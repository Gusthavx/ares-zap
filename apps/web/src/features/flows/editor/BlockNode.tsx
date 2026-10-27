// Adaptado do MarcFlow (MIT, Marcos Maia) — src/components/flows/block-node.tsx
// Visual monocromático: cada tipo de bloco só ganha um ponto pequeno da cor de BLOCKS.
import { memo, useEffect, type ReactNode } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import {
    Clock, Contact, Copy, File, Filter, Image as ImageIcon, LayoutGrid, Mic, Rocket, Shuffle, Star, Trash2, Video, Workflow, Zap, type LucideIcon,
} from "lucide-react";
import {
    ANSWER_TYPES, BLOCKS, WEEKDAYS, outputsOf, type ConditionData, type ContentItem, type FlowAction, type FlowCondition,
    type FlowNode, type MenuData, type NodeDataMap, type NodeType, type RandomizerData, type SmartDelayData,
} from "@areszap/core";
import { fieldLabel, useEditor, type FlowMeta } from "./context";
import { PreviewText } from "./TextField";

export const BLOCK_ICONS: Record<NodeType, LucideIcon> = {
    start: Rocket, content: Star, menu: LayoutGrid, action: Zap, condition: Filter,
    flowLink: Workflow, randomizer: Shuffle, smartDelay: Clock,
};

export const UNIT_SHORT: Record<string, string> = { seconds: "s", minutes: "min", hours: "h", days: "dias" };

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

function OutRow({ id, children, className = "" }: { id: string; children: ReactNode; className?: string }) {
    return (
        <div className={`relative flex min-h-6 items-center justify-end pr-3 text-[11px] ${className}`}>
            {children}
            <Handle type="source" position={Position.Right} id={id} className="!-right-[5px]" />
        </div>
    );
}

function Item({ children }: { children: ReactNode }) {
    return <div className="rounded bg-subtle px-2 py-1.5 text-[12px] leading-snug">{children}</div>;
}

const empty = (t: string) => <span className="text-faint">{t}</span>;
function Pend() { return <span className="text-warn">selecione</span>; }

function contentItem(it: ContentItem, meta: FlowMeta) {
    const media: Record<string, [LucideIcon, string]> = { image: [ImageIcon, "Imagem"], video: [Video, "Vídeo"], audio: [Mic, "Áudio"], file: [File, "Arquivo"] };
    switch (it.kind) {
        case "text": return <Item>{it.text ? <PreviewText text={it.text} className="line-clamp-4 whitespace-pre-wrap break-words" /> : empty("Escreva o texto")}</Item>;
        case "image": case "video": case "audio": case "file": {
            const [Icon, label] = media[it.kind];
            return <Item><span className="flex items-center gap-1.5"><Icon className="h-3.5 w-3.5 shrink-0 text-muted" /><span className="truncate">{it.assetId || it.url ? (it.fileName || label) : empty(`Envie ${label.toLowerCase()}`)}</span></span></Item>;
        }
        case "delay": return <Item><span className="text-muted">{it.typing ? "Digitando" : "Pausa"}</span> {it.seconds} s</Item>;
        case "vcard": return <Item><span className="flex items-center gap-1.5"><Contact className="h-3.5 w-3.5 text-muted" />{it.name || empty("Cartão de contato")}</span></Item>;
        case "input": return (
            <div className="rounded bg-subtle py-1.5 pl-2 text-[12px]">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Pergunta</span>
                <div className="pr-2">{it.question ? <PreviewText text={it.question} className="line-clamp-3 whitespace-pre-wrap" /> : empty("Escreva a pergunta")}</div>
                <div className="mt-1 pr-2 text-[11px] text-muted">
                    {ANSWER_TYPES.find(a => a.value === it.answerType)?.label} → {it.fieldKey ? <b className="text-fg">{fieldLabel(meta, it.fieldKey)}</b> : <span className="text-warn">escolha o campo</span>}
                </div>
                <OutRow id={`input:${it.id}:valid`}>Resposta válida</OutRow>
                <OutRow id={`input:${it.id}:timeout`} className="text-muted">Se não responder</OutRow>
            </div>
        );
    }
}

export function actionText(a: FlowAction, meta: FlowMeta): ReactNode {
    const tag = (id?: string) => meta.labels.find(l => l.id === id)?.name;
    switch (a.type) {
        case "addTag": return <>Adicionar etiqueta {tag(a.labelId) ? <b>{tag(a.labelId)}</b> : <Pend />}</>;
        case "removeTag": return <>Remover etiqueta {tag(a.labelId) ? <b>{tag(a.labelId)}</b> : <Pend />}</>;
        case "setField": return <>Definir {a.fieldKey ? <b>{fieldLabel(meta, a.fieldKey)}</b> : <Pend />} = <PreviewText text={a.value || "(vazio)"} /></>;
        case "clearField": return <>Limpar {a.fieldKey ? <b>{fieldLabel(meta, a.fieldKey)}</b> : <Pend />}</>;
        case "notify": return <>Notificar equipe {a.phones ? <b>{a.phones}</b> : <Pend />}</>;
        case "pauseAutomation": return <>Pausar automações {a.forever ? "indefinidamente" : `por ${a.value} ${UNIT_SHORT[a.unit]}`}</>;
        case "resumeAutomation": return <>Reativar automações</>;
        case "optOut": return <>Bloquear transmissões para o contato</>;
    }
}

