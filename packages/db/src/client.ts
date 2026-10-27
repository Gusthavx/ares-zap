import postgres from "postgres";
import { CHANNEL_COMMANDS, CHANNEL_EVENTS, type BusEvent, type WorkerCommand } from "@areszap/core";

/**
 * Cliente SQL do app (postgres.js puro). O Drizzle NÃO usa este cliente: ao embrulhar um cliente,
 * ele troca os conversores de data e JSON para "passa direto", o que quebraria o SQL escrito à mão.
 * O Drizzle fica só no schema/migrações (migrate.ts abre conexão própria).
 */
export interface DbHandle { sql: postgres.Sql; close: () => Promise<void> }

export function connect(url = process.env.DATABASE_URL, opts: { max?: number; appName?: string } = {}): DbHandle {
    if (!url) throw new Error("DATABASE_URL não definido");
    const sql = postgres(url, {
        max: opts.max ?? 10,
        idle_timeout: 30,
        connection: { application_name: opts.appName ?? "areszap" },
        onnotice: () => undefined,
        // jsonb volta como objeto; timestamptz como Date
    });
    return { sql, close: () => sql.end({ timeout: 5 }) };
}

// ---------- barramento entre processos ----------
/** NOTIFY tem limite de ~8 KB; os eventos carregam só ids. */
export async function publishEvent(sql: postgres.Sql, e: BusEvent) {
    await sql.notify(CHANNEL_EVENTS, JSON.stringify(e));
}

export async function sendCommand(sql: postgres.Sql, c: WorkerCommand) {
    await sql.notify(CHANNEL_COMMANDS, JSON.stringify(c));
}

export async function onEvents(sql: postgres.Sql, cb: (e: BusEvent) => void) {
    return sql.listen(CHANNEL_EVENTS, payload => {
        try { cb(JSON.parse(payload)); } catch { /* payload inválido: ignora */ }
    });
}

export async function onCommands(sql: postgres.Sql, cb: (c: WorkerCommand) => void) {
    return sql.listen(CHANNEL_COMMANDS, payload => {
        try { cb(JSON.parse(payload)); } catch { /* payload inválido: ignora */ }
    });
}
