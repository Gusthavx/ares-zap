import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { dailyCap, resolveSettings, sessionSettingsSchema } from "@areszap/core";
import { sealSecret } from "@areszap/db";
import { requireAdmin, requireUser } from "../auth";
import { HttpError, idParam, notFound, parse } from "../http";

const cloudSchema = z.object({
    phoneNumberId: z.string().trim().min(3),
    wabaId: z.string().trim().optional(),
    accessToken: z.string().trim().min(10).optional(),
    appSecret: z.string().trim().min(8).optional(),
    verifyToken: z.string().trim().min(8).optional(),
});

export function sessionDto(r: Record<string, any>, qr?: string | null) {
    const cc = (r.cloud_config ?? null) as Record<string, string> | null;
    return {
        id: r.id, name: r.name, provider: r.provider, enabled: r.enabled, status: r.status, phone: r.phone,
        lastError: r.last_error, settings: resolveSettings(r.settings), connectedAt: r.connected_at, createdAt: r.created_at,
        qr: qr ?? null,
        // segredos nunca saem; só se estão configurados
        cloud: cc ? { phoneNumberId: cc.phoneNumberId ?? null, wabaId: cc.wabaId ?? null, verifyToken: cc.verifyToken ?? null, hasToken: !!cc.accessToken, hasAppSecret: !!cc.appSecret } : null,
    };
}

/** Mescla a configuração nova da API oficial sem apagar segredos já salvos. */
function mergeCloud(prev: Record<string, string> | null, next: z.infer<typeof cloudSchema>) {
    const out: Record<string, string> = { ...(prev ?? {}) };
    out.phoneNumberId = next.phoneNumberId;
    if (next.wabaId !== undefined) out.wabaId = next.wabaId;
    if (next.verifyToken) out.verifyToken = next.verifyToken;
    if (next.accessToken) out.accessToken = sealSecret(next.accessToken);
    if (next.appSecret) out.appSecret = sealSecret(next.appSecret);
    return out;
}

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    app.get("/sessions", async req => {
        requireUser(req);
        const rows = await sql`select * from sessions order by created_at`;
        return rows.map(r => sessionDto(r, app.qr.get(r.id)));
    });

    app.post("/sessions", async req => {
        const u = requireUser(req);
        const b = parse(z.object({
            name: z.string().trim().min(1).max(80),
            provider: z.enum(["baileys", "cloud"]).default("baileys"),
            cloud: cloudSchema.optional(),
        }), req.body);
        if (b.provider === "cloud" && (!b.cloud?.accessToken || !b.cloud.phoneNumberId)) {
            throw new HttpError(400, "Informe phoneNumberId e accessToken da API oficial");
        }
        const cloud = b.provider === "cloud" && b.cloud ? mergeCloud(null, { ...b.cloud, verifyToken: b.cloud.verifyToken ?? crypto.randomUUID() }) : null;
        const [r] = await sql`
            insert into sessions (name, provider, cloud_config, owner_id, enabled)
            values (${b.name}, ${b.provider}, ${cloud ? sql.json(cloud) : null}, ${u.id}, true) returning *`;
        await app.command({ c: "session.start", sessionId: r.id });
        return sessionDto(r);
    });

    app.get("/sessions/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [r] = await sql`select * from sessions where id = ${id}`;
        if (!r) throw notFound("Sessão");
        return sessionDto(r, app.qr.get(id));
    });

    app.patch("/sessions/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            name: z.string().trim().min(1).max(80).optional(),
            settings: z.record(z.string(), z.unknown()).optional(),
            cloud: cloudSchema.optional(),
        }), req.body);
        const [cur] = await sql`select * from sessions where id = ${id}`;
        if (!cur) throw notFound("Sessão");
        // valida a configuração completa (mesclada) com o schema compartilhado
        const settings = b.settings ? parse(sessionSettingsSchema, deepMerge(resolveSettings(cur.settings), b.settings)) : null;
        const cloud = b.cloud ? mergeCloud(cur.cloud_config, b.cloud) : null;
        const [r] = await sql`
            update sessions set
                name = ${b.name ?? cur.name},
                settings = ${settings ? sql.json(settings as any) : cur.settings},
                cloud_config = ${cloud ? sql.json(cloud) : cur.cloud_config}
            where id = ${id} returning *`;
        await app.command({ c: "cache.invalidate", sessionId: id, what: "settings" });
        if (cloud) await app.command({ c: "session.reload", sessionId: id });
        return sessionDto(r, app.qr.get(id));
    });

    app.delete("/sessions/:id", async req => {
        requireAdmin(req); // no MarcFlow qualquer usuário com acesso compartilhado apagava a sessão
        const { id } = parse(idParam, req.params);
        await app.command({ c: "session.logout", sessionId: id });
        const r = await sql`delete from sessions where id = ${id} returning id`;
        if (!r.length) throw notFound("Sessão");
        app.qr.delete(id);
        return { ok: true };
    });

    for (const action of ["start", "stop", "logout"] as const) {
        app.post(`/sessions/:id/${action}`, async req => {
            requireUser(req);
            const { id } = parse(idParam, req.params);
            const [r] = await sql`select id from sessions where id = ${id}`;
            if (!r) throw notFound("Sessão");
            if (action === "start") await sql`update sessions set enabled = true where id = ${id}`;
            await app.command({ c: `session.${action}`, sessionId: id });
            return { ok: true };
        });
    }

    app.get("/sessions/:id/stats", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [s] = await sql`select settings, first_connected_at from sessions where id = ${id}`;
        if (!s) throw notFound("Sessão");
        const settings = resolveSettings(s.settings);
        const [o] = await sql`
            select
                count(*) filter (where status = 'queued')::int as queued,
                count(*) filter (where status = 'held')::int as held,
                count(*) filter (where status = 'sending')::int as sending,
                count(*) filter (where status = 'sent' and sent_at >= date_trunc('day', now() at time zone ${settings.timezone}) at time zone ${settings.timezone})::int as "sentToday",
                count(*) filter (where status = 'failed' and created_at >= date_trunc('day', now() at time zone ${settings.timezone}) at time zone ${settings.timezone})::int as "failedToday",
                count(*) filter (where status = 'sent' and priority >= 2 and sent_at >= date_trunc('day', now() at time zone ${settings.timezone}) at time zone ${settings.timezone})::int as "bulkToday"
            from outbox where session_id = ${id}`;
        const [f] = await sql`
            select (select count(*)::int from flows where session_id = ${id} and status = 'active') as active,
                   (select count(*)::int from flow_runs where session_id = ${id} and status in ('running','waiting_input','waiting_delay')) as "runsActive"`;
        const days = s.first_connected_at ? Math.floor((Date.now() - new Date(s.first_connected_at).getTime()) / 86_400_000) : 0;
        return { outbox: o, cap: { today: dailyCap(settings, days), perDay: settings.sending.perDay, bulkToday: o.bulkToday }, flows: f };
    });
};

function deepMerge(a: any, b: any): any {
    if (Array.isArray(b) || b === null || typeof b !== "object") return b;
    const out: any = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object" ? deepMerge(a[k], v) : v;
    return out;
}

export default routes;
