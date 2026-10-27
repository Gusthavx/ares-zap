import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api, qk } from "@/api";
import { Button, IconButton } from "@/ui/button";
import { Field, Input } from "@/ui/form";
import { Empty, PageLoader, SecretBox } from "@/ui/misc";
import { confirm, Dialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { fmtDateTime } from "@/lib/format";

export function ApiKeysTab({ sid }: { sid: string }) {
    const client = useQueryClient();
    const keys = useQuery({ queryKey: qk.apiKeys, queryFn: api.apiKeys.list });
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [shown, setShown] = useState<string | null>(null);

    const create = useMutation({
        mutationFn: () => api.apiKeys.create(name.trim()),
        onSuccess: k => { client.invalidateQueries({ queryKey: qk.apiKeys }); setCreating(false); setName(""); setShown(k.key); },
        onError: e => toast.error(e),
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.apiKeys.remove(id),
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.apiKeys }); toast.success("Chave apagada"); },
        onError: e => toast.error(e),
    });

    if (keys.isPending) return <PageLoader />;
    if (keys.isError) return <p className="text-[13px] text-bad">{keys.error.message}</p>;

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-xl text-[13px] text-muted">
                    Para integrações: mande o header <code className="font-mono text-[12px]">x-api-key</code>. Ex.: <code className="font-mono text-[12px]">POST /api/v1/sessions/{sid.slice(0, 8)}…/messages</code>
                </p>
                <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setCreating(true)}>Nova chave</Button>
            </div>
            {!keys.data.length ? <Empty title="Nenhuma chave de API">Crie uma chave para enviar mensagens ou disparar fluxos a partir de outro sistema.</Empty> : (
                <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full text-left text-[13px]">
                        <thead className="border-b border-line text-[12px] text-muted">
                            <tr><th className="px-4 py-2 font-normal">Nome</th><th className="px-4 py-2 font-normal">Prefixo</th><th className="px-4 py-2 font-normal">Último uso</th><th className="px-4 py-2 font-normal">Criada</th><th /></tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                            {keys.data.map(k => (
                                <tr key={k.id}>
                                    <td className="px-4 py-2.5 font-medium">{k.name}</td>
                                    <td className="px-4 py-2.5 font-mono text-[12px] text-muted">{k.prefix}…</td>
                                    <td className="px-4 py-2.5 text-muted">{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : "nunca"}</td>
                                    <td className="px-4 py-2.5 text-muted">{fmtDateTime(k.createdAt)}</td>
                                    <td className="px-2 text-right">
                                        <IconButton title="Apagar chave" onClick={async () => {
                                            if (await confirm({ title: `Apagar a chave “${k.name}”?`, body: "Integrações que usam esta chave param de funcionar na hora.", confirm: "Apagar", danger: true })) remove.mutate(k.id);
                                        }}><Trash2 className="h-3.5 w-3.5" /></IconButton>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <Dialog open={creating} onClose={() => setCreating(false)} title="Nova chave de API" size="sm"
                footer={<><Button onClick={() => setCreating(false)}>Cancelar</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Criar</Button></>}>
                <Field label="Nome" hint="Onde ela vai ser usada. Ex.: Loja, CRM.">
                    <Input autoFocus value={name} maxLength={60} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && create.mutate()} />
                </Field>
            </Dialog>
            <Dialog open={!!shown} onClose={() => setShown(null)} title="Sua chave de API" footer={<Button variant="primary" onClick={() => setShown(null)}>Já guardei</Button>}>
                {shown && <SecretBox value={shown} hint="Copie agora: a chave completa não aparece de novo." />}
            </Dialog>
        </div>
    );
}
