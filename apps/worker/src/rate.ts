import { dailyCap, zonedParts, type SessionSettings } from "@areszap/core";

export type SendClass = "conversation" | "api" | "bulk";

export const classOf = (priority: number): SendClass => (priority >= 2 ? "bulk" : priority === 1 ? "api" : "conversation");

/**
 * Ritmo de envio de um número (em memória, um por sessão no worker).
 * - Tudo respeita o limite por minuto (anti-rajada).
 * - Envio em massa (transmissão) também respeita: intervalo aleatório entre envios, teto por hora,
 *   teto do dia com aquecimento de número novo e janela de horário.
 * O MarcFlow usava intervalo fixo, sem teto e sem variação.
 */
export class RateGate {
    private minute: number[] = [];
    private bulkHour: number[] = [];
    private day = { key: "", bulk: 0 };
    private nextBulkAt = 0;

    constructor(private now: () => number = Date.now, private random: () => number = Math.random) { }

    seed(dayKey: string, bulkSentToday: number) {
        this.day = { key: dayKey, bulk: bulkSentToday };
    }

    dayKey(s: SessionSettings) { return zonedParts(new Date(this.now()), s.timezone).today; }

    /** Pode mandar mensagem em massa agora? Senão, quanto esperar (ms). `daysConnected` alimenta o aquecimento. */
    bulkWait(s: SessionSettings, daysConnected: number): { ok: true } | { ok: false; waitMs: number; reason: string } {
        const t = this.now();
        this.trim(t);
        const key = this.dayKey(s);
        if (key !== this.day.key) this.day = { key, bulk: 0 };
        if (t < this.nextBulkAt) return { ok: false, waitMs: this.nextBulkAt - t, reason: "intervalo" };
        if (this.minute.length >= s.sending.perMinute) return { ok: false, waitMs: this.minute[0] + 60_000 - t, reason: "por minuto" };
        if (this.bulkHour.length >= s.sending.perHour) return { ok: false, waitMs: this.bulkHour[0] + 3_600_000 - t, reason: "por hora" };
        const cap = dailyCap(s, daysConnected);
        if (this.day.bulk >= cap) return { ok: false, waitMs: 10 * 60_000, reason: `teto do dia (${cap})` };
        const w = s.sending.bulkWindow;
        if (w) {
            const hhmm = zonedParts(new Date(t), s.timezone).hhmm;
            const inside = w.start <= w.end ? hhmm >= w.start && hhmm < w.end : hhmm >= w.start || hhmm < w.end;
            if (!inside) return { ok: false, waitMs: 60_000, reason: "fora da janela" };
        }
        return { ok: true };
    }

    /** Conversa e API: só o limite por minuto. */
    conversationWait(s: SessionSettings): number {
        const t = this.now();
        this.trim(t);
        return this.minute.length >= s.sending.perMinute ? this.minute[0] + 60_000 - t : 0;
    }

    record(cls: SendClass, s: SessionSettings, gap?: { min: number; max: number }) {
        const t = this.now();
        this.minute.push(t);
        if (cls === "bulk") {
            this.bulkHour.push(t);
            this.day.bulk++;
            const min = gap?.min ?? s.sending.bulkMinGapSec;
            const max = Math.max(min, gap?.max ?? s.sending.bulkMaxGapSec);
            this.nextBulkAt = t + Math.round((min + this.random() * (max - min)) * 1000);
        }
    }

    stats() { return { minute: this.minute.length, bulkHour: this.bulkHour.length, bulkToday: this.day.bulk, nextBulkAt: this.nextBulkAt }; }

    private trim(t: number) {
        while (this.minute.length && this.minute[0] <= t - 60_000) this.minute.shift();
        while (this.bulkHour.length && this.bulkHour[0] <= t - 3_600_000) this.bulkHour.shift();
    }
}
