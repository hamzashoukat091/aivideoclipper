import { History } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useRun, useRuns } from "@/api/hooks";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { useJobContext } from "@/features/job/context";
import { isActive } from "@/lib/stages";
import { useNow } from "@/lib/useNow";
import { RunConsole } from "./RunConsole";
import { RunListItem } from "./RunList";

export default function RunsPage() {
  const { job } = useJobContext();
  const runs = useRuns(job.id, 100);
  const [params, setParams] = useSearchParams();
  const now = useNow(1000, !!runs.data?.some((r) => isActive(r)));
  const wanted = params.get("run");
  const listed = runs.data?.find((r) => r.id === wanted) ?? null;
  const direct = useRun(wanted && !listed && !runs.isLoading ? wanted : null);
  const selected = listed ?? direct.data ?? runs.data?.[0] ?? null;

  if (runs.isLoading) return <SkeletonRows rows={8} className="p-6" />;
  if (runs.isError) return <ErrorState error={runs.error} onRetry={() => void runs.refetch()} className="py-20" />;
  if (!runs.data?.length) {
    return (
      <EmptyState icon={History} title="No runs for this job yet" className="py-20">
        Runs started from Clipper Studio are recorded with their exact commands, exit codes and full logs (runs/&lt;run_id&gt;.json + .log).
      </EmptyState>
    );
  }
  return (
    <div className="grid h-full min-h-0 gap-4 p-4 sm:p-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <section aria-label="Run history" className="flex min-h-0 flex-col overflow-hidden rounded border border-line bg-panel max-lg:max-h-[320px]">
        <header className="flex h-10 shrink-0 items-center border-b border-line px-3 text-sm font-medium text-fg">
          History <span className="ml-2 text-xs font-normal text-muted">{runs.data.length}</span>
        </header>
        <ul className="min-h-0 flex-1 divide-y divide-line/60 overflow-y-auto">
          {runs.data.map((r) => (
            <li key={r.id}>
              <RunListItem run={r} now={now} selected={selected?.id === r.id} onSelect={() => setParams({ run: r.id }, { replace: true })} />
            </li>
          ))}
        </ul>
      </section>
      <RunConsole run={selected} className="min-h-[480px] lg:h-full" title="Run details" />
    </div>
  );
}
