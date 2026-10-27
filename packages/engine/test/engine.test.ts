import { beforeEach, describe, expect, it } from "vitest";
import { resolveSettings, type FlowGraph, type FlowTrigger } from "@areszap/core";
import { FlowEngine, MemoryStore, type EngineIncoming } from "../src";

const S = "sess-1";
let clock = new Date("2026-10-26T12:00:00Z");
let store: MemoryStore;
let engine: FlowEngine;
let settings = resolveSettings({ sending: { typingSimulation: false } });
let key = 0;

function msg(text: string, extra: Partial<EngineIncoming> = {}): EngineIncoming {
    return { sessionId: S, contactId: "c1", jid: "5511999990000@s.whatsapp.net", keyId: `k${++key}`, type: "text", text, ...extra };
}

const trig = (t: Partial<FlowTrigger>): FlowTrigger => ({ id: "t" + Math.random(), type: "anyMessage", priority: 0, ...t });

function addFlow(id: string, graph: FlowGraph, triggers: FlowTrigger[] = [trig({})]) {
    store.addFlow(S, { id, name: id, version: 1, graph, triggers });
}

/** Fluxo: pergunta o nome → menu (1 Sim / 2 Não) → condição por campo → mensagens. */
const welcome: FlowGraph = {
    nodes: [
        { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
        { id: "ask", type: "content", position: { x: 0, y: 0 }, data: { items: [
            { id: "t1", kind: "text", text: "Oi! Tudo bem?" },
            { id: "d1", kind: "delay", seconds: 3, typing: true },
            { id: "in1", kind: "input", question: "Qual seu nome?", answerType: "firstName", fieldKey: "nome", fieldScope: "CONTACT", expireValue: 1, expireUnit: "hours", errorMessage: "Não entendi", maxAttempts: 2 },
        ] } },
        { id: "menu", type: "menu", position: { x: 0, y: 0 }, data: { mode: "number", question: "{nome}, quer receber ofertas?", invalidText: "Responda 1 ou 2", maxErrors: 2, options: [{ id: "yes", text: "Sim" }, { id: "no", text: "Não" }], expireValue: 1, expireUnit: "days" } },
        { id: "act", type: "action", position: { x: 0, y: 0 }, data: { actions: [{ id: "a1", type: "addTag", labelId: "L1" }, { id: "a2", type: "setField", fieldKey: "aceitou", fieldScope: "CONTACT", value: "sim" }] } },
        { id: "bye", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "t2", kind: "text", text: "Fechado, {nome}!" }] } },
        { id: "out", type: "action", position: { x: 0, y: 0 }, data: { actions: [{ id: "a3", type: "optOut" }] } },
    ],
    edges: [
        { id: "e1", source: "start", sourceHandle: "next", target: "ask" },
        { id: "e2", source: "ask", sourceHandle: "next", target: "menu" },
        { id: "e3", source: "menu", sourceHandle: "option:yes", target: "act" },
        { id: "e4", source: "act", sourceHandle: "next", target: "bye" },
        { id: "e5", source: "menu", sourceHandle: "option:no", target: "out" },
    ],
};

beforeEach(() => {
    clock = new Date("2026-10-26T12:00:00Z");
    settings = resolveSettings({ sending: { typingSimulation: false } });
    store = new MemoryStore();
    store.addContact({ id: "c1", sessionId: S, jid: "5511999990000@s.whatsapp.net", phone: "5511999990000", pushName: "Maria Silva" });
    store.labels.set(S, new Map([["L1", "Interessado"]]));
    engine = new FlowEngine({ store, settings: () => settings, now: () => clock, random: () => 0.1 });
});

