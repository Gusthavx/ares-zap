import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Search, Workflow } from "lucide-react";
import { formatPhone } from "@areszap/core";
import { api, qk, type Chat, type Page as ApiPage } from "@/api";
import { useDebounced, useSessionId } from "@/lib/hooks";
import { fmtShort, isFuture } from "@/lib/format";
import { Input, Segmented } from "@/ui/form";
import { Spinner } from "@/ui/misc";
import { ChatView } from "./ChatView";

export function InboxPage() {
    const sid = useSessionId();
    const { chatId } = useParams();
    const [search, setSearch] = useState("");
    const [archived, setArchived] = useState<"open" | "archived">("open");
    const q = useDebounced(search.trim(), 300);
    const client = useQueryClient();

    const chats = useInfiniteQuery({
        queryKey: [...qk.chats(sid), { q, archived }],
        queryFn: ({ pageParam }) => api.chats.list(sid, { search: q, archived: archived === "archived", cursor: pageParam }),
        initialPageParam: null as string | null,
        getNextPageParam: last => last.nextCursor,
        enabled: !!sid,
    });
    const items = chats.data?.pages.flatMap(p => p.items) ?? [];

    // conversa aberta: procura em qualquer lista já carregada (busca diferente, arquivadas…)
    let open: Chat | undefined = items.find(c => c.id === chatId);
    if (!open && chatId) {
        for (const [, data] of client.getQueriesData<InfiniteData<ApiPage<Chat>>>({ queryKey: qk.chats(sid) })) {
            open = data?.pages.flatMap(p => p.items).find(c => c.id === chatId);
            if (open) break;
        }
    }

    // link direto para uma conversa fora das listas carregadas: busca só ela
    const single = useQuery({ queryKey: qk.chat(chatId ?? ""), queryFn: () => api.chats.get(chatId!), enabled: !!chatId && !open });
    if (!open) open = single.data;

    return (
        <div className="flex h-full min-h-0">
            <div className={`${chatId ? "hidden md:flex" : "flex"} w-full min-w-0 flex-col border-r border-line md:w-[320px] md:shrink-0 xl:w-[360px]`}>
                <div className="space-y-2 border-b border-line p-3">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar nome, número ou mensagem" className="pl-8" aria-label="Buscar conversas" />
                    </div>
                    <Segmented value={archived} onChange={setArchived} className="w-full" options={[{ value: "open", label: "Abertas" }, { value: "archived", label: "Arquivadas" }]} />
                </div>
                <ChatList sid={sid} chats={items} activeId={chatId} loading={chats.isPending} error={chats.error}
                    hasMore={!!chats.hasNextPage} loadingMore={chats.isFetchingNextPage} onMore={() => chats.fetchNextPage()} searching={!!q} />
            </div>
            <div className={`${chatId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
                {chatId ? <ChatView key={chatId} sid={sid} chatId={chatId} chat={open} /> : (
                    <div className="flex flex-1 items-center justify-center p-6 text-center text-[13px] text-muted">Escolha uma conversa à esquerda.</div>
                )}
            </div>
        </div>
    );
}

function ChatList({ sid, chats, activeId, loading, error, hasMore, loadingMore, onMore, searching }: {
    sid: string; chats: Chat[]; activeId?: string; loading: boolean; error: Error | null; hasMore: boolean; loadingMore: boolean; onMore: () => void; searching: boolean;
}) {
    const navigate = useNavigate();
    const sentinel = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = sentinel.current;
        if (!el || !hasMore) return;
        const io = new IntersectionObserver(e => { if (e[0].isIntersecting && !loadingMore) onMore(); }, { rootMargin: "200px" });
        io.observe(el);
        return () => io.disconnect();
    }, [hasMore, loadingMore, onMore]);

    if (loading) return <div className="flex flex-1 justify-center p-6 text-muted"><Spinner /></div>;
    if (error) return <p className="p-4 text-[13px] text-bad">{error.message}</p>;
    if (!chats.length) return <p className="p-6 text-center text-[13px] text-muted">{searching ? "Nada encontrado." : "Nenhuma conversa ainda."}</p>;

    return (
        <div className="min-h-0 flex-1 overflow-y-auto">
            <ul>
                {chats.map(c => {
                    const paused = isFuture(c.pausedUntil);
                    return (
                        <li key={c.id}>
                            <button type="button" onClick={() => navigate(`/s/${sid}/inbox/${c.id}`)}
                                className={`flex w-full gap-3 border-b border-line px-3.5 py-3 text-left transition-colors ${c.id === activeId ? "bg-subtle" : "hover:bg-subtle/60"}`}>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2">
                                        <p className={`min-w-0 flex-1 truncate text-[13.5px] ${c.unread ? "font-semibold" : "font-medium"}`}>{c.title || formatPhone(c.phone)}</p>
                                        <span className={`shrink-0 text-[11.5px] ${c.unread ? "text-fg" : "text-muted"}`}>{fmtShort(c.lastMessageAt)}</span>
                                    </div>
                                    <div className="mt-0.5 flex items-center gap-2">
                                        <p className={`min-w-0 flex-1 truncate text-[12.5px] ${c.unread ? "text-fg" : "text-muted"}`}>
                                            {c.lastFromMe && <span className="text-muted">Você: </span>}{c.lastMessageText || " "}
                                        </p>
                                        {c.activeRun && <span title={`Em fluxo: ${c.activeRun.flowName}`}><Workflow className="h-3.5 w-3.5 text-muted" /></span>}
                                        {paused && <span className="text-[11px] text-warn" title="Robô pausado para este contato">pausado</span>}
                                        {c.unread > 0 && <span className="tabular min-w-[18px] rounded-full bg-fg px-1.5 text-center text-[10.5px] font-semibold leading-[18px] text-bg">{c.unread > 99 ? "99+" : c.unread}</span>}
                                    </div>
                                </div>
                            </button>
                        </li>
                    );
                })}
            </ul>
            <div ref={sentinel} className="flex justify-center p-3">
                {loadingMore ? <Spinner className="h-4 w-4 text-muted" /> : hasMore ? <button type="button" onClick={onMore} className="text-[12.5px] text-muted hover:text-fg">Carregar mais</button> : null}
            </div>
        </div>
    );
}
