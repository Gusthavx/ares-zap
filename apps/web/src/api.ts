// Cliente da API do Ares Zap. Fonte da verdade: docs/API.md.
import type {
    FlowGraph, FlowTrigger, GraphIssue, OutMessage, SessionSettings, SessionStatus, WebhookEvent,
} from "@areszap/core";

// ---------- tipos das respostas ----------
export type Role = "admin" | "member";
export interface User { id: string; email: string; name: string; role: Role; createdAt?: string }

export type Provider = "baileys" | "cloud";
export interface Session {
    id: string; name: string; provider: Provider; enabled: boolean; status: SessionStatus; phone: string | null;
    lastError: string | null; settings: SessionSettings; connectedAt: string | null; createdAt: string; qr: string | null;
}
export interface CloudConfig { phoneNumberId: string; wabaId: string; accessToken: string; appSecret: string; verifyToken: string }
export interface SessionStats {
    outbox: { queued: number; held: number; sending: number; sentToday: number; failedToday: number };
    cap: { today: number; perDay: number };
    flows: { active: number; runsActive: number };
}

export interface ActiveRun { id: string; flowId: string; flowName: string; status: string }
export interface Chat {
    id: string; jid: string; title: string; phone: string; lastMessageText: string | null; lastMessageAt: string | null;
    lastFromMe: boolean; unread: number; archived: boolean; contactId: string | null; pausedUntil: string | null; activeRun: ActiveRun | null;
}
export type MessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";
export type Sender = "contact" | "flow" | "broadcast" | "agent" | "api" | "phone" | "notify";
export interface Message {
    id: string; waId: string; fromMe: boolean; sender: Sender; type: string; body: string | null;
    media: { assetId: string; mime: string; fileName: string | null } | null; status: MessageStatus | null; createdAt: string;
}
export interface Page<T> { items: T[]; nextCursor: string | null }

export interface LabelRef { id: string; name: string; color: string }
export interface Label extends LabelRef { count: number }
export interface Contact {
    id: string; jid: string; phone: string; name: string | null; pushName: string | null; fields: Record<string, string>;
    labels: LabelRef[]; pausedUntil: string | null; optedOutAt: string | null; createdAt: string;
}

export type FlowStatus = "draft" | "active" | "inactive";
export interface FlowSummary {
    id: string; name: string; status: FlowStatus; publishedVersion: number | null; publishedAt: string | null; updatedAt: string;
    triggers: FlowTrigger[]; hasUnpublishedChanges: boolean; runsActive: number;
}
export interface Flow extends FlowSummary {
    sessionId: string; draftGraph: FlowGraph; draftTriggers: FlowTrigger[]; draftRevision: number;
    publishedGraph: FlowGraph | null; publishedTriggers: FlowTrigger[] | null;
}
export interface FlowExport { name: string; graph: FlowGraph; triggers: FlowTrigger[] }
export interface FlowStats { nodes: Record<string, Record<string, number>>; runs: Record<string, number> }
export type SimOutcome = "started" | "handled" | "busy" | "paused" | "no-trigger" | "ignored" | "duplicate" | "reset";
export interface SimMessage {
    kind: "text" | "media" | "vcard" | "menu" | "template"; text: string; options?: { id: string; text: string }[];
    mode?: "number" | "interactive"; typingMs: number; delayMs: number; to?: string;
}
export interface SimResult {
    result: SimOutcome; messages: SimMessage[];
    run: { status: string; currentNodeId: string | null; wait: unknown; resumeAt: string | null; flowId?: string } | null;
    fields: Record<string, string>;
    /** Nomes das etiquetas do contato simulado. */
    tags: string[];
    events?: { nodeId: string | null; kind: string; detail: Record<string, unknown> | null }[];
}
export interface Run {
    id: string; flowId: string; flowVersion: number | null; contactId: string; jid: string; status: string; currentNodeId: string | null;
    resumeAt: string | null; isTest: boolean; error: string | null; createdAt: string; updatedAt: string;
}
export interface RunEvent { id: string; nodeId: string | null; kind: string; detail: Record<string, unknown> | null; createdAt: string }

