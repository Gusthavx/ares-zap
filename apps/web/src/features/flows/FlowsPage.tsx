import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus, Upload } from "lucide-react";
import type { FlowTrigger } from "@areszap/core";
import { api, qk, type FlowSummary } from "@/api";
import { downloadJson, slug, useSessionId } from "@/lib/hooks";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { Button, IconButton } from "@/ui/button";
import { Field, Input } from "@/ui/form";
import { Empty, Page, PageHeader, PageLoader, Status } from "@/ui/misc";
import { confirm, Dialog, MenuItem, Popover } from "@/ui/overlay";
import { toast } from "@/ui/toast";

export const FLOW_STATUS = {
    active: { label: "Ativo", tone: "ok" as const },
    inactive: { label: "Desativado", tone: "warn" as const },
    draft: { label: "Rascunho", tone: "neutral" as const },
};

export function triggerSummary(ts: FlowTrigger[]): string {
    if (!ts.length) return "Sem gatilho";
    return ts.map(t => t.type === "firstMessage" ? "Primeira mensagem" : t.type === "anyMessage" ? "Qualquer mensagem" : `“${t.value ?? ""}”`).join(", ");
}

export function FlowsPage() {
    const sid = useSessionId();
    const client = useQueryClient();
    const navigate = useNavigate();
    const flows = useQuery({ queryKey: qk.flows(sid), queryFn: () => api.flows.list(sid) });
    const [creating, setCreating] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);

    const refresh = () => client.invalidateQueries({ queryKey: qk.flows(sid) });
    const duplicate = useMutation({ mutationFn: api.flows.duplicate, onSuccess: f => { refresh(); toast.success(`Criado “${f.name}”`); }, onError: e => toast.error(e) });
    const remove = useMutation({ mutationFn: api.flows.remove, onSuccess: () => { refresh(); toast.success("Fluxo apagado"); }, onError: e => toast.error(e) });
    const importFlow = useMutation({
        mutationFn: async (file: File) => {
            let json: unknown;
            try { json = JSON.parse(await file.text()); } catch { throw new Error("O arquivo não é um JSON válido."); }
            return api.flows.import(sid, json);
        },
        onSuccess: f => {
            refresh();
            const w = f.importWarnings ?? [];
            if (w.length) toast.info(`Fluxo importado com ${w.length} aviso${w.length > 1 ? "s" : ""}: ${w.slice(0, 4).join(" · ")}${w.length > 4 ? " …" : ""}`, { duration: 20000 });
            else toast.success("Fluxo importado");
            navigate(`/s/${sid}/flows/${f.id}`);
        },
        onError: e => toast.error(e),
    });
    const exportFlow = async (f: FlowSummary) => {
        try { downloadJson(`${slug(f.name) || "fluxo"}.json`, await api.flows.export(f.id)); } catch (e) { toast.error(e); }
    };

    return (
        <Page>
            <PageHeader title="Fluxos" description="Conversas automáticas disparadas por palavra-chave, primeira mensagem ou qualquer mensagem."
                actions={<>
                    <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importFlow.mutate(f); e.target.value = ""; }} />
                    <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} loading={importFlow.isPending} onClick={() => fileInput.current?.click()}>Importar</Button>
                    <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>Novo fluxo</Button>
                </>} />

            {flows.isPending ? <PageLoader /> : flows.isError ? <p className="text-[13px] text-bad">{flows.error.message}</p> : !flows.data.length ? (
                <Empty title="Nenhum fluxo ainda" action={<Button variant="primary" onClick={() => setCreating(true)}>Criar o primeiro fluxo</Button>}>
                    Monte a conversa com blocos de mensagem, menu, condição e espera. Também dá para importar um JSON exportado do MarcFlow.
                </Empty>
            ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                    {flows.data.map(f => {
                        const st = FLOW_STATUS[f.status] ?? FLOW_STATUS.draft;
                        return (
                            <li key={f.id} className="flex items-center gap-3 px-4 py-3 hover:bg-subtle/50">
                                <Link to={`/s/${sid}/flows/${f.id}`} className="min-w-0 flex-1">
                                    <p className="truncate font-medium">{f.name}</p>
                                    <p className="mt-0.5 truncate text-[12.5px] text-muted">
                                        {triggerSummary(f.triggers)}
                                        {f.publishedVersion ? ` · v${f.publishedVersion}` : " · nunca publicado"}
                                        {` · editado ${fmtDateTime(f.updatedAt)}`}
                                    </p>
                                </Link>
                                <div className="hidden flex-col items-end gap-0.5 sm:flex">
                                    <Status tone={st.tone}>{st.label}</Status>
                                    {f.hasUnpublishedChanges && f.publishedVersion ? <span className="text-[11.5px] text-warn">Alterações não publicadas</span> : null}
                                </div>
                                <span className="tabular hidden w-24 text-right text-[12.5px] text-muted md:block" title="Conversas em andamento neste fluxo">{fmtNum(f.runsActive)} em curso</span>
                                <Popover align="right" width="w-44" trigger={({ toggle }) => <IconButton title="Ações" onClick={toggle}><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                                    {close => <>
                                        <MenuItem onClick={() => { close(); navigate(`/s/${sid}/flows/${f.id}`); }}>Abrir editor</MenuItem>
                                        <MenuItem onClick={() => { close(); duplicate.mutate(f.id); }}>Duplicar</MenuItem>
                                        <MenuItem onClick={() => { close(); exportFlow(f); }}>Exportar JSON</MenuItem>
                                        <MenuItem danger onClick={async () => {
                                            close();
                                            if (await confirm({ title: `Apagar “${f.name}”?`, body: f.runsActive ? `${f.runsActive} conversa(s) em andamento serão encerradas.` : "O fluxo e o histórico de execuções serão apagados.", confirm: "Apagar", danger: true })) remove.mutate(f.id);
                                        }}>Apagar</MenuItem>
                                    </>}
                                </Popover>
                            </li>
                        );
                    })}
                </ul>
            )}
            {creating && <NewFlowDialog sid={sid} onClose={() => setCreating(false)} />}
        </Page>
    );
}

function NewFlowDialog({ sid, onClose }: { sid: string; onClose: () => void }) {
    const client = useQueryClient();
    const navigate = useNavigate();
    const [name, setName] = useState("");
    const m = useMutation({
        mutationFn: () => api.flows.create(sid, { name: name.trim() }),
        onSuccess: f => { client.invalidateQueries({ queryKey: qk.flows(sid) }); navigate(`/s/${sid}/flows/${f.id}`); },
        onError: e => toast.error(e),
    });
    return (
        <Dialog open onClose={onClose} title="Novo fluxo" size="sm"
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>Criar e abrir</Button></>}>
            <Field label="Nome" hint="Ex.: Boas-vindas, Menu principal, Pós-compra.">
                <Input autoFocus value={name} maxLength={80} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && m.mutate()} />
            </Field>
        </Dialog>
    );
}
