// Desenvolvimento: aplica migrações e sobe servidor, worker e painel juntos (Ctrl+C derruba os três).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = { ...process.env, ...loadEnv(path.join(root, ".env")) };
if (env.DATA_DIR && !path.isAbsolute(env.DATA_DIR)) env.DATA_DIR = path.join(root, env.DATA_DIR);
env.MIGRATIONS_DIR ??= path.join(root, "packages/db/migrations");

function loadEnv(file) {
    if (!existsSync(file)) { console.error("Crie o .env a partir do .env.example"); process.exit(1); }
    return Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/)
        .filter(l => l.trim() && !l.trim().startsWith("#") && l.includes("="))
        .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

const run = (name, args) => {
    const p = spawn("npm", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    const tag = `[${name}]`.padEnd(9);
    p.stdout.on("data", d => process.stdout.write(String(d).split("\n").filter(Boolean).map(l => `${tag} ${l}`).join("\n") + "\n"));
    p.stderr.on("data", d => process.stderr.write(String(d).split("\n").filter(Boolean).map(l => `${tag} ${l}`).join("\n") + "\n"));
    p.on("exit", code => { console.log(`${tag} saiu (${code})`); });
    return p;
};

const mig = spawn("npm", ["run", "migrate", "-w", "@areszap/db"], { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
mig.on("exit", code => {
    if (code !== 0) { console.error("Migração falhou. O Postgres está de pé? (docker compose up -d)"); process.exit(code ?? 1); }
    const procs = [
        run("server", ["run", "dev", "-w", "@areszap/server"]),
        run("worker", ["run", "dev", "-w", "@areszap/worker"]),
        run("web", ["run", "dev", "-w", "@areszap/web"]),
    ];
    const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
});
