import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Play, Power, Square, Trash2 } from "lucide-react";
import { formatPhone, resolveSettings, sessionSettingsSchema, type SessionSettings } from "@areszap/core";
import { api, qk, type CloudConfig, type Session } from "@/api";
import { useMe } from "@/app/auth";
import { Button } from "@/ui/button";
import { Field, Input, NumberInput, Segmented, Switch } from "@/ui/form";
import { CopyButton, PageLoader, Section, Status, Tag } from "@/ui/misc";
import { confirm, Dialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { useSession } from "./queries";
import { sessionStatus } from "./status";
import { QrCode } from "./QrCode";

export function SessionPanel({ sid }: { sid: string }) {
    const { data: s, isPending } = useSession(sid);
    if (isPending && !s) return <PageLoader />;
    if (!s) return <p className="text-[13px] text-muted">Número não encontrado.</p>;
    return (
        <div>
            <ConnectionSection s={s} />
            <StatsSection sid={s.id} />
            <SettingsForm key={s.id} s={s} />
            <DangerSection s={s} />
        </div>
    );
}

function ConnectionSection({ s }: { s: Session }) {
    const client = useQueryClient();
    const st = sessionStatus(s.status);
    const [renaming, setRenaming] = useState(false);
    const [cloudOpen, setCloudOpen] = useState(false);

    const action = useMutation({
        mutationFn: (a: "start" | "stop" | "logout") => api.sessions.action(s.id, a),
        onSuccess: (_, a) => {
            toast.success(a === "start" ? "Iniciando o número…" : a === "stop" ? "Número parado" : "Número desconectado do celular");
            client.invalidateQueries({ queryKey: qk.session(s.id) });
            client.invalidateQueries({ queryKey: qk.sessions });
            // o worker aplica o comando em segundo plano: confere de novo em seguida
            setTimeout(() => { client.invalidateQueries({ queryKey: qk.session(s.id) }); client.invalidateQueries({ queryKey: qk.sessions }); }, 3000);
        },
        onError: e => toast.error(e),
    });

    const running = ["starting", "qr", "connected", "reconnecting"].includes(s.status);
    const hookUrl = `${location.origin}/hooks/meta/${s.id}`;

    return (
        <Section title="Conexão" actions={<Status tone={st.tone}>{st.label}</Status>}>
            <div className="flex flex-col gap-6 md:flex-row">
                <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex items-center gap-2">
                        <p className="text-[17px] font-semibold">{s.name}</p>
                        <button type="button" title="Renomear" className="rounded p-1 text-muted hover:bg-subtle hover:text-fg" onClick={() => setRenaming(true)}><Pencil className="h-3.5 w-3.5" /></button>
                        <Tag>{s.provider === "cloud" ? "API oficial" : "WhatsApp Web"}</Tag>
                    </div>
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
                        <dt className="text-muted">Número</dt><dd>{s.phone ? formatPhone(s.phone) : "—"}</dd>
                        <dt className="text-muted">Conectado desde</dt><dd>{s.status === "connected" ? fmtDateTime(s.connectedAt) : "—"}</dd>
                        {s.lastError && <><dt className="text-muted">Último erro</dt><dd className="text-bad">{s.lastError}</dd></>}
                    </dl>
                    <div className="flex flex-wrap gap-2 pt-1">
                        {!running && <Button variant="primary" size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={action.isPending && action.variables === "start"} onClick={() => action.mutate("start")}>{s.provider === "baileys" ? "Conectar" : "Iniciar"}</Button>}
                        {running && <Button size="sm" icon={<Square className="h-3.5 w-3.5" />} loading={action.isPending && action.variables === "stop"} onClick={() => action.mutate("stop")}>Parar</Button>}
                        {s.provider === "baileys" && s.status !== "logged_out" && (
                            <Button size="sm" variant="danger" icon={<Power className="h-3.5 w-3.5" />} loading={action.isPending && action.variables === "logout"}
                                onClick={async () => {
                                    if (await confirm({ title: "Desconectar do celular?", body: "O WhatsApp sai deste aparelho conectado. Para voltar, será preciso ler um QR novo.", confirm: "Desconectar", danger: true })) action.mutate("logout");
                                }}>Desconectar</Button>
                        )}
                        {s.provider === "cloud" && <Button size="sm" onClick={() => setCloudOpen(true)}>Atualizar credenciais</Button>}
                    </div>
                    {s.provider === "cloud" && (
                        <div className="space-y-1 pt-2 text-[12.5px]">
                            <p className="text-muted">URL do webhook para cadastrar na Meta (com o token de verificação que você definiu):</p>
                            <div className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
                                <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{hookUrl}</code>
                                <CopyButton value={hookUrl} />
                            </div>
                        </div>
                    )}
                </div>
                {s.provider === "baileys" && (s.status === "qr" || s.status === "starting") && (
                    <div className="flex flex-col items-center gap-2 md:w-[260px]">
                        {s.qr ? <QrCode value={s.qr} /> : <div className="flex h-[232px] w-[232px] items-center justify-center rounded-md border border-dashed border-line text-[12.5px] text-muted">Gerando QR…</div>}
                        <p className="max-w-[240px] text-center text-[12px] text-muted">No celular: WhatsApp → Dispositivos conectados → Conectar dispositivo. O QR muda a cada poucos segundos.</p>
                    </div>
                )}
            </div>
            {renaming && <RenameDialog s={s} onClose={() => setRenaming(false)} />}
            {cloudOpen && <CloudDialog s={s} onClose={() => setCloudOpen(false)} />}
        </Section>
    );
}

function RenameDialog({ s, onClose }: { s: Session; onClose: () => void }) {
    const client = useQueryClient();
    const [name, setName] = useState(s.name);
    const m = useMutation({
        mutationFn: () => api.sessions.update(s.id, { name: name.trim() }),
        onSuccess: updated => { client.setQueryData(qk.session(s.id), updated); client.invalidateQueries({ queryKey: qk.sessions }); onClose(); },
        onError: e => toast.error(e),
    });
    return (
        <Dialog open onClose={onClose} title="Renomear número" size="sm"
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} disabled={!name.trim()} onClick={() => m.mutate()}>Salvar</Button></>}>
            <Input autoFocus value={name} maxLength={60} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim() && m.mutate()} />
        </Dialog>
    );
}

