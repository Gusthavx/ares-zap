import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Plus } from "lucide-react";
import { formatPhone } from "@areszap/core";
import { Button } from "@/ui/button";
import { Empty, PageLoader, Status, Tag } from "@/ui/misc";
import { fmtDateTime } from "@/lib/format";
import { useSessions } from "./queries";
import { sessionStatus } from "./status";
import { CreateSessionDialog } from "./CreateSessionDialog";

/** Lista de todos os números, com criação. */
export function SessionsList({ currentId }: { currentId?: string }) {
    const sessions = useSessions();
    const [params, setParams] = useSearchParams();
    const [open, setOpen] = useState(params.get("new") === "1");
    const close = () => { setOpen(false); if (params.get("new")) { params.delete("new"); setParams(params, { replace: true }); } };

    if (sessions.isPending) return <PageLoader />;
    const list = sessions.data ?? [];

    return (
        <div>
            <div className="mb-4 flex items-center justify-between gap-2">
                <p className="text-[13px] text-muted">{list.length === 1 ? "1 número" : `${list.length} números`}</p>
                <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>Adicionar número</Button>
            </div>
            {list.length === 0 ? (
                <Empty title="Nenhum número ainda" action={<Button variant="primary" onClick={() => setOpen(true)}>Adicionar número</Button>}>
                    Conecte um WhatsApp pelo QR code ou pela API oficial da Meta.
                </Empty>
            ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                    {list.map(s => {
                        const st = sessionStatus(s.status);
                        return (
                            <li key={s.id}>
                                <Link to={`/s/${s.id}/settings/number`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-subtle">
                                    <div className="min-w-0 flex-1">
                                        <p className="flex items-center gap-2 font-medium">
                                            {s.name}
                                            {s.id === currentId && <Tag>atual</Tag>}
                                            <Tag>{s.provider === "cloud" ? "API oficial" : "WhatsApp Web"}</Tag>
                                        </p>
                                        <p className="text-[12.5px] text-muted">{s.phone ? formatPhone(s.phone) : "Sem número vinculado"} · criado em {fmtDateTime(s.createdAt)}</p>
                                    </div>
                                    <Status tone={st.tone}>{st.label}</Status>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
            <CreateSessionDialog open={open} onClose={close} />
        </div>
    );
}
