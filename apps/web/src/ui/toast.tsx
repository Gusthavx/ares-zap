import { useSyncExternalStore } from "react";
import { X } from "lucide-react";

type Kind = "info" | "success" | "error";
interface Toast { id: number; kind: Kind; text: string; action?: { label: string; onClick: () => void } }

let list: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach(f => f());

function push(kind: Kind, text: string, opts?: { action?: Toast["action"]; duration?: number }) {
    const id = ++seq;
    list = [...list.slice(-3), { id, kind, text, action: opts?.action }];
    emit();
    setTimeout(() => dismiss(id), opts?.duration ?? (kind === "error" ? 7000 : 3500));
    return id;
}
function dismiss(id: number) { list = list.filter(t => t.id !== id); emit(); }

export const toast = {
    info: (t: string, o?: { action?: Toast["action"]; duration?: number }) => push("info", t, o),
    success: (t: string, o?: { action?: Toast["action"]; duration?: number }) => push("success", t, o),
    error: (t: unknown, o?: { action?: Toast["action"]; duration?: number }) => push("error", t instanceof Error ? t.message : String(t), o),
};

export function ToastHost() {
    const items = useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb); }, () => list);
    return (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4" aria-live="polite">
            {items.map(t => (
                <div key={t.id} className="pointer-events-auto flex max-w-sm animate-in items-start gap-3 rounded-md border border-line bg-panel px-3.5 py-2.5 text-[13px] shadow-xl">
                    <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${t.kind === "error" ? "bg-bad" : t.kind === "success" ? "bg-ok" : "bg-faint"}`} />
                    <p className={`flex-1 ${t.kind === "error" ? "text-bad" : ""}`}>{t.text}</p>
                    {t.action && <button type="button" className="font-medium underline underline-offset-2" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
                    <button type="button" className="text-muted hover:text-fg" aria-label="Fechar" onClick={() => dismiss(t.id)}><X className="h-3.5 w-3.5" /></button>
                </div>
            ))}
        </div>
    );
}
