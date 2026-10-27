import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth";
import { idParam, notFound, parse, uuid } from "../http";

const contactDto = (r: Record<string, any>) => ({
    id: r.id, jid: r.jid, phone: r.phone, name: r.name, pushName: r.push_name, fields: r.fields ?? {},
    labels: (r.labels ?? []).filter((l: any) => l?.id), pausedUntil: r.paused_until, optedOutAt: r.opted_out_at, createdAt: r.created_at,
});

const fieldKey = z.string().trim().min(1).max(60).regex(/^[\w\-.À-ÿ]+$/, "Campo só com letras, números, - _ .");

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    const loadContact = async (id: string) => {
        const [r] = await sql`
            select c.*, coalesce(json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color)) filter (where l.id is not null), '[]') as labels
            from contacts c left join contact_labels cl on cl.contact_id = c.id left join labels l on l.id = cl.label_id
            where c.id = ${id} group by c.id`;
        if (!r) throw notFound("Contato");
        return contactDto(r);
    };

    app.get("/sessions/:id/contacts", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const q = parse(z.object({
            search: z.string().trim().max(100).optional(),
            labelId: uuid.optional(),
            cursor: z.iso.datetime().optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
        }), req.query);
        const like = q.search ? `%${q.search.replace(/[%_\\]/g, "\\$&")}%` : null;
        const rows = await sql`
            select c.*, coalesce(json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color)) filter (where l.id is not null), '[]') as labels
            from contacts c
            left join contact_labels cl on cl.contact_id = c.id
            left join labels l on l.id = cl.label_id
            where c.session_id = ${id} and c.jid not like '%@g.us'
              ${like ? sql`and (c.name ilike ${like} or c.push_name ilike ${like} or c.phone ilike ${like})` : sql``}
              ${q.labelId ? sql`and exists (select 1 from contact_labels x where x.contact_id = c.id and x.label_id = ${q.labelId})` : sql``}
              ${q.cursor ? sql`and c.created_at < ${q.cursor}` : sql``}
            group by c.id
            order by c.created_at desc
            limit ${q.limit + 1}`;
        const items = rows.slice(0, q.limit).map(contactDto);
        return { items, nextCursor: rows.length > q.limit ? new Date(rows[q.limit - 1].created_at).toISOString() : null };
    });

    app.patch("/contacts/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({
            name: z.string().trim().max(120).nullable().optional(),
            fields: z.record(fieldKey, z.string().max(2000).nullable()).optional(),
            labelIds: z.array(uuid).max(100).optional(),
            optedOut: z.boolean().optional(),
        }), req.body);
        const [c] = await sql`select id, session_id from contacts where id = ${id}`;
        if (!c) throw notFound("Contato");
        await sql.begin(async tx => {
            if (b.name !== undefined) {
                await tx`update contacts set name = ${b.name} where id = ${id}`;
                await tx`update chats set title = ${b.name} where contact_id = ${id}`;
            }
            if (b.fields) {
                const set = Object.fromEntries(Object.entries(b.fields).filter(([, v]) => v !== null)) as Record<string, string>;
                const del = Object.entries(b.fields).filter(([, v]) => v === null).map(([k]) => k);
                await tx`update contacts set fields = (fields || ${tx.json(set)}) - ${del}::text[] where id = ${id}`;
            }
            if (b.optedOut !== undefined) await tx`update contacts set opted_out_at = ${b.optedOut ? tx`coalesce(opted_out_at, now())` : null} where id = ${id}`;
            if (b.labelIds) {
                await tx`delete from contact_labels where contact_id = ${id}`;
                if (b.labelIds.length) {
                    // só etiquetas da mesma sessão
                    await tx`insert into contact_labels (contact_id, label_id)
                             select ${id}, l.id from labels l where l.session_id = ${c.session_id} and l.id in ${tx(b.labelIds)}
                             on conflict do nothing`;
                }
            }
        });
        return loadContact(id);
    });

    // ---------- etiquetas ----------
    app.get("/sessions/:id/labels", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const rows = await sql`
            select l.*, (select count(*)::int from contact_labels cl where cl.label_id = l.id) as count
            from labels l where l.session_id = ${id} order by l.name`;
        return rows.map(r => ({ id: r.id, name: r.name, color: r.color, count: r.count }));
    });

    const labelBody = z.object({ name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });

    app.post("/sessions/:id/labels", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(labelBody, req.body);
        const [r] = await sql`insert into labels (session_id, name, color) values (${id}, ${b.name}, ${b.color ?? "#64748B"}) returning *`;
        await app.command({ c: "cache.invalidate", sessionId: id, what: "flows" });
        return { id: r.id, name: r.name, color: r.color, count: 0 };
    });

    app.patch("/labels/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(labelBody.partial(), req.body);
        const [r] = await sql`update labels set name = coalesce(${b.name ?? null}, name), color = coalesce(${b.color ?? null}, color) where id = ${id} returning *`;
        if (!r) throw notFound("Etiqueta");
        await app.command({ c: "cache.invalidate", sessionId: r.session_id, what: "flows" });
        return { id: r.id, name: r.name, color: r.color };
    });

    app.delete("/labels/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [r] = await sql`delete from labels where id = ${id} returning session_id`;
        if (!r) throw notFound("Etiqueta");
        await app.command({ c: "cache.invalidate", sessionId: r.session_id, what: "flows" });
        return { ok: true };
    });

    // ---------- variáveis globais do robô ----------
    app.get("/sessions/:id/variables", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const rows = await sql`select key, value from bot_variables where session_id = ${id} order by key`;
        return Object.fromEntries(rows.map(r => [r.key, r.value]));
    });

    app.put("/sessions/:id/variables", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.record(fieldKey, z.string().max(4000).nullable()), req.body);
        await sql.begin(async tx => {
            for (const [k, v] of Object.entries(b)) {
                if (v === null) await tx`delete from bot_variables where session_id = ${id} and key = ${k}`;
                else await tx`insert into bot_variables (session_id, key, value) values (${id}, ${k}, ${v})
                              on conflict (session_id, key) do update set value = excluded.value`;
            }
        });
        const rows = await sql`select key, value from bot_variables where session_id = ${id} order by key`;
        return Object.fromEntries(rows.map(r => [r.key, r.value]));
    });
};

export default routes;
