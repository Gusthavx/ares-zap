import { useQuery } from "@tanstack/react-query";
import { api, qk } from "@/api";

export function useSessions() {
    return useQuery({ queryKey: qk.sessions, queryFn: api.sessions.list, staleTime: 30_000 });
}

export function useSession(id: string) {
    const list = useSessions();
    const q = useQuery({ queryKey: qk.session(id), queryFn: () => api.sessions.get(id), enabled: !!id, staleTime: 10_000 });
    return { ...q, data: q.data ?? list.data?.find(s => s.id === id) };
}

export function useLabels(sid: string) {
    return useQuery({ queryKey: qk.labels(sid), queryFn: () => api.labels.list(sid), enabled: !!sid, staleTime: 60_000 });
}