const OP_LABEL: Record<string, string> = {
    is: "é", isNot: "não é", contains: "contém", notContains: "não contém", startsWith: "começa com", hasValue: "tem valor", containsAny: "contém alguma de",
    gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠", after: "depois de", before: "antes de", on: "em",
};

export function conditionText(c: FlowCondition, meta: FlowMeta): ReactNode {
    const op = OP_LABEL[c.op];
    switch (c.source) {
        case "tag": return <>Etiqueta {op} <b>{meta.labels.find(l => l.id === c.value)?.name || "?"}</b></>;
        case "weekday": return <>Dia da semana {op} <b>{WEEKDAYS[Number(c.value)] ?? "?"}</b></>;
        case "time": return <>Hora {op} <b>{c.value || "?"}</b></>;
        case "field": return <><b>{fieldLabel(meta, c.fieldKey) || "?"}</b> {op} {c.op !== "hasValue" && <b>{c.value || "?"}</b>}</>;
    }
}

function Body({ node }: { node: FlowNode }) {
    const { meta, stat, hasStats } = useEditor();
    switch (node.type) {
        case "start":
            return <p className="px-3 text-[12px] text-muted">O fluxo começa aqui. Ligue a saída ao primeiro bloco.</p>;
        case "content": {
            const d = node.data as NodeDataMap["content"];
            return <div className="space-y-1.5 px-3">{d.items.length ? d.items.map(it => <div key={it.id}>{contentItem(it, meta)}</div>) : <Item>{empty("Adicione mensagens, mídias ou perguntas")}</Item>}</div>;
        }
        case "menu": {
            const d = node.data as MenuData;
            const entered = stat(node.id, "entered");
            return (
                <div className="space-y-1 pl-3">
                    <div className="mr-3 text-[12px]">
                        {d.mode === "interactive" && <span className="mb-1 inline-block text-[10px] font-medium uppercase tracking-wide text-muted">Interativo</span>}
                        <div>{d.question ? <PreviewText text={d.question} className="line-clamp-3 whitespace-pre-wrap" /> : empty("Escreva a pergunta")}</div>
                    </div>
                    {d.options.map((o, i) => (
                        <div key={o.id} className="rounded-l bg-subtle py-1 pl-2">
                            <OutRow id={`option:${o.id}`}>
                                <span className="mr-auto min-w-0 truncate text-[12px]"><span className="text-muted">{d.mode === "interactive" ? "○" : `${i + 1}.`}</span> {o.text || empty("Resposta")}</span>
                                {hasStats && <span className="tabular ml-2 text-[10.5px] text-muted" title={`${stat(node.id, `option:${o.id}`)} de ${entered}`}>{pct(stat(node.id, `option:${o.id}`), entered)}</span>}
                            </OutRow>
                        </div>
                    ))}
                    {d.maxErrors > 0 && <OutRow id="error" className="text-muted">Saída de erro (após {d.maxErrors})</OutRow>}
                    <OutRow id="timeout" className="text-muted">Se não responder</OutRow>
                </div>
            );
        }
        case "action": {
            const d = node.data as NodeDataMap["action"];
            return <div className="space-y-1.5 px-3">{d.actions.length ? d.actions.map(a => <Item key={a.id}>{actionText(a, meta)}</Item>) : <Item>{empty("Qual ação deve ser feita?")}</Item>}</div>;
        }
        case "condition": {
            const d = node.data as ConditionData;
            return (
                <div className="space-y-1.5 pl-3">
                    <p className="mr-3 text-[11px] text-muted">{d.logic === "and" ? "Todas as condições" : "Pelo menos uma condição"}</p>
                    {d.conditions.length ? d.conditions.map(c => <div key={c.id} className="mr-3"><Item>{conditionText(c, meta)}</Item></div>) : <div className="mr-3"><Item>{empty("Adicione uma condição")}</Item></div>}
                    <OutRow id="true">Verdadeiro{hasStats && <span className="tabular ml-2 text-muted">{stat(node.id, "option:true") || ""}</span>}</OutRow>
                    <OutRow id="false">Falso{hasStats && <span className="tabular ml-2 text-muted">{stat(node.id, "option:false") || ""}</span>}</OutRow>
                </div>
            );
        }
        case "randomizer": {
            const d = node.data as RandomizerData;
            const entered = stat(node.id, "entered");
            return (
                <div className="space-y-1 pl-3">
                    {d.options.length < 2 && <p className="mr-3 text-[11px] text-muted">Adicione pelo menos duas opções</p>}
                    {d.options.map((o, i) => (
                        <div key={o.id} className="rounded-l bg-subtle py-1 pl-2">
                            <OutRow id={`option:${o.id}`}>
                                <span className="mr-auto text-[12px]">Opção {i + 1}</span>
                                {d.mode === "random" && <b className="tabular ml-2">{o.weight}%</b>}
                                {hasStats && <span className="tabular ml-2 text-[10.5px] text-muted">{pct(stat(node.id, `option:${o.id}`), entered)}</span>}
                            </OutRow>
                        </div>
                    ))}
                    {d.mode === "sequential" && <p className="mr-3 text-[10.5px] text-muted">Sequencial: uma opção por vez, em rodízio</p>}
                </div>
            );
        }
        case "smartDelay": {
            const d = node.data as SmartDelayData;
            return (
                <div className="px-3">
                    <Item>{d.mode === "duration"
                        ? (d.value > 0 ? <>Continua após <b>{d.value} {UNIT_SHORT[d.unit]}</b></> : empty("Defina o tempo de espera"))
                        : (d.datetime ? <>Continua em <b>{d.datetime.replace("T", " ")}</b></> : empty("Escolha data e hora"))}</Item>
                </div>
            );
        }
        case "flowLink": {
            const d = node.data as NodeDataMap["flowLink"];
            const f = meta.flows.find(x => x.id === d.flowId);
            return <div className="px-3"><Item>{f ? <>Inicia o fluxo <b>{f.name}</b></> : empty("Selecione o fluxo que será iniciado")}</Item></div>;
        }
    }
}

