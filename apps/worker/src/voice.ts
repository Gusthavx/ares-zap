import { spawn } from "node:child_process";

/**
 * Converte qualquer áudio para OGG/Opus mono (nota de voz que toca em todo celular, inclusive iPhone).
 * Usa o ffmpeg do sistema por stdin/stdout, sem arquivo temporário e sem shell.
 */
export function toVoiceNote(input: Buffer, timeoutMs = 60_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
            "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1",
        ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const timer = setTimeout(() => { ff.kill("SIGKILL"); reject(new Error("ffmpeg demorou demais")); }, timeoutMs);
        ff.stdout.on("data", d => out.push(d));
        ff.stderr.on("data", d => err.push(d));
        ff.on("error", e => { clearTimeout(timer); reject(new Error(`ffmpeg indisponível: ${e.message}`)); });
        ff.on("close", code => {
            clearTimeout(timer);
            if (code === 0 && out.length) resolve(Buffer.concat(out));
            else reject(new Error(`ffmpeg falhou: ${Buffer.concat(err).toString().slice(0, 300)}`));
        });
        ff.stdin.on("error", () => undefined);
        ff.stdin.end(input);
    });
}
