import type { RunInfo } from "@/api/types";
import { StateIcon } from "@/components/ui/Status";
import { cn } from "@/lib/cn";
import { elapsedSeconds, fmtClock, fmtDateTime, fmtRelative } from "@/lib/format";
import { ACTION_LABEL, currentStepName } from "@/lib/stages";

export function RunListItem({ run, selected, onSelect, showJob, now }: { run: RunInfo; selected: boolean; onSelect: () => void; showJob?: boolean; now: number }) {
  const el = elapsedSeconds(run.started ?? run.created, run.ended, now);
  const done = run.steps.filter((s) => s.state === "done").length;
  const ran = run.steps.filter((s) => s.state !== "skipped").length;
  const step = currentStepName(run);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn("row-hover flex w-full items-start gap-2.5 px-3 py-2.5 text-left", selected && "bg-accent/[0.08] shadow-[inset_2px_0_0_rgb(var(--accent))]")}
    >
      <StateIcon state={run.state} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{ACTION_LABEL[run.action]}</span>
          {showJob ? <span className="truncate font-mono text-xs text-muted">{run.job_id}</span> : null}
          <span className="ml-auto shrink-0 font-mono text-xs text-muted tnum">{fmtClock(el)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-faint">
          <span title={fmtDateTime(run.created)}>{fmtRelative(run.created, now)}</span>
          <span className="tnum">
            {done}/{ran} steps
          </span>
          {step ? <span className="text-run">· {step}</span> : null}
          {run.error ? <span className="truncate text-bad">· {run.error}</span> : null}
        </div>
      </div>
    </button>
  );
}
