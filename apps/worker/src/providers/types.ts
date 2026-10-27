import type { IncomingType, OutMessage, SessionStatus } from "@areszap/core";

export interface InboundMedia {
    mime?: string;
    fileName?: string;
    size?: number;
    /** Baixa o arquivo sob demanda (Baileys: mídia do WhatsApp; API oficial: Graph API). */
    download: () => Promise<{ buffer: Buffer; mime: string; fileName?: string }>;
}

/** Mensagem recebida já normalizada, igual para os dois provedores. */
export interface InboundMessage {
    jid: string;               // jid do contato (telefone quando conhecido)
    waId: string;
    fromMe: boolean;
    /** true = mensagem nova em tempo real; false = histórico/eco (não dispara fluxo). */
    live: boolean;
    type: IncomingType;
    text: string;
    pushName?: string | null;
    timestamp: Date;
    media?: InboundMedia;
    quotedWaId?: string | null;
    /** Resposta de lista/botão da API oficial (id da opção). */
    interactiveReplyId?: string | null;
    /** Voto em enquete (Baileys): o pipeline decifra com o segredo guardado pelo motor. */
    pollVote?: { pollId: string; voters: string[]; encPayload: Uint8Array; encIv: Uint8Array };
}

export interface Receipt { waId: string; jid: string; status: "sent" | "delivered" | "read" | "failed"; error?: string }

export interface ProviderHandlers {
    status: (status: SessionStatus, info?: { qr?: string | null; phone?: string | null; error?: string | null }) => void;
    inbound: (messages: InboundMessage[]) => void;
    receipts: (receipts: Receipt[]) => void;
}

export interface MediaPayload { buffer: Buffer; mime: string; fileName: string }

export interface Provider {
    readonly kind: "baileys" | "cloud";
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Desconecta o aparelho e apaga as credenciais. */
    logout(): Promise<void>;
    isReady(): boolean;
    /** Envia e devolve o id da mensagem no WhatsApp. `waId` é o id pré-gerado (o Baileys usa; a API oficial gera o dele). */
    send(jid: string, msg: OutMessage, opts: { waId: string; media?: MediaPayload; mediaKey?: string }): Promise<{ waId: string }>;
    presence(jid: string, state: "composing" | "paused"): Promise<void>;
    /** Lê o voto de uma enquete enviada pelo motor. Devolve o índice da opção ou null. */
    readPollVote?(vote: NonNullable<InboundMessage["pollVote"]>, poll: { id: string; secret: string; values: string[] }): number | null;
    /** Erro que indica número banido/restrito: o sender pausa a sessão em vez de tentar de novo. */
    isFatalSendError?(err: unknown): boolean;
}
