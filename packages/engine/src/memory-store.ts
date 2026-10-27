import { ACTIVE_STATUSES, type ActiveFlow, type CommitBatch, type ContactRow, type EngineStore, type FlowEvent, type QueuedOut, type RunRow } from "./store";

/**
 * Store em memória. Serve o simulador do editor (nada vai para o WhatsApp nem para o banco)
 * e os testes do motor.
 */
export class MemoryStore implements EngineStore {
    runs = new Map<string, RunRow>();
    contacts = new Map<string, ContactRow>();
    tags = new Map<string, Set<string>>();
    labels = new Map<string, Map<string, string>>(); // sessionId -> (labelId -> nome)
    botVars = new Map<string, Record<string, string>>();
    flows: ActiveFlow[] = [];
    flowSession = new Map<string, string>(); // flowId -> sessionId
    stats = new Map<string, number>();
    events: FlowEvent[] = [];
    outbound: QueuedOut[] = [];
    commits = 0;

    /** Carregador opcional de fluxos ativos de verdade (o simulador segue um flowLink para fluxos publicados). */
    constructor(private fallbackFlow?: (sessionId: string, flowId: string) => Promise<ActiveFlow | null>) { }

    addContact(c: Partial<ContactRow> & { id: string; sessionId: string; jid: string }) {
        const row: ContactRow = { phone: null, name: null, pushName: null, fields: {}, pausedUntil: null, optedOutAt: null, ...c };
        this.contacts.set(row.id, row);
        return row;
    }

    addFlow(sessionId: string, f: ActiveFlow) {
        this.flows = [...this.flows.filter(x => x.id !== f.id), f];
        this.flowSession.set(f.id, sessionId);
    }

    async findActiveRun(contactId: string) {
        const list = [...this.runs.values()].filter(r => r.contactId === contactId && ACTIVE_STATUSES.includes(r.status));
        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return list[0] ? structuredClone(list[0]) : null;
    }

    async getRun(id: string) {
        const r = this.runs.get(id);
        return r ? structuredClone(r) : null;
    }

    async getContact(id: string) {
        const c = this.contacts.get(id);
        return c ? structuredClone(c) : null;
    }

    async getTagIds(contactId: string) { return [...(this.tags.get(contactId) ?? [])]; }
    async getLabels(sessionId: string) { return this.labels.get(sessionId) ?? new Map(); }
    async getBotVars(sessionId: string) { return { ...(this.botVars.get(sessionId) ?? {}) }; }
    async getActiveFlows(sessionId: string) { return this.flows.filter(f => this.flowSession.get(f.id) === sessionId); }

    async getActiveFlow(sessionId: string, flowId: string) {
        const own = this.flows.find(f => f.id === flowId && this.flowSession.get(f.id) === sessionId);
        return own ?? (this.fallbackFlow ? this.fallbackFlow(sessionId, flowId) : null);
    }

    async nextSequence(flowId: string, nodeId: string) {
        const k = `${flowId}:${nodeId}:seq`;
        const n = (this.stats.get(k) ?? 0) + 1;
        this.stats.set(k, n);
        return n;
    }

    /** Due runs (para testes do agendador). */
    dueRuns(now: Date) {
        return [...this.runs.values()].filter(r => r.resumeAt && r.resumeAt <= now && ACTIVE_STATUSES.includes(r.status));
    }

    async commit(b: CommitBatch) {
        this.commits++;
        for (const { row } of b.runs) this.runs.set(row.id, structuredClone(row));
        this.events.push(...b.events);
        for (const s of b.stats) {
            const k = `${s.flowId}:${s.nodeId}:${s.key}`;
            this.stats.set(k, (this.stats.get(k) ?? 0) + s.inc);
        }
        this.outbound.push(...b.outbound);
        if (b.contact) {
            const c = this.contacts.get(b.contact.id);
            if (c) {
                for (const [k, v] of Object.entries(b.contact.fields ?? {})) { if (v === null) delete c.fields[k]; else c.fields[k] = v; }
                if (b.contact.pausedUntil !== undefined) c.pausedUntil = b.contact.pausedUntil;
                if (b.contact.optedOutAt !== undefined) c.optedOutAt = b.contact.optedOutAt;
            }
        }
        for (const t of b.tagsAdd) {
            const set = this.tags.get(t.contactId) ?? new Set();
            set.add(t.labelId);
            this.tags.set(t.contactId, set);
        }
        for (const t of b.tagsRemove) this.tags.get(t.contactId)?.delete(t.labelId);
        for (const v of b.botVars) {
            const vars = this.botVars.get(v.sessionId) ?? {};
            if (v.value === null) delete vars[v.key]; else vars[v.key] = v.value;
            this.botVars.set(v.sessionId, vars);
        }
    }

    /** Textos enviados (para testes e para o simulador). */
    sentTexts(jid?: string) {
        return this.outbound.filter(o => !jid || o.jid === jid).map(o =>
            o.payload.kind === "text" ? o.payload.text : o.payload.kind === "menu" ? o.payload.question : `[${o.payload.kind}]`);
    }
}
