import type { FastifyPluginAsync } from "fastify";
import { deleteAsset, readAsset, saveAsset } from "@areszap/db";
import { requireUser } from "../auth";
import { HttpError, idParam, notFound, parse } from "../http";

const assetDto = (r: { id: string; fileName: string; mime: string; size: number; createdAt: Date }) =>
    ({ id: r.id, fileName: r.fileName, mime: r.mime, size: r.size, createdAt: r.createdAt, url: `/api/assets/${r.id}/file` });

/** Só imagem, áudio, vídeo e PDF abrem no navegador; o resto vira download (evita HTML/SVG executando no domínio do painel). */
const INLINE = /^(image\/(jpeg|png|gif|webp)|audio\/|video\/|application\/pdf)/;

const routes: FastifyPluginAsync = async app => {
    const sql = app.sql;

    app.get("/sessions/:id/assets", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const rows = await sql`select id, file_name, mime, size, created_at from assets where session_id = ${id} and origin = 'upload' order by created_at desc limit 500`;
        return rows.map(r => assetDto({ id: r.id, fileName: r.file_name, mime: r.mime, size: r.size, createdAt: r.created_at }));
    });

    app.post("/sessions/:id/assets", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const [s] = await sql`select id from sessions where id = ${id}`;
        if (!s) throw notFound("Sessão");
        const file = await req.file();
        if (!file) throw new HttpError(400, "Envie um arquivo no campo file");
        const buffer = await file.toBuffer();
        if (!buffer.length) throw new HttpError(400, "Arquivo vazio");
        const a = await saveAsset(sql, { sessionId: id, buffer, fileName: file.filename, mime: file.mimetype, origin: "upload" });
        return assetDto(a);
    });

    app.get("/assets/:id/file", async (req, reply) => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        const a = await readAsset(sql, id);
        if (!a) throw notFound("Arquivo");
        const inline = INLINE.test(a.row.mime);
        reply.header("content-type", a.row.mime);
        reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.row.fileName)}`);
        reply.header("cache-control", "private, max-age=86400");
        reply.header("content-security-policy", "default-src 'none'; sandbox");
        return reply.send(a.buffer);
    });

    app.delete("/assets/:id", async req => {
        requireUser(req);
        const { id } = parse(idParam, req.params);
        if (!(await deleteAsset(sql, id))) throw notFound("Arquivo");
        return { ok: true };
    });
};

export default routes;
