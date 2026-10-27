// Mensagem de saída neutra: o motor e a API produzem isto; cada provedor (Baileys / API oficial) traduz.

export type OutMessage =
    | { kind: "text"; text: string }
    | { kind: "media"; media: "image" | "video" | "audio" | "file"; assetId?: string; url?: string; caption?: string; fileName?: string; mime?: string }
    | { kind: "vcard"; name: string; phone: string; org?: string }
    | {
        kind: "menu";
        question: string;
        options: { id: string; text: string }[];
        mode: "number" | "interactive";
        /** Enquete do Baileys: id da mensagem e segredo escolhidos pelo motor, para ler o voto depois. */
        messageId?: string;
        pollSecret?: string;
    }
    | { kind: "template"; name: string; language: string; components?: unknown[] };

export type OutSource = "flow" | "broadcast" | "agent" | "api" | "notify";

/** Prioridade na fila do número: conversa antes de envio em massa. */
export const PRIORITY = { conversation: 0, notify: 0, agent: 0, api: 1, bulk: 2 } as const;

/** Resumo curto para log e lista de conversas. */
export function summarize(m: OutMessage): string {
    switch (m.kind) {
        case "text": return m.text.slice(0, 200);
        case "media": return m.caption?.slice(0, 200) || `[${m.media}${m.fileName ? `: ${m.fileName}` : ""}]`;
        case "vcard": return `[contato: ${m.name}]`;
        case "menu": return `📋 ${m.question.slice(0, 180)}`;
        case "template": return `[modelo: ${m.name}]`;
    }
}

/** Id no formato que o WhatsApp Web usa (3EB0 + hex maiúsculo). O motor gera antes de enfileirar. */
export function newWaMessageId(): string {
    const bytes = new Uint8Array(9);
    globalThis.crypto.getRandomValues(bytes);
    return "3EB0" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
