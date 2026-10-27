import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { newWaMessageId, phoneFromJid, PRIORITY, resolveSettings, summarize, type OutMessage } from "@areszap/core";
import { enqueueJob, mediaKindOf, publishEvent, recordMessage } from "@areszap/db";
import { requireUser } from "../auth";
import { HttpError, notFound, parse, uuid } from "../http";

const chatDto = (r: Record<string, any>) => ({
    id: r.id, jid: r.jid, title: r.title || r.name || r.push_name || null, phone: r.phone ?? phoneFromJid(r.jid),
    lastMessageText: r.last_message_text, lastMessageAt: r.last_message_at, lastFromMe: r.last_from_me, unread: r.unread,
    archived: r.archived, contactId: r.contact_id, pausedUntil: r.paused_until && new Date(r.paused_until) > new Date() ? r.paused_until : null,
    activeRun: r.run_id ? { id: r.run_id, flowId: r.run_flow_id, flowName: r.run_flow_name, status: r.run_status } : null,
});

const messageDto = (r: Record<string, any>) => ({
    id: r.id, waId: r.wa_id, fromMe: r.from_me, sender: r.sender, type: r.type, body: r.body,
    media: r.media ? { assetId: r.media.assetId ?? null, mime: r.media.mime ?? null, fileName: r.media.fileName ?? null } : null,
    status: r.status, createdAt: r.created_at,
});

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    app.get("/sessions/:id/chats", async req => {
        requireUser(req);
        const { id } = parse(z.object({ id: uuid }), req.params);
        const q = parse(z.object({
            search: z.string().trim().max(100).optional(),
            archived: z.enum(["0", "1"]).default("0"),
            cursor: z.iso.datetime().optional(),
            limit: z.coerce.number().int().min(1).max(100).default(40),
        }), req.query);
        const like = q.search ? `%${q.search.replace(/[%_\\]/g, "\\$&")}%` : null;
        const rows = await sql`
            select ch.*, c.name, c.push_name, c.phone, c.paused_until,
                   r.id as run_id, r.flow_id as run_flow_id, r.status as run_status, f.name as run_flow_name
            from chats ch
            left join contacts c on c.id = ch.contact_id
            left join lateral (
                select id, flow_id, status from flow_runs
                where contact_id = ch.contact_id and status in ('running','waiting_input','waiting_delay')
                order by created_at desc limit 1
            ) r on true
            left join flows f on f.id = r.flow_id
            where ch.session_id = ${id} and ch.archived = ${q.archived === "1"}
              ${q.cursor ? sql`and ch.last_message_at < ${q.cursor}` : sql``}
              ${like ? sql`and (ch.title ilike ${like} or c.name ilike ${like} or c.push_name ilike ${like} or ch.jid ilike ${like} or ch.last_message_text ilike ${like})` : sql``}
            order by ch.last_message_at desc nulls last
            limit ${q.limit + 1}`;
        const items = rows.slice(0, q.limit).map(chatDto);
        const last = rows[q.limit - 1];
        return { items, nextCursor: rows.length > q.limit && last?.last_message_at ? new Date(last.last_message_at).toISOString() : null };
    });

    const loadChat = async (chatId: string) => {
        const [c] = await sql`select ch.*, s.settings from chats ch join sessions s on s.id = ch.session_id where ch.id = ${chatId}`;
        if (!c) throw notFound("Conversa");
        return c;
    };

    app.get("/chats/:chatId", async req => {
        requireUser(req);
        const { chatId } = parse(z.object({ chatId: uuid }), req.params);
        const [r] = await sql`
            select ch.*, c.name, c.push_name, c.phone, c.paused_until,
                   r.id as run_id, r.flow_id as run_flow_id, r.status as run_status, f.name as run_flow_name
            from chats ch
            left join contacts c on c.id = ch.contact_id
            left join lateral (
                select id, flow_id, status from flow_runs
                where contact_id = ch.contact_id and status in ('running','waiting_input','waiting_delay')
                order by created_at desc limit 1
            ) r on true
            left join flows f on f.id = r.flow_id
            where ch.id = ${chatId}`;
        if (!r) throw notFound("Conversa");
        return chatDto(r);
    });

    app.get("/chats/:chatId/messages", async req => {
        requireUser(req);
        const { chatId } = parse(z.object({ chatId: uuid }), req.params);
        const q = parse(z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
        const rows = await sql`
            select * from messages where chat_id = ${chatId}
            ${q.before ? sql`and created_at < ${q.before}` : sql``}
            order by created_at desc limit ${q.limit}`;
        return { items: rows.map(messageDto) };
    });

    app.post("/chats/:chatId/messages", async req => {
        requireUser(req);
        const { chatId } = parse(z.object({ chatId: uuid }), req.params);
        const b = parse(z.object({
            text: z.string().trim().min(1).max(4096).optional(),
            assetId: uuid.optional(),
            caption: z.string().max(1024).optional(),
        }).refine(v => v.text || v.assetId, "Mande texto ou arquivo"), req.body);
        const chat = await loadChat(chatId);
        let payload: OutMessage;
        if (b.assetId) {
            const [a] = await sql`select mime, file_name from assets where id = ${b.assetId} and session_id = ${chat.session_id}`;
            if (!a) throw notFound("Arquivo");
            payload = { kind: "media", media: mediaKindOf(a.mime), assetId: b.assetId, caption: b.caption ?? b.text, fileName: a.file_name };
        } else payload = { kind: "text", text: b.text! };
        const waId = newWaMessageId();
        const [o] = await sql`
            insert into outbox (session_id, jid, payload, source, priority, wa_id)
            values (${chat.session_id}, ${chat.jid}, ${sql.json(payload as any)}, 'agent', ${PRIORITY.agent}, ${waId}) returning id`;
        // aparece na conversa na hora (status queued); o sender troca para sent quando sair
        const rec = await recordMessage(sql, {
            sessionId: chat.session_id, jid: chat.jid, waId, fromMe: true, sender: "agent",
            type: payload.kind === "media" ? payload.media : "text", body: summarize(payload),
            media: payload.kind === "media" ? { assetId: payload.assetId, fileName: payload.fileName } : null,
            status: "queued", createdAt: new Date(),
        });
        await publishEvent(sql, { t: "message", sessionId: chat.session_id, chatId: rec.chatId, messageId: rec.messageId, fromMe: true });
        // resposta do atendente = atendimento humano: o worker cancela o fluxo e pausa a automação do contato
        const settings = resolveSettings(chat.settings);
        if (settings.humanTakeover.enabled && chat.contact_id) {
            await enqueueJob(sql, "contact.takeover", {
                sessionId: chat.session_id, contactId: chat.contact_id,
                until: new Date(Date.now() + settings.humanTakeover.minutes * 60_000).toISOString(),
            });
        }
        await app.command({ c: "outbox.wake", sessionId: chat.session_id });
        return { outboxId: Number(o.id), waId };
    });

    app.post("/chats/:chatId/read", async req => {
        requireUser(req);
        const { chatId } = parse(z.object({ chatId: uuid }), req.params);
        const r = await sql`update chats set unread = 0 where id = ${chatId} returning session_id`;
        if (!r.length) throw notFound("Conversa");
        await publishEvent(sql, { t: "chat", sessionId: r[0].session_id, chatId });
        return { ok: true };
    });

    app.post("/chats/:chatId/archive", async req => {
        requireUser(req);
        const { chatId } = parse(z.object({ chatId: uuid }), req.params);
        const b = parse(z.object({ archived: z.boolean() }), req.body);
        const r = await sql`update chats set archived = ${b.archived} where id = ${chatId} returning session_id`;
        if (!r.length) throw notFound("Conversa");
        await publishEvent(sql, { t: "chat", sessionId: r[0].session_id, chatId });
        return { ok: true };
    });

    app.post("/chats/:chatId/automation", async req => {
        requireUser(req);
        const { chatId } = parse(z.object({ chatId: uuid }), req.params);
        const b = parse(z.discriminatedUnion("action", [
            z.object({ action: z.literal("resume") }),
            z.object({ action: z.literal("pause"), minutes: z.number().int().min(1).max(60 * 24 * 365) }),
        ]), req.body);
        const chat = await loadChat(chatId);
        if (!chat.contact_id) throw new HttpError(422, "Conversa sem contato");
        if (b.action === "resume") {
            await sql`update contacts set paused_until = null where id = ${chat.contact_id}`;
            await publishEvent(sql, { t: "chat", sessionId: chat.session_id, chatId });
            return { pausedUntil: null };
        }
        const until = new Date(Date.now() + b.minutes * 60_000);
        await enqueueJob(sql, "contact.takeover", { sessionId: chat.session_id, contactId: chat.contact_id, until: until.toISOString() });
        await sql`update contacts set paused_until = ${until} where id = ${chat.contact_id}`;
        await publishEvent(sql, { t: "chat", sessionId: chat.session_id, chatId });
        return { pausedUntil: until };
    });
};

export default routes;
