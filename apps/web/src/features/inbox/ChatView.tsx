import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Archive, ArchiveRestore, ArrowLeft, Bot, Check, CheckCheck, Clock, FileText, Paperclip, Send, X } from "lucide-react";
import { formatPhone } from "@areszap/core";
import { api, qk, type Chat, type Message } from "@/api";
import { useSession } from "@/features/sessions/queries";
import { fmtBytes, fmtDateTime, fmtDay, fmtTime, isFuture } from "@/lib/format";
import { Button, IconButton } from "@/ui/button";
import { MenuItem, Popover } from "@/ui/overlay";
import { Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";

const PAGE = 50;

const SENDER: Record<string, string> = { flow: "Fluxo", broadcast: "Transmissão", agent: "", api: "API", phone: "Celular", notify: "Notificação" };

export function ChatView({ sid, chatId, chat }: { sid: string; chatId: string; chat?: Chat }) {
    const client = useQueryClient();
    const scroller = useRef<HTMLDivElement>(null);
    const prevHeight = useRef<number | null>(null);
    const stick = useRef(true);

    const msgs = useInfiniteQuery({
        queryKey: qk.messages(chatId),
        queryFn: ({ pageParam }) => api.chats.messages(chatId, pageParam, PAGE),
        initialPageParam: null as string | null,
        getNextPageParam: last => (last.items.length < PAGE ? undefined : last.items[last.items.length - 1].createdAt),
    });
    // páginas vêm da mais nova para a mais antiga; na tela, de cima (antiga) para baixo (nova)
    const list = (msgs.data?.pages.flatMap(p => p.items) ?? []).slice().reverse();
    const newest = list[list.length - 1]?.id;
    const oldest = list[0]?.id;

    // marca como lida ao abrir / quando chega mensagem com a conversa aberta
    const unread = chat?.unread ?? 0;
    useEffect(() => {
        if (!unread) return;
        api.chats.read(chatId).then(() => { client.invalidateQueries({ queryKey: qk.chats(sid) }); client.invalidateQueries({ queryKey: qk.chat(chatId) }); }).catch(() => undefined);
    }, [chatId, unread, sid, client]);

    // mantém a posição quando carrega mensagens antigas; desce quando chega nova e o usuário está no fim
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        if (prevHeight.current !== null) {
            el.scrollTop += el.scrollHeight - prevHeight.current;
            prevHeight.current = null;
        }
    }, [oldest]);
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [newest]);

    const onScroll = () => {
        const el = scroller.current;
        if (!el) return;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (el.scrollTop < 120 && msgs.hasNextPage && !msgs.isFetchingNextPage) {
            prevHeight.current = el.scrollHeight;
            msgs.fetchNextPage();
        }
    };

    const archive = useMutation({
        mutationFn: (v: boolean) => api.chats.archive(chatId, v),
        onSuccess: (_, v) => { client.invalidateQueries({ queryKey: qk.chats(sid) }); client.invalidateQueries({ queryKey: qk.chat(chatId) }); toast.success(v ? "Conversa arquivada" : "Conversa desarquivada"); },
        onError: e => toast.error(e),
    });
    const automation = useMutation({
        mutationFn: (b: { action: "resume" } | { action: "pause"; minutes: number }) => api.chats.automation(chatId, b),
        onSuccess: r => {
            client.invalidateQueries({ queryKey: qk.chats(sid) });
            client.invalidateQueries({ queryKey: qk.chat(chatId) });
            toast.success(r.pausedUntil ? `Robô pausado até ${fmtDateTime(r.pausedUntil)}` : "Robô reativado para este contato");
        },
        onError: e => toast.error(e),
    });

    const paused = isFuture(chat?.pausedUntil);
    const title = chat ? chat.title || formatPhone(chat.phone) : "Conversa";

    return (
        <>
            <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
                <Link to={`/s/${sid}/inbox`} className="rounded p-1.5 text-muted hover:bg-subtle hover:text-fg md:hidden" aria-label="Voltar"><ArrowLeft className="h-4 w-4" /></Link>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold">{title}</p>
                    {chat?.phone && chat.title && <p className="truncate text-[12px] text-muted">{formatPhone(chat.phone)}</p>}
                </div>
                {!paused && (
                    <Popover align="right" width="w-48" trigger={({ toggle }) => <Button size="sm" variant="ghost" icon={<Bot className="h-3.5 w-3.5" />} onClick={toggle}><span className="hidden sm:inline">Pausar robô</span></Button>}>
                        {close => [[30, "30 minutos"], [120, "2 horas"], [1440, "24 horas"], [10080, "7 dias"]].map(([m, l]) => (
                            <MenuItem key={m} onClick={() => { close(); automation.mutate({ action: "pause", minutes: Number(m) }); }}>{l}</MenuItem>
                        ))}
                    </Popover>
                )}
                {chat && (
                    <IconButton title={chat.archived ? "Desarquivar" : "Arquivar"} onClick={() => archive.mutate(!chat.archived)}>
                        {chat.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                    </IconButton>
                )}
            </header>

            {paused && (
                <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-[12.5px] text-warn">
                    <Bot className="h-3.5 w-3.5" />
                    <span className="flex-1">Robô pausado até {fmtDateTime(chat!.pausedUntil)}. Fluxos não respondem este contato.</span>
                    <button type="button" className="font-medium underline underline-offset-2" disabled={automation.isPending} onClick={() => automation.mutate({ action: "resume" })}>Reativar</button>
                </div>
            )}
            {chat?.activeRun && (
                <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-[12.5px] text-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-fg" />
                    Em fluxo: <Link to={`/s/${sid}/flows/${chat.activeRun.flowId}`} className="font-medium text-fg underline-offset-2 hover:underline">{chat.activeRun.flowName}</Link>
                    <span>· {RUN_LABEL[chat.activeRun.status] ?? chat.activeRun.status}</span>
                </div>
            )}

            <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-canvas px-3 py-4 sm:px-6">
                {msgs.isPending ? <div className="flex justify-center py-8 text-muted"><Spinner /></div>
                    : msgs.isError ? <p className="text-center text-[13px] text-bad">{msgs.error.message}</p>
                        : (
                            <div className="mx-auto max-w-3xl space-y-1">
                                {msgs.isFetchingNextPage && <div className="flex justify-center py-2 text-muted"><Spinner className="h-3.5 w-3.5" /></div>}
                                {!msgs.hasNextPage && list.length > 0 && <p className="py-2 text-center text-[11.5px] text-faint">Início da conversa</p>}
                                {!list.length && <p className="py-8 text-center text-[13px] text-muted">Nenhuma mensagem.</p>}
                                {list.map((m, i) => {
                                    const day = fmtDay(m.createdAt);
                                    const showDay = i === 0 || fmtDay(list[i - 1].createdAt) !== day;
                                    return (
                                        <Fragment key={m.id}>
                                            {showDay && <p className="sticky top-0 z-10 py-2 text-center text-[11.5px] text-muted"><span className="rounded-full border border-line bg-bg px-2.5 py-0.5">{day}</span></p>}
                                            <Bubble m={m} />
                                        </Fragment>
                                    );
                                })}
                            </div>
                        )}
            </div>

            <Composer sid={sid} chatId={chatId} onSent={() => { stick.current = true; }} />
        </>
    );
}

