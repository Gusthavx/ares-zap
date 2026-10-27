import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import { api, qk } from "@/api";
import { useSessionId } from "@/lib/hooks";
import { useLabels } from "@/features/sessions/queries";
import { PageLoader } from "@/ui/misc";
import { FlowEditor, pendingFlush } from "./FlowEditor";

export default function FlowEditorPage() {
    const sid = useSessionId();
    const { flowId = "" } = useParams();
    const client = useQueryClient();
    const [reloadKey, setReloadKey] = useState(0);

    // o editor guarda o estado local: o rascunho só é buscado de novo ao recarregar
    const flow = useQuery({
        queryKey: qk.flow(flowId),
        queryFn: async () => { await pendingFlush.get(flowId); return api.flows.get(flowId); },
        staleTime: Infinity, gcTime: 0,
    });
    const labels = useLabels(sid);
    const flows = useQuery({ queryKey: qk.flows(sid), queryFn: () => api.flows.list(sid) });
    const variables = useQuery({ queryKey: qk.variables(sid), queryFn: () => api.variables.get(sid) });
    const fields = useQuery({ queryKey: qk.fields(sid), queryFn: () => api.sessions.fields(sid), staleTime: 60_000 });

    const reload = async () => {
        await client.refetchQueries({ queryKey: qk.flow(flowId) });
        setReloadKey(k => k + 1);
    };

    const error = flow.error || labels.error || flows.error;
    if (error) return (
        <div className="p-8 text-center text-[13px]">
            <p className="text-bad">{error.message}</p>
            <Link to={`/s/${sid}/flows`} className="mt-2 inline-block text-muted underline">Voltar para os fluxos</Link>
        </div>
    );
    if (!flow.data || !labels.data || !flows.data || flow.isFetching) return <PageLoader />;

    return (
        <ReactFlowProvider>
            <FlowEditor key={`${flowId}:${reloadKey}`} sid={sid} initial={flow.data} labels={labels.data} flows={flows.data}
                variables={variables.data ?? {}} knownContactFields={fields.data?.contact ?? []} onReload={reload} />
        </ReactFlowProvider>
    );
}