function CloudDialog({ s, onClose }: { s: Session; onClose: () => void }) {
    const client = useQueryClient();
    const [c, setC] = useState<Partial<CloudConfig>>({});
    const m = useMutation({
        mutationFn: () => api.sessions.update(s.id, { cloud: Object.fromEntries(Object.entries(c).filter(([, v]) => v?.trim())) }),
        onSuccess: updated => { client.setQueryData(qk.session(s.id), updated); toast.success("Credenciais atualizadas"); onClose(); },
        onError: e => toast.error(e),
    });
    const set = (k: keyof CloudConfig) => (e: React.ChangeEvent<HTMLInputElement>) => setC(x => ({ ...x, [k]: e.target.value }));
    return (
        <Dialog open onClose={onClose} title="Credenciais da API oficial" description="Preencha só o que quer trocar. Os valores atuais não são mostrados."
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Salvar</Button></>}>
            <div className="space-y-3">
                <Field label="ID do número (Phone number ID)"><Input onChange={set("phoneNumberId")} /></Field>
                <Field label="ID da conta (WABA ID)"><Input onChange={set("wabaId")} /></Field>
                <Field label="Token de acesso"><Input type="password" autoComplete="off" onChange={set("accessToken")} /></Field>
                <Field label="Chave secreta do app"><Input type="password" autoComplete="off" onChange={set("appSecret")} /></Field>
                <Field label="Token de verificação do webhook"><Input onChange={set("verifyToken")} /></Field>
            </div>
        </Dialog>
    );
}

