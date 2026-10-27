import type postgres from "postgres";
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "baileys";

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v, BufferJSON.replacer));
const fromJson = (v: unknown) => JSON.parse(JSON.stringify(v), BufferJSON.reviver);

/**
 * Estado de autenticação do Baileys no Postgres (tabela wa_auth, uma linha por chave).
 * Diferente do MarcFlow: leitura em lote numa consulta e gravação em lote numa transação.
 * O Postgres compara texto com maiúsculas, então não precisa do escape de chave do original.
 */
export async function usePgAuthState(sql: postgres.Sql, sessionId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; clear: () => Promise<void> }> {
    const row = await sql`select value from wa_auth where session_id = ${sessionId} and key = 'creds'`;
    const creds: AuthenticationCreds = row[0] ? fromJson(row[0].value) : initAuthCreds();

    const state: AuthenticationState = {
        creds,
        keys: {
            get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
                const out: { [id: string]: SignalDataTypeMap[T] } = {};
                if (!ids.length) return out;
                const keys = ids.map(id => `${type}:${id}`);
                const rows = await sql`select key, value from wa_auth where session_id = ${sessionId} and key in ${sql(keys)}`;
                for (const r of rows) {
                    const id = (r.key as string).slice(type.length + 1);
                    let value = fromJson(r.value);
                    if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    out[id] = value;
                }
                return out;
            },
            set: async data => {
                const upserts: { session_id: string; key: string; value: unknown }[] = [];
                const deletes: string[] = [];
                for (const category in data) {
                    const entries = data[category as keyof SignalDataTypeMap] ?? {};
                    for (const id in entries) {
                        const value = entries[id];
                        const key = `${category}:${id}`;
                        if (value) upserts.push({ session_id: sessionId, key, value: sql.json(toJson(value)) });
                        else deletes.push(key);
                    }
                }
                if (!upserts.length && !deletes.length) return;
                await sql.begin(async tx => {
                    if (upserts.length) {
                        // em lotes para não estourar o limite de parâmetros
                        for (let i = 0; i < upserts.length; i += 500) {
                            await tx`insert into wa_auth ${tx(upserts.slice(i, i + 500) as any)}
                                     on conflict (session_id, key) do update set value = excluded.value`;
                        }
                    }
                    if (deletes.length) await tx`delete from wa_auth where session_id = ${sessionId} and key in ${tx(deletes)}`;
                });
            },
        },
    };

    return {
        state,
        saveCreds: async () => {
            await sql`insert into wa_auth (session_id, key, value) values (${sessionId}, 'creds', ${sql.json(toJson(creds))})
                      on conflict (session_id, key) do update set value = excluded.value`;
        },
        clear: async () => { await sql`delete from wa_auth where session_id = ${sessionId}`; },
    };
}
