import { LIST_MAX_ROWS, LIST_MAX_ROW_TITLE, menuText, phoneFromJid, type IncomingType, type OutMessage } from "@areszap/core";
import type { Logger } from "pino";
import type { InboundMessage, MediaPayload, Provider, ProviderHandlers, Receipt } from "./types";

export interface CloudConfig { phoneNumberId: string; wabaId?: string; accessToken: string }

const GRAPH = () => `https://graph.facebook.com/${process.env.GRAPH_API_VERSION || "v23.0"}`;
const BUTTON_MAX = 3;
const BUTTON_TITLE_MAX = 20;

/** Erros da Graph API que significam conta/número restrito: pausar a sessão em vez de insistir. */
const FATAL_CODES = new Set([368, 131031, 190, 10, 200]);

export class GraphError extends Error {
    constructor(message: string, public code?: number, public status?: number) { super(message); }
}

export class CloudProvider implements Provider {
    readonly kind = "cloud" as const;
    private ready = false;
    private mediaIds = new Map<string, { id: string; at: number }>();

    constructor(private sessionId: string, private cfg: () => CloudConfig | null, private handlers: ProviderHandlers, private log: Logger) { }

    isReady() { return this.ready; }

    private async graph(path: string, init: RequestInit = {}): Promise<any> {
        const cfg = this.cfg();
        if (!cfg?.accessToken || !cfg.phoneNumberId) throw new GraphError("API oficial sem token ou phoneNumberId configurado");
        const res = await fetch(path.startsWith("http") ? path : `${GRAPH()}/${path}`, {
            ...init,
            headers: { authorization: `Bearer ${cfg.accessToken}`, ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...init.headers },
            signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        const body = text ? safeJson(text) : null;
        if (!res.ok) {
            const err = body?.error;
            throw new GraphError(cloudErrorMessage(err?.code, err?.message ?? `HTTP ${res.status}`), err?.code, res.status);
        }
        return body;
    }

    async start() {
        const cfg = this.cfg();
        try {
            const info = await this.graph(`${cfg?.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`);
            this.ready = true;
            this.handlers.status("connected", { phone: String(info.display_phone_number ?? "").replace(/\D/g, "") || null, qr: null, error: null });
        } catch (e) {
            this.ready = false;
            this.handlers.status("error", { error: (e as Error).message });
        }
    }

    async stop() { this.ready = false; this.handlers.status("stopped"); }
    async logout() { this.ready = false; this.handlers.status("logged_out", { phone: null }); }

    async presence() { /* a API oficial não tem "digitando" livre; o atraso é respeitado pela fila */ }

    async send(jid: string, msg: OutMessage, opts: { waId: string; media?: MediaPayload; mediaKey?: string }): Promise<{ waId: string }> {
        if (!this.ready) throw new GraphError("Sessão da API oficial não está ativa");
        const to = phoneFromJid(jid);
        const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
        let body: Record<string, unknown>;
        switch (msg.kind) {
            case "text":
                body = { ...base, type: "text", text: { body: msg.text, preview_url: false } };
                break;
            case "vcard": {
                const digits = msg.phone.replace(/\D/g, "");
                body = { ...base, type: "contacts", contacts: [{
                    name: { formatted_name: msg.name, first_name: msg.name.split(" ")[0] },
                    phones: [{ phone: `+${digits}`, wa_id: digits, type: "CELL" }],
                    ...(msg.org ? { org: { company: msg.org } } : {}),
                }] };
                break;
            }
            case "menu":
                body = { ...base, ...this.menuBody(msg) };
                break;
            case "template":
                body = { ...base, type: "template", template: { name: msg.name, language: { code: msg.language }, ...(msg.components ? { components: msg.components } : {}) } };
                break;
            case "media": {
                const type = msg.media === "file" ? "document" : msg.media;
                let ref: Record<string, unknown>;
                if (opts.media) ref = { id: await this.uploadMedia(opts.media, opts.mediaKey) };
                else if (msg.url) ref = { link: msg.url };
                else throw new GraphError("Mídia sem arquivo");
                if (msg.caption && type !== "audio") ref.caption = msg.caption;
                if (type === "document") ref.filename = msg.fileName || opts.media?.fileName || "arquivo";
                body = { ...base, type, [type]: ref };
                break;
            }
        }
        const res = await this.graph(`${this.cfg()!.phoneNumberId}/messages`, { method: "POST", body: JSON.stringify(body) });
        return { waId: res?.messages?.[0]?.id ?? opts.waId };
    }

    /** Até 3 opções curtas = botões; até 10 = lista; acima disso = menu numerado em texto. */
    private menuBody(msg: Extract<OutMessage, { kind: "menu" }>) {
        const opts = msg.options;
        if (msg.mode === "interactive" && opts.length <= BUTTON_MAX && opts.every(o => o.text.length <= BUTTON_TITLE_MAX)) {
            return { type: "interactive", interactive: { type: "button", body: { text: msg.question.slice(0, 1024) }, action: {
                buttons: opts.map(o => ({ type: "reply", reply: { id: `option:${o.id}`, title: o.text } })),
            } } };
        }
        if (msg.mode === "interactive" && opts.length <= LIST_MAX_ROWS && opts.every(o => o.text.length <= LIST_MAX_ROW_TITLE)) {
            return { type: "interactive", interactive: { type: "list", body: { text: msg.question.slice(0, 4096) }, action: {
                button: "Escolher", sections: [{ title: "Opções", rows: opts.map(o => ({ id: `option:${o.id}`, title: o.text })) }],
            } } };
        }
        return { type: "text", text: { body: menuText(msg.question, opts) } };
    }

    private async uploadMedia(media: MediaPayload, key?: string): Promise<string> {
        const hit = key ? this.mediaIds.get(key) : undefined;
        if (hit && Date.now() - hit.at < 20 * 86_400_000) return hit.id; // ids valem ~30 dias
        const form = new FormData();
        form.append("messaging_product", "whatsapp");
        form.append("type", media.mime);
        form.append("file", new Blob([new Uint8Array(media.buffer)], { type: media.mime }), media.fileName);
        const res = await this.graph(`${this.cfg()!.phoneNumberId}/media`, { method: "POST", body: form });
        if (key) this.mediaIds.set(key, { id: res.id, at: Date.now() });
        return res.id;
    }

    /** Corpo do webhook da Meta (já com assinatura conferida pelo servidor). */
    handleWebhook(payload: any) {
        const inbound: InboundMessage[] = [];
        const receipts: Receipt[] = [];
        for (const entry of payload?.entry ?? []) for (const change of entry?.changes ?? []) {
            const v = change?.value;
            if (!v || v.metadata?.phone_number_id !== this.cfg()?.phoneNumberId) continue;
            const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
            for (const m of v.messages ?? []) {
                const n = this.normalize(m, names.get(m.from) ?? null);
                if (n) inbound.push(n);
            }
            for (const s of v.statuses ?? []) {
                const status = s.status === "failed" ? "failed" : s.status === "read" ? "read" : s.status === "delivered" ? "delivered" : s.status === "sent" ? "sent" : null;
                if (status) receipts.push({ waId: s.id, jid: `${s.recipient_id}@s.whatsapp.net`, status, error: s.errors?.[0] ? cloudErrorMessage(s.errors[0].code, s.errors[0].title) : undefined });
            }
        }
        if (inbound.length) this.handlers.inbound(inbound);
        if (receipts.length) this.handlers.receipts(receipts);
    }

    private normalize(m: any, pushName: string | null): InboundMessage | null {
        if (!m?.id || !m.from) return null;
        let type: IncomingType = "other";
        let text = "";
        let interactiveReplyId: string | null = null;
        let mediaRef: { id: string; mime?: string; fileName?: string } | null = null;
        switch (m.type) {
            case "text": type = "text"; text = m.text?.body ?? ""; break;
            case "image": case "video": case "audio": case "sticker": case "document": {
                const d = m[m.type];
                type = m.type;
                text = d?.caption ?? "";
                mediaRef = { id: d?.id, mime: d?.mime_type, fileName: d?.filename };
                break;
            }
            case "location": type = "location"; text = `${m.location?.latitude},${m.location?.longitude}`; break;
            case "contacts": type = "contact"; text = m.contacts?.[0]?.name?.formatted_name ?? ""; break;
            case "interactive": {
                const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
                type = "interactive"; text = r?.title ?? ""; interactiveReplyId = r?.id ?? null;
                break;
            }
            case "button": type = "interactive"; text = m.button?.text ?? ""; interactiveReplyId = m.button?.payload ?? null; break;
            case "reaction": return null;
            default: type = "other";
        }
        return {
            jid: `${m.from}@s.whatsapp.net`, waId: m.id, fromMe: false, live: true, type, text, pushName,
            timestamp: new Date(Number(m.timestamp) * 1000 || Date.now()), quotedWaId: m.context?.id ?? null, interactiveReplyId,
            media: mediaRef?.id ? {
                mime: mediaRef.mime, fileName: mediaRef.fileName,
                download: async () => {
                    const meta = await this.graph(mediaRef!.id);
                    const res = await fetch(meta.url, { headers: { authorization: `Bearer ${this.cfg()!.accessToken}` }, signal: AbortSignal.timeout(60_000) });
                    if (!res.ok) throw new GraphError(`Download da mídia falhou (${res.status})`);
                    return { buffer: Buffer.from(await res.arrayBuffer()), mime: meta.mime_type || mediaRef!.mime || "application/octet-stream", fileName: mediaRef!.fileName };
                },
            } : undefined,
        };
    }

    isFatalSendError(err: unknown) {
        return err instanceof GraphError && !!err.code && FATAL_CODES.has(err.code);
    }
}

function safeJson(t: string) { try { return JSON.parse(t); } catch { return null; } }

/** Mensagens em português para os erros mais comuns da API oficial. */
export function cloudErrorMessage(code: number | undefined, fallback: string): string {
    switch (code) {
        case 131047: return "Fora da janela de 24 h: só dá para mandar modelo (template) aprovado";
        case 131026: return "Número não recebe mensagens (sem WhatsApp ou bloqueou)";
        case 131049: return "A Meta segurou a mensagem de marketing para este usuário (limite por pessoa)";
        case 131056: return "Muitas mensagens para o mesmo número em pouco tempo";
        case 130429: return "Limite de envio da API atingido";
        case 132001: return "Modelo não existe ou não está aprovado neste idioma";
        case 368: case 131031: return "Conta restrita pela Meta";
        case 190: return "Token da API oficial inválido ou expirado";
        default: return code ? `${fallback} (código ${code})` : fallback;
    }
}
