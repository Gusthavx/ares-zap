import type postgres from "postgres";
import { resolveSettings, type FlowGraph, type FlowTrigger } from "@areszap/core";
import { FlowEngine, MemoryStore, type ActiveFlow } from "@areszap/engine";

interface SimEntry { store: MemoryStore; engine: FlowEngine; sessionId: string; contactId: string; jid: string; usedAt: number }

const TTL_MS = 30 * 60_000;

export interface SimMessage {
    kind: string; text: string; options?: { id: string; text: string }[]; mode?: string;
    typingMs: number; delayMs: number; to?: string;
}

/**
 * Simulador do editor: roda o RASCUNHO num contato fictício, tudo em memória (sem banco e sem WhatsApp).
 * Um simulador por usuário e fluxo; some depois de 30 min parado.
 */
export class SimulatorPool {
    private pool = new Map<string, SimEntry>();
    constructor(private sql: postgres.Sql) {
        setInterval(() => {
            const now = Date.now();
            for (const [k, v] of this.pool) if (now - v.usedAt > TTL_MS) this.pool.delete(k);
        }, 60_000).unref();
    }

    reset(userId: string, flowId: string) { this.pool.delete(`${userId}:${flowId}`); }

    private async entry(user: { id: string; name: string }, flow: { id: string; sessionId: string }): Promise<SimEntry> {
        const key = `${user.id}:${flow.id}`;
        const hit = this.pool.get(key);
        if (hit) { hit.usedAt = Date.now(); return hit; }
        const sql = this.sql;
        const [s] = await sql`select settings from sessions where id = ${flow.sessionId}`;
        const settings = resolveSettings(s?.settings);
        // um flowLink no simulador segue para o fluxo publicado de verdade (só leitura)
        const store = new MemoryStore(async (sessionId, flowId) => {
            const [f] = await sql`select id, name, published_version, published_graph, published_triggers from flows
                                  where id = ${flowId} and session_id = ${sessionId} and status = 'active' and published_graph is not null`;
            return f ? { id: f.id, name: f.name, version: f.published_version, graph: f.published_graph, triggers: f.published_triggers ?? [] } : null;
        });
        const labels = await sql`select id, name from labels where session_id = ${flow.sessionId}`;
        store.labels.set(flow.sessionId, new Map(labels.map(l => [l.id as string, l.name as string])));
        const vars = await sql`select key, value from bot_variables where session_id = ${flow.sessionId}`;
        store.botVars.set(flow.sessionId, Object.fromEntries(vars.map(v => [v.key, v.value])));
        const jid = `sim-${user.id.slice(0, 8)}@sim`;
        const contact = store.addContact({ id: `sim-${user.id}`, sessionId: flow.sessionId, jid, phone: "5511999999999", pushName: user.name || "Contato Teste" });
        const engine = new FlowEngine({ store, settings: () => ({ ...settings, sending: { ...settings.sending, typingSimulation: false } }) });
        const e: SimEntry = { store, engine, sessionId: flow.sessionId, contactId: contact.id, jid, usedAt: Date.now() };
        this.pool.set(key, e);
        return e;
    }

    async simulate(
        user: { id: string; name: string },
        flow: { id: string; sessionId: string; name: string; graph: FlowGraph; triggers: FlowTrigger[] },
        input: { text?: string; optionId?: string; skipWait?: boolean },
    ) {
        const e = await this.entry(user, flow);
        // o rascunho atual entra como único fluxo "ativo" do simulador (sem gatilho = qualquer mensagem)
        const active: ActiveFlow = { id: flow.id, name: flow.name, version: 0, graph: flow.graph, triggers: flow.triggers.length ? flow.triggers : [{ id: "sim", type: "anyMessage", priority: 0 }] };
        e.store.flows = e.store.flows.filter(f => f.id !== flow.id);
        e.store.addFlow(flow.sessionId, active);
        const before = e.store.outbound.length;
        let result: string;
        if (input.skipWait) {
            const run = await e.store.findActiveRun(e.contactId);
            if (run && run.resumeAt) { await e.engine.resume(run); result = "handled"; }
            else result = "ignored";
        } else {
            const isFirst = e.store.runs.size === 0;
            result = await e.engine.handleIncoming({
                sessionId: e.sessionId, contactId: e.contactId, jid: e.jid, keyId: `SIM${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
                type: input.optionId ? "interactive" : "text", text: input.text ?? "", optionId: input.optionId ?? null, isFirstContact: isFirst,
            });
        }
        const messages: SimMessage[] = e.store.outbound.slice(before).map(o => {
            const p = o.payload;
            const base = { typingMs: o.typingMs, delayMs: o.delayMs, to: o.jid === e.jid ? undefined : o.jid };
            switch (p.kind) {
                case "text": return { kind: "text", text: p.text, ...base };
                case "menu": return { kind: "menu", text: p.question, options: p.options, mode: p.mode, ...base };
                case "media": return { kind: "media", text: p.caption ? `[${p.media}] ${p.caption}` : `[${p.media}${p.fileName ? `: ${p.fileName}` : ""}]`, ...base };
                case "vcard": return { kind: "vcard", text: `[contato: ${p.name} ${p.phone}]`, ...base };
                case "template": return { kind: "template", text: `[modelo: ${p.name}]`, ...base };
            }
        });
        const runs = [...e.store.runs.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const run = runs[0] ?? null;
        const contact = await e.store.getContact(e.contactId);
        const labels = await e.store.getLabels(e.sessionId);
        const tags = (await e.store.getTagIds(e.contactId)).map(id => labels.get(id) ?? id);
        return {
            result, messages,
            run: run ? { status: run.status, currentNodeId: run.currentNodeId, wait: run.wait, resumeAt: run.resumeAt, flowId: run.flowId } : null,
            fields: contact?.fields ?? {}, tags,
            events: e.store.events.slice(-30).map(ev => ({ nodeId: ev.nodeId, kind: ev.kind, detail: ev.detail })),
        };
    }
}
