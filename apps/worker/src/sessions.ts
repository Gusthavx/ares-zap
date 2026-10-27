import { publishEvent } from "@areszap/db";
import type { SessionStatus } from "@areszap/core";
import { log, type Ctx } from "./context";
import { BaileysProvider } from "./providers/baileys";
import { CloudProvider } from "./providers/cloud";
import type { Provider } from "./providers/types";
import type { InboundPipeline } from "./pipeline";
import { OutboxSender } from "./sender";
import type { Webhooks } from "./webhooks";

interface Live { provider: Provider; sender: OutboxSender; chain: Promise<unknown>; lastStatus: SessionStatus | null }

/** Sobe, derruba e acompanha as sessões (números) deste worker. */
export class SessionManager {
    private live = new Map<string, Live>();

    constructor(private ctx: Ctx, private pipeline: InboundPipeline, private hooks: Webhooks) { }

    get count() { return this.live.size; }
    provider(id: string) { return this.live.get(id)?.provider ?? null; }
    wake(id: string) { this.live.get(id)?.sender.wake(); }
    senderStats() { return Object.fromEntries([...this.live].map(([id, l]) => [id, l.sender.stats()])); }

    async bootstrap() {
        const rows = await this.ctx.sql`select id from sessions where enabled order by created_at`;
        for (const r of rows) await this.start(r.id).catch(e => log.error({ err: e, session: r.id }, "falha ao subir sessão"));
        log.info({ sessions: rows.length }, "sessões iniciadas");
    }

    async start(id: string) {
        if (this.live.has(id)) return;
        this.ctx.sessions.invalidate(id);
        const info = await this.ctx.sessions.get(id);
        if (!info) return;
        await this.ctx.sql`update sessions set enabled = true where id = ${id}`;

        const handlers = {
            status: (status: SessionStatus, extra?: { qr?: string | null; phone?: string | null; error?: string | null }) => void this.onStatus(id, status, extra),
            inbound: (msgs: Parameters<InboundPipeline["handle"]>[2]) => {
                const l = this.live.get(id);
                if (!l) return;
                // uma fila por sessão: mantém a ordem de chegada entre lotes
                l.chain = l.chain.then(() => this.pipeline.handle(id, l.provider, msgs)).catch(() => undefined);
            },
            receipts: (r: Parameters<InboundPipeline["receipts"]>[1]) => void this.pipeline.receipts(id, r),
        };
        const provider: Provider = info.provider === "cloud"
            ? new CloudProvider(id, () => this.ctx.sessions.peek(id)?.cloud ?? null, handlers, log.child({ session: id }))
            : new BaileysProvider(id, this.ctx.sql, () => this.ctx.sessions.peek(id)?.settings ?? info.settings, handlers, log.child({ session: id }));
        const sender = new OutboxSender(this.ctx, id, provider, this.hooks);
        this.live.set(id, { provider, sender, chain: Promise.resolve(), lastStatus: null });
        sender.start();
        await provider.start();
    }

    async stop(id: string, opts: { disable?: boolean } = {}) {
        const l = this.live.get(id);
        if (opts.disable) await this.ctx.sql`update sessions set enabled = false where id = ${id}`;
        if (!l) { await this.setStatus(id, "stopped"); return; }
        this.live.delete(id);
        l.sender.stop();
        await l.provider.stop();
    }

    async logout(id: string) {
        const l = this.live.get(id);
        this.live.delete(id);
        l?.sender.stop();
        if (l) await l.provider.logout();
        else await this.ctx.sql`delete from wa_auth where session_id = ${id}`;
        await this.ctx.sql`update sessions set enabled = false where id = ${id}`;
        await this.setStatus(id, "logged_out", { phone: null });
    }

    async reload(id: string) {
        await this.stop(id);
        await this.start(id);
    }

    async stopAll() {
        for (const id of [...this.live.keys()]) await this.stop(id).catch(() => undefined);
    }

    /** Atendimento à mudança de status vinda do provedor. */
    private async onStatus(id: string, status: SessionStatus, extra?: { qr?: string | null; phone?: string | null; error?: string | null }) {
        const l = this.live.get(id);
        const changed = l?.lastStatus !== status;
        if (l) l.lastStatus = status;
        await this.setStatus(id, status, extra).catch(e => log.error({ err: e }, "falha ao gravar status"));
        if (status === "connected") {
            this.ctx.sessions.invalidate(id); // pega first_connected_at novo para o aquecimento
            l?.sender.wake();
        }
        if (changed && status !== "qr") void this.hooks.emit(id, "session.status", { status, phone: extra?.phone ?? null, error: extra?.error ?? null });
        if (status === "logged_out" && l) { this.live.delete(id); l.sender.stop(); }
    }

    private async setStatus(id: string, status: SessionStatus, extra: { qr?: string | null; phone?: string | null; error?: string | null } = {}) {
        if (status !== "qr") {
            await this.ctx.sql`
                update sessions set status = ${status},
                    phone = ${extra.phone === undefined ? this.ctx.sql`phone` : extra.phone},
                    last_error = ${status === "connected" ? null : extra.error === undefined ? this.ctx.sql`last_error` : extra.error},
                    connected_at = ${status === "connected" ? this.ctx.sql`now()` : this.ctx.sql`connected_at`},
                    first_connected_at = ${status === "connected" ? this.ctx.sql`coalesce(first_connected_at, now())` : this.ctx.sql`first_connected_at`}
                where id = ${id}`;
        } else {
            await this.ctx.sql`update sessions set status = 'qr' where id = ${id} and status <> 'qr'`;
        }
        await publishEvent(this.ctx.sql, { t: "session.status", sessionId: id, status, phone: extra.phone, qr: extra.qr ?? null, error: extra.error ?? null });
    }
}
