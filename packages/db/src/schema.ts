import { sql } from "drizzle-orm";
import {
    bigint, bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import type { FlowGraph, FlowTrigger, OutMessage } from "@areszap/core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ---------- usuários e acesso ----------
export const userRole = pgEnum("user_role", ["admin", "member"]);

export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull().default("member"),
    createdAt: createdAt(),
}, t => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const apiKeys = pgTable("api_keys", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),          // primeiros caracteres, para o usuário reconhecer
    keyHash: text("key_hash").notNull(),       // sha256 da chave; a chave em si só aparece na criação
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
}, t => [uniqueIndex("api_keys_hash_uq").on(t.keyHash)]);

// ---------- sessões (números) ----------
export const providerKind = pgEnum("provider_kind", ["baileys", "cloud"]);

export const sessions = pgTable("sessions", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    provider: providerKind("provider").notNull().default("baileys"),
    /** desejo do usuário: ligado ou não. O worker sobe tudo que está ligado. */
    enabled: boolean("enabled").notNull().default(true),
    status: text("status").notNull().default("stopped"),
    phone: text("phone"),
    lastError: text("last_error"),
    /** API oficial: phoneNumberId, wabaId, token (cifrado), appSecret (cifrado), verifyToken. */
    cloudConfig: jsonb("cloud_config").$type<Record<string, string>>(),
    settings: jsonb("settings").notNull().default({}),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    firstConnectedAt: ts("first_connected_at"),
    connectedAt: ts("connected_at"),
    createdAt: createdAt(),
});

/** Estado de autenticação do Baileys: uma linha por chave. Texto sensível a maiúsculas (Postgres) dispensa o escape do MarcFlow. */
export const waAuth = pgTable("wa_auth", {
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
}, t => [primaryKey({ columns: [t.sessionId, t.key] })]);

// ---------- contatos, etiquetas, conversas, mensagens ----------
export const contacts = pgTable("contacts", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    phone: text("phone"),
    name: text("name"),              // nome salvo pelo usuário
    pushName: text("push_name"),     // nome do perfil do WhatsApp
    fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
    pausedUntil: ts("paused_until"),
    optedOutAt: ts("opted_out_at"),
    /** Primeiro contato visto depois da sessão conectar: decide o gatilho "primeira mensagem". */
    firstInboundAt: ts("first_inbound_at"),
    createdAt: createdAt(),
}, t => [
    uniqueIndex("contacts_session_jid_uq").on(t.sessionId, t.jid),
    index("contacts_session_phone_idx").on(t.sessionId, t.phone),
]);

export const labels = pgTable("labels", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#64748B"),
    createdAt: createdAt(),
}, t => [uniqueIndex("labels_session_name_uq").on(t.sessionId, t.name)]);

export const contactLabels = pgTable("contact_labels", {
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.contactId, t.labelId] }), index("contact_labels_label_idx").on(t.labelId)]);

/** Variáveis globais do robô (campos de escopo BOT). */
export const botVariables = pgTable("bot_variables", {
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
}, t => [primaryKey({ columns: [t.sessionId, t.key] })]);

/** Lista de conversas desnormalizada: a tela lista daqui, sem recalcular a partir das mensagens. */
export const chats = pgTable("chats", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    title: text("title"),
    lastMessageText: text("last_message_text"),
    lastMessageAt: ts("last_message_at"),
    lastFromMe: boolean("last_from_me").notNull().default(false),
    unread: integer("unread").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
}, t => [
    uniqueIndex("chats_session_jid_uq").on(t.sessionId, t.jid),
    index("chats_session_last_idx").on(t.sessionId, t.archived, t.lastMessageAt.desc()),
]);

export const messageSender = pgEnum("message_sender", ["contact", "flow", "broadcast", "agent", "api", "phone", "notify"]);

export const messages = pgTable("messages", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    waId: text("wa_id").notNull(),
    fromMe: boolean("from_me").notNull(),
    sender: messageSender("sender").notNull(),
    type: text("type").notNull(),
    body: text("body"),
    media: jsonb("media").$type<{ assetId?: string; mime?: string; fileName?: string; size?: number; providerRef?: string }>(),
    status: text("status").notNull().default("received"),
    quotedWaId: text("quoted_wa_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
}, t => [
    uniqueIndex("messages_session_wa_uq").on(t.sessionId, t.waId),
    index("messages_chat_created_idx").on(t.chatId, t.createdAt.desc()),
]);

// ---------- mídia ----------
export const assets = pgTable("assets", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    path: text("path").notNull(),
    origin: text("origin").notNull().default("upload"), // upload | inbound
    createdAt: createdAt(),
}, t => [index("assets_session_idx").on(t.sessionId, t.createdAt.desc())]);

// ---------- fluxos ----------
export const flowStatus = pgEnum("flow_status", ["draft", "active", "inactive"]);

export const flows = pgTable("flows", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: flowStatus("status").notNull().default("draft"),
    draftGraph: jsonb("draft_graph").$type<FlowGraph>().notNull(),
    draftTriggers: jsonb("draft_triggers").$type<FlowTrigger[]>().notNull().default([]),
    draftRevision: integer("draft_revision").notNull().default(0),
    publishedGraph: jsonb("published_graph").$type<FlowGraph>(),
    publishedTriggers: jsonb("published_triggers").$type<FlowTrigger[]>(),
    publishedVersion: integer("published_version").notNull().default(0),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [index("flows_session_status_idx").on(t.sessionId, t.status)]);

export const runStatus = pgEnum("run_status", ["running", "waiting_input", "waiting_delay", "completed", "failed", "expired", "cancelled"]);

