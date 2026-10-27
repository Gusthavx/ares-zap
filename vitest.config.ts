import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["packages/*/test/**/*.test.ts", "apps/worker/test/**/*.test.ts", "apps/server/test/**/*.test.ts"],
        environment: "node",
        // os testes com banco usam o mesmo banco de teste: um arquivo por vez
        fileParallelism: false,
    },
});
