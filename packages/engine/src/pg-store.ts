import type postgres from "postgres";
import { PRIORITY, type FlowGraph, type FlowTrigger } from "@areszap/core";
import type { ActiveFlow, CommitBatch, ContactRow, EngineStore, RunRow, Wait } from "./store";

type Sql = postgres.Sql;
const j = (sql: Sql | postgres.TransactionSql, v: unknown) => sql.json(v as postgres.JSONValue);

function toRun(r: Record<string, any>): RunRow {
    return {
        id: r.id, flowId: r.flow_id, flowVersion: r.flow_version, sessionId: r.session_id, contactId: r.contact_id,
        jid: r.jid, graph: r.graph as FlowGraph, status: r.status, currentNodeId: r.current_node_id, wait: (r.wait ?? null) as Wait | null,
        resumeAt: r.resume_at, lastKeyId: r.last_key_id, steps: r.steps, isTest: r.is_test, error: r.error, createdAt: r.created_at,
    };
}

function toContact(r: Record<string, any>): ContactRow {
    return {
        id: r.id, sessionId: r.session_id, jid: r.jid, phone: r.phone, name: r.name, pushName: r.push_name,
        fields: r.fields ?? {}, pausedUntil: r.paused_until, optedOutAt: r.opted_out_at,
    };
}

/**
 * Store do motor em Postgres. Os fluxos ativos e as etiquetas ficam em cache por sessão;
 * o worker invalida o cache quando o painel publica/edita (comando cache.invalidate).
 */
export class PgStore implements EngineStore {
    private flowCache = new Map<string, { at: number; flows: ActiveFlow[] }>();
    private labelCache = new Map<string, { at: number; labels: Map<string, string> }>();
    private ttlMs = 60_000;

    constructor(private sql: Sql, private hooks: { onOutbound?: (sessionIds: string[]) => void } = {}) { }

    invalidate(sessionId?: string) {
        if (sessionId) { this.flowCache.delete(sessionId); this.labelCache.delete(sessionId); }
        else { this.flowCache.clear(); this.labelCache.clear(); }
    }

    async findActiveRun(contactId: string) {
        const rows = await this.sql`
            select r.*, c.jid from flow_runs r join contacts c on c.id = r.contact_id
            where r.contact_id = ${contactId} and r.status in ('running','waiting_input','waiting_delay')
            order by r.created_at desc limit 1`;
        return rows[0] ? toRun(rows[0]) : null;
    }

    async getRun(runId: string) {
        const rows = await this.sql`select r.*, c.jid from flow_runs r join contacts c on c.id = r.contact_id where r.id = ${runId}`;
        return rows[0] ? toRun(rows[0]) : null;
    }

    async getContact(contactId: string) {
        const rows = await this.sql`select * from contacts where id = ${contactId}`;
        return rows[0] ? toContact(rows[0]) : null;
    }

    async getTagIds(contactId: string) {
        const rows = await this.sql`select label_id from contact_labels where contact_id = ${contactId}`;
        return rows.map(r => r.label_id as string);
    }

    async getLabels(sessionId: string) {
        const hit = this.labelCache.get(sessionId);
        if (hit && Date.now() - hit.at < this.ttlMs) return hit.labels;
        const rows = await this.sql`select id, name from labels where session_id = ${sessionId}`;
        const labels = new Map(rows.map(r => [r.id as string, r.name as string]));
        this.labelCache.set(sessionId, { at: Date.now(), labels });
        return labels;
    }

    async getBotVars(sessionId: string) {
        const rows = await this.sql`select key, value from bot_variables where session_id = ${sessionId}`;
        return Object.fromEntries(rows.map(r => [r.key, r.value]));
    }

    async getActiveFlows(sessionId: string) {
        const hit = this.flowCache.get(sessionId);
        if (hit && Date.now() - hit.at < this.ttlMs) return hit.flows;
        const rows = await this.sql`
            select id, name, published_version, published_graph, published_triggers from flows
            where session_id = ${sessionId} and status = 'active' and published_graph is not null`;
        const flows: ActiveFlow[] = rows.map(r => ({
            id: r.id, name: r.name, version: r.published_version, graph: r.published_graph as FlowGraph,
            triggers: (r.published_triggers ?? []) as FlowTrigger[],
        }));
        this.flowCache.set(sessionId, { at: Date.now(), flows });
        return flows;
    }

    async getActiveFlow(sessionId: string, flowId: string) {
        return (await this.getActiveFlows(sessionId)).find(f => f.id === flowId) ?? null;
    }

    async nextSequence(flowId: string, nodeId: string) {
        const rows = await this.sql`
            insert into flow_node_stats (flow_id, node_id, key, count) values (${flowId}, ${nodeId}, 'seq', 1)
            on conflict (flow_id, node_id, key) do update set count = flow_node_stats.count + 1
            returning count`;
        return Number(rows[0].count);
    }

