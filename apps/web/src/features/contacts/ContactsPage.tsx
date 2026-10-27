import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, X } from "lucide-react";
import { formatPhone } from "@areszap/core";
import { api, qk, type Contact, type Label } from "@/api";
import { useDebounced, useSessionId } from "@/lib/hooks";
import { fmtDateTime, fmtNum, isFuture } from "@/lib/format";
import { useLabels } from "@/features/sessions/queries";
import { Button, IconButton } from "@/ui/button";
import { Checkbox, Field, Input, Select, Switch } from "@/ui/form";
import { Empty, Page, PageHeader, PageLoader, Spinner, Tabs } from "@/ui/misc";
import { confirm, Dialog, Sheet } from "@/ui/overlay";
import { toast } from "@/ui/toast";

type Tab = "contacts" | "labels" | "variables";

export function ContactsPage() {
    const sid = useSessionId();
    const [params, setParams] = useSearchParams();
    const tab = (["contacts", "labels", "variables"].includes(params.get("tab") ?? "") ? params.get("tab") : "contacts") as Tab;
    return (
        <Page>
            <PageHeader title="Contatos" />
            <Tabs value={tab} onChange={t => setParams(t === "contacts" ? {} : { tab: t }, { replace: true })} items={[
                { value: "contacts", label: "Contatos" }, { value: "labels", label: "Etiquetas" }, { value: "variables", label: "Variáveis do robô" },
            ]} />
            {tab === "contacts" && <ContactsTab sid={sid} />}
            {tab === "labels" && <LabelsTab sid={sid} />}
            {tab === "variables" && <VariablesTab sid={sid} />}
        </Page>
    );
}

// ---------- contatos ----------
function LabelDot({ color }: { color: string }) {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />;
}

