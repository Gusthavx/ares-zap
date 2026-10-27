import { existsSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { connect, runMigrations } from "@areszap/db";

// roda via npm -w (cwd = apps/server): lê o .env da raiz se o banco não veio do ambiente
const rootEnv = path.resolve(process.cwd(), "../../.env");
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

/** npm run make-admin -- email@exemplo.com "senha forte" [Nome] — cria ou promove um administrador. */
async function main() {
    const [email, password, ...name] = process.argv.slice(2);
    if (!email || !password) {
        console.error('Uso: npm run make-admin -- email@exemplo.com "senha" [Nome]');
        process.exit(1);
    }
    if (password.length < 8) { console.error("A senha precisa de pelo menos 8 caracteres"); process.exit(1); }
    await runMigrations();
    const { sql, close } = connect(process.env.DATABASE_URL, { max: 1 });
    const hash = await bcrypt.hash(password, 12);
    const [u] = await sql`
        insert into users (email, name, password_hash, role) values (${email.toLowerCase()}, ${name.join(" ")}, ${hash}, 'admin')
        on conflict (lower(email)) do update set password_hash = excluded.password_hash, role = 'admin'
        returning id, email`;
    console.log(`Administrador pronto: ${u.email}`);
    await close();
}

main().catch(e => { console.error(e); process.exit(1); });
