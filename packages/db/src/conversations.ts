import type postgres from "postgres";
import { phoneFromJid } from "@areszap/core";

type Tx = postgres.Sql | postgres.TransactionSql;

export interface ContactRef { contactId: string; chatId: string; firstInbound: boolean; pausedUntil: Date | null; optedOutAt: Date | null }

/** Garante contato + conversa do jid (upsert). `pushName` só atualiza quando vier preenchido. */
export async function ensureContact(tx: Tx, sessionId: string, jid: string, pushName?: string | null): Promise<ContactRef & { firstInboundAt: Date | null }> {
    const phone = jid.endsWith("@s.whatsapp.net") ? phoneFromJid(jid) : null;
    const [c] = await tx`
        insert into contacts (session_id, jid, phone, push_name) values (${sessionId}, ${jid}, ${phone}, ${pushName ?? null})
        on conflict (session_id, jid) do update set push_name = coalesce(excluded.push_name, contacts.push_name)
        returning id, first_inbound_at, paused_until, opted_out_at, name, push_name`;
    const title = c.name || c.push_name || null;
    const [chat] = await tx`
        insert into chats (session_id, contact_id, jid, title) values (${sessionId}, ${c.id}, ${jid}, ${title})
        on conflict (session_id, jid) do update set contact_id = excluded.contact_id,
            title = coalesce(chats.title, excluded.title)
        returning id`;
    return { contactId: c.id, chatId: chat.id, firstInbound: false, firstInboundAt: c.first_inbound_at, pausedUntil: c.paused_until, optedOutAt: c.opted_out_at };
}

export type Sender = "contact" | "flow" | "broadcast" | "agent" | "api" | "phone" | "notify";

export interface RecordInput {
    sessionId: string;
    jid: string;
    waId: string;
    fromMe: boolean;
    sender: Sender;
    type: string;
    body: string | null;
    media?: Record<string, unknown> | null;
    status: string;
    createdAt: Date;
    pushName?: string | null;
    quotedWaId?: string | null;
    /** Marca o primeiro contato recebido (gatilho "primeira mensagem"). */
    markFirstInbound?: boolean;
}

export interface RecordResult extends ContactRef { messageId: string; inserted: boolean }

const STATUS_RANK: Record<string, number> = { failed: -1, queued: 0, received: 0, sent: 1, delivered: 2, read: 3 };

/** Grava a mensagem, atualiza a conversa (último texto, não lidas) e devolve ids. Idempotente por (sessão, waId). */
export async function recordMessage(sql: postgres.Sql, m: RecordInput): Promise<RecordResult> {
    return sql.begin(async tx => {
        const ref = await ensureContact(tx, m.sessionId, m.jid, m.fromMe ? null : m.pushName);
        const [msg] = await tx`
            insert into messages (session_id, chat_id, wa_id, from_me, sender, type, body, media, status, quoted_wa_id, created_at)
            values (${m.sessionId}, ${ref.chatId}, ${m.waId}, ${m.fromMe}, ${m.sender}, ${m.type}, ${m.body},
                    ${m.media ? tx.json(m.media as postgres.JSONValue) : null}, ${m.status}, ${m.quotedWaId ?? null}, ${m.createdAt})
            on conflict (session_id, wa_id) do update set
                sender = case when messages.sender = 'phone' and excluded.sender <> 'phone' then excluded.sender else messages.sender end,
                status = case when messages.status = 'queued' then excluded.status else messages.status end
            returning id, (xmax = 0) as inserted`;
        const inserted = !!msg.inserted;
        if (inserted) {
            await tx`
                update chats set last_message_text = ${(m.body ?? `[${m.type}]`).slice(0, 300)}, last_message_at = ${m.createdAt},
                    last_from_me = ${m.fromMe}, unread = ${m.fromMe ? 0 : tx`unread + 1`}, archived = ${m.fromMe ? tx`archived` : false}
                where id = ${ref.chatId} and (last_message_at is null or last_message_at <= ${m.createdAt})`;
        }
        let firstInbound = false;
        if (inserted && m.markFirstInbound && !ref.firstInboundAt) {
            const r = await tx`update contacts set first_inbound_at = now() where id = ${ref.contactId} and first_inbound_at is null returning id`;
            firstInbound = r.length > 0;
        }
        return { ...ref, firstInbound, messageId: msg.id, inserted };
    });
}

/** Atualiza status de mensagens enviadas (recibos). Nunca rebaixa (lida não volta para entregue). */
export async function applyReceipts(sql: postgres.Sql, sessionId: string, receipts: { waId: string; status: string }[]) {
    if (!receipts.length) return [] as { id: string; chatId: string; waId: string; status: string }[];
    const rows = receipts.map(r => [r.waId, r.status, STATUS_RANK[r.status] ?? 0]);
    const out = await sql`
        update messages m set status = v.status
        from (values ${sql(rows as any)}) as v(wa_id, status, rank)
        where m.session_id = ${sessionId} and m.wa_id = v.wa_id and m.from_me
          and (v.status = 'failed' or (case m.status when 'read' then 3 when 'delivered' then 2 when 'sent' then 1 when 'failed' then -1 else 0 end) < v.rank::int)
        returning m.id, m.chat_id, m.wa_id, m.status`;
    return out.map(r => ({ id: r.id as string, chatId: r.chat_id as string, waId: r.wa_id as string, status: r.status as string }));
}
