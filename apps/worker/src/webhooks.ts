import crypto from "node:crypto";
import type postgres from "postgres";
import { enqueueJob, safeFetch } from "@areszap/db";
import type { WebhookEvent } from "@areszap/core";
import { log } from "./context";

interface Hook { id: string; sessionId: string | null; events: string[] }

/**
 * Webhooks de saída. Cada evento vira uma tarefa por webhook (com nova tentativa e espera crescente);
 * o envio nunca trava o pipeline de mensagens.
 */
export class Webhooks {
    private cache: { at: number; hooks: Hook[] } | null = null;
    constructor(private sql: postgres.Sql) { }

    invalidate() { this.cache = null; }

    private async hooks(): Promise<Hook[]> {
        if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.hooks;
        const rows = await this.sql`select id, session_id, events from webhooks where active`;
        this.cache = { at: Date.now(), hooks: rows.map(r => ({ id: r.id, sessionId: r.session_id, events: r.events })) };
        return this.cache.hooks;
    }

    /** Dispara o evento para os webhooks que assinam (da sessão ou globais). Não lança erro. */
    async emit(sessionId: string, event: WebhookEvent, data: unknown) {
        try {
            const targets = (await this.hooks()).filter(h => (!h.sessionId || h.sessionId === sessionId) && h.events.includes(event));
            for (const h of targets) {
                await enqueueJob(this.sql, "webhook.deliver", { webhookId: h.id, body: { event, sessionId, data, at: new Date().toISOString() } }, { maxAttempts: 6 });
            }
        } catch (e) {
            log.warn({ err: e, event }, "falha ao enfileirar webhook");
        }
    }

    /** Tarefa de entrega: assina com HMAC-SHA256 e manda. Não-2xx lança erro para a fila tentar de novo. */
    async deliver(payload: { webhookId: string; body: unknown }) {
        const [h] = await this.sql`select url, secret, active from webhooks where id = ${payload.webhookId}`;
        if (!h || !h.active) return;
        const body = JSON.stringify(payload.body);
        const signature = crypto.createHmac("sha256", h.secret).update(body).digest("hex");
        let status = 0;
        let error: string | null = null;
        try {
            const res = await safeFetch(h.url, {
                method: "POST", body, timeoutMs: 10_000,
                headers: { "content-type": "application/json", "x-areszap-signature": `sha256=${signature}`, "user-agent": "AresZap-Webhook/1" },
            });
            status = res.status;
            if (!res.ok) error = `HTTP ${res.status}`;
        } catch (e) {
            error = (e as Error).message;
        }
        await this.sql`update webhooks set last_status = ${status || null}, last_error = ${error}, last_at = now() where id = ${payload.webhookId}`;
        if (error) throw new Error(error);
    }
}
