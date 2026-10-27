import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@xyflow/react/dist/base.css";
import "./index.css";
import { ApiError, qk, setUnauthorizedHandler } from "./api";
import { App } from "./app/App";
import { ToastHost } from "./ui/toast";
import { ConfirmHost } from "./ui/overlay";

const client = new QueryClient({
    defaultOptions: {
        queries: {
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
        },
        mutations: { retry: false },
    },
});

// 401 em qualquer chamada: volta para o login.
setUnauthorizedHandler(() => client.setQueryData(qk.me, null));

async function boot() {
    if (import.meta.env.VITE_MOCK === "1") {
        const { installMock } = await import("./mock");
        installMock();
    }
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <QueryClientProvider client={client}>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
                <ToastHost />
                <ConfirmHost />
            </QueryClientProvider>
        </StrictMode>,
    );
}

boot();
