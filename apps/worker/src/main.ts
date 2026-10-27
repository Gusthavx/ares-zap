import { connect, enqueueJob, onCommands, publishEvent } from "@areszap/db";
import { FlowEngine, KeyedMutex, PgStore } from "@areszap/engine";
import { resolveSettings, type WorkerCommand } from "@areszap/core";
import { SessionInfoCache, log, type Ctx } from "./context";
import { JobRunner } from "./jobs";
import { Webhooks } from "./webhooks";
import { InboundPipeline } from "./pipeline";
import { SessionManager } from "./sessions";
import { startBroadcast } from "./broadcasts";
import { CloudProvider } from "./providers/cloud";

const { sql, close } = connect(process.env.DATABASE_URL, { max: Number(process.env.WORKER_DB_POOL || 15), appName: "areszap-worker" });
const sessionsCache = new SessionInfoCache(sql);
const hooks = new Webhooks(sql);
let manager: SessionManager;

const store = new PgStore(sql, { onOutbound: ids => ids.forEach(id => manager?.wake(id)) });
const mutex = new KeyedMutex();
const engine = new FlowEngine({
    store,
    settings: async id => (await sessionsCache.get(id))?.settings ?? resolveSettings({}),
    logger: { error: (msg, err) => log.error({ err }, msg) },
    onRunEnded: run => {
        void publishEvent(sql, { t: "run", sessionId: run.sessionId, flowId: run.flowId, runId: run.id, status: run.status });
        if (run.status === "completed" && !run.isTest) void hooks.emit(run.sessionId, "flow.completed", { runId: run.id, flowId: run.flowId, contactId: run.contactId, jid: run.jid });
    },
});

const ctx: Ctx = { sql, sessions: sessionsCache, store, engine, mutex };
const pipeline = new InboundPipeline(ctx, hooks);
manager = new SessionManager(ctx, pipeline, hooks);

// ---------- tarefas ----------
const jobs = new JobRunner(sql)
    .on("webhook.deliver", p => hooks.deliver(p))
    .on("broadcast.start", p => startBroadcast(ctx, p.broadcastId, id => manager.wake(id)))
    .on("cloud.inbound", async p => {
        const prov = manager.provider(p.sessionId);
        if (!(prov instanceof CloudProvider)) throw new Error("sessão da API oficial não está ativa neste worker");
        prov.handleWebhook(p.body);
    })
    .on("flow.start", async p => {
        // evento externo (API /v1/.../events) com início de fluxo: roda no worker, serializado por contato
        const contact = await store.getContact(p.contactId);
        if (!contact) return;
        const flow = p.flowId ? await store.getActiveFlow(contact.sessionId, p.flowId) : null;
        await mutex.run(`${contact.sessionId}:${contact.id}`, () => engine.externalEvent({ contact, fields: p.fields ?? {}, start: flow ? { flow, nodeId: p.nodeId } : undefined }));
    })
    .on("flow.test", async p => {
        const contact = await store.getContact(p.contactId);
        if (!contact) return;
        await mutex.run(`${contact.sessionId}:${contact.id}`, () => engine.startTest({ contact, flow: { id: p.flowId, name: p.name, version: 0, graph: p.graph, triggers: [] } }));
    })
    .on("run.cancel", async p => {
        const run = await store.getRun(p.runId);
        if (!run) return;
        await mutex.run(`${run.sessionId}:${run.contactId}`, () => engine.cancelActive(run.contactId, p.reason ?? "Cancelado pelo painel"));
    })
    .on("contact.takeover", async p => {
        await mutex.run(`${p.sessionId}:${p.contactId}`, () => engine.cancelActive(p.contactId, "Atendimento humano", { pauseUntil: new Date(p.until) }));
    })
    .on("cleanup", async () => {
        // retenção: logs de execução 30 dias, fila enviada 14 dias, tarefas 7 dias
        await sql`delete from flow_events where created_at < now() - interval '30 days'`;
        await sql`delete from outbox where status in ('sent','failed','cancelled','skipped') and created_at < now() - interval '14 days'`;
        await sql`delete from jobs where status in ('done','failed') and created_at < now() - interval '7 days'`;
        await enqueueJob(sql, "cleanup", {}, { runAt: new Date(Date.now() + 24 * 3600_000), dedupeKey: "cleanup" });
    });

// ---------- esperas vencidas dos fluxos ----------
let resuming = false;
async function resumeDue() {
    if (resuming) return;
    resuming = true;
    try {
        const due = await store.claimDueRuns(200);
        await Promise.all(due.map(run => mutex.run(`${run.sessionId}:${run.contactId}`, () => engine.resume(run))
            .catch(e => log.error({ err: e, run: run.id }, "falha ao retomar execução"))));
    } catch (e) {
        log.error({ err: e }, "falha no agendador de fluxos");
    } finally {
        resuming = false;
    }
}

// ---------- comandos do painel ----------
async function onCommand(c: WorkerCommand) {
    log.debug({ c }, "comando");
    switch (c.c) {
        case "session.start": return manager.start(c.sessionId);
        case "session.stop": return manager.stop(c.sessionId, { disable: true });
        case "session.logout": return manager.logout(c.sessionId);
        case "session.reload": return manager.reload(c.sessionId);
        case "outbox.wake": return manager.wake(c.sessionId);
        case "cache.invalidate":
            if (c.what === "flows" || c.what === "all") store.invalidate(c.sessionId);
            if (c.what === "settings" || c.what === "all") { sessionsCache.invalidate(c.sessionId); store.invalidate(c.sessionId); }
            if (c.what === "webhooks" || c.what === "all") hooks.invalidate();
            return;
    }
}

async function heartbeat() {
    await sql`insert into heartbeats (name, at, info) values ('worker', now(), ${sql.json({ sessions: manager.count, pid: process.pid, mutexKeys: mutex.size })})
              on conflict (name) do update set at = now(), info = excluded.info`.catch(() => undefined);
}

async function main() {
    await sql`select 1 from sessions limit 1`.catch(() => {
        throw new Error("Banco sem tabelas: rode `npm run db:migrate` antes de subir o worker");
    });
    await onCommands(sql, c => { onCommand(c).catch(e => log.error({ err: e, c }, "comando falhou")); });
    // execuções que ficaram "running" (não deveria acontecer: o motor só grava estados de espera/fim)
    await sql`update flow_runs set status = 'failed', error = 'Execução interrompida' where status = 'running' and updated_at < now() - interval '10 minutes'`;
    // itens que ficaram "sending" quando o worker caiu voltam para a fila
    await sql`update outbox set status = 'queued' where status = 'sending'`;
    await enqueueJob(sql, "cleanup", {}, { runAt: new Date(Date.now() + 3600_000), dedupeKey: "cleanup" });

    jobs.start(1000);
    setInterval(() => void resumeDue(), 5000);
    setInterval(() => void heartbeat(), 10_000);
    await heartbeat();
    await manager.bootstrap();
    log.info("worker pronto");
}

async function shutdown(sig: string) {
    log.info({ sig }, "encerrando worker");
    jobs.stop();
    await manager.stopAll();
    await close();
    process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", e => log.error({ err: e }, "promessa rejeitada sem tratamento"));

main().catch(e => { log.fatal({ err: e }, "worker não subiu"); process.exit(1); });