export const flowRuns = pgTable("flow_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id").notNull().references(() => flows.id, { onDelete: "cascade" }),
    flowVersion: integer("flow_version").notNull().default(0),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    graph: jsonb("graph").$type<FlowGraph>().notNull(),
    status: runStatus("status").notNull().default("running"),
    currentNodeId: text("current_node_id"),
    wait: jsonb("wait"),
    resumeAt: ts("resume_at"),
    lastKeyId: text("last_key_id"),
    steps: integer("steps").notNull().default(0),
    isTest: boolean("is_test").notNull().default(false),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, t => [
    index("flow_runs_active_contact_idx").on(t.contactId, t.createdAt.desc()).where(sql`status in ('running','waiting_input','waiting_delay')`),
    index("flow_runs_due_idx").on(t.resumeAt).where(sql`resume_at is not null`),
    index("flow_runs_flow_idx").on(t.flowId, t.createdAt.desc()),
]);

export const flowEvents = pgTable("flow_events", {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull().references(() => flowRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    kind: text("kind").notNull(), // START ENTER SEND WAIT INPUT INVALID BRANCH ACTION ERROR END
    detail: jsonb("detail"),
    createdAt: createdAt(),
}, t => [index("flow_events_run_idx").on(t.runId, t.id)]);

export const flowNodeStats = pgTable("flow_node_stats", {
    flowId: uuid("flow_id").notNull().references(() => flows.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    key: text("key").notNull(), // entered | option:<id> | seq
    count: integer("count").notNull().default(0),
}, t => [primaryKey({ columns: [t.flowId, t.nodeId, t.key] })]);

// ---------- fila de saída por número ----------
export const outboxStatus = pgEnum("outbox_status", ["queued", "held", "sending", "sent", "failed", "cancelled", "skipped"]);

export const outbox = pgTable("outbox", {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    payload: jsonb("payload").$type<OutMessage>().notNull(),
    source: text("source").notNull(),            // flow | broadcast | agent | api | notify
    priority: smallint("priority").notNull().default(0),
    notBefore: ts("not_before").notNull().defaultNow(),
    /** Atraso "digitando…" a simular antes deste envio (ms). */
    typingMs: integer("typing_ms").notNull().default(0),
    status: outboxStatus("status").notNull().default("queued"),
    attempts: smallint("attempts").notNull().default(0),
    error: text("error"),
    waId: text("wa_id"),
    runId: uuid("run_id"),
    broadcastId: uuid("broadcast_id"),
    recipientId: bigint("recipient_id", { mode: "number" }),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
}, t => [
    index("outbox_pick_idx").on(t.sessionId, t.priority, t.notBefore, t.id).where(sql`status = 'queued'`),
    index("outbox_sent_idx").on(t.sessionId, t.sentAt).where(sql`status = 'sent'`),
    index("outbox_broadcast_idx").on(t.broadcastId, t.status),
    uniqueIndex("outbox_wa_id_uq").on(t.sessionId, t.waId),
    index("outbox_jid_head_idx").on(t.sessionId, t.jid, t.id).where(sql`status in ('queued','sending')`),
]);

// ---------- transmissões ----------
export const broadcastStatus = pgEnum("broadcast_status", ["scheduled", "running", "paused", "completed", "cancelled"]);

export const broadcasts = pgTable("broadcasts", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    message: jsonb("message").$type<OutMessage>().notNull(),
    status: broadcastStatus("status").notNull().default("scheduled"),
    scheduledAt: ts("scheduled_at"),
    minGapSec: integer("min_gap_sec"),
    maxGapSec: integer("max_gap_sec"),
    skipOptedOut: boolean("skip_opted_out").notNull().default(true),
    total: integer("total").notNull().default(0),
    sent: integer("sent").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
}, t => [index("broadcasts_session_idx").on(t.sessionId, t.createdAt.desc())]);

export const broadcastRecipients = pgTable("broadcast_recipients", {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    broadcastId: uuid("broadcast_id").notNull().references(() => broadcasts.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    vars: jsonb("vars").$type<Record<string, string>>().notNull().default({}),
    status: text("status").notNull().default("pending"), // pending queued sent failed skipped
    error: text("error"),
    sentAt: ts("sent_at"),
}, t => [
    uniqueIndex("broadcast_recipients_uq").on(t.broadcastId, t.jid),
    index("broadcast_recipients_status_idx").on(t.broadcastId, t.status),
]);

// ---------- webhooks de saída ----------
export const webhooks = pgTable("webhooks", {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "cascade" }), // null = todas as sessões
    url: text("url").notNull(),
    events: text("events").array().notNull(),
    secret: text("secret").notNull(), // usado para assinar (HMAC); nunca devolvido pela API
    active: boolean("active").notNull().default(true),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    lastAt: ts("last_at"),
    createdAt: createdAt(),
});

// ---------- tarefas agendadas (fila única persistente) ----------
export const jobStatus = pgEnum("job_status", ["queued", "running", "done", "failed"]);

export const jobs = pgTable("jobs", {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    runAt: ts("run_at").notNull().defaultNow(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: smallint("attempts").notNull().default(0),
    maxAttempts: smallint("max_attempts").notNull().default(5),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
}, t => [
    index("jobs_due_idx").on(t.runAt, t.id).where(sql`status = 'queued'`),
    uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey).where(sql`dedupe_key is not null and status in ('queued','running')`),
]);

// ---------- saúde dos processos ----------
export const heartbeats = pgTable("heartbeats", {
    name: text("name").primaryKey(),
    at: ts("at").notNull().defaultNow(),
    info: jsonb("info"),
});
