import { describe, expect, it } from "vitest";
import { resolveSettings } from "@areszap/core";
import { RateGate, classOf } from "../src/rate";

describe("RateGate", () => {
    const base = Date.parse("2026-10-26T15:00:00Z"); // 12:00 em São Paulo
    const mk = (over: object = {}) => {
        let t = base;
        const gate = new RateGate(() => t, () => 0.5);
        return { gate, s: resolveSettings({ sending: { warmup: { enabled: false }, ...over } }), advance: (ms: number) => { t += ms; } };
    };

    it("classe pela prioridade", () => {
        expect(classOf(0)).toBe("conversation");
        expect(classOf(1)).toBe("api");
        expect(classOf(2)).toBe("bulk");
    });

    it("intervalo aleatório entre envios em massa (meio do intervalo com random 0,5)", () => {
        const { gate, s, advance } = mk({ bulkMinGapSec: 10, bulkMaxGapSec: 30 });
        expect(gate.bulkWait(s, 0).ok).toBe(true);
        gate.record("bulk", s);
        const w = gate.bulkWait(s, 0);
        expect(w.ok).toBe(false);
        if (!w.ok) expect(w.waitMs).toBe(20_000);
        advance(20_000);
        expect(gate.bulkWait(s, 0).ok).toBe(true);
    });

    it("intervalo da própria transmissão vence o da sessão", () => {
        const { gate, s } = mk({ bulkMinGapSec: 10, bulkMaxGapSec: 30 });
        gate.record("bulk", s, { min: 60, max: 60 });
        const w = gate.bulkWait(s, 0);
        if (!w.ok) expect(w.waitMs).toBe(60_000);
    });

    it("limite por minuto vale para conversa", () => {
        const { gate, s, advance } = mk({ perMinute: 2 });
        gate.record("conversation", s);
        gate.record("conversation", s);
        expect(gate.conversationWait(s)).toBe(60_000);
        advance(60_001);
        expect(gate.conversationWait(s)).toBe(0);
    });

    it("teto do dia com aquecimento", () => {
        let t = base;
        const gate = new RateGate(() => t, () => 0);
        const s = resolveSettings({ sending: { bulkMinGapSec: 1, bulkMaxGapSec: 1, warmup: { enabled: true, startPerDay: 3, growthPct: 100 } } });
        for (let i = 0; i < 3; i++) { expect(gate.bulkWait(s, 0).ok).toBe(true); gate.record("bulk", s); t += 1000; }
        const w = gate.bulkWait(s, 0);
        expect(w.ok).toBe(false);
        if (!w.ok) expect(w.reason).toContain("teto do dia (3)");
        // no 2º dia conectado o teto dobra (3 → 6)
        expect(gate.bulkWait(s, 1).ok).toBe(true);
    });

    it("janela de envio no fuso da sessão", () => {
        const { gate, s } = mk({ bulkWindow: { start: "13:00", end: "20:00" } });
        const w = gate.bulkWait(s, 0); // 12:00 em SP
        expect(w.ok).toBe(false);
        if (!w.ok) expect(w.reason).toBe("fora da janela");
        const { gate: g2, s: s2 } = mk({ bulkWindow: { start: "08:00", end: "20:00" } });
        expect(g2.bulkWait(s2, 0).ok).toBe(true);
    });
});
