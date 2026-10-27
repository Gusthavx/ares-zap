// Adaptado do MarcFlow (MIT, Marcos Maia) — src/components/flows/flow-dialogs.tsx
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, FastForward, ChevronRight, Plus, RefreshCw, RotateCcw, Send, Trash2, X } from "lucide-react";
import { BLOCKS, formatPhone, newId, phoneFromJid, validateTriggers, type FlowGraph, type FlowTrigger, type GraphIssue, type KeywordMatch, type TriggerType } from "@areszap/core";
import { api, qk, type Run, type RunEvent, type SimMessage, type SimResult } from "@/api";
import { load, save } from "@/lib/storage";
import { fmtDateTime, fmtTime } from "@/lib/format";
import { Button, IconButton } from "@/ui/button";
import { Field, Input, NumberInput, Select } from "@/ui/form";
import { Dialog, Sheet } from "@/ui/overlay";
import { Spinner, Status, Tag, type Tone } from "@/ui/misc";
import { toast } from "@/ui/toast";
import type { FlowMeta } from "./context";

// ---------- lista de problemas ----------
export function IssuesList({ issues, onPick }: { issues: GraphIssue[]; onPick: (nodeId?: string) => void }) {
    if (!issues.length) return <p className="p-3 text-[13px] text-ok">Tudo certo para publicar.</p>;
    return (
        <ul className="max-h-72 space-y-px overflow-y-auto">
            {issues.map((i, k) => (
                <li key={k}>
                    <button type="button" onClick={() => onPick(i.nodeId)} className="flex w-full gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-subtle">
                        <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${i.level === "error" ? "bg-bad" : "bg-warn"}`} />{i.message}
                    </button>
                </li>
            ))}
        </ul>
    );
}

// ---------- gatilhos ----------
const TRIGGER_TYPES: { value: TriggerType; label: string }[] = [
    { value: "keyword", label: "Palavra-chave" },
    { value: "firstMessage", label: "Primeira mensagem do contato" },
    { value: "anyMessage", label: "Qualquer mensagem (fluxo padrão)" },
];
const MATCHES: { value: KeywordMatch; label: string }[] = [
    { value: "exact", label: "É igual a" }, { value: "word", label: "Palavra isolada" }, { value: "contains", label: "Contém" }, { value: "regex", label: "Expressão regular" },
];

export function TriggersSheet({ open, onClose, triggers, onChange }: { open: boolean; onClose: () => void; triggers: FlowTrigger[]; onChange: (t: FlowTrigger[]) => void }) {
    const issues = validateTriggers(triggers);
    const upd = (id: string, patch: Partial<FlowTrigger>) => onChange(triggers.map(t => (t.id === id ? { ...t, ...patch } : t)));
    return (
        <Sheet open={open} onClose={onClose} title="Quando este fluxo começa">
            <div className="space-y-4">
                <p className="text-[12.5px] text-muted">Os gatilhos são salvos junto com o rascunho e só valem depois de publicar. Se vários fluxos baterem, vence a palavra-chave de maior prioridade; depois “primeira mensagem”; por último “qualquer mensagem”.</p>
                {triggers.map(t => (
                    <div key={t.id} className="space-y-2 rounded-md border border-line p-3">
                        <div className="flex gap-2">
                            <Select className="flex-1" value={t.type} onChange={e => upd(t.id, { type: e.target.value as TriggerType, ...(e.target.value === "keyword" ? { match: t.match ?? "exact" } : {}) })} options={TRIGGER_TYPES} />
                            <IconButton size="icon" title="Remover gatilho" onClick={() => onChange(triggers.filter(x => x.id !== t.id))}><Trash2 className="h-4 w-4" /></IconButton>
                        </div>
                        {t.type === "keyword" && (
                            <>
                                <div className="flex gap-2">
                                    <Select className="w-40 shrink-0" value={t.match ?? "exact"} onChange={e => upd(t.id, { match: e.target.value as KeywordMatch })} options={MATCHES} />
                                    <Input placeholder={t.match === "regex" ? "^(oi|olá)\\b" : t.match === "word" ? "oi, olá, bom dia" : "Ex.: menu"} value={t.value ?? ""} onChange={e => upd(t.id, { value: e.target.value })} className={t.match === "regex" ? "font-mono text-[12.5px]" : ""} />
                                </div>
                                <div className="flex items-center gap-2 text-[12.5px] text-muted">
                                    Prioridade <NumberInput className="h-8 w-20" value={t.priority} onChange={v => upd(t.id, { priority: Math.round(v) })} />
                                    <span>maior vence</span>
                                </div>
                            </>
                        )}
                    </div>
                ))}
                <Button className="w-full justify-center border-dashed" icon={<Plus className="h-3.5 w-3.5" />}
                    onClick={() => onChange([...triggers, { id: newId(), type: "keyword", match: "exact", value: "", priority: 0 }])}>Adicionar gatilho</Button>
                {issues.length > 0 && <ul className="space-y-0.5 text-[12px] text-bad">{issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>}
                <p className="text-[11.5px] text-muted">Palavra-chave ignora maiúsculas e acentos. “Palavra isolada” aceita pontuação e emoji em volta (“Oi!”, “oi, tudo bem?”) e não confunde “oi” com “foi”; separe várias por vírgula. Grupos e mensagens enviadas por você nunca disparam fluxos.</p>
            </div>
        </Sheet>
    );
}

// ---------- testar no número real ----------
export function TestDialog({ open, onClose, onRun }: { open: boolean; onClose: () => void; onRun: (phone: string) => Promise<boolean> }) {
    const [phone, setPhone] = useState(() => load("az-test-phone") || "");
    const [busy, setBusy] = useState(false);
    const run = async () => {
        if (phone.replace(/\D/g, "").length < 10) return;
        setBusy(true);
        save("az-test-phone", phone);
        const ok = await onRun(phone);
        setBusy(false);
        if (ok) onClose();
    };
    return (
        <Dialog open={open} onClose={onClose} size="sm" title="Testar no meu número"
            description="Envia o RASCUNHO de verdade pelo WhatsApp deste número. Responda pelo celular para seguir a conversa. Use um número seu."
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={busy} disabled={phone.replace(/\D/g, "").length < 10} onClick={run}>Enviar teste</Button></>}>
            <Field label="Número com DDD" hint="Ex.: 21 99999-9999 ou +55 21 99999-9999.">
                <Input autoFocus inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} onKeyDown={e => e.key === "Enter" && run()} />
            </Field>
        </Dialog>
    );
}

// ---------- simulador ----------
type Line =
    | { id: number; from: "me"; text: string }
    | { id: number; from: "bot"; msg: SimMessage }
    | { id: number; from: "note"; text: string }
    | { id: number; from: "error"; text: string };

const OUTCOME_NOTE: Partial<Record<SimResult["result"], string>> = {
    "no-trigger": "Essa mensagem não aciona nenhum gatilho do fluxo.",
    paused: "Robô pausado para este contato. Reinicie para começar de novo.",
    busy: "O fluxo está numa espera programada e não lê mensagens agora.",
    ignored: "Mensagem ignorada pelo fluxo.",
    duplicate: "Mensagem repetida, ignorada.",
    reset: "Simulação reiniciada.",
};
export const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
    running: { label: "Executando", tone: "neutral" }, waiting_input: { label: "Aguardando resposta", tone: "neutral" },
    waiting_delay: { label: "Em espera", tone: "warn" }, completed: { label: "Concluído", tone: "ok" }, failed: { label: "Falhou", tone: "bad" },
    expired: { label: "Sem resposta", tone: "neutral" }, cancelled: { label: "Cancelado", tone: "neutral" },
};
const runStatus = (s: string) => RUN_STATUS[s] ?? { label: s, tone: "neutral" as Tone };

let lineSeq = 0;

export function Simulator({ flowId, graph, meta, beforeSend, onNode, onFocusNode, onClose }: {
    flowId: string; graph: FlowGraph; meta: FlowMeta; beforeSend: () => Promise<boolean>;
    onNode: (id: string | null) => void; onFocusNode: (id: string) => void; onClose: () => void;
}) {
    const [lines, setLines] = useState<Line[]>([]);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [state, setState] = useState<SimResult | null>(null);
    const [showState, setShowState] = useState(true);
    const end = useRef<HTMLDivElement>(null);
    useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [lines]);
    useEffect(() => () => onNode(null), [onNode]);

    const call = async (body: { text?: string; optionId?: string; reset?: boolean; skipWait?: boolean }, echo?: string) => {
        if (busy) return;
        setBusy(true);
        try {
            if (!body.reset && !(await beforeSend())) return;
            if (echo) setLines(l => [...l, { id: ++lineSeq, from: "me", text: echo }]);
            const r = await api.flows.simulate(flowId, body);
            setState(r);
            onNode(r.run?.currentNodeId ?? null);
            const add: Line[] = r.messages.map(msg => ({ id: ++lineSeq, from: "bot" as const, msg }));
            const note = OUTCOME_NOTE[r.result];
            if (body.reset) { setLines([]); return; }
            if (body.skipWait) add.unshift({ id: ++lineSeq, from: "note", text: r.result === "ignored" ? "Não havia espera para pular." : "Espera pulada." });
            if (note && !(body.skipWait && r.result === "ignored")) add.push({ id: ++lineSeq, from: "note", text: note });
            else if (r.run?.status === "completed" || r.run?.status === "expired") add.push({ id: ++lineSeq, from: "note", text: "Conversa encerrada pelo fluxo." });
            else if (r.run?.status === "failed") add.push({ id: ++lineSeq, from: "error", text: "O fluxo falhou neste ponto." });
            setLines(l => [...l, ...add]);
        } catch (e) {
            setLines(l => [...l, { id: ++lineSeq, from: "error", text: e instanceof Error ? e.message : String(e) }]);
        } finally {
            setBusy(false);
        }
    };

    const send = () => { const t = text.trim(); if (!t) return; setText(""); call({ text: t }, t); };
    const lastMenu = [...lines].reverse().find(l => l.from === "bot" && l.msg.kind === "menu" && !l.msg.to);
    const nodeName = (id: string | null | undefined) => {
        const n = id ? graph.nodes.find(x => x.id === id) : undefined;
        return n ? n.data.name || BLOCKS[n.type].label : "—";
    };
    const tagName = (t: string) => meta.labels.find(l => l.id === t)?.name ?? t;
    const canSkip = !!state?.run && (state.run.status === "waiting_delay" || (state.run.status === "waiting_input" && !!state.run.resumeAt));

    return (
        <aside className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-[calc(100vw-1rem)] animate-sheet flex-col border-l border-line bg-panel shadow-xl">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
                <h2 className="text-[14px] font-semibold">Simulador</h2>
                <span className="text-[11.5px] text-muted">rascunho · nada vai ao WhatsApp</span>
                <div className="ml-auto flex gap-0.5">
                    <IconButton title="Reiniciar (apaga campos, etiquetas e execução do contato simulado)" disabled={busy} onClick={() => call({ reset: true })}><RotateCcw className="h-3.5 w-3.5" /></IconButton>
                    <IconButton title="Fechar" onClick={onClose}><X className="h-4 w-4" /></IconButton>
                </div>
            </header>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-canvas p-3">
                {!lines.length && <p className="px-6 py-8 text-center text-[12.5px] text-muted">Escreva como se fosse o contato. Comece pela palavra do gatilho.</p>}
                {lines.map(l => {
                    if (l.from === "note" || l.from === "error") return <p key={l.id} className={`py-1 text-center text-[11.5px] ${l.from === "error" ? "text-bad" : "text-muted"}`}>{l.text}</p>;
                    if (l.from === "me") return <div key={l.id} className="flex justify-end"><div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-fg px-3 py-1.5 text-[13px] text-bg">{l.text}</div></div>;
                    const m = l.msg;
                    if (m.to) return (
                        <div key={l.id} className="rounded-md border border-dashed border-line-strong px-3 py-2 text-[12.5px]">
                            <p className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted">Notificação para {formatPhone(m.to)} · não enviada</p>
                            <p className="whitespace-pre-wrap break-words">{m.text}</p>
                        </div>
                    );
                    return (
                        <div key={l.id} className="flex justify-start">
                            <div className="max-w-[85%] rounded-lg border border-line bg-bg px-3 py-1.5 text-[13px]">
                                {m.kind !== "text" && m.kind !== "menu" && <p className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted">{m.kind === "media" ? "Mídia" : m.kind === "vcard" ? "Contato" : "Modelo"}</p>}
                                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                                {m.kind === "menu" && m.options && (
                                    <div className="mt-2 flex flex-col gap-1">
                                        {m.options.map((o, i) => (
                                            <button key={o.id} type="button" disabled={busy || l !== lastMenu} onClick={() => call({ optionId: o.id }, o.text)}
                                                className="rounded border border-line px-2.5 py-1 text-left text-[12.5px] transition-colors hover:border-fg disabled:pointer-events-none disabled:opacity-50">
                                                {m.mode === "interactive" ? "○" : `${i + 1}.`} {o.text}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {(m.typingMs > 0 || m.delayMs > 0) && (
                                    <p className="mt-0.5 text-[10.5px] text-faint">{m.delayMs > 0 ? `após ${(m.delayMs / 1000).toLocaleString("pt-BR")} s` : ""}{m.delayMs > 0 && m.typingMs > 0 ? " · " : ""}{m.typingMs > 0 ? `digitando ${(m.typingMs / 1000).toLocaleString("pt-BR")} s` : ""}</p>
                                )}
                            </div>
                        </div>
                    );
                })}
                {busy && <div className="flex justify-start px-1 text-muted"><Spinner className="h-3.5 w-3.5" /></div>}
                {canSkip && !busy && (
                    <div className="flex justify-center pt-1">
                        <button type="button" onClick={() => call({ skipWait: true })} className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] text-muted hover:border-fg hover:text-fg"
                            title={state?.run?.status === "waiting_delay" ? "Continua agora, como se o atraso tivesse acabado" : "Segue pelo caminho “Se não responder”"}>
                            <FastForward className="h-3.5 w-3.5" />{state?.run?.status === "waiting_delay" ? "Pular espera" : "Simular “não respondeu”"}
                        </button>
                    </div>
                )}
                <div ref={end} />
            </div>

            {state && (
                <div className="shrink-0 border-t border-line text-[12px]">
                    <button type="button" onClick={() => setShowState(s => !s)} className="flex w-full items-center gap-1.5 px-4 py-2 font-medium hover:bg-subtle">
                        {showState ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}Estado da execução
                        {state.run && <span className="ml-auto"><Status tone={runStatus(state.run.status).tone}>{runStatus(state.run.status).label}</Status></span>}
                    </button>
                    {showState && (
                        <div className="max-h-48 space-y-2 overflow-y-auto px-4 pb-3">
                            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                                <dt className="text-muted">Bloco atual</dt>
                                <dd>{state.run?.currentNodeId ? <button type="button" className="underline underline-offset-2" onClick={() => onFocusNode(state.run!.currentNodeId!)}>{nodeName(state.run.currentNodeId)}</button> : "—"}</dd>
                                {state.run?.resumeAt && <><dt className="text-muted">Retoma em</dt><dd>{fmtDateTime(state.run.resumeAt)}</dd></>}
                                {state.run?.wait != null && <><dt className="text-muted">Esperando</dt><dd>{waitText(state.run.wait)}</dd></>}
                            </dl>
                            <div>
                                <p className="text-muted">Campos</p>
                                {Object.keys(state.fields).length ? (
                                    <dl className="mt-0.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                                        {Object.entries(state.fields).map(([k, v]) => <FieldRow key={k} k={k} v={v} />)}
                                    </dl>
                                ) : <p className="text-faint">nenhum</p>}
                            </div>
                            <div>
                                <p className="text-muted">Etiquetas</p>
                                {state.tags.length ? <div className="mt-1 flex flex-wrap gap-1">{state.tags.map(t => <Tag key={t}>{tagName(t)}</Tag>)}</div> : <p className="text-faint">nenhuma</p>}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <form className="flex shrink-0 gap-2 border-t border-line p-3" onSubmit={e => { e.preventDefault(); send(); }}>
                <Input value={text} onChange={e => setText(e.target.value)} placeholder="Mensagem do contato" disabled={busy} autoFocus />
                <Button type="submit" variant="primary" size="icon" title="Enviar" aria-label="Enviar" disabled={busy || !text.trim()}><Send className="h-4 w-4" /></Button>
            </form>
        </aside>
    );
}

function FieldRow({ k, v }: { k: string; v: string }) {
    return <><dt className="font-mono text-[11px] text-muted">{k}</dt><dd className="break-words">{v || <span className="text-faint">vazio</span>}</dd></>;
}

function waitText(w: unknown): string {
    if (!w || typeof w !== "object") return String(w);
    const o = w as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    const map: Record<string, string> = { menu: "resposta do menu", input: "resposta da pergunta", delay: "fim do atraso" };
    return map[kind] ?? kind ?? "—";
}

// ---------- execuções ----------
const EVENT: Record<string, string> = {
    START: "Início", ENTER: "Entrou no bloco", SEND: "Enviou", WAIT: "Aguardando", INPUT: "Resposta recebida", INVALID: "Resposta inválida",
    BRANCH: "Decisão", ACTION: "Ação", ERROR: "Erro", END: "Fim",
};

function describe(e: RunEvent, graph: FlowGraph): string {
    const d = e.detail || {};
    const node = graph.nodes.find(n => n.id === e.nodeId);
    if (e.kind === "ENTER") return node ? node.data.name || BLOCKS[node.type].label : "";
    if (e.kind === "START") return [d.test ? "teste" : "", d.from === "flowLink" ? "vindo de outro fluxo" : "", d.version ? `v${d.version}` : ""].filter(Boolean).join(" · ");
    if (e.kind === "SEND") {
        const kinds: Record<string, string> = { menu: "menu", media: "mídia", vcard: "cartão de contato", template: "modelo" };
        const what = d.text ? String(d.text) : d.summary ? String(d.summary) : `[${kinds[String(d.kind)] ?? String(d.kind ?? "mensagem")}]`;
        return what + (d.to ? ` → ${formatPhone(phoneFromJid(String(d.to)))}` : "");
    }
    if (e.kind === "ACTION") {
        const labels: Record<string, string> = { addTag: "etiqueta adicionada", removeTag: "etiqueta removida", setField: "campo", clearField: "campo limpo", notify: "notificação", pausedUntil: "automação pausada até", resumeAutomation: "automação reativada", optOut: "saiu das transmissões" };
        return Object.entries(d).map(([k, v]) => k === "pausedUntil" ? `${labels[k]} ${fmtDateTime(String(v))}` : k === "value" ? `= ${v}` : `${labels[k] ?? k}${v === true ? "" : `: ${v}`}`).join(" ");
    }
    if (e.kind === "WAIT") return d.until ? `até ${fmtDateTime(String(d.until))}` : "";
    if (e.kind === "INPUT") return d.option ? `opção ${d.option}${d.text ? ` (${d.text})` : ""}` : `${d.field ? `${d.field} = ` : ""}${d.value ?? d.text ?? ""}`;
    if (e.kind === "INVALID") return `“${d.answer ?? ""}”${d.attempts ? ` (${d.attempts}ª)` : ""}`;
    if (e.kind === "BRANCH") return d.result !== undefined ? (d.result ? "Verdadeiro" : "Falso") : d.option ? `Opção ${d.option}` : String(d.path ?? "");
    if (e.kind === "ERROR") return String(d.error ?? "");
    if (e.kind === "END") return runStatus(String(d.status ?? "")).label;
    return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
}

export function RunsSheet({ open, onClose, flowId, graph }: { open: boolean; onClose: () => void; flowId: string; graph: FlowGraph }) {
    const client = useQueryClient();
    const [status, setStatus] = useState("");
    const [detail, setDetail] = useState<Run | null>(null);
    const runs = useQuery({ queryKey: [...qk.flowRuns(flowId), status], queryFn: () => api.flows.runs(flowId, status || undefined), enabled: open });
    const events = useQuery({ queryKey: qk.runEvents(detail?.id ?? ""), queryFn: () => api.runs.events(detail!.id), enabled: !!detail });
    const cancel = useMutation({
        mutationFn: (id: string) => api.runs.cancel(id),
        onSuccess: () => { toast.success("Execução cancelada"); client.invalidateQueries({ queryKey: qk.flowRuns(flowId) }); setDetail(null); },
        onError: e => toast.error(e),
    });
    const active = (s: string) => ["running", "waiting_input", "waiting_delay"].includes(s);

    return (
        <Sheet open={open} onClose={onClose} width="max-w-lg"
            title={detail ? <span className="flex items-center gap-2"><IconButton title="Voltar" onClick={() => setDetail(null)}><ArrowLeft className="h-4 w-4" /></IconButton>{formatPhone(phoneFromJid(detail.jid))}</span> : "Execuções"}
            actions={!detail ? <IconButton title="Atualizar" onClick={() => runs.refetch()}><RefreshCw className={`h-3.5 w-3.5 ${runs.isFetching ? "animate-spin" : ""}`} /></IconButton> : undefined}>
            {!detail ? (
                <div className="space-y-3">
                    <Select value={status} onChange={e => setStatus(e.target.value)} options={[{ value: "", label: "Todos os estados" }, ...Object.entries(RUN_STATUS).map(([v, s]) => ({ value: v, label: s.label }))]} />
                    {runs.isPending ? <div className="flex justify-center py-6 text-muted"><Spinner /></div>
                        : runs.isError ? <p className="text-[13px] text-bad">{runs.error.message}</p>
                            : !runs.data.items.length ? <p className="py-6 text-center text-[13px] text-muted">Nenhuma execução. Publique o fluxo e mande a palavra do gatilho, ou use “Testar”.</p>
                                : (
                                    <ul className="divide-y divide-line rounded-md border border-line">
                                        {runs.data.items.map(r => (
                                            <li key={r.id}>
                                                <button type="button" onClick={() => setDetail(r)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-subtle">
                                                    <div className="min-w-0 flex-1">
                                                        <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">{formatPhone(phoneFromJid(r.jid))}{r.isTest && <Tag>teste</Tag>}{r.flowVersion ? <span className="text-[11.5px] font-normal text-muted">v{r.flowVersion}</span> : null}</p>
                                                        <p className="text-[11.5px] text-muted">{fmtDateTime(r.createdAt)}</p>
                                                        {r.error && <p className="truncate text-[11.5px] text-bad">{r.error}</p>}
                                                    </div>
                                                    <Status tone={runStatus(r.status).tone}>{runStatus(r.status).label}</Status>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Status tone={runStatus(detail.status).tone}>{runStatus(detail.status).label}</Status>
                        {detail.resumeAt && active(detail.status) && <span className="text-[12px] text-muted">retoma {fmtDateTime(detail.resumeAt)}</span>}
                        {active(detail.status) && <Button size="sm" variant="danger" className="ml-auto" loading={cancel.isPending} onClick={() => cancel.mutate(detail.id)}>Cancelar execução</Button>}
                    </div>
                    {detail.error && <p className="text-[12.5px] text-bad">{detail.error}</p>}
                    {events.isPending ? <div className="flex justify-center py-6 text-muted"><Spinner /></div> : events.isError ? <p className="text-[13px] text-bad">{events.error.message}</p> : (
                        <ol className="relative ml-1.5 space-y-2 border-l border-line pl-4">
                            {events.data.items.map(e => (
                                <li key={e.id} className="relative text-[12.5px]">
                                    <span className={`absolute -left-[20.5px] top-[7px] h-2 w-2 rounded-full ${e.kind === "ERROR" ? "bg-bad" : e.kind === "INVALID" ? "bg-warn" : "bg-line-strong"}`} />
                                    <span className="font-medium">{EVENT[e.kind] ?? e.kind}</span> <span className="text-muted">{describe(e, graph)}</span>
                                    {" "}<span className="tabular ml-1 text-[10.5px] text-faint">{fmtTime(e.createdAt)}</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            )}
        </Sheet>
    );
}

// ---------- variáveis do robô ----------
export function BotVarsDialog({ open, onClose, sid }: { open: boolean; onClose: () => void; sid: string }) {
    const client = useQueryClient();
    const vars = useQuery({ queryKey: qk.variables(sid), queryFn: () => api.variables.get(sid), enabled: open });
    const [draft, setDraft] = useState<Record<string, string> | null>(null);
    useEffect(() => { if (vars.data && !draft) setDraft(vars.data); }, [vars.data, draft]);
    const m = useMutation({
        mutationFn: () => api.variables.put(sid, draft ?? {}),
        onSuccess: d => { client.setQueryData(qk.variables(sid), d); toast.success("Variáveis salvas"); onClose(); },
        onError: e => toast.error(e),
    });
    const entries = Object.entries(draft ?? {});
    return (
        <Dialog open={open} onClose={onClose} size="lg" title="Variáveis do robô" description="Valores globais usados nas mensagens como {chave}: preço, link, horário de atendimento…"
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} disabled={!draft} onClick={() => m.mutate()}>Salvar</Button></>}>
            {!draft ? <div className="flex justify-center py-6 text-muted"><Spinner /></div> : !entries.length ? (
                <p className="text-[13px] text-muted">Nenhuma variável. Crie num bloco, no seletor de campos (“Do robô”), ou em Contatos → Variáveis do robô.</p>
            ) : (
                <div className="space-y-3">
                    {entries.map(([k, v]) => (
                        <Field key={k} label={<span className="font-mono text-[12px]">{`{${k}}`}</span>}>
                            <Input value={v} onChange={e => setDraft({ ...draft, [k]: e.target.value })} />
                        </Field>
                    ))}
                </div>
            )}
        </Dialog>
    );
}
