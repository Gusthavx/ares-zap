import { newId, type FlowGraph, type FlowTrigger } from "@areszap/core";
import { HttpError } from "./http";

/**
 * Aceita o JSON exportado pelo Ares Zap ou o grafo do MarcFlow (FlowGraph + FlowTrigger do Prisma)
 * e devolve no formato atual, com avisos do que foi adaptado.
 */
export function importFlow(body: unknown): { name: string; graph: FlowGraph; triggers: FlowTrigger[]; warnings: string[] } {
    const b = (body ?? {}) as Record<string, any>;
    const graph = (b.graph ?? b.draftGraph ?? b.publishedGraph ?? (Array.isArray(b.nodes) ? { nodes: b.nodes, edges: b.edges ?? [] } : null)) as FlowGraph | null;
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new HttpError(400, "JSON sem grafo de fluxo (nodes/edges)");
    if (graph.nodes.length > 500) throw new HttpError(400, "Fluxo grande demais (máx. 500 blocos)");
    const warnings: string[] = [];

    const nodes = graph.nodes.map(n => {
        const node = structuredClone(n) as any;
        if (node.type === "menu" && node.data?.mode === "poll") node.data.mode = "interactive";
        if (node.type === "content" && Array.isArray(node.data?.items)) {
            const before = node.data.items.length;
            node.data.items = node.data.items.filter((it: any) => it.kind !== "autoOff");
            if (node.data.items.length < before) warnings.push("Itens \"desligar resposta automática\" foram removidos (não existem no Ares Zap).");
            for (const it of node.data.items) if ((it.kind === "image" || it.kind === "video" || it.kind === "audio" || it.kind === "file") && it.assetId && !it.url) {
                warnings.push("Há mídia apontando para arquivo do sistema antigo: suba o arquivo de novo no bloco.");
                delete it.assetId;
            }
        }
        if (node.type === "flowLink" && node.data?.flowId) {
            warnings.push("Conexões de fluxo precisam ser refeitas (os ids de fluxo mudam na importação).");
            node.data.flowId = undefined;
        }
        return node;
    });

    const rawTriggers: any[] = Array.isArray(b.triggers) ? b.triggers : [];
    const triggers: FlowTrigger[] = rawTriggers.map(t => {
        const type = String(t.type ?? "");
        const mapType = type === "KEYWORD" ? "keyword" : type === "FIRST_MESSAGE" ? "firstMessage" : type === "ANY_MESSAGE" ? "anyMessage" : type;
        const m = String(t.match ?? t.matchType ?? "exact").toLowerCase();
        return {
            id: t.id && String(t.id).length <= 40 ? String(t.id) : newId(),
            type: (["keyword", "firstMessage", "anyMessage"].includes(mapType) ? mapType : "keyword") as FlowTrigger["type"],
            match: (["exact", "word", "contains", "regex"].includes(m) ? m : "exact") as FlowTrigger["match"],
            value: t.value ?? t.keyword ?? undefined,
            priority: Number(t.priority) || 0,
        };
    });

    return {
        name: String(b.name || "Fluxo importado").slice(0, 120),
        graph: { nodes, edges: graph.edges.map(e => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target })) },
        triggers,
        warnings: [...new Set(warnings)],
    };
}
