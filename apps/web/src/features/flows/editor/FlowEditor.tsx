// Adaptado do MarcFlow (MIT, Marcos Maia) — src/components/flows/flow-editor.tsx
// Rascunho = grafo + gatilhos, salvo junto com controle de revisão (PUT /flows/:id/draft).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    ReactFlow, Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, getBezierPath, useEdgesState, useNodesState, useReactFlow,
    type Connection, type Edge, type EdgeProps, type IsValidConnection, type Node, type NodeMouseHandler,
} from "@xyflow/react";
import {
    AlertTriangle, ArrowLeft, Bot, Braces, Check, CloudOff, History, Maximize, Play, Plus, Redo2, Rocket, Trash2, Undo2, X, Zap,
} from "lucide-react";
import {
    ADDABLE_BLOCKS, BLOCKS, SYSTEM_FIELDS, defaultData, newId, validateGraph, validateTriggers,
    type FlowEdge, type FlowGraph, type FlowNode, type FlowTrigger, type GraphIssue, type NodeType,
} from "@areszap/core";
import { api, ApiError, qk, type Flow, type FlowStatus, type FlowSummary, type Label } from "@/api";
import { useTheme } from "@/lib/theme";
import { Button, IconButton } from "@/ui/button";
import { Switch } from "@/ui/form";
import { Status } from "@/ui/misc";
import { confirm, Popover } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { FLOW_STATUS } from "../FlowsPage";
import { BlockNode, BLOCK_ICONS } from "./BlockNode";
import { BlockPanel } from "./BlockPanel";
import { EditorContext, type EditorApi, type FieldDef, type FlowMeta } from "./context";
import { BotVarsDialog, IssuesList, RunsSheet, Simulator, TestDialog, TriggersSheet } from "./panels";

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

const nodeTypes = Object.fromEntries((Object.keys(BLOCKS) as NodeType[]).map(t => [t, BlockNode]));

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }: EdgeProps) {
    const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
    const { setEdges } = useReactFlow();
    return (
        <>
            <BaseEdge id={id} path={path} interactionWidth={16} />
            {selected && (
                <EdgeLabelRenderer>
                    <button type="button" title="Remover conexão" onClick={() => setEdges(es => es.filter(e => e.id !== id))}
                        className="nodrag nopan absolute flex h-6 w-6 items-center justify-center rounded border border-line bg-panel text-bad shadow"
                        style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, pointerEvents: "all" }}>
                        <Trash2 className="h-3 w-3" />
                    </button>
                </EdgeLabelRenderer>
            )}
        </>
    );
}
const edgeTypes = { flow: FlowEdgeView };

const toRfNodes = (g: FlowGraph): Node[] => g.nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data as Record<string, unknown>, deletable: n.type !== "start" }));
const toRfEdges = (g: FlowGraph): Edge[] => g.edges.map(e => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, type: "flow" }));
const toGraph = (nodes: Node[], edges: Edge[]): FlowGraph => ({
    nodes: nodes.map(n => ({ id: n.id, type: n.type as NodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data } as FlowNode)),
    edges: edges.map(e => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle || "next", target: e.target } as FlowEdge)),
});

/** Salvamento disparado ao sair do editor; a página espera ele antes de buscar o rascunho de novo. */
export const pendingFlush = new Map<string, Promise<unknown>>();

