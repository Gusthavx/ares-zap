import { publishEvent } from "@areszap/db";
import { PRIORITY, newWaMessageId, phoneFromJid, renderTemplate, type OutMessage } from "@areszap/core";
import { log, type Ctx } from "./context";

const CHUNK = 1000;

/**
 * Tarefa "broadcast.start": transforma os destinatários em itens da fila do número, com o texto já personalizado.
 * O ritmo (intervalo aleatório, tetos, janela) fica todo com o sender.
 */
export async function startBroadcast(ctx: Ctx, broadcastId: string, wake: (sessionId: string) => void) {
    const [b] = await ctx.sql`select * from broadcasts where id = ${broadcastId}`;
    // "running" também entra: se o worker caiu no meio, a nova tentativa continua dos destinatários ainda pendentes
    if (!b || (b.status !== "scheduled" && b.status !== "running")) return;
    // "running" antes de enfileirar: o sender segura (held) item de transmissão que não está rodando
    await ctx.sql`update broadcasts set status = 'running', started_at = coalesce(started_at, now()) where id = ${broadcastId} and status = 'scheduled'`;
    const message = b.message as OutMessage;
    let lastId = 0;
    let queued = 0;
    for (;;) {
        const recips = await ctx.sql`
            select r.id, r.jid, r.vars, c.name, c.push_name, c.fields from broadcast_recipients r
            left join contacts c on c.session_id = ${b.session_id} and c.jid = r.jid
            where r.broadcast_id = ${broadcastId} and r.status = 'pending' and r.id > ${lastId}
            order by r.id limit ${CHUNK}`;
        if (!recips.length) break;
        const rows = recips.map(r => {
            const full = String(r.name || r.push_name || r.vars?.nome || "").trim();
            const vars: Record<string, string> = {
                ...(r.fields ?? {}),
                "nome-completo": full, "primeiro-nome": full.split(/\s+/)[0] || "", "telefone": phoneFromJid(r.jid),
                ...(r.vars ?? {}),
            };
            const payload: OutMessage = message.kind === "text" ? { kind: "text", text: renderTemplate(message.text, vars) }
                : message.kind === "media" ? { ...message, caption: message.caption ? renderTemplate(message.caption, vars) : undefined }
                : message;
            return {
                session_id: b.session_id, jid: r.jid, payload: ctx.sql.json(payload as any), source: "broadcast",
                priority: PRIORITY.bulk, not_before: new Date(), wa_id: newWaMessageId(), broadcast_id: broadcastId, recipient_id: Number(r.id),
            };
        });
        await ctx.sql.begin(async tx => {
            await tx`insert into outbox ${tx(rows)}`;
            await tx`update broadcast_recipients set status = 'queued' where id in ${tx(recips.map(r => r.id))}`;
        });
        queued += rows.length;
        lastId = Number(recips[recips.length - 1].id);
    }
    const [left] = await ctx.sql`select count(*)::int as n from outbox where broadcast_id = ${broadcastId} and status in ('queued','held','sending')`;
    if (left.n === 0) await ctx.sql`update broadcasts set status = 'completed', finished_at = now() where id = ${broadcastId} and status = 'running'`;
    await publishEvent(ctx.sql, { t: "broadcast", sessionId: b.session_id, broadcastId });
    wake(b.session_id);
    log.info({ broadcastId, queued }, "transmissão na fila");
}
