// Adaptado do MarcFlow (MIT, Marcos Maia) — src/components/flows/block-panel.tsx
import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Contact, Copy, File, HelpCircle, Image as ImageIcon, Mic, Plus, Timer, Trash2, Type, Upload, Video, X } from "lucide-react";
import {
    ANSWER_TYPES, BLOCKS, LIST_MAX_ROWS, POLL_MAX_OPTIONS, POLL_MAX_QUESTION, WEEKDAYS, newId,
    type AnswerType, type ConditionData, type ConditionOp, type ConditionSource, type ContentItem, type FieldScope, type FieldType,
    type FlowAction, type FlowCondition, type FlowNode, type MediaKind, type MenuData, type NodeDataMap, type RandomizerData, type SmartDelayData, type TimeUnit,
} from "@areszap/core";
import { api } from "@/api";
import { slug } from "@/lib/hooks";
import { Button, IconButton } from "@/ui/button";
import { Checkbox, Field, Input, NumberInput, Segmented, Select, Textarea, type Option } from "@/ui/form";
import { Dialog } from "@/ui/overlay";
import { Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { BLOCK_ICONS } from "./BlockNode";
import { useEditor } from "./context";
import { TextField } from "./TextField";

// ---------- peças pequenas ----------
function Sec({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
    return (
        <div className="space-y-1.5">
            <p className="text-[12.5px] font-medium">{title}</p>
            {children}
            {hint && <p className="text-[11.5px] text-muted">{hint}</p>}
        </div>
    );
}

function Card({ title, onUp, onDown, onCopy, onDelete, children }: { title: string; onUp?: () => void; onDown?: () => void; onCopy?: () => void; onDelete: () => void; children: ReactNode }) {
    return (
        <div className="space-y-2 rounded-md border border-line p-3">
            <div className="flex items-center gap-0.5">
                <span className="mr-auto text-[11px] font-medium uppercase tracking-wide text-muted">{title}</span>
                {onUp && <IconButton title="Subir" onClick={onUp}><ArrowUp className="h-3.5 w-3.5" /></IconButton>}
                {onDown && <IconButton title="Descer" onClick={onDown}><ArrowDown className="h-3.5 w-3.5" /></IconButton>}
                {onCopy && <IconButton title="Duplicar" onClick={onCopy}><Copy className="h-3.5 w-3.5" /></IconButton>}
                <IconButton title="Excluir" className="hover:!text-bad" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></IconButton>
            </div>
            {children}
        </div>
    );
}

function AddButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong py-2 text-[13px] text-muted transition-colors hover:border-fg hover:text-fg">
            <Plus className="h-3.5 w-3.5" />{children}
        </button>
    );
}

