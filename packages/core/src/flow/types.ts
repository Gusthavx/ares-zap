// Modelo do grafo de fluxos. Compartilhado entre o editor (navegador), o motor e a API: sem imports de servidor aqui.
// Portado do MarcFlow (MIT, Marcos Maia) — src/modules/flows/types.ts — com gatilhos versionados e menu interativo.

export type NodeType =
    | "start"
    | "content"
    | "menu"
    | "action"
    | "condition"
    | "randomizer"
    | "smartDelay"
    | "flowLink";

export type TimeUnit = "seconds" | "minutes" | "hours" | "days";
export type FieldScope = "CONTACT" | "BOT";
export type FieldType = "TEXT" | "NUMBER" | "DATE" | "DATETIME";

export type AnswerType =
    | "text" | "number" | "date" | "datetime" | "firstName" | "lastName" | "fullName"
    | "email" | "cpf" | "image" | "video" | "audio" | "file";

export type MediaKind = "image" | "video" | "audio" | "file";

export type ContentItem =
    | { id: string; kind: "text"; text: string }
    | { id: string; kind: MediaKind; assetId?: string; url?: string; caption?: string; fileName?: string }
    | { id: string; kind: "delay"; seconds: number; typing: boolean }
    | { id: string; kind: "vcard"; name: string; phone: string; org?: string }
    | {
        id: string; kind: "input"; question: string; answerType: AnswerType;
        fieldKey?: string; fieldScope?: FieldScope;
        expireValue: number; expireUnit: TimeUnit;
        errorMessage: string; maxAttempts: number;
    };

export interface MenuOption { id: string; text: string }

/** Limites da enquete do WhatsApp (Baileys). */
export const POLL_MAX_OPTIONS = 12;
export const POLL_MAX_QUESTION = 255;
/** Limites da lista interativa da API oficial. Acima disso o provedor manda menu numerado. */
export const LIST_MAX_ROWS = 10;
export const LIST_MAX_ROW_TITLE = 24;

export interface MenuData {
    /** "number" = texto numerado; "interactive" = enquete no Baileys, lista/botões na API oficial. */
    mode?: "number" | "interactive";
    question: string;
    invalidText: string;
    maxErrors: number; // 0 = nunca usa a saída de erro
    options: MenuOption[];
    expireValue: number;
    expireUnit: TimeUnit;
}

export type FlowAction =
    | { id: string; type: "addTag" | "removeTag"; labelId?: string }
    | { id: string; type: "setField"; fieldKey?: string; fieldScope?: FieldScope; value: string }
    | { id: string; type: "clearField"; fieldKey?: string; fieldScope?: FieldScope }
    | { id: string; type: "notify"; phones: string; message: string }
    | { id: string; type: "pauseAutomation"; forever: boolean; value: number; unit: TimeUnit }
    | { id: string; type: "resumeAutomation" }
    | { id: string; type: "optOut" };

export type ConditionSource = "tag" | "weekday" | "time" | "field";
export type ConditionOp =
    | "is" | "isNot" | "contains" | "notContains" | "startsWith" | "hasValue"
    | "containsAny"
    | "gt" | "gte" | "lt" | "lte" | "eq" | "neq"
    | "after" | "before" | "on";

export interface FlowCondition {
    id: string;
    source: ConditionSource;
    fieldKey?: string;
    fieldScope?: FieldScope;
    fieldType?: FieldType;
    op: ConditionOp;
    value: string; // labelId | dia 0-6 | "HH:MM" | texto/número/data
}

export interface ConditionData { logic: "and" | "or"; conditions: FlowCondition[] }
export interface RandomizerOption { id: string; weight: number }
export interface RandomizerData { mode: "random" | "sequential"; options: RandomizerOption[] }
export interface SmartDelayData { mode: "duration" | "datetime"; value: number; unit: "minutes" | "hours" | "days"; datetime?: string }
export interface FlowLinkData { flowId?: string }

export interface NodeDataMap {
    start: Record<string, unknown>;
    content: { items: ContentItem[] };
    menu: MenuData;
    action: { actions: FlowAction[] };
    condition: ConditionData;
    randomizer: RandomizerData;
    smartDelay: SmartDelayData;
    flowLink: FlowLinkData;
}

/** Nome opcional do bloco mostrado no editor. O motor ignora. */
export interface NodeMeta { name?: string }

export interface FlowNode<T extends NodeType = NodeType> {
    id: string;
    type: T;
    position: { x: number; y: number };
    data: NodeDataMap[T] & NodeMeta;
}

export interface FlowEdge { id: string; source: string; sourceHandle: string; target: string }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