describe("conversa completa", () => {
    it("pergunta, valida, menu, ação e mensagem final", async () => {
        addFlow("f1", welcome);
        expect(await engine.handleIncoming(msg("olá"))).toBe("started");
        expect(store.sentTexts()).toEqual(["Oi! Tudo bem?", "Qual seu nome?"]);
        // a pausa com "digitando" vira typingMs no envio seguinte
        expect(store.outbound[1].typingMs).toBe(3000);
        expect(store.commits).toBe(1); // um commit por avanço

        expect(await engine.handleIncoming(msg("   "))).toBe("handled");
        expect(store.sentTexts().at(-1)).toBe("Não entendi");

        await engine.handleIncoming(msg("Ana Paula"));
        expect(store.contacts.get("c1")!.fields.nome).toBe("Ana");
        expect(store.sentTexts().at(-1)).toBe("Ana, quer receber ofertas?\n\n1. Sim\n2. Não");

        await engine.handleIncoming(msg("talvez"));
        expect(store.sentTexts().at(-1)).toBe("Responda 1 ou 2");

        await engine.handleIncoming(msg("1"));
        expect(store.sentTexts().at(-1)).toBe("Fechado, Ana!");
        expect([...store.tags.get("c1")!]).toEqual(["L1"]);
        expect(store.contacts.get("c1")!.fields.aceitou).toBe("sim");
        const run = [...store.runs.values()][0];
        expect(run.status).toBe("completed");
        expect(store.stats.get("f1:menu:option:yes")).toBe(1);
    });

    it("mensagem repetida (mesmo id) não avança duas vezes", async () => {
        addFlow("f1", welcome);
        await engine.handleIncoming(msg("oi"));
        const m = msg("Ana");
        await engine.handleIncoming(m);
        const n = store.outbound.length;
        expect(await engine.handleIncoming(m)).toBe("duplicate");
        expect(store.outbound.length).toBe(n);
    });

    it("sem resposta segue o caminho de tempo esgotado ou expira", async () => {
        addFlow("f1", welcome);
        await engine.handleIncoming(msg("oi"));
        clock = new Date(clock.getTime() + 2 * 3600_000);
        const due = store.dueRuns(clock);
        expect(due).toHaveLength(1);
        await engine.resume(due[0]);
        expect([...store.runs.values()][0].status).toBe("expired");
    });

    it("opt-out grava no contato", async () => {
        addFlow("f1", welcome);
        await engine.handleIncoming(msg("oi"));
        await engine.handleIncoming(msg("Ana"));
        await engine.handleIncoming(msg("2"));
        expect(store.contacts.get("c1")!.optedOutAt).toEqual(clock);
    });
});

describe("gatilhos e pausa", () => {
    it("sem gatilho que case não faz nada", async () => {
        addFlow("f1", welcome, [trig({ type: "keyword", value: "promo", match: "exact" })]);
        expect(await engine.handleIncoming(msg("oi"))).toBe("no-trigger");
        expect(await engine.handleIncoming(msg("PROMO"))).toBe("started");
    });

    it("contato pausado não dispara fluxo; cancelActive com pausa (atendimento humano)", async () => {
        addFlow("f1", welcome);
        await engine.handleIncoming(msg("oi"));
        await engine.cancelActive("c1", "Atendimento humano", { pauseUntil: new Date(clock.getTime() + 3600_000) });
        expect([...store.runs.values()][0].status).toBe("cancelled");
        expect(await engine.handleIncoming(msg("oi de novo"))).toBe("paused");
    });

    it("primeira mensagem só no primeiro contato", async () => {
        addFlow("f1", welcome, [trig({ type: "firstMessage" })]);
        expect(await engine.handleIncoming(msg("oi", { isFirstContact: false }))).toBe("no-trigger");
        expect(await engine.handleIncoming(msg("oi", { isFirstContact: true }))).toBe("started");
    });
});

describe("atraso inteligente", () => {
    const delayed: FlowGraph = {
        nodes: [
            { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
            { id: "wait", type: "smartDelay", position: { x: 0, y: 0 }, data: { mode: "duration", value: 2, unit: "hours" } },
            { id: "msg", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "t", kind: "text", text: "Passaram 2 horas" }] } },
        ],
        edges: [
            { id: "e1", source: "start", sourceHandle: "next", target: "wait" },
            { id: "e2", source: "wait", sourceHandle: "next", target: "msg" },
        ],
    };

    it("espera, ignora mensagem no meio (padrão) e retoma no horário", async () => {
        addFlow("d", delayed);
        await engine.handleIncoming(msg("oi"));
        expect(await engine.handleIncoming(msg("alô?"))).toBe("busy");
        expect(store.dueRuns(clock)).toHaveLength(0);
        clock = new Date(clock.getTime() + 2 * 3600_000 + 1);
        await engine.resume(store.dueRuns(clock)[0]);
        expect(store.sentTexts()).toEqual(["Passaram 2 horas"]);
    });

    it("com onMessageDuringDelay = interrupt, nova mensagem cancela e procura gatilho", async () => {
        settings = resolveSettings({ onMessageDuringDelay: "interrupt", sending: { typingSimulation: false } });
        addFlow("d", delayed, [trig({ type: "keyword", value: "oi" })]);
        addFlow("f1", welcome, [trig({ type: "keyword", value: "menu" })]);
        await engine.handleIncoming(msg("oi"));
        expect(await engine.handleIncoming(msg("menu"))).toBe("started");
        const statuses = [...store.runs.values()].map(r => `${r.flowId}:${r.status}`).sort();
        expect(statuses).toEqual(["d:cancelled", "f1:waiting_input"]);
    });
});

