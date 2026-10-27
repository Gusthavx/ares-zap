import { fetchBuffer, publishEvent, readAsset, recordMessage, sniffMime } from "@areszap/db";
import { summarize, type OutMessage, type SessionSettings } from "@areszap/core";
import { log, type Ctx } from "./context";
import { RateGate, classOf } from "./rate";
import type { MediaPayload, Provider } from "./providers/types";
import type { Webhooks } from "./webhooks";
import { toVoiceNote } from "./voice";

interface OutboxRow {
    id: number; session_id: string; jid: string; payload: OutMessage; source: string; priority: number;
    typing_ms: number; attempts: number; wa_id: string; run_id: string | null; broadcast_id: string | null; recipient_id: number | null;
}

const MAX_ATTEMPTS = 3;
const SENDER_OF: Record<string, "flow" | "broadcast" | "agent" | "api" | "notify"> = { flow: "flow", broadcast: "broadcast", agent: "agent", api: "api", notify: "notify" };

/**
 * Fila de saída de UM número. Todo envio (fluxo, transmissão, atendente, API) passa por aqui:
 * ordem por contato, "digitando…" sem travar os outros contatos, ritmo anti-bloqueio e nova tentativa.
 */
export class OutboxSender {
    private running = false;
    private wakeUp: (() => void) | null = null;
    private gate = new RateGate();
    private gaps = new Map<string, { min: number; max: number } | null>();
    private seeded = false;

    constructor(private ctx: Ctx, private sessionId: string, private provider: Provider, private hooks: Webhooks) { }

    start() {
        if (this.running) return;
        this.running = true;
        void this.loop().catch(e => log.error({ err: e, session: this.sessionId }, "sender parou"));
    }

    stop() { this.running = false; this.wake(); }

    wake() { const w = this.wakeUp; this.wakeUp = null; w?.(); }

    stats() { return this.gate.stats(); }

    private sleep(ms: number) {
        return new Promise<void>(resolve => {
            const t = setTimeout(() => { this.wakeUp = null; resolve(); }, Math.max(50, ms));
            this.wakeUp = () => { clearTimeout(t); resolve(); };
        });
    }

    private async seed() {
        const info = await this.ctx.sessions.get(this.sessionId);
        if (!info) return;
        const day = this.gate.dayKey(info.settings);
        // envios em massa já feitos hoje (no fuso da sessão), para o teto valer mesmo depois de reiniciar
        const [r] = await this.ctx.sql`
            select count(*)::int as n from outbox
            where session_id = ${this.sessionId} and status = 'sent' and priority >= 2
              and sent_at >= (date_trunc('day', now() at time zone ${info.settings.timezone}) at time zone ${info.settings.timezone})`;
        this.gate.seed(day, r?.n ?? 0);
        this.seeded = true;
    }

    private async loop() {
        while (this.running) {
            try {
                if (!this.provider.isReady()) { await this.sleep(30_000); continue; }
                if (!this.seeded) await this.seed();
                const info = await this.ctx.sessions.get(this.sessionId);
                if (!info) { await this.sleep(30_000); continue; }
                const s = info.settings;
                const daysConnected = info.firstConnectedAt ? Math.floor((Date.now() - info.firstConnectedAt.getTime()) / 86_400_000) : 0;

                const convWait = this.gate.conversationWait(s);
                if (convWait > 0) { await this.sleep(convWait); continue; }
                const bulk = this.gate.bulkWait(s, daysConnected);

                const item = await this.pick(bulk.ok);
                if (!item) {
                    const next = await this.nextDue(bulk.ok);
                    const bulkHint = !bulk.ok ? bulk.waitMs : Infinity;
                    await this.sleep(Math.min(next ?? 30_000, bulkHint, 30_000));
                    continue;
                }

                // "digitando…": manda a presença e devolve o item para a fila com o atraso, sem bloquear os outros contatos
                if (item.typing_ms > 0) {
                    await this.provider.presence(item.jid, "composing");
                    await this.ctx.sql`update outbox set status = 'queued', typing_ms = 0, attempts = attempts - 1,
                        not_before = now() + ${item.typing_ms} * interval '1 millisecond' where id = ${item.id}`;
                    continue;
                }

                await this.process(item, s);
            } catch (e) {
                log.error({ err: e, session: this.sessionId }, "erro no sender");
                await this.sleep(5_000);
            }
        }
    }

