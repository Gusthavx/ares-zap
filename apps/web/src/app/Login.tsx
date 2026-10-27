import { useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { api, qk } from "@/api";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/form";
import { PageLoader } from "@/ui/misc";
import { ThemeToggle } from "./ThemeToggle";
import { useMe } from "./auth";

export function LoginPage() {
    const me = useMe();
    const [params] = useSearchParams();
    const client = useQueryClient();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const next = params.get("next");
    const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";

    if (me.isPending) return <div className="h-full"><PageLoader /></div>;
    if (me.data) return <Navigate to={target} replace />;

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const { user } = await api.auth.login(email.trim(), password);
            client.setQueryData(qk.me, user);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Falha ao entrar.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="relative flex min-h-full items-center justify-center px-4 py-12">
            <div className="absolute right-4 top-4"><ThemeToggle /></div>
            <form onSubmit={submit} className="w-full max-w-[340px] animate-in">
                <div className="mb-8">
                    <Logo />
                    <h1 className="mt-6 text-[22px] font-semibold tracking-tight">Entrar</h1>
                    <p className="mt-1 text-[13px] text-muted">Painel de automação de WhatsApp.</p>
                </div>
                <div className="space-y-4">
                    <Field label="E-mail" htmlFor="email">
                        <Input id="email" type="email" autoComplete="email" autoFocus required value={email} onChange={e => setEmail(e.target.value)} />
                    </Field>
                    <Field label="Senha" htmlFor="password">
                        <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
                    </Field>
                    {error && <p className="text-[13px] text-bad">{error}</p>}
                    <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>Entrar</Button>
                </div>
            </form>
        </div>
    );
}

export function Logo({ compact }: { compact?: boolean }) {
    return (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
            <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden>
                <rect width="32" height="32" rx="7" className="fill-fg" />
                <path d="M9 23 16 8l7 15M11.5 18h9" className="stroke-bg" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {!compact && <span className="text-[15px]">Ares Zap</span>}
        </span>
    );
}
