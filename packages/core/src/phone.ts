/** Só dígitos; aplica o DDI padrão quando o número parece nacional (10 ou 11 dígitos no Brasil). */
export function normalizePhone(input: string, defaultCountryCode = "55"): string | null {
    const raw = String(input ?? "").trim();
    let d = raw.replace(/\D/g, "");
    if (!d) return null;
    if (raw.startsWith("+")) return d.length >= 8 && d.length <= 15 ? d : null;
    if (d.startsWith("00")) d = d.slice(2);
    if (defaultCountryCode === "55" && (d.length === 10 || d.length === 11) && !d.startsWith("55")) d = "55" + d;
    else if (defaultCountryCode !== "55" && d.length <= 10 && !d.startsWith(defaultCountryCode)) d = defaultCountryCode + d;
    return d.length >= 8 && d.length <= 15 ? d : null;
}

export const toUserJid = (digits: string) => `${digits}@s.whatsapp.net`;
export const isGroupJid = (jid: string) => jid.endsWith("@g.us");
export const isLidJid = (jid: string) => jid.endsWith("@lid");
export const isSimJid = (jid: string) => jid.endsWith("@sim");
export const isBroadcastJid = (jid: string) => jid === "status@broadcast" || jid.endsWith("@broadcast") || jid.endsWith("@newsletter");

/** "5511999998888:12@s.whatsapp.net" → "5511999998888". */
export const phoneFromJid = (jid: string) => jid.split("@")[0].split(":")[0];

/** Telefone em formato legível (+55 11 99999-8888 quando brasileiro). */
export function formatPhone(digits: string): string {
    const d = digits.replace(/\D/g, "");
    if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
        const ddd = d.slice(2, 4), rest = d.slice(4);
        return `+55 ${ddd} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
    }
    return `+${d}`;
}
