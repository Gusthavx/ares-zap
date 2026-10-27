import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { newWaMessageId, normalizePhone, PRIORITY, resolveSettings, toUserJid, type OutMessage } from "@areszap/core";
import { assertPublicUrl, enqueueJob, ensureContact } from "@areszap/db";
import { requireUser } from "../auth";
import { HttpError, idParam, notFound, parse, uuid } from "../http";

/** API para integrações (header x-api-key). Mandar mensagem e registrar evento externo. */
const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    const session = async (id: string) => {
        const [s] = await sql`select id, settings from sessions where id = ${id}`;
        if (!s) throw notFound("Sessão");
        return { id: s.id as string, settings: resolveSettings(s.settings) };
    };

    app.get("/sessions", async req => {
        requireUser(req);
        const rows = await sql`select id, name, provider, status, phone from sessions order by created_at`;
        return rows.map(r => ({ id: r.id, name: r.name, provider: r.provider, status: r.status, phone: r.phone }));
    });

    app.post("/sessions/:id/messages", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            to: z.string().min(8).max(30),
            text: z.string().max(4096).optional(),
            media: z.object({
                type: z.enum(["image", "video", "audio", "file"]),
                url: z.string().url().optional(), assetId: uuid.optional(),
                caption: z.string().max(1024).optional(), fileName: z.string().max(180).optional(),
            }).optional(),
            template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(15), components: z.array(z.any()).optional() }).optional(),
        }).refine(v => v.text || v.media || v.template, "Mande text, media ou template"), req.body);
        const s = await session(id);
        const phone = normalizePhone(b.to, s.settings.defaultCountryCode);
        if (!phone) throw new HttpError(400, "Telefone inválido");
        let payload: OutMessage;
        if (b.template) payload = { kind: "template", ...b.template };
        else if (b.media) {
            if (b.media.url) {
                try { await assertPublicUrl(b.media.url); } catch (e) { throw new HttpError(400, (e as Error).message); }
            }
            if (!b.media.url && !b.media.assetId) throw new HttpError(400, "media precisa de url ou assetId");
            payload = { kind: "media", media: b.media.type, url: b.media.url, assetId: b.media.assetId, caption: b.media.caption ?? b.text, fileName: b.media.fileName };
        } else payload = { kind: "text", text: b.text! };
        const jid = toUserJid(phone);
        await ensureContact(sql, id, jid);
        const waId = newWaMessageId();
        const [o] = await sql`
            insert into outbox (session_id, jid, payload, source, priority, wa_id)
            values (${id}, ${jid}, ${sql.json(payload as any)}, 'api', ${PRIORITY.api}, ${waId}) returning id`;
        await app.command({ c: "outbox.wake", sessionId: id });
        return { outboxId: Number(o.id), waId };
    });

    /** Evento externo (ex.: compra aprovada): grava campos no contato e, se pedir, inicia um fluxo publicado num bloco. */
    app.post("/sessions/:id/events", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            phone: z.string().min(8).max(30),
            name: z.string().max(120).optional(),
            fields: z.record(z.string().max(60), z.string().max(2000)).optional(),
            flowId: uuid.optional(),
            nodeId: z.string().max(40).optional(),
        }), req.body);
        const s = await session(id);
        const phone = normalizePhone(b.phone, s.settings.defaultCountryCode);
        if (!phone) throw new HttpError(400, "Telefone inválido");
        if (b.flowId) {
            const [f] = await sql`select id, published_graph from flows where id = ${b.flowId} and session_id = ${id} and status = 'active'`;
            if (!f?.published_graph) throw new HttpError(422, "Fluxo não está ativo nesta sessão");
            if (b.nodeId && !(f.published_graph.nodes as { id: string }[]).some(n => n.id === b.nodeId)) throw new HttpError(422, "Bloco não existe no fluxo publicado");
        }
        const ref = await ensureContact(sql, id, toUserJid(phone), b.name ?? null);
        if (b.name) await sql`update contacts set name = coalesce(name, ${b.name}) where id = ${ref.contactId}`;
        if (b.flowId) {
            // roda no worker, serializado com as mensagens do contato
            await enqueueJob(sql, "flow.start", { contactId: ref.contactId, fields: b.fields ?? {}, flowId: b.flowId, nodeId: b.nodeId });
        } else if (b.fields && Object.keys(b.fields).length) {
            await sql`update contacts set fields = fields || ${sql.json(b.fields)} where id = ${ref.contactId}`;
        }
        return { contactId: ref.contactId, queued: !!b.flowId };
    });
};

export default routes;