/** Select que funciona como botão "adicionar" (volta ao vazio após escolher). */
function AddSelect({ label, options, onPick }: { label: string; options: Option[]; onPick: (v: string) => void }) {
    return (
        <div className="relative">
            <div className="pointer-events-none flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong py-2 text-[13px] text-muted">
                <Plus className="h-3.5 w-3.5" />{label}
            </div>
            <select aria-label={label} value="" onChange={e => e.target.value && onPick(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
                <option value="" disabled>{label}</option>
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        </div>
    );
}

const UNITS: { value: TimeUnit; label: string }[] = [
    { value: "seconds", label: "Segundos" }, { value: "minutes", label: "Minutos" }, { value: "hours", label: "Horas" }, { value: "days", label: "Dias" },
];

function Expire({ value, unit, onChange }: { value: number; unit: TimeUnit; onChange: (v: number, u: TimeUnit) => void }) {
    return (
        <div className="flex gap-2">
            <NumberInput min={1} className="w-24" value={value} onChange={v => onChange(Math.max(1, Math.round(v) || 1), unit)} />
            <Select className="flex-1" value={unit} onChange={e => onChange(value, e.target.value as TimeUnit)} options={UNITS} />
        </div>
    );
}

// ---------- seletor de campo com "criar campo" ----------
function FieldPicker({ fieldKey, scope, onChange, includeSystem }: { fieldKey?: string; scope?: FieldScope; onChange: (key: string, scope: FieldScope, type: FieldType) => void; includeSystem?: boolean }) {
    const { meta, addField } = useEditor();
    const [open, setOpen] = useState(false);
    const [label, setLabel] = useState("");
    const [newScope, setNewScope] = useState<FieldScope>("CONTACT");
    const [busy, setBusy] = useState(false);

    const isSys = includeSystem && !!fieldKey && meta.systemFields.some(f => f.key === fieldKey);
    const value = fieldKey ? `${isSys ? "SYS" : scope === "BOT" ? "BOT" : "CONTACT"}:${fieldKey}` : "";
    const contact = meta.fields.filter(f => f.scope === "CONTACT");
    const bot = meta.fields.filter(f => f.scope === "BOT");
    // campo vindo de importação que o editor ainda não conhece
    const unknown = fieldKey && !isSys && !meta.fields.some(f => f.key === fieldKey) ? [{ value, label: fieldKey }] : [];

    const choose = (v: string) => {
        if (v === "__new") { setLabel(""); setOpen(true); return; }
        const i = v.indexOf(":");
        const s = v.slice(0, i), key = v.slice(i + 1);
        const t = s === "SYS" ? meta.systemFields.find(f => f.key === key)?.type : meta.fields.find(f => f.key === key)?.type;
        onChange(key, s === "BOT" ? "BOT" : "CONTACT", t || "TEXT");
    };

    const key = slug(label);
    const create = async () => {
        if (!key) return;
        setBusy(true);
        try {
            await addField({ key, label: label.trim(), type: "TEXT", scope: newScope });
            onChange(key, newScope, "TEXT");
            setOpen(false);
        } catch (e) { toast.error(e); } finally { setBusy(false); }
    };

    return (
        <>
            <Select value={value} onChange={e => choose(e.target.value)} placeholder="Escolha o campo" options={[
                { value: "__new", label: "+ Criar novo campo" },
                ...unknown,
                ...(includeSystem ? [{ group: "Campos do sistema", options: meta.systemFields.map(f => ({ value: `SYS:${f.key}`, label: f.label })) }] : []),
                ...(contact.length ? [{ group: "Campos do contato", options: contact.map(f => ({ value: `CONTACT:${f.key}`, label: f.label })) }] : []),
                ...(bot.length ? [{ group: "Campos do robô", options: bot.map(f => ({ value: `BOT:${f.key}`, label: f.label })) }] : []),
            ]} />
            <Dialog open={open} onClose={() => setOpen(false)} title="Criar campo" size="sm"
                footer={<><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!key} onClick={create}>Criar campo</Button></>}>
                <div className="space-y-3">
                    <Field label="Nome" hint={key ? <>Usado nos textos como <code className="font-mono">{`{${key}}`}</code></> : "Ex.: E-mail, Cidade, Plano"}>
                        <Input autoFocus value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => e.key === "Enter" && create()} />
                    </Field>
                    <Field label="Tipo">
                        <Segmented value={newScope} onChange={setNewScope} className="w-full" options={[{ value: "CONTACT", label: "Do contato" }, { value: "BOT", label: "Do robô (global)" }]} />
                    </Field>
                    <p className="text-[12px] text-muted">{newScope === "CONTACT" ? "Um valor por pessoa (ex.: e-mail informado)." : "Um valor para todos os contatos (ex.: preço, link). Edite em Contatos → Variáveis do robô."}</p>
                </div>
            </Dialog>
        </>
    );
}

// ---------- mídia ----------
const ACCEPT: Record<MediaKind, string> = { image: "image/jpeg,image/png,image/webp", video: "video/mp4,video/3gpp", audio: "audio/mpeg,audio/ogg,audio/mp4,audio/aac,audio/amr", file: "*/*" };
const MEDIA_HINT: Record<MediaKind, string> = { image: "JPG, PNG ou WEBP", video: "MP4", audio: "MP3, OGG ou M4A (vai como áudio gravado)", file: "Qualquer arquivo até 64 MB" };

function MediaEditor({ item, onChange }: { item: Extract<ContentItem, { kind: MediaKind }>; onChange: (it: ContentItem) => void }) {
    const { sessionId } = useEditor();
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const upload = async (file: File) => {
        setBusy(true);
        try {
            const a = await api.assets.upload(sessionId, file);
            onChange({ ...item, assetId: a.id, url: undefined, fileName: a.fileName });
        } catch (e) { toast.error(e); } finally { setBusy(false); }
    };
    return (
        <div className="space-y-2">
            <input ref={input} type="file" accept={ACCEPT[item.kind]} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
            {item.assetId ? (
                <div className="flex items-center gap-2 rounded-md border border-line p-2">
                    {item.kind === "image"
                        ? <img src={api.assets.fileUrl(item.assetId)} alt="" className="h-11 w-11 rounded object-cover" />
                        : <File className="h-4 w-4 text-muted" />}
                    <span className="min-w-0 flex-1 truncate text-[13px]">{item.fileName}</span>
                    <IconButton title="Trocar arquivo" onClick={() => input.current?.click()}>{busy ? <Spinner className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}</IconButton>
                </div>
            ) : (
                <button type="button" onClick={() => input.current?.click()} disabled={busy}
                    className="flex w-full flex-col items-center gap-1 rounded-md border border-dashed border-line-strong py-4 text-[13px] text-muted hover:border-fg hover:text-fg">
                    {busy ? <Spinner /> : <Upload className="h-4 w-4" />}
                    <span className="font-medium">Enviar arquivo</span>
                    <span className="text-[11px]">{MEDIA_HINT[item.kind]}</span>
                </button>
            )}
            {!item.assetId && <Input placeholder="ou cole um link público (https://…)" value={item.url || ""} onChange={e => onChange({ ...item, url: e.target.value || undefined })} />}
            {item.kind === "file" && <Input placeholder="Nome do arquivo para o contato" value={item.fileName || ""} onChange={e => onChange({ ...item, fileName: e.target.value })} />}
            {item.kind !== "audio" && <TextField value={item.caption || ""} onChange={v => onChange({ ...item, caption: v })} placeholder="Legenda (opcional)" rows={2} />}
        </div>
    );
}

