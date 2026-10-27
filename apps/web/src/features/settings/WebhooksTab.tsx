import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { WEBHOOK_EVENTS, type WebhookEvent } from "@areszap/core";
import { api, qk, type Webhook } from "@/api";
import { useSessions } from "@/features/sessions/queries";
import { Button, IconButton } from "@/ui/button";
import { Checkbox, Field, Input, Segmented, Switch } from "@/ui/form";
import { Empty, PageLoader, SecretBox, Status } from "@/ui/misc";
import { confirm, Dialog, MenuItem, Popover } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { fmtDateTime } from "@/lib/format";

const EVENT_LABEL: Record<WebhookEvent, string> = {
    "message.received": "Mensagem recebida",
    "message.sent": "Mensagem enviada",
    "message.status": "Status de mensagem (entregue, lida, falha)",
    "session.status": "Conexão do número mudou",
    "flow.completed": "Fluxo concluído",
    "contact.optout": "Contato pediu para sair",
    "broadcast.finished": "Transmissão terminou",
};

export function WebhooksTab({ sid }: { sid: string }) {
    const client = useQueryClient();
    const hooks = useQuery({ queryKey: qk.webhooks, queryFn: api.webhooks.list });
    const sessions = useSessions();
    const [editing, setEditing] = useState<Webhook | "new" | null>(null);
    const [secret, setSecret] = useState<string | null>(null);

    const toggle = useMutation({
        mutationFn: (h: Webhook) => api.webhooks.update(h.id, { active: !h.active }),
        onSuccess: () => client.invalidateQueries({ queryKey: qk.webhooks }),
        onError: e => toast.error(e),
    });
    const test = useMutation({
        mutationFn: (id: string) => api.webhooks.test(id),
        onSuccess: () => { toast.success("Teste enviado. Confira o último status em instantes."); setTimeout(() => client.invalidateQueries({ queryKey: qk.webhooks }), 2500); },
        onError: e => toast.error(e),
    });
    const remove = useMutation({
        mutationFn: (id: string) => api.webhooks.remove(id),
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.webhooks }); toast.success("Webhook apagado"); },
        onError: e => toast.error(e),
    });

    if (hooks.isPending) return <PageLoader />;
    if (hooks.isError) return <p className="text-[13px] text-bad">{hooks.error.message}</p>;
    const sessionName = (id: string | null) => (id ? sessions.data?.find(s => s.id === id)?.name ?? "número apagado" : "Todos os números");

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-xl text-[13px] text-muted">O Ares Zap faz um POST na URL a cada evento, assinado com HMAC no header <code className="font-mono text-[12px]">x-areszap-signature</code>. Até 6 tentativas.</p>
                <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>Novo webhook</Button>
            </div>
            {!hooks.data.length ? <Empty title="Nenhum webhook">Use para avisar outro sistema quando chega mensagem, quando um fluxo termina etc.</Empty> : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                    {hooks.data.map(h => {
                        const ok = h.lastStatus !== null && h.lastStatus >= 200 && h.lastStatus < 300;
                        return (
                            <li key={h.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate font-mono text-[12.5px]">{h.url}</p>
                                    <p className="mt-0.5 text-[12px] text-muted">{sessionName(h.sessionId)} · {h.events.length} evento{h.events.length === 1 ? "" : "s"}</p>
                                    {h.lastAt && (
                                        <p className="mt-0.5 text-[12px]">
                                            <Status tone={ok ? "ok" : "bad"}>{h.lastStatus ? `HTTP ${h.lastStatus}` : "Falhou"} em {fmtDateTime(h.lastAt)}</Status>
                                            {!ok && h.lastError && h.lastError !== `HTTP ${h.lastStatus}` && <span className="ml-2 text-bad">{h.lastError}</span>}
                                        </p>
                                    )}
                                </div>
                                <Switch checked={h.active} onChange={() => toggle.mutate(h)} />
                                <Popover align="right" width="w-44" trigger={({ toggle: t }) => <IconButton title="Ações" onClick={t}><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                                    {close => <>
                                        <MenuItem onClick={() => { close(); setEditing(h); }}>Editar</MenuItem>
                                        <MenuItem onClick={() => { close(); test.mutate(h.id); }}>Enviar teste</MenuItem>
                                        <MenuItem danger onClick={async () => { close(); if (await confirm({ title: "Apagar webhook?", confirm: "Apagar", danger: true })) remove.mutate(h.id); }}>Apagar</MenuItem>
                                    </>}
                                </Popover>
                            </li>
                        );
                    })}
                </ul>
            )}
            {editing && <WebhookDialog sid={sid} hook={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSecret={setSecret} />}
            <Dialog open={!!secret} onClose={() => setSecret(null)} title="Segredo do webhook" footer={<Button variant="primary" onClick={() => setSecret(null)}>Já guardei</Button>}>
                {secret && <SecretBox value={secret} hint="Guarde agora: este segredo não aparece de novo. Use-o para conferir a assinatura HMAC-SHA256 do corpo." />}
            </Dialog>
        </div>
    );
}

function WebhookDialog({ sid, hook, onClose, onSecret }: { sid: string; hook: Webhook | null; onClose: () => void; onSecret: (s: string) => void }) {
    const client = useQueryClient();
    const [url, setUrl] = useState(hook?.url ?? "https://");
    const [events, setEvents] = useState<WebhookEvent[]>(hook?.events ?? ["message.received"]);
    const [scope, setScope] = useState<"this" | "all">(hook ? (hook.sessionId ? "this" : "all") : "this");

    const m = useMutation({
        mutationFn: async () => {
            if (hook) return api.webhooks.update(hook.id, { url: url.trim(), events });
            const created = await api.webhooks.create({ url: url.trim(), events, sessionId: scope === "this" ? sid : null });
            onSecret(created.secret);
            return created;
        },
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.webhooks }); onClose(); },
        onError: e => toast.error(e),
    });
    const validUrl = /^https?:\/\/[^\s]+\.[^\s]+/.test(url.trim());

    return (
        <Dialog open onClose={onClose} title={hook ? "Editar webhook" : "Novo webhook"}
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} disabled={!validUrl || !events.length} onClick={() => m.mutate()}>{hook ? "Salvar" : "Criar"}</Button></>}>
            <div className="space-y-4">
                <Field label="URL" hint="Precisa ser pública. Endereços de rede interna são recusados.">
                    <Input autoFocus type="url" value={url} onChange={e => setUrl(e.target.value)} className="font-mono text-[12.5px]" />
                </Field>
                {!hook && (
                    <Field label="Vale para">
                        <Segmented value={scope} onChange={setScope} options={[{ value: "this", label: "Este número" }, { value: "all", label: "Todos os números" }]} />
                    </Field>
                )}
                <Field label="Eventos">
                    <div className="grid gap-1.5">
                        {WEBHOOK_EVENTS.map(ev => (
                            <Checkbox key={ev} checked={events.includes(ev)} onChange={on => setEvents(on ? [...events, ev] : events.filter(x => x !== ev))}
                                label={<span>{EVENT_LABEL[ev]} <code className="ml-1 font-mono text-[11px] text-muted">{ev}</code></span>} />
                        ))}
                    </div>
                </Field>
            </div>
        </Dialog>
    );
}
