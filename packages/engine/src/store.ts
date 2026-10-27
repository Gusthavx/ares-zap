import type { FlowGraph, FlowTrigger, IncomingType, OutMessage, OutSource } from "@areszap/core";

export type RunStatus = "running" | "waiting_input" | "waiting_delay" | "completed" | "failed" | "expired" | "cancelled";
export const ACTIVE_STATUSES: RunStatus[] = ["running", "waiting_input", "waiting_delay"];
export const isTerminal = (s: RunStatus) => !ACTIVE_STATUSES.includes(s);

export interface PollRef { id: string; secret: string; values: string[] }

export type Wait =
    | { kind: "input"; nodeId: string; itemIndex: number; attempts: number }
    | { kind: "menu"; nodeId: string; errors: number; poll?: PollRef }
    | { kind: "delay"; nodeId: string };

export interface RunRow {
    id: string;
    flowId: string;
    flowVersion: number;
    sessionId: string;
    contactId: string;
    jid: string;
    graph: FlowGraph;
    status: RunStatus;
    currentNodeId: string | null;
    wait: Wait | null;
    resumeAt: Date | null;
    lastKeyId: string | null;
    steps: number;
    isTest: boolean;
    error: string | null;
    createdAt: Date;
}

export interface ContactRow {
    id: string;
    sessionId: string;
    jid: string;
    phone: string | null;
    name: string | null;
    pushName: string | null;
    fields: Record<string, string>;
    pausedUntil: Date | null;
    optedOutAt: Date | null;
}

export interface ActiveFlow { id: string; name: string; version: number; graph: FlowGraph; triggers: FlowTrigger[] }

export interface FlowEvent { runId: string; nodeId: string | null; kind: string; detail?: unknown; at: Date }

export interface QueuedOut {
    jid: string;
    payload: OutMessage;
    source: OutSource;
    /** Espera antes deste envio, somada à fila do contato (pausa do bloco Conteúdo). */
    delayMs: number;
    /** "digitando…" antes deste envio. */
    typingMs: number;
    waId: string;
    runId: string | null;
}

/** Tudo que um avanço do motor mudou. O store grava numa transação só. */
export interface CommitBatch {
    runs: { row: RunRow; isNew: boolean }[];
    events: FlowEvent[];
    stats: { flowId: string; nodeId: string; key: string; inc: number }[];
    outbound: QueuedOut[];
    contact?: {
        id: string;
        fields?: Record<string, string | null>; // null apaga
        pausedUntil?: Date | null;
        optedOutAt?: Date | null;
    };
    tagsAdd: { contactId: string; labelId: string }[];
    tagsRemove: { contactId: string; labelId: string }[];
    botVars: { sessionId: string; key: string; value: string | null }[];
}

/**
 * Acesso a dados do motor. Implementações: PgStore (worker, Postgres) e MemoryStore (simulador e testes).
 * O chamador garante que só um avanço por contato roda de cada vez.
 */
export interface EngineStore {
    findActiveRun(contactId: string): Promise<RunRow | null>;
    getRun(runId: string): Promise<RunRow | null>;
    getContact(contactId: string): Promise<ContactRow | null>;
    getTagIds(contactId: string): Promise<string[]>;
    getLabels(sessionId: string): Promise<Map<string, string>>;
    getBotVars(sessionId: string): Promise<Record<string, string>>;
    getActiveFlows(sessionId: string): Promise<ActiveFlow[]>;
    getActiveFlow(sessionId: string, flowId: string): Promise<ActiveFlow | null>;
    /** Contador atômico do randomizador sequencial (1, 2, 3…). */
    nextSequence(flowId: string, nodeId: string): Promise<number>;
    commit(batch: CommitBatch): Promise<void>;
}

export interface EngineIncoming {
    sessionId: string;
    contactId: string;
    jid: string;
    keyId: string;
    type: IncomingType;
    text: string;
    mediaRef?: string | null;
    /** Resposta de menu interativo (lista/botão da API oficial ou voto lido da enquete). */
    optionId?: string | null;
    /** Id da enquete votada: só vale se for a enquete que o fluxo está esperando. */
    pollId?: string | null;
    /** Primeiro contato desde que a sessão conectou (gatilho "primeira mensagem"). */
    isFirstContact?: boolean;
}

export type IncomingResult = "handled" | "started" | "duplicate" | "busy" | "paused" | "no-trigger" | "ignored";
