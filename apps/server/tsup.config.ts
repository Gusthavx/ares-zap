import { defineConfig } from "tsup";

// os pacotes internos (@areszap/*) são TypeScript-fonte: entram no bundle; o resto fica em node_modules
export default defineConfig({
    entry: ["src/main.ts", "src/make-admin.ts"],
    format: ["esm"],
    target: "node22",
    outDir: "dist",
    clean: true,
    splitting: false,
    noExternal: [/^@areszap\//],
});
