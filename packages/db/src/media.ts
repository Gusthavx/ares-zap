import fs from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";
import { sha256 } from "./crypto";

export const dataDir = () => path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));

/** Tipo pelo conteúdo (assinatura dos primeiros bytes). Nunca confiar no nome/extensão enviados. */
export function sniffMime(buf: Buffer, fallback = "application/octet-stream"): string {
    const h = buf.subarray(0, 16);
    const hex = h.toString("hex");
    const ascii = h.toString("latin1");
    if (hex.startsWith("ffd8ff")) return "image/jpeg";
    if (hex.startsWith("89504e47")) return "image/png";
    if (ascii.startsWith("GIF8")) return "image/gif";
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
    if (ascii.slice(4, 8) === "ftyp") {
        const brand = ascii.slice(8, 12);
        return brand.startsWith("M4A") ? "audio/mp4" : brand === "qt  " ? "video/quicktime" : "video/mp4";
    }
    if (ascii.startsWith("OggS")) return "audio/ogg";
    if (ascii.startsWith("ID3") || hex.startsWith("fffb") || hex.startsWith("fff3") || hex.startsWith("fff2")) return "audio/mpeg";
    if (hex.startsWith("1a45dfa3")) return "video/webm";
    if (ascii.startsWith("%PDF")) return "application/pdf";
    if (hex.startsWith("504b0304")) return fallback.includes("officedocument") ? fallback : "application/zip";
    if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return "audio/wav";
    // texto simples (csv/txt) é aceito como arquivo genérico; nunca como html
    return fallback === "text/csv" || fallback === "text/plain" ? fallback : "application/octet-stream";
}

export const mediaKindOf = (mime: string): "image" | "video" | "audio" | "file" =>
    mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

const safeName = (n: string) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 180) || "arquivo";

export interface AssetRow { id: string; sessionId: string; fileName: string; mime: string; size: number; path: string; createdAt: Date }

/** Grava um arquivo da sessão. Mesmo conteúdo na mesma sessão reaproveita o registro existente. */
export async function saveAsset(sql: postgres.Sql, opts: { sessionId: string; buffer: Buffer; fileName: string; mime?: string; origin?: "upload" | "inbound" }): Promise<AssetRow> {
    const hash = sha256(opts.buffer);
    const found = await sql`select * from assets where session_id = ${opts.sessionId} and sha256 = ${hash} limit 1`;
    if (found[0]) return toAsset(found[0]);
    const mime = sniffMime(opts.buffer, opts.mime);
    const id = globalThis.crypto.randomUUID();
    const dir = path.join(dataDir(), "assets", opts.sessionId);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, id);
    await fs.writeFile(file, opts.buffer);
    const rows = await sql`
        insert into assets (id, session_id, file_name, mime, size, sha256, path, origin)
        values (${id}, ${opts.sessionId}, ${safeName(opts.fileName)}, ${mime}, ${opts.buffer.length}, ${hash}, ${file}, ${opts.origin ?? "upload"})
        returning *`;
    return toAsset(rows[0]);
}

export async function readAsset(sql: postgres.Sql, id: string, sessionId?: string): Promise<{ row: AssetRow; buffer: Buffer } | null> {
    const rows = sessionId
        ? await sql`select * from assets where id = ${id} and session_id = ${sessionId}`
        : await sql`select * from assets where id = ${id}`;
    if (!rows[0]) return null;
    const row = toAsset(rows[0]);
    return { row, buffer: await fs.readFile(row.path) };
}

export async function deleteAsset(sql: postgres.Sql, id: string) {
    const rows = await sql`delete from assets where id = ${id} returning path`;
    if (rows[0]) await fs.rm(rows[0].path, { force: true });
    return !!rows[0];
}

function toAsset(r: Record<string, any>): AssetRow {
    return { id: r.id, sessionId: r.session_id, fileName: r.file_name, mime: r.mime, size: r.size, path: r.path, createdAt: r.created_at };
}
