import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Paperclip, Upload, X } from "lucide-react";
import { formatPhone, renderTemplate, resolveSettings } from "@areszap/core";
import { api, qk, type Asset } from "@/api";
import { useSessionId, useDebounced } from "@/lib/hooks";
import { fmtBytes, fmtNum, toLocalInput } from "@/lib/format";
import { MAX_RECIPIENTS, parseRecipients } from "@/lib/recipients";
import { useLabels, useSession } from "@/features/sessions/queries";
import { Button, IconButton } from "@/ui/button";
import { Checkbox, Field, Input, NumberInput, Segmented, Textarea } from "@/ui/form";
import { Page, PageHeader, Section, Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";

export function BroadcastNew() {
    const sid = useSessionId();
    const navigate = useNavigate();
    const client = useQueryClient();
    const { data: session } = useSession(sid);
    const labels = useLabels(sid);
    const settings = resolveSettings(session?.settings);

    const [name, setName] = useState("");
    const [text, setText] = useState("");
    const [asset, setAsset] = useState<Asset | null>(null);
    const [uploading, setUploading] = useState(false);
    const [raw, setRaw] = useState("");
    const [labelIds, setLabelIds] = useState<string[]>([]);
    const [when, setWhen] = useState<"now" | "later">("now");
    const [scheduledAt, setScheduledAt] = useState(() => toLocalInput(new Date(Date.now() + 3600_000).toISOString()));
    const [minGap, setMinGap] = useState<number | null>(null);
    const [maxGap, setMaxGap] = useState<number | null>(null);
    const [skipOptedOut, setSkipOptedOut] = useState(true);
    const fileInput = useRef<HTMLInputElement>(null);
    const csvInput = useRef<HTMLInputElement>(null);
    const textArea = useRef<HTMLTextAreaElement>(null);

    const gapMin = minGap ?? settings.sending.bulkMinGapSec;
    const gapMax = maxGap ?? settings.sending.bulkMaxGapSec;

    const rawDebounced = useDebounced(raw, 250);
    const parsed = useMemo(() => parseRecipients(rawDebounced, settings.defaultCountryCode), [rawDebounced, settings.defaultCountryCode]);
    const total = parsed.recipients.length;
    const labelCount = labels.data?.filter(l => labelIds.includes(l.id)).reduce((s, l) => s + l.count, 0) ?? 0;
    const sample = parsed.recipients[0];
    const preview = renderTemplate(text, { nome: "Maria", "primeiro-nome": "Maria", "nome-completo": "Maria Souza", telefone: sample?.phone ?? "", ...(sample?.vars ?? {}) });
    const vars = ["nome", "primeiro-nome", ...parsed.columns.filter(c => c !== "nome" && c !== "primeiro-nome")];

    const upload = async (f: File) => {
        setUploading(true);
        try { setAsset(await api.assets.upload(sid, f)); } catch (e) { toast.error(e); } finally { setUploading(false); }
    };
    const loadCsv = async (f: File) => {
        const t = await f.text();
        setRaw(t);
        if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ""));
    };
    const insertVar = (k: string) => {
        const el = textArea.current;
        const s = el?.selectionStart ?? text.length, e = el?.selectionEnd ?? text.length;
        setText(text.slice(0, s) + `{${k}}` + text.slice(e));
        requestAnimationFrame(() => { el?.focus(); const p = s + k.length + 2; el?.setSelectionRange(p, p); });
    };

    const errors: string[] = [];
    if (!name.trim()) errors.push("Dê um nome à transmissão.");
    if (!text.trim() && !asset) errors.push("Escreva a mensagem ou anexe um arquivo.");
    if (!total && !labelIds.length) errors.push("Informe destinatários ou escolha etiquetas.");
    if (total > MAX_RECIPIENTS) errors.push(`Máximo de ${fmtNum(MAX_RECIPIENTS)} destinatários por transmissão.`);
    if (gapMin > gapMax) errors.push("O intervalo mínimo é maior que o máximo.");
    if (when === "later" && (!scheduledAt || new Date(scheduledAt).getTime() < Date.now())) errors.push("Escolha uma data futura para o agendamento.");

    const create = useMutation({
        mutationFn: () => api.broadcasts.create(sid, {
            name: name.trim(),
            text: text.trim(),
            ...(asset ? { assetId: asset.id } : {}),
            ...(total ? { recipients: parsed.recipients } : {}),
            ...(labelIds.length ? { labelIds } : {}),
            ...(when === "later" ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}),
            minGapSec: gapMin,
            maxGapSec: gapMax,
            skipOptedOut,
        }),
        onSuccess: b => {
            client.invalidateQueries({ queryKey: qk.broadcasts(sid) });
            toast.success(when === "later" ? "Transmissão agendada" : "Transmissão criada");
            if (b.invalidNumbers) toast.info(`${fmtNum(b.invalidNumbers)} número${b.invalidNumbers > 1 ? "s" : ""} recusado${b.invalidNumbers > 1 ? "s" : ""} pelo servidor (formato inválido).`, { duration: 10000 });
            navigate(`/s/${sid}/broadcasts/${b.id}`);
        },
        onError: e => toast.error(e),
    });

    // estimativa grosseira de duração pelo intervalo médio
    const estCount = total + labelCount;
    const estMin = estCount ? Math.round((estCount * (gapMin + gapMax)) / 2 / 60) : 0;

    return (
        <Page width="max-w-3xl">
            <Link to={`/s/${sid}/broadcasts`} className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Transmissões</Link>
            <PageHeader title="Nova transmissão" />

            <Section title="Mensagem">
                <div className="space-y-4">
                    <Field label="Nome" hint="Só para você identificar.">
                        <Input value={name} maxLength={100} onChange={e => setName(e.target.value)} />
                    </Field>
                    <Field label="Texto" hint={<>Variáveis entre chaves vêm das colunas da lista e dos campos do contato.</>}>
                        <Textarea ref={textArea} rows={6} value={text} maxLength={4096} onChange={e => setText(e.target.value)} placeholder="Olá {nome}, tudo bem?" />
                    </Field>
                    <div className="flex flex-wrap gap-1.5">
                        {vars.map(v => (
                            <button key={v} type="button" onClick={() => insertVar(v)} className="rounded border border-line px-1.5 py-0.5 font-mono text-[11.5px] text-muted hover:border-fg hover:text-fg">{`{${v}}`}</button>
                        ))}
                    </div>
                    <div>
                        <input ref={fileInput} type="file" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
                        {asset ? (
                            <div className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                                {asset.mime.startsWith("image/") ? <img src={api.assets.fileUrl(asset.id)} alt="" className="h-9 w-9 rounded object-cover" /> : <FileText className="h-4 w-4 text-muted" />}
                                <span className="min-w-0 flex-1 truncate">{asset.fileName}</span>
                                <span className="text-[12px] text-muted">{fmtBytes(asset.size)}</span>
                                <IconButton title="Remover anexo" onClick={() => setAsset(null)}><X className="h-3.5 w-3.5" /></IconButton>
                            </div>
                        ) : (
                            <Button size="sm" icon={uploading ? <Spinner className="h-3.5 w-3.5" /> : <Paperclip className="h-3.5 w-3.5" />} disabled={uploading} onClick={() => fileInput.current?.click()}>
                                Anexar imagem, vídeo, áudio ou arquivo
                            </Button>
                        )}
                        {asset && <p className="mt-1 text-[12px] text-muted">O texto vai como legenda do anexo.</p>}
                    </div>
                    {(text.trim() || asset) && (
                        <div>
                            <p className="mb-1 text-[12px] text-muted">Prévia{sample ? ` para ${formatPhone(sample.phone)}` : ""}</p>
                            <div className="max-w-md whitespace-pre-wrap break-words rounded-lg bg-subtle px-3.5 py-2.5 text-[13.5px]">{preview || <span className="text-muted">[anexo]</span>}</div>
                        </div>
                    )}
                </div>
            </Section>

            <Section title="Destinatários" description="Cole números ou um CSV. Com cabeçalho, cada coluna vira variável (ex.: “nome” → {nome}). Sem cabeçalho: número e nome.">
                <div className="space-y-3">
                    <Textarea rows={7} value={raw} onChange={e => setRaw(e.target.value)} className="font-mono text-[12.5px]"
                        placeholder={"telefone;nome\n21999998888;Maria\n11988887777;João"} />
                    <div className="flex flex-wrap items-center gap-3">
                        <input ref={csvInput} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) loadCsv(f); e.target.value = ""; }} />
                        <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => csvInput.current?.click()}>Carregar CSV</Button>
                        {raw.trim() && (
                            <p className="tabular text-[12.5px] text-muted">
                                <span className="text-fg">{fmtNum(total)} válidos</span>
                                {parsed.duplicates > 0 && ` · ${fmtNum(parsed.duplicates)} repetidos ignorados`}
                                {parsed.invalid.length > 0 && <span className="text-bad"> · {fmtNum(parsed.invalid.length)} inválidos</span>}
                                {parsed.hasHeader && ` · colunas: ${parsed.columns.join(", ") || "—"}`}
                            </p>
                        )}
                    </div>
                    {parsed.invalid.length > 0 && (
                        <details className="text-[12px]">
                            <summary className="cursor-pointer text-bad">Ver linhas inválidas</summary>
                            <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-muted">
                                {parsed.invalid.slice(0, 200).map(i => <li key={i.line}>linha {i.line}: {i.text}</li>)}
                            </ul>
                        </details>
                    )}
                    {!!labels.data?.length && (
                        <Field label="E/ou contatos com as etiquetas">
                            <div className="flex flex-wrap gap-1.5">
                                {labels.data.map(l => {
                                    const on = labelIds.includes(l.id);
                                    return (
                                        <button key={l.id} type="button" onClick={() => setLabelIds(on ? labelIds.filter(x => x !== l.id) : [...labelIds, l.id])}
                                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors ${on ? "border-fg text-fg" : "border-line text-muted hover:text-fg"}`}>
                                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: l.color }} aria-hidden />{l.name}<span className="tabular text-faint">{fmtNum(l.count)}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </Field>
                    )}
                    <Checkbox checked={skipOptedOut} onChange={setSkipOptedOut} label="Pular quem pediu para sair (opt-out)" />
                </div>
            </Section>

            <Section title="Envio" description={`Intervalo aleatório entre cada mensagem, respeitando o teto diário${settings.sending.bulkWindow ? ` e a janela ${settings.sending.bulkWindow.start}–${settings.sending.bulkWindow.end}` : ""} do número.`}>
                <div className="space-y-4">
                    <Segmented value={when} onChange={setWhen} options={[{ value: "now", label: "Começar agora" }, { value: "later", label: "Agendar" }]} />
                    {when === "later" && (
                        <Field label="Data e hora" hint="No horário deste navegador." className="max-w-xs">
                            <Input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
                        </Field>
                    )}
                    <div className="flex flex-wrap gap-4">
                        <Field label="Intervalo mínimo (s)" className="w-40"><NumberInput min={1} max={3600} value={gapMin} onChange={setMinGap} /></Field>
                        <Field label="Intervalo máximo (s)" className="w-40"><NumberInput min={1} max={3600} value={gapMax} onChange={setMaxGap} /></Field>
                    </div>
                    {estCount > 0 && <p className="text-[12.5px] text-muted">Cerca de {fmtNum(estCount)} envios{labelIds.length ? " (contando as etiquetas, antes de tirar repetidos)" : ""}: uns {estMin < 60 ? `${estMin} min` : `${(estMin / 60).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`} só de intervalo, fora o teto diário.</p>}
                </div>
            </Section>

            <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
                {errors.length > 0 && <p className="mr-auto text-[12.5px] text-muted">{errors[0]}</p>}
                <Link to={`/s/${sid}/broadcasts`}><Button>Cancelar</Button></Link>
                <Button variant="primary" disabled={errors.length > 0} loading={create.isPending} onClick={() => create.mutate()}>
                    {when === "later" ? "Agendar transmissão" : "Criar e enviar"}
                </Button>
            </div>
        </Page>
    );
}
