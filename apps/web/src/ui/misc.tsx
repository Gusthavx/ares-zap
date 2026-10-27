import { useState, type ReactNode } from "react";
import { Check, Copy, Loader2 } from "lucide-react";

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
    return <Loader2 className={`animate-spin ${className}`} aria-hidden />;
}

export function PageLoader() {
    return <div className="flex h-full min-h-40 items-center justify-center text-muted"><Spinner /></div>;
}

export type Tone = "ok" | "warn" | "bad" | "neutral";
const DOT: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", neutral: "bg-faint" };
const TEXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad", neutral: "text-muted" };

export function Dot({ tone = "neutral", className = "" }: { tone?: Tone; className?: string }) {
    return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]} ${className}`} aria-hidden />;
}

/** Rótulo de estado: ponto + texto. A cor só aparece quando significa algo. */
export function Status({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
    return (
        <span className={`inline-flex items-center gap-1.5 text-[12.5px] ${tone === "neutral" ? "text-muted" : TEXT[tone]} ${className}`}>
            <Dot tone={tone} />{children}
        </span>
    );
}

export function Tag({ children, className = "" }: { children: ReactNode; className?: string }) {
    return <span className={`inline-flex items-center gap-1 rounded border border-line px-1.5 py-px text-[11.5px] text-muted ${className}`}>{children}</span>;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
    return (
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
                <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
                {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
    );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
    return (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-14 text-center">
            <p className="font-medium">{title}</p>
            {children && <p className="mt-1 max-w-sm text-[13px] text-muted">{children}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

export function ErrorLine({ error }: { error: unknown }) {
    if (!error) return null;
    const msg = error instanceof Error ? error.message : String(error);
    return <p className="text-[13px] text-bad">{msg}</p>;
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
    return (
        <section className="border-t border-line py-6 first:border-t-0 first:pt-0">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h2 className="text-[14.5px] font-semibold">{title}</h2>
                    {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
                </div>
                {actions}
            </div>
            {children}
        </section>
    );
}

export function CopyButton({ value, label = "Copiar" }: { value: string; label?: string }) {
    const [done, setDone] = useState(false);
    return (
        <button
            type="button"
            onClick={async () => {
                try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* sem permissão */ }
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-muted hover:bg-subtle hover:text-fg"
        >
            {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{done ? "Copiado" : label}
        </button>
    );
}

/** Valor secreto mostrado uma única vez. */
export function SecretBox({ value, hint }: { value: string; hint: string }) {
    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-md border border-line bg-subtle px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{value}</code>
                <CopyButton value={value} />
            </div>
            <p className="text-[12px] text-warn">{hint}</p>
        </div>
    );
}

export function Progress({ value, max }: { value: number; max: number }) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    return (
        <div className="h-1 w-full overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
            <div className="h-full rounded-full bg-fg transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
    );
}

export function Kbd({ children }: { children: ReactNode }) {
    return <kbd className="rounded border border-line px-1 font-mono text-[10.5px] text-muted">{children}</kbd>;
}

/** Contêiner padrão das páginas com rolagem própria. */
export function Page({ children, width = "max-w-5xl" }: { children: ReactNode; width?: string }) {
    return <div className={`mx-auto w-full ${width} px-4 py-6 sm:px-8 sm:py-8`}>{children}</div>;
}

/** Abas em forma de links/botões sublinhados. */
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
    return (
        <div className="-mx-4 mb-6 overflow-x-auto overflow-y-hidden border-b border-line px-4 [scrollbar-width:none] sm:mx-0 sm:px-0">
            <div className="flex gap-5">
                {items.map(i => (
                    <button key={i.value} type="button" onClick={() => onChange(i.value)}
                        className={`-mb-px whitespace-nowrap border-b py-2 text-[13.5px] transition-colors ${value === i.value ? "border-fg font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}>
                        {i.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
