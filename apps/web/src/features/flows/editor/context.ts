// Adaptado do MarcFlow (MIT, Marcos Maia) — src/components/flows/editor-context.tsx
import { createContext, useContext } from "react";
import type { FieldScope, FieldType, GraphIssue, NodeDataMap, NodeType } from "@areszap/core";
import type { FlowSummary, Label } from "@/api";

export interface FieldDef { key: string; label: string; type: FieldType; scope: FieldScope }

export interface FlowMeta {
    labels: Label[];
    /** Campos do contato e do robô conhecidos (não inclui os do sistema). */
    fields: FieldDef[];
    systemFields: { key: string; label: string; type: FieldType }[];
    flows: FlowSummary[];
}

export interface EditorApi {
    sessionId: string;
    flowId: string;
    meta: FlowMeta;
    /** Registra um campo novo (contato: só no editor; robô: grava variável vazia). */
    addField: (f: FieldDef) => Promise<void>;
    issuesByNode: Record<string, GraphIssue[]>;
    stat: (nodeId: string, key: string) => number;
    hasStats: boolean;
    simNodeId: string | null;
    updateNode: <T extends NodeType>(id: string, data: NodeDataMap[T]) => void;
    requestDelete: (id: string) => void;
    duplicateNode: (id: string) => void;
    openPanel: (id: string) => void;
}

export const EditorContext = createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
    const ctx = useContext(EditorContext);
    if (!ctx) throw new Error("useEditor fora do editor");
    return ctx;
}

/** Variáveis usáveis como {chave} nos textos, agrupadas como no seletor. */
export function variableGroups(meta: FlowMeta) {
    return [
        { label: "Campos do sistema", items: meta.systemFields.map(f => ({ key: f.key, label: f.label })) },
        { label: "Campos do contato", items: meta.fields.filter(f => f.scope === "CONTACT").map(f => ({ key: f.key, label: f.label })) },
        { label: "Campos do robô", items: meta.fields.filter(f => f.scope === "BOT").map(f => ({ key: f.key, label: f.label })) },
    ].filter(g => g.items.length);
}

export function fieldLabel(meta: FlowMeta, key?: string) {
    if (!key) return "";
    return meta.systemFields.find(f => f.key === key)?.label || meta.fields.find(f => f.key === key)?.label || key;
}
