import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/** Aplica as migrações versionadas (pasta migrations/). Usado no dev e no start de produção. */
export async function runMigrations(url = process.env.DATABASE_URL) {
    if (!url) throw new Error("DATABASE_URL não definido");
    const client = postgres(url, { max: 1, onnotice: () => undefined });
    const db = drizzle(client);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const folder = process.env.MIGRATIONS_DIR ?? path.resolve(here, "../migrations");
    try {
        await migrate(db, { migrationsFolder: folder });
    } finally {
        await client.end({ timeout: 5 });
    }
}
