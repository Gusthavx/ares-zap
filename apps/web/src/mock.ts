// Mock opcional da API para desenvolver sem backend: só entra com VITE_MOCK=1 (npm run dev:mock).
// Dados de exemplo em memória; nada disso vai para o build normal (import dinâmico).
import { emptyGraph, newId, type FlowGraph, type FlowTrigger, type SessionSettings } from "@areszap/core";
import type { Broadcast, Chat, Contact, Flow, Label, Message, Session, Webhook, ApiKey, User } from "./api";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const MIN = 60_000, H = 60 * MIN, D = 24 * H;

const settings = {} as SessionSettings;
const me: User = { id: "u1", email: "voce@exemplo.com", name: "Você", role: "admin" };
let loggedIn = true;

const sessions: Session[] = [
    { id: "s1", name: "Atendimento", provider: "baileys", enabled: true, status: "connected", phone: "5521999990000", lastError: null, settings, connectedAt: iso(3 * D), createdAt: iso(20 * D), qr: null },
    { id: "s2", name: "Vendas", provider: "baileys", enabled: true, status: "qr", phone: null, lastError: null, settings, connectedAt: null, createdAt: iso(2 * D), qr: "2@exemplo-de-qr-code-para-teste,abc,def,ghi" },
];
const labels: Label[] = [
    { id: "l1", name: "Cliente", color: "#16a34a", count: 2 },
    { id: "l2", name: "Lead frio", color: "#737373", count: 1 },
];
const contacts: Contact[] = [
    { id: "c1", jid: "5521988887777@s.whatsapp.net", phone: "5521988887777", name: "Ana Lima", pushName: "Ana", fields: { cidade: "Niterói" }, labels: [labels[0]], pausedUntil: null, optedOutAt: null, createdAt: iso(5 * D) },
    { id: "c2", jid: "5511977776666@s.whatsapp.net", phone: "5511977776666", name: null, pushName: "Bruno", fields: {}, labels: [labels[0], labels[1]], pausedUntil: new Date(now + 2 * H).toISOString(), optedOutAt: null, createdAt: iso(2 * D) },
];
const chats: Chat[] = [
    { id: "ch1", jid: contacts[0].jid, title: "Ana Lima", phone: contacts[0].phone, lastMessageText: "Quero saber o preço", lastMessageAt: iso(4 * MIN), lastFromMe: false, unread: 2, archived: false, contactId: "c1", pausedUntil: null, activeRun: { id: "r1", flowId: "f1", flowName: "Boas-vindas", status: "waiting_input" } },
    { id: "ch2", jid: contacts[1].jid, title: "Bruno", phone: contacts[1].phone, lastMessageText: "Obrigado!", lastMessageAt: iso(3 * H), lastFromMe: true, unread: 0, archived: false, contactId: "c2", pausedUntil: new Date(now + 2 * H).toISOString(), activeRun: null },
];
const messages: Record<string, Message[]> = {
    ch1: [
        { id: "m4", waId: "w4", fromMe: false, sender: "contact", type: "text", body: "Quero saber o preço", media: null, status: null, createdAt: iso(4 * MIN) },
        { id: "m3", waId: "w3", fromMe: true, sender: "flow", type: "text", body: "Como posso ajudar?\n\n1. Preços\n2. Falar com atendente", media: null, status: "read", createdAt: iso(5 * MIN) },
        { id: "m2", waId: "w2", fromMe: true, sender: "flow", type: "text", body: "Olá Ana! Bem-vinda 👋", media: null, status: "read", createdAt: iso(5 * MIN + 2000) },
        { id: "m1", waId: "w1", fromMe: false, sender: "contact", type: "text", body: "oi", media: null, status: null, createdAt: iso(6 * MIN) },
    ],
    ch2: [
        { id: "m6", waId: "w6", fromMe: true, sender: "agent", type: "text", body: "Obrigado!", media: null, status: "delivered", createdAt: iso(3 * H) },
        { id: "m5", waId: "w5", fromMe: false, sender: "contact", type: "text", body: "Recebi o pedido, valeu", media: null, status: null, createdAt: iso(3 * H + 5 * MIN) },
    ],
};