function StatsSection({ sid }: { sid: string }) {
    const stats = useQuery({ queryKey: qk.stats(sid), queryFn: () => api.sessions.stats(sid), refetchInterval: 20_000 });
    const d = stats.data;
    return (
        <Section title="Hoje" description="Fila de envio do número e teto diário efetivo (com aquecimento).">
            {stats.isError ? <p className="text-[13px] text-bad">{stats.error.message}</p> : (
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
                    <Stat label="Enviadas hoje" value={d ? `${fmtNum(d.outbox.sentToday)} / ${fmtNum(d.cap.today)}` : "…"} hint={d ? `teto máximo ${fmtNum(d.cap.perDay)}/dia` : undefined} />
                    <Stat label="Na fila" value={d ? fmtNum(d.outbox.queued + d.outbox.sending) : "…"} hint={d && d.outbox.held ? `${fmtNum(d.outbox.held)} retidas (fora da janela ou teto)` : undefined} tone={d && d.outbox.held ? "warn" : undefined} />
                    <Stat label="Falhas hoje" value={d ? fmtNum(d.outbox.failedToday) : "…"} tone={d && d.outbox.failedToday ? "bad" : undefined} />
                    <Stat label="Fluxos ativos" value={d ? fmtNum(d.flows.active) : "…"} hint={d ? `${fmtNum(d.flows.runsActive)} conversas em andamento` : undefined} />
                </div>
            )}
        </Section>
    );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" | "bad" }) {
    return (
        <div className="bg-bg px-4 py-3">
            <p className="text-[12px] text-muted">{label}</p>
            <p className={`tabular mt-0.5 text-[18px] font-semibold ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : ""}`}>{value}</p>
            {hint && <p className="text-[11.5px] text-muted">{hint}</p>}
        </div>
    );
}

// ---------- configurações (SessionSettings) ----------
const PATH_LABEL: Record<string, string> = {
    timezone: "Fuso horário", defaultCountryCode: "DDI padrão", "humanTakeover.minutes": "Minutos de pausa",
    "sending.perMinute": "Envios por minuto", "sending.perHour": "Envios por hora", "sending.perDay": "Envios por dia",
    "sending.bulkMinGapSec": "Intervalo mínimo", "sending.bulkMaxGapSec": "Intervalo máximo",
    "sending.warmup.startPerDay": "Início do aquecimento", "sending.warmup.growthPct": "Crescimento diário",
    "sending.bulkWindow.start": "Início da janela", "sending.bulkWindow.end": "Fim da janela",
};

function timezones(): string[] {
    try { return Intl.supportedValuesOf("timeZone"); } catch { return ["America/Sao_Paulo"]; }
}

