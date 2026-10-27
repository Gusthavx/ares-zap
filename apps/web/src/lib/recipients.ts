// Lê números colados ou CSV e devolve destinatários {phone, vars} para a transmissão.
import { normalizePhone } from "@areszap/core";

export interface ParsedRecipients {
    recipients: { phone: string; vars?: Record<string, string> }[];
    invalid: { line: number; text: string }[];
    duplicates: number;
    columns: string[];
    hasHeader: boolean;
}

export const MAX_RECIPIENTS = 50_000;

const PHONE_HEADERS = ["telefone", "phone", "numero", "número", "celular", "whatsapp", "fone", "tel", "contato", "number", "mobile"];

function detectDelimiter(lines: string[]): string {
    const sample = lines.slice(0, 20);
    let best = "", bestScore = 0;
    for (const d of [";", ",", "\t", "|"]) {
        const counts = sample.map(l => splitLine(l, d).length);
        const score = counts.filter(c => c > 1).length;
        if (score > bestScore) { best = d; bestScore = score; }
    }
    return best;
}

/** Divide uma linha respeitando aspas ("a;b" fica junto). */
function splitLine(line: string, d: string): string[] {
    if (!d) return [line];
    const out: string[] = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
        } else if (c === d && !quoted) { out.push(cur); cur = ""; }
        else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const looksPhone = (s: string) => s.replace(/\D/g, "").length >= 8 && /^[\d\s()+\-.]+$/.test(s.trim());

/** Nome de variável a partir do cabeçalho: "Primeiro Nome" → "primeiro-nome". */
export function varKey(h: string): string {
    return fold(h).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "coluna";
}

export function parseRecipients(text: string, defaultCountryCode = "55"): ParsedRecipients {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const empty: ParsedRecipients = { recipients: [], invalid: [], duplicates: 0, columns: [], hasHeader: false };
    if (!lines.length) return empty;

    const d = detectDelimiter(lines);
    const rows = lines.map(l => splitLine(l, d));
    const first = rows[0];
    const hasHeader = first.some(c => PHONE_HEADERS.includes(fold(c))) || (first.every(c => !looksPhone(c)) && rows.length > 1 && rows.slice(1, 6).some(r => r.some(looksPhone)));

    let phoneCol = 0;
    let columns: string[];
    if (hasHeader) {
        const idx = first.findIndex(c => PHONE_HEADERS.includes(fold(c)));
        phoneCol = idx >= 0 ? idx : Math.max(0, rows[1]?.findIndex(looksPhone) ?? 0);
        columns = first.map(varKey);
    } else {
        phoneCol = Math.max(0, first.findIndex(looksPhone));
        // sem cabeçalho: segunda coluna vira {nome}, as outras {coluna3}, {coluna4}…
        columns = first.map((_, i) => (i === phoneCol ? "telefone" : i === (phoneCol === 0 ? 1 : 0) ? "nome" : `coluna${i + 1}`));
    }

    const seen = new Set<string>();
    const out: ParsedRecipients = { recipients: [], invalid: [], duplicates: 0, columns: columns.filter((_, i) => i !== phoneCol), hasHeader };
    rows.slice(hasHeader ? 1 : 0).forEach((r, i) => {
        const lineNo = i + 1 + (hasHeader ? 1 : 0);
        const phone = normalizePhone(r[phoneCol] ?? "", defaultCountryCode);
        if (!phone) { out.invalid.push({ line: lineNo, text: lines[lineNo - 1] }); return; }
        if (seen.has(phone)) { out.duplicates++; return; }
        seen.add(phone);
        const vars: Record<string, string> = {};
        r.forEach((v, k) => { if (k !== phoneCol && v && columns[k]) vars[columns[k]] = v; });
        out.recipients.push(Object.keys(vars).length ? { phone, vars } : { phone });
    });
    return out;
}
