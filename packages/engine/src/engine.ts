// Executor de fluxos. Mesma semântica do MarcFlow (MIT, Marcos Maia — src/modules/flows/engine.ts), com três mudanças:
// 1. Lê o estado uma vez por avanço e grava tudo numa transação no fim (antes: 3 a 5 consultas por bloco).
// 2. Não fala com o WhatsApp: as mensagens vão para a fila de saída do número (outbox), que cuida de ritmo e "digitando…".
// 3. Gatilhos versionados, pausa por atendimento humano e regra explícita para mensagem durante atraso inteligente.
import {
    evalConditions, formatZoned, matchMenuOption, menuText, newWaMessageId, normalizePhone, phoneFromJid, pickTrigger,
    pickWeighted, renderTemplate, resolveSettings, toUserJid, unitMs, validateAnswer, zonedParts, zonedToDate,
    type ContentItem, type FlowAction, type FlowGraph, type FlowNode, type FlowTrigger, type MenuData, type NodeDataMap,
    type OutMessage, type RandomizerData, type SessionSettings, type SmartDelayData,
} from "@areszap/core";
import {
    isTerminal, type ActiveFlow, type CommitBatch, type ContactRow, type EngineIncoming, type EngineStore,
    type IncomingResult, type PollRef, type RunRow, type RunStatus, type Wait,
} from "./store";

// Folga de propósito: um roteador de texto livre é uma cadeia de ~30 condições percorrida a cada mensagem.
const MAX_STEPS_PER_ADVANCE = 150;
const MAX_STEPS_PER_RUN = 5000;
const MAX_VISITS_PER_ADVANCE = 20;
const MAX_INLINE_DELAY_S = 60;

export interface EngineOptions {
    store: EngineStore;
    settings: (sessionId: string) => Promise<SessionSettings> | SessionSettings;
    now?: () => Date;
    random?: () => number;
    randomBytes?: (n: number) => Uint8Array;
    /** Chamado depois do commit quando uma execução termina (webhook flow.completed, evento para o painel). */
    onRunEnded?: (run: RunRow) => void;
    logger?: { error: (msg: string, err?: unknown) => void };
}

class StopRun extends Error { }

interface Ctx {
    run: RunRow;
    contact: ContactRow;
    settings: SessionSettings;
    vars: Record<string, string>;
    tagIds: Set<string>;
    lastText: string;
    visits: Map<string, number>;
    steps: number;
    batch: CommitBatch;
    /** pausa acumulada (ms) a aplicar no próximo envio */
    pendingDelayMs: number;
    pendingTypingMs: number;
    ended: RunRow[];
}

const emptyBatch = (): CommitBatch => ({ runs: [], events: [], stats: [], outbound: [], tagsAdd: [], tagsRemove: [], botVars: [] });

export class FlowEngine {
    private store: EngineStore;
    private now: () => Date;
    private random: () => number;
    private randomBytes: (n: number) => Uint8Array;

