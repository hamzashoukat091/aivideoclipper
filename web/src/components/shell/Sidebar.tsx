import { Plus, X } from "lucide-react";
import { NavLink, useMatch } from "react-router-dom";
import { MOCK } from "@/api/client";
import { useHealth, useJobs } from "@/api/hooks";
import type { JobSummary } from "@/api/types";
import { IconButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Feedback";
import { Tooltip } from "@/components/ui/Tooltip";
import { NAV_FEATURES } from "@/features/registry";
import { cn } from "@/lib/cn";
import { ACTION_LABEL, currentStepName } from "@/lib/stages";
import { openNewJob, setUI, useUI } from "@/lib/ui-store";
import { JobThumb } from "./JobThumb";
import { StageStrip } from "./StageStrip";

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="6" fill="rgb(var(--panel-2))" />
        <rect x="11" y="5" width="10" height="22" rx="2" fill="none" stroke="rgb(var(--accent))" strokeWidth="2.5" />
        <path d="M5 11v10M27 11v10" stroke="rgb(var(--muted))" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span className="text-sm font-semibold tracking-tight text-fg">Clipper Studio</span>
    </div>
  );
}

function JobItem({ job, onNavigate }: { job: JobSummary; onNavigate: () => void }) {
  const match = useMatch({ path: `/jobs/${job.id}`, end: false });
  const run = job.active_run;
  return (
    <NavLink
      to={`/jobs/${job.id}`}
      onClick={onNavigate}
      title={job.title}
      className={cn(
        "press group flex items-center gap-2.5 rounded px-2 py-1.5 hover:bg-fg/[0.05]",
        match && "bg-fg/[0.07] shadow-[inset_2px_0_0_rgb(var(--accent))]",
      )}
    >
      <JobThumb url={job.thumbnail_url} alt="" className="w-14" iconSize="size-3.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-fg">{job.title || job.id}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <StageStrip stages={job.stages} size="sm" tooltips={false} />
          {run ? (
            <Tooltip content={`${ACTION_LABEL[run.action]} ${run.state}${currentStepName(run) ? ` · ${currentStepName(run)}` : ""}`}>
              <span className="inline-flex items-center gap-1 text-xs text-run">
                <span className="size-1.5 animate-pulse-dot rounded-full bg-run" aria-hidden />
                {run.state === "queued" ? "queued" : "live"}
              </span>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </NavLink>
  );
}

export function Sidebar() {
  const ui = useUI();
  const jobs = useJobs();
  const health = useHealth();
  const close = () => setUI({ sidebar: false });
  return (
    <>
      {ui.sidebar ? <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={close} aria-hidden /> : null}
      <aside
        aria-label="Sidebar"
        className={cn(
          "z-40 flex h-full w-[232px] shrink-0 flex-col border-r border-line bg-panel",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-180 max-lg:ease-out",
          ui.sidebar ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
        )}
      >
        <div className="flex h-12 items-center justify-between border-b border-line px-3">
          <NavLink to="/" onClick={close} className="rounded px-1 py-0.5" aria-label="Clipper Studio home">
            <Logo />
          </NavLink>
          <IconButton label="Close sidebar" className="lg:hidden" onClick={close}>
            <X className="size-4" aria-hidden />
          </IconButton>
        </div>
        <nav aria-label="Main" className="space-y-0.5 p-2">
          {NAV_FEATURES.map((f) => (
            <NavLink
              key={f.id}
              to={f.route ?? "/"}
              end={f.route === "/"}
              onClick={close}
              className={({ isActive }) =>
                cn(
                  "press flex h-8 items-center gap-2.5 rounded px-2 text-sm text-muted hover:bg-fg/[0.05] hover:text-fg",
                  isActive && "bg-fg/[0.07] text-fg",
                )
              }
            >
              <f.icon className="size-4" aria-hidden />
              {f.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-faint">Jobs{jobs.data ? ` · ${jobs.data.length}` : ""}</h2>
          <IconButton label="New job" shortcut="N" size="sm" onClick={() => openNewJob()}>
            <Plus className="size-3.5" aria-hidden />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {jobs.isLoading ? (
            <div className="space-y-2 p-1">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : jobs.isError ? (
            <p className="px-2 py-2 text-xs text-muted">Jobs unavailable — server not reachable.</p>
          ) : jobs.data && jobs.data.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted">No jobs yet.</p>
          ) : (
            jobs.data?.map((j) => <JobItem key={j.id} job={j} onNavigate={close} />)
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span className={cn("size-1.5 rounded-full", health.isSuccess ? "bg-ok" : health.isLoading ? "bg-idle" : "bg-bad")} aria-hidden />
            {health.isSuccess ? "Online" : health.isLoading ? "Connecting…" : "Offline"}
          </span>
          <span className="whitespace-nowrap font-mono">
            {MOCK ? <span className="mr-1.5 rounded-sm bg-warn/15 px-1 text-warn">MOCK</span> : null}
            {health.data?.version ? `v${health.data.version}` : ""}
          </span>
        </div>
      </aside>
    </>
  );
}
