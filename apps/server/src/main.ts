import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, runMigrations } from "@areszap/db";
import { buildApp } from "./app";

async function main() {
    if (process.env.MIGRATE_ON_START !== "0") await runMigrations();
    const { sql } = connect(process.env.DATABASE_URL, { max: Number(process.env.SERVER_DB_POOL || 10), appName: "areszap-server" });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDir = process.env.WEB_DIR ?? path.resolve(here, "../../web/dist");
    const app = await buildApp(sql, { webDir });
    const port = Number(process.env.PORT || 3100);
    // padrão: só na máquina local; para expor, use HOST=0.0.0.0 atrás de um proxy com HTTPS
    const host = process.env.HOST || "127.0.0.1";
    await app.listen({ port, host });
}

main().catch(e => { console.error(e); process.exit(1); });