    constructor(private opts: EngineOptions) {
        this.store = opts.store;
        this.now = opts.now ?? (() => new Date());
        this.random = opts.random ?? Math.random;
        this.randomBytes = opts.randomBytes ?? (n => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; });
    }

    // ================= API pública =================

    /** Mensagem nova de um contato (já salva e sem duplicata). O chamador serializa por contato. */
    async handleIncoming(msg: EngineIncoming): Promise<IncomingResult> {
        const settings = await this.settingsFor(msg.sessionId);
        const contact = await this.store.getContact(msg.contactId);
        if (!contact) return "ignored";
        const active = await this.store.findActiveRun(msg.contactId);
        let interrupted: RunRow | null = null;

        if (active) {
            if (active.lastKeyId === msg.keyId) return "duplicate";
            if (active.status === "waiting_input") {
                const poll = active.wait?.kind === "menu" ? active.wait.poll : undefined;
                if (msg.pollId && poll?.id !== msg.pollId) return "ignored"; // voto numa enquete antiga
                const ctx = await this.load(active, contact, settings, msg.text);
                await this.guard(ctx, () => this.handleInput(ctx, msg));
                await this.flush(ctx);
                return "handled";
            }
            if (active.status === "waiting_delay" && settings.onMessageDuringDelay === "interrupt") {
                interrupted = active;
            } else {
                return "busy";
            }
        }

        if (contact.pausedUntil && contact.pausedUntil > this.now()) return "paused";

        const flows = await this.store.getActiveFlows(msg.sessionId);
        const entries = flows.flatMap(flow => flow.triggers.map(trigger => ({ trigger, flow })));
        const hit = pickTrigger(entries, msg.text, !!msg.isFirstContact);
        if (!hit) return interrupted ? "busy" : "no-trigger";

        const batch = emptyBatch();
        if (interrupted) this.endInBatch(batch, interrupted, "cancelled", "Interrompido por nova mensagem do contato");
        await this.startRun({ flow: hit.flow, contact, settings, keyId: msg.keyId, text: msg.text, batch });
        if (interrupted) this.opts.onRunEnded?.({ ...interrupted, status: "cancelled" });
        return "started";
    }

    /** Inicia um fluxo publicado (ou o rascunho, em teste) para um contato. */
    async startRun(opts: {
        flow: ActiveFlow; contact: ContactRow; settings?: SessionSettings; keyId?: string; text?: string;
        isTest?: boolean; startNodeId?: string; batch?: CommitBatch;
    }): Promise<string> {
        const settings = opts.settings ?? await this.settingsFor(opts.contact.sessionId);
        const graph = opts.flow.graph;
        const start = opts.startNodeId ? graph.nodes.find(n => n.id === opts.startNodeId) : graph.nodes.find(n => n.type === "start");
        if (!start) throw new Error(opts.startNodeId ? `Bloco "${opts.startNodeId}" não existe no fluxo` : "Fluxo sem bloco inicial");
        const run: RunRow = {
            id: globalThis.crypto.randomUUID(),
            flowId: opts.flow.id,
            flowVersion: opts.flow.version,
            sessionId: opts.contact.sessionId,
            contactId: opts.contact.id,
            jid: opts.contact.jid,
            graph,
            status: "running",
            currentNodeId: start.id,
            wait: null,
            resumeAt: null,
            lastKeyId: opts.keyId ?? null,
            steps: 0,
            isTest: !!opts.isTest,
            error: null,
            createdAt: this.now(),
        };
        const ctx = await this.load(run, opts.contact, settings, opts.text ?? "", opts.batch);
        ctx.batch.runs.push({ row: run, isNew: true });
        this.event(ctx, null, "START", { test: run.isTest, version: run.flowVersion });
        await this.guard(ctx, () => this.execute(ctx, start.id));
        await this.flush(ctx);
        return run.id;
    }

    /** Retoma uma espera vencida (atraso inteligente, pergunta ou menu sem resposta). */
    async resume(run: RunRow): Promise<void> {
        const contact = await this.store.getContact(run.contactId);
        if (!contact) return;
        const ctx = await this.load(run, contact, await this.settingsFor(run.sessionId), "");
        await this.guard(ctx, async () => {
            const wait = ctx.run.wait;
            if (!wait) return this.finish(ctx, "failed", "Espera sem estado");
            if (wait.kind === "delay") return this.execute(ctx, this.follow(ctx, wait.nodeId, "next"));
            if (wait.kind === "menu") return this.timeoutPath(ctx, "timeout");
            const item = (this.node(ctx, wait.nodeId)?.data as NodeDataMap["content"] | undefined)?.items[wait.itemIndex];
            return this.timeoutPath(ctx, `input:${item?.id}:timeout`);
        });
        await this.flush(ctx);
    }

    /** Cancela as execuções ativas do contato (atendimento humano, teste, evento externo). */
    async cancelActive(contactId: string, reason: string, opts: { pauseUntil?: Date } = {}): Promise<number> {
        const active = await this.store.findActiveRun(contactId);
        const batch = emptyBatch();
        if (active) this.endInBatch(batch, active, "cancelled", reason);
        if (opts.pauseUntil) batch.contact = { id: contactId, pausedUntil: opts.pauseUntil };
        if (!active && !opts.pauseUntil) return 0;
        await this.store.commit(batch);
        if (active) this.opts.onRunEnded?.(active);
        return active ? 1 : 0;
    }

    /** Teste do rascunho num número real: substitui qualquer execução ativa do contato. */
    async startTest(opts: { flow: ActiveFlow; contact: ContactRow }) {
        const batch = emptyBatch();
        const active = await this.store.findActiveRun(opts.contact.id);
        if (active) this.endInBatch(batch, active, "cancelled", "Substituído por um teste");
        return this.startRun({ ...opts, isTest: true, batch });
    }

    /**
     * Evento de fora da conversa (ex.: compra aprovada): grava campos e, se pedido, inicia um fluxo publicado
     * num bloco, substituindo a execução ativa.
     */
    async externalEvent(opts: { contact: ContactRow; fields: Record<string, string>; start?: { flow: ActiveFlow; nodeId?: string } }) {
        const batch = emptyBatch();
        batch.contact = { id: opts.contact.id, fields: opts.fields };
        const contact = { ...opts.contact, fields: { ...opts.contact.fields, ...opts.fields } };
        if (!opts.start) { await this.store.commit(batch); return null; }
        const active = await this.store.findActiveRun(contact.id);
        if (active) this.endInBatch(batch, active, "cancelled", "Substituído por evento externo");
        return this.startRun({ flow: opts.start.flow, contact, startNodeId: opts.start.nodeId, batch });
    }

    // ================= execução =================

    private async settingsFor(sessionId: string) {
        return resolveSettings(await this.opts.settings(sessionId));
    }

    private async load(run: RunRow, contact: ContactRow, settings: SessionSettings, lastText: string, batch?: CommitBatch): Promise<Ctx> {
        const [tagIds, botVars] = await Promise.all([this.store.getTagIds(contact.id), this.store.getBotVars(contact.sessionId)]);
        const ctx: Ctx = {
            run: { ...run }, contact, settings, lastText, vars: {}, tagIds: new Set(tagIds),
            visits: new Map(), steps: 0, batch: batch ?? emptyBatch(), pendingDelayMs: 0, pendingTypingMs: 0, ended: [],
        };
        ctx.vars = this.variables(ctx, botVars);
        return ctx;
    }

    private variables(ctx: Ctx, botVars: Record<string, string>): Record<string, string> {
        const full = (ctx.contact.name || ctx.contact.pushName || "").trim();
        const parts = full.split(/\s+/).filter(Boolean);
        const phone = ctx.contact.phone || phoneFromJid(ctx.contact.jid);
        return {
            ...botVars,
            ...ctx.contact.fields,
            "nome-completo": full,
            "primeiro-nome": parts[0] || "",
            "sobrenome": parts.slice(1).join(" "),
            "telefone": phone,
            "ddd": phone.startsWith("55") ? phone.slice(2, 4) : "",
            "ultima-mensagem": ctx.lastText,
            "agora": formatZoned(this.now(), ctx.settings.timezone),
        };
    }

    /** Erros inesperados viram FAILED em vez de derrubar o worker. */
    private async guard(ctx: Ctx, fn: () => Promise<void>) {
        try {
            await fn();
        } catch (e) {
            if (e instanceof StopRun) return;
            this.opts.logger?.error(`fluxo ${ctx.run.id} falhou`, e);
            this.finish(ctx, "failed", (e as Error).message);
        }
    }

    private async flush(ctx: Ctx) {
        this.upsertRun(ctx);
        await this.store.commit(ctx.batch);
        for (const r of ctx.ended) this.opts.onRunEnded?.(r);
    }

    private upsertRun(ctx: Ctx) {
        const existing = ctx.batch.runs.find(r => r.row.id === ctx.run.id);
        if (existing) existing.row = { ...ctx.run };
        else ctx.batch.runs.push({ row: { ...ctx.run }, isNew: false });
    }

    private endInBatch(batch: CommitBatch, run: RunRow, status: RunStatus, error: string | null) {
        const row: RunRow = { ...run, status, wait: null, resumeAt: null, error };
        batch.runs.push({ row, isNew: false });
        batch.events.push({ runId: run.id, nodeId: null, kind: "END", detail: { status, reason: error }, at: this.now() });
    }

    private event(ctx: Ctx, nodeId: string | null, kind: string, detail?: unknown) {
        ctx.batch.events.push({ runId: ctx.run.id, nodeId, kind, detail, at: this.now() });
    }

    private stat(ctx: Ctx, nodeId: string, key: string) {
        if (ctx.run.isTest) return;
        const s = ctx.batch.stats.find(x => x.flowId === ctx.run.flowId && x.nodeId === nodeId && x.key === key);
        if (s) s.inc++;
        else ctx.batch.stats.push({ flowId: ctx.run.flowId, nodeId, key, inc: 1 });
    }

    private node(ctx: Ctx, id: string): FlowNode | undefined {
        return ctx.run.graph.nodes.find(n => n.id === id);
    }

    private follow(ctx: Ctx, nodeId: string, handle: string): string | null {
        return ctx.run.graph.edges.find(e => e.source === nodeId && e.sourceHandle === handle)?.target ?? null;
    }

    private finish(ctx: Ctx, status: RunStatus, error?: string) {
        ctx.run = { ...ctx.run, status, wait: null, resumeAt: null, error: error ?? null };
        this.event(ctx, null, status === "failed" ? "ERROR" : "END", { status, error });
        if (isTerminal(status)) ctx.ended.push({ ...ctx.run });
    }

    private fail(ctx: Ctx, error: string): never {
        this.finish(ctx, "failed", error);
        throw new StopRun(error);
    }

    private enqueue(ctx: Ctx, nodeId: string, payload: OutMessage, opts: { to?: string; source?: "flow" | "notify"; waId?: string } = {}) {
        let typing = ctx.pendingTypingMs;
        if (!typing && ctx.settings.sending.typingSimulation && payload.kind === "text" && !opts.to) {
            typing = Math.min(4000, 400 + payload.text.length * 25);
        }
        const waId = opts.waId ?? newWaMessageId();
        ctx.batch.outbound.push({
            jid: opts.to ?? ctx.run.jid, payload, source: opts.source ?? "flow",
            delayMs: ctx.pendingDelayMs, typingMs: typing, waId, runId: ctx.run.id,
        });
        ctx.pendingDelayMs = 0;
        ctx.pendingTypingMs = 0;
        this.event(ctx, nodeId, "SEND", { kind: payload.kind, to: opts.to, waId, text: payload.kind === "text" ? payload.text.slice(0, 500) : undefined });
        return waId;
    }

    private sendItem(ctx: Ctx, nodeId: string, item: ContentItem) {
        const v = ctx.vars;
        switch (item.kind) {
            case "text":
                return void this.enqueue(ctx, nodeId, { kind: "text", text: renderTemplate(item.text, v) });
            case "image": case "video": case "audio": case "file":
                return void this.enqueue(ctx, nodeId, {
                    kind: "media", media: item.kind, assetId: item.assetId, url: item.url,
                    caption: item.caption ? renderTemplate(item.caption, v) : undefined, fileName: item.fileName,
                });
            case "vcard":
                return void this.enqueue(ctx, nodeId, { kind: "vcard", name: item.name, phone: item.phone, org: item.org });
            case "delay": {
                const ms = Math.min(Math.max(0, item.seconds), MAX_INLINE_DELAY_S) * 1000;
                if (item.typing) ctx.pendingTypingMs += ms; else ctx.pendingDelayMs += ms;
                return;
            }
            case "input":
                return void this.enqueue(ctx, nodeId, { kind: "text", text: renderTemplate(item.question, v) });
        }
    }

    private sendMenu(ctx: Ctx, nodeId: string, d: MenuData): PollRef | undefined {
        const question = renderTemplate(d.question, ctx.vars);
        const options = d.options.map(o => ({ id: o.id, text: renderTemplate(o.text, ctx.vars) }));
        if (d.mode !== "interactive") {
            this.enqueue(ctx, nodeId, { kind: "text", text: menuText(question, options) });
            return undefined;
        }
        // O motor escolhe id e segredo da enquete para conseguir ler o voto depois (Baileys não guarda).
        const messageId = newWaMessageId();
        const secret = Buffer.from(this.randomBytes(32)).toString("base64");
        this.enqueue(ctx, nodeId, { kind: "menu", mode: "interactive", question, options, messageId, pollSecret: secret }, { waId: messageId });
        return { id: messageId, secret, values: options.map(o => o.text) };
    }

    private async runAction(ctx: Ctx, nodeId: string, a: FlowAction) {
        const contactPatch = (ctx.batch.contact ??= { id: ctx.contact.id });
        switch (a.type) {
            case "addTag": case "removeTag": {
                const labels = await this.store.getLabels(ctx.run.sessionId);
                const name = labels.get(a.labelId ?? "");
                if (!name) throw new Error("Etiqueta não encontrada");
                const pair = { contactId: ctx.contact.id, labelId: a.labelId! };
                if (a.type === "addTag") { ctx.tagIds.add(pair.labelId); ctx.batch.tagsAdd.push(pair); }
                else { ctx.tagIds.delete(pair.labelId); ctx.batch.tagsRemove.push(pair); }
                return this.event(ctx, nodeId, "ACTION", { [a.type]: name });
            }
            case "setField": case "clearField": {
                const key = a.fieldKey!;
                const value = a.type === "setField" ? renderTemplate(a.value, ctx.vars) : null;
                this.setField(ctx, key, a.fieldScope, value);
                return this.event(ctx, nodeId, "ACTION", a.type === "setField" ? { setField: key, value } : { clearField: key });
            }
            case "notify": {
                const text = renderTemplate(a.message, ctx.vars);
                // o número pode vir de um campo ({TELEFONE_EQUIPE}); vazio só pula a notificação
                const phones = renderTemplate(a.phones, ctx.vars).split(/[,;\s]+/)
                    .map(p => normalizePhone(p, ctx.settings.defaultCountryCode)).filter((p): p is string => !!p);
                if (!phones.length) return this.event(ctx, nodeId, "ACTION", { notify: "sem número configurado" });
                for (const p of phones) this.enqueue(ctx, nodeId, { kind: "text", text }, { to: toUserJid(p), source: "notify" });
                return;
            }
            case "pauseAutomation": {
                const until = a.forever ? new Date("9999-12-31T00:00:00Z") : new Date(this.now().getTime() + a.value * unitMs[a.unit]);
                contactPatch.pausedUntil = until;
                return this.event(ctx, nodeId, "ACTION", { pausedUntil: until.toISOString() });
            }
            case "resumeAutomation":
                contactPatch.pausedUntil = null;
                return this.event(ctx, nodeId, "ACTION", { resumeAutomation: true });
            case "optOut":
                contactPatch.optedOutAt = this.now();
                return this.event(ctx, nodeId, "ACTION", { optOut: true });
        }
    }

    private setField(ctx: Ctx, key: string, scope: "CONTACT" | "BOT" | undefined, value: string | null) {
        if (scope === "BOT") ctx.batch.botVars.push({ sessionId: ctx.run.sessionId, key, value });
        else {
            const c = (ctx.batch.contact ??= { id: ctx.contact.id });
            c.fields = { ...(c.fields ?? {}), [key]: value };
        }
        if (value === null) delete ctx.vars[key]; else ctx.vars[key] = value;
    }

    private setWait(ctx: Ctx, status: RunStatus, wait: Wait, resumeAt: Date) {
        ctx.run = { ...ctx.run, status, wait, resumeAt };
    }

    /** Percorre o grafo a partir de (nodeId, itemIndex) até esperar, terminar ou falhar. */
    private async execute(ctx: Ctx, startNodeId: string | null, startItem = 0): Promise<void> {
        let nodeId = startNodeId;
        let itemIndex = startItem;
        while (nodeId) {
            ctx.steps++;
            ctx.run.steps++;
            if (ctx.steps > MAX_STEPS_PER_ADVANCE || ctx.run.steps > MAX_STEPS_PER_RUN) this.fail(ctx, "Limite de passos atingido (possível ciclo no fluxo).");
            const visits = (ctx.visits.get(nodeId) || 0) + 1;
            ctx.visits.set(nodeId, visits);
            if (visits > MAX_VISITS_PER_ADVANCE) this.fail(ctx, "O mesmo bloco foi repetido demais (ciclo no fluxo).");

            const node = this.node(ctx, nodeId);
            if (!node) break;
            ctx.run = { ...ctx.run, status: "running", currentNodeId: node.id, wait: null, resumeAt: null };
            if (itemIndex === 0) {
                this.event(ctx, node.id, "ENTER", { type: node.type });
                this.stat(ctx, node.id, "entered");
            }

            switch (node.type) {
                case "start":
                    nodeId = this.follow(ctx, node.id, "next");
                    break;

                case "content": {
                    const items = (node.data as NodeDataMap["content"]).items;
                    for (let i = itemIndex; i < items.length; i++) {
                        const it = items[i];
                        this.sendItem(ctx, node.id, it);
                        if (it.kind === "input") {
                            const resumeAt = new Date(this.now().getTime() + Math.max(1, it.expireValue) * unitMs[it.expireUnit]);
                            this.setWait(ctx, "waiting_input", { kind: "input", nodeId: node.id, itemIndex: i, attempts: 0 }, resumeAt);
                            this.event(ctx, node.id, "WAIT", { input: it.answerType, until: resumeAt.toISOString() });
                            return;
                        }
                    }
                    nodeId = this.follow(ctx, node.id, "next");
                    break;
                }

                case "menu": {
                    const d = node.data as MenuData;
                    const poll = this.sendMenu(ctx, node.id, d);
                    const resumeAt = new Date(this.now().getTime() + Math.max(1, d.expireValue) * unitMs[d.expireUnit]);
                    this.setWait(ctx, "waiting_input", { kind: "menu", nodeId: node.id, errors: 0, ...(poll ? { poll } : {}) }, resumeAt);
                    this.event(ctx, node.id, "WAIT", { menu: d.options.length, until: resumeAt.toISOString() });
                    return;
                }

                case "action": {
                    for (const a of (node.data as NodeDataMap["action"]).actions) {
                        try { await this.runAction(ctx, node.id, a); }
                        catch (e) { this.event(ctx, node.id, "ERROR", { action: a.type, error: (e as Error).message }); }
                    }
                    nodeId = this.follow(ctx, node.id, "next");
                    break;
                }

                case "condition": {
                    const cd = node.data as NodeDataMap["condition"];
                    const conditions = cd.conditions.map(c => ({ ...c, value: renderTemplate(String(c.value ?? ""), ctx.vars) }));
                    const ok = evalConditions({ ...cd, conditions }, {
                        tagIds: [...ctx.tagIds], ...zonedParts(this.now(), ctx.settings.timezone), fields: ctx.vars,
                    });
                    this.event(ctx, node.id, "BRANCH", { result: ok });
                    this.stat(ctx, node.id, `option:${ok}`);
                    nodeId = this.follow(ctx, node.id, ok ? "true" : "false");
                    break;
                }

                case "randomizer": {
                    const d = node.data as RandomizerData;
                    let opt = null;
                    if (d.mode === "sequential" && d.options.length) {
                        const n = ctx.run.isTest ? 1 : await this.store.nextSequence(ctx.run.flowId, node.id);
                        opt = d.options[(n - 1) % d.options.length];
                    } else opt = pickWeighted(d.options, this.random());
                    this.event(ctx, node.id, "BRANCH", { option: opt ? d.options.indexOf(opt) + 1 : null });
                    if (opt) this.stat(ctx, node.id, `option:${opt.id}`);
                    nodeId = opt ? this.follow(ctx, node.id, `option:${opt.id}`) : null;
                    break;
                }

                case "smartDelay": {
                    const d = node.data as SmartDelayData;
                    const at = d.mode === "datetime"
                        ? zonedToDate(d.datetime || "", ctx.settings.timezone)
                        : new Date(this.now().getTime() + d.value * unitMs[d.unit]);
                    if (!at || at.getTime() <= this.now().getTime()) {
                        this.event(ctx, node.id, "BRANCH", { skipped: at ? "data já passou" : "data inválida" });
                        nodeId = this.follow(ctx, node.id, "next");
                        break;
                    }
                    this.setWait(ctx, "waiting_delay", { kind: "delay", nodeId: node.id }, at);
                    this.event(ctx, node.id, "WAIT", { until: at.toISOString() });
                    return;
                }

                case "flowLink": {
                    const target = (node.data as NodeDataMap["flowLink"]).flowId;
                    this.finish(ctx, "completed");
                    const flow = target ? await this.store.getActiveFlow(ctx.run.sessionId, target) : null;
                    if (!flow) {
                        this.event(ctx, node.id, "ERROR", { error: "Fluxo de destino não está ativo" });
                        return;
                    }
                    // a execução atual e a nova vão no mesmo commit
                    this.upsertRun(ctx);
                    await this.startRunInline(ctx, flow);
                    return;
                }
            }
            itemIndex = 0;
        }
        this.finish(ctx, "completed");
    }

    /** Contato com as mudanças deste avanço aplicadas (para a próxima execução ver os campos novos). */
    private contactAfterBatch(ctx: Ctx): ContactRow {
        const c = ctx.batch.contact;
        if (!c) return ctx.contact;
        const fields = { ...ctx.contact.fields };
        for (const [k, v] of Object.entries(c.fields ?? {})) { if (v === null) delete fields[k]; else fields[k] = v; }
        return {
            ...ctx.contact, fields,
            pausedUntil: c.pausedUntil !== undefined ? c.pausedUntil : ctx.contact.pausedUntil,
            optedOutAt: c.optedOutAt !== undefined ? c.optedOutAt : ctx.contact.optedOutAt,
        };
    }

    /** flowLink: começa a execução de destino dentro do mesmo avanço e do mesmo commit. */
    private async startRunInline(ctx: Ctx, flow: ActiveFlow) {
        const start = flow.graph.nodes.find(n => n.type === "start");
        if (!start) return;
        const contact = this.contactAfterBatch(ctx);
        const run: RunRow = {
            id: globalThis.crypto.randomUUID(), flowId: flow.id, flowVersion: flow.version, sessionId: contact.sessionId,
            contactId: contact.id, jid: contact.jid, graph: flow.graph, status: "running", currentNodeId: start.id, wait: null,
            resumeAt: null, lastKeyId: ctx.run.lastKeyId, steps: 0, isTest: ctx.run.isTest, error: null, createdAt: this.now(),
        };
        ctx.batch.runs.push({ row: run, isNew: true });
        // o contexto passa a ser da nova execução; ctx.steps continua contando (protege contra ciclo entre fluxos)
        ctx.run = run;
        ctx.contact = contact;
        ctx.visits = new Map();
        this.event(ctx, null, "START", { test: run.isTest, version: run.flowVersion, from: "flowLink" });
        await this.execute(ctx, start.id);
    }

    private async handleInput(ctx: Ctx, msg: EngineIncoming) {
        const wait = ctx.run.wait;
        if (!wait || wait.kind === "delay") return;
        const node = this.node(ctx, wait.nodeId);
        if (!node) return this.finish(ctx, "failed", "Bloco de espera não existe mais");
        const answer = { text: msg.text || "", type: msg.type, mediaRef: msg.mediaRef };
        ctx.run.lastKeyId = msg.keyId;

        if (wait.kind === "input") {
            const item = (node.data as NodeDataMap["content"]).items[wait.itemIndex];
            if (!item || item.kind !== "input") return this.finish(ctx, "failed", "Captura não existe mais");
            const value = validateAnswer(item.answerType, answer);
            if (value === null) {
                const attempts = wait.attempts + 1;
                this.event(ctx, node.id, "INVALID", { answer: answer.text.slice(0, 80), attempts });
                if (attempts >= Math.max(1, item.maxAttempts)) return this.timeoutPath(ctx, `input:${item.id}:timeout`);
                if (item.errorMessage.trim()) this.enqueue(ctx, node.id, { kind: "text", text: renderTemplate(item.errorMessage, ctx.vars) });
                ctx.run.wait = { ...wait, attempts };
                return;
            }
            if (item.fieldKey) this.setField(ctx, item.fieldKey, item.fieldScope, value);
            this.event(ctx, node.id, "INPUT", { field: item.fieldKey, value: value.slice(0, 120) });
            const target = this.follow(ctx, node.id, `input:${item.id}:valid`);
            return target ? this.execute(ctx, target) : this.execute(ctx, node.id, wait.itemIndex + 1);
        }

        const d = node.data as MenuData;
        const opt = matchMenuOption(answer.text, d.options, msg.optionId);
        if (opt) {
            this.stat(ctx, node.id, `option:${opt.id}`);
            this.event(ctx, node.id, "INPUT", { option: d.options.indexOf(opt) + 1, text: opt.text });
            return this.execute(ctx, this.follow(ctx, node.id, `option:${opt.id}`));
        }
        const errors = wait.errors + 1;
        this.event(ctx, node.id, "INVALID", { answer: answer.text.slice(0, 80), errors });
        if (d.maxErrors > 0 && errors >= d.maxErrors) return this.execute(ctx, this.follow(ctx, node.id, "error"));
        if (d.invalidText.trim()) this.enqueue(ctx, node.id, { kind: "text", text: renderTemplate(d.invalidText, ctx.vars) });
        ctx.run.wait = { ...wait, errors };
    }

    private async timeoutPath(ctx: Ctx, handle: string) {
        const from = ctx.run.wait?.nodeId ?? null;
        const target = from ? this.follow(ctx, from, handle) : null;
        if (!target) return this.finish(ctx, "expired");
        this.event(ctx, from, "BRANCH", { path: "sem resposta" });
        return this.execute(ctx, target);
    }
}

export type { FlowGraph, FlowTrigger };
