// Produção: depois de `npm run build`, sobe servidor e worker compilados (processos separados).
// Reinicia o que cair, com espera crescente. Para PM2/systemd, rode os dois `node dist/main.js` separadamente.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fileEnv = existsSync(path.join(root, ".env"))
    ? Object.fromEntries(readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)
        .filter(l => l.trim() && !l.trim().startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }))
    : {};
const env = { NODE_ENV: "production", ...fileEnv, ...process.env };
if (env.DATA_DIR && !path.isAbsolute(env.DATA_DIR)) env.DATA_DIR = path.join(root, env.DATA_DIR);
env.MIGRATIONS_DIR ??= path.join(root, "packages/db/migrations");
env.WEB_DIR ??= path.join(root, "apps/web/dist");

function keep(name, entry) {
    let tries = 0;
    const start = () => {
        const p = spawn(process.execPath, [entry], { cwd: root, env, stdio: "inherit" });
        const began = Date.now();
        p.on("exit", code => {
            if (code === 0) return;
            tries = Date.now() - began > 60_000 ? 0 : tries + 1;
            const wait = Math.min(30_000, 1000 * 2 ** tries);
            console.error(`[${name}] caiu (código ${code}); reiniciando em ${wait / 1000}s`);
            setTimeout(start, wait);
        });
    };
    start();
}

keep("server", path.join(root, "apps/server/dist/main.js"));
// o worker espera o servidor aplicar as migrações
setTimeout(() => keep("worker", path.join(root, "apps/worker/dist/main.js")), 3000);
