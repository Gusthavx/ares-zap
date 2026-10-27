import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pause, Play, X } from "lucide-react";
import { formatPhone, phoneFromJid } from "@areszap/core";
import { api, qk, type RecipientStatus } from "@/api";
import { useNow, useSessionId } from "@/lib/hooks";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { Button } from "@/ui/button";
import { Page, PageLoader, Section, Status, Tabs, Tag, type Tone } from "@/ui/misc";
import { confirm } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { BroadcastProgress, bStatus, messagePreview } from "./common";

const R_STATUS: Record<RecipientStatus | "cancelled", { label: string; tone: Tone }> = {
    pending: { label: "Aguardando", tone: "neutral" }, queued: { label: "Na fila", tone: "neutral" }, sent: { label: "Enviada", tone: "ok" },
    failed: { label: "Falhou", tone: "bad" }, skipped: { label: "Pulada", tone: "neutral" }, cancelled: { label: "Cancelada", tone: "neutral" },
};
const PAGE = 100;

export function BroadcastDetail() {
    const sid = useSessionId();
    const { broadcastId = "" } = useParams();
    const client = useQueryClient();
    useNow(30_000);
    const b = useQuery({ queryKey: qk.broadcast(broadcastId), queryFn: () => api.broadcasts.get(broadcastId) });
    const [filter, setFilter] = useState<"" | RecipientStatus>("");
    const [offset, setOffset] = useState(0);
    const rec = useQuery({
        queryKey: [...qk.recipients(broadcastId), filter, offset],
        queryFn: () => api.broadcasts.recipients(broadcastId, { status: filter || undefined, limit: PAGE, offset }),
        placeholderData: prev => prev,
    });

    const act = useMutation({
        mutationFn: (a: "pause" | "resume" | "cancel") => api.broadcasts.action(broadcastId, a),
        onSuccess: (_, a) => {
            toast.success(a === "pause" ? "Transmissão pausada" : a === "resume" ? "Transmissão retomada" : "Transmissão cancelada");
            client.invalidateQueries({ queryKey: qk.broadcast(broadcastId) });
            client.invalidateQueries({ queryKey: qk.broadcasts(sid) });
        },
        onError: e => toast.error(e),
    });

    if (b.isPending) return <PageLoader />;
    if (b.isError) return <Page><p className="text-[13px] text-bad">{b.error.message}</p></Page>;
    const d = b.data;
    const st = bStatus(d.status);
    const open = d.status === "scheduled" || d.status === "running" || d.status === "paused";
    const m = d.message;

    return (
        <Page>
            <Link to={`/s/${sid}/broadcasts`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Transmissões</Link>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-[20px] font-semibold tracking-tight">{d.name}</h1>
                    <div className="mt-1"><Status tone={st.tone}>{st.label}</Status></div>
                </div>
                {open && (
                    <div className="flex gap-2">
                        {d.status === "running" && <Button size="sm" icon={<Pause className="h-3.5 w-3.5" />} loading={act.isPending && act.variables === "pause"} onClick={() => act.mutate("pause")}>Pausar</Button>}
                        {d.status === "paused" && <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={act.isPending && act.variables === "resume"} onClick={() => act.mutate("resume")}>Retomar</Button>}
                        <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={act.isPending && act.variables === "cancel"}
                            onClick={async () => { if (await confirm({ title: "Cancelar a transmissão?", body: "Quem ainda não recebeu não vai receber. Não dá para retomar depois.", confirm: "Cancelar transmissão", danger: true })) act.mutate("cancel"); }}>
                            Cancelar
                        </Button>
                    </div>
                )}
            </div>

            <Section title="Progresso">
                <BroadcastProgress b={d} />
                <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
                    {d.scheduledAt && <><dt className="text-muted">Agendada para</dt><dd>{fmtDateTime(d.scheduledAt)}</dd></>}
                    <dt className="text-muted">Início</dt><dd>{fmtDateTime(d.startedAt)}</dd>
                    {d.finishedAt && <><dt className="text-muted">Fim</dt><dd>{fmtDateTime(d.finishedAt)}</dd></>}
                    {d.status === "running" && d.etaAt && <><dt className="text-muted">Previsão de fim</dt><dd>{fmtDateTime(d.etaAt)}</dd></>}
                    <dt className="text-muted">Intervalo</dt><dd>{d.minGapSec}–{d.maxGapSec} s entre envios</dd>
                    <dt className="text-muted">Quem saiu</dt><dd>{d.skipOptedOut ? "é pulado" : "recebe"}</dd>
                </dl>
            </Section>

            <Section title="Mensagem">
                <div className="max-w-lg rounded-lg border border-line px-3.5 py-2.5 text-[13.5px]">
                    {m.kind === "media" && m.assetId && (
                        m.media === "image" ? <img src={api.assets.fileUrl(m.assetId)} alt="" className="mb-2 max-h-56 rounded" />
                            : <p className="mb-1"><Tag>{m.fileName || m.media}</Tag></p>
                    )}
                    <p className="whitespace-pre-wrap break-words">{messagePreview(d)}</p>
                </div>
            </Section>

            <Section title="Destinatários">
                <Tabs value={filter} onChange={v => { setFilter(v); setOffset(0); }} items={[
                    { value: "", label: `Todos · ${fmtNum(d.total)}` },
                    { value: "sent", label: `Enviadas · ${fmtNum(d.sent)}` },
                    { value: "failed", label: `Falhas · ${fmtNum(d.failed)}` },
                    { value: "skipped", label: `Puladas · ${fmtNum(d.skipped)}` },
                    { value: "pending", label: "Aguardando" },
                ]} />
                {rec.isPending ? <PageLoader /> : rec.isError ? <p className="text-[13px] text-bad">{rec.error.message}</p> : !rec.data.items.length ? (
                    <p className="py-6 text-center text-[13px] text-muted">Ninguém aqui.</p>
                ) : (
                    <>
                        <div className="overflow-x-auto rounded-lg border border-line">
                            <table className="w-full text-left text-[13px]">
                                <thead className="border-b border-line text-[12px] text-muted">
                                    <tr><th className="px-4 py-2 font-normal">Número</th><th className="px-4 py-2 font-normal">Situação</th><th className="px-4 py-2 font-normal">Enviada em</th></tr>
                                </thead>
                                <tbody className="divide-y divide-line">
                                    {rec.data.items.map(r => {
                                        const rs = R_STATUS[r.status as RecipientStatus] ?? { label: r.status, tone: "neutral" as Tone };
                                        return (
                                            <tr key={r.id}>
                                                <td className="tabular whitespace-nowrap px-4 py-2">{formatPhone(phoneFromJid(r.jid))}</td>
                                                <td className="px-4 py-2"><Status tone={rs.tone}>{rs.label}</Status>{r.error && <span className="ml-2 text-[12px] text-bad">{r.error}</span>}</td>
                                                <td className="whitespace-nowrap px-4 py-2 text-muted">{r.sentAt ? fmtDateTime(r.sentAt) : "—"}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-[12.5px] text-muted">
                            <span className="tabular">{fmtNum(offset + 1)}–{fmtNum(Math.min(offset + PAGE, rec.data.total))} de {fmtNum(rec.data.total)}</span>
                            <div className="flex gap-2">
                                <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Anteriores</Button>
                                <Button size="sm" disabled={offset + PAGE >= rec.data.total} onClick={() => setOffset(offset + PAGE)}>Próximos</Button>
                            </div>
                        </div>
                    </>
                )}
            </Section>
        </Page>
    );
}