describe("ligação entre fluxos e randomizador", () => {
    it("flowLink termina um e começa o outro no mesmo commit", async () => {
        const a: FlowGraph = {
            nodes: [
                { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
                { id: "set", type: "action", position: { x: 0, y: 0 }, data: { actions: [{ id: "x", type: "setField", fieldKey: "origem", fieldScope: "CONTACT", value: "A" }] } },
                { id: "go", type: "flowLink", position: { x: 0, y: 0 }, data: { flowId: "b" } },
            ],
            edges: [{ id: "1", source: "start", sourceHandle: "next", target: "set" }, { id: "2", source: "set", sourceHandle: "next", target: "go" }],
        };
        const b: FlowGraph = {
            nodes: [
                { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
                { id: "m", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "t", kind: "text", text: "Vim do {origem}" }] } },
            ],
            edges: [{ id: "1", source: "start", sourceHandle: "next", target: "m" }],
        };
        addFlow("a", a, [trig({ type: "keyword", value: "a" })]);
        addFlow("b", b, []);
        await engine.handleIncoming(msg("a"));
        expect(store.sentTexts()).toEqual(["Vim do A"]);
        expect(store.commits).toBe(1);
        expect([...store.runs.values()].map(r => r.status)).toEqual(["completed", "completed"]);
    });

    it("ciclo infinito é interrompido", async () => {
        const loop: FlowGraph = {
            nodes: [
                { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
                { id: "c", type: "condition", position: { x: 0, y: 0 }, data: { logic: "or", conditions: [{ id: "x", source: "weekday", op: "is", value: "9" }] } },
            ],
            edges: [
                { id: "1", source: "start", sourceHandle: "next", target: "c" },
                { id: "2", source: "c", sourceHandle: "false", target: "c" },
            ],
        };
        addFlow("l", loop);
        await engine.handleIncoming(msg("oi"));
        const run = [...store.runs.values()][0];
        expect(run.status).toBe("failed");
        expect(run.error).toMatch(/ciclo/);
    });

    it("randomizador sequencial alterna", async () => {
        const g: FlowGraph = {
            nodes: [
                { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
                { id: "r", type: "randomizer", position: { x: 0, y: 0 }, data: { mode: "sequential", options: [{ id: "a", weight: 50 }, { id: "b", weight: 50 }] } },
                { id: "ma", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "1", kind: "text", text: "A" }] } },
                { id: "mb", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "2", kind: "text", text: "B" }] } },
            ],
            edges: [
                { id: "1", source: "start", sourceHandle: "next", target: "r" },
                { id: "2", source: "r", sourceHandle: "option:a", target: "ma" },
                { id: "3", source: "r", sourceHandle: "option:b", target: "mb" },
            ],
        };
        addFlow("r", g);
        await engine.handleIncoming(msg("1"));
        await engine.handleIncoming(msg("2"));
        await engine.handleIncoming(msg("3"));
        expect(store.sentTexts()).toEqual(["A", "B", "A"]);
    });
});

describe("menu interativo (enquete)", () => {
    it("guarda id e segredo da enquete e ignora voto em enquete antiga", async () => {
        const g = structuredClone(welcome);
        (g.nodes[2].data as { mode: string }).mode = "interactive";
        addFlow("f1", g);
        await engine.handleIncoming(msg("oi"));
        await engine.handleIncoming(msg("Ana"));
        const out = store.outbound.at(-1)!;
        expect(out.payload.kind).toBe("menu");
        const pollId = out.payload.kind === "menu" ? out.payload.messageId : "";
        expect(out.waId).toBe(pollId);
        const run = [...store.runs.values()][0];
        expect(run.wait).toMatchObject({ kind: "menu", poll: { id: pollId } });

        expect(await engine.handleIncoming(msg("", { pollId: "OUTRA", optionId: "yes" }))).toBe("ignored");
        expect(await engine.handleIncoming(msg("", { pollId, optionId: "yes" }))).toBe("handled");
        expect(store.sentTexts().at(-1)).toBe("Fechado, Ana!");
    });
});

describe("evento externo", () => {
    it("grava campos e inicia o fluxo num bloco", async () => {
        addFlow("f1", welcome, []);
        const contact = (await store.getContact("c1"))!;
        const flow = (await store.getActiveFlow(S, "f1"))!;
        await engine.externalEvent({ contact, fields: { nome: "Bia", pedido: "123" }, start: { flow, nodeId: "bye" } });
        expect(store.sentTexts()).toEqual(["Fechado, Bia!"]);
        expect(store.contacts.get("c1")!.fields.pedido).toBe("123");
    });
});