const RUN_LABEL: Record<string, string> = {
    running: "executando", waiting_input: "aguardando resposta", waiting_delay: "em espera", completed: "concluído", failed: "falhou", expired: "sem resposta", cancelled: "cancelado",
};

function StatusIcon({ s }: { s: Message["status"] }) {
    if (s === "queued") return <Clock className="h-3 w-3" aria-label="Na fila" />;
    if (s === "sent") return <Check className="h-3 w-3" aria-label="Enviada" />;
    if (s === "delivered") return <CheckCheck className="h-3 w-3" aria-label="Entregue" />;
    if (s === "read") return <CheckCheck className="h-3 w-3 text-fg" aria-label="Lida" />;
    if (s === "failed") return <AlertCircle className="h-3 w-3 text-bad" aria-label="Falhou" />;
    return null;
}

function Media({ m }: { m: Message }) {
    if (!m.media) return null;
    const url = api.assets.fileUrl(m.media.assetId);
    const mime = m.media.mime || "";
    if (mime.startsWith("image/")) return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={m.media.fileName ?? "Imagem"} loading="lazy" className="max-h-72 max-w-full rounded" /></a>;
    if (mime.startsWith("video/")) return <video src={url} controls preload="metadata" className="max-h-72 max-w-full rounded" />;
    if (mime.startsWith("audio/")) return <audio src={url} controls preload="none" className="w-64 max-w-full" />;
    return (
        <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded border border-line px-2.5 py-2 text-[13px] hover:bg-subtle">
            <FileText className="h-4 w-4 text-muted" /><span className="truncate">{m.media.fileName || "Arquivo"}</span>
        </a>
    );
}

