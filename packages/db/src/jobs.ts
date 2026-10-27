import type postgres from "postgres";

/** Enfileira uma tarefa persistente. Com `dedupeKey`, não duplica enquanto houver uma igual na fila. */
export async function enqueueJob(
    sql: postgres.Sql | postgres.TransactionSql,
    kind: string,
    payload: unknown,
    opts: { runAt?: Date; maxAttempts?: number; dedupeKey?: string } = {},
): Promise<number | null> {
    const rows = await sql`
        insert into jobs (kind, payload, run_at, max_attempts, dedupe_key)
        values (${kind}, ${sql.json(payload as postgres.JSONValue)}, ${opts.runAt ?? new Date()}, ${opts.maxAttempts ?? 5}, ${opts.dedupeKey ?? null})
        on conflict do nothing
        returning id`;
    return rows[0]?.id ? Number(rows[0].id) : null;
}
