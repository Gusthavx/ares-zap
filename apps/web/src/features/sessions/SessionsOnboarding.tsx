import { Navigate } from "react-router";
import { Logo } from "@/app/Login";
import { ThemeToggle } from "@/app/ThemeToggle";
import { PageLoader } from "@/ui/misc";
import { SessionsList } from "./SessionsList";
import { useSessions } from "./queries";

/** Primeira tela quando ainda não existe número. */
export function SessionsOnboarding() {
    const sessions = useSessions();
    if (sessions.isPending) return <PageLoader />;
    if (sessions.data?.length) return <Navigate to={`/s/${sessions.data[0].id}/settings/numbers`} replace />;
    return (
        <div className="mx-auto max-w-2xl px-4 py-10">
            <div className="mb-10 flex items-center justify-between"><Logo /><ThemeToggle /></div>
            <h1 className="text-[22px] font-semibold tracking-tight">Conecte o primeiro número</h1>
            <p className="mb-8 mt-1 text-[13px] text-muted">Cada número tem as próprias conversas, fluxos, transmissões e contatos.</p>
            <SessionsList />
        </div>
    );
}