// ---------- editores por tipo ----------
const CONTENT_ADD: { kind: ContentItem["kind"]; label: string; icon: typeof Type }[] = [
    { kind: "text", label: "Texto", icon: Type }, { kind: "image", label: "Imagem", icon: ImageIcon }, { kind: "video", label: "Vídeo", icon: Video },
    { kind: "audio", label: "Áudio", icon: Mic }, { kind: "file", label: "Arquivo", icon: File }, { kind: "input", label: "Pergunta", icon: HelpCircle },
    { kind: "delay", label: "Pausa", icon: Timer }, { kind: "vcard", label: "Contato", icon: Contact },
];

function newContentItem(kind: ContentItem["kind"]): ContentItem {
    const id = newId();
    switch (kind) {
        case "text": return { id, kind, text: "" };
        case "delay": return { id, kind, seconds: 3, typing: true };
        case "vcard": return { id, kind, name: "", phone: "" };
        case "input": return { id, kind, question: "", answerType: "text", expireValue: 1, expireUnit: "days", errorMessage: "Não entendi sua resposta. Pode tentar de novo?", maxAttempts: 3 };
        default: return { id, kind } as ContentItem;
    }
}

const ITEM_TITLE: Record<ContentItem["kind"], string> = { text: "Texto", image: "Imagem", video: "Vídeo", audio: "Áudio", file: "Arquivo", delay: "Pausa", vcard: "Cartão de contato", input: "Pergunta (salva a resposta)" };

