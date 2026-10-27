import pino from "pino";
import type postgres from "postgres";
import { openSecret } from "@areszap/db";
import { resolveSettings, type SessionSettings } from "@areszap/core";
import type { FlowEngine, KeyedMutex, PgStore } from "@areszap/engine";
import type { CloudConfig } from "./providers/cloud";

export const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { proc: "worker" } });

export interface SessionInfo {
    id: string;
    name: string;
    provider: "baileys" | "cloud";
    enabled: boolean;
    settings: SessionSettings;
    firstConnectedAt: Date | null;
    cloud: CloudConfig | null;
}

/** Configuração das sessões em memória, invalidada por comando do painel. */
export class SessionInfoCache {
    private map = new Map<string, SessionInfo>();
    constructor(private sql: postgres.Sql) { }

    async get(id: string): Promise<SessionInfo | null> {
        const hit = this.map.get(id);
        if (hit) return hit;
        const [r] = await this.sql`select id, name, provider, enabled, settings, cloud_config, first_connected_at from sessions where id = ${id}`;
        if (!r) return null;
        const cc = (r.cloud_config ?? null) as Record<string, string> | null;
        const info: SessionInfo = {
            id: r.id, name: r.name, provider: r.provider, enabled: r.enabled, settings: resolveSettings(r.settings),
            firstConnectedAt: r.first_connected_at,
            cloud: cc?.phoneNumberId ? { phoneNumberId: cc.phoneNumberId, wabaId: cc.wabaId, accessToken: openSecret(cc.accessToken) ?? "" } : null,
        };
        this.map.set(id, info);
        return info;
    }

    /** Versão síncrona para quem já carregou a sessão (provedores). */
    peek(id: string) { return this.map.get(id) ?? null; }

    invalidate(id?: string) { if (id) this.map.delete(id); else this.map.clear(); }
}

export interface Ctx {
    sql: postgres.Sql;
    sessions: SessionInfoCache;
    store: PgStore;
    engine: FlowEngine;
    mutex: KeyedMutex;
}