// ---------- gatilhos (versionados junto com o grafo publicado) ----------
export type TriggerType = "keyword" | "firstMessage" | "anyMessage";
export type KeywordMatch = "exact" | "word" | "contains" | "regex";
export interface FlowTrigger {
    id: string;
    type: TriggerType;
    match?: KeywordMatch;
    value?: string;
    priority: number;
}

export const BLOCKS: Record<NodeType, { label: string; color: string }> = {
    start: { label: "Bloco inicial", color: "#64748B" },
    content: { label: "Conteúdo", color: "#EC5858" },
    menu: { label: "Menu", color: "#683AC8" },
    action: { label: "Ação", color: "#F5B715" },
    condition: { label: "Condição", color: "#5175F5" },
    flowLink: { label: "Conexão de fluxo", color: "#3ABA38" },
    randomizer: { label: "Randomizador", color: "#1FBADC" },
    smartDelay: { label: "Atraso inteligente", color: "#F0875A" },
};

export const ADDABLE_BLOCKS: NodeType[] = ["content", "menu", "action", "condition", "flowLink", "randomizer", "smartDelay"];

export const ANSWER_TYPES: { value: AnswerType; label: string }[] = [
    { value: "text", label: "Texto" }, { value: "number", label: "Número" }, { value: "date", label: "Data" },
    { value: "datetime", label: "Data e hora" }, { value: "firstName", label: "Primeiro nome" },
    { value: "lastName", label: "Sobrenome" }, { value: "fullName", label: "Nome completo" },
    { value: "email", label: "E-mail" }, { value: "cpf", label: "CPF" }, { value: "image", label: "Imagem" },
    { value: "video", label: "Vídeo" }, { value: "audio", label: "Áudio" }, { value: "file", label: "Arquivo" },
];

export const SYSTEM_FIELDS: { key: string; label: string; type: FieldType }[] = [
    { key: "nome-completo", label: "Nome completo", type: "TEXT" },
    { key: "primeiro-nome", label: "Primeiro nome", type: "TEXT" },
    { key: "sobrenome", label: "Sobrenome", type: "TEXT" },
    { key: "telefone", label: "Telefone", type: "TEXT" },
    { key: "ddd", label: "DDD", type: "TEXT" },
    { key: "ultima-mensagem", label: "Última mensagem recebida", type: "TEXT" },
    { key: "agora", label: "Data e hora atual", type: "DATETIME" },
];

export const WEEKDAYS = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

/** Id curto e estável para nós, arestas, itens e opções. */
export const newId = () => {
    const bytes = new Uint8Array(6);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
};

export function emptyGraph(): FlowGraph {
    return { nodes: [{ id: "start", type: "start", position: { x: 0, y: 0 }, data: {} }], edges: [] };
}

export function defaultData<T extends NodeType>(type: T): NodeDataMap[T] {
    const d: { [K in NodeType]: NodeDataMap[K] } = {
        start: {},
        content: { items: [] },
        menu: { mode: "number", question: "", invalidText: "Opção inválida. Responda com o número de uma das opções.", maxErrors: 3, options: [], expireValue: 1, expireUnit: "days" },
        action: { actions: [] },
        condition: { logic: "or", conditions: [] },
        randomizer: { mode: "random", options: [] },
        smartDelay: { mode: "duration", value: 0, unit: "minutes" },
        flowLink: {},
    };
    return structuredClone(d[type]);
}

/** Saídas de um bloco, na ordem de exibição. O id é o que a aresta guarda em sourceHandle. */
export function outputsOf(node: FlowNode): { id: string; label: string }[] {
    switch (node.type) {
        case "start": return [{ id: "next", label: "Início" }];
        case "content": {
            const outs: { id: string; label: string }[] = [];
            for (const it of (node.data as NodeDataMap["content"]).items) {
                if (it.kind === "input") {
                    outs.push({ id: `input:${it.id}:valid`, label: "Resposta válida" });
                    outs.push({ id: `input:${it.id}:timeout`, label: "Se não responder" });
                }
            }
            outs.push({ id: "next", label: "Próximo passo" });
            return outs;
        }
        case "menu": {
            const d = node.data as MenuData;
            return [
                ...d.options.map((o, i) => ({ id: `option:${o.id}`, label: `${i + 1}. ${o.text || "Resposta " + (i + 1)}` })),
                ...(d.maxErrors > 0 ? [{ id: "error", label: "Saída de erro" }] : []),
                { id: "timeout", label: "Se não responder" },
            ];
        }
        case "condition": return [{ id: "true", label: "Verdadeiro" }, { id: "false", label: "Falso" }];
        case "randomizer": return (node.data as RandomizerData).options.map((o, i) => ({ id: `option:${o.id}`, label: `Opção ${i + 1}` }));
        case "flowLink": return [];
        default: return [{ id: "next", label: "Próximo passo" }];
    }
}