const startGraph = (): FlowGraph => {
    const g = emptyGraph();
    const c = { id: "n1", type: "content" as const, position: { x: 320, y: 0 }, data: { items: [{ id: "i1", kind: "text" as const, text: "Olá {primeiro-nome}! Bem-vinda 👋" }] } };
    const m = { id: "n2", type: "menu" as const, position: { x: 660, y: 0 }, data: { mode: "number" as const, question: "Como posso ajudar?", invalidText: "Opção inválida.", maxErrors: 3, options: [{ id: "o1", text: "Preços" }, { id: "o2", text: "Falar com atendente" }], expireValue: 1, expireUnit: "days" as const } };
    g.nodes.push(c, m);
    g.edges.push({ id: "e1", source: "start", sourceHandle: "next", target: "n1" }, { id: "e2", source: "n1", sourceHandle: "next", target: "n2" });
    return g;
};
const flows: Flow[] = [
    {
        id: "f1", sessionId: "s1", name: "Boas-vindas", status: "active", publishedVersion: 3, publishedAt: iso(D), updatedAt: iso(2 * H),
        triggers: [{ id: "t1", type: "keyword", match: "word", value: "oi, olá", priority: 0 }], hasUnpublishedChanges: false, runsActive: 4,
        draftGraph: startGraph(), draftTriggers: [{ id: "t1", type: "keyword", match: "word", value: "oi, olá", priority: 0 }], draftRevision: 7,
        publishedGraph: startGraph(), publishedTriggers: [{ id: "t1", type: "keyword", match: "word", value: "oi, olá", priority: 0 }],
    },
];
let variables: Record<string, string> = { preco: "R$ 97,00", link: "https://exemplo.com/checkout" };
const broadcasts: Broadcast[] = [
    { id: "b1", name: "Promoção de outubro", status: "running", message: { kind: "text", text: "Oi {nome}, temos uma oferta para você." }, scheduledAt: null, minGapSec: 15, maxGapSec: 45, skipOptedOut: true, total: 1200, sent: 430, failed: 6, skipped: 12, createdAt: iso(5 * H), startedAt: iso(5 * H), finishedAt: null, etaAt: new Date(now + 3 * H).toISOString() },
    { id: "b2", name: "Aviso de feriado", status: "completed", message: { kind: "text", text: "Amanhã não abrimos." }, scheduledAt: null, minGapSec: 15, maxGapSec: 45, skipOptedOut: true, total: 80, sent: 79, failed: 1, skipped: 0, createdAt: iso(4 * D), startedAt: iso(4 * D), finishedAt: iso(4 * D - H), etaAt: null },
];
const webhooks: Webhook[] = [{ id: "w1", sessionId: null, url: "https://exemplo.com/hooks/areszap", events: ["message.received", "flow.completed"], active: true, lastStatus: 200, lastError: null, lastAt: iso(10 * MIN), createdAt: iso(10 * D) }];
const apiKeys: ApiKey[] = [{ id: "k1", name: "Loja", prefix: "az_live_3f9a", lastUsedAt: iso(H), createdAt: iso(9 * D) }];
const users: User[] = [{ ...me, createdAt: iso(30 * D) }];

type Handler = (m: RegExpMatchArray, body: unknown, url: URL) => unknown;
class Fail { constructor(public status: number, public body: unknown) { } }
const ok = { ok: true };
const summary = (f: Flow) => ({ id: f.id, name: f.name, status: f.status, publishedVersion: f.publishedVersion, publishedAt: f.publishedAt, updatedAt: f.updatedAt, triggers: f.triggers, hasUnpublishedChanges: f.hasUnpublishedChanges, runsActive: f.runsActive });
const findFlow = (id: string) => { const f = flows.find(x => x.id === id); if (!f) throw new Fail(404, { error: "Fluxo não encontrado." }); return f; };

let simStep = 0;

