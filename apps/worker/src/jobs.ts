import type postgres from "postgres";
import { log } from "./context";

export interface JobRow { id: number; kind: string; payload: any; attempts: number; maxAttempts: number }
export type JobHandler = (payload: any, job: JobRow) => Promise<void>;

/** Espera entre tentativas: 10 s, 1 min, 5 min, 30 min, 2 h. */
const BACKOFF_S = [10, 60, 300, 1800, 7200];

/**
 * Fila única persistente (tabela jobs): agendamentos, webhooks, transmissões e limpeza.
 * Reivindicação com SKIP LOCKED, então dá para rodar mais de um worker.
 */
export class JobRunner {
    private handlers = new Map<string, JobHandler>();
    private running = 0;
    private timer: NodeJS.Timeout | null = null;
    private busy = false;

    constructor(private sql: postgres.Sql, private concurrency = 8) { }

    on(kind: string, h: JobHandler) { this.handlers.set(kind, h); return this; }

    start(intervalMs = 1000) {
        this.timer = setInterval(() => void this.tick(), intervalMs);
        void this.recover();
    }

    stop() { if (this.timer) clearInterval(this.timer); }

    /** Tarefas presas em "running" (worker caiu no meio) voltam para a fila. */
    private async recover() {
        await this.sql`update jobs set status = 'queued', locked_until = null where status = 'running' and locked_until < now()`.catch(() => undefined);
    }

    async tick() {
        if (this.busy) return;
        const free = this.concurrency - this.running;
        if (free <= 0) return;
        this.busy = true;
        try {
            const rows = await this.sql`
                with c as (
                    select id from jobs where status = 'queued' and run_at <= now()
                    order by run_at, id limit ${free} for update skip locked
                )
                update jobs j set status = 'running', attempts = j.attempts + 1, locked_until = now() + interval '10 minutes'
                from c where j.id = c.id
                returning j.id, j.kind, j.payload, j.attempts, j.max_attempts`;
            for (const r of rows) {
                const job: JobRow = { id: Number(r.id), kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts };
                this.running++;
                void this.exec(job).finally(() => { this.running--; });
            }
        } catch (e) {
            log.error({ err: e }, "falha ao buscar tarefas");
        } finally {
            this.busy = false;
        }
    }

    private async exec(job: JobRow) {
        const h = this.handlers.get(job.kind);
        try {
            if (!h) throw new Error(`tarefa desconhecida: ${job.kind}`);
            await h(job.payload, job);
            await this.sql`update jobs set status = 'done', locked_until = null where id = ${job.id}`;
        } catch (e) {
            const msg = (e as Error).message?.slice(0, 500) ?? String(e);
            if (job.attempts >= job.maxAttempts) {
                await this.sql`update jobs set status = 'failed', last_error = ${msg}, locked_until = null where id = ${job.id}`;
                log.warn({ job: job.kind, id: job.id, err: msg }, "tarefa falhou de vez");
            } else {
                const wait = BACKOFF_S[Math.min(job.attempts - 1, BACKOFF_S.length - 1)];
                await this.sql`update jobs set status = 'queued', last_error = ${msg}, locked_until = null,
                               run_at = now() + ${wait} * interval '1 second' where id = ${job.id}`;
            }
        }
    }
}
