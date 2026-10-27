import crypto from "node:crypto";

/** Cifra segredos guardados no banco (token da API oficial, app secret) com AES-256-GCM derivado do APP_SECRET. */
function key(): Buffer {
    const secret = process.env.APP_SECRET;
    if (!secret || secret.length < 32) throw new Error("APP_SECRET ausente ou curto (mínimo 32 caracteres)");
    return crypto.createHash("sha256").update("areszap:secrets:" + secret).digest();
}

export function sealSecret(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function openSecret(sealed: string | undefined | null): string | null {
    if (!sealed) return null;
    const [v, iv, tag, enc] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !enc) return null;
    try {
        const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
        d.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
    } catch {
        return null;
    }
}

export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
