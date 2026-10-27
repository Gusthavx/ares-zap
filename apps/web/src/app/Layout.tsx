import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, LogOut, Menu, MessagesSquare, Plus, Send, Settings, Smartphone, Users, Workflow, X } from "lucide-react";
import { formatPhone } from "@areszap/core";
import { api, qk, type Session } from "@/api";
import { useRealtime, useWsState } from "@/ws";
import { save } from "@/lib/storage";
import { useSessionId } from "@/lib/hooks";
import { useSession, useSessions } from "@/features/sessions/queries";
import { sessionStatus } from "@/features/sessions/status";
import { Dot, PageLoader } from "@/ui/misc";
import { Popover } from "@/ui/overlay";
import { IconButton } from "@/ui/button";
import { Logo } from "./Login";
import { ThemeToggle } from "./ThemeToggle";
import { useMe } from "./auth";

const NAV = [
    { to: "inbox", label: "Conversas", icon: MessagesSquare },
    { to: "flows", label: "Fluxos", icon: Workflow },
    { to: "broadcasts", label: "Transmissões", icon: Send },
    { to: "contacts", label: "Contatos", icon: Users },
    { to: "settings", label: "Configurações", icon: Settings },
];

export function Layout() {
    const sid = useSessionId();
    const me = useMe();
    const sessions = useSessions();
    const loc = useLocation();
    const [drawer, setDrawer] = useState(false);
    useRealtime(!!me.data && import.meta.env.VITE_MOCK !== "1");

    useEffect(() => { if (sid) save("az-session", sid); }, [sid]);
    useEffect(() => { setDrawer(false); }, [loc.pathname]);

    if (sessions.isPending) return <div className="h-full"><PageLoader /></div>;
    const exists = sessions.data?.some(s => s.id === sid);

    return (
        <div className="flex h-full min-h-0">
            {/* barra lateral fixa (desktop) */}
            <aside className="hidden w-[232px] shrink-0 border-r border-line lg:block">
                <Sidebar />
            </aside>

            {/* gaveta (celular) */}
            {drawer && (
                <div className="fixed inset-0 z-40 lg:hidden">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
                    <aside className="absolute inset-y-0 left-0 w-[260px] animate-in border-r border-line bg-bg">
                        <Sidebar onClose={() => setDrawer(false)} />
                    </aside>
                </div>
            )}

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 lg:hidden">
                    <IconButton title="Abrir menu" onClick={() => setDrawer(true)}><Menu className="h-4 w-4" /></IconButton>
                    <Logo />
                </header>
                {exists ? <ConnectionStrip sid={sid} /> : null}
                <main className="min-h-0 flex-1 overflow-y-auto">
                    {exists ? <Outlet /> : (
                        <div className="p-8 text-center text-[13px] text-muted">
                            Este número não existe mais. <Link className="underline" to="/">Voltar ao início</Link>
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}

function Sidebar({ onClose }: { onClose?: () => void }) {
    const sid = useSessionId();
    const me = useMe();
    const ws = useWsState();
    const client = useQueryClient();
    const navigate = useNavigate();

    const logout = async () => {
        try { await api.auth.logout(); } catch { /* segue */ }
        client.clear();
        client.setQueryData(qk.me, null);
        navigate("/login");
    };

    return (
        <div className="flex h-full flex-col">
            <div className="flex h-12 items-center justify-between px-4">
                <Logo />
                {onClose && <IconButton title="Fechar menu" onClick={onClose}><X className="h-4 w-4" /></IconButton>}
            </div>
            <div className="px-3 pb-3">
                <SessionSwitcher />
            </div>
            <nav className="flex-1 space-y-px px-3">
                {NAV.map(n => (
                    <NavLink
                        key={n.to}
                        to={`/s/${sid}/${n.to}`}
                        className={({ isActive }) => `flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors ${isActive ? "bg-subtle font-medium text-fg" : "text-muted hover:bg-subtle hover:text-fg"}`}
                    >
                        <n.icon className="h-4 w-4" strokeWidth={1.75} />{n.label}
                    </NavLink>
                ))}
            </nav>
            <div className="space-y-2 border-t border-line px-3 py-3">
                {ws !== "open" && import.meta.env.VITE_MOCK !== "1" && (
                    <p className="flex items-center gap-1.5 px-1 text-[12px] text-warn" title="As telas continuam funcionando; só não atualizam sozinhas.">
                        <Dot tone="warn" />{ws === "connecting" ? "Conectando ao tempo real…" : "Tempo real desconectado"}
                    </p>
                )}
                <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1 px-1">
                        <p className="truncate text-[13px] font-medium">{me.data?.name || me.data?.email}</p>
                        <p className="truncate text-[11.5px] text-muted">{me.data?.role === "admin" ? "Administrador" : "Membro"}</p>
                    </div>
                    <ThemeToggle />
                    <IconButton title="Sair" onClick={logout}><LogOut className="h-4 w-4" /></IconButton>
                </div>
            </div>
        </div>
    );
}

function SessionLine({ s }: { s: Session }) {
    const st = sessionStatus(s.status);
    return (
        <span className="flex min-w-0 items-center gap-2">
            <Dot tone={st.tone} />
            <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{s.name}</span>
                <span className="block truncate text-[11.5px] text-muted">{s.phone ? formatPhone(s.phone) : st.label}</span>
            </span>
        </span>
    );
}

function SessionSwitcher() {
    const sid = useSessionId();
    const { data: current } = useSession(sid);
    const sessions = useSessions();
    const navigate = useNavigate();
    const loc = useLocation();

    // ao trocar de número, mantém a seção (Conversas, Fluxos…) mas sai de itens específicos
    const switchTo = (id: string) => {
        const section = loc.pathname.split("/")[3] || "inbox";
        const keep = section === "settings" ? loc.pathname.split("/").slice(3, 5).join("/") : section;
        navigate(`/s/${id}/${keep}`);
    };

    return (
        <Popover width="w-full" className="block w-full" trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className="flex w-full items-center gap-2 rounded-md border border-line px-2.5 py-2 text-left hover:bg-subtle">
                <span className="min-w-0 flex-1">{current ? <SessionLine s={current} /> : <span className="text-[13px] text-muted">Escolha um número</span>}</span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted" />
            </button>
        )}>
            {close => (
                <div className="max-h-80 overflow-y-auto">
                    {sessions.data?.map(s => (
                        <button key={s.id} type="button" onClick={() => { close(); if (s.id !== sid) switchTo(s.id); }}
                            className={`flex w-full rounded px-2 py-1.5 text-left hover:bg-subtle ${s.id === sid ? "bg-subtle" : ""}`}>
                            <SessionLine s={s} />
                        </button>
                    ))}
                    <div className="mt-1 border-t border-line pt-1">
                        <button type="button" onClick={() => { close(); navigate(`/s/${sid}/settings/numbers`); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] text-muted hover:bg-subtle hover:text-fg">
                            <Smartphone className="h-3.5 w-3.5" />Gerenciar números
                        </button>
                        <button type="button" onClick={() => { close(); navigate(`/s/${sid}/settings/numbers?new=1`); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[13px] text-muted hover:bg-subtle hover:text-fg">
                            <Plus className="h-3.5 w-3.5" />Adicionar número
                        </button>
                    </div>
                </div>
            )}
        </Popover>
    );
}

/** Faixa fina no topo quando o número não está conectado. */
function ConnectionStrip({ sid }: { sid: string }) {
    const { data: s } = useSession(sid);
    const loc = useLocation();
    if (!s || s.status === "connected" || loc.pathname.endsWith("/settings/number")) return null;
    const st = sessionStatus(s.status);
    return (
        <div className={`flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5 text-[12.5px] ${st.tone === "bad" ? "text-bad" : "text-warn"}`}>
            <Dot tone={st.tone} />
            <span className="min-w-0 flex-1 truncate">{s.name}: {st.label}{s.lastError && s.status === "error" ? ` (${s.lastError})` : ""}</span>
            <Link to={`/s/${sid}/settings/number`} className="shrink-0 font-medium underline underline-offset-2">{s.status === "qr" ? "Ler QR" : "Conectar"}</Link>
        </div>
    );
}
