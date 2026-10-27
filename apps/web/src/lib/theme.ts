import { useSyncExternalStore } from "react";
import { load, save } from "./storage";

export type Theme = "light" | "dark";
const subs = new Set<() => void>();

function current(): Theme {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function setTheme(t: Theme) {
    document.documentElement.classList.toggle("dark", t === "dark");
    save("az-theme", t);
    subs.forEach(f => f());
}

export function useTheme(): [Theme, () => void] {
    const t = useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb); }, current);
    return [t, () => setTheme(t === "dark" ? "light" : "dark")];
}

export const storedTheme = () => load("az-theme");