export interface Asset { id: string; fileName: string; mime: string; size: number; createdAt: string; url: string }

export type BroadcastStatus = "scheduled" | "running" | "paused" | "completed" | "cancelled";
export interface Broadcast {
    id: string; name: string; status: BroadcastStatus; message: OutMessage; scheduledAt: string | null; minGapSec: number; maxGapSec: number;
    skipOptedOut: boolean; total: number; sent: number; failed: number; skipped: number; createdAt: string; startedAt: string | null;
    finishedAt: string | null; etaAt: string | null;
}
export type RecipientStatus = "pending" | "queued" | "sent" | "failed" | "skipped" | "cancelled";
export interface Recipient { id: string; jid: string; status: RecipientStatus; error: string | null; sentAt: string | null }
export interface NewBroadcast {
    name: string; text: string; assetId?: string; recipients?: { phone: string; vars?: Record<string, string> }[]; labelIds?: string[];
    scheduledAt?: string; minGapSec?: number; maxGapSec?: number; skipOptedOut?: boolean;
}

export interface Webhook {
    id: string; sessionId: string | null; url: string; events: WebhookEvent[]; active: boolean; lastStatus: number | null;
    lastError: string | null; lastAt: string | null; createdAt: string;
}
export interface ApiKey { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string }

// ---------- transporte ----------
export class ApiError extends Error {
    constructor(message: string, public status: number, public body: Record<string, unknown> = {}) { super(message); }
    get issues(): GraphIssue[] { return Array.isArray(this.body.issues) ? (this.body.issues as GraphIssue[]) : []; }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

const FALLBACK: Record<number, string> = {
    400: "Dados inválidos.", 401: "Sua sessão expirou. Entre de novo.", 403: "Você não tem permissão para isso.", 404: "Não encontrado.",
    409: "Conflito: o item foi alterado em outro lugar.", 413: "Arquivo grande demais.", 422: "Não foi possível concluir.", 429: "Muitas tentativas. Espere um pouco.",
};

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(q?: Query): string {
    if (!q) return "";
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
}

export async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
    const isForm = body instanceof FormData;
    let res: Response;
    try {
        res = await fetch(`/api${path}${qs(query)}`, {
            method,
            credentials: "include",
            headers: body === undefined || isForm ? undefined : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        });
    } catch {
        throw new ApiError("Sem conexão com o servidor.", 0);
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) { try { json = JSON.parse(text); } catch { json = undefined; } }
    if (!res.ok) {
        const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
        if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
        const msg = typeof obj.error === "string" ? obj.error : FALLBACK[res.status] ?? `Erro ${res.status}.`;
        throw new ApiError(msg, res.status, obj);
    }
    return json as T;
}

const get = <T>(p: string, q?: Query) => request<T>("GET", p, undefined, q);
const post = <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {});
const put = <T>(p: string, b: unknown) => request<T>("PUT", p, b);
const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);
const del = <T = { ok: boolean }>(p: string) => request<T>("DELETE", p);

type Ok = { ok: boolean };

