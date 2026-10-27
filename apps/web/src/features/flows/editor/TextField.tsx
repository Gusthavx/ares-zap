// Adaptado do MarcFlow (MIT, Marcos Maia) — src/components/flows/text-field.tsx
import { useRef, useState } from "react";
import { Bold, Braces, Italic, Strikethrough } from "lucide-react";
import { Popover } from "@/ui/overlay";
import { Input } from "@/ui/form";
import { useEditor, variableGroups } from "./context";

interface Props {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    rows?: number;
    maxLength?: number;
    /** Botões de *negrito* _itálico_ ~tachado~ do WhatsApp. */
    formatting?: boolean;
}

/** Área de texto com formatação do WhatsApp e seletor de {variável}. */
export function TextField({ value, onChange, placeholder, rows = 3, maxLength = 4096, formatting = true }: Props) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const { meta } = useEditor();
    const [q, setQ] = useState("");

    const insert = (before: string, after = "") => {
        const el = ref.current;
        const start = el?.selectionStart ?? value.length;
        const end = el?.selectionEnd ?? value.length;
        const next = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end);
        onChange(next.slice(0, maxLength));
        requestAnimationFrame(() => {
            el?.focus();
            const pos = start + before.length + (end - start) + after.length;
            el?.setSelectionRange(pos, pos);
        });
    };

    const groups = variableGroups(meta)
        .map(g => ({ ...g, items: g.items.filter(i => !q || i.label.toLowerCase().includes(q.toLowerCase()) || i.key.includes(q.toLowerCase())) }))
        .filter(g => g.items.length);

    return (
        <div className="rounded-md border border-line bg-bg transition-colors focus-within:border-fg">
            <textarea
                ref={ref}
                value={value}
                rows={rows}
                maxLength={maxLength}
                placeholder={placeholder}
                onChange={e => onChange(e.target.value)}
                className="block w-full resize-y rounded-t-md bg-transparent px-3 pt-2 text-[13px] leading-relaxed outline-none placeholder:text-faint"
            />
            <div className="flex items-center gap-0.5 px-1.5 pb-1">
                {formatting && (
                    <>
                        <ToolBtn title="Negrito (*texto*)" onClick={() => insert("*", "*")}><Bold className="h-3.5 w-3.5" /></ToolBtn>
                        <ToolBtn title="Itálico (_texto_)" onClick={() => insert("_", "_")}><Italic className="h-3.5 w-3.5" /></ToolBtn>
                        <ToolBtn title="Tachado (~texto~)" onClick={() => insert("~", "~")}><Strikethrough className="h-3.5 w-3.5" /></ToolBtn>
                    </>
                )}
                <Popover width="w-64" onOpenChange={o => { if (!o) setQ(""); }} trigger={({ toggle }) => (
                    <ToolBtn title="Inserir variável" onClick={toggle}><Braces className="h-3.5 w-3.5" /></ToolBtn>
                )}>
                    {close => (
                        <div className="p-1">
                            <Input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar campo" className="mb-1.5 h-8" />
                            <div className="max-h-60 overflow-y-auto">
                                {groups.map(g => (
                                    <div key={g.label} className="mb-1">
                                        <p className="px-2 py-1 text-[10.5px] font-medium uppercase tracking-wide text-muted">{g.label}</p>
                                        {g.items.map(i => (
                                            <button key={i.key} type="button" className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-subtle"
                                                onClick={() => { insert(`{${i.key}}`); close(); }}>
                                                <span className="truncate">{i.label}</span><span className="shrink-0 font-mono text-[10.5px] text-muted">{`{${i.key}}`}</span>
                                            </button>
                                        ))}
                                    </div>
                                ))}
                                {!groups.length && <p className="p-2 text-[13px] text-muted">Nenhum campo encontrado</p>}
                            </div>
                        </div>
                    )}
                </Popover>
                <span className="tabular ml-auto pr-1 text-[10.5px] text-faint">{value.length}/{maxLength}</span>
            </div>
        </div>
    );
}

function ToolBtn({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return <button type="button" className="rounded p-1.5 text-muted hover:bg-subtle hover:text-fg" {...p}>{children}</button>;
}

/** Mostra a marcação do WhatsApp e as {variáveis} nos cartões dos blocos. */
export function PreviewText({ text, className }: { text: string; className?: string }) {
    const parts = text.split(/(\{[^}]+\}|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
    return (
        <span className={className}>
            {parts.map((p, i) => {
                if (/^\{[^}]+\}$/.test(p)) return <span key={i} className="rounded bg-subtle px-0.5 font-mono text-[0.92em]">{p}</span>;
                if (/^\*.+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>;
                if (/^_.+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>;
                if (/^~.+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>;
                return p;
            })}
        </span>
    );
}
