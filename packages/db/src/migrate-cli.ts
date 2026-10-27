import { runMigrations } from "./migrate";

// comando `npm run db:migrate` (fica fora do index para não entrar no bundle do servidor)
runMigrations()
    .then(() => { console.log("migrações aplicadas"); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
