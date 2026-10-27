import {
    BLOCKS, LIST_MAX_ROWS, LIST_MAX_ROW_TITLE, POLL_MAX_OPTIONS, POLL_MAX_QUESTION,
    type ConditionData, type FlowGraph, type FlowLinkData, type FlowTrigger, type MenuData, type NodeDataMap,
    type RandomizerData, type SmartDelayData,
} from "./types";

export interface GraphIssue { nodeId?: string; level: "error" | "warning"; message: string }

export const MAX_NODES = 500;
export const MAX_REGEX_LENGTH = 200;

/** Validação usada pelo editor e por publicar/testar. Erro bloqueia; aviso não. */
export function validateGraph(graph: FlowGraph): GraphIssue[] {
    const issues: GraphIssue[] = [];
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return [{ level: "error", message: "Grafo inválido." }];
    if (graph.nodes.length > MAX_NODES) issues.push({ level: "error", message: `O fluxo passa de ${MAX_NODES} blocos.` });
    const ids = new Set(graph.nodes.map(n => n.id));
    if (ids.size !== graph.nodes.length) issues.push({ level: "error", message: "Há blocos com id repetido." });
    const start = graph.nodes.find(n => n.type === "start");
    if (!start) return [...issues, { level: "error", message: "O fluxo não tem bloco inicial." }];
    if (graph.nodes.filter(n => n.type === "start").length > 1) issues.push({ level: "error", message: "O fluxo só pode ter um bloco inicial." });
    if (!graph.edges.some(e => e.source === start.id)) issues.push({ nodeId: start.id, level: "error", message: "Conecte o bloco inicial a outro bloco." });

    for (const n of graph.nodes) {
        const label = n.data?.name || BLOCKS[n.type]?.label || n.type;
        const err = (message: string) => issues.push({ nodeId: n.id, level: "error", message: `${label}: ${message}` });
        const warn = (message: string) => issues.push({ nodeId: n.id, level: "warning", message: `${label}: ${message}` });
        if (!BLOCKS[n.type]) { err("tipo de bloco desconhecido."); continue; }
        switch (n.type) {
            case "content": {
                const d = n.data as NodeDataMap["content"];
                if (!d.items?.length) err("adicione pelo menos um item.");
                for (const it of d.items ?? []) {
                    if (it.kind === "text" && !it.text.trim()) err("há um texto vazio.");
                    if ((it.kind === "image" || it.kind === "video" || it.kind === "audio" || it.kind === "file") && !it.assetId && !it.url) err("há uma mídia sem arquivo.");
                    if (it.kind === "vcard" && (!it.name.trim() || !it.phone.trim())) err("o cartão de contato precisa de nome e telefone.");
                    if (it.kind === "input" && !it.question.trim()) err("a pergunta da captura está vazia.");
                    if (it.kind === "input" && !it.fieldKey) err("escolha o campo onde salvar a resposta.");
                    if (it.kind === "delay" && (it.seconds < 0 || it.seconds > 60)) err("a pausa dentro do conteúdo vai de 0 a 60 segundos.");
                }
                break;
            }
            case "menu": {
                const d = n.data as MenuData;
                if (!d.question.trim()) err("escreva a pergunta.");
                if (!d.options.length) err("adicione pelo menos uma resposta.");
                if (d.options.some(o => !o.text.trim())) err("há uma resposta vazia.");
                if (d.options.some(o => !graph.edges.some(e => e.source === n.id && e.sourceHandle === `option:${o.id}`))) err("há uma resposta sem caminho conectado.");
                if (d.mode === "interactive") {
                    if (d.options.length > POLL_MAX_OPTIONS) err(`o menu interativo aceita no máximo ${POLL_MAX_OPTIONS} respostas.`);
                    if (d.question.length > POLL_MAX_QUESTION) err(`a pergunta do menu interativo passa de ${POLL_MAX_QUESTION} caracteres.`);
                    const texts = d.options.map(o => o.text.trim().toLowerCase());
                    if (new Set(texts).size < texts.length) err("o menu interativo não pode ter duas respostas iguais.");
                    if (d.options.length > LIST_MAX_ROWS || d.options.some(o => o.text.length > LIST_MAX_ROW_TITLE))
                        warn(`na API oficial, mais de ${LIST_MAX_ROWS} respostas ou resposta com mais de ${LIST_MAX_ROW_TITLE} caracteres vira menu numerado.`);
                }
                break;
            }
            case "action": {
                const d = n.data as NodeDataMap["action"];
                if (!d.actions.length) err("adicione pelo menos uma ação.");
                for (const a of d.actions) {
                    if ((a.type === "addTag" || a.type === "removeTag") && !a.labelId) err("escolha a etiqueta.");
                    if ((a.type === "setField" || a.type === "clearField") && !a.fieldKey) err("escolha o campo.");
                    if (a.type === "notify" && (!a.phones.trim() || !a.message.trim())) err("informe o número e a mensagem da notificação.");
                }
                break;
            }
            case "condition": {
                const d = n.data as ConditionData;
                if (!d.conditions.length) err("adicione pelo menos uma condição.");
                for (const c of d.conditions) {
                    if (c.op !== "hasValue" && !String(c.value ?? "").trim()) err("há uma condição sem valor.");
                    if (c.source === "field" && !c.fieldKey) err("há uma condição sem campo.");
                }
                break;
            }
            case "randomizer": {
                const d = n.data as RandomizerData;
                if (d.options.length < 2) err("adicione pelo menos duas opções.");
                if (d.mode === "random" && d.options.reduce((s, o) => s + (Number(o.weight) || 0), 0) !== 100) err("a soma dos percentuais deve ser 100%.");
                break;
            }
            case "smartDelay": {
                const d = n.data as SmartDelayData;
                if (d.mode === "duration") {
                    const days = d.unit === "days" ? d.value : d.unit === "hours" ? d.value / 24 : d.value / 1440;
                    if (!(d.value > 0)) err("defina a duração.");
                    if (days > 30) err("o máximo é 30 dias.");
                } else if (!d.datetime) err("escolha a data e a hora.");
                break;
            }
            case "flowLink":
                if (!(n.data as FlowLinkData).flowId) err("escolha o fluxo.");
                break;
        }
    }

    for (const e of graph.edges) {
        if (!ids.has(e.source) || !ids.has(e.target)) issues.push({ level: "error", message: "Há uma conexão apontando para um bloco que não existe." });
    }

    // aviso de bloco solto (não alcançável a partir do início)
    const out = new Map<string, string[]>();
    for (const e of graph.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    const reach = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length) {
        const id = queue.shift()!;
        for (const t of out.get(id) ?? []) if (!reach.has(t)) { reach.add(t); queue.push(t); }
    }
    for (const n of graph.nodes) if (!reach.has(n.id)) issues.push({ nodeId: n.id, level: "warning", message: `${n.data?.name || BLOCKS[n.type]?.label}: bloco não está ligado ao início.` });
    return issues;
}

export function validateTriggers(triggers: FlowTrigger[]): GraphIssue[] {
    const issues: GraphIssue[] = [];
    for (const t of triggers) {
        if (t.type !== "keyword") continue;
        if (!t.value?.trim()) issues.push({ level: "error", message: "Há um gatilho de palavra-chave sem texto." });
        if (t.match === "regex") {
            if ((t.value ?? "").length > MAX_REGEX_LENGTH) issues.push({ level: "error", message: `A expressão regular passa de ${MAX_REGEX_LENGTH} caracteres.` });
            try { new RegExp(t.value ?? "", "i"); } catch { issues.push({ level: "error", message: `Expressão regular inválida: ${t.value}` }); }
        }
    }
    return issues;
}

export const hasErrors = (issues: GraphIssue[]) => issues.some(i => i.level === "error");
