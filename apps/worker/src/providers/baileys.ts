import crypto from "node:crypto";
import makeWASocket, {
    Browsers, DisconnectReason, decryptPollVote, downloadMediaMessage, fetchLatestBaileysVersion, getContentType,
    isJidGroup, isLidUser, jidNormalizedUser, makeCacheableSignalKeyStore, normalizeMessageContent, proto,
    type AnyMessageContent, type WAMessage, type WASocket,
} from "baileys";
import type postgres from "postgres";
import { isBroadcastJid, menuText, type IncomingType, type OutMessage, type SessionSettings } from "@areszap/core";
import type { Logger } from "pino";
import { usePgAuthState } from "./pg-auth-state";
import type { InboundMessage, MediaPayload, Provider, ProviderHandlers, Receipt } from "./types";

let versionCache: { at: number; version?: [number, number, number] } | null = null;
async function waVersion() {
    if (versionCache && Date.now() - versionCache.at < 6 * 3600_000) return versionCache.version;
    try {
        const { version } = await fetchLatestBaileysVersion();
        versionCache = { at: Date.now(), version: version as [number, number, number] };
    } catch {
        versionCache = { at: Date.now(), version: undefined }; // usa o padrão da biblioteca
    }
    return versionCache.version;
}

const RECEIPT: Record<number, Receipt["status"] | undefined> = {
    [proto.WebMessageInfo.Status.ERROR]: "failed",
    [proto.WebMessageInfo.Status.SERVER_ACK]: "sent",
    [proto.WebMessageInfo.Status.DELIVERY_ACK]: "delivered",
    [proto.WebMessageInfo.Status.READ]: "read",
    [proto.WebMessageInfo.Status.PLAYED]: "read",
};

export class BaileysProvider implements Provider {
    readonly kind = "baileys" as const;
    private sock: WASocket | null = null;
    private ready = false;
    private stopped = true;
    private attempt = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private clearAuth: (() => Promise<void>) | null = null;
    /** Muda a cada start/stop: um connect() que termina depois de um stop não cria socket órfão. */
    private gen = 0;

    constructor(
        private sessionId: string,
        private sql: postgres.Sql,
        private settings: () => SessionSettings,
        private handlers: ProviderHandlers,
        private log: Logger,
    ) { }

    isReady() { return this.ready && !!this.sock; }

    async start() {
        this.gen++;
        this.stopped = false;
        this.attempt = 0;
        await this.connect();
    }

    async stop() {
        this.gen++;
        this.stopped = true;
        this.ready = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const s = this.sock;
        this.sock = null;
        s?.ev.removeAllListeners("connection.update");
        s?.end(undefined);
        this.handlers.status("stopped");
    }

    async logout() {
        const s = this.sock;
        this.gen++;
        this.stopped = true;
        this.ready = false;
        try { await s?.logout(); } catch { /* já desconectado */ }
        s?.end(undefined);
        this.sock = null;
        if (this.clearAuth) await this.clearAuth();
        else await this.sql`delete from wa_auth where session_id = ${this.sessionId}`;
        this.handlers.status("logged_out", { phone: null });
    }