/** JSON com chaves ordenadas: o banco (jsonb) pode devolver as chaves em outra ordem. */
function stable(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).filter(k => (v as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(v);
}
const signature = (graph: FlowGraph | null, triggers: FlowTrigger[] | null) => (graph ? stable({ graph: { nodes: graph.nodes.map(n => ({ ...n, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })), edges: graph.edges }, triggers: triggers ?? [] }) : null);

/** Campos do contato usados no grafo (não existe rota que liste os campos). */
function contactFieldsIn(g: FlowGraph): string[] {
    const keys = new Set<string>();
    const sys = new Set(SYSTEM_FIELDS.map(f => f.key));
    const add = (k?: string, scope?: string) => { if (k && scope !== "BOT" && !sys.has(k)) keys.add(k); };
    for (const n of g.nodes) {
        const d = n.data as Record<string, unknown>;
        if (n.type === "content") for (const it of (d.items as { kind: string; fieldKey?: string; fieldScope?: string }[]) ?? []) if (it.kind === "input") add(it.fieldKey, it.fieldScope);
        if (n.type === "action") for (const a of (d.actions as { fieldKey?: string; fieldScope?: string }[]) ?? []) add(a.fieldKey, a.fieldScope);
        if (n.type === "condition") for (const c of (d.conditions as { source: string; fieldKey?: string; fieldScope?: string }[]) ?? []) if (c.source === "field") add(c.fieldKey, c.fieldScope);
    }
    return [...keys];
}

export function FlowEditor({ sid, initial, labels, flows, variables, knownContactFields, onReload }: {
    sid: string; initial: Flow; labels: Label[]; flows: FlowSummary[]; variables: Record<string, string>; knownContactFields: string[]; onReload: () => void;
}) {
    const rf = useReactFlow();
    const client = useQueryClient();
    const [theme] = useTheme();
    const wrapper = useRef<HTMLDivElement>(null);
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toRfNodes(initial.draftGraph));
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toRfEdges(initial.draftGraph));
    const [triggers, setTriggers] = useState<FlowTrigger[]>(initial.draftTriggers ?? []);
    const [name, setName] = useState(initial.name);
    const [status, setStatus] = useState<FlowStatus>(initial.status);
    const [publishedVersion, setPublishedVersion] = useState(initial.publishedVersion);
    const [publishedSig, setPublishedSig] = useState(() => signature(initial.publishedGraph, initial.publishedTriggers));
    const [panelId, setPanelId] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<SaveState>("saved");
    const [issuesOpen, setIssuesOpen] = useState(false);
    const [serverIssues, setServerIssues] = useState<GraphIssue[]>([]);
    const [dialog, setDialog] = useState<"triggers" | "test" | "runs" | "vars" | null>(null);
    const [simOpen, setSimOpen] = useState(false);
    const [simNodeId, setSimNodeId] = useState<string | null>(null);
    const [publishing, setPublishing] = useState(false);
    const [extraFields, setExtraFields] = useState<FieldDef[]>([]);

    const revision = useRef(initial.draftRevision);
    // mesma forma que o editor produz (toGraph), senão o primeiro render já parece "alterado"
    const serializedInit = JSON.stringify({ graph: toGraph(toRfNodes(initial.draftGraph), toRfEdges(initial.draftGraph)), triggers: initial.draftTriggers ?? [] });
    const lastSaved = useRef(serializedInit);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const undo = useRef<string[]>([JSON.stringify(toGraph(toRfNodes(initial.draftGraph), toRfEdges(initial.draftGraph)))]);
    const redo = useRef<string[]>([]);

    const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
    const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
    const serialized = useMemo(() => JSON.stringify({ graph, triggers }), [graph, triggers]);
    const serializedRef = useRef(serialized);
    serializedRef.current = serialized;

    const issues = useMemo(() => [...validateGraph(graph), ...validateTriggers(triggers)], [graph, triggers]);
    const errors = issues.filter(i => i.level === "error");
    const allIssues = useMemo(() => {
        const seen = new Set(issues.map(i => i.message));
        return [...issues, ...serverIssues.filter(i => !seen.has(i.message))];
    }, [issues, serverIssues]);
    const issuesByNode = useMemo(() => {
        const m: Record<string, GraphIssue[]> = {};
        for (const i of allIssues) if (i.nodeId) (m[i.nodeId] ||= []).push(i);
        return m;
    }, [allIssues]);

    const stats = useQuery({ queryKey: qk.flowStats(initial.id), queryFn: () => api.flows.stats(initial.id), refetchInterval: 60_000 });
    const statNodes = stats.data?.nodes;
    const hasStats = !!statNodes && Object.keys(statNodes).length > 0;

    // ---------- salvar (rascunho inteiro + revisão) ----------
    const saveNow = useCallback(async (): Promise<boolean> => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        const body = serializedRef.current;
        if (body === lastSaved.current) return true;
        setSaveState("saving");
        try {
            const parsed = JSON.parse(body) as { graph: FlowGraph; triggers: FlowTrigger[] };
            const r = await api.flows.saveDraft(initial.id, { ...parsed, revision: revision.current });
            revision.current = r.revision;
            lastSaved.current = body;
            setSaveState(serializedRef.current === body ? "saved" : "dirty");
            client.invalidateQueries({ queryKey: qk.flows(sid) });
            return true;
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                setSaveState("conflict");
                toast.error("Este fluxo foi salvo em outra aba. Recarregue para continuar.", { duration: 15000, action: { label: "Recarregar", onClick: onReload } });
            } else {
                setSaveState("error");
                toast.error(e);
            }
            return false;
        }
    }, [initial.id, sid, client, onReload]);

    useEffect(() => {
        if (serialized === lastSaved.current || saveState === "conflict") return;
        setSaveState(s => (s === "saving" ? s : "dirty"));
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { saveNow(); }, 800);
    }, [serialized, saveNow, saveState]);

    useEffect(() => {
        const h = setTimeout(() => {
            if (undo.current[undo.current.length - 1] !== graphJson) {
                undo.current.push(graphJson);
                if (undo.current.length > 80) undo.current.shift();
                redo.current = [];
            }
        }, 400);
        return () => clearTimeout(h);
    }, [graphJson]);

    // aviso ao fechar a aba + salvamento ao sair do editor pela navegação interna
    useEffect(() => {
        const warn = (e: BeforeUnloadEvent) => { if (serializedRef.current !== lastSaved.current) e.preventDefault(); };
        window.addEventListener("beforeunload", warn);
        return () => {
            window.removeEventListener("beforeunload", warn);
            if (timer.current) clearTimeout(timer.current);
            const body = serializedRef.current;
            if (body !== lastSaved.current) {
                const parsed = JSON.parse(body) as { graph: FlowGraph; triggers: FlowTrigger[] };
                const p = api.flows.saveDraft(initial.id, { ...parsed, revision: revision.current })
                    .catch(() => toast.error("As últimas alterações do fluxo não foram salvas."))
                    .finally(() => pendingFlush.delete(initial.id));
                pendingFlush.set(initial.id, p);
            }
        };
    }, [initial.id]);

    const applyGraph = useCallback((s: string) => {
        const g = JSON.parse(s) as FlowGraph;
        setNodes(toRfNodes(g));
        setEdges(toRfEdges(g));
    }, [setNodes, setEdges]);
    const doUndo = useCallback(() => {
        if (undo.current.length < 2) return;
        redo.current.push(undo.current.pop()!);
        applyGraph(undo.current[undo.current.length - 1]);
    }, [applyGraph]);
    const doRedo = useCallback(() => {
        const s = redo.current.pop();
        if (!s) return;
        undo.current.push(s);
        applyGraph(s);
    }, [applyGraph]);

    // ---------- operações no grafo ----------
    const updateNode = useCallback((id: string, data: unknown) => {
        setNodes(ns => ns.map(n => (n.id === id ? { ...n, data: data as Record<string, unknown> } : n)));
    }, [setNodes]);

    const deleteNode = useCallback((id: string) => {
        setNodes(ns => ns.filter(n => n.id !== id));
        setEdges(es => es.filter(e => e.source !== id && e.target !== id));
        setPanelId(p => (p === id ? null : p));
    }, [setNodes, setEdges]);

    const requestDelete = useCallback(async (id: string) => {
        if (await confirm({ title: "Excluir bloco?", body: "O bloco e as conexões dele saem do rascunho. Dá para desfazer com Ctrl+Z enquanto a página estiver aberta.", confirm: "Excluir", danger: true })) deleteNode(id);
    }, [deleteNode]);

    const freeSpot = useCallback((x: number, y: number) => {
        const ns = rf.getNodes();
        let py = y;
        for (let i = 0; i < 40 && ns.some(n => Math.abs(n.position.x - x) < 240 && Math.abs(n.position.y - py) < 140); i++) py += 80;
        return { x, y: py };
    }, [rf]);

    const duplicateNode = useCallback((id: string) => {
        const src = rf.getNode(id);
        if (!src || src.type === "start") return;
        const copy: Node = { ...src, id: newId(), selected: true, position: freeSpot(src.position.x + 290, src.position.y), data: structuredClone(src.data) };
        setNodes(ns => [...ns.map(n => ({ ...n, selected: false })), copy]);
        setPanelId(copy.id);
    }, [rf, setNodes, freeSpot]);

    const addBlock = (type: NodeType) => {
        const rect = wrapper.current!.getBoundingClientRect();
        const c = rf.screenToFlowPosition({ x: rect.left + rect.width / 2 + (panelId ? 190 : 0), y: rect.top + rect.height / 2 - 80 });
        const node: Node = { id: newId(), type, position: freeSpot(c.x - 125, c.y), data: defaultData(type) as Record<string, unknown>, selected: true, deletable: true };
        setNodes(ns => [...ns.map(n => ({ ...n, selected: false })), node]);
        setPanelId(node.id);
    };

    const onConnect = useCallback((c: Connection) => {
        const handle = c.sourceHandle || "next";
        setEdges(es => [
            ...es.filter(e => !(e.source === c.source && (e.sourceHandle || "next") === handle)), // uma saída liga a um destino só
            { id: newId(), source: c.source, sourceHandle: handle, target: c.target, type: "flow" },
        ]);
    }, [setEdges]);

    const isValidConnection: IsValidConnection = useCallback(c => c.source !== c.target && rf.getNode(c.target)?.type !== "start", [rf]);
    const onNodeClick: NodeMouseHandler = useCallback((_, n) => setPanelId(n.id), []);

    const focusNode = useCallback((id?: string) => {
        setIssuesOpen(false);
        if (!id) return;
        const n = rf.getNode(id);
        if (!n) return;
        setNodes(ns => ns.map(x => ({ ...x, selected: x.id === id })));
        setPanelId(id);
        rf.setCenter(n.position.x + 125 - 190 / rf.getZoom(), n.position.y + 80, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
    }, [rf, setNodes]);

    // ---------- teclado ----------
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement;
            if (t.closest("input, textarea, select, [contenteditable=true], dialog")) return;
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
            else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); }
            else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
            else if (mod && e.key.toLowerCase() === "d") {
                e.preventDefault();
                const sel = rf.getNodes().find(n => n.selected);
                if (sel) duplicateNode(sel.id);
            } else if (e.key === "Escape") setPanelId(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [doUndo, doRedo, duplicateNode, rf, saveNow]);

    // ---------- ações no servidor ----------
    const publish = async () => {
        if (errors.length) { setIssuesOpen(true); return; }
        setPublishing(true);
        try {
            if (!(await saveNow())) return;
            const r = await api.flows.publish(initial.id);
            setServerIssues(r.issues ?? []);
            setStatus("active");
            setPublishedVersion(r.version);
            setPublishedSig(signature(JSON.parse(serializedRef.current).graph, triggers));
            client.invalidateQueries({ queryKey: qk.flows(sid) });
            if (triggers.length) toast.success(`Versão ${r.version} publicada e ativa`);
            else { toast.info("Publicado. Configure um gatilho para o fluxo começar sozinho."); setDialog("triggers"); }
        } catch (e) {
            if (e instanceof ApiError && e.status === 422 && e.issues.length) { setServerIssues(e.issues); setIssuesOpen(true); }
            toast.error(e);
        } finally {
            setPublishing(false);
        }
    };

    const runTest = async (phone: string) => {
        if (errors.length) { setIssuesOpen(true); toast.error("Corrija os erros antes de testar."); return false; }
        if (!(await saveNow())) return false;
        try {
            await api.flows.test(initial.id, phone);
            toast.success("Teste iniciado. Veja o WhatsApp do número informado.");
            return true;
        } catch (e) { toast.error(e); return false; }
    };

    const toggleStatus = async (on: boolean) => {
        try {
            await (on ? api.flows.activate(initial.id) : api.flows.deactivate(initial.id));
            setStatus(on ? "active" : "inactive");
            client.invalidateQueries({ queryKey: qk.flows(sid) });
            toast.success(on ? "Fluxo ativado" : "Fluxo desativado: novos contatos não entram; conversas em andamento continuam");
        } catch (e) { toast.error(e); }
    };

    const rename = async () => {
        const v = name.trim();
        if (!v || v === initial.name) { setName(v || initial.name); return; }
        try { await api.flows.rename(initial.id, v); client.invalidateQueries({ queryKey: qk.flows(sid) }); } catch (e) { toast.error(e); }
    };

    const simWarned = useRef(false);
    const simBeforeSend = useCallback(async () => {
        if (errors.length && !simWarned.current) { simWarned.current = true; toast.info("O rascunho tem erros; a simulação pode parar neles."); }
        return saveNow();
    }, [errors.length, saveNow]);

    // ---------- metadados para os painéis ----------
    const graphContactKeys = useMemo(() => contactFieldsIn(graph), [graph]);
    const meta: FlowMeta = useMemo(() => {
        const fields: FieldDef[] = [];
        const seen = new Set<string>();
        const push = (f: FieldDef) => { if (!seen.has(`${f.scope}:${f.key}`)) { seen.add(`${f.scope}:${f.key}`); fields.push(f); } };
        const sys = new Set(SYSTEM_FIELDS.map(f => f.key));
        for (const k of [...knownContactFields, ...graphContactKeys].sort()) if (!sys.has(k)) push({ key: k, label: k, type: "TEXT", scope: "CONTACT" });
        for (const f of extraFields) push(f);
        for (const k of Object.keys(variables)) push({ key: k, label: k, type: "TEXT", scope: "BOT" });
        return { labels, flows, systemFields: SYSTEM_FIELDS, fields };
    }, [graphContactKeys, knownContactFields, extraFields, variables, labels, flows]);

    const addField = useCallback(async (f: FieldDef) => {
        if (f.scope === "BOT") {
            if (!(f.key in variables)) {
                const v = await api.variables.put(sid, { [f.key]: "" });
                client.setQueryData(qk.variables(sid), v);
            }
        } else setExtraFields(x => [...x, f]);
    }, [sid, variables, client]);

    const ctx: EditorApi = {
        sessionId: sid, flowId: initial.id, meta, addField, issuesByNode, hasStats, simNodeId,
        stat: (nodeId, key) => statNodes?.[nodeId]?.[key] ?? 0,
        updateNode: updateNode as EditorApi["updateNode"],
        requestDelete, duplicateNode, openPanel: setPanelId,
    };

    const panelNode = panelId ? graph.nodes.find(n => n.id === panelId) : undefined;
    const currentSig = useMemo(() => signature(graph, triggers), [graph, triggers]);
    const unpublished = publishedSig !== null && publishedSig !== currentSig;
    const st = FLOW_STATUS[status] ?? FLOW_STATUS.draft;

    return (
        <EditorContext.Provider value={ctx}>
            <div className="flex h-full min-h-0 flex-col">
                <header className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-2 [scrollbar-width:none] sm:px-3">
                    <Link to={`/s/${sid}/flows`} className="rounded p-1.5 text-muted hover:bg-subtle hover:text-fg" title="Voltar para a lista"><ArrowLeft className="h-4 w-4" /></Link>
                    <input value={name} onChange={e => setName(e.target.value)} onBlur={rename} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        className="w-28 shrink-0 truncate rounded bg-transparent px-1.5 py-1 text-[14px] font-semibold outline-none hover:bg-subtle focus:bg-subtle sm:w-44 xl:w-60" title="Clique para renomear" aria-label="Nome do fluxo" />
                    <span className="hidden shrink-0 sm:block"><Status tone={st.tone}>{st.label}{publishedVersion ? ` · v${publishedVersion}` : ""}</Status></span>
                    {unpublished && <span className="hidden shrink-0 text-[12px] text-warn md:inline">Alterações não publicadas</span>}
                    <SaveIndicator state={saveState} onRetry={saveNow} onReload={onReload} />

                    <div className="ml-auto flex shrink-0 items-center gap-1">
                        <div className="hidden xl:flex">
                            <IconButton size="icon" title="Desfazer (Ctrl+Z)" onClick={doUndo}><Undo2 className="h-4 w-4" /></IconButton>
                            <IconButton size="icon" title="Refazer (Ctrl+Shift+Z)" onClick={doRedo}><Redo2 className="h-4 w-4" /></IconButton>
                        </div>
                        {publishedVersion ? (
                            <span className="mx-1 hidden items-center gap-1.5 text-[12.5px] md:flex" title="Liga ou desliga a entrada de novos contatos">
                                <Switch checked={status === "active"} onChange={toggleStatus} />Ativo
                            </span>
                        ) : null}
                        <Button size="sm" variant="ghost" icon={<Zap className="h-3.5 w-3.5" />} onClick={() => setDialog("triggers")} title="Gatilhos">
                            <span className="hidden 2xl:inline">Gatilhos</span>{triggers.length > 0 && <span className="tabular text-[11px] text-muted">{triggers.length}</span>}
                        </Button>
                        <div className="hidden md:flex">
                        <Button size="sm" variant="ghost" icon={<History className="h-3.5 w-3.5" />} onClick={() => setDialog("runs")} title="Execuções"><span className="hidden 2xl:inline">Execuções</span></Button>
                        <Button size="sm" variant="ghost" icon={<Braces className="h-3.5 w-3.5" />} onClick={() => setDialog("vars")} title="Variáveis do robô"><span className="hidden 2xl:inline">Variáveis</span></Button>
                        </div>
                        <Button size="sm" variant={simOpen ? "secondary" : "ghost"} icon={<Bot className="h-3.5 w-3.5" />} onClick={() => setSimOpen(o => !o)} title="Conversar com o rascunho sem enviar nada"><span className="hidden xl:inline">Simular</span></Button>
                        <Button size="sm" variant="ghost" icon={<Play className="h-3.5 w-3.5" />} onClick={() => setDialog("test")} title="Testar no meu número"><span className="hidden 2xl:inline">Testar</span></Button>
                        <Popover align="right" width="w-80" open={issuesOpen} onOpenChange={setIssuesOpen} trigger={() => (
                            <Button size="sm" variant="primary" loading={publishing} onClick={publish}
                                icon={errors.length ? <AlertTriangle className="h-3.5 w-3.5" /> : <Rocket className="h-3.5 w-3.5" />}>
                                Publicar{errors.length > 0 && <span className="tabular text-[11px] opacity-70">{errors.length}</span>}
                            </Button>
                        )}>
                            <p className="px-2 pb-1 pt-1.5 text-[12.5px] font-medium">{errors.length || serverIssues.some(i => i.level === "error") ? "Corrija antes de publicar" : "Avisos"}</p>
                            <IssuesList issues={allIssues} onPick={focusNode} />
                        </Popover>
                    </div>
                </header>

                <div ref={wrapper} className="relative min-h-0 flex-1">
                    <ReactFlow
                        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode={theme}
                        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection}
                        onNodeClick={onNodeClick} onPaneClick={() => setPanelId(null)}
                        onNodesDelete={ds => { if (ds.some(d => d.id === panelId)) setPanelId(null); }}
                        deleteKeyCode={["Delete", "Backspace"]} multiSelectionKeyCode={["Shift", "Meta", "Control"]}
                        defaultEdgeOptions={{ type: "flow" }}
                        fitView fitViewOptions={{ padding: 0.3, maxZoom: 1 }} onInit={inst => { setTimeout(() => inst.fitView({ padding: 0.3, maxZoom: 1 }), 60); }} minZoom={0.15} maxZoom={1.75} proOptions={{ hideAttribution: true }}
                    >
                        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--line-strong)" />
                    </ReactFlow>

                    {saveState === "conflict" && (
                        <div className="absolute inset-x-0 top-0 z-30 flex flex-wrap items-center justify-center gap-3 border-b border-line bg-panel px-4 py-2 text-[12.5px]">
                            <span className="text-bad">Outra aba salvou este fluxo. As alterações daqui não foram salvas.</span>
                            <Button size="sm" variant="primary" onClick={onReload}>Recarregar</Button>
                        </div>
                    )}

                    <div className="absolute top-3 z-10 flex flex-col gap-2 transition-[right] duration-150" style={{ right: simOpen ? 392 : 12 }}>
                        <Popover align="right" width="w-56" trigger={({ open, toggle }) => (
                            <button type="button" title="Adicionar bloco" onClick={toggle} className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-ink-fg shadow-lg transition-opacity hover:opacity-90">
                                {open ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                            </button>
                        )}>
                            {close => ADDABLE_BLOCKS.map(t => {
                                const Icon = BLOCK_ICONS[t];
                                return (
                                    <button key={t} type="button" onClick={() => { addBlock(t); close(); }} className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-[13px] hover:bg-subtle">
                                        <span className="h-2 w-2 rounded-full" style={{ background: BLOCKS[t].color }} aria-hidden />
                                        <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.75} />{BLOCKS[t].label}
                                    </button>
                                );
                            })}
                        </Popover>
                        <button type="button" title="Enquadrar todos os blocos" onClick={() => rf.fitView({ padding: 0.3, maxZoom: 1, duration: 250 })}
                            className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-panel text-fg shadow hover:bg-subtle">
                            <Maximize className="h-4 w-4" />
                        </button>
                    </div>

                    {panelNode && <BlockPanel key={panelNode.id} node={panelNode} onClose={() => setPanelId(null)} />}
                    {simOpen && (
                        <Simulator flowId={initial.id} graph={graph} meta={meta} beforeSend={simBeforeSend}
                            onNode={setSimNodeId} onFocusNode={focusNode} onClose={() => setSimOpen(false)} />
                    )}
                </div>
            </div>

            <TriggersSheet open={dialog === "triggers"} onClose={() => setDialog(null)} triggers={triggers} onChange={setTriggers} />
            {dialog === "test" && <TestDialog open onClose={() => setDialog(null)} onRun={runTest} />}
            {dialog === "vars" && <BotVarsDialog open onClose={() => setDialog(null)} sid={sid} />}
            {dialog === "runs" && <RunsSheet open onClose={() => setDialog(null)} flowId={initial.id} graph={graph} />}
        </EditorContext.Provider>
    );
}

function SaveIndicator({ state, onRetry, onReload }: { state: SaveState; onRetry: () => void; onReload: () => void }) {
    if (state === "saving" || state === "dirty") return <span className="hidden shrink-0 text-[12px] text-muted sm:inline">Salvando…</span>;
    if (state === "error") return <button type="button" onClick={onRetry} className="flex shrink-0 items-center gap-1 text-[12px] text-bad"><CloudOff className="h-3.5 w-3.5" />Erro ao salvar · tentar de novo</button>;
    if (state === "conflict") return <button type="button" onClick={onReload} className="flex shrink-0 items-center gap-1 text-[12px] text-bad"><AlertTriangle className="h-3.5 w-3.5" />Alterado em outra aba · recarregar</button>;
    return <span className="hidden shrink-0 items-center gap-1 text-[12px] text-muted sm:flex"><Check className="h-3.5 w-3.5" />Salvo</span>;
}
