import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export class HttpError extends Error {
    constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export const notFound = (what = "Registro") => new HttpError(404, `${what} não encontrado`);

/** Valida com zod e devolve 400 com a primeira mensagem legível. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
    const r = schema.safeParse(data ?? {});
    if (r.success) return r.data;
    const first = r.error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    throw new HttpError(400, `${where}${first?.message ?? "dados inválidos"}`, { issues: r.error.issues.slice(0, 10) });
}

export const uuid = z.uuid({ message: "id inválido" });
export const idParam = z.object({ id: uuid });

export function sendError(reply: FastifyReply, err: unknown, req?: FastifyRequest) {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...err.extra });
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: traduz(e) });
    // erro de banco por FK/único: mensagens claras em vez de 500
    if (e.code === "23505") return reply.status(409).send({ error: "Já existe um registro com esses dados" });
    if (e.code === "23503") return reply.status(422).send({ error: "Registro relacionado não existe" });
    if (e.code === "22P02") return reply.status(400).send({ error: "Valor em formato inválido" });
    req?.log.error({ err }, "erro interno");
    return reply.status(500).send({ error: "Erro interno" });
}

function traduz(e: { statusCode?: number; message?: string; code?: string }) {
    if (e.code === "FST_REQ_FILE_TOO_LARGE") return "Arquivo grande demais";
    if (e.statusCode === 429) return "Muitas tentativas. Espere um pouco e tente de novo";
    if (e.statusCode === 415) return "Tipo de conteúdo não suportado";
    return e.message || "Requisição inválida";
}