    /** Execuções com espera vencida, reivindicadas de forma atômica (resume_at = null) para um só worker retomar. */
    async claimDueRuns(limit = 100): Promise<RunRow[]> {
        const rows = await this.sql`
            with due as (
                select id from flow_runs
                where resume_at is not null and resume_at <= now() and status in ('waiting_input','waiting_delay')
                order by resume_at limit ${limit} for update skip locked
            )
            update flow_runs r set resume_at = null, updated_at = now()
            from due where r.id = due.id
            returning r.*, (select jid from contacts c where c.id = r.contact_id) as jid`;
        return rows.map(toRun);
    }

    async commit(b: CommitBatch) {
        const touched = new Set<string>();
        await this.sql.begin(async tx => {
            for (const { row, isNew } of b.runs) {
                if (isNew) {
                    await tx`
                        insert into flow_runs (id, flow_id, flow_version, session_id, contact_id, graph, status, current_node_id, wait,
                            resume_at, last_key_id, steps, is_test, error, created_at, updated_at)
                        values (${row.id}, ${row.flowId}, ${row.flowVersion}, ${row.sessionId}, ${row.contactId}, ${j(tx, row.graph)},
                            ${row.status}, ${row.currentNodeId}, ${row.wait ? j(tx, row.wait) : null}, ${row.resumeAt}, ${row.lastKeyId},
                            ${row.steps}, ${row.isTest}, ${row.error}, ${row.createdAt}, now())`;
                } else {
                    await tx`
                        update flow_runs set status = ${row.status}, current_node_id = ${row.currentNodeId},
                            wait = ${row.wait ? j(tx, row.wait) : null}, resume_at = ${row.resumeAt}, last_key_id = ${row.lastKeyId},
                            steps = ${row.steps}, error = ${row.error}, updated_at = now()
                        where id = ${row.id}`;
                }
            }

            if (b.events.length) {
                await tx`insert into flow_events ${tx(b.events.map(e => ({
                    run_id: e.runId, node_id: e.nodeId, kind: e.kind, detail: e.detail === undefined ? null : j(tx, e.detail), created_at: e.at,
                })))}`;
            }

            if (b.stats.length) {
                await tx`
                    insert into flow_node_stats ${tx(b.stats.map(s => ({ flow_id: s.flowId, node_id: s.nodeId, key: s.key, count: s.inc })))}
                    on conflict (flow_id, node_id, key) do update set count = flow_node_stats.count + excluded.count`;
            }

            if (b.contact) {
                const c = b.contact;
                const set = Object.fromEntries(Object.entries(c.fields ?? {}).filter(([, v]) => v !== null)) as Record<string, string>;
                const del = Object.entries(c.fields ?? {}).filter(([, v]) => v === null).map(([k]) => k);
                await tx`
                    update contacts set
                        fields = (fields || ${j(tx, set)}) - ${del}::text[],
                        paused_until = ${c.pausedUntil === undefined ? tx`paused_until` : c.pausedUntil},
                        opted_out_at = ${c.optedOutAt === undefined ? tx`opted_out_at` : c.optedOutAt}
                    where id = ${c.id}`;
            }

            for (const t of b.tagsAdd) await tx`insert into contact_labels (contact_id, label_id) values (${t.contactId}, ${t.labelId}) on conflict do nothing`;
            for (const t of b.tagsRemove) await tx`delete from contact_labels where contact_id = ${t.contactId} and label_id = ${t.labelId}`;

            for (const v of b.botVars) {
                if (v.value === null) await tx`delete from bot_variables where session_id = ${v.sessionId} and key = ${v.key}`;
                else await tx`insert into bot_variables (session_id, key, value) values (${v.sessionId}, ${v.key}, ${v.value})
                              on conflict (session_id, key) do update set value = excluded.value`;
            }

            if (b.outbound.length) {
                const sessionId = b.runs[0]?.row.sessionId;
                if (!sessionId) throw new Error("envio sem sessão");
                // A fila do contato continua de onde a última mensagem pendente dele está (mantém a ordem e as pausas).
                const jids = [...new Set(b.outbound.map(o => o.jid))];
                const tails = await tx`
                    select jid, max(not_before) as tail from outbox
                    where session_id = ${sessionId} and jid in ${tx(jids)} and status in ('queued','sending')
                    group by jid`;
                const cursor = new Map<string, number>(tails.map(t => [t.jid as string, new Date(t.tail).getTime()]));
                const now = Date.now();
                const rows = b.outbound.map(o => {
                    const base = Math.max(now, cursor.get(o.jid) ?? 0) + o.delayMs;
                    cursor.set(o.jid, base);
                    return {
                        session_id: sessionId, jid: o.jid, payload: j(tx, o.payload), source: o.source,
                        priority: o.source === "notify" ? PRIORITY.notify : PRIORITY.conversation,
                        not_before: new Date(base), typing_ms: o.typingMs, wa_id: o.waId, run_id: o.runId,
                    };
                });
                await tx`insert into outbox ${tx(rows)}`;
                touched.add(sessionId);
            }
        });
        if (touched.size) this.hooks.onOutbound?.([...touched]);
    }
}
