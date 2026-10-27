import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Desenha o texto do QR do WhatsApp em SVG. Fundo sempre branco para a câmera ler bem. */
export function QrCode({ value, size = 232 }: { value: string; size?: number }) {
    const [svg, setSvg] = useState<string | null>(null);
    const [error, setError] = useState(false);
    useEffect(() => {
        let alive = true;
        QRCode.toString(value, { type: "svg", margin: 2, errorCorrectionLevel: "L", color: { dark: "#000000", light: "#ffffff" } })
            .then(s => { if (alive) { setSvg(s); setError(false); } })
            .catch(() => alive && setError(true));
        return () => { alive = false; };
    }, [value]);
    if (error) return <p className="text-[13px] text-bad">Não foi possível desenhar o QR.</p>;
    return (
        <div
            className="overflow-hidden rounded-md border border-line bg-white [&>svg]:h-full [&>svg]:w-full"
            style={{ width: size, height: size }}
            role="img"
            aria-label="QR code para conectar o WhatsApp"
            // SVG gerado localmente pela biblioteca qrcode a partir do texto do QR
            dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        />
    );
}
