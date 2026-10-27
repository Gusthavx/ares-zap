import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { normalizePhone, resolveSettings, toUserJid, type OutMessage } from "@areszap/core";
import { enqueueJob, mediaKindOf, publishEvent } from "@areszap/db";
import { requireUser } from "../auth";
import { HttpError, idParam, notFound, parse, uuid } from "../http";

const MAX_RECIPIENTS = 50_000;

function dto(r: Record<string, any>, settings?: ReturnType<typeof resolveSettings>) {
    const left = Math.max(0, r.total - r.sent - r.failed - r.skipped);
    let etaAt: string | null = null;
    if (r.status === "running" && left > 0) {
        const min = r.min_gap_sec ?? settings?.sending.bulkMinGapSec ?? 15;
        const max = r.max_gap_sec ?? settings?.sending.bulkMaxGapSec ?? 45;
        etaAt = new Date(Date.now() + left * ((min + max) / 2) * 1000).toISOString();
    }
    return {
        id: r.id, name: r.name, status: r.status, message: r.message, scheduledAt: r.scheduled_at, minGapSec: r.min_gap_sec,
        maxGapSec: r.max_gap_sec, skipOptedOut: r.skip_opted_out, total: r.total, sent: r.sent, failed: r.failed, skipped: r.skipped,
        createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, etaAt,
    };
}

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    app.get("/sessions/:id/broadcasts", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [s] = await sql`select settings from sessions where id = ${id}`;
        const rows = await sql`select * from broadcasts where session_id = ${id} order by created_at desc limit 200`;
        return rows.map(r => dto(r, resolveSettings(s?.settings)));
    });

    app.post("/sessions/:id/broadcasts", { bodyLimit: 16 * 1024 * 1024 }, async req => {
        const user = requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            name: z.string().trim().min(1).max(120),
            text: z.string().max(4096).default(""),
            assetId: uuid.optional(),
            recipients: z.array(z.object({ phone: z.string().max(30), vars: z.record(z.string(), z.string().max(500)).optional() })).max(MAX_RECIPIENTS).optional(),
            labelIds: z.array(uuid).max(50).optional(),
            scheduledAt: z.iso.datetime({ offset: true }).optional(),
            minGapSec: z.number().int().min(1).max(3600).optional(),
            maxGapSec: z.number().int().min(1).max(3600).optional(),
            skipOptedOut: z.boolean().default(true),
        }), req.body);
        if (!b.text.trim() && !b.assetId) throw new HttpError(400, "Escreva a mensagem ou anexe um arquivo");
        if (b.minGapSec && b.maxGapSec && b.maxGapSec < b.minGapSec) throw new HttpError(400, "O intervalo máximo precisa ser maior que o mínimo");
        const [s] = await sql`select settings from sessions where id = ${id}`;
        if (!s) throw notFound("Sessão");
        const settings = resolveSettings(s.settings);

        let message: OutMessage = { kind: "text", text: b.text };
        if (b.assetId) {
            const [a] = await sql`select mime, file_name from assets where id = ${b.assetId} and session_id = ${id}`;
            if (!a) throw notFound("Arquivo");
            message = { kind: "media", media: mediaKindOf(a.mime), assetId: b.assetId, caption: b.text || undefined, fileName: a.file_name };
        }

        // destinatários: números colados + contatos das etiquetas, sem repetir
        const byJid = new Map<string, Record<string, string>>();
        let invalid = 0;
        for (const r of b.recipients ?? []) {
            const p = normalizePhone(r.phone, settings.defaultCountryCode);
            if (!p) { invalid++; continue; }
            byJid.set(toUserJid(p), r.vars ?? {});
        }
        if (b.labelIds?.length) {
            const rows = await sql`
                select distinct c.jid from contacts c join contact_labels cl on cl.contact_id = c.id
                join labels l on l.id = cl.label_id and l.session_id = ${id}
                where c.session_id = ${id} and cl.label_id in ${sql(b.labelIds)} and c.jid like '%@s.whatsapp.net'`;
            for (const r of rows) if (!byJid.has(r.jid)) byJid.set(r.jid, {});
        }
        if (!byJid.size) throw new HttpError(400, invalid ? "Nenhum número válido na lista" : "Adicione destinatários");
        if (byJid.size > MAX_RECIPIENTS) throw new HttpError(400, `Máximo de ${MAX_RECIPIENTS} destinatários por transmissão`);

        const runAt = b.scheduledAt ? new Date(b.scheduledAt) : new Date();
        const bc = await sql.begin(async tx => {
            const [row] = await tx`
                insert into broadcasts (session_id, name, message, status, scheduled_at, min_gap_sec, max_gap_sec, skip_opted_out, total, created_by)
                values (${id}, ${b.name}, ${tx.json(message as any)}, 'scheduled', ${b.scheduledAt ? runAt : null}, ${b.minGapSec ?? null},
                        ${b.maxGapSec ?? b.minGapSec ?? null}, ${b.skipOptedOut}, ${byJid.size}, ${user.id})
                returning *`;
            const all = [...byJid].map(([jid, vars]) => ({ broadcast_id: row.id, jid, vars: tx.json(vars) }));
            for (let i = 0; i < all.length; i += 2000) await tx`insert into broadcast_recipients ${tx(all.slice(i, i + 2000))}`;
            await enqueueJob(tx, "broadcast.start", { broadcastId: row.id }, { runAt, dedupeKey: `broadcast:${row.id}` });
            return row;
        });
        return { ...dto(bc, settings), invalidNumbers: invalid };
    });

    app.get("/broadcasts/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [r] = await sql`select b.*, s.settings from broadcasts b join sessions s on s.id = b.session_id where b.id = ${id}`;
        if (!r) throw notFound("Transmissão");
        return dto(r, resolveSettings(r.settings));
    });

    app.get("/broadcasts/:id/recipients", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const q = parse(z.object({ status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
        const rows = await sql`
            select id, jid, status, error, sent_at from broadcast_recipients
            where broadcast_id = ${id} ${q.status ? sql`and status = ${q.status}` : sql``}
            order by id limit ${q.limit} offset ${q.offset}`;
        const [t] = await sql`select count(*)::int as n from broadcast_recipients where broadcast_id = ${id} ${q.status ? sql`and status = ${q.status}` : sql``}`;
        return { items: rows.map(r => ({ id: Number(r.id), jid: r.jid, status: r.status, error: r.error, sentAt: r.sent_at })), total: t.n };
    });

    const change = async (id: string, fn: (b: Record<string, any>) => Promise<void>) => {
        const [b] = await sql`select * from broadcasts where id = ${id}`;
        if (!b) throw notFound("Transmissão");
        await fn(b);
        await publishEvent(sql, { t: "broadcast", sessionId: b.session_id, broadcastId: id });
        await app.command({ c: "outbox.wake", sessionId: b.session_id });
        return { ok: true };
    };

    app.post("/broadcasts/:id/pause", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        return change(id, async b => {
            if (b.status !== "running" && b.status !== "scheduled") throw new HttpError(422, "Só dá para pausar transmissão agendada ou rodando");
            await sql.begin(async tx => {
                await tx`update broadcasts set status = 'paused' where id = ${id}`;
                await tx`update outbox set status = 'held' where broadcast_id = ${id} and status = 'queued'`;
            });
        });
    });

    app.post("/broadcasts/:id/resume", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        return change(id, async b => {
            if (b.status !== "paused") throw new HttpError(422, "A transmissão não está pausada");
            await sql.begin(async tx => {
                // se pausou antes de começar, volta para agendada (a tarefa de início ainda vai rodar)
                const started = !!b.started_at;
                await tx`update broadcasts set status = ${started ? "running" : "scheduled"} where id = ${id}`;
                await tx`update outbox set status = 'queued', not_before = now() where broadcast_id = ${id} and status = 'held'`;
                if (!started) await enqueueJob(tx, "broadcast.start", { broadcastId: id }, { dedupeKey: `broadcast:${id}` });
            });
        });
    });

    app.post("/broadcasts/:id/cancel", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        return change(id, async b => {
            if (b.status === "completed" || b.status === "cancelled") throw new HttpError(422, "A transmissão já terminou");
            await sql.begin(async tx => {
                await tx`update broadcasts set status = 'cancelled', finished_at = now() where id = ${id}`;
                await tx`update outbox set status = 'cancelled' where broadcast_id = ${id} and status in ('queued','held')`;
                await tx`update broadcast_recipients set status = 'cancelled' where broadcast_id = ${id} and status in ('pending','queued')`;
            });
        });
    });
};

export default routes;
