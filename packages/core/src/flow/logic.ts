// Funções puras do motor. Sem E/S, para ficarem testáveis.
// Portado do MarcFlow (MIT, Marcos Maia) — src/modules/flows/logic.ts — sem moment/moment-timezone.
import type { AnswerType, ConditionData, FlowCondition, FlowTrigger, MenuOption, RandomizerOption, TimeUnit } from "./types";
import { MAX_REGEX_LENGTH } from "./validate";

export const unitMs: Record<TimeUnit, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Texto sem acento reduzido a palavras separadas por um espaço: pontuação e emoji viram separador. */
const words = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Verdadeiro quando `text` contém alguma das palavras/frases (separadas por vírgula) como palavra inteira.
 * "*" no fim casa prefixo ("reembols*" → reembolso, reembolsar). "Foi" nunca casa "oi".
 */
export function containsAnyPhrase(text: string, list: string): boolean {
    const t = ` ${words(text)} `;
    return list.split(",").some(raw => {
        const prefix = raw.trim().endsWith("*");
        const p = words(raw);
        return !!p && (prefix ? t.includes(` ${p}`) : t.includes(` ${p} `));
    });
}

/** "{primeiro-nome}" -> valor; chave desconhecida vira vazio. Mesma sintaxe em fluxo, transmissão e API. */
export function renderTemplate(text: string, vars: Record<string, string | undefined>): string {
    return text.replace(/\{([\w\-.À-ÿ]+)\}/g, (_, k: string) => vars[k] ?? "");
}

/** Aceita "2", "2.", "2)", o texto da opção (sem acento/maiúscula) ou o id da opção (resposta interativa). */
export function matchMenuOption(input: string, options: MenuOption[], optionId?: string | null): MenuOption | null {
    if (optionId) {
        const byId = options.find(o => o.id === optionId || `option:${o.id}` === optionId);
        if (byId) return byId;
    }
    const raw = input.trim().replace(/[.)]$/, "");
    if (/^\d+$/.test(raw)) return options[Number(raw) - 1] ?? null;
    const f = fold(input);
    return options.find(o => fold(o.text) === f) ?? null;
}

export function menuText(question: string, options: MenuOption[]): string {
    return `${question}\n\n${options.map((o, i) => `${i + 1}. ${o.text}`).join("\n")}`;
}

