import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useMe } from "./auth";
import { PageLoader } from "@/ui/misc";
import { load } from "@/lib/storage";
import { useSessions } from "@/features/sessions/queries";
import { LoginPage } from "./Login";
import { Layout } from "./Layout";
import { InboxPage } from "@/features/inbox/InboxPage";
import { FlowsPage } from "@/features/flows/FlowsPage";
import { BroadcastsPage } from "@/features/broadcasts/BroadcastsPage";
import { BroadcastNew } from "@/features/broadcasts/BroadcastNew";
import { BroadcastDetail } from "@/features/broadcasts/BroadcastDetail";
import { ContactsPage } from "@/features/contacts/ContactsPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SessionsOnboarding } from "@/features/sessions/SessionsOnboarding";

// O editor carrega o React Flow: fica num pedaço separado.
const FlowEditorPage = lazy(() => import("@/features/flows/editor/FlowEditorPage"));

function RequireAuth({ children }: { children: ReactNode }) {
    const me = useMe();
    const loc = useLocation();
    if (me.isPending) return <div className="h-full"><PageLoader /></div>;
    if (me.isError) return <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-bad">Não foi possível falar com o servidor. {me.error.message}</div>;
    if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return <>{children}</>;
}

/** "/" → último número usado, ou o primeiro, ou a tela de criar número. */
function Home() {
    const sessions = useSessions();
    if (sessions.isPending) return <PageLoader />;
    const list = sessions.data ?? [];
    if (!list.length) return <Navigate to="/sessions" replace />;
    const last = load("az-session");
    const pick = list.find(s => s.id === last) ?? list[0];
    return <Navigate to={`/s/${pick.id}/inbox`} replace />;
}

export function App() {
    return (
        <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
            <Route path="/sessions" element={<RequireAuth><SessionsOnboarding /></RequireAuth>} />
            <Route path="/s/:sessionId" element={<RequireAuth><Layout /></RequireAuth>}>
                <Route index element={<Navigate to="inbox" replace />} />
                <Route path="inbox" element={<InboxPage />} />
                <Route path="inbox/:chatId" element={<InboxPage />} />
                <Route path="flows" element={<FlowsPage />} />
                <Route path="flows/:flowId" element={<Suspense fallback={<PageLoader />}><FlowEditorPage /></Suspense>} />
                <Route path="broadcasts" element={<BroadcastsPage />} />
                <Route path="broadcasts/new" element={<BroadcastNew />} />
                <Route path="broadcasts/:broadcastId" element={<BroadcastDetail />} />
                <Route path="contacts" element={<ContactsPage />} />
                <Route path="settings" element={<Navigate to="number" replace />} />
                <Route path="settings/:tab" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
