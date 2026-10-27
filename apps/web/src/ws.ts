// Tempo real: um WebSocket por aba, reconexão exponencial e invalidação das queries afetadas.
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { BusEvent } from "@areszap/core";
import { qk, type Session } from "./api";

export type WsState = "connecting" | "open" | "closed";

let state: WsState = "closed";
const stateSubs = new Set<() => void>();
const setState = (s: WsState) => { if (s !== state) { state = s; stateSubs.forEach(f => f()); } };

const listeners = new Set<(e: BusEvent) => void>();

/** Escuta eventos brutos (ex.: QR chegando). */
export function onBusEvent(fn: (e: BusEvent) => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function useWsState(): WsState {
    return useSyncExternalStore(cb => { stateSubs.add(cb); return () => stateSubs.delete(cb); }, () => state);
}

// Junta invalidações em rajada (transmissão manda muitos eventos) num intervalo curto.
function batcher(client: QueryClient) {
    const pending = new Map<string, QueryKey>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (key: QueryKey) => {
        pending.set(JSON.stringify(key), key);
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            const keys = [...pending.values()];
            pending.clear();
            for (const k of keys) client.invalidateQueries({ queryKey: k });
        }, 250);
    };
}

function apply(client: QueryClient, invalidate: (k: QueryKey) => void, e: BusEvent) {
    switch (e.t) {
        case "session.status": {
            const patch = (s: Session): Session => s.id !== e.sessionId ? s : {
                ...s, status: e.status,
                ...(e.phone !== undefined ? { phone: e.phone } : {}),
                ...(e.qr !== undefined ? { qr: e.qr } : {}),
                ...(e.error !== undefined ? { lastError: e.error } : {}),
            };
            client.setQueryData<Session[]>(qk.sessions, list => list?.map(patch));
            client.setQueryData<Session>(qk.session(e.sessionId), s => (s ? patch(s) : s));
            invalidate(qk.stats(e.sessionId));
            // o evento pode chegar fora de ordem: confere com o banco logo depois
            invalidate(qk.session(e.sessionId));
            invalidate(qk.sessions);
            break;
        }
        case "message":
            invalidate(qk.messages(e.chatId));
            invalidate(qk.chats(e.sessionId));
            invalidate(qk.chat(e.chatId));
            break;
        case "message.status":
            invalidate(qk.messages(e.chatId));
            break;
        case "chat":
            invalidate(qk.chats(e.sessionId));
            invalidate(qk.chat(e.chatId));
            break;
        case "broadcast":
            invalidate(qk.broadcasts(e.sessionId));
            invalidate(qk.broadcast(e.broadcastId));
            invalidate(qk.recipients(e.broadcastId));
            invalidate(qk.stats(e.sessionId));
            break;
        case "run":
            invalidate(qk.flows(e.sessionId));
            invalidate(qk.flowStats(e.flowId));
            invalidate(qk.flowRuns(e.flowId));
            invalidate(qk.chats(e.sessionId));
            break;
    }
}

/** Liga o WebSocket enquanto houver usuário logado. Montar uma vez no layout. */
export function useRealtime(enabled: boolean) {
    const client = useQueryClient();
    useEffect(() => {
        if (!enabled) return;
        const invalidate = batcher(client);
        let ws: WebSocket | null = null;
        let attempt = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;
        let everOpened = false;

        const connect = () => {
            if (stopped) return;
            setState("connecting");
            const proto = location.protocol === "https:" ? "wss:" : "ws:";
            ws = new WebSocket(`${proto}//${location.host}/ws`);
            ws.onopen = () => {
                attempt = 0;
                setState("open");
                // eventos perdidos enquanto estava fora: recarrega o que está na tela
                if (everOpened) client.invalidateQueries();
                everOpened = true;
            };
            ws.onmessage = ev => {
                let e: BusEvent;
                try { e = JSON.parse(String(ev.data)); } catch { return; }
                if (!e || typeof e !== "object" || !("t" in e)) return;
                apply(client, invalidate, e);
                listeners.forEach(fn => fn(e));
            };
            ws.onclose = () => {
                setState("closed");
                ws = null;
                if (stopped) return;
                const base = Math.min(30_000, 1000 * 2 ** attempt);
                attempt++;
                timer = setTimeout(connect, base / 2 + Math.random() * (base / 2));
            };
            ws.onerror = () => ws?.close();
        };

        const onVisible = () => { if (document.visibilityState === "visible" && !ws && timer) { clearTimeout(timer); attempt = 0; connect(); } };
        document.addEventListener("visibilitychange", onVisible);
        // adiado um tique: no StrictMode o efeito monta e desmonta na hora, sem abrir socket à toa
        timer = setTimeout(connect, 0);
        return () => {
            stopped = true;
            document.removeEventListener("visibilitychange", onVisible);
            if (timer) clearTimeout(timer);
            ws?.close();
            setState("closed");
        };
    }, [enabled, client]);
}
