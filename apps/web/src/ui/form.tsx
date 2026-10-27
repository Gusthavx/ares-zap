import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

const FIELD = "w-full rounded-md border border-line bg-bg px-3 text-[13.5px] outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-fg disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = "", ...p }, ref) {
    return <input ref={ref} className={`${FIELD} h-9 ${className}`} {...p} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className = "", ...p }, ref) {
    return <textarea ref={ref} className={`${FIELD} resize-y py-2 leading-relaxed ${className}`} {...p} />;
});

export interface Option { value: string; label: string; disabled?: boolean }

export function Select({ options, placeholder, className = "", value, ...p }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & { options: (Option | { group: string; options: Option[] })[]; placeholder?: string }) {
    return (
        <div className={`relative ${className}`}>
            <select value={value ?? ""} className={`${FIELD} h-9 appearance-none pr-8 ${!value ? "text-faint" : ""}`} {...p}>
                {placeholder !== undefined && <option value="" disabled>{placeholder}</option>}
                {options.map((o, i) => "group" in o
                    ? <optgroup key={i} label={o.group}>{o.options.map(x => <option key={x.value} value={x.value} disabled={x.disabled} className="text-fg">{x.label}</option>)}</optgroup>
                    : <option key={o.value} value={o.value} disabled={o.disabled} className="text-fg">{o.label}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        </div>
    );
}

export function Field({ label, hint, error, children, className = "", htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
    return (
        <div className={`space-y-1.5 ${className}`}>
            {label && <label htmlFor={htmlFor} className="block text-[12.5px] font-medium">{label}</label>}
            {children}
            {error ? <p className="text-[12px] text-bad">{error}</p> : hint ? <p className="text-[12px] text-muted">{hint}</p> : null}
        </div>
    );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
    const id = useId();
    const control = (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-45 ${checked ? "border-fg bg-fg" : "border-line-strong bg-subtle"}`}
        >
            <span className={`inline-block h-3 w-3 rounded-full transition-transform duration-150 ${checked ? "translate-x-[15px] bg-bg" : "translate-x-[2px] bg-muted"}`} />
        </button>
    );
    if (!label) return control;
    return (
        <div className="flex items-start justify-between gap-4">
            <label htmlFor={id} className="min-w-0 cursor-pointer">
                <span className="block text-[13.5px]">{label}</span>
                {description && <span className="block text-[12px] text-muted">{description}</span>}
            </label>
            <div className="pt-0.5">{control}</div>
        </div>
    );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
    return (
        <label className={`inline-flex cursor-pointer select-none items-center gap-2 text-[13.5px] ${disabled ? "opacity-50" : ""}`}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--fg)]" />
            {label}
        </label>
    );
}

/** Controle segmentado (abas pequenas). */
export function Segmented<T extends string>({ value, onChange, options, className = "" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; className?: string }) {
    return (
        <div className={`inline-flex rounded-md border border-line p-0.5 ${className}`} role="tablist">
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={value === o.value}
                    onClick={() => onChange(o.value)}
                    className={`flex-1 whitespace-nowrap rounded px-2.5 py-1 text-[12.5px] transition-colors ${value === o.value ? "bg-subtle font-medium text-fg" : "text-muted hover:text-fg"}`}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function NumberInput({ value, onChange, min, max, step, className = "", ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
    return (
        <Input
            type="number"
            inputMode="decimal"
            value={Number.isFinite(value) ? value : ""}
            min={min}
            max={max}
            step={step}
            className={`tabular ${className}`}
            onChange={e => {
                const n = Number(e.target.value);
                if (e.target.value === "" || Number.isNaN(n)) return onChange(min ?? 0);
                onChange(n);
            }}
            onBlur={() => {
                let n = value;
                if (min !== undefined && n < min) n = min;
                if (max !== undefined && n > max) n = max;
                if (n !== value) onChange(n);
            }}
            {...p}
        />
    );
}
