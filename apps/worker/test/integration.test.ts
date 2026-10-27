// Integração com Postgres real (pula se TEST_DATABASE_URL não estiver definido).
// Usa um provedor falso no lugar do WhatsApp: testa pipeline → motor → fila → sender → banco.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connect, runMigrations } from "@areszap/db";
import { FlowEngine, KeyedMutex, PgStore } from "@areszap/engine";
import { resolveSettings, type FlowGraph, type OutMessage } from "@areszap/core";
import { SessionInfoCache, type Ctx } from "../src/context";
import { InboundPipeline } from "../src/pipeline";
import { OutboxSender } from "../src/sender";
import { Webhooks } from "../src/webhooks";
import { startBroadcast } from "../src/broadcasts";
import type { InboundMessage, Provider } from "../src/providers/types";

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

class FakeProvider implements Provider {
    readonly kind = "baileys" as const;
    sent: { jid: string; msg: OutMessage; waId: string; at: number }[] = [];
    presences: string[] = [];
    async start() { }
    async stop() { }
    async logout() { }
    isReady() { return true; }
    async send(jid: string, msg: OutMessage, opts: { waId: string }) { this.sent.push({ jid, msg, waId: opts.waId, at: Date.now() }); return { waId: opts.waId }; }
    async presence(jid: string, state: string) { this.presences.push(`${state}:${jid}`); }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v as T;
        if (Date.now() > end) throw new Error("tempo esgotado esperando condição");
        await new Promise(r => setTimeout(r, 100));
    }
}

const graph: FlowGraph = {
    nodes: [
        { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
        { id: "ask", type: "content", position: { x: 0, y: 0 }, data: { items: [
            { id: "t1", kind: "text", text: "Oi! Tudo bem?" },
            { id: "in1", kind: "input", question: "Qual seu nome?", answerType: "firstName", fieldKey: "nome", fieldScope: "CONTACT", expireValue: 1, expireUnit: "hours", errorMessage: "Não entendi", maxAttempts: 2 },
        ] } },
        { id: "menu", type: "menu", position: { x: 0, y: 0 }, data: { mode: "number", question: "{nome}, quer ofertas?", invalidText: "Responda 1 ou 2", maxErrors: 2, options: [{ id: "yes", text: "Sim" }, { id: "no", text: "Não" }], expireValue: 1, expireUnit: "days" } },
        { id: "bye", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "t2", kind: "text", text: "Fechado, {nome}!" }] } },
    ],
    edges: [
        { id: "e1", source: "start", sourceHandle: "next", target: "ask" },
        { id: "e2", source: "ask", sourceHandle: "next", target: "menu" },
        { id: "e3", source: "menu", sourceHandle: "option:yes", target: "bye" },
    ],
};