function ContentEditor({ node, set }: { node: FlowNode<"content">; set: (d: NodeDataMap["content"]) => void }) {
    const items = node.data.items;
    const update = (i: number, it: ContentItem) => set({ items: items.map((x, k) => (k === i ? it : x)) });
    const move = (i: number, d: number) => { const a = [...items]; [a[i], a[i + d]] = [a[i + d], a[i]]; set({ items: a }); };
    return (
        <div className="space-y-3">
            {items.map((it, i) => (
                <Card key={it.id} title={ITEM_TITLE[it.kind]}
                    onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < items.length - 1 ? () => move(i, 1) : undefined}
                    onCopy={() => set({ items: [...items.slice(0, i + 1), { ...structuredClone(it), id: newId() }, ...items.slice(i + 1)] })}
                    onDelete={() => set({ items: items.filter((_, k) => k !== i) })}>
                    <ItemEditor item={it} onChange={x => update(i, x)} />
                </Card>
            ))}
            <div className="grid grid-cols-4 gap-1.5 pt-1">
                {CONTENT_ADD.map(a => (
                    <button key={a.kind} type="button" onClick={() => set({ items: [...items, newContentItem(a.kind)] })}
                        className="flex flex-col items-center gap-1 rounded-md border border-dashed border-line-strong py-2.5 text-[11.5px] text-muted transition-colors hover:border-fg hover:text-fg">
                        <a.icon className="h-4 w-4" strokeWidth={1.75} />{a.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function ItemEditor({ item, onChange }: { item: ContentItem; onChange: (it: ContentItem) => void }) {
    switch (item.kind) {
        case "text": return <TextField value={item.text} onChange={text => onChange({ ...item, text })} placeholder="Digite a mensagem" rows={4} />;
        case "image": case "video": case "audio": case "file": return <MediaEditor item={item} onChange={onChange} />;
        case "delay": return (
            <div className="space-y-2.5">
                <div className="flex items-center gap-3">
                    <input type="range" min={0} max={60} step={1} value={item.seconds} onChange={e => onChange({ ...item, seconds: Number(e.target.value) })} className="flex-1 accent-[var(--fg)]" aria-label="Segundos" />
                    <span className="tabular w-12 text-right text-[13px]">{item.seconds} s</span>
                </div>
                <Checkbox checked={item.typing} onChange={v => onChange({ ...item, typing: v })} label="Mostrar “digitando…” durante a pausa" />
            </div>
        );
        case "vcard": return (
            <div className="space-y-2">
                <Input placeholder="Nome" value={item.name} onChange={e => onChange({ ...item, name: e.target.value })} />
                <Input placeholder="Telefone com DDI (5521999999999)" inputMode="tel" value={item.phone} onChange={e => onChange({ ...item, phone: e.target.value })} />
                <Input placeholder="Empresa (opcional)" value={item.org || ""} onChange={e => onChange({ ...item, org: e.target.value || undefined })} />
            </div>
        );
        case "input": return (
            <div className="space-y-3">
                <TextField value={item.question} onChange={question => onChange({ ...item, question })} placeholder="Ex.: Qual é o seu e-mail?" />
                <Sec title="Tipo de resposta"><Select value={item.answerType} onChange={e => onChange({ ...item, answerType: e.target.value as AnswerType })} options={ANSWER_TYPES} /></Sec>
                <Sec title="Salvar a resposta no campo"><FieldPicker fieldKey={item.fieldKey} scope={item.fieldScope} onChange={(fieldKey, fieldScope) => onChange({ ...item, fieldKey, fieldScope })} /></Sec>
                <Sec title="Mensagem se a resposta for inválida"><TextField value={item.errorMessage} onChange={errorMessage => onChange({ ...item, errorMessage })} rows={2} /></Sec>
                <Sec title="Tentativas" hint="Depois disso, segue pela saída “Se não responder”.">
                    <Select value={String(item.maxAttempts)} onChange={e => onChange({ ...item, maxAttempts: Number(e.target.value) })} options={[1, 2, 3, 4, 5].map(n => ({ value: String(n), label: `${n} ${n === 1 ? "vez" : "vezes"}` }))} />
                </Sec>
                <Sec title="Se não responder em"><Expire value={item.expireValue} unit={item.expireUnit} onChange={(expireValue, expireUnit) => onChange({ ...item, expireValue, expireUnit })} /></Sec>
            </div>
        );
    }
}

function MenuEditor({ node, set }: { node: FlowNode<"menu">; set: (d: MenuData) => void }) {
    const d = node.data;
    const opts = d.options;
    const interactive = d.mode === "interactive";
    const full = interactive && opts.length >= POLL_MAX_OPTIONS;
    return (
        <div className="space-y-4">
            <Sec title="Como o contato responde">
                <div className="space-y-2">
                    {([
                        ["number", "Número", "Pergunta e opções numeradas numa mensagem de texto. O contato digita o número ou o texto."],
                        ["interactive", "Interativo", `Toca na opção: enquete no WhatsApp Web, lista ou botões na API oficial. Até ${POLL_MAX_OPTIONS} respostas.`],
                    ] as const).map(([v, t, h]) => (
                        <label key={v} className="flex cursor-pointer items-start gap-2.5">
                            <input type="radio" name={`mode-${node.id}`} checked={(d.mode ?? "number") === v} onChange={() => set({ ...d, mode: v })} className="mt-1 accent-[var(--fg)]" />
                            <span className="text-[13px]"><b className="font-medium">{t}</b><span className="block text-[11.5px] text-muted">{h}</span></span>
                        </label>
                    ))}
                </div>
            </Sec>
            <Sec title="Pergunta" hint={interactive ? `Até ${POLL_MAX_QUESTION} caracteres. Quem não tocar ainda pode digitar o número ou o texto da opção.` : "O contato pode responder com o número ou com o texto da opção."}>
                <TextField value={d.question} onChange={question => set({ ...d, question })} placeholder="Ex.: Como posso ajudar?" />
                {interactive && d.question.length > POLL_MAX_QUESTION && <p className="text-[11.5px] text-bad">{d.question.length}/{POLL_MAX_QUESTION} caracteres</p>}
            </Sec>
            <Sec title={interactive ? `Respostas (${opts.length}/${POLL_MAX_OPTIONS})` : "Respostas"} hint={interactive && opts.length > LIST_MAX_ROWS ? `Na API oficial, acima de ${LIST_MAX_ROWS} respostas vira menu numerado.` : undefined}>
                <div className="space-y-2">
                    {opts.map((o, i) => (
                        <div key={o.id} className="flex items-center gap-1.5">
                            <span className="tabular w-5 text-[13px] text-muted">{interactive ? "○" : `${i + 1}.`}</span>
                            <Input autoFocus={i === opts.length - 1 && !o.text} placeholder={`Resposta ${i + 1}`} value={o.text} maxLength={100} onChange={e => set({ ...d, options: opts.map(x => x.id === o.id ? { ...x, text: e.target.value } : x) })} />
                            <IconButton title="Subir" disabled={i === 0} onClick={() => { const a = [...opts]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; set({ ...d, options: a }); }}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
                            <IconButton title="Excluir" onClick={() => set({ ...d, options: opts.filter(x => x.id !== o.id) })}><X className="h-3.5 w-3.5" /></IconButton>
                        </div>
                    ))}
                    {full ? <p className="text-center text-[11.5px] text-muted">O menu interativo aceita até {POLL_MAX_OPTIONS} respostas.</p>
                        : <AddButton onClick={() => set({ ...d, options: [...opts, { id: newId(), text: "" }] })}>Adicionar resposta</AddButton>}
                </div>
            </Sec>
            <Sec title="Texto para resposta inválida"><TextField value={d.invalidText} onChange={invalidText => set({ ...d, invalidText })} rows={2} /></Sec>
            <Sec title="Saída de erro depois de quantos erros" hint="0 = nunca sai pela saída de erro; continua pedindo a resposta.">
                <NumberInput min={0} max={100} className="w-24" value={d.maxErrors} onChange={v => set({ ...d, maxErrors: Math.min(100, Math.max(0, Math.round(v) || 0)) })} />
            </Sec>
            <Sec title="Se não responder em"><Expire value={d.expireValue} unit={d.expireUnit} onChange={(expireValue, expireUnit) => set({ ...d, expireValue, expireUnit })} /></Sec>
        </div>
    );
}

const ACTIONS: { value: FlowAction["type"]; label: string }[] = [
    { value: "addTag", label: "Adicionar etiqueta" }, { value: "removeTag", label: "Remover etiqueta" },
    { value: "setField", label: "Definir valor de um campo" }, { value: "clearField", label: "Limpar valor de um campo" },
    { value: "notify", label: "Notificar equipe por WhatsApp" }, { value: "pauseAutomation", label: "Pausar automações do contato" },
    { value: "resumeAutomation", label: "Reativar automações do contato" }, { value: "optOut", label: "Bloquear transmissões para o contato" },
];

function newAction(type: FlowAction["type"]): FlowAction {
    const id = newId();
    switch (type) {
        case "setField": return { id, type, value: "" };
        case "notify": return { id, type, phones: "", message: "Novo contato no fluxo: {nome-completo} ({telefone})" };
        case "pauseAutomation": return { id, type, forever: false, value: 30, unit: "minutes" };
        default: return { id, type } as FlowAction;
    }
}

function ActionEditor({ node, set }: { node: FlowNode<"action">; set: (d: NodeDataMap["action"]) => void }) {
    const { meta } = useEditor();
    const acts = node.data.actions;
    const upd = (i: number, a: FlowAction) => set({ actions: acts.map((x, k) => (k === i ? a : x)) });
    return (
        <div className="space-y-3">
            {acts.map((a, i) => (
                <Card key={a.id} title={ACTIONS.find(x => x.value === a.type)?.label || a.type}
                    onUp={i > 0 ? () => { const x = [...acts]; [x[i - 1], x[i]] = [x[i], x[i - 1]]; set({ actions: x }); } : undefined}
                    onDelete={() => set({ actions: acts.filter((_, k) => k !== i) })}>
                    {(a.type === "addTag" || a.type === "removeTag") && (
                        meta.labels.length
                            ? <Select value={a.labelId} onChange={e => upd(i, { ...a, labelId: e.target.value })} options={meta.labels.map(l => ({ value: l.id, label: l.name }))} placeholder="Escolha a etiqueta" />
                            : <p className="text-[12px] text-muted">Nenhuma etiqueta. Crie em Contatos → Etiquetas.</p>
                    )}
                    {(a.type === "setField" || a.type === "clearField") && (
                        <FieldPicker fieldKey={a.fieldKey} scope={a.fieldScope} onChange={(fieldKey, fieldScope) => upd(i, { ...a, fieldKey, fieldScope })} />
                    )}
                    {a.type === "setField" && <TextField value={a.value} onChange={value => upd(i, { ...a, value })} placeholder="Valor (aceita variáveis)" rows={2} formatting={false} maxLength={1000} />}
                    {a.type === "notify" && (
                        <>
                            <Input placeholder="Números com DDI, separados por vírgula" value={a.phones} onChange={e => upd(i, { ...a, phones: e.target.value })} />
                            <TextField value={a.message} onChange={message => upd(i, { ...a, message })} rows={2} />
                        </>
                    )}
                    {a.type === "pauseAutomation" && (
                        <div className="space-y-2">
                            <Checkbox checked={a.forever} onChange={v => upd(i, { ...a, forever: v })} label="Pausar indefinidamente" />
                            {!a.forever && <Expire value={a.value} unit={a.unit} onChange={(value, unit) => upd(i, { ...a, value, unit })} />}
                            <p className="text-[11.5px] text-muted">Durante a pausa, nenhum fluxo novo atende este contato. O fluxo atual continua.</p>
                        </div>
                    )}
                    {a.type === "resumeAutomation" && <p className="text-[12px] text-muted">Remove a pausa de automações deste contato.</p>}
                    {a.type === "optOut" && <p className="text-[12px] text-muted">Marca o contato como “pediu para sair”. Transmissões com “pular quem saiu” não enviam para ele.</p>}
                </Card>
            ))}
            <AddSelect label="Adicionar ação" options={ACTIONS} onPick={t => set({ actions: [...acts, newAction(t as FlowAction["type"])] })} />
        </div>
    );
}

const OPS: Record<string, { value: ConditionOp; label: string }[]> = {
    tag: [{ value: "is", label: "tem a etiqueta" }, { value: "isNot", label: "não tem a etiqueta" }],
    weekday: [{ value: "is", label: "é" }, { value: "isNot", label: "não é" }],
    time: [{ value: "after", label: "depois de" }, { value: "before", label: "antes de" }],
    TEXT: [{ value: "is", label: "é" }, { value: "isNot", label: "não é" }, { value: "contains", label: "contém" }, { value: "notContains", label: "não contém" }, { value: "startsWith", label: "começa com" }, { value: "containsAny", label: "contém alguma destas palavras" }, { value: "hasValue", label: "tem algum valor" }],
    NUMBER: [{ value: "gt", label: "maior que" }, { value: "gte", label: "maior ou igual a" }, { value: "lt", label: "menor que" }, { value: "lte", label: "menor ou igual a" }, { value: "eq", label: "igual a" }, { value: "neq", label: "diferente de" }, { value: "hasValue", label: "tem algum valor" }],
    DATE: [{ value: "after", label: "depois de" }, { value: "before", label: "antes de" }, { value: "on", label: "em" }, { value: "hasValue", label: "tem algum valor" }],
};
const FIELD_TYPES: { value: FieldType; label: string }[] = [{ value: "TEXT", label: "Texto" }, { value: "NUMBER", label: "Número" }, { value: "DATE", label: "Data" }, { value: "DATETIME", label: "Data e hora" }];
const typeKeyOf = (t?: FieldType) => (t === "DATETIME" ? "DATE" : t || "TEXT");

function ConditionEditor({ node, set }: { node: FlowNode<"condition">; set: (d: ConditionData) => void }) {
    const { meta } = useEditor();
    const d = node.data;
    const upd = (i: number, c: FlowCondition) => set({ ...d, conditions: d.conditions.map((x, k) => (k === i ? c : x)) });
    const add = (source: ConditionSource) => set({ ...d, conditions: [...d.conditions, { id: newId(), source, op: OPS[source === "field" ? "TEXT" : source][0].value, value: source === "time" ? "09:00" : "", fieldType: "TEXT" }] });
    return (
        <div className="space-y-4">
            <Segmented value={d.logic} onChange={v => set({ ...d, logic: v })} className="w-full" options={[{ value: "or", label: "Qualquer condição" }, { value: "and", label: "Todas as condições" }]} />
            <p className="text-[12px] text-muted">Sai por <b className="font-medium text-fg">Verdadeiro</b> quando {d.logic === "and" ? "todas as condições" : "pelo menos uma condição"} for atendida; senão, por <b className="font-medium text-fg">Falso</b>.</p>
            {d.conditions.map((c, i) => {
                const typeKey = c.source === "field" ? typeKeyOf(c.fieldType) : c.source;
                const sys = c.source === "field" && meta.systemFields.find(f => f.key === c.fieldKey);
                return (
                    <Card key={c.id} title={{ tag: "Etiqueta", weekday: "Dia da semana", time: "Hora", field: "Campo" }[c.source]} onDelete={() => set({ ...d, conditions: d.conditions.filter((_, k) => k !== i) })}>
                        {c.source === "field" && (
                            <FieldPicker includeSystem fieldKey={c.fieldKey} scope={c.fieldScope}
                                onChange={(fieldKey, fieldScope, fieldType) => upd(i, { ...c, fieldKey, fieldScope, fieldType, op: OPS[typeKeyOf(fieldType)][0].value, value: "" })} />
                        )}
                        {c.source === "field" && c.fieldKey && !sys && (
                            <Select value={c.fieldType || "TEXT"} onChange={e => { const ft = e.target.value as FieldType; upd(i, { ...c, fieldType: ft, op: OPS[typeKeyOf(ft)][0].value, value: "" }); }} options={FIELD_TYPES.map(t => ({ value: t.value, label: `Comparar como ${t.label.toLowerCase()}` }))} />
                        )}
                        <Select value={c.op} onChange={e => upd(i, { ...c, op: e.target.value as ConditionOp })} options={OPS[typeKey]} />
                        {c.op !== "hasValue" && (
                            c.source === "tag" ? <Select value={c.value} onChange={e => upd(i, { ...c, value: e.target.value })} options={meta.labels.map(l => ({ value: l.id, label: l.name }))} placeholder="Escolha a etiqueta" />
                                : c.source === "weekday" ? <Select value={c.value} onChange={e => upd(i, { ...c, value: e.target.value })} options={WEEKDAYS.map((w, k) => ({ value: String(k), label: w }))} placeholder="Escolha o dia" />
                                    : c.source === "time" ? <Input type="time" className="w-32" value={c.value} onChange={e => upd(i, { ...c, value: e.target.value })} />
                                        : typeKey === "DATE" ? <Input type="date" value={c.value} onChange={e => upd(i, { ...c, value: e.target.value })} />
                                            : c.op === "containsAny" ? <Textarea rows={3} placeholder="Palavras ou frases separadas por vírgula. Use * no fim para prefixo (reembols*)" value={c.value} onChange={e => upd(i, { ...c, value: e.target.value })} />
                                                : <Input inputMode={typeKey === "NUMBER" ? "decimal" : undefined} placeholder="Valor (aceita {campo})" value={c.value} onChange={e => upd(i, { ...c, value: e.target.value })} />
                        )}
                    </Card>
                );
            })}
            <AddSelect label="Adicionar condição" onPick={v => add(v as ConditionSource)} options={[
                { value: "tag", label: "Etiqueta" }, { value: "weekday", label: "Dia da semana ao passar por aqui" },
                { value: "time", label: "Hora ao passar por aqui" }, { value: "field", label: "Valor de um campo" },
            ]} />
            <p className="text-[11.5px] text-muted">Dia e hora usam o fuso do número (Configurações).</p>
        </div>
    );
}

function RandomizerEditor({ node, set }: { node: FlowNode<"randomizer">; set: (d: RandomizerData) => void }) {
    const d = node.data;
    const sum = d.options.reduce((s, o) => s + (Number(o.weight) || 0), 0);
    const rebalance = (options: RandomizerData["options"]) => {
        if (!options.length) return options;
        const base = Math.floor(100 / options.length);
        return options.map((o, i) => ({ ...o, weight: i === options.length - 1 ? 100 - base * (options.length - 1) : base }));
    };
    return (
        <div className="space-y-4">
            <Segmented value={d.mode} onChange={v => set({ ...d, mode: v })} className="w-full" options={[{ value: "random", label: "Aleatório" }, { value: "sequential", label: "Sequencial" }]} />
            <p className="text-[12px] text-muted">{d.mode === "random" ? "Cada contato cai numa opção conforme a chance definida." : "Cada contato vai para a próxima opção, em rodízio, começando pela primeira."}</p>
            {d.options.map((o, i) => (
                <div key={o.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5">
                    <span className="mr-auto text-[13px]">Opção {i + 1}</span>
                    {d.mode === "random" && <><NumberInput min={0} max={100} className="h-8 w-20 text-right" value={o.weight} onChange={v => set({ ...d, options: d.options.map(x => x.id === o.id ? { ...x, weight: Math.min(100, Math.max(0, Math.round(v) || 0)) } : x) })} /><span className="text-[13px] text-muted">%</span></>}
                    <IconButton title="Excluir" onClick={() => set({ ...d, options: rebalance(d.options.filter(x => x.id !== o.id)) })}><X className="h-3.5 w-3.5" /></IconButton>
                </div>
            ))}
            {d.mode === "random" && d.options.length > 0 && sum !== 100 && (
                <p className="text-[12px] text-bad">A soma deve ser 100% (agora: {sum}%). <button type="button" className="underline" onClick={() => set({ ...d, options: rebalance(d.options) })}>Dividir igualmente</button></p>
            )}
            <AddButton onClick={() => set({ ...d, options: rebalance([...d.options, { id: newId(), weight: 0 }]) })}>Adicionar opção</AddButton>
        </div>
    );
}

function DelayEditor({ node, set }: { node: FlowNode<"smartDelay">; set: (d: SmartDelayData) => void }) {
    const d = node.data;
    return (
        <div className="space-y-4">
            <Segmented value={d.mode} onChange={v => set({ ...d, mode: v })} className="w-full" options={[{ value: "duration", label: "Esperar um tempo" }, { value: "datetime", label: "Até data e hora" }]} />
            {d.mode === "duration" ? (
                <Sec title="Duração" hint="Máximo de 30 dias. A conversa fica parada e continua sozinha depois desse tempo.">
                    <div className="flex gap-2">
                        <NumberInput min={1} className="w-24" value={d.value} onChange={v => set({ ...d, value: Math.max(0, v) })} />
                        <Select className="flex-1" value={d.unit} onChange={e => set({ ...d, unit: e.target.value as SmartDelayData["unit"] })} options={UNITS.filter(u => u.value !== "seconds")} />
                    </div>
                </Sec>
            ) : (
                <Sec title="Continuar em" hint="Usa o fuso do número. Se a data já tiver passado quando o contato chegar aqui, a etapa é pulada.">
                    <Input type="datetime-local" value={d.datetime || ""} onChange={e => set({ ...d, datetime: e.target.value })} />
                </Sec>
            )}
        </div>
    );
}

function FlowLinkEditor({ node, set }: { node: FlowNode<"flowLink">; set: (d: NodeDataMap["flowLink"]) => void }) {
    const { meta, flowId } = useEditor();
    const others = meta.flows.filter(f => f.id !== flowId);
    return (
        <Sec title="Fluxo que será iniciado" hint="Este fluxo termina aqui e o contato passa para o fluxo escolhido. O destino precisa estar publicado.">
            {others.length ? <Select value={node.data.flowId} onChange={e => set({ flowId: e.target.value })} placeholder="Selecione o fluxo"
                options={others.map(f => ({ value: f.id, label: `${f.name}${f.status !== "active" ? " (não ativo)" : ""}` }))} />
                : <p className="text-[12px] text-muted">Crie outro fluxo para poder conectá-lo aqui.</p>}
        </Sec>
    );
}

// ---------- casca do painel ----------
export function BlockPanel({ node, onClose }: { node: FlowNode; onClose: () => void }) {
    const { updateNode, issuesByNode } = useEditor();
    const { color, label } = BLOCKS[node.type];
    const Icon = BLOCK_ICONS[node.type];
    const name = node.data.name;
    // os editores remontam o objeto de dados; mantém o nome do bloco
    const set = (data: unknown) => updateNode(node.id, { ...(name ? { name } : {}), ...(data as object) } as never);
    const issues = issuesByNode[node.id] || [];
    return (
        <aside className="nowheel absolute inset-y-0 left-0 z-20 flex w-[380px] max-w-[calc(100vw-1rem)] animate-in flex-col border-r border-line bg-panel shadow-xl">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
                <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden />
                <Icon className="h-4 w-4 text-muted" strokeWidth={1.75} />
                <h2 className="text-[14px] font-semibold">{label}</h2>
                <IconButton title="Fechar (Esc)" className="ml-auto" onClick={onClose}><X className="h-4 w-4" /></IconButton>
            </header>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
                <Input placeholder="Nome do bloco (opcional)" value={name || ""} maxLength={60}
                    onChange={e => updateNode(node.id, { ...node.data, name: e.target.value || undefined } as never)} />
                {issues.length > 0 && (
                    <ul className="space-y-0.5 text-[12px]">
                        {issues.map((e, i) => <li key={i} className={e.level === "error" ? "text-bad" : "text-warn"}>{e.message.replace(/^[^:]+: /, "")}</li>)}
                    </ul>
                )}
                {node.type === "start" && <p className="text-[13px] text-muted">O fluxo começa aqui. Puxe a saída deste bloco até o primeiro bloco da conversa. Quando o fluxo começa fica em “Gatilhos”, no topo.</p>}
                {node.type === "content" && <ContentEditor node={node as FlowNode<"content">} set={set} />}
                {node.type === "menu" && <MenuEditor node={node as FlowNode<"menu">} set={set} />}
                {node.type === "action" && <ActionEditor node={node as FlowNode<"action">} set={set} />}
                {node.type === "condition" && <ConditionEditor node={node as FlowNode<"condition">} set={set} />}
                {node.type === "randomizer" && <RandomizerEditor node={node as FlowNode<"randomizer">} set={set} />}
                {node.type === "smartDelay" && <DelayEditor node={node as FlowNode<"smartDelay">} set={set} />}
                {node.type === "flowLink" && <FlowLinkEditor node={node as FlowNode<"flowLink">} set={set} />}
            </div>
        </aside>
    );
}