function SettingsForm({ s }: { s: Session }) {
    const client = useQueryClient();
    const initial = useMemo(() => resolveSettings(s.settings), [s.settings]);
    const [d, setD] = useState<SessionSettings>(initial);
    useEffect(() => setD(initial), [initial]);
    const dirty = JSON.stringify(d) !== JSON.stringify(initial);
    const tz = useMemo(timezones, []);

    const parsed = sessionSettingsSchema.safeParse(d);
    const errors: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join(".")] = "Valor fora do permitido.";
    if (d.sending.bulkMinGapSec > d.sending.bulkMaxGapSec) errors["sending.bulkMaxGapSec"] = "O máximo precisa ser maior ou igual ao mínimo.";
    if (d.sending.perMinute > d.sending.perHour) errors["sending.perHour"] = "Menor que o limite por minuto.";
    if (d.sending.perHour > d.sending.perDay) errors["sending.perDay"] = "Menor que o limite por hora.";
    const errorList = Object.keys(errors);

    const save = useMutation({
        mutationFn: () => api.sessions.update(s.id, { settings: d }),
        onSuccess: updated => {
            client.setQueryData(qk.session(s.id), updated);
            client.invalidateQueries({ queryKey: qk.sessions });
            client.invalidateQueries({ queryKey: qk.stats(s.id) });
            toast.success("Configurações salvas");
        },
        onError: e => toast.error(e),
    });

    const up = (fn: (x: SessionSettings) => void) => setD(prev => { const n = structuredClone(prev); fn(n); return n; });
    const err = (k: string) => errors[k];

    return (
        <>
            <Section title="Geral">
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Fuso horário" hint="Usado em condições de dia/hora, atraso por data e janela de envio." error={err("timezone")}>
                        <Input list="az-timezones" value={d.timezone} onChange={e => up(x => { x.timezone = e.target.value; })} />
                        <datalist id="az-timezones">{tz.map(t => <option key={t} value={t} />)}</datalist>
                    </Field>
                    <Field label="DDI padrão" hint="Aplicado a números digitados sem código do país." error={err("defaultCountryCode")}>
                        <Input inputMode="numeric" maxLength={4} value={d.defaultCountryCode} onChange={e => up(x => { x.defaultCountryCode = e.target.value.replace(/\D/g, ""); })} />
                    </Field>
                </div>
            </Section>

            <Section title="Atendimento humano" description="Quando alguém responde pelo painel ou pelo celular, o robô para de falar com aquele contato.">
                <div className="space-y-4">
                    <Switch checked={d.humanTakeover.enabled} onChange={v => up(x => { x.humanTakeover.enabled = v; })}
                        label="Pausar o robô quando um atendente responder" description="Cancela o fluxo em andamento daquele contato." />
                    {d.humanTakeover.enabled && (
                        <Field label="Pausa (minutos)" hint={`${humanMinutes(d.humanTakeover.minutes)}. Máximo de 30 dias.`} error={err("humanTakeover.minutes")} className="max-w-[220px]">
                            <NumberInput min={1} max={43200} value={d.humanTakeover.minutes} onChange={v => up(x => { x.humanTakeover.minutes = Math.round(v); })} />
                        </Field>
                    )}
                    <Field label="Mensagem do contato durante um atraso inteligente">
                        <Segmented value={d.onMessageDuringDelay} onChange={v => up(x => { x.onMessageDuringDelay = v; })} options={[
                            { value: "ignore", label: "Ignorar e seguir esperando" },
                            { value: "interrupt", label: "Interromper e procurar gatilho" },
                        ]} />
                    </Field>
                </div>
            </Section>

            <Section title="Ritmo de envio" description="Limites da fila do número. Conversa de fluxo sempre passa na frente de envio em massa.">
                <div className="space-y-5">
                    <div className="grid gap-4 sm:grid-cols-3">
                        <Field label="Por minuto" error={err("sending.perMinute")}><NumberInput min={1} max={600} value={d.sending.perMinute} onChange={v => up(x => { x.sending.perMinute = Math.round(v); })} /></Field>
                        <Field label="Por hora" error={err("sending.perHour")}><NumberInput min={1} max={20000} value={d.sending.perHour} onChange={v => up(x => { x.sending.perHour = Math.round(v); })} /></Field>
                        <Field label="Por dia" error={err("sending.perDay")}><NumberInput min={1} max={200000} value={d.sending.perDay} onChange={v => up(x => { x.sending.perDay = Math.round(v); })} /></Field>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-3">
                        <Field label="Intervalo mínimo em massa (s)" error={err("sending.bulkMinGapSec")}><NumberInput min={1} max={3600} value={d.sending.bulkMinGapSec} onChange={v => up(x => { x.sending.bulkMinGapSec = v; })} /></Field>
                        <Field label="Intervalo máximo em massa (s)" error={err("sending.bulkMaxGapSec")}><NumberInput min={1} max={3600} value={d.sending.bulkMaxGapSec} onChange={v => up(x => { x.sending.bulkMaxGapSec = v; })} /></Field>
                    </div>
                    <p className="-mt-2 text-[12px] text-muted">Cada envio de transmissão espera um tempo aleatório entre o mínimo e o máximo. Padrão para novas transmissões.</p>
                    <Switch checked={d.sending.typingSimulation} onChange={v => up(x => { x.sending.typingSimulation = v; })}
                        label="Mostrar “digitando…” antes das respostas do fluxo" description="Tempo proporcional ao tamanho do texto." />
                </div>
            </Section>

            <Section title="Aquecimento de número novo" description="O teto diário começa baixo e sobe a cada dia conectado, até o limite por dia.">
                <div className="space-y-4">
                    <Switch checked={d.sending.warmup.enabled} onChange={v => up(x => { x.sending.warmup.enabled = v; })} label="Aquecimento ligado" />
                    {d.sending.warmup.enabled && (
                        <div className="grid gap-4 sm:grid-cols-3">
                            <Field label="Começa com (envios/dia)" error={err("sending.warmup.startPerDay")}><NumberInput min={1} value={d.sending.warmup.startPerDay} onChange={v => up(x => { x.sending.warmup.startPerDay = Math.round(v); })} /></Field>
                            <Field label="Cresce por dia (%)" error={err("sending.warmup.growthPct")}><NumberInput min={1} max={500} value={d.sending.warmup.growthPct} onChange={v => up(x => { x.sending.warmup.growthPct = v; })} /></Field>
                            <Field label="Projeção"><p className="tabular pt-2 text-[12.5px] text-muted">{rampText(d)}</p></Field>
                        </div>
                    )}
                </div>
            </Section>

            <Section title="Janela de envio em massa" description="Transmissões só saem dentro deste horário, no fuso do número. Conversas de fluxo não respeitam a janela.">
                <div className="space-y-4">
                    <Switch checked={!!d.sending.bulkWindow} onChange={v => up(x => { x.sending.bulkWindow = v ? { start: "08:00", end: "20:00" } : null; })} label="Limitar horário" />
                    {d.sending.bulkWindow && (
                        <div className="flex flex-wrap gap-4">
                            <Field label="Das" error={err("sending.bulkWindow.start")}><Input type="time" className="w-32" value={d.sending.bulkWindow.start} onChange={e => up(x => { x.sending.bulkWindow!.start = e.target.value; })} /></Field>
                            <Field label="Até" error={err("sending.bulkWindow.end")}><Input type="time" className="w-32" value={d.sending.bulkWindow.end} onChange={e => up(x => { x.sending.bulkWindow!.end = e.target.value; })} /></Field>
                        </div>
                    )}
                </div>
            </Section>

            <Section title="Histórico">
                <Switch checked={d.syncHistory} onChange={v => up(x => { x.syncHistory = v; })}
                    label="Baixar conversas antigas do celular ao parear" description="Pesado: pode levar minutos e ocupar espaço. Vale só no próximo pareamento." />
            </Section>

            {(dirty || errorList.length > 0) && <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
                {errorList.length > 0 && <p className="mr-auto text-[12.5px] text-bad">Revise: {errorList.map(k => PATH_LABEL[k] ?? k).join(", ")}.</p>}
                {dirty && errorList.length === 0 && <p className="mr-auto text-[12.5px] text-warn">Alterações não salvas</p>}
                <Button disabled={!dirty} onClick={() => setD(initial)}>Descartar</Button>
                <Button variant="primary" disabled={!dirty || errorList.length > 0} loading={save.isPending} onClick={() => save.mutate()}>Salvar configurações</Button>
            </div>}
        </>
    );
}

