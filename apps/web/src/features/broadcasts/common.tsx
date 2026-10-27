import type { Broadcast, BroadcastStatus } from "@/api";
import { fmtNum, fmtRelative } from "@/lib/format";
import { Progress, type Tone } from "@/ui/misc";

export const BROADCAST_STATUS: Record<BroadcastStatus, { label: string; tone: Tone }> = {
    scheduled: { label: "Agendada", tone: "neutral" },
    running: { label: "Enviando", tone: "ok" },
    paused: { label: "Pausada", tone: "warn" },
    completed: { label: "Concluída", tone: "neutral" },
    cancelled: { label: "Cancelada", tone: "neutral" },
};

export const bStatus = (s: string) => BROADCAST_STATUS[s as BroadcastStatus] ?? { label: s, tone: "neutral" as Tone };

export function messagePreview(b: Broadcast): string {
    const m = b.message;
    switch (m.kind) {
        case "text": return m.text;
        case "media": return m.caption || `[${m.media}${m.fileName ? `: ${m.fileName}` : ""}]`;
        case "vcard": return `[contato: ${m.name}]`;
        case "menu": return m.question;
        case "template": return `[modelo: ${m.name}]`;
    }
}

export function BroadcastProgress({ b }: { b: Broadcast }) {
    const done = b.sent + b.failed + b.skipped;
    return (
        <div className="space-y-1.5">
            <Progress value={done} max={b.total} />
            <p className="tabular flex flex-wrap gap-x-3 text-[12px] text-muted">
                <span>{fmtNum(b.sent)} enviadas</span>
                {b.failed > 0 && <span className="text-bad">{fmtNum(b.failed)} falhas</span>}
                {b.skipped > 0 && <span>{fmtNum(b.skipped)} puladas</span>}
                <span>de {fmtNum(b.total)}</span>
                {b.status === "running" && b.etaAt && <span>· termina {fmtRelative(b.etaAt)}</span>}
            </p>
        </div>
    );
}