    private async connect() {
        if (this.stopped) return;
        const gen = this.gen;
        this.handlers.status(this.attempt ? "reconnecting" : "starting");
        const { state, saveCreds, clear } = await usePgAuthState(this.sql, this.sessionId);
        this.clearAuth = clear;
        const version = await waVersion();
        if (this.stopped || gen !== this.gen) return; // parado enquanto carregava
        const baileysLog = this.log.child({ mod: "baileys" });
        baileysLog.level = process.env.BAILEYS_LOG_LEVEL ?? "warn";
        const sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLog as any) },
            logger: baileysLog as any,
            browser: Browsers.macOS("Desktop"),
            markOnlineOnConnect: false,          // o celular continua recebendo notificação
            // histórico completo só se pedido; a sincronização inicial leve fica ligada porque traz o mapeamento LID ↔ telefone
            // (desligar tudo deixa a sessão instável, aviso do próprio Baileys). Mensagens do histórico não disparam fluxo.
            syncFullHistory: this.settings().syncHistory,
            ...(this.settings().syncHistory ? { shouldSyncHistoryMessage: () => true } : {}),
            generateHighQualityLinkPreview: false,
            getMessage: async () => undefined,
        });
        this.sock = sock;

        sock.ev.process(async events => {
            if (sock !== this.sock || gen !== this.gen) return; // socket antigo
            if (events["creds.update"]) await saveCreds().catch(e => this.log.error({ err: e }, "falha ao salvar credenciais"));

            const conn = events["connection.update"];
            if (conn) {
                if (conn.qr) this.handlers.status("qr", { qr: conn.qr });
                if (conn.connection === "open") {
                    this.ready = true;
                    this.attempt = 0;
                    this.handlers.status("connected", { phone: sock.user?.id ? jidNormalizedUser(sock.user.id).split("@")[0] : null, qr: null });
                }
                if (conn.connection === "close") this.onClose(conn.lastDisconnect?.error);
            }

            const up = events["messages.upsert"];
            if (up) {
                const live = up.type === "notify";
                const list = up.messages.map(m => this.normalize(m, live)).filter((m): m is InboundMessage => !!m);
                if (list.length) this.handlers.inbound(list);
            }

            const upd = events["messages.update"];
            if (upd) {
                const receipts: Receipt[] = [];
                for (const u of upd) {
                    const st = u.update.status;
                    if (!u.key.fromMe || st == null || !u.key.id || !u.key.remoteJid) continue;
                    const status = RECEIPT[st];
                    if (status) receipts.push({ waId: u.key.id, jid: this.contactJid(u.key.remoteJid, (u.key as { remoteJidAlt?: string }).remoteJidAlt), status });
                }
                if (receipts.length) this.handlers.receipts(receipts);
            }
        });
    }

    private onClose(err: unknown) {
        this.ready = false;
        const code = (err as { output?: { statusCode?: number } })?.output?.statusCode;
        if (this.stopped) return;
        if (code === DisconnectReason.loggedOut) {
            this.stopped = true;
            this.sock = null;
            void this.clearAuth?.();
            this.handlers.status("logged_out", { phone: null, error: "O aparelho desconectou esta sessão" });
            return;
        }
        // 515 (restartRequired) logo após parear: reconecta na hora. O resto: espera crescente, sem limite de tentativas.
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 1000 * 2 ** this.attempt) + Math.floor(Math.random() * 1000);
        this.attempt++;
        this.handlers.status("reconnecting", { error: err instanceof Error ? err.message : code ? `código ${code}` : null });
        const gen = this.gen;
        this.reconnectTimer = setTimeout(() => { if (gen !== this.gen) return; this.connect().catch(e => this.log.error({ err: e }, "reconexão falhou")); }, delay);
    }

    private contactJid(remoteJid: string, alt?: string | null) {
        const jid = isLidUser(remoteJid) && alt ? alt : remoteJid;
        return jidNormalizedUser(jid);
    }

    private normalize(m: WAMessage, live: boolean): InboundMessage | null {
        const key = m.key;
        const raw = key.remoteJid;
        if (!raw || !key.id || isJidGroup(raw) || isBroadcastJid(raw)) return null;
        const alt = (key as { remoteJidAlt?: string }).remoteJidAlt;
        const jid = this.contactJid(raw, alt);
        const content = normalizeMessageContent(m.message);
        if (!content) return null;
        const ctype = getContentType(content);
        if (!ctype || ["protocolMessage", "senderKeyDistributionMessage", "reactionMessage", "messageContextInfo", "keepInChatMessage"].includes(ctype)) return null;

        let type: IncomingType = "other";
        let text = "";
        let media: InboundMessage["media"];
        let interactiveReplyId: string | null = null;
        let pollVote: InboundMessage["pollVote"];
        const c = content as proto.IMessage;
        const dl = (mime?: string | null, fileName?: string | null, size?: unknown): InboundMessage["media"] => ({
            mime: mime ?? undefined, fileName: fileName ?? undefined, size: size ? Number(size) : undefined,
            download: async () => {
                const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: this.log as any, reuploadRequest: this.sock!.updateMediaMessage });
                return { buffer, mime: mime || "application/octet-stream", fileName: fileName ?? undefined };
            },
        });

        switch (ctype) {
            case "conversation": type = "text"; text = c.conversation || ""; break;
            case "extendedTextMessage": type = "text"; text = c.extendedTextMessage?.text || ""; break;
            case "imageMessage": type = "image"; text = c.imageMessage?.caption || ""; media = dl(c.imageMessage?.mimetype, null, c.imageMessage?.fileLength); break;
            case "videoMessage": type = "video"; text = c.videoMessage?.caption || ""; media = dl(c.videoMessage?.mimetype, null, c.videoMessage?.fileLength); break;
            case "audioMessage": type = "audio"; media = dl(c.audioMessage?.mimetype, null, c.audioMessage?.fileLength); break;
            case "documentMessage": type = "document"; text = c.documentMessage?.caption || ""; media = dl(c.documentMessage?.mimetype, c.documentMessage?.fileName, c.documentMessage?.fileLength); break;
            case "documentWithCaptionMessage": {
                const d = c.documentWithCaptionMessage?.message?.documentMessage;
                type = "document"; text = d?.caption || ""; media = dl(d?.mimetype, d?.fileName, d?.fileLength); break;
            }
            case "stickerMessage": type = "sticker"; media = dl(c.stickerMessage?.mimetype, null, c.stickerMessage?.fileLength); break;
            case "locationMessage": type = "location"; text = `${c.locationMessage?.degreesLatitude},${c.locationMessage?.degreesLongitude}`; break;
            case "contactMessage": type = "contact"; text = c.contactMessage?.displayName || ""; break;
            case "pollCreationMessage": case "pollCreationMessageV2": case "pollCreationMessageV3": {
                const p = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
                type = "poll"; text = p?.name || ""; break;
            }
            case "pollUpdateMessage": {
                const u = c.pollUpdateMessage;
                const pollId = u?.pollCreationMessageKey?.id;
                if (!u?.vote?.encPayload || !u.vote.encIv || !pollId) return null;
                type = "interactive";
                pollVote = { pollId, voters: [...new Set([raw, alt, jid].filter((j): j is string => !!j).map(j => jidNormalizedUser(j)))], encPayload: u.vote.encPayload, encIv: u.vote.encIv };
                break;
            }
            case "buttonsResponseMessage": type = "interactive"; text = c.buttonsResponseMessage?.selectedDisplayText || ""; interactiveReplyId = c.buttonsResponseMessage?.selectedButtonId || null; break;
            case "listResponseMessage": type = "interactive"; text = c.listResponseMessage?.title || ""; interactiveReplyId = c.listResponseMessage?.singleSelectReply?.selectedRowId || null; break;
            default: type = "other";
        }

        const ctxInfo = (c.extendedTextMessage?.contextInfo ?? c.imageMessage?.contextInfo ?? c.videoMessage?.contextInfo ?? null);
        return {
            jid, waId: key.id, fromMe: !!key.fromMe, live, type, text, pushName: m.pushName ?? null,
            timestamp: new Date(Number(m.messageTimestamp || 0) * 1000 || Date.now()),
            media, quotedWaId: ctxInfo?.stanzaId ?? null, interactiveReplyId, pollVote,
        };
    }

    readPollVote(vote: NonNullable<InboundMessage["pollVote"]>, poll: { id: string; secret: string; values: string[] }): number | null {
        const me = this.sock?.user;
        const creators = [me?.id, (me as { lid?: string } | undefined)?.lid].filter((j): j is string => !!j).map(jidNormalizedUser);
        for (const pollCreatorJid of creators) for (const voterJid of vote.voters) {
            try {
                const { selectedOptions } = decryptPollVote({ encPayload: vote.encPayload, encIv: vote.encIv }, {
                    pollCreatorJid, pollMsgId: poll.id, pollEncKey: Buffer.from(poll.secret, "base64"), voterJid,
                });
                const hash = selectedOptions?.[0] ? Buffer.from(selectedOptions[0]).toString("hex") : null;
                const i = hash ? poll.values.findIndex(v => crypto.createHash("sha256").update(v).digest("hex") === hash) : -1;
                return i >= 0 ? i : null;
            } catch { /* par de jid errado: a autenticação GCM falha, tenta o próximo */ }
        }
        return null;
    }

    async presence(jid: string, state: "composing" | "paused") {
        if (!this.isReady()) return;
        await this.sock!.sendPresenceUpdate(state, jid).catch(() => undefined);
    }

    async send(jid: string, msg: OutMessage, opts: { waId: string; media?: MediaPayload }): Promise<{ waId: string }> {
        if (!this.isReady()) throw new Error("Sessão desconectada");
        const content = this.toContent(msg, opts.media);
        const sent = await this.sock!.sendMessage(jid, content, { messageId: opts.waId });
        return { waId: sent?.key.id ?? opts.waId };
    }

    private toContent(msg: OutMessage, media?: MediaPayload): AnyMessageContent {
        switch (msg.kind) {
            case "text": return { text: msg.text };
            case "vcard": {
                const digits = msg.phone.replace(/\D/g, "");
                const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${msg.name}\n${msg.org ? `ORG:${msg.org};\n` : ""}TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}\nEND:VCARD`;
                return { contacts: { displayName: msg.name, contacts: [{ vcard }] } };
            }
            case "menu":
                if (msg.mode === "interactive" && msg.pollSecret) {
                    return { poll: { name: msg.question, values: msg.options.map(o => o.text), selectableCount: 1, messageSecret: Buffer.from(msg.pollSecret, "base64") } };
                }
                return { text: menuText(msg.question, msg.options) };
            case "media": {
                if (!media) throw new Error("Mídia não carregada");
                const caption = msg.caption || undefined;
                switch (msg.media) {
                    case "image": return { image: media.buffer, caption, mimetype: media.mime };
                    case "video": return { video: media.buffer, caption, mimetype: media.mime };
                    case "audio": {
                        const voice = media.mime.startsWith("audio/ogg");
                        return { audio: media.buffer, mimetype: voice ? "audio/ogg; codecs=opus" : media.mime, ptt: voice };
                    }
                    default: return { document: media.buffer, mimetype: media.mime, fileName: msg.fileName || media.fileName, caption };
                }
            }
            case "template": throw new Error("Modelos (templates) só existem na API oficial");
        }
    }

    isFatalSendError(err: unknown) {
        const m = String((err as Error)?.message ?? err).toLowerCase();
        return m.includes("not-authorized") || m.includes("forbidden") || m.includes("logged out");
    }
}