    /** Próximo item que pode sair: o mais antigo de cada contato (ordem), por prioridade. */
    private async pick(allowBulk: boolean): Promise<OutboxRow | null> {
        const rows = await this.ctx.sql<OutboxRow[]>`
            with c as (
                select o.id from outbox o
                where o.session_id = ${this.sessionId} and o.status = 'queued' and o.not_before <= now()
                  and (${allowBulk} or o.priority < 2)
                  and not exists (
                      select 1 from outbox p
                      where p.session_id = o.session_id and p.jid = o.jid and p.status in ('queued','sending')
                        and p.id < o.id and p.priority <= o.priority)
                order by o.priority, o.not_before, o.id
                limit 1 for update skip locked
            )
            update outbox set status = 'sending', attempts = outbox.attempts + 1 from c where outbox.id = c.id
            returning outbox.*`;
        return rows[0] ?? null;
    }

    private async nextDue(allowBulk: boolean): Promise<number | null> {
        const [r] = await this.ctx.sql`
            select extract(epoch from (min(not_before) - now())) * 1000 as ms from outbox
            where session_id = ${this.sessionId} and status = 'queued' and (${allowBulk} or priority < 2)`;
        return r?.ms == null ? null : Math.max(0, Number(r.ms));
    }

    private async loadMedia(msg: Extract<OutMessage, { kind: "media" }>): Promise<MediaPayload> {
        let buffer: Buffer, mime: string, fileName = msg.fileName || "arquivo";
        if (msg.assetId) {
            const a = await readAsset(this.ctx.sql, msg.assetId, this.sessionId);
            if (!a) throw new Error("Arquivo de mídia não encontrado");
            buffer = a.buffer; mime = a.row.mime; fileName = msg.fileName || a.row.fileName;
        } else if (msg.url) {
            const f = await fetchBuffer(msg.url);
            buffer = f.buffer; mime = sniffMime(f.buffer, f.mime);
        } else throw new Error("Mídia sem arquivo");
        // áudio vira nota de voz OGG/Opus no Baileys (toca no iPhone)
        if (msg.media === "audio" && this.provider.kind === "baileys" && !mime.startsWith("audio/ogg")) {
            buffer = await toVoiceNote(buffer);
            mime = "audio/ogg";
        }
        return { buffer, mime, fileName };
    }

