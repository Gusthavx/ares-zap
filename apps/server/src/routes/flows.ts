import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
    emptyGraph, hasErrors, normalizePhone, resolveSettings, toUserJid, validateGraph, validateTriggers,
    type FlowGraph, type FlowTrigger,
} from "@areszap/core";
import { enqueueJob, ensureContact } from "@areszap/db";
import { requireUser } from "../auth";
import { HttpError, idParam, notFound, parse } from "../http";
import { importFlow } from "../import-flow";

const MAX_GRAPH_BYTES = 2 * 1024 * 1024;

const triggerSchema = z.object({
    id: z.string().min(1).max(40),
    type: z.enum(["keyword", "firstMessage", "anyMessage"]),
    match: z.enum(["exact", "word", "contains", "regex"]).optional(),
    value: z.string().max(500).optional(),
    priority: z.number().int().min(-1000).max(1000).default(0),
});
const graphSchema = z.object({ nodes: z.array(z.any()).max(500), edges: z.array(z.any()).max(3000) });

function summaryDto(r: Record<string, any>) {
    return {
        id: r.id, name: r.name, status: r.status, publishedVersion: r.published_version, publishedAt: r.published_at,
        updatedAt: r.updated_at, triggers: r.draft_triggers ?? [], runsActive: r.runs_active ?? 0,
        hasUnpublishedChanges: !r.published_graph || JSON.stringify(r.published_graph) !== JSON.stringify(r.draft_graph)
            || JSON.stringify(r.published_triggers ?? []) !== JSON.stringify(r.draft_triggers ?? []),
    };
}

