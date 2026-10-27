import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { sha256 } from "@areszap/db";
import { HttpError } from "./http";

export interface AuthUser { id: string; email: string; name: string; role: "admin" | "member"; via: "cookie" | "key" }

declare module "fastify" {
    interface FastifyRequest { user: AuthUser | null }
}

export const COOKIE = "az_session";
const TTL_S = 7 * 24 * 3600;

function secretKey() {
    const s = process.env.APP_SECRET;
    if (!s || s.length < 32) throw new Error("APP_SECRET ausente ou curto (mínimo 32 caracteres)");
    return new TextEncoder().encode(crypto.createHash("sha256").update("areszap:jwt:" + s).digest("hex"));
}

export async function issueSession(reply: FastifyReply, userId: string) {
    const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId)
        .setIssuedAt().setExpirationTime(`${TTL_S}s`).sign(secretKey());
    reply.setCookie(COOKIE, token, {
        httpOnly: true, sameSite: "lax", path: "/", maxAge: TTL_S,
        secure: process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "0",
    });
}

export function clearSession(reply: FastifyReply) {
    reply.clearCookie(COOKIE, { path: "/" });
}

/** Chave de API: 32 bytes aleatórios (crypto), guardada como sha256. O MarcFlow usava Math.random e texto puro. */
export function newApiKey() {
    const key = "az_" + crypto.randomBytes(32).toString("base64url");
    return { key, prefix: key.slice(0, 10), hash: sha256(key) };
}

export function registerAuth(app: FastifyInstance) {
    app.decorateRequest("user", null);
    app.addHook("onRequest", async req => {
        req.user = await resolveUser(app, req);
    });
}

export async function resolveUser(app: FastifyInstance, req: FastifyRequest): Promise<AuthUser | null> {
    const sql = app.sql;
    const key = (req.headers["x-api-key"] as string | undefined) ?? (req.url.startsWith("/ws") ? new URL(req.url, "http://x").searchParams.get("key") ?? undefined : undefined);
    if (key) {
        const [row] = await sql`
            update api_keys k set last_used_at = now() from users u
            where k.key_hash = ${sha256(key)} and u.id = k.user_id
            returning u.id, u.email, u.name, u.role`;
        return row ? { id: row.id, email: row.email, name: row.name, role: row.role, via: "key" } : null;
    }
    const token = req.cookies?.[COOKIE];
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, secretKey());
        const [u] = await sql`select id, email, name, role from users where id = ${payload.sub!}`;
        return u ? { id: u.id, email: u.email, name: u.name, role: u.role, via: "cookie" } : null;
    } catch {
        return null;
    }
}

export function requireUser(req: FastifyRequest): AuthUser {
    if (!req.user) throw new HttpError(401, "Faça login");
    return req.user;
}

export function requireAdmin(req: FastifyRequest): AuthUser {
    const u = requireUser(req);
    if (u.role !== "admin") throw new HttpError(403, "Só administradores podem fazer isso");
    return u;
}
