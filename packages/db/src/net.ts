import dns from "node:dns/promises";
import net from "node:net";

/** Faixas que um webhook ou uma mídia por URL nunca pode atingir (rede interna, metadados de nuvem, loopback). */
function isPrivateIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split(".").map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

/**
 * Confere se a URL é http(s) pública. Resolve o DNS e recusa IP privado (proteção contra SSRF).
 * `ALLOW_PRIVATE_URLS=1` libera (só para testes locais).
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("URL inválida"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use uma URL http ou https");
    if (url.username || url.password) throw new Error("URL com usuário/senha não é aceita");
    if (process.env.ALLOW_PRIVATE_URLS === "1") return url;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    if (!addrs.length || addrs.some(isPrivateIp)) throw new Error("URL aponta para rede interna");
    return url;
}

/** fetch com tempo limite, sem seguir redirecionamento (um redirect poderia levar para a rede interna). */
export async function safeFetch(raw: string, init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {}) {
    const url = await assertPublicUrl(raw);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
    try {
        return await fetch(url, { ...init, redirect: "manual", signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

/** Baixa o corpo inteiro com limite de tamanho. */
export async function fetchBuffer(raw: string, maxBytes = 64 * 1024 * 1024): Promise<{ buffer: Buffer; mime: string }> {
    const res = await safeFetch(raw, { timeoutMs: 30_000 });
    if (!res.ok) throw new Error(`Download falhou (${res.status})`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > maxBytes) throw new Error("Arquivo grande demais");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error("Arquivo grande demais");
    return { buffer: buf, mime: res.headers.get("content-type")?.split(";")[0] || "application/octet-stream" };
}
