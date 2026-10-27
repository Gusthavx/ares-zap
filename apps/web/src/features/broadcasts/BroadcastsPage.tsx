import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, qk } from "@/api";
import { useNow, useSessionId } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/format";
import { Button } from "@/ui/button";
import { Empty, Page, PageHeader, PageLoader, Status } from "@/ui/misc";
import { BroadcastProgress, bStatus, messagePreview } from "./common";

export function BroadcastsPage() {
    const sid = useSessionId();
    useNow(30_000); // atualiza "termina em…"
    const list = useQuery({ queryKey: qk.broadcasts(sid), queryFn: () => api.broadcasts.list(sid) });

    return (
        <Page>
            <PageHeader title="Transmissões" description="Envio em massa com intervalo aleatório, teto diário e janela de horário do número."
                actions={<Link to={`/s/${sid}/broadcasts/new`}><Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />}>Nova transmissão</Button></Link>} />
            {list.isPending ? <PageLoader /> : list.isError ? <p className="text-[13px] text-bad">{list.error.message}</p> : !list.data.length ? (
                <Empty title="Nenhuma transmissão" action={<Link to={`/s/${sid}/broadcasts/new`}><Button variant="primary">Criar transmissão</Button></Link>}>
                    Cole uma lista de números (ou um CSV com nome e outras colunas) ou escolha etiquetas de contatos.
                </Empty>
            ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                    {list.data.map(b => {
                        const st = bStatus(b.status);
                        return (
                            <li key={b.id}>
                                <Link to={`/s/${sid}/broadcasts/${b.id}`} className="block space-y-2 px-4 py-3.5 hover:bg-subtle/50">
                                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                        <p className="min-w-0 flex-1 truncate font-medium">{b.name}</p>
                                        <Status tone={st.tone}>{st.label}</Status>
                                    </div>
                                    <p className="truncate text-[12.5px] text-muted">{messagePreview(b)}</p>
                                    <BroadcastProgress b={b} />
                                    <p className="text-[11.5px] text-faint">
                                        {b.status === "scheduled" && b.scheduledAt ? `Começa em ${fmtDateTime(b.scheduledAt)}` : `Criada em ${fmtDateTime(b.createdAt)}`}
                                        {b.finishedAt ? ` · terminou em ${fmtDateTime(b.finishedAt)}` : ""}
                                    </p>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
        </Page>
    );
}