function validCpf(v: string): boolean {
    const d = v.replace(/\D/g, "");
    if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
    const calc = (len: number) => {
        let sum = 0;
        for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
        const r = (sum * 10) % 11;
        return r === 10 ? 0 : r;
    };
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function parseBrDate(v: string, withTime: boolean): string | null {
    const m = v.trim().match(withTime
        ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,T]+(\d{1,2}):(\d{2})$/
        : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const [dd, mm, yyyy] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (dt.getUTCDate() !== dd || dt.getUTCMonth() !== mm - 1) return null;
    const date = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    if (!withTime) return date;
    const [h, mi] = [Number(m[4]), Number(m[5])];
    if (h > 23 || mi > 59) return null;
    return `${date} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export type IncomingType = "text" | "image" | "video" | "audio" | "document" | "sticker" | "location" | "contact" | "poll" | "interactive" | "other";
export interface IncomingAnswer { text: string; type: IncomingType; mediaRef?: string | null }

/** Valor a gravar, ou null quando a resposta não serve para o tipo esperado. */
export function validateAnswer(type: AnswerType, a: IncomingAnswer): string | null {
    const t = a.text.trim();
    switch (type) {
        case "text": return t || null;
        case "number": {
            const n = t.replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
            return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
        }
        case "date": return parseBrDate(t, false);
        case "datetime": return parseBrDate(t, true);
        case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) ? t.toLowerCase() : null;
        case "cpf": return validCpf(t) ? t.replace(/\D/g, "") : null;
        case "firstName": return t ? t.split(/\s+/)[0] : null;
        case "lastName": { const p = t.split(/\s+/); return p.length > 1 ? p.slice(1).join(" ") : (t || null); }
        case "fullName": return t || null;
        case "image": return a.type === "image" ? (a.mediaRef || "imagem") : null;
        case "video": return a.type === "video" ? (a.mediaRef || "vídeo") : null;
        case "audio": return a.type === "audio" ? (a.mediaRef || "áudio") : null;
        case "file": return a.type === "document" ? (a.mediaRef || "arquivo") : null;
    }
}

export interface ConditionContext {
    tagIds: string[];
    weekday: number;   // 0 = domingo, no fuso da sessão
    minutes: number;   // minutos desde meia-noite, no fuso da sessão
    today: string;     // AAAA-MM-DD, no fuso da sessão
    fields: Record<string, string | undefined>;
}

function toMinutes(hhmm: string): number {
    const [h, m] = hhmm.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}

export function evalCondition(c: FlowCondition, ctx: ConditionContext): boolean {
    switch (c.source) {
        case "tag": {
            const has = ctx.tagIds.includes(c.value);
            return c.op === "isNot" ? !has : has;
        }
        case "weekday": {
            const same = ctx.weekday === Number(c.value);
            return c.op === "isNot" ? !same : same;
        }
        case "time": {
            const v = toMinutes(c.value);
            return c.op === "before" ? ctx.minutes < v : ctx.minutes >= v;
        }
        case "field": {
            const raw = ctx.fields[c.fieldKey || ""];
            const val = raw == null ? "" : String(raw);
            if (c.op === "hasValue") return val.trim() !== "";
            if (c.fieldType === "NUMBER") {
                const a = Number(val.replace(",", ".")), b = Number(String(c.value).replace(",", "."));
                if (val.trim() === "" || isNaN(a) || isNaN(b)) return c.op === "neq";
                const r: Partial<Record<FlowCondition["op"], boolean>> = { gt: a > b, gte: a >= b, lt: a < b, lte: a <= b, eq: a === b, neq: a !== b };
                return r[c.op] ?? false;
            }
            if (c.fieldType === "DATE" || c.fieldType === "DATETIME") {
                const d = val.slice(0, 10), ref = String(c.value).slice(0, 10);
                if (!d) return false;
                return c.op === "after" ? d > ref : c.op === "before" ? d < ref : d === ref;
            }
            const a = fold(val), b = fold(String(c.value));
            switch (c.op) {
                case "is": return a === b;
                case "isNot": return a !== b;
                case "contains": return a.includes(b);
                case "notContains": return !a.includes(b);
                case "startsWith": return a.startsWith(b);
                case "containsAny": return containsAnyPhrase(val, String(c.value));
                default: return false;
            }
        }
    }
}

export function evalConditions(d: ConditionData, ctx: ConditionContext): boolean {
    if (!d.conditions.length) return false;
    return d.logic === "and" ? d.conditions.every(c => evalCondition(c, ctx)) : d.conditions.some(c => evalCondition(c, ctx));
}

/** Sorteio por peso; `rand` em [0,1). */
export function pickWeighted(options: RandomizerOption[], rand: number): RandomizerOption | null {
    if (!options.length) return null;
    const total = options.reduce((s, o) => s + Math.max(0, Number(o.weight) || 0), 0);
    if (total <= 0) return options[Math.floor(rand * options.length)];
    let x = rand * total;
    for (const o of options) {
        x -= Math.max(0, Number(o.weight) || 0);
        if (x < 0) return o;
    }
    return options[options.length - 1];
}

/** Regex compilada uma vez por padrão (cache), com limite de tamanho do padrão e do texto testado. */
const regexCache = new Map<string, RegExp | null>();
function compiled(pattern: string): RegExp | null {
    if (pattern.length > MAX_REGEX_LENGTH) return null;
    if (!regexCache.has(pattern)) {
        let re: RegExp | null = null;
        try { re = new RegExp(pattern, "i"); } catch { re = null; }
        if (regexCache.size > 1000) regexCache.clear();
        regexCache.set(pattern, re);
    }
    return regexCache.get(pattern)!;
}

export function matchKeyword(text: string, keyword: string, match: FlowTrigger["match"] = "exact"): boolean {
    if (!keyword) return false;
    if (match === "regex") return compiled(keyword)?.test(text.slice(0, 1000)) ?? false;
    if (match === "word") return containsAnyPhrase(text, keyword);
    const a = fold(text), b = fold(keyword);
    return match === "contains" ? a.includes(b) : a === b;
}

/**
 * Escolhe o gatilho que dispara: palavra-chave de maior prioridade; senão primeira mensagem (se for o 1º contato);
 * senão qualquer mensagem. Devolve o índice do item em `entries`.
 */
export function pickTrigger<T extends { trigger: FlowTrigger }>(entries: T[], text: string, isFirstContact: boolean): T | null {
    const best = (list: T[]) => list.sort((a, b) => b.trigger.priority - a.trigger.priority)[0] ?? null;
    const kw = entries.filter(e => e.trigger.type === "keyword" && matchKeyword(text, e.trigger.value || "", e.trigger.match));
    if (kw.length) return best(kw);
    if (isFirstContact) {
        const first = entries.filter(e => e.trigger.type === "firstMessage");
        if (first.length) return best(first);
    }
    return best(entries.filter(e => e.trigger.type === "anyMessage"));
}

// ---------- fuso horário sem dependências ----------
const dtf = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
    let f = dtf.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat("en-US", {
            timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        });
        dtf.set(tz, f);
    }
    return f;
}

/** Partes do relógio de `date` no fuso `tz`. */
export function zonedParts(date: Date, tz: string): { weekday: number; minutes: number; today: string; hhmm: string } {
    const p = Object.fromEntries(formatter(tz).formatToParts(date).map(x => [x.type, x.value]));
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    return { weekday, minutes: Number(p.hour) * 60 + Number(p.minute), today: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

function offsetMs(date: Date, tz: string): number {
    const p = Object.fromEntries(formatter(tz).formatToParts(date).map(x => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** "AAAA-MM-DDTHH:mm" no fuso `tz` → instante UTC. Inválido → null. */
export function zonedToDate(local: string, tz: string): Date | null {
    const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
    if (!m) return null;
    const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    // duas passadas resolvem a virada de horário de verão
    let t = guess - offsetMs(new Date(guess), tz);
    t = guess - offsetMs(new Date(t), tz);
    return new Date(t);
}

export function formatZoned(date: Date, tz: string): string {
    const z = zonedParts(date, tz);
    return `${z.today} ${z.hhmm}`;
}
