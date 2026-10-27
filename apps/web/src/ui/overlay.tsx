import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "./button";

/** Modal com <dialog> nativo: foco, Esc e camada superior de graça. */
export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: {
    open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg";
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) {
            d.showModal();
            // showModal foca o primeiro botão (Fechar); preferimos o primeiro campo
            d.querySelector<HTMLElement>("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea")?.focus();
        }
        if (!open && d.open) d.close();
    }, [open]);
    const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";
    if (!open) return null;
    return (
        <dialog
            ref={ref}
            onCancel={e => { e.preventDefault(); onClose(); }}
            onMouseDown={e => { if (e.target === ref.current) onClose(); }}
            className={`m-auto w-[calc(100%-2rem)] ${width} animate-in rounded-lg border border-line bg-panel p-0 text-fg shadow-2xl backdrop:bg-black/50`}
        >
            <div className="flex max-h-[85vh] flex-col">
                <div className="flex items-start gap-3 px-5 pb-2 pt-4">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-[15px] font-semibold">{title}</h2>
                        {description && <p className="mt-1 text-[12.5px] text-muted">{description}</p>}
                    </div>
                    <IconButton title="Fechar" onClick={onClose}><X className="h-4 w-4" /></IconButton>
                </div>
                {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{children}</div>}
                {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
            </div>
        </dialog>
    );
}

/** Painel lateral à direita. */
export function Sheet({ open, onClose, title, children, footer, width = "max-w-md", actions }: {
    open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; actions?: ReactNode;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
    }, [open]);
    if (!open) return null;
    return (
        <dialog
            ref={ref}
            onCancel={e => { e.preventDefault(); onClose(); }}
            onMouseDown={e => { if (e.target === ref.current) onClose(); }}
            className={`fixed inset-y-0 left-auto right-0 m-0 h-full max-h-none w-full ${width} animate-sheet border-l border-line bg-panel p-0 text-fg backdrop:bg-black/40`}
        >
            <div className="flex h-full flex-col">
                <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
                    <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h2>
                    {actions}
                    <IconButton title="Fechar" onClick={onClose}><X className="h-4 w-4" /></IconButton>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
                {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
            </div>
        </dialog>
    );
}

/** Fecha ao clicar fora / Esc. */
export function useDismiss(open: boolean, close: () => void) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open, close]);
    return ref;
}

export function Popover({ trigger, children, align = "left", width = "w-56", open: controlled, onOpenChange, className = "inline-block", up }: {
    trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode);
    align?: "left" | "right"; width?: string; open?: boolean; onOpenChange?: (o: boolean) => void; className?: string; up?: boolean;
}) {
    const [inner, setInner] = useState(false);
    const open = controlled ?? inner;
    const set = (o: boolean) => { onOpenChange?.(o); if (controlled === undefined) setInner(o); };
    const ref = useDismiss(open, () => set(false));
    return (
        <div ref={ref} className={`relative ${className}`}>
            {trigger({ open, toggle: () => set(!open) })}
            {open && (
                <div className={`absolute z-50 ${up ? "bottom-full mb-1" : "top-full mt-1"} ${align === "right" ? "right-0" : "left-0"} ${width} animate-in rounded-md border border-line bg-panel p-1 shadow-xl`}>
                    {typeof children === "function" ? children(() => set(false)) : children}
                </div>
            )}
        </div>
    );
}

export function MenuItem({ children, onClick, danger, icon, disabled }: { children: ReactNode; onClick: () => void; danger?: boolean; icon?: ReactNode; disabled?: boolean }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-subtle disabled:opacity-40 ${danger ? "text-bad" : ""}`}
        >
            {icon && <span className="text-muted [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}{children}
        </button>
    );
}

// ---------- confirmação imperativa ----------
interface ConfirmReq { title: string; body?: ReactNode; confirm?: string; danger?: boolean; resolve: (ok: boolean) => void }
let confirmState: ConfirmReq | null = null;
const confirmSubs = new Set<() => void>();
const emitConfirm = () => confirmSubs.forEach(f => f());

export function confirm(opts: Omit<ConfirmReq, "resolve">): Promise<boolean> {
    return new Promise(resolve => { confirmState = { ...opts, resolve }; emitConfirm(); });
}

export function ConfirmHost() {
    const req = useSyncExternalStore(cb => { confirmSubs.add(cb); return () => confirmSubs.delete(cb); }, () => confirmState);
    const done = (ok: boolean) => { req?.resolve(ok); confirmState = null; emitConfirm(); };
    return (
        <Dialog open={!!req} onClose={() => done(false)} title={req?.title} size="sm"
            footer={<>
                <Button onClick={() => done(false)}>Cancelar</Button>
                <Button variant={req?.danger ? "danger" : "primary"} onClick={() => done(true)} autoFocus>{req?.confirm ?? "Confirmar"}</Button>
            </>}>
            {req?.body && <div className="text-[13.5px] text-muted">{req.body}</div>}
        </Dialog>
    );
}
