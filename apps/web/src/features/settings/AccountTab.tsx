import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, qk } from "@/api";
import { useMe } from "@/app/auth";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/form";
import { Section } from "@/ui/misc";
import { toast } from "@/ui/toast";

function ProfileForm() {
    const me = useMe();
    const client = useQueryClient();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [current, setCurrent] = useState("");
    useEffect(() => { if (me.data) { setName(me.data.name ?? ""); setEmail(me.data.email); } }, [me.data]);
    const changed = !!me.data && (name.trim() !== (me.data.name ?? "") || email.trim().toLowerCase() !== me.data.email);
    const m = useMutation({
        mutationFn: () => api.auth.profile({ name: name.trim(), email: email.trim(), current }),
        onSuccess: r => { client.setQueryData(qk.me, r.user); toast.success("Dados salvos"); setCurrent(""); },
        onError: e => toast.error(e),
    });
    const submit = (e: FormEvent) => { e.preventDefault(); if (changed && current) m.mutate(); };

    return (
        <Section title="Perfil" description={`Papel: ${me.data?.role === "admin" ? "Administrador" : "Membro"}. O e-mail é o seu login.`}>
            <form onSubmit={submit} className="space-y-3">
                <Field label="Nome"><Input value={name} onChange={e => setName(e.target.value)} maxLength={80} autoComplete="name" /></Field>
                <Field label="E-mail"><Input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" /></Field>
                <Field label="Senha atual" hint="Para confirmar a alteração.">
                    <Input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required />
                </Field>
                <Button type="submit" variant="primary" loading={m.isPending} disabled={!changed || !current}>Salvar</Button>
            </form>
        </Section>
    );
}

function PasswordForm() {
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [again, setAgain] = useState("");
    const m = useMutation({
        mutationFn: () => api.auth.password(current, next),
        onSuccess: () => { toast.success("Senha alterada"); setCurrent(""); setNext(""); setAgain(""); },
        onError: e => toast.error(e),
    });
    const mismatch = again.length > 0 && next !== again;
    const submit = (e: FormEvent) => { e.preventDefault(); if (next.length >= 8 && !mismatch) m.mutate(); };

    return (
        <Section title="Trocar senha">
            <form onSubmit={submit} className="space-y-3">
                <Field label="Senha atual"><Input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required /></Field>
                <Field label="Nova senha" hint="Mínimo de 8 caracteres."><Input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} required /></Field>
                <Field label="Repita a nova senha" error={mismatch ? "As senhas não são iguais." : undefined}>
                    <Input type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} required />
                </Field>
                <Button type="submit" variant="primary" loading={m.isPending} disabled={!current || next.length < 8 || next !== again}>Trocar senha</Button>
            </form>
        </Section>
    );
}

export function AccountTab() {
    return (
        <div className="max-w-md">
            <ProfileForm />
            <PasswordForm />
        </div>
    );
}