const routes: [string, RegExp, Handler][] = [
    ["POST", /^\/auth\/login$/, () => { loggedIn = true; return { user: me }; }],
    ["POST", /^\/auth\/logout$/, () => { loggedIn = false; return ok; }],
    ["GET", /^\/auth\/me$/, () => { if (!loggedIn) throw new Fail(401, { error: "Não autenticado." }); return { user: me }; }],
    ["POST", /^\/auth\/password$/, () => ok],
    ["GET", /^\/sessions$/, () => sessions],
    ["POST", /^\/sessions$/, (_, b) => { const s: Session = { ...sessions[1], id: newId(), name: (b as { name: string }).name, status: "stopped", qr: null, createdAt: new Date().toISOString() }; sessions.push(s); return s; }],
    ["GET", /^\/sessions\/([^/]+)$/, m => sessions.find(s => s.id === m[1])],
    ["PATCH", /^\/sessions\/([^/]+)$/, (m, b) => { const s = sessions.find(x => x.id === m[1])!; Object.assign(s, b); return s; }],
    ["POST", /^\/sessions\/([^/]+)\/(start|stop|logout)$/, m => { const s = sessions.find(x => x.id === m[1])!; s.status = m[2] === "start" ? "qr" : m[2] === "stop" ? "stopped" : "logged_out"; if (m[2] === "start") s.qr = "2@qr-de-teste," + Date.now(); return ok; }],
    ["GET", /^\/sessions\/([^/]+)\/stats$/, () => ({ outbox: { queued: 12, held: 3, sending: 1, sentToday: 342, failedToday: 2 }, cap: { today: 640, perDay: 1500 }, flows: { active: 1, runsActive: 4 } })],
    ["GET", /^\/sessions\/([^/]+)\/chats$/, (m, _, u) => {
        const q = (u.searchParams.get("search") ?? "").toLowerCase();
        const arch = u.searchParams.get("archived") === "1";
        return { items: m[1] === "s1" ? chats.filter(c => c.archived === arch && (!q || c.title.toLowerCase().includes(q) || c.phone.includes(q))) : [], nextCursor: null };
    }],
    ["GET", /^\/chats\/([^/]+)\/messages$/, m => ({ items: messages[m[1]] ?? [] })],
    ["POST", /^\/chats\/([^/]+)\/messages$/, (m, b) => {
        const body = b as { text?: string; caption?: string };
        (messages[m[1]] ||= []).unshift({ id: newId(), waId: newId(), fromMe: true, sender: "agent", type: "text", body: body.text ?? body.caption ?? "", media: null, status: "queued", createdAt: new Date().toISOString() });
        const c = chats.find(x => x.id === m[1]); if (c) { c.lastMessageText = body.text ?? ""; c.lastFromMe = true; c.lastMessageAt = new Date().toISOString(); c.pausedUntil = new Date(Date.now() + 2 * H).toISOString(); }
        return { outboxId: newId(), waId: newId() };
    }],
    ["POST", /^\/chats\/([^/]+)\/read$/, m => { const c = chats.find(x => x.id === m[1]); if (c) c.unread = 0; return ok; }],
    ["POST", /^\/chats\/([^/]+)\/archive$/, (m, b) => { const c = chats.find(x => x.id === m[1]); if (c) c.archived = (b as { archived: boolean }).archived; return ok; }],
    ["POST", /^\/chats\/([^/]+)\/automation$/, (m, b) => {
        const c = chats.find(x => x.id === m[1])!; const a = b as { action: string; minutes?: number };
        c.pausedUntil = a.action === "resume" ? null : new Date(Date.now() + (a.minutes ?? 60) * MIN).toISOString();
        return { pausedUntil: c.pausedUntil };
    }],
    ["GET", /^\/sessions\/([^/]+)\/contacts$/, (_, __, u) => {
        const q = (u.searchParams.get("search") ?? "").toLowerCase(); const l = u.searchParams.get("labelId");
        return { items: contacts.filter(c => (!q || (c.name ?? c.pushName ?? "").toLowerCase().includes(q) || c.phone.includes(q)) && (!l || c.labels.some(x => x.id === l))), nextCursor: null };
    }],
    ["PATCH", /^\/contacts\/([^/]+)$/, (m, b) => {
        const c = contacts.find(x => x.id === m[1])!; const p = b as { name?: string; fields?: Record<string, string>; labelIds?: string[]; optedOut?: boolean };
        if (p.name !== undefined) c.name = p.name || null; if (p.fields) c.fields = p.fields;
        if (p.labelIds) c.labels = labels.filter(l => p.labelIds!.includes(l.id));
        if (p.optedOut !== undefined) c.optedOutAt = p.optedOut ? new Date().toISOString() : null;
        return c;
    }],
    ["GET", /^\/sessions\/([^/]+)\/labels$/, () => labels],
    ["POST", /^\/sessions\/([^/]+)\/labels$/, (_, b) => { const l = { id: newId(), count: 0, color: "#737373", ...(b as { name: string }) }; labels.push(l); return l; }],
    ["PATCH", /^\/labels\/([^/]+)$/, (m, b) => Object.assign(labels.find(l => l.id === m[1])!, b)],
    ["DELETE", /^\/labels\/([^/]+)$/, m => { labels.splice(labels.findIndex(l => l.id === m[1]), 1); return ok; }],
    ["GET", /^\/sessions\/([^/]+)\/variables$/, () => variables],
    ["PUT", /^\/sessions\/([^/]+)\/variables$/, (_, b) => { for (const [k, v] of Object.entries(b as Record<string, string | null>)) { if (v === null) delete variables[k]; else variables[k] = v; } variables = { ...variables }; return variables; }],
    ["GET", /^\/sessions\/([^/]+)\/flows$/, m => flows.filter(f => f.sessionId === m[1]).map(summary)],
    ["POST", /^\/sessions\/([^/]+)\/flows$/, (m, b) => {
        const f: Flow = { ...structuredClone(flows[0]), id: newId(), sessionId: m[1], name: (b as { name: string }).name, status: "draft", publishedVersion: null, publishedAt: null, publishedGraph: null, publishedTriggers: null, draftGraph: emptyGraph(), draftTriggers: [], triggers: [], draftRevision: 1, runsActive: 0, hasUnpublishedChanges: true, updatedAt: new Date().toISOString() };
        flows.push(f); return f;
    }],
    ["POST", /^\/sessions\/([^/]+)\/flows\/import$/, (m, b) => {
        const j = b as { name?: string; graph?: FlowGraph; triggers?: FlowTrigger[] };
        const f: Flow = { ...structuredClone(flows[0]), id: newId(), sessionId: m[1], name: j.name ?? "Importado", status: "draft", publishedVersion: null, publishedGraph: null, publishedTriggers: null, draftGraph: j.graph ?? emptyGraph(), draftTriggers: j.triggers ?? [], triggers: [], draftRevision: 1, runsActive: 0 };
        flows.push(f); return f;
    }],
    ["GET", /^\/flows\/([^/]+)$/, m => findFlow(m[1])],
    ["GET", /^\/flows\/([^/]+)\/export$/, m => { const f = findFlow(m[1]); return { name: f.name, graph: f.draftGraph, triggers: f.draftTriggers }; }],
    ["PATCH", /^\/flows\/([^/]+)$/, (m, b) => Object.assign(findFlow(m[1]), b)],
    ["PUT", /^\/flows\/([^/]+)\/draft$/, (m, b) => {
        const f = findFlow(m[1]); const p = b as { graph: FlowGraph; triggers: FlowTrigger[]; revision: number };
        if (p.revision !== f.draftRevision) throw new Fail(409, { error: "Outra aba salvou antes.", revision: f.draftRevision });
        f.draftGraph = p.graph; f.draftTriggers = p.triggers; f.draftRevision++; f.hasUnpublishedChanges = true; f.updatedAt = new Date().toISOString();
        return { revision: f.draftRevision };
    }],
    ["POST", /^\/flows\/([^/]+)\/publish$/, m => {
        const f = findFlow(m[1]);
        f.publishedGraph = structuredClone(f.draftGraph); f.publishedTriggers = structuredClone(f.draftTriggers); f.triggers = f.draftTriggers;
        f.publishedVersion = (f.publishedVersion ?? 0) + 1; f.status = "active"; f.hasUnpublishedChanges = false;
        return { version: f.publishedVersion, issues: [] };
    }],
    ["POST", /^\/flows\/([^/]+)\/(activate|deactivate)$/, m => { findFlow(m[1]).status = m[2] === "activate" ? "active" : "inactive"; return ok; }],
    ["POST", /^\/flows\/([^/]+)\/duplicate$/, m => { const f = { ...structuredClone(findFlow(m[1])), id: newId() }; f.name += " (cópia)"; flows.push(f); return f; }],
    ["DELETE", /^\/flows\/([^/]+)$/, m => { flows.splice(flows.findIndex(f => f.id === m[1]), 1); return ok; }],
    ["POST", /^\/flows\/([^/]+)\/simulate$/, (_, b) => {
        const p = b as { text?: string; optionId?: string; reset?: boolean };
        if (p.reset) { simStep = 0; return { result: "reset", messages: [], run: null, fields: {}, tags: [] }; }
        if (simStep === 0) {
            if (!/oi|olá/i.test(p.text ?? "")) return { result: "no-trigger", messages: [], run: null, fields: {}, tags: [] };
            simStep = 1;
            return {
                result: "started", fields: { "primeiro-nome": "Teste" }, tags: [],
                messages: [{ kind: "text", text: "Olá Teste! Bem-vinda 👋", typingMs: 1200, delayMs: 0 }, { kind: "menu", text: "Como posso ajudar?", options: [{ id: "o1", text: "Preços" }, { id: "o2", text: "Falar com atendente" }], mode: "number", typingMs: 900, delayMs: 0 }],
                run: { status: "waiting_input", currentNodeId: "n2", wait: { kind: "menu" }, resumeAt: new Date(Date.now() + D).toISOString() },
            };
        }
        simStep = 0;
        return { result: "handled", fields: { "primeiro-nome": "Teste" }, tags: ["l1"], messages: [{ kind: "text", text: "Você escolheu: " + (p.optionId ?? p.text), typingMs: 0, delayMs: 0 }, { kind: "text", text: "Novo contato no fluxo", to: "5521911112222", typingMs: 0, delayMs: 0 }], run: { status: "completed", currentNodeId: null, wait: null, resumeAt: null } };
    }],
    ["POST", /^\/flows\/([^/]+)\/test$/, () => ({ runId: newId() })],
    ["GET", /^\/flows\/([^/]+)\/stats$/, () => ({ nodes: { n1: { entered: 120 }, n2: { entered: 118, "option:o1": 70, "option:o2": 31 } }, runs: { completed: 90, waiting_input: 4 } })],
    ["GET", /^\/flows\/([^/]+)\/runs$/, m => ({ items: [{ id: "r1", flowId: m[1], flowVersion: 3, contactId: "c1", jid: contacts[0].jid, status: "waiting_input", currentNodeId: "n2", resumeAt: new Date(now + D).toISOString(), isTest: false, error: null, createdAt: iso(6 * MIN), updatedAt: iso(5 * MIN) }] })],
    ["GET", /^\/runs\/([^/]+)\/events$/, () => ({ items: [
        { id: "e1", nodeId: null, kind: "START", detail: null, createdAt: iso(6 * MIN) },
        { id: "e2", nodeId: "n1", kind: "ENTER", detail: null, createdAt: iso(6 * MIN) },
        { id: "e3", nodeId: "n1", kind: "SEND", detail: { summary: "Olá Ana! Bem-vinda 👋" }, createdAt: iso(6 * MIN) },
        { id: "e4", nodeId: "n2", kind: "WAIT", detail: { until: new Date(now + D).toISOString() }, createdAt: iso(5 * MIN) },
    ] })],
    ["POST", /^\/runs\/([^/]+)\/cancel$/, () => ok],
    ["POST", /^\/sessions\/([^/]+)\/assets$/, (_, b) => { const f = (b as FormData).get("file") as File; return { id: newId(), fileName: f.name, mime: f.type || "application/octet-stream", size: f.size, createdAt: new Date().toISOString(), url: "" }; }],
    ["GET", /^\/sessions\/([^/]+)\/broadcasts$/, () => broadcasts],
    ["POST", /^\/sessions\/([^/]+)\/broadcasts$/, (_, b) => {
        const p = b as { name: string; text: string; recipients?: unknown[] };
        const x: Broadcast = { ...broadcasts[1], id: newId(), name: p.name, status: "running", message: { kind: "text", text: p.text }, total: p.recipients?.length ?? 0, sent: 0, failed: 0, skipped: 0, createdAt: new Date().toISOString(), finishedAt: null };
        broadcasts.unshift(x); return x;
    }],
    ["GET", /^\/broadcasts\/([^/]+)$/, m => broadcasts.find(b => b.id === m[1])],
    ["GET", /^\/broadcasts\/([^/]+)\/recipients$/, () => ({ items: [
        { id: "1", jid: contacts[0].jid, status: "sent", error: null, sentAt: iso(30 * MIN) },
        { id: "2", jid: contacts[1].jid, status: "failed", error: "Número sem WhatsApp", sentAt: null },
        { id: "3", jid: "5531966665555@s.whatsapp.net", status: "pending", error: null, sentAt: null },
    ], total: 3 })],
    ["POST", /^\/broadcasts\/([^/]+)\/(pause|resume|cancel)$/, m => { const b = broadcasts.find(x => x.id === m[1])!; b.status = m[2] === "pause" ? "paused" : m[2] === "resume" ? "running" : "cancelled"; return ok; }],
    ["GET", /^\/webhooks$/, () => webhooks],
    ["POST", /^\/webhooks$/, (_, b) => { const w = { ...webhooks[0], id: newId(), lastAt: null, lastStatus: null, ...(b as object) } as Webhook; webhooks.push(w); return { ...w, secret: "whsec_exemplo_" + newId() }; }],
    ["PATCH", /^\/webhooks\/([^/]+)$/, (m, b) => Object.assign(webhooks.find(w => w.id === m[1])!, b)],
    ["DELETE", /^\/webhooks\/([^/]+)$/, m => { webhooks.splice(webhooks.findIndex(w => w.id === m[1]), 1); return ok; }],
    ["POST", /^\/webhooks\/([^/]+)\/test$/, () => ok],
    ["GET", /^\/api-keys$/, () => apiKeys],
    ["POST", /^\/api-keys$/, (_, b) => { const k = { id: newId(), name: (b as { name: string }).name, prefix: "az_live_" + newId().slice(0, 4), lastUsedAt: null, createdAt: new Date().toISOString() }; apiKeys.push(k); return { ...k, key: k.prefix + newId() + newId() }; }],
    ["DELETE", /^\/api-keys\/([^/]+)$/, m => { apiKeys.splice(apiKeys.findIndex(k => k.id === m[1]), 1); return ok; }],
    ["GET", /^\/users$/, () => users],
    ["POST", /^\/users$/, (_, b) => { const u = { ...(b as User), id: newId(), createdAt: new Date().toISOString() }; users.push(u); return u; }],
    ["DELETE", /^\/users\/([^/]+)$/, m => { users.splice(users.findIndex(u => u.id === m[1]), 1); return ok; }],
];

export function installMock() {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, location.origin);
        if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/assets/")) return real(input, init);
        const path = url.pathname.slice(4);
        const method = (init?.method ?? "GET").toUpperCase();
        let body: unknown = init?.body;
        if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* texto */ } }
        await new Promise(r => setTimeout(r, 120));
        for (const [m, re, h] of routes) {
            const match = method === m ? path.match(re) : null;
            if (!match) continue;
            try {
                const out = h(match, body, url);
                return new Response(JSON.stringify(out ?? null), { status: 200, headers: { "Content-Type": "application/json" } });
            } catch (e) {
                if (e instanceof Fail) return new Response(JSON.stringify(e.body), { status: e.status, headers: { "Content-Type": "application/json" } });
                throw e;
            }
        }
        return new Response(JSON.stringify({ error: `Mock sem rota: ${method} ${path}` }), { status: 404, headers: { "Content-Type": "application/json" } });
    };
    console.info("[Ares Zap] API simulada (VITE_MOCK=1)");
}
