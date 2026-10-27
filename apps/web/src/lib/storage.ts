// localStorage pode lançar (janela privada, bloqueio): sempre com try/catch.
export function load(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}
export function save(key: string, value: string | null) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* sem armazenamento */ }
}
