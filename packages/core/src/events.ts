// Eventos entre processos (Postgres LISTEN/NOTIFY). Payload pequeno: o painel busca o resto pela API.

export type SessionStatus = "stopped" | "starting" | "qr" | "connected" | "reconnecting" | "logged_out" | "error";

export type BusEvent =
    | { t: "session.status"; sessionId: string; status: SessionStatus; phone?: string | null; qr?: string | null; error?: string | null }
    | { t: "message"; sessionId: string; chatId: string; messageId: string; fromMe: boolean }
    | { t: "message.status"; sessionId: string; chatId: string; messageId: string; status: string }
    | { t: "chat"; sessionId: string; chatId: string }
    | { t: "broadcast"; sessionId: string; broadcastId: string }
    | { t: "run"; sessionId: string; flowId: string; runId: string; status: string };

export type WorkerCommand =
    | { c: "session.start"; sessionId: string }
    | { c: "session.stop"; sessionId: string }
    | { c: "session.logout"; sessionId: string }
    | { c: "session.reload"; sessionId: string }
    | { c: "cache.invalidate"; sessionId: string; what: "flows" | "webhooks" | "settings" | "all" }
    | { c: "outbox.wake"; sessionId: string };

export const CHANNEL_EVENTS = "areszap_events";
export const CHANNEL_COMMANDS = "areszap_commands";

/** Eventos que um webhook pode assinar. */
export const WEBHOOK_EVENTS = [
    "message.received",
    "message.sent",
    "message.status",
    "session.status",
    "flow.completed",
    "contact.optout",
    "broadcast.finished",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
