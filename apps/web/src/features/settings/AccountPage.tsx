import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/app/Login";
import { ThemeToggle } from "@/app/ThemeToggle";
import { AccountTab } from "./AccountTab";

/** Minha conta fora de um número (acessível antes de conectar o primeiro). */
export function AccountPage() {
    return (
        <div className="mx-auto max-w-2xl px-4 py-10">
            <div className="mb-10 flex items-center justify-between"><Logo /><ThemeToggle /></div>
            <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Voltar</Link>
            <h1 className="mb-6 text-[22px] font-semibold tracking-tight">Minha conta</h1>
            <AccountTab />
        </div>
    );
}
