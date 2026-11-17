import { Activity, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCancelRun, useRuns, useSystem } from "@/api/hooks";
import type { RunInfo } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { Segmented } from "@/components/ui/Segmented";
import { StateBadge } from "@/components/ui/Status";
import { RunConsole } from "@/features/runs/RunConsole";
import { elapsedSeconds, fmtClock, fmtDateTime, fmtRelative } from "@/lib/format";
import { ACTION_LABEL, isActive } from "@/lib/stages";
import { toast } from "@/lib/toast";
import { useNow } from "@/lib/useNow";

type F = "all" | "active" | "failed" | "done";

export default function ActivityPage() {
  const sys = useSystem();
  const runs = useRuns(null, 200);
  const cancel = useCancelRun();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<F>("all");
  const [toCancel, setToCancel] = useState<RunInfo | null>(null);
  const now = useNow(1000, !!sys.data?.queue.running);
  const list = useMemo(
    () =>
      (runs.data ?? []).filter((r) =>
        filter === "all" ? true : filter === "active" ? isActive(r) : filter === "failed" ? r.state === "failed" || r.state === "cancelled" : r.state === "done",
      ),
    [runs.data, filter],
  );
  const running = sys.data?.queue.running ?? null;
  const queued = sys.data?.queue.queued ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-fg">Activity</h1>
        <span className="text-sm text-muted">One pipeline process runs at a time (CPU-bound); the rest wait in the queue.</span>
      </div>

      <section aria-labelledby="queue-h" className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <h2 id="queue-h" className="mb-2 text-sm font-medium text-fg">
            Running now
          </h2>
          {sys.isLoading ? (
            <SkeletonRows rows={3} />
          ) : sys.isError ? (
            <ErrorState error={sys.error} onRetry={() => void sys.refetch()} />
          ) : running ? (
            <RunConsole run={running} className="h-[440px]" title={`Live · ${running.job_id}`} />
          ) : (
            <div className="rounded border border-line bg-panel">
              <EmptyState icon={Activity} title="Nothing running">
                Start a stage from a job’s Overview. Its live log shows here and in the job.
              </EmptyState>
            </div>
          )}
        </div>
        <div>
          <h2 className="mb-2 text-sm font-medium text-fg">Queue ({queued.length})</h2>
          <div className="rounded border border-line bg-panel">
            {queued.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">The queue is empty.</p>
            ) : (
              <ul className="divide-y divide-line/60">
                {queued.map((r, i) => (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                    <span className="font-mono text-xs text-faint">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-fg">{ACTION_LABEL[r.action]}</div>
                      <Link to={`/jobs/${r.job_id}`} className="font-mono text-xs text-muted hover:text-fg">
                        {r.job_id}
                      </Link>
                    </div>
                    <Button size="sm" variant="danger" icon={<Square className="size-3" aria-hidden />} onClick={() => setToCancel(r)}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="all-h">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 id="all-h" className="text-sm font-medium text-fg">
            All runs
          </h2>
          <Segmented
            size="sm"
            label="Filter runs"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "done", label: "Done" },
              { value: "failed", label: "Failed / cancelled" },
            ]}
          />
        </div>
        <div className="overflow-x-auto rounded border border-line bg-panel">
          {runs.isLoading ? (
            <SkeletonRows rows={5} className="p-3" />
          ) : runs.isError ? (
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          ) : list.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">{runs.data?.length ? "No run matches this filter." : "No runs recorded yet."}</p>
          ) : (
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">All runs across jobs, newest first</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-faint">
                  <th scope="col" className="px-4 py-2 font-medium">Run</th>
                  <th scope="col" className="px-2 py-2 font-medium">Job</th>
                  <th scope="col" className="px-2 py-2 font-medium">State</th>
                  <th scope="col" className="px-2 py-2 font-medium">Steps</th>
                  <th scope="col" className="px-2 py-2 font-medium">Started</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Duration</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const el = elapsedSeconds(r.started ?? r.created, r.ended, now);
                  return (
                    <tr key={r.id} className="row-hover cursor-pointer border-b border-line/60 last:border-b-0" onClick={() => navigate(`/jobs/${r.job_id}/runs?run=${r.id}`)}>
                      <td className="px-4 py-2">
                        <Link to={`/jobs/${r.job_id}/runs?run=${r.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-fg hover:text-accent">
                          {ACTION_LABEL[r.action]}
                        </Link>
                        <div className="font-mono text-xs text-faint">{r.id}</div>
                      </td>
                      <td className="max-w-[200px] truncate px-2 py-2 font-mono text-xs text-muted">{r.job_id}</td>
                      <td className="px-2 py-2">
                        <StateBadge state={r.state} />
                        {r.error ? <div className="max-w-[260px] truncate text-xs text-bad" title={r.error}>{r.error}</div> : null}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-muted">{r.steps.map((s) => s.name).join(" → ") || "—"}</td>
                      <td className="px-2 py-2 text-xs text-muted" title={fmtDateTime(r.started ?? r.created)}>
                        {fmtRelative(r.started ?? r.created, now)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs text-fg tnum">{fmtClock(el)}</td>
                      <td className="px-4 py-2 text-right">
                        {isActive(r) ? (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setToCancel(r);
                            }}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <ConfirmDialog
        open={toCancel !== null}
        onOpenChange={(o) => (!o ? setToCancel(null) : undefined)}
        title="Cancel this run?"
        tone="danger"
        confirmLabel="Cancel run"
        onConfirm={() => {
          if (!toCancel) return;
          cancel.mutate(toCancel.id, { onError: (e) => toast({ tone: "error", title: "Cancel failed", description: e instanceof Error ? e.message : String(e) }) });
        }}
      >
        {toCancel ? (
          <>
            {ACTION_LABEL[toCancel.action]} on <span className="font-mono text-fg">{toCancel.job_id}</span> ({toCancel.state}). A running process tree is killed; a queued run is
            removed from the queue.
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