// ---------- endpoints ----------
export const api = {
    auth: {
        login: (email: string, password: string) => post<{ user: User }>("/auth/login", { email, password }),
        logout: () => post<Ok>("/auth/logout"),
        me: async (): Promise<User | null> => {
            try { return (await get<{ user: User }>("/auth/me")).user; } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
        },
        password: (current: string, next: string) => post<Ok>("/auth/password", { current, next }),
    },
    sessions: {
        list: () => get<Session[]>("/sessions"),
        get: (id: string) => get<Session>(`/sessions/${id}`),
        create: (b: { name: string; provider: Provider; cloud?: CloudConfig }) => post<Session>("/sessions", b),
        update: (id: string, b: { name?: string; settings?: Partial<SessionSettings>; cloud?: Partial<CloudConfig> }) => patch<Session>(`/sessions/${id}`, b),
        remove: (id: string) => del(`/sessions/${id}`),
        action: (id: string, action: "start" | "stop" | "logout") => post<Ok>(`/sessions/${id}/${action}`),
        stats: (id: string) => get<SessionStats>(`/sessions/${id}/stats`),
        fields: (id: string) => get<{ contact: string[]; bot: string[] }>(`/sessions/${id}/fields`),
    },
    chats: {
        list: (sid: string, q: { search?: string; archived?: boolean; cursor?: string | null; limit?: number }) =>
            get<Page<Chat>>(`/sessions/${sid}/chats`, { search: q.search, archived: q.archived ? 1 : 0, cursor: q.cursor, limit: q.limit ?? 40 }),
        get: (chatId: string) => get<Chat>(`/chats/${chatId}`),
        messages: (chatId: string, before?: string | null, limit = 50) => get<{ items: Message[] }>(`/chats/${chatId}/messages`, { before, limit }),
        send: (chatId: string, b: { text: string } | { assetId: string; caption?: string }) => post<{ outboxId: string; waId: string }>(`/chats/${chatId}/messages`, b),
        read: (chatId: string) => post<Ok>(`/chats/${chatId}/read`),
        archive: (chatId: string, archived: boolean) => post<Ok>(`/chats/${chatId}/archive`, { archived }),
        automation: (chatId: string, b: { action: "resume" } | { action: "pause"; minutes: number }) => post<{ pausedUntil: string | null }>(`/chats/${chatId}/automation`, b),
    },
    contacts: {
        list: (sid: string, q: { search?: string; labelId?: string; cursor?: string | null; limit?: number }) =>
            get<Page<Contact>>(`/sessions/${sid}/contacts`, { search: q.search, labelId: q.labelId, cursor: q.cursor, limit: q.limit ?? 50 }),
        update: (id: string, b: { name?: string; fields?: Record<string, string>; labelIds?: string[]; optedOut?: boolean }) => patch<Contact>(`/contacts/${id}`, b),
    },
    labels: {
        list: (sid: string) => get<Label[]>(`/sessions/${sid}/labels`),
        create: (sid: string, b: { name: string; color?: string }) => post<Label>(`/sessions/${sid}/labels`, b),
        update: (id: string, b: { name?: string; color?: string }) => patch<Label>(`/labels/${id}`, b),
        remove: (id: string) => del(`/labels/${id}`),
    },
    variables: {
        get: (sid: string) => get<Record<string, string>>(`/sessions/${sid}/variables`),
        put: (sid: string, b: Record<string, string | null>) => put<Record<string, string>>(`/sessions/${sid}/variables`, b),
    },
    flows: {
        list: (sid: string) => get<FlowSummary[]>(`/sessions/${sid}/flows`),
        create: (sid: string, b: { name: string; graph?: FlowGraph; triggers?: FlowTrigger[] }) => post<Flow>(`/sessions/${sid}/flows`, b),
        import: (sid: string, json: unknown) => post<Flow & { importWarnings?: string[] }>(`/sessions/${sid}/flows/import`, json),
        get: (id: string) => get<Flow>(`/flows/${id}`),
        export: (id: string) => get<FlowExport>(`/flows/${id}/export`),
        rename: (id: string, name: string) => patch<Flow>(`/flows/${id}`, { name }),
        saveDraft: (id: string, b: { graph: FlowGraph; triggers: FlowTrigger[]; revision: number }) => put<{ revision: number }>(`/flows/${id}/draft`, b),
        validate: (id: string) => post<{ issues: GraphIssue[] }>(`/flows/${id}/validate`),
        publish: (id: string) => post<{ version: number; issues: GraphIssue[] }>(`/flows/${id}/publish`),
        activate: (id: string) => post<Ok>(`/flows/${id}/activate`),
        deactivate: (id: string) => post<Ok>(`/flows/${id}/deactivate`),
        duplicate: (id: string) => post<Flow>(`/flows/${id}/duplicate`),
        remove: (id: string) => del(`/flows/${id}`),
        simulate: (id: string, b: { text?: string; optionId?: string; reset?: boolean; skipWait?: boolean }) => post<SimResult>(`/flows/${id}/simulate`, b),
        test: (id: string, phone: string) => post<{ runId: string }>(`/flows/${id}/test`, { phone }),
        stats: (id: string) => get<FlowStats>(`/flows/${id}/stats`),
        runs: (id: string, status?: string) => get<{ items: Run[] }>(`/flows/${id}/runs`, { status, limit: 50 }),
    },
    runs: {
        events: (id: string) => get<{ items: RunEvent[] }>(`/runs/${id}/events`),
        cancel: (id: string) => post<Ok>(`/runs/${id}/cancel`),
    },
    assets: {
        list: (sid: string) => get<Asset[]>(`/sessions/${sid}/assets`),
        upload: (sid: string, file: File) => { const fd = new FormData(); fd.append("file", file); return request<Asset>("POST", `/sessions/${sid}/assets`, fd); },
        remove: (id: string) => del(`/assets/${id}`),
        fileUrl: (id: string) => `/api/assets/${id}/file`,
    },
    broadcasts: {
        list: (sid: string) => get<Broadcast[]>(`/sessions/${sid}/broadcasts`),
        create: (sid: string, b: NewBroadcast) => post<Broadcast & { invalidNumbers?: number }>(`/sessions/${sid}/broadcasts`, b),
        get: (id: string) => get<Broadcast>(`/broadcasts/${id}`),
        recipients: (id: string, q: { status?: string; limit?: number; offset?: number }) =>
            get<{ items: Recipient[]; total: number }>(`/broadcasts/${id}/recipients`, { status: q.status, limit: q.limit ?? 100, offset: q.offset ?? 0 }),
        action: (id: string, action: "pause" | "resume" | "cancel") => post<Ok>(`/broadcasts/${id}/${action}`),
    },
    webhooks: {
        list: () => get<Webhook[]>("/webhooks"),
        create: (b: { sessionId?: string | null; url: string; events: WebhookEvent[] }) => post<Webhook & { secret: string }>("/webhooks", b),
        update: (id: string, b: { url?: string; events?: WebhookEvent[]; active?: boolean }) => patch<Webhook>(`/webhooks/${id}`, b),
        remove: (id: string) => del(`/webhooks/${id}`),
        test: (id: string) => post<Ok>(`/webhooks/${id}/test`),
    },
    apiKeys: {
        list: () => get<ApiKey[]>("/api-keys"),
        create: (name: string) => post<ApiKey & { key: string }>("/api-keys", { name }),
        remove: (id: string) => del(`/api-keys/${id}`),
    },
    users: {
        list: () => get<User[]>("/users"),
        create: (b: { email: string; name: string; password: string; role: Role }) => post<User>("/users", b),
        remove: (id: string) => del(`/users/${id}`),
    },
};