function flowDto(r: Record<string, any>) {
    return {
        ...summaryDto(r), sessionId: r.session_id, draftGraph: r.draft_graph, draftTriggers: r.draft_triggers ?? [],
        draftRevision: r.draft_revision, publishedGraph: r.published_graph, publishedTriggers: r.published_triggers,
    };
}

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    const load = async (id: string) => {
        const [r] = await sql`select * from flows where id = ${id}`;
        if (!r) throw notFound("Fluxo");
        return r;
    };
    const invalidate = (sessionId: string) => app.command({ c: "cache.invalidate", sessionId, what: "flows" });

    app.get("/sessions/:id/flows", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const rows = await sql`
            select f.*, (select count(*)::int from flow_runs r where r.flow_id = f.id and r.status in ('running','waiting_input','waiting_delay')) as runs_active
            from flows f where f.session_id = ${id} order by f.updated_at desc`;
        return rows.map(summaryDto);
    });

    app.post("/sessions/:id/flows", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ name: z.string().trim().min(1).max(120), graph: graphSchema.optional(), triggers: z.array(triggerSchema).max(50).optional() }), req.body);
        const [r] = await sql`
            insert into flows (session_id, name, draft_graph, draft_triggers)
            values (${id}, ${b.name}, ${sql.json((b.graph ?? emptyGraph()) as any)}, ${sql.json((b.triggers ?? []) as any)}) returning *`;
        return flowDto(r);
    });

    app.post("/sessions/:id/flows/import", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const imported = importFlow(req.body);
        const [r] = await sql`
            insert into flows (session_id, name, draft_graph, draft_triggers)
            values (${id}, ${imported.name}, ${sql.json(imported.graph as any)}, ${sql.json(imported.triggers as any)}) returning *`;
        return { ...flowDto(r), importWarnings: imported.warnings };
    });

    app.get("/flows/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const r = await load(id);
        const [c] = await sql`select count(*)::int as n from flow_runs where flow_id = ${id} and status in ('running','waiting_input','waiting_delay')`;
        return flowDto({ ...r, runs_active: c.n });
    });

    app.get("/flows/:id/export", async (req, reply) => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const r = await load(id);
        reply.header("content-disposition", `attachment; filename="fluxo-${encodeURIComponent(r.name)}.json"`);
        return { format: "areszap-flow@1", name: r.name, graph: r.draft_graph, triggers: r.draft_triggers ?? [] };
    });

    app.patch("/flows/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
        const [r] = await sql`update flows set name = ${b.name}, updated_at = now() where id = ${id} returning *`;
        if (!r) throw notFound("Fluxo");
        await invalidate(r.session_id);
        return flowDto(r);
    });

    // rascunho com concorrência otimista: duas abas não se sobrescrevem
    app.put("/flows/:id/draft", { bodyLimit: MAX_GRAPH_BYTES }, async (req, reply) => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ graph: graphSchema, triggers: z.array(triggerSchema).max(50), revision: z.number().int().min(0) }), req.body);
        const [r] = await sql`
            update flows set draft_graph = ${sql.json(b.graph as any)}, draft_triggers = ${sql.json(b.triggers as any)},
                draft_revision = draft_revision + 1, updated_at = now()
            where id = ${id} and draft_revision = ${b.revision}
            returning draft_revision`;
        if (r) return { revision: r.draft_revision };
        const [cur] = await sql`select draft_revision from flows where id = ${id}`;
        if (!cur) throw notFound("Fluxo");
        return reply.status(409).send({ error: "O fluxo foi salvo em outra aba. Recarregue para continuar.", revision: cur.draft_revision });
    });

    app.post("/flows/:id/validate", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const r = await load(id);
        return { issues: [...validateGraph(r.draft_graph), ...validateTriggers(r.draft_triggers ?? [])] };
    });

    app.post("/flows/:id/publish", async (req, reply) => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const r = await load(id);
        const graph = r.draft_graph as FlowGraph;
        const triggers = (r.draft_triggers ?? []) as FlowTrigger[];
        const issues = [...validateGraph(graph), ...validateTriggers(triggers)];
        // flowLink só pode apontar para fluxo da mesma sessão
        const links = graph.nodes.filter(n => n.type === "flowLink").map(n => (n.data as { flowId?: string }).flowId).filter((x): x is string => !!x);
        if (links.length) {
            const ok = await sql`select id from flows where session_id = ${r.session_id} and id in ${sql(links)}`;
            const okIds = new Set(ok.map(x => x.id));
            for (const l of links) if (!okIds.has(l)) issues.push({ level: "error", message: "Uma conexão de fluxo aponta para um fluxo que não existe nesta sessão." });
        }
        if (hasErrors(issues)) return reply.status(422).send({ error: "O fluxo tem erros", issues });
        const [u] = await sql`
            update flows set published_graph = draft_graph, published_triggers = draft_triggers,
                published_version = published_version + 1, published_at = now(), status = 'active', updated_at = now()
            where id = ${id} returning published_version`;
        await invalidate(r.session_id);
        return { version: u.published_version, issues };
    });

    for (const [action, status] of [["activate", "active"], ["deactivate", "inactive"]] as const) {
        app.post(`/flows/:id/${action}`, async req => {
            requireUser(req);
            const { id } = parse(idParam, req.params);
            const r = await load(id);
            if (status === "active" && !r.published_graph) throw new HttpError(422, "Publique o fluxo antes de ativar");
            await sql`update flows set status = ${status}, updated_at = now() where id = ${id}`;
            await invalidate(r.session_id);
            return { ok: true };
        });
    }

    app.post("/flows/:id/duplicate", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const r = await load(id);
        const [c] = await sql`
            insert into flows (session_id, name, draft_graph, draft_triggers)
            values (${r.session_id}, ${`${r.name} (cópia)`}, ${sql.json(r.draft_graph)}, ${sql.json(r.draft_triggers ?? [])}) returning *`;
        return flowDto(c);
    });

    app.delete("/flows/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [r] = await sql`delete from flows where id = ${id} returning session_id`;
        if (!r) throw notFound("Fluxo");
        await invalidate(r.session_id);
        return { ok: true };
    });

    app.post("/flows/:id/simulate", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async req => {
        const user = requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ text: z.string().max(4096).optional(), optionId: z.string().max(60).optional(), reset: z.boolean().optional(), skipWait: z.boolean().optional() }), req.body);
        if (b.reset) {
            app.sims.reset(user.id, id);
            return { result: "reset", messages: [], run: null, fields: {}, tags: [], events: [] };
        }
        const r = await load(id);
        return app.sims.simulate(user, { id, sessionId: r.session_id, name: r.name, graph: r.draft_graph, triggers: r.draft_triggers ?? [] }, b);
    });

    app.post("/flows/:id/test", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const b = parse(z.object({ phone: z.string().min(8).max(25) }), req.body);
        const r = await load(id);
        const issues = validateGraph(r.draft_graph);
        if (hasErrors(issues)) throw new HttpError(422, "O rascunho tem erros", { issues });
        const [s] = await sql`select settings from sessions where id = ${r.session_id}`;
        const phone = normalizePhone(b.phone, resolveSettings(s?.settings).defaultCountryCode);
        if (!phone) throw new HttpError(400, "Telefone inválido");
        const ref = await ensureContact(sql, r.session_id, toUserJid(phone));
        await enqueueJob(sql, "flow.test", { contactId: ref.contactId, flowId: id, name: r.name, graph: r.draft_graph });
        return { contactId: ref.contactId, queued: true };
    });

    app.get("/flows/:id/stats", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const rows = await sql`select node_id, key, count from flow_node_stats where flow_id = ${id} and key <> 'seq'`;
        const nodes: Record<string, Record<string, number>> = {};
        for (const r of rows) (nodes[r.node_id] ??= {})[r.key] = r.count;
        const runs = await sql`select status, count(*)::int as n from flow_runs where flow_id = ${id} and not is_test group by status`;
        return { nodes, runs: Object.fromEntries(runs.map(r => [r.status, r.n])) };
    });

    app.get("/flows/:id/runs", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const q = parse(z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
        const rows = await sql`
            select r.id, r.flow_id, r.flow_version, r.contact_id, c.jid, c.name, c.push_name, r.status, r.current_node_id, r.resume_at,
                   r.is_test, r.error, r.created_at, r.updated_at
            from flow_runs r join contacts c on c.id = r.contact_id
            where r.flow_id = ${id} ${q.status ? sql`and r.status = ${q.status}` : sql``}
            order by r.created_at desc limit ${q.limit}`;
        return {
            items: rows.map(r => ({
                id: r.id, flowId: r.flow_id, flowVersion: r.flow_version, contactId: r.contact_id, jid: r.jid, contactName: r.name || r.push_name,
                status: r.status, currentNodeId: r.current_node_id, resumeAt: r.resume_at, isTest: r.is_test, error: r.error,
                createdAt: r.created_at, updatedAt: r.updated_at,
            })),
        };
    });

    app.get("/runs/:id/events", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const rows = await sql`select id, node_id, kind, detail, created_at from flow_events where run_id = ${id} order by id limit 1000`;
        return { items: rows.map(r => ({ id: Number(r.id), nodeId: r.node_id, kind: r.kind, detail: r.detail, createdAt: r.created_at })) };
    });

    app.post("/runs/:id/cancel", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [r] = await sql`select id from flow_runs where id = ${id} and status in ('running','waiting_input','waiting_delay')`;
        if (!r) throw new HttpError(422, "Execução não está ativa");
        await enqueueJob(sql, "run.cancel", { runId: id, reason: "Cancelado pelo painel" });
        return { ok: true };
    });

    // campos conhecidos (para o editor sugerir): do sistema + usados nos contatos + variáveis do robô
    app.get("/sessions/:id/fields", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const contactKeys = await sql`select distinct jsonb_object_keys(fields) as k from (select fields from contacts where session_id = ${id} order by created_at desc limit 5000) x`;
        const botKeys = await sql`select key from bot_variables where session_id = ${id}`;
        return { contact: contactKeys.map(r => r.k).sort(), bot: botKeys.map(r => r.key).sort() };
    });
};

export default routes;
