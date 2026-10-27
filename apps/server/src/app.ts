import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type postgres from "postgres";
import { onEvents, sendCommand } from "@areszap/db";
import type { BusEvent, WorkerCommand } from "@areszap/core";
import { registerAuth, resolveUser } from "./auth";
import { HttpError, sendError } from "./http";
import { SimulatorPool } from "./sim";
import authRoutes from "./routes/auth";
import sessionRoutes from "./routes/sessions";
import chatRoutes from "./routes/chats";
import contactRoutes from "./routes/contacts";
import flowRoutes from "./routes/flows";
import assetRoutes from "./routes/assets";
import broadcastRoutes from "./routes/broadcasts";
import webhookRoutes from "./routes/webhooks";
import adminRoutes from "./routes/admin";
import publicRoutes from "./routes/public";
import metaRoutes from "./routes/meta";

declare module "fastify" {
    interface FastifyInstance {
        sql: postgres.Sql;
        command: (c: WorkerCommand) => Promise<void>;
        /** Último QR de cada sessão (vem do worker por evento). */
        qr: Map<string, string>;
        sims: SimulatorPool;
    }
}

export async function buildApp(sql: postgres.Sql, opts: { webDir?: string; logger?: boolean } = {}): Promise<FastifyInstance> {
    const app = Fastify({
        logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" },
        trustProxy: process.env.TRUST_PROXY === "1",
        bodyLimit: 8 * 1024 * 1024,
    });
    app.decorate("sql", sql);
    app.decorate("command", (c: WorkerCommand) => sendCommand(sql, c));
    app.decorate("qr", new Map<string, string>());
    app.decorate("sims", new SimulatorPool(sql));

    // corpo vazio com content-type json (DELETE/POST de ação) vira undefined em vez de 400
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
        const text = String(body ?? "").trim();
        if (!text) return done(null, undefined);
        try { done(null, JSON.parse(text)); } catch { done(new HttpError(400, "JSON inválido"), undefined); }
    });
    await app.register(cookie);
    await app.register(rateLimit, {
        global: true, max: Number(process.env.RATE_LIMIT_PER_MIN || 600), timeWindow: "1 minute",
        keyGenerator: req => (req.headers["x-api-key"] as string) || req.ip,
    });
    await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });
    await app.register(websocket);
    registerAuth(app);

    app.setErrorHandler((err, req, reply) => sendError(reply, err, req));
    app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api") || req.url.startsWith("/hooks")) return reply.status(404).send({ error: "Rota não encontrada" });
        // SPA: qualquer outra rota devolve o index do painel
        if (opts.webDir && fs.existsSync(path.join(opts.webDir, "index.html"))) return reply.type("text/html").sendFile("index.html");
        return reply.status(404).send({ error: "Painel não compilado (rode npm run build)" });
    });

    // ---------- tempo real ----------
    const clients = new Set<{ send: (s: string) => void; readyState: number }>();
    await onEvents(sql, (e: BusEvent) => {
        if (e.t === "session.status") {
            if (e.qr) app.qr.set(e.sessionId, e.qr);
            else if (e.status !== "qr") app.qr.delete(e.sessionId);
        }
        const msg = JSON.stringify(e);
        for (const c of clients) if (c.readyState === 1) c.send(msg);
    });
    app.get("/ws", { websocket: true }, async (socket, req) => {
        // o MarcFlow deixava o Socket.IO sem login (qualquer um via QR e mensagens); aqui só entra autenticado
        const user = req.user ?? await resolveUser(app, req);
        if (!user) { socket.close(4401, "login necessário"); return; }
        clients.add(socket);
        socket.on("close", () => clients.delete(socket));
        socket.on("message", (raw: unknown) => { if (String(raw) === "ping") socket.send("pong"); });
    });

    await app.register(async api => {
        await api.register(authRoutes, { prefix: "/auth" });
        await api.register(sessionRoutes);
        await api.register(chatRoutes);
        await api.register(contactRoutes);
        await api.register(flowRoutes);
        await api.register(assetRoutes);
        await api.register(broadcastRoutes);
        await api.register(webhookRoutes);
        await api.register(adminRoutes);
        await api.register(publicRoutes, { prefix: "/v1" });
        api.get("/health", async () => {
            const [db] = await sql`select 1 as ok`.catch(() => [null]);
            const [hb] = await sql`select at from heartbeats where name = 'worker'`.catch(() => [null]);
            const alive = !!hb && Date.now() - new Date(hb.at).getTime() < 30_000;
            return { ok: !!db && alive, db: !!db, worker: { alive, lastBeatAt: hb?.at ?? null } };
        });
    }, { prefix: "/api" });
    await app.register(metaRoutes, { prefix: "/hooks" });

    if (opts.webDir && fs.existsSync(opts.webDir)) {
        await app.register(fastifyStatic, { root: opts.webDir, prefix: "/", wildcard: false, index: ["index.html"] });
    }

    app.addHook("onSend", async (_req, reply, payload) => {
        reply.header("x-content-type-options", "nosniff");
        reply.header("referrer-policy", "same-origin");
        return payload;
    });

    return app;
}

export { HttpError };
