import { z } from "zod";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

/** Configuração por sessão (número). Tudo tem padrão; o banco guarda só o que foi mudado. */
export const sessionSettingsSchema = z.object({
    timezone: z.string().default("America/Sao_Paulo"),
    defaultCountryCode: z.string().regex(/^\d{1,4}$/).default("55"),
    /** Quando o atendente responde (painel ou celular), pausa fluxos daquele contato por N minutos e cancela o fluxo em andamento. */
    humanTakeover: z.object({
        enabled: z.boolean().default(true),
        minutes: z.number().int().min(1).max(60 * 24 * 30).default(120),
    }).prefault({}),
    /** Mensagem do contato durante um atraso inteligente: ignorar (como no MarcFlow) ou interromper e procurar outro gatilho. */
    onMessageDuringDelay: z.enum(["ignore", "interrupt"]).default("ignore"),
    sending: z.object({
        perMinute: z.number().int().min(1).max(600).default(20),
        perHour: z.number().int().min(1).max(20_000).default(400),
        perDay: z.number().int().min(1).max(200_000).default(1500),
        /** Intervalo aleatório entre envios em massa (transmissão), em segundos. */
        bulkMinGapSec: z.number().min(1).max(3600).default(15),
        bulkMaxGapSec: z.number().min(1).max(3600).default(45),
        /** "digitando…" proporcional ao tamanho do texto antes de cada resposta de fluxo. */
        typingSimulation: z.boolean().default(true),
        /** Número novo começa com teto diário baixo e sobe a cada dia conectado. */
        warmup: z.object({
            enabled: z.boolean().default(true),
            startPerDay: z.number().int().min(1).default(50),
            growthPct: z.number().min(1).max(500).default(30),
        }).prefault({}),
        /** Janela de envio em massa no fuso da sessão (vazio = qualquer hora). Conversa de fluxo não respeita a janela. */
        bulkWindow: z.object({ start: hhmm, end: hhmm }).nullable().default(null),
    }).prefault({}),
    /** Baixar o histórico antigo do celular ao parear (pesado; desligado por padrão). */
    syncHistory: z.boolean().default(false),
});

export type SessionSettings = z.infer<typeof sessionSettingsSchema>;

export function resolveSettings(raw: unknown): SessionSettings {
    const parsed = sessionSettingsSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : sessionSettingsSchema.parse({});
}

/** Teto diário efetivo considerando o aquecimento. `daysConnected` começa em 0 no 1º dia. */
export function dailyCap(s: SessionSettings, daysConnected: number): number {
    if (!s.sending.warmup.enabled) return s.sending.perDay;
    const ramp = s.sending.warmup.startPerDay * Math.pow(1 + s.sending.warmup.growthPct / 100, Math.max(0, daysConnected));
    return Math.min(s.sending.perDay, Math.floor(ramp));
}
