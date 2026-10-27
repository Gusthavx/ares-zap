import { applyReceipts, publishEvent, recordMessage, saveAsset } from "@areszap/db";
import type { Ctx } from "./context";
import { log } from "./context";
import type { InboundMessage, Provider, Receipt } from "./providers/types";
import type { Webhooks } from "./webhooks";

const MAX_INBOUND_MEDIA = Number(process.env.MAX_INBOUND_MEDIA_MB || 16) * 1024 * 1024;
/** Mensagem "fromMe" mais velha que isso é histórico/eco atrasado, não atendimento humano. */
const HUMAN_ECHO_WINDOW_MS = 2 * 60_000;

/**
 * Caminho único da mensagem recebida: grava (1 transação) → atendimento humano ou motor de fluxos → eventos e webhooks.
 * Mídia é baixada em segundo plano, sem segurar o fluxo.
 */
export class InboundPipeline {
    private mediaQueue: Promise<unknown> = Promise.resolve();

    constructor(private ctx: Ctx, private hooks: Webhooks) { }

    async handle(sessionId: string, provider: Provider, list: InboundMessage[]) {
        for (const m of list) {
            try {
                await this.one(sessionId, provider, m);
            } catch (e) {
                log.error({ err: e, session: sessionId, waId: m.waId }, "falha ao processar mensagem recebida");
            }
        }
    }

    private async one(sessionId: string, provider: Provider, m: InboundMessage) {
        const info = await this.ctx.sessions.get(sessionId);
        if (!info) return;

        // voto em enquete: decifra com o segredo que o motor guardou na espera do menu
        let text = m.text;
        let optionId = m.interactiveReplyId ?? null;
        let pollId: string | null = null;
        if (m.pollVote) {
            const vote = await this.readVote(sessionId, provider, m);
            if (!vote) return;
            text = vote.text;
            pollId = m.pollVote.pollId;
        }

        const rec = await recordMessage(this.ctx.sql, {
            sessionId, jid: m.jid, waId: m.waId, fromMe: m.fromMe, sender: m.fromMe ? "phone" : "contact",
            type: m.pollVote ? "interactive" : m.type, body: m.pollVote ? `✔ ${text}` : (text || null),
            media: m.media ? { mime: m.media.mime, fileName: m.media.fileName, size: m.media.size } : null,
            status: m.fromMe ? "sent" : "received", createdAt: m.timestamp, pushName: m.pushName,
            quotedWaId: m.quotedWaId, markFirstInbound: !m.fromMe && m.live,
        });
        if (!rec.inserted) return; // repetida

        await publishEvent(this.ctx.sql, { t: "message", sessionId, chatId: rec.chatId, messageId: rec.messageId, fromMe: m.fromMe });
        if (m.media && (m.media.size ?? 0) <= MAX_INBOUND_MEDIA) this.downloadLater(sessionId, rec.messageId, m);

        if (m.fromMe) {
            await this.maybeHumanTakeover(sessionId, rec.contactId, m, info.settings.humanTakeover);
            return;
        }

        void this.hooks.emit(sessionId, "message.received", {
            from: m.jid, waId: m.waId, type: m.type, text, pushName: m.pushName, contactId: rec.contactId, chatId: rec.chatId,
        });
        if (!m.live) return;

        const result = await this.ctx.mutex.run(`${sessionId}:${rec.contactId}`, () => this.ctx.engine.handleIncoming({
            sessionId, contactId: rec.contactId, jid: m.jid, keyId: m.waId, type: m.type, text,
            mediaRef: m.media ? rec.messageId : null, optionId, pollId, isFirstContact: rec.firstInbound,
        }));
        log.debug({ session: sessionId, jid: m.jid, result }, "mensagem processada");
    }

    /**
     * Mensagem enviada pelo celular (ou outro aparelho) que não saiu da nossa fila = atendente assumiu.
     * Cancela o fluxo em andamento e pausa a automação do contato pelo tempo configurado.
     */
    private async maybeHumanTakeover(sessionId: string, contactId: string, m: InboundMessage, cfg: { enabled: boolean; minutes: number }) {
        if (!cfg.enabled || Date.now() - m.timestamp.getTime() > HUMAN_ECHO_WINDOW_MS) return;
        const ours = await this.ctx.sql`select 1 from outbox where session_id = ${sessionId} and wa_id = ${m.waId} limit 1`;
        if (ours.length) return;
        const until = new Date(Date.now() + cfg.minutes * 60_000);
        await this.ctx.mutex.run(`${sessionId}:${contactId}`, () => this.ctx.engine.cancelActive(contactId, "Atendimento humano", { pauseUntil: until }));
        log.info({ session: sessionId, contactId, until }, "atendimento humano: automação pausada");
    }

    private async readVote(sessionId: string, provider: Provider, m: InboundMessage): Promise<{ text: string } | null> {
        const [c] = await this.ctx.sql`select id from contacts where session_id = ${sessionId} and jid = ${m.jid}`;
        if (!c) return null;
        const run = await this.ctx.store.findActiveRun(c.id);
        const poll = run?.wait?.kind === "menu" ? run.wait.poll : undefined;
        if (!poll || poll.id !== m.pollVote!.pollId || !provider.readPollVote) return null;
        const i = provider.readPollVote(m.pollVote!, poll);
        if (i === null) { log.warn({ run: run!.id }, "voto da enquete não pôde ser lido (ou foi retirado)"); return null; }
        return { text: String(i + 1) };
    }

    /** Baixa a mídia recebida em fila (uma por vez) e liga o arquivo à mensagem. */
    private downloadLater(sessionId: string, messageId: string, m: InboundMessage) {
        this.mediaQueue = this.mediaQueue.then(async () => {
            try {
                const file = await m.media!.download();
                if (file.buffer.length > MAX_INBOUND_MEDIA) return;
                const asset = await saveAsset(this.ctx.sql, {
                    sessionId, buffer: file.buffer, fileName: file.fileName || `${m.type}-${m.waId}`, mime: file.mime, origin: "inbound",
                });
                const [row] = await this.ctx.sql`
                    update messages set media = coalesce(media, '{}'::jsonb) || ${this.ctx.sql.json({ assetId: asset.id, mime: asset.mime, fileName: asset.fileName, size: asset.size })}
                    where id = ${messageId} returning chat_id`;
                if (row) await publishEvent(this.ctx.sql, { t: "message.status", sessionId, chatId: row.chat_id, messageId, status: "media" });
            } catch (e) {
                log.warn({ err: (e as Error).message, messageId }, "download de mídia falhou");
            }
        });
    }

    async receipts(sessionId: string, list: Receipt[]) {
        try {
            const changed = await applyReceipts(this.ctx.sql, sessionId, list);
            for (const c of changed) {
                await publishEvent(this.ctx.sql, { t: "message.status", sessionId, chatId: c.chatId, messageId: c.id, status: c.status });
                void this.hooks.emit(sessionId, "message.status", { waId: c.waId, status: c.status });
            }
            const failed = list.filter(r => r.status === "failed" && r.error);
            for (const f of failed) await this.ctx.sql`update outbox set error = ${f.error!} where session_id = ${sessionId} and wa_id = ${f.waId}`;
        } catch (e) {
            log.error({ err: e, session: sessionId }, "falha ao aplicar recibos");
        }
    }
}
