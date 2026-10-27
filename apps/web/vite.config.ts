import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const backend = "http://127.0.0.1:3100";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            "/api": { target: backend, changeOrigin: false },
            "/hooks": { target: backend, changeOrigin: false },
            "/ws": { target: backend.replace("http", "ws"), ws: true },
        },
    },
    build: {
        outDir: "dist",
        chunkSizeWarningLimit: 900,
        rollupOptions: {
            output: {
                manualChunks: {
                    react: ["react", "react-dom", "react-router"],
                    flow: ["@xyflow/react"],
                },
            },
        },
    },
});
