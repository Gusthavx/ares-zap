import type { SessionStatus } from "@areszap/core";
import type { Tone } from "@/ui/misc";

export const SESSION_STATUS: Record<SessionStatus, { label: string; tone: Tone }> = {
    stopped: { label: "Parado", tone: "warn" },
    starting: { label: "Iniciando…", tone: "warn" },
    qr: { label: "Aguardando leitura do QR", tone: "warn" },
    connected: { label: "Conectado", tone: "ok" },
    reconnecting: { label: "Reconectando…", tone: "warn" },
    logged_out: { label: "Desconectado do celular", tone: "bad" },
    error: { label: "Erro", tone: "bad" },
};

export const sessionStatus = (s: string) => SESSION_STATUS[s as SessionStatus] ?? { label: s, tone: "neutral" as Tone };
