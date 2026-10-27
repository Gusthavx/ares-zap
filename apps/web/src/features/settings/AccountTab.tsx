import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/api";
import { useMe } from "@/app/auth";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/form";
import { Section } from "@/ui/misc";
import { toast } from "@/ui/toast";

export function AccountTab() {
    const me = useMe();
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
        <div className="max-w-md">
            <Section title="Perfil">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
                    <dt className="text-muted">Nome</dt><dd>{me.data?.name || "—"}</dd>
                    <dt className="text-muted">E-mail</dt><dd>{me.data?.email}</dd>
                    <dt className="text-muted">Papel</dt><dd>{me.data?.role === "admin" ? "Administrador" : "Membro"}</dd>
                </dl>
            </Section>
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
        </div>
    );
}
