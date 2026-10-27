import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api, qk, type Role } from "@/api";
import { useMe } from "@/app/auth";
import { Button, IconButton } from "@/ui/button";
import { Field, Input, Segmented } from "@/ui/form";
import { PageLoader, Tag } from "@/ui/misc";
import { confirm, Dialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { fmtDateTime } from "@/lib/format";

export function UsersTab() {
    const client = useQueryClient();
    const me = useMe();
    const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
    const [open, setOpen] = useState(false);
    const remove = useMutation({
        mutationFn: (id: string) => api.users.remove(id),
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.users }); toast.success("Usuário removido"); },
        onError: e => toast.error(e),
    });

    if (users.isPending) return <PageLoader />;
    if (users.isError) return <p className="text-[13px] text-bad">{users.error.message}</p>;

    return (
        <div>
            <div className="mb-4 flex items-center justify-between gap-2">
                <p className="text-[13px] text-muted">Quem pode entrar no painel. Administradores gerenciam usuários e apagam números.</p>
                <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>Novo usuário</Button>
            </div>
            <ul className="divide-y divide-line rounded-lg border border-line">
                {users.data.map(u => (
                    <li key={u.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-2 font-medium">{u.name || u.email}{u.id === me.data?.id && <Tag>você</Tag>}</p>
                            <p className="truncate text-[12.5px] text-muted">{u.email}{u.createdAt ? ` · desde ${fmtDateTime(u.createdAt)}` : ""}</p>
                        </div>
                        <Tag>{u.role === "admin" ? "Administrador" : "Membro"}</Tag>
                        {u.id !== me.data?.id && (
                            <IconButton title="Remover usuário" onClick={async () => {
                                if (await confirm({ title: `Remover ${u.name || u.email}?`, body: "A pessoa perde o acesso ao painel.", confirm: "Remover", danger: true })) remove.mutate(u.id);
                            }}><Trash2 className="h-3.5 w-3.5" /></IconButton>
                        )}
                    </li>
                ))}
            </ul>
            {open && <NewUserDialog onClose={() => setOpen(false)} />}
        </div>
    );
}

function NewUserDialog({ onClose }: { onClose: () => void }) {
    const client = useQueryClient();
    const [f, setF] = useState({ name: "", email: "", password: "", role: "member" as Role });
    const m = useMutation({
        mutationFn: () => api.users.create({ ...f, email: f.email.trim(), name: f.name.trim() }),
        onSuccess: () => { client.invalidateQueries({ queryKey: qk.users }); toast.success("Usuário criado"); onClose(); },
        onError: e => toast.error(e),
    });
    const ok = f.name.trim() && /\S+@\S+\.\S+/.test(f.email) && f.password.length >= 8;
    return (
        <Dialog open onClose={onClose} title="Novo usuário"
            footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={m.isPending} disabled={!ok} onClick={() => m.mutate()}>Criar</Button></>}>
            <div className="space-y-3">
                <Field label="Nome"><Input autoFocus value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
                <Field label="E-mail"><Input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
                <Field label="Senha inicial" hint="Mínimo de 8 caracteres. A pessoa pode trocar depois em Minha conta.">
                    <Input type="password" autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} />
                </Field>
                <Field label="Papel">
                    <Segmented value={f.role} onChange={role => setF({ ...f, role })} options={[{ value: "member", label: "Membro" }, { value: "admin", label: "Administrador" }]} />
                </Field>
            </div>
        </Dialog>
    );
}
