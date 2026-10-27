// Testes da API com Postgres real (pula sem TEST_DATABASE_URL). Usa app.inject, sem abrir porta.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import { connect, runMigrations } from "@areszap/db";
import { buildApp } from "../src/app";

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;

d("API", () => {
    let h: ReturnType<typeof connect>;
    let app: FastifyInstance;
    let cookie = "";
    let sessionId = "";
    let flowId = "";

    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
        const res = await app.inject({ method: method as any, url, payload: body as any, headers: { cookie, ...headers } });
        return { status: res.statusCode, body: res.body ? safe(res.body) : null, headers: res.headers };
    };
    const safe = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

    beforeAll(async () => {
        const admin = postgres(URL!, { max: 1, onnotice: () => undefined });
        await admin`drop schema if exists public cascade`;
        await admin`drop schema if exists drizzle cascade`;
        await admin`create schema public`;
        await admin.end();
        await runMigrations(URL);
        h = connect(URL, { max: 5 });
        await h.sql`insert into users (email, name, password_hash, role) values ('admin@teste.local', 'Admin', ${await bcrypt.hash("senha-forte-123", 4)}, 'admin')`;
        app = await buildApp(h.sql, { logger: false });
    }, 60_000);

    afterAll(async () => { await app?.close(); await h?.close(); });

    it("login: senha errada 401, certa devolve cookie httpOnly", async () => {
        expect((await call("GET", "/api/auth/me")).status).toBe(401);
        expect((await call("POST", "/api/auth/login", { email: "admin@teste.local", password: "errada" })).status).toBe(401);
        const r = await call("POST", "/api/auth/login", { email: "ADMIN@teste.local", password: "senha-forte-123" });
        expect(r.status).toBe(200);
        const set = String(r.headers["set-cookie"]);
        expect(set).toContain("HttpOnly");
        cookie = set.split(";")[0];
        expect((await call("GET", "/api/auth/me")).body.user.email).toBe("admin@teste.local");
    });

    it("minha conta: troca nome e e-mail só com a senha atual; e-mail repetido 409", async () => {
        expect((await call("PATCH", "/api/auth/me", { email: "novo@teste.local", current: "errada" })).status).toBe(400);
        const ok = await call("PATCH", "/api/auth/me", { name: "Dono", email: "Novo@Teste.local", current: "senha-forte-123" });
        expect(ok.status).toBe(200);
        expect(ok.body.user).toMatchObject({ name: "Dono", email: "novo@teste.local" });
        await h.sql`insert into users (email, name, password_hash, role) values ('outro@teste.local', 'Outro', 'x', 'member')`;
        expect((await call("PATCH", "/api/auth/me", { email: "outro@teste.local", current: "senha-forte-123" })).status).toBe(409);
        await h.sql`delete from users where email = 'outro@teste.local'`;
        expect((await call("POST", "/api/auth/login", { email: "novo@teste.local", password: "senha-forte-123" })).status).toBe(200);
        await call("PATCH", "/api/auth/me", { name: "Admin", email: "admin@teste.local", current: "senha-forte-123" });
    });

    it("sessão: cria, configura (validado) e não expõe segredo", async () => {
        const r = await call("POST", "/api/sessions", { name: "Número 1" });
        expect(r.status).toBe(200);
        sessionId = r.body.id;
        expect(r.body.settings.timezone).toBe("America/Sao_Paulo");
        const bad = await call("PATCH", `/api/sessions/${sessionId}`, { settings: { sending: { perMinute: 0 } } });
        expect(bad.status).toBe(400);
        const ok = await call("PATCH", `/api/sessions/${sessionId}`, { settings: { sending: { bulkMinGapSec: 20, bulkMaxGapSec: 60 } } });
        expect(ok.body.settings.sending.bulkMaxGapSec).toBe(60);
        expect(ok.body.settings.sending.perMinute).toBe(20); // o resto continua no padrão
        const cloud = await call("POST", "/api/sessions", { name: "Oficial", provider: "cloud", cloud: { phoneNumberId: "1234567", accessToken: "EAAG-token-secreto-123", appSecret: "app-secret-abc" } });
        expect(cloud.status).toBe(200);
        expect(JSON.stringify(cloud.body)).not.toContain("token-secreto");
        expect(cloud.body.cloud.hasToken).toBe(true);
        const [raw] = await h.sql`select cloud_config from sessions where id = ${cloud.body.id}`;
        expect(raw.cloud_config.accessToken).toMatch(/^v1\./); // cifrado no banco
        const stats = await call("GET", `/api/sessions/${sessionId}/stats`);
        expect(stats.body.cap.today).toBe(50); // aquecimento: número novo começa em 50/dia
    });

    it("fluxo: rascunho com revisão (409), publicar valida, simulador conversa", async () => {
        const c = await call("POST", `/api/sessions/${sessionId}/flows`, { name: "Boas-vindas" });
        flowId = c.body.id;
        expect(c.body.draftRevision).toBe(0);
        // publicar vazio = erro
        const p0 = await call("POST", `/api/flows/${flowId}/publish`);
        expect(p0.status).toBe(422);
        const graph = {
            nodes: [
                { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
                { id: "m", type: "menu", position: { x: 0, y: 0 }, data: { mode: "interactive", question: "Oi {primeiro-nome}! Escolha:", invalidText: "Inválido", maxErrors: 0, options: [{ id: "a", text: "Preço" }, { id: "b", text: "Suporte" }], expireValue: 1, expireUnit: "hours" } },
                { id: "ra", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "t", kind: "text", text: "Custa R$ 10" }] } },
                { id: "rb", type: "action", position: { x: 0, y: 0 }, data: { actions: [{ id: "x", type: "setField", fieldKey: "precisa", fieldScope: "CONTACT", value: "suporte" }] } },
            ],
            edges: [
                { id: "1", source: "start", sourceHandle: "next", target: "m" },
                { id: "2", source: "m", sourceHandle: "option:a", target: "ra" },
                { id: "3", source: "m", sourceHandle: "option:b", target: "rb" },
            ],
        };
        const triggers = [{ id: "t1", type: "keyword", match: "word", value: "oi, olá", priority: 1 }];
        const s1 = await call("PUT", `/api/flows/${flowId}/draft`, { graph, triggers, revision: 0 });
        expect(s1.body.revision).toBe(1);
        const stale = await call("PUT", `/api/flows/${flowId}/draft`, { graph, triggers, revision: 0 });
        expect(stale.status).toBe(409);
        expect(stale.body.revision).toBe(1);

        const sim1 = await call("POST", `/api/flows/${flowId}/simulate`, { text: "olá, tudo bem?" });
        expect(sim1.body.result).toBe("started");
        expect(sim1.body.messages[0]).toMatchObject({ kind: "menu", text: "Oi Admin! Escolha:", mode: "interactive" });
        const sim2 = await call("POST", `/api/flows/${flowId}/simulate`, { optionId: "b" });
        expect(sim2.body.fields.precisa).toBe("suporte");
        expect(sim2.body.run.status).toBe("completed");
        const reset = await call("POST", `/api/flows/${flowId}/simulate`, { reset: true });
        expect(reset.body.result).toBe("reset");
        const sim3 = await call("POST", `/api/flows/${flowId}/simulate`, { text: "bom dia" });
        expect(sim3.body.result).toBe("no-trigger");

        const pub = await call("POST", `/api/flows/${flowId}/publish`);
        expect(pub.status).toBe(200);
        expect(pub.body.version).toBe(1);
        const list = await call("GET", `/api/sessions/${sessionId}/flows`);
        expect(list.body[0]).toMatchObject({ status: "active", hasUnpublishedChanges: false, publishedVersion: 1 });
        const exp = await call("GET", `/api/flows/${flowId}/export`);
        const imp = await call("POST", `/api/sessions/${sessionId}/flows/import`, { ...exp.body, name: "Importado" });
        expect(imp.body.name).toBe("Importado");
    });

    it("importa grafo do MarcFlow (enquete vira menu interativo, autoOff sai)", async () => {
        const r = await call("POST", `/api/sessions/${sessionId}/flows/import`, {
            name: "Do MarcFlow",
            graph: {
                nodes: [
                    { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} },
                    { id: "c", type: "content", position: { x: 0, y: 0 }, data: { items: [{ id: "o", kind: "autoOff", seconds: 60 }, { id: "t", kind: "text", text: "oi" }] } },
                    { id: "m", type: "menu", position: { x: 0, y: 0 }, data: { mode: "poll", question: "?", invalidText: "", maxErrors: 0, options: [], expireValue: 1, expireUnit: "days" } },
                ],
                edges: [],
            },
            triggers: [{ type: "KEYWORD", keyword: "promo", matchType: "CONTAINS", priority: 2 }],
        });
        expect(r.status).toBe(200);
        expect(r.body.draftGraph.nodes[1].data.items).toHaveLength(1);
        expect(r.body.draftGraph.nodes[2].data.mode).toBe("interactive");
        expect(r.body.draftTriggers[0]).toMatchObject({ type: "keyword", match: "contains", value: "promo", priority: 2 });
        expect(r.body.importWarnings.length).toBeGreaterThan(0);
    });

    it("transmissão: normaliza números, ignora inválidos e repetidos, pausa e cancela", async () => {
        const r = await call("POST", `/api/sessions/${sessionId}/broadcasts`, {
            name: "Promo", text: "Olá {nome}",
            recipients: [{ phone: "(11) 98888-7777", vars: { nome: "Ana" } }, { phone: "11988887777" }, { phone: "abc" }],
        });
        expect(r.status).toBe(200);
        expect(r.body.total).toBe(1);
        expect(r.body.invalidNumbers).toBe(1);
        const id = r.body.id;
        const [job] = await h.sql`select kind, payload from jobs where kind = 'broadcast.start'`;
        expect(job.payload.broadcastId).toBe(id);
        expect((await call("POST", `/api/broadcasts/${id}/pause`)).status).toBe(200);
        expect((await call("GET", `/api/broadcasts/${id}`)).body.status).toBe("paused");
        expect((await call("POST", `/api/broadcasts/${id}/cancel`)).status).toBe(200);
        expect((await call("POST", `/api/broadcasts/${id}/cancel`)).status).toBe(422);
    });

    it("webhook: recusa URL interna e não devolve o segredo depois de criar", async () => {
        const bad = await call("POST", "/api/webhooks", { url: "http://127.0.0.1:9999/x", events: ["message.received"] });
        expect(bad.status).toBe(400);
        const ok = await call("POST", "/api/webhooks", { url: "https://example.com/hook", events: ["message.received"] });
        expect(ok.status).toBe(200);
        expect(ok.body.secret).toMatch(/^whsec_/);
        const list = await call("GET", "/api/webhooks");
        expect(JSON.stringify(list.body)).not.toContain("whsec_");
    });

    it("chave de API: mostrada uma vez, guardada como hash, dá acesso à API pública", async () => {
        const k = await call("POST", "/api/api-keys", { name: "integração" });
        expect(k.body.key).toMatch(/^az_/);
        const [row] = await h.sql`select key_hash from api_keys`;
        expect(row.key_hash).not.toContain(k.body.key);
        const saved = cookie;
        cookie = "";
        const r = await call("POST", `/api/v1/sessions/${sessionId}/messages`, { to: "11977776666", text: "Pedido aprovado" }, { "x-api-key": k.body.key });
        expect(r.status).toBe(200);
        const [o] = await h.sql`select jid, source, priority from outbox where id = ${r.body.outboxId}`;
        expect(o).toMatchObject({ jid: "5511977776666@s.whatsapp.net", source: "api", priority: 1 });
        expect((await call("GET", "/api/sessions", undefined, { "x-api-key": "az_errada" })).status).toBe(401);
        cookie = saved;
    });

    it("inbox: atendente responde → fila + pausa por atendimento humano", async () => {
        const [c] = await h.sql`select id from chats where jid = '5511977776666@s.whatsapp.net'`;
        const r = await call("POST", `/api/chats/${c.id}/messages`, { text: "Oi, sou a Joana" });
        expect(r.status).toBe(200);
        const jobs = await h.sql`select payload from jobs where kind = 'contact.takeover'`;
        expect(jobs).toHaveLength(1);
        const chats = await call("GET", `/api/sessions/${sessionId}/chats?search=97777`);
        expect(chats.status).toBe(200);
        const msgs = await call("GET", `/api/chats/${c.id}/messages`);
        expect(msgs.body.items[0]).toMatchObject({ body: "Oi, sou a Joana", status: "queued", sender: "agent", fromMe: true });
        expect((await call("GET", `/api/chats/${c.id}`)).body.id).toBe(c.id);
    });

    it("webhook da Meta: só aceita assinatura correta", async () => {
        const [s] = await h.sql`select id from sessions where provider = 'cloud'`;
        const body = JSON.stringify({ entry: [] });
        const good = "sha256=" + crypto.createHmac("sha256", "app-secret-abc").update(body).digest("hex");
        const bad = await app.inject({ method: "POST", url: `/hooks/meta/${s.id}`, payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" } });
        expect(bad.statusCode).toBe(401);
        const ok = await app.inject({ method: "POST", url: `/hooks/meta/${s.id}`, payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": good } });
        expect(ok.statusCode).toBe(200);
        const [cfg] = await h.sql`select cloud_config from sessions where id = ${s.id}`;
        const verify = await app.inject({ method: "GET", url: `/hooks/meta/${s.id}?hub.mode=subscribe&hub.verify_token=${cfg.cloud_config.verifyToken}&hub.challenge=123` });
        expect(verify.body).toBe("123");
    });

    it("DELETE com content-type json e corpo vazio funciona", async () => {
        const s = await call("POST", "/api/sessions", { name: "apagar" });
        const r = await app.inject({ method: "DELETE", url: `/api/sessions/${s.body.id}`, headers: { cookie, "content-type": "application/json" } });
        expect(r.statusCode).toBe(200);
        const bad = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{x" });
        expect(bad.statusCode).toBe(400);
    });

    it("rota de membro não apaga sessão; arquivo HTML vira download", async () => {
        const up = await app.inject({
            method: "POST", url: `/api/sessions/${sessionId}/assets`, headers: { cookie, "content-type": "multipart/form-data; boundary=X" },
            payload: `--X\r\nContent-Disposition: form-data; name="file"; filename="a.html"\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>\r\n--X--\r\n`,
        });
        expect(up.statusCode).toBe(200);
        const asset = JSON.parse(up.body);
        expect(asset.mime).toBe("application/octet-stream");
        const file = await app.inject({ method: "GET", url: asset.url, headers: { cookie } });
        expect(file.headers["content-disposition"]).toContain("attachment");
        expect(file.headers["x-content-type-options"]).toBe("nosniff");
    });
});
