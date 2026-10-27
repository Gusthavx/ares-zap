import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { enqueueJob, openSecret } from "@areszap/db";

/**
 * Webhook da API oficial (Meta). GET = verificação do token; POST = mensagens e status,
 * com assinatura X-Hub-Signature-256 conferida no corpo bruto antes de enfileirar para o worker.
 */
const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    // corpo bruto só nesta rota, para conferir a assinatura byte a byte
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    const config = async (sessionId: string) => {
        if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
        const [s] = await sql`select cloud_config from sessions where id = ${sessionId} and provider = 'cloud'`;
        return (s?.cloud_config ?? null) as Record<string, string> | null;
    };

    app.get("/meta/:sessionId", async (req, reply) => {
        const { sessionId } = req.params as { sessionId: string };
        const q = req.query as Record<string, string>;
        const cfg = await config(sessionId);
        if (cfg?.verifyToken && q["hub.mode"] === "subscribe" && q["hub.verify_token"] === cfg.verifyToken) {
            return reply.type("text/plain").send(q["hub.challenge"] ?? "");
        }
        return reply.status(403).send({ error: "Token de verificação inválido" });
    });

    app.post("/meta/:sessionId", { config: { rateLimit: { max: 3000, timeWindow: "1 minute" } } }, async (req, reply) => {
        const { sessionId } = req.params as { sessionId: string };
        const cfg = await config(sessionId);
        if (!cfg) return reply.status(404).send({ error: "Sessão não encontrada" });
        const raw = req.body as Buffer;
        const appSecret = openSecret(cfg.appSecret);
        if (!appSecret) return reply.status(403).send({ error: "Configure o app secret da API oficial na sessão" });
        const sig = String(req.headers["x-hub-signature-256"] ?? "");
        const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(raw).digest("hex");
        if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
            return reply.status(401).send({ error: "Assinatura inválida" });
        }
        let body: unknown;
        try { body = JSON.parse(raw.toString("utf8")); } catch { return reply.status(400).send({ error: "JSON inválido" }); }
        await enqueueJob(sql, "cloud.inbound", { sessionId, body }, { maxAttempts: 8 });
        // a Meta só quer 200 rápido; o processamento é do worker
        return reply.send({ ok: true });
    });
};

export default routes;