function humanMinutes(m: number) {
    if (m < 60) return `${m} min`;
    if (m < 1440) return `${(m / 60).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} h`;
    return `${(m / 1440).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} dias`;
}

function rampText(s: SessionSettings) {
    const w = s.sending.warmup;
    const day = (n: number) => Math.min(s.sending.perDay, Math.floor(w.startPerDay * Math.pow(1 + w.growthPct / 100, n)));
    let full = 0;
    while (day(full) < s.sending.perDay && full < 365) full++;
    return `dia 1: ${fmtNum(day(0))} · dia 7: ${fmtNum(day(6))} · teto em ${full + 1} dias`;
}

function DangerSection({ s }: { s: Session }) {
    const me = useMe();
    const client = useQueryClient();
    const navigate = useNavigate();
    const m = useMutation({
        mutationFn: () => api.sessions.remove(s.id),
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.sessions }); toast.success("Número apagado"); navigate("/"); },
        onError: e => toast.error(e),
    });
    if (me.data?.role !== "admin") return null;
    return (
        <Section title="Apagar número" description="Apaga conversas, contatos, fluxos e transmissões deste número. Não dá para desfazer.">
            <Button variant="danger" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} loading={m.isPending}
                onClick={async () => { if (await confirm({ title: `Apagar “${s.name}”?`, body: "Tudo deste número será apagado para sempre.", confirm: "Apagar", danger: true })) m.mutate(); }}>
                Apagar número
            </Button>
        </Section>
    );
}