    private async process(item: OutboxRow, s: SessionSettings) {
        const cls = classOf(item.priority);
        // opt-out: transmissão nunca vai para quem pediu para sair
        if (item.broadcast_id) {
            const [b] = await this.ctx.sql`
                select b.skip_opted_out, b.status, b.min_gap_sec, b.max_gap_sec, c.opted_out_at from broadcasts b
                left join contacts c on c.session_id = b.session_id and c.jid = ${item.jid}
                where b.id = ${item.broadcast_id}`;
            if (b && b.status !== "running") {
                await this.ctx.sql`update outbox set status = 'held', attempts = attempts - 1 where id = ${item.id}`;
                return;
            }
            if (b?.skip_opted_out && b.opted_out_at) {
                await this.finishBroadcastItem(item, "skipped", "Contato pediu para sair");
                return;
            }
            if (!this.gaps.has(item.broadcast_id)) this.gaps.set(item.broadcast_id, b?.min_gap_sec ? { min: b.min_gap_sec, max: b.max_gap_sec ?? b.min_gap_sec } : null);
        }

        try {
            const media = item.payload.kind === "media" ? await this.loadMedia(item.payload) : undefined;
            const res = await this.provider.send(item.jid, item.payload, {
                waId: item.wa_id, media, mediaKey: item.payload.kind === "media" ? item.payload.assetId : undefined,
            });
            this.gate.record(cls, s, item.broadcast_id ? this.gaps.get(item.broadcast_id) ?? undefined : undefined);

            await this.ctx.sql`update outbox set status = 'sent', sent_at = now(), wa_id = ${res.waId}, error = null where id = ${item.id}`;
            const rec = await recordMessage(this.ctx.sql, {
                sessionId: this.sessionId, jid: item.jid, waId: res.waId, fromMe: true, sender: SENDER_OF[item.source] ?? "api",
                type: item.payload.kind === "media" ? item.payload.media : item.payload.kind, body: summarize(item.payload),
                media: item.payload.kind === "media" ? { assetId: item.payload.assetId, mime: media?.mime, fileName: media?.fileName } : null,
                status: "sent", createdAt: new Date(),
            });
            if (item.broadcast_id) await this.finishBroadcastItem(item, "sent", null);
            await publishEvent(this.ctx.sql, { t: "message", sessionId: this.sessionId, chatId: rec.chatId, messageId: rec.messageId, fromMe: true });
            void this.hooks.emit(this.sessionId, "message.sent", { to: item.jid, waId: res.waId, source: item.source, text: summarize(item.payload) });
        } catch (e) {
            const msg = (e as Error).message?.slice(0, 500) ?? String(e);
            if (this.provider.isFatalSendError?.(e)) {
                // número restrito/banido: devolve à fila e pausa este número
                await this.ctx.sql`update outbox set status = 'queued', attempts = attempts - 1, error = ${msg} where id = ${item.id}`;
                await this.ctx.sql`update sessions set status = 'error', last_error = ${msg} where id = ${this.sessionId}`;
                await publishEvent(this.ctx.sql, { t: "session.status", sessionId: this.sessionId, status: "error", error: msg });
                log.error({ session: this.sessionId, err: msg }, "erro grave de envio: sessão pausada");
                this.running = false;
                return;
            }
            if (item.attempts >= MAX_ATTEMPTS) {
                await this.ctx.sql`update outbox set status = 'failed', error = ${msg} where id = ${item.id}`;
                await this.ctx.sql`update messages set status = 'failed' where session_id = ${this.sessionId} and wa_id = ${item.wa_id} and status = 'queued'`;
                if (item.broadcast_id) await this.finishBroadcastItem(item, "failed", msg);
                log.warn({ session: this.sessionId, jid: item.jid, err: msg }, "envio falhou de vez");
            } else {
                await this.ctx.sql`update outbox set status = 'queued', error = ${msg},
                    not_before = now() + ${30 * item.attempts} * interval '1 second' where id = ${item.id}`;
            }
        }
    }

    /** Atualiza destinatário e totais da transmissão; fecha a transmissão quando não sobra nada. */
    private async finishBroadcastItem(item: OutboxRow, status: "sent" | "failed" | "skipped", error: string | null) {
        const id = item.broadcast_id!;
        await this.ctx.sql.begin(async tx => {
            if (status !== "sent") await tx`update outbox set status = ${status === "skipped" ? "skipped" : "failed"}, error = ${error} where id = ${item.id}`;
            if (item.recipient_id) await tx`update broadcast_recipients set status = ${status}, error = ${error}, sent_at = ${status === "sent" ? new Date() : null} where id = ${item.recipient_id}`;
            if (status === "sent") await tx`update broadcasts set sent = sent + 1 where id = ${id}`;
            else if (status === "failed") await tx`update broadcasts set failed = failed + 1 where id = ${id}`;
            else await tx`update broadcasts set skipped = skipped + 1 where id = ${id}`;
        });
        const [left] = await this.ctx.sql`select count(*)::int as n from outbox where broadcast_id = ${id} and status in ('queued','held','sending')`;
        if (left.n === 0) {
            const done = await this.ctx.sql`update broadcasts set status = 'completed', finished_at = now() where id = ${id} and status = 'running' returning sent, failed, skipped, total`;
            if (done[0]) void this.hooks.emit(this.sessionId, "broadcast.finished", { broadcastId: id, ...done[0] });
            this.gaps.delete(id);
        }
        await publishEvent(this.ctx.sql, { t: "broadcast", sessionId: this.sessionId, broadcastId: id });
    }
}
