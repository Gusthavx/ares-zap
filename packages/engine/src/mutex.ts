/** Fila de promessas por chave: garante ordem e um avanço por contato de cada vez dentro do processo. */
export class KeyedMutex {
    private tails = new Map<string, Promise<unknown>>();

    run<T>(key: string, job: () => Promise<T>): Promise<T> {
        const prev = this.tails.get(key) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(job);
        this.tails.set(key, next);
        next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key); }).catch(() => undefined);
        return next;
    }

    get size() { return this.tails.size; }
}