function Bubble({ m }: { m: Message }) {
    const mine = m.fromMe;
    const label = mine ? SENDER[m.sender] : "";
    const body = m.body ?? (m.media ? "" : `[${m.type}]`);
    return (
        <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-1.5 text-[13.5px] sm:max-w-[70%] ${mine ? "bg-subtle" : "border border-line bg-bg"} ${m.status === "failed" ? "border border-bad/40" : ""}`}>
                {label && <p className="mb-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted">{label}</p>}
                {m.media && <div className="mb-1"><Media m={m} /></div>}
                {body && <p className="whitespace-pre-wrap break-words">{body}</p>}
                <p className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-muted">
                    {fmtTime(m.createdAt)}{mine && <StatusIcon s={m.status} />}
                </p>
            </div>
        </div>
    );
}

function Composer({ sid, chatId, onSent }: { sid: string; chatId: string; onSent: () => void }) {
    const client = useQueryClient();
    const { data: session } = useSession(sid);
    const [text, setText] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const area = useRef<HTMLTextAreaElement>(null);

    useLayoutEffect(() => {
        const el = area.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight + 2, 180)}px`;
        el.style.overflowY = el.scrollHeight > 180 ? "auto" : "hidden";
    }, [text]);

    const send = useMutation({
        mutationFn: async () => {
            if (file) {
                const asset = await api.assets.upload(sid, file);
                return api.chats.send(chatId, { assetId: asset.id, ...(text.trim() ? { caption: text.trim() } : {}) });
            }
            return api.chats.send(chatId, { text: text.trim() });
        },
        onSuccess: () => {
            setText(""); setFile(null); onSent();
            client.invalidateQueries({ queryKey: qk.messages(chatId) });
            client.invalidateQueries({ queryKey: qk.chats(sid) });
        },
        onError: e => toast.error(e),
    });

    const can = (text.trim() || file) && !send.isPending;
    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (can) send.mutate(); }
    };
    const ht = session?.settings?.humanTakeover;

    return (
        <div className="shrink-0 border-t border-line bg-bg px-3 py-2.5">
            {file && (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-[12.5px]">
                    <Paperclip className="h-3.5 w-3.5 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="text-muted">{fmtBytes(file.size)}</span>
                    <IconButton title="Remover anexo" onClick={() => setFile(null)}><X className="h-3.5 w-3.5" /></IconButton>
                </div>
            )}
            <div className="flex items-end gap-2">
                <input ref={fileInput} type="file" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }} />
                <IconButton size="icon" title="Anexar arquivo" onClick={() => fileInput.current?.click()}><Paperclip className="h-4 w-4" /></IconButton>
                <textarea
                    ref={area}
                    rows={1}
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={onKey}
                    placeholder={file ? "Legenda (opcional)" : "Escreva uma mensagem"}
                    className="max-h-[180px] min-h-9 flex-1 resize-none rounded-md border border-line bg-bg px-3 py-[7px] text-[13.5px] outline-none placeholder:text-faint focus:border-fg"
                />
                <Button variant="primary" size="icon" title="Enviar" aria-label="Enviar" disabled={!can} loading={send.isPending} onClick={() => send.mutate()}>
                    {!send.isPending && <Send className="h-4 w-4" />}
                </Button>
            </div>
            {ht?.enabled && <p className="mt-1.5 px-11 text-[11.5px] text-faint">Responder por aqui pausa o robô deste contato por {ht.minutes >= 60 ? `${Math.round(ht.minutes / 60)} h` : `${ht.minutes} min`}. Enter envia, Shift+Enter quebra linha.</p>}
        </div>
    );
}
