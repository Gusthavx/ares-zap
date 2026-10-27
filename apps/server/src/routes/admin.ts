import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { newApiKey, requireAdmin, requireUser } from "../auth";
import { HttpError, idParam, notFound, parse } from "../http";

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    // ---------- chaves de API (cada usuário vê as suas) ----------
    app.get("/api-keys", async req => {
        const u = requireUser(req);
        const rows = await sql`select id, name, prefix, last_used_at, created_at from api_keys where user_id = ${u.id} order by created_at desc`;
        return rows.map(r => ({ id: r.id, name: r.name, prefix: r.prefix, lastUsedAt: r.last_used_at, createdAt: r.created_at }));
    });

    app.post("/api-keys", async req => {
        const u = requireUser(req);
        if (u.via === "key") throw new HttpError(403, "Crie chaves pelo painel");
        const b = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
        const k = newApiKey();
        const [r] = await sql`insert into api_keys (user_id, name, prefix, key_hash) values (${u.id}, ${b.name}, ${k.prefix}, ${k.hash}) returning id, created_at`;
        return { id: r.id, name: b.name, prefix: k.prefix, lastUsedAt: null, createdAt: r.created_at, key: k.key };
    });

    app.delete("/api-keys/:id", async req => {
        const u = requireUser(req);
        const { id } = parse(idParam, req.params);
        const r = await sql`delete from api_keys where id = ${id} and user_id = ${u.id} returning id`;
        if (!r.length) throw notFound("Chave");
        return { ok: true };
    });

    // ---------- usuários (cadastro fechado: só o admin cria) ----------
    app.get("/users", async req => {
        requireAdmin(req);
        const rows = await sql`select id, email, name, role, created_at from users order by created_at`;
        return rows.map(r => ({ id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at }));
    });

    app.post("/users", async req => {
        requireAdmin(req);
        const b = parse(z.object({
            email: z.email("E-mail inválido").max(200),
            name: z.string().trim().max(120).default(""),
            password: z.string().min(8, "A senha precisa de pelo menos 8 caracteres").max(200),
            role: z.enum(["admin", "member"]).default("member"),
        }), req.body);
        const [r] = await sql`
            insert into users (email, name, password_hash, role) values (${b.email.toLowerCase()}, ${b.name}, ${await bcrypt.hash(b.password, 12)}, ${b.role})
            returning id, email, name, role, created_at`;
        return { id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at };
    });

    app.delete("/users/:id", async req => {
        const me = requireAdmin(req);
        const { id } = parse(idParam, req.params);
        if (id === me.id) throw new HttpError(422, "Você não pode apagar a si mesmo");
        const r = await sql`delete from users where id = ${id} returning id`;
        if (!r.length) throw notFound("Usuário");
        return { ok: true };
    });
};

export default routes;
