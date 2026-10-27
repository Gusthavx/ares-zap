const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const timeOnly = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" });
const longDay = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const num = new Intl.NumberFormat("pt-BR");

export const fmtNum = (n: number | null | undefined) => num.format(n ?? 0);

export function fmtDateTime(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

export function fmtTime(iso: string): string {
    return timeOnly.format(new Date(iso));
}

/** Hora se for hoje, "ontem", ou dia/mês. */
export function fmtShort(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return timeOnly.format(d);
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "ontem";
    return dayMonth.format(d);
}

export function fmtDay(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return "Hoje";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Ontem";
    const s = longDay.format(d);
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "em 12 min", "há 3 h". */
export function fmtRelative(iso: string | null | undefined): string {
    if (!iso) return "—";
    const diff = new Date(iso).getTime() - Date.now();
    const abs = Math.abs(diff);
    const min = Math.round(abs / 60_000);
    let s: string;
    if (min < 1) s = "menos de 1 min";
    else if (min < 60) s = `${min} min`;
    else if (min < 60 * 24) { const h = Math.floor(min / 60), m = min % 60; s = m && h < 10 ? `${h} h ${m} min` : `${h} h`; }
    else s = `${Math.round(min / 1440)} dia${Math.round(min / 1440) > 1 ? "s" : ""}`;
    return diff >= 0 ? `em ${s}` : `há ${s}`;
}

export function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export const isFuture = (iso: string | null | undefined) => !!iso && new Date(iso).getTime() > Date.now();

/** Valor para <input type="datetime-local"> a partir de ISO (hora local do navegador). */
export function toLocalInput(iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function plural(n: number, one: string, many: string) {
    return `${fmtNum(n)} ${n === 1 ? one : many}`;
}