function ContactsTab({ sid }: { sid: string }) {
    const [search, setSearch] = useState("");
    const [labelId, setLabelId] = useState("");
    const [editing, setEditing] = useState<Contact | null>(null);
    const q = useDebounced(search.trim(), 300);
    const labels = useLabels(sid);
    const list = useInfiniteQuery({
        queryKey: [...qk.contacts(sid), { q, labelId }],
        queryFn: ({ pageParam }) => api.contacts.list(sid, { search: q, labelId: labelId || undefined, cursor: pageParam }),
        initialPageParam: null as string | null,
        getNextPageParam: p => p.nextCursor,
    });
    const items = list.data?.pages.flatMap(p => p.items) ?? [];

    return (
        <div>
            <div className="mb-4 flex flex-wrap gap-2">
                <div className="relative min-w-[200px] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                    <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar nome ou número" className="pl-8" aria-label="Buscar contatos" />
                </div>
                <Select className="w-full sm:w-56" value={labelId} onChange={e => setLabelId(e.target.value)}
                    options={[{ value: "", label: "Todas as etiquetas" }, ...(labels.data ?? []).map(l => ({ value: l.id, label: `${l.name} (${fmtNum(l.count)})` }))]} />
            </div>
            {list.isPending ? <PageLoader /> : list.isError ? <p className="text-[13px] text-bad">{list.error.message}</p> : !items.length ? (
                <Empty title={q || labelId ? "Nenhum contato encontrado" : "Nenhum contato ainda"}>Contatos aparecem aqui quando mandam mensagem ou recebem uma transmissão.</Empty>
            ) : (
                <>
                    <ul className="divide-y divide-line rounded-lg border border-line">
                        {items.map(c => (
                            <li key={c.id}>
                                <button type="button" onClick={() => setEditing(c)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left hover:bg-subtle/50">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-[13.5px] font-medium">{c.name || c.pushName || formatPhone(c.phone)}</p>
                                        <p className="tabular truncate text-[12px] text-muted">{formatPhone(c.phone)}{c.pushName && c.name && c.pushName !== c.name ? ` · ${c.pushName}` : ""}</p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        {c.labels.map(l => <span key={l.id} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-px text-[11.5px] text-muted"><LabelDot color={l.color} />{l.name}</span>)}
                                        {c.optedOutAt && <span className="text-[11.5px] text-warn">saiu das transmissões</span>}
                                        {isFuture(c.pausedUntil) && <span className="text-[11.5px] text-warn">robô pausado</span>}
                                    </div>
                                </button>
                            </li>
                        ))}
                    </ul>
                    {list.hasNextPage && (
                        <div className="mt-3 flex justify-center">
                            <Button size="sm" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Carregar mais</Button>
                        </div>
                    )}
                </>
            )}
            {editing && <ContactSheet sid={sid} contact={editing} labels={labels.data ?? []} onClose={() => setEditing(null)} />}
        </div>
    );
}

function ContactSheet({ sid, contact, labels, onClose }: { sid: string; contact: Contact; labels: Label[]; onClose: () => void }) {
    const client = useQueryClient();
    const [name, setName] = useState(contact.name ?? "");
    const [fields, setFields] = useState<[string, string][]>(Object.entries(contact.fields ?? {}));
    const [labelIds, setLabelIds] = useState(contact.labels.map(l => l.id));
    const [optedOut, setOptedOut] = useState(!!contact.optedOutAt);

    const m = useMutation({
        mutationFn: () => api.contacts.update(contact.id, {
            name: name.trim(),
            fields: Object.fromEntries(fields.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
            labelIds,
            optedOut,
        }),
        onSuccess: () => {
            client.invalidateQueries({ queryKey: qk.contacts(sid) });
            client.invalidateQueries({ queryKey: qk.labels(sid) });
            client.invalidateQueries({ queryKey: qk.chats(sid) });
            toast.success("Contato salvo");
            onClose();
        },
        onError: e => toast.error(e),
    });

    return (
        <Sheet open onClose={onClose} title={contact.name || contact.pushName || formatPhone(contact.phone)}
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Salvar</Button></>}>
            <div className="space-y-5">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
                    <dt className="text-muted">Número</dt><dd className="tabular">{formatPhone(contact.phone)}</dd>
                    {contact.pushName && <><dt className="text-muted">Nome no WhatsApp</dt><dd>{contact.pushName}</dd></>}
                    <dt className="text-muted">Desde</dt><dd>{fmtDateTime(contact.createdAt)}</dd>
                    {isFuture(contact.pausedUntil) && <><dt className="text-muted">Robô pausado até</dt><dd className="text-warn">{fmtDateTime(contact.pausedUntil)}</dd></>}
                </dl>
                <Field label="Nome"><Input value={name} onChange={e => setName(e.target.value)} placeholder={contact.pushName ?? ""} /></Field>
                <Field label="Etiquetas">
                    {labels.length ? (
                        <div className="grid gap-1.5">
                            {labels.map(l => (
                                <Checkbox key={l.id} checked={labelIds.includes(l.id)} onChange={on => setLabelIds(on ? [...labelIds, l.id] : labelIds.filter(x => x !== l.id))}
                                    label={<span className="inline-flex items-center gap-1.5"><LabelDot color={l.color} />{l.name}</span>} />
                            ))}
                        </div>
                    ) : <p className="text-[12.5px] text-muted">Nenhuma etiqueta criada.</p>}
                </Field>
                <Field label="Campos" hint="Usados nas mensagens como {chave}.">
                    <div className="space-y-2">
                        {fields.map(([k, v], i) => (
                            <div key={i} className="flex gap-2">
                                <Input value={k} placeholder="chave" className="w-36 font-mono text-[12.5px]" onChange={e => setFields(fields.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} />
                                <Input value={v} placeholder="valor" onChange={e => setFields(fields.map((f, j) => (j === i ? [f[0], e.target.value] : f)))} />
                                <IconButton size="icon" title="Remover campo" onClick={() => setFields(fields.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5" /></IconButton>
                            </div>
                        ))}
                        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setFields([...fields, ["", ""]])}>Adicionar campo</Button>
                    </div>
                </Field>
                <Switch checked={optedOut} onChange={setOptedOut} label="Pediu para sair" description="Transmissões com “pular quem saiu” não enviam para este contato." />
            </div>
        </Sheet>
    );
}

// ---------- etiquetas ----------
/** Poucas cores neutras de propósito: a cor da etiqueta só serve para diferenciar. */
const LABEL_COLORS = ["#737373", "#dc2626", "#d97706", "#16a34a", "#2563eb", "#7c3aed", "#db2777", "#0891b2"];

function LabelsTab({ sid }: { sid: string }) {
    const client = useQueryClient();
    const labels = useLabels(sid);
    const [editing, setEditing] = useState<Label | "new" | null>(null);
    const remove = useMutation({
        mutationFn: (id: string) => api.labels.remove(id),
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.labels(sid) }); client.invalidateQueries({ queryKey: qk.contacts(sid) }); toast.success("Etiqueta apagada"); },
        onError: e => toast.error(e),
    });
    if (labels.isPending) return <PageLoader />;
    if (labels.isError) return <p className="text-[13px] text-bad">{labels.error.message}</p>;
    return (
        <div>
            <div className="mb-4 flex items-center justify-between gap-2">
                <p className="text-[13px] text-muted">Organize contatos e use em condições, ações de fluxo e transmissões.</p>
                <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditing("new")}>Nova etiqueta</Button>
            </div>
            {!labels.data.length ? <Empty title="Nenhuma etiqueta" /> : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                    {labels.data.map(l => (
                        <li key={l.id} className="flex items-center gap-3 px-4 py-2.5">
                            <LabelDot color={l.color} />
                            <button type="button" className="min-w-0 flex-1 truncate text-left text-[13.5px] hover:underline" onClick={() => setEditing(l)}>{l.name}</button>
                            <span className="tabular text-[12.5px] text-muted">{fmtNum(l.count)} contato{l.count === 1 ? "" : "s"}</span>
                            <IconButton title="Apagar etiqueta" onClick={async () => {
                                if (await confirm({ title: `Apagar “${l.name}”?`, body: "Sai de todos os contatos. Condições e ações de fluxo que usam esta etiqueta ficam pendentes.", confirm: "Apagar", danger: true })) remove.mutate(l.id);
                            }}><Trash2 className="h-3.5 w-3.5" /></IconButton>
                        </li>
                    ))}
                </ul>
            )}
            {editing && <LabelDialog sid={sid} label={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
        </div>
    );
}

function LabelDialog({ sid, label, onClose }: { sid: string; label: Label | null; onClose: () => void }) {
    const client = useQueryClient();
    const [name, setName] = useState(label?.name ?? "");
    const [color, setColor] = useState(label?.color ?? LABEL_COLORS[0]);
    const m = useMutation({
        mutationFn: () => (label ? api.labels.update(label.id, { name: name.trim(), color }) : api.labels.create(sid, { name: name.trim(), color })),
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.labels(sid) }); client.invalidateQueries({ queryKey: qk.contacts(sid) }); onClose(); },
        onError: e => toast.error(e),
    });
    return (
        <Dialog open onClose={onClose} title={label ? "Editar etiqueta" : "Nova etiqueta"} size="sm"
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>Salvar</Button></>}>
            <div className="space-y-4">
                <Field label="Nome"><Input autoFocus value={name} maxLength={50} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && m.mutate()} /></Field>
                <Field label="Cor">
                    <div className="flex flex-wrap gap-2">
                        {LABEL_COLORS.map(c => (
                            <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Cor ${c}`}
                                className={`flex h-7 w-7 items-center justify-center rounded-full border ${color === c ? "border-fg" : "border-transparent"}`}>
                                <span className="h-3.5 w-3.5 rounded-full" style={{ background: c }} />
                            </button>
                        ))}
                    </div>
                </Field>
            </div>
        </Dialog>
    );
}

// ---------- variáveis do robô ----------
function VariablesTab({ sid }: { sid: string }) {
    const client = useQueryClient();
    const vars = useQuery({ queryKey: qk.variables(sid), queryFn: () => api.variables.get(sid) });
    const [rows, setRows] = useState<{ key: string; value: string; orig?: string }[] | null>(null);
    useEffect(() => { if (vars.data) setRows(Object.entries(vars.data).map(([key, value]) => ({ key, value, orig: key }))); }, [vars.data]);

    const m = useMutation({
        mutationFn: () => {
            const body: Record<string, string | null> = {};
            const keep = new Set(rows!.filter(r => r.key.trim()).map(r => r.key.trim()));
            for (const k of Object.keys(vars.data ?? {})) if (!keep.has(k)) body[k] = null;
            for (const r of rows!) if (r.key.trim()) body[r.key.trim()] = r.value;
            return api.variables.put(sid, body);
        },
        onSuccess: d => { client.setQueryData(qk.variables(sid), d); toast.success("Variáveis salvas"); },
        onError: e => toast.error(e),
    });

    if (vars.isPending || !rows) return vars.isError ? <p className="text-[13px] text-bad">{vars.error.message}</p> : <div className="flex justify-center py-8 text-muted"><Spinner /></div>;
    const badKey = rows.some(r => r.key.trim() && !/^[\w\-.À-ÿ]+$/.test(r.key.trim()));
    const dup = new Set(rows.map(r => r.key.trim())).size !== rows.length;

    return (
        <div className="max-w-2xl">
            <p className="mb-4 text-[13px] text-muted">Valores iguais para todos os contatos, usados nos fluxos como <code className="font-mono text-[12px]">{"{chave}"}</code>: preço, link do checkout, horário de atendimento.</p>
            <div className="space-y-2">
                {rows.map((r, i) => (
                    <div key={i} className="flex gap-2">
                        <Input value={r.key} placeholder="chave" className="w-44 font-mono text-[12.5px]" onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                        <Input value={r.value} placeholder="valor" onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                        <IconButton size="icon" title="Remover variável" onClick={() => setRows(rows.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5" /></IconButton>
                    </div>
                ))}
                {!rows.length && <p className="text-[13px] text-muted">Nenhuma variável.</p>}
                <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRows([...rows, { key: "", value: "" }])}>Adicionar variável</Button>
            </div>
            {badKey && <p className="mt-2 text-[12.5px] text-bad">Use só letras, números, hífen, ponto ou sublinhado na chave.</p>}
            {dup && <p className="mt-2 text-[12.5px] text-bad">Há chaves repetidas.</p>}
            <div className="mt-4 flex justify-end">
                <Button variant="primary" loading={m.isPending} disabled={badKey || dup} onClick={() => m.mutate()}>Salvar variáveis</Button>
            </div>
        </div>
    );
}
