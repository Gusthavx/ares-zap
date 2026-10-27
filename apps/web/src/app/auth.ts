import { useQuery } from "@tanstack/react-query";
import { api, qk } from "@/api";

export function useMe() {
    return useQuery({ queryKey: qk.me, queryFn: api.auth.me, staleTime: 5 * 60_000 });
}
