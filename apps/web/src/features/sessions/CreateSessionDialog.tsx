import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, qk, type CloudConfig, type Provider } from "@/api";
import { Button } from "@/ui/button";
import { Field, Input, Segmented } from "@/ui/form";
import { Dialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";

const randomToken = () => {
    const b = new Uint8Array(18);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
};

export function CreateSessionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const client = useQueryClient();
    const navigate = useNavigate();
    const [name, setName] = useState("");
    const [provider, setProvider] = useState<Provider>("baileys");
    const [cloud, setCloud] = useState<CloudConfig>(() => ({ phoneNumberId: "", wabaId: "", accessToken: "", appSecret: "", verifyToken: randomToken() }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const cloudOk = provider === "baileys" || (cloud.phoneNumberId.trim() && cloud.wabaId.trim() && cloud.accessToken.trim() && cloud.appSecret.trim() && cloud.verifyToken.trim());

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const s = await api.sessions.create({ name: name.trim(), provider, ...(provider === "cloud" ? { cloud } : {}) });
            client.setQueryData(qk.sessions, (list: unknown) => Array.isArray(list) ? [...list, s] : [s]);
            client.invalidateQueries({ queryKey: qk.sessions });
            // Baileys: já pede o QR
            if (provider === "baileys") api.sessions.action(s.id, "start").catch(() => undefined);
            toast.success("Número criado");
            onClose();
            navigate(`/s/${s.id}/settings/number`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    const set = (k: keyof CloudConfig) => (e: React.ChangeEvent<HTMLInputElement>) => setCloud(c => ({ ...c, [k]: e.target.value }));

    return (
        <Dialog open={open} onClose={onClose} title="Adicionar número"
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!name.trim() || !cloudOk} onClick={submit}>Criar número</Button></>}>
            <div className="space-y-4">
                <Field label="Nome" hint="Só para você reconhecer. Ex.: Atendimento, Vendas.">
                    <Input autoFocus value={name} maxLength={60} onChange={e => setName(e.target.value)} />
                </Field>
                <Field label="Conexão">
                    <Segmented value={provider} onChange={setProvider} className="w-full" options={[
                        { value: "baileys", label: "WhatsApp Web (QR)" },
                        { value: "cloud", label: "API oficial (Meta)" },
                    ]} />
                </Field>
                {provider === "baileys" ? (
                    <p className="text-[12.5px] text-muted">Você lê um QR code com o WhatsApp do celular, como no WhatsApp Web. O celular precisa ficar com internet de vez em quando.</p>
                ) : (
                    <div className="space-y-3">
                        <p className="text-[12.5px] text-muted">Dados do app no Meta for Developers (WhatsApp → Configuração da API).</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="ID do número (Phone number ID)"><Input value={cloud.phoneNumberId} onChange={set("phoneNumberId")} inputMode="numeric" /></Field>
                            <Field label="ID da conta (WABA ID)"><Input value={cloud.wabaId} onChange={set("wabaId")} inputMode="numeric" /></Field>
                        </div>
                        <Field label="Token de acesso permanente"><Input value={cloud.accessToken} onChange={set("accessToken")} type="password" autoComplete="off" /></Field>
                        <Field label="Chave secreta do app (App secret)" hint="Usada para conferir a assinatura dos webhooks da Meta.">
                            <Input value={cloud.appSecret} onChange={set("appSecret")} type="password" autoComplete="off" />
                        </Field>
                        <Field label="Token de verificação do webhook" hint="Você cola este mesmo valor na Meta ao configurar o webhook.">
                            <div className="flex gap-2">
                                <Input value={cloud.verifyToken} onChange={set("verifyToken")} className="font-mono text-[12.5px]" />
                                <Button onClick={() => setCloud(c => ({ ...c, verifyToken: randomToken() }))}>Gerar</Button>
                            </div>
                        </Field>
                    </div>
                )}
                {error && <p className="text-[13px] text-bad">{error}</p>}
            </div>
        </Dialog>
    );
}
