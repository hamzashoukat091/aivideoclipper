import { Clapperboard, Search, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useJobs } from "@/api/hooks";
import type { JobSummary } from "@/api/types";
import { JobThumb } from "@/components/shell/JobThumb";
import { NewJobForm } from "@/components/shell/NewJobForm";
import { StageStrip } from "@/components/shell/StageStrip";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/Feedback";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/cn";
import { fmtClock, fmtRelative, fmtUsd, resolutionLabel } from "@/lib/format";
import { ACTION_LABEL, currentStepName } from "@/lib/stages";

type Filter = "all" | "review" | "rendered" | "running";

function matches(j: JobSummary, f: Filter): boolean {
  if (f === "review") return j.clips.pending > 0;
  if (f === "rendered") return j.clips.rendered > 0;
  if (f === "running") return !!j.active_run;
  return true;
}

function JobCard({ job }: { job: JobSummary }) {
  const res = resolutionLabel(job.height);
  const run = job.active_run;
  return (
    <Link
      to={`/jobs/${job.id}`}
      className="group flex flex-col overflow-hidden rounded border border-line bg-panel transition-[transform,border-color,background-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-faint/60 hover:bg-panel2 active:scale-[.99]"
    >
      <div className="relative">
        <JobThumb url={job.thumbnail_url} alt="" className="w-full rounded-none" iconSize="size-8" />
        <div className="absolute bottom-2 right-2 flex gap-1">
          {res ? <span className="rounded-sm bg-black/75 px-1.5 py-0.5 font-mono text-xs text-fg">{res}</span> : null}
          {job.duration ? <span className="rounded-sm bg-black/75 px-1.5 py-0.5 font-mono text-xs text-fg tnum">{fmtClock(job.duration)}</span> : null}
        </div>
        {run ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-sm bg-black/75 px-1.5 py-0.5 text-xs text-run">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-run" aria-hidden />
            {ACTION_LABEL[run.action]}
            {currentStepName(run) ? ` · ${currentStepName(run)}` : ""}
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-sm font-medium leading-snug text-fg" title={job.title}>
            {job.title || job.id}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted">{job.channel ?? job.source}</p>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2">
          <StageStrip stages={job.stages} focusable={false} />
          <span className="text-xs text-faint">{fmtRelative(job.updated)}</span>
        </div>
        <div className="flex items-baseline gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">
            {[
              <span key="n">{job.clips.candidates} clips</span>,
              job.clips.approved ? <span key="a" className="text-ok">{job.clips.approved} approved</span> : null,
              job.clips.pending ? <span key="p" className="text-warn">{job.clips.pending} to review</span> : null,
              job.clips.rendered ? <span key="r">{job.clips.rendered} rendered</span> : null,
              job.clips.failed_checks ? <span key="f" className="text-bad">{job.clips.failed_checks} failed checks</span> : null,
            ]
              .filter(Boolean)
              .flatMap((el, i) => (i ? [<span key={`s${i}`} aria-hidden className="text-faint"> · </span>, el] : [el]))}
          </span>
          {job.cost_usd ? (
            <span className="ml-auto shrink-0 font-mono text-fg/80 tnum" title="Selection spend">
              {fmtUsd(job.cost_usd)}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

export default function LibraryPage() {
  const jobs = useJobs();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (jobs.data ?? []).filter(
      (j) => matches(j, filter) && (!needle || `${j.title} ${j.channel ?? ""} ${j.id}`.toLowerCase().includes(needle)),
    );
  }, [jobs.data, q, filter]);

  if (jobs.isLoading) {
    return (
      <div className="p-4 sm:p-6">
        <Skeleton className="mb-5 h-8 w-72" />
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[280px]" />
          ))}
        </div>
      </div>
    );
  }
  if (jobs.isError) return <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} className="py-24" />;

  if ((jobs.data ?? []).length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded border border-line bg-panel2">
            <Clapperboard className="size-5 text-accent" aria-hidden />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-fg">Start your first job</h1>
            <p className="text-sm text-muted">Paste a long YouTube video (podcast, interview, vlog) or a local file. The free prepare run starts right away.</p>
          </div>
        </div>
        <div className="rounded border border-line bg-panel p-5">
          <NewJobForm />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-lg font-semibold text-fg">Library</h1>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <label htmlFor="lib-search" className="sr-only">
            Search jobs by title
          </label>
          <input
            id="lib-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by title, channel, id"
            className="h-8 w-64 max-w-full rounded border border-line bg-panel pl-8 pr-2 text-sm text-fg placeholder:text-faint focus:border-accent/70 focus:outline-none"
          />
        </div>
        <Segmented
          label="Filter jobs"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "review", label: "To review" },
            { value: "rendered", label: "Rendered" },
            { value: "running", label: "Running" },
          ]}
        />
      </div>
      {list.length === 0 ? (
        <EmptyState icon={SearchX} title="No matching jobs">
          Nothing matches “{q}”{filter !== "all" ? " with this filter" : ""}.
        </EmptyState>
      ) : (
        <div className={cn("grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]")}>
          {list.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </div>
      )}
    </div>
  );
}