d("integração worker + Postgres", () => {
    let h: ReturnType<typeof connect>;
    let ctx: Ctx;
    let pipeline: InboundPipeline;
    let sender: OutboxSender;
    const fake = new FakeProvider();
    let sessionId: string;
    let n = 0;
    const inbound = (jid: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage =>
        ({ jid, waId: `IN${Date.now()}${n++}`, fromMe: false, live: true, type: "text", text, pushName: "Maria Teste", timestamp: new Date(), ...extra });

    beforeAll(async () => {
        const admin = postgres(URL!, { max: 1, onnotice: () => undefined });
        await admin`drop schema if exists public cascade`;
        await admin`drop schema if exists drizzle cascade`;
        await admin`create schema public`;
        await admin.end();
        await runMigrations(URL);
        h = connect(URL, { max: 5 });
        const settings = resolveSettings({ sending: { typingSimulation: false, bulkMinGapSec: 1, bulkMaxGapSec: 1, warmup: { enabled: false } } });
        const [s] = await h.sql`insert into sessions (name, settings, status) values ('teste', ${h.sql.json(settings as any)}, 'connected') returning id`;
        sessionId = s.id;
        await h.sql`insert into flows (session_id, name, status, draft_graph, published_graph, published_triggers, published_version)
                    values (${sessionId}, 'boas-vindas', 'active', ${h.sql.json(graph as any)}, ${h.sql.json(graph as any)},
                            ${h.sql.json([{ id: "t", type: "keyword", match: "word", value: "oi", priority: 0 }])}, 1)`;
        const sessions = new SessionInfoCache(h.sql);
        const store = new PgStore(h.sql, { onOutbound: () => sender?.wake() });
        const engine = new FlowEngine({ store, settings: async id => (await sessions.get(id))!.settings });
        ctx = { sql: h.sql, sessions, store, engine, mutex: new KeyedMutex() };
        const hooks = new Webhooks(h.sql);
        pipeline = new InboundPipeline(ctx, hooks);
        sender = new OutboxSender(ctx, sessionId, fake, hooks);
        sender.start();
    }, 60_000);

    afterAll(async () => { sender?.stop(); await h?.close(); });

    const texts = () => fake.sent.map(s => (s.msg.kind === "text" ? s.msg.text : s.msg.kind));

    it("conversa completa: gatilho, pergunta, menu, campo gravado, tudo enviado na ordem", async () => {
        const jid = "5511900000001@s.whatsapp.net";
        await pipeline.handle(sessionId, fake, [inbound(jid, "oi")]);
        await waitFor(() => fake.sent.length >= 2);
        expect(texts()).toEqual(["Oi! Tudo bem?", "Qual seu nome?"]);

        const [chat] = await h.sql`select * from chats where jid = ${jid}`;
        expect(chat.last_message_text).toBe("Qual seu nome?");
        expect(chat.unread).toBe(0); // resposta do robô zera as não lidas

        await pipeline.handle(sessionId, fake, [inbound(jid, "Ana Paula")]);
        await waitFor(() => fake.sent.length >= 3);
        expect(texts()[2]).toBe("Ana, quer ofertas?\n\n1. Sim\n2. Não");

        await pipeline.handle(sessionId, fake, [inbound(jid, "1")]);
        await waitFor(() => fake.sent.length >= 4);
        expect(texts()[3]).toBe("Fechado, Ana!");

        const [c] = await h.sql`select fields, first_inbound_at from contacts where jid = ${jid}`;
        expect(c.fields.nome).toBe("Ana");
        expect(c.first_inbound_at).not.toBeNull();
        const [run] = await h.sql`select status from flow_runs r join contacts c on c.id = r.contact_id where c.jid = ${jid}`;
        expect(run.status).toBe("completed");
        const msgs = await h.sql`select sender from messages m join chats ch on ch.id = m.chat_id where ch.jid = ${jid} order by m.created_at`;
        expect(msgs.map(m => m.sender)).toEqual(["contact", "flow", "flow", "contact", "flow", "contact", "flow"]);
        const stats = await h.sql`select key, count from flow_node_stats where node_id = 'menu'`;
        expect(Object.fromEntries(stats.map(s => [s.key, s.count]))).toMatchObject({ entered: 1, "option:yes": 1 });
    });

    it("mensagem repetida não dispara de novo", async () => {
        const jid = "5511900000002@s.whatsapp.net";
        const m = inbound(jid, "oi");
        await pipeline.handle(sessionId, fake, [m, m]);
        await waitFor(() => fake.sent.filter(s => s.jid === jid).length >= 2);
        await new Promise(r => setTimeout(r, 500));
        expect(fake.sent.filter(s => s.jid === jid).length).toBe(2);
    });

    it("atendente respondendo pelo celular cancela o fluxo e pausa o contato", async () => {
        const jid = "5511900000003@s.whatsapp.net";
        await pipeline.handle(sessionId, fake, [inbound(jid, "oi")]);
        await waitFor(() => fake.sent.filter(s => s.jid === jid).length >= 2);
        // mensagem do celular (waId que não saiu da fila)
        await pipeline.handle(sessionId, fake, [inbound(jid, "Oi Maria, aqui é a Joana", { fromMe: true, waId: "PHONE123" })]);
        const [c] = await waitFor(async () => {
            const r = await h.sql`select paused_until from contacts where jid = ${jid}`;
            return r[0]?.paused_until ? r : null;
        });
        expect(new Date(c.paused_until).getTime()).toBeGreaterThan(Date.now());
        const [run] = await h.sql`select r.status, r.error from flow_runs r join contacts c on c.id = r.contact_id where c.jid = ${jid}`;
        expect(run.status).toBe("cancelled");
        expect(run.error).toBe("Atendimento humano");
        const [m] = await h.sql`select sender from messages where wa_id = 'PHONE123'`;
        expect(m.sender).toBe("phone");
        // e o eco de uma mensagem nossa NÃO conta como atendimento humano
        const ours = fake.sent.find(s => s.jid === "5511900000001@s.whatsapp.net")!;
        await pipeline.handle(sessionId, fake, [inbound("5511900000001@s.whatsapp.net", "eco", { fromMe: true, waId: ours.waId })]);
        const [c1] = await h.sql`select paused_until from contacts where jid = '5511900000001@s.whatsapp.net'`;
        expect(c1.paused_until).toBeNull();
    });

    it("recibos sobem o status e nunca rebaixam", async () => {
        const waId = fake.sent[0].waId;
        await pipeline.receipts(sessionId, [{ waId, jid: fake.sent[0].jid, status: "read" }]);
        await pipeline.receipts(sessionId, [{ waId, jid: fake.sent[0].jid, status: "delivered" }]);
        const [m] = await h.sql`select status from messages where wa_id = ${waId}`;
        expect(m.status).toBe("read");
    });

    it("transmissão: personaliza, pula quem saiu e respeita o intervalo", async () => {
        await h.sql`insert into contacts (session_id, jid, phone, opted_out_at) values (${sessionId}, '5511900000099@s.whatsapp.net', '5511900000099', now())`;
        const [b] = await h.sql`insert into broadcasts (session_id, name, message, total, min_gap_sec, max_gap_sec)
            values (${sessionId}, 'promo', ${h.sql.json({ kind: "text", text: "Olá {primeiro-nome}, cupom {cupom}" })}, 3, 1, 1) returning id`;
        await h.sql`insert into broadcast_recipients ${h.sql([
            { broadcast_id: b.id, jid: "5511900000097@s.whatsapp.net", vars: h.sql.json({ nome: "Bia", cupom: "A1" }) },
            { broadcast_id: b.id, jid: "5511900000098@s.whatsapp.net", vars: h.sql.json({ nome: "Caio", cupom: "B2" }) },
            { broadcast_id: b.id, jid: "5511900000099@s.whatsapp.net", vars: h.sql.json({ nome: "Saiu", cupom: "C3" }) },
        ])}`;
        const before = fake.sent.length;
        await startBroadcast(ctx, b.id, () => sender.wake());
        const done = await waitFor(async () => {
            const [r] = await h.sql`select * from broadcasts where id = ${b.id}`;
            return r.status === "completed" ? r : null;
        }, 20_000);
        expect([done.sent, done.skipped, done.failed]).toEqual([2, 1, 0]);
        const bulk = fake.sent.slice(before);
        expect(bulk.map(s => (s.msg as { text: string }).text)).toEqual(["Olá Bia, cupom A1", "Olá Caio, cupom B2"]);
        expect(bulk[1].at - bulk[0].at).toBeGreaterThanOrEqual(900); // intervalo de 1 s entre envios em massa
    }, 30_000);
});
