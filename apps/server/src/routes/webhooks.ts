import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { WEBHOOK_EVENTS } from "@areszap/core";
import { assertPublicUrl, enqueueJob } from "@areszap/db";
import { requireUser } from "../auth";
import { HttpError, idParam, notFound, parse, uuid } from "../http";

// o segredo nunca é devolvido depois da criação (o MarcFlow listava os segredos)
const dto = (r: Record<string, any>) => ({
    id: r.id, sessionId: r.session_id, url: r.url, events: r.events, active: r.active,
    lastStatus: r.last_status, lastError: r.last_error, lastAt: r.last_at, createdAt: r.created_at,
});

const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Escolha pelo menos um evento");

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;
    const invalidate = () => app.command({ c: "cache.invalidate", sessionId: "*", what: "webhooks" });
    const checkUrl = async (url: string) => {
        try { await assertPublicUrl(url); } catch (e) { throw new HttpError(400, (e as Error).message); }
    };

    app.get("/webhooks", async req => {
        requireUser(req);
        const rows = await sql`select * from webhooks order by created_at desc`;
        return rows.map(dto);
    });

    app.post("/webhooks", async req => {
        requireUser(req);
        const b = parse(z.object({ sessionId: uuid.nullable().optional(), url: z.string().url().max(2000), events }), req.body);
        await checkUrl(b.url);
        const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
        const [r] = await sql`insert into webhooks (session_id, url, events, secret) values (${b.sessionId ?? null}, ${b.url}, ${b.events}, ${secret}) returning *`;
        await invalidate();
        return { ...dto(r), secret };
    });

    app.patch("/webhooks/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ url: z.string().url().max(2000).optional(), events: events.optional(), active: z.boolean().optional() }), req.body);
        if (b.url) await checkUrl(b.url);
        const [r] = await sql`
            update webhooks set url = coalesce(${b.url ?? null}, url), events = coalesce(${b.events ?? null}, events),
                active = coalesce(${b.active ?? null}, active)
            where id = ${id} returning *`;
        if (!r) throw notFound("Webhook");
        await invalidate();
        return dto(r);
    });

    app.delete("/webhooks/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const r = await sql`delete from webhooks where id = ${id} returning id`;
        if (!r.length) throw notFound("Webhook");
        await invalidate();
        return { ok: true };
    });

    app.post("/webhooks/:id/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [r] = await sql`select id, session_id from webhooks where id = ${id}`;
        if (!r) throw notFound("Webhook");
        await enqueueJob(sql, "webhook.deliver", {
            webhookId: id, body: { event: "test", sessionId: r.session_id, data: { message: "Teste do Ares Zap" }, at: new Date().toISOString() },
        }, { maxAttempts: 1 });
        return { ok: true };
    });
};

export default routes;
