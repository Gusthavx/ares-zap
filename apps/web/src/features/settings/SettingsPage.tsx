import { Navigate, useNavigate, useParams } from "react-router";
import { useMe } from "@/app/auth";
import { useSessionId } from "@/lib/hooks";
import { Page, PageHeader, Tabs } from "@/ui/misc";
import { SessionPanel } from "@/features/sessions/SessionPanel";
import { SessionsList } from "@/features/sessions/SessionsList";
import { WebhooksTab } from "./WebhooksTab";
import { ApiKeysTab } from "./ApiKeysTab";
import { UsersTab } from "./UsersTab";
import { AccountTab } from "./AccountTab";

type Tab = "number" | "numbers" | "webhooks" | "api-keys" | "users" | "account";

export function SettingsPage() {
    const sid = useSessionId();
    const { tab = "number" } = useParams();
    const navigate = useNavigate();
    const me = useMe();
    const admin = me.data?.role === "admin";

    const items: { value: Tab; label: string }[] = [
        { value: "number", label: "Este número" },
        { value: "numbers", label: "Números" },
        { value: "webhooks", label: "Webhooks" },
        { value: "api-keys", label: "Chaves de API" },
        ...(admin ? [{ value: "users" as Tab, label: "Usuários" }] : []),
        { value: "account", label: "Minha conta" },
    ];
    if (!items.some(i => i.value === tab)) return <Navigate to={`/s/${sid}/settings/number`} replace />;

    return (
        <Page>
            <PageHeader title="Configurações" />
            <Tabs value={tab as Tab} onChange={t => navigate(`/s/${sid}/settings/${t}`)} items={items} />
            {tab === "number" && <SessionPanel sid={sid} />}
            {tab === "numbers" && <SessionsList currentId={sid} />}
            {tab === "webhooks" && <WebhooksTab sid={sid} />}
            {tab === "api-keys" && <ApiKeysTab sid={sid} />}
            {tab === "users" && admin && <UsersTab />}
            {tab === "account" && <AccountTab />}
        </Page>
    );
}