/** Chaves de cache do react-query, num lugar só para o WebSocket invalidar certo. */
export const qk = {
    me: ["me"] as const,
    sessions: ["sessions"] as const,
    session: (id: string) => ["session", id] as const,
    stats: (id: string) => ["session-stats", id] as const,
    chats: (sid: string) => ["chats", sid] as const,
    messages: (chatId: string) => ["messages", chatId] as const,
    chat: (chatId: string) => ["chat", chatId] as const,
    fields: (sid: string) => ["fields", sid] as const,
    contacts: (sid: string) => ["contacts", sid] as const,
    labels: (sid: string) => ["labels", sid] as const,
    variables: (sid: string) => ["variables", sid] as const,
    flows: (sid: string) => ["flows", sid] as const,
    flow: (id: string) => ["flow", id] as const,
    flowStats: (id: string) => ["flow-stats", id] as const,
    flowRuns: (id: string) => ["flow-runs", id] as const,
    runEvents: (id: string) => ["run-events", id] as const,
    broadcasts: (sid: string) => ["broadcasts", sid] as const,
    broadcast: (id: string) => ["broadcast", id] as const,
    recipients: (id: string) => ["recipients", id] as const,
    webhooks: ["webhooks"] as const,
    apiKeys: ["api-keys"] as const,
    users: ["users"] as const,
};
