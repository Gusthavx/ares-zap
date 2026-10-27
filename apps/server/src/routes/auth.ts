import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { clearSession, issueSession, requireUser } from "../auth";
import { HttpError, parse } from "../http";

/** Hash de verdade para comparar quando o e-mail não existe (tempo igual nos dois casos). */
const DUMMY_HASH = bcrypt.hashSync("areszap-dummy-password", 10);

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    app.post("/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
        const b = parse(z.object({ email: z.string().trim().min(3), password: z.string().min(1) }), req.body);
        const [u] = await sql`select id, email, name, role, password_hash from users where lower(email) = lower(${b.email})`;
        // compara mesmo sem usuário, para não revelar quais e-mails existem pelo tempo de resposta
        const ok = await bcrypt.compare(b.password, u?.password_hash ?? DUMMY_HASH);
        if (!u || !ok) throw new HttpError(401, "E-mail ou senha incorretos");
        await issueSession(reply, u.id);
        return { user: { id: u.id, email: u.email, name: u.name, role: u.role } };
    });

    app.post("/logout", async (_req, reply) => {
        clearSession(reply);
        return { ok: true };
    });

    app.get("/me", async req => {
        const u = requireUser(req);
        return { user: { id: u.id, email: u.email, name: u.name, role: u.role } };
    });

    app.post("/password", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async req => {
        const u = requireUser(req);
        const b = parse(z.object({ current: z.string().min(1), next: z.string().min(8, "A senha nova precisa de pelo menos 8 caracteres") }), req.body);
        const [row] = await sql`select password_hash from users where id = ${u.id}`;
        if (!row || !(await bcrypt.compare(b.current, row.password_hash))) throw new HttpError(400, "Senha atual incorreta");
        await sql`update users set password_hash = ${await bcrypt.hash(b.next, 12)} where id = ${u.id}`;
        return { ok: true };
    });
};

export default routes;