function BlockNodeImpl({ id, type, data, selected }: NodeProps) {
    const t = type as NodeType;
    const node = { id, type: t, data, position: { x: 0, y: 0 } } as FlowNode;
    const { color, label } = BLOCKS[t];
    const Icon = BLOCK_ICONS[t];
    const { issuesByNode, requestDelete, duplicateNode, stat, hasStats, simNodeId } = useEditor();
    const issues = issuesByNode[id] || [];
    const errors = issues.filter(i => i.level === "error");
    const warns = issues.filter(i => i.level === "warning");
    const outs = outputsOf(node);
    const updateInternals = useUpdateNodeInternals();
    const outKey = outs.map(o => o.id).join("|");
    useEffect(() => { updateInternals(id); }, [id, outKey, updateInternals]);
    const name = (data as { name?: string }).name;
    const entered = stat(id, "entered");
    const isSim = simNodeId === id;

    return (
        <div className={`group w-[250px] rounded-lg border bg-panel pb-2 shadow-sm transition-[border-color,box-shadow] duration-100 ${
            selected ? "border-fg shadow-md" : errors.length ? "border-bad/60" : "border-line-strong"} ${isSim ? "ring-2 ring-fg/25 ring-offset-2 ring-offset-canvas" : ""}`}>
            {t !== "start" && <Handle type="target" position={Position.Left} className="!left-[-5px] !top-[20px]" />}
            <div className="flex h-10 items-center gap-2 px-3">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={1.75} />
                <span className="min-w-0 truncate text-[13px] font-semibold" title={name ? label : undefined}>{name || label}</span>
                {hasStats && t !== "start" && (
                    <span className={`tabular ml-auto text-[10.5px] text-muted group-hover:hidden ${selected ? "hidden" : ""}`} title="Contatos que passaram por este bloco">{entered}</span>
                )}
                {t !== "start" && (
                    <div className={`nodrag ml-auto gap-0.5 ${selected ? "flex" : "hidden group-hover:flex"}`}>
                        <button type="button" title="Duplicar (Ctrl+D)" className="rounded p-1 text-muted hover:bg-subtle hover:text-fg" onClick={e => { e.stopPropagation(); duplicateNode(id); }}><Copy className="h-3.5 w-3.5" /></button>
                        <button type="button" title="Excluir" className="rounded p-1 text-muted hover:bg-subtle hover:text-bad" onClick={e => { e.stopPropagation(); requestDelete(id); }}><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                )}
            </div>
            <Body node={node} />
            {(t === "start" || t === "content" || t === "action" || t === "smartDelay") && (
                <OutRow id="next" className="mt-1.5 text-muted">{t === "start" ? "Início" : "Próximo passo"}</OutRow>
            )}
            {errors.length > 0 ? (
                <p className="mx-3 mt-1.5 text-[10.5px] text-bad" title={errors.map(e => e.message).join("\n")}>{errors.length === 1 ? errors[0].message.replace(/^[^:]+: /, "") : `${errors.length} pendências`}</p>
            ) : warns.length > 0 ? (
                <p className="mx-3 mt-1.5 text-[10.5px] text-warn" title={warns.map(e => e.message).join("\n")}>{warns[0].message.replace(/^[^:]+: /, "")}</p>
            ) : null}
            {t === "flowLink" && <p className="mx-3 mt-1 text-[10.5px] text-muted">Encerra este fluxo</p>}
        </div>
    );
}

export const BlockNode = memo(BlockNodeImpl);
