import { AlertTriangle, ExternalLink, FolderX } from "lucide-react";
import { NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useJob } from "@/api/hooks";
import type { JobDetail } from "@/api/types";
import { JobThumb } from "@/components/shell/JobThumb";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/Feedback";
import { Chip } from "@/components/ui/Status";
import { JOB_TABS } from "@/features/registry";
import { cn } from "@/lib/cn";
import { fmtCompact, fmtDuration, fmtFps, fmtUploadDate, num, str } from "@/lib/format";
import type { JobContext } from "./context";

function MediaChips({ job }: { job: JobDetail }) {
  const p = job.probe ?? {};
  const w = num(p.width);
  const h = num(p.height) ?? job.height;
  const v = str(p.vcodec);
  const a = str(p.acodec);
  const hdr = p.hdr === true;
  const vfr = p.likely_vfr === true;
  const sr = num(p.sample_rate);
  const br = num(p.bit_rate);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {w && h ? (
        <Chip mono title="Master resolution">
          {w}×{h}
        </Chip>
      ) : null}
      {job.fps ? <Chip mono>{fmtFps(job.fps)}</Chip> : null}
      {v ? <Chip mono title="Video codec">{v}</Chip> : null}
      {a ? (
        <Chip mono title="Audio codec">
          {a}
          {sr ? ` ${Math.round(sr / 100) / 10} kHz` : ""}
        </Chip>
      ) : null}
      {br ? <Chip mono title="Bit rate">{(br / 1e6).toFixed(1)} Mb/s</Chip> : null}
      {hdr ? <Chip className="border-warn/40 text-warn">HDR</Chip> : null}
      {vfr ? <Chip className="border-warn/40 text-warn" title="Variable frame rate detected">VFR</Chip> : null}
      {job.meta && job.meta.height_ok === false ? <Chip className="border-bad/40 text-bad">below listed height</Chip> : null}
    </div>
  );
}

function Header({ job, compact }: { job: JobDetail; compact: boolean }) {
  const up = fmtUploadDate(job.info?.upload_date);
  const sourceUrl = job.info?.webpage_url ?? (/^https?:\/\//.test(job.source) ? job.source : null);
  return (
    <div className={cn("flex items-start gap-4 px-4 sm:px-6", compact ? "pb-1 pt-2.5" : "pb-3 pt-4")}>
      {!compact ? <JobThumb url={job.thumbnail_url} alt="" className="hidden w-28 md:block" /> : null}
      <div className="min-w-0 flex-1">
        <h1 className="line-clamp-1 text-md font-semibold leading-snug text-fg xl:text-lg" title={job.title}>
          {job.title || job.id}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {job.channel ? <span className="truncate">{job.channel}</span> : null}
          {job.duration ? <span className="font-mono tnum">{fmtDuration(job.duration)}</span> : null}
          {up ? <span>{up}</span> : null}
          {job.info?.view_count ? <span className="tnum">{fmtCompact(job.info.view_count)} views</span> : null}
          <span className="font-mono text-faint">{job.id}</span>
          {sourceUrl ? (
            <a href={sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-muted hover:text-accent">
              Source <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <span className="max-w-[320px] truncate font-mono text-xs text-faint" title={job.source}>
              {job.source}
            </span>
          )}
        </div>
        {!compact ? (
          <div className="mt-2">
            <MediaChips job={job} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div role="status" className="mx-4 mb-3 flex items-start gap-2 rounded border border-warn/30 bg-warn/[0.07] px-3 py-2 text-sm sm:mx-6">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <ul className="min-w-0 space-y-0.5">
        {warnings.map((w) => (
          <li key={w} className="text-fg">
            {w}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function JobLayout() {
  const { id = "" } = useParams();
  const loc = useLocation();
  const job = useJob(id);

  if (job.isLoading) {
    return (
      <div className="space-y-3 p-6" role="status" aria-label="Loading job">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (job.isError || !job.data) {
    if (job.error instanceof ApiError && job.error.status === 404) {
      return (
        <EmptyState icon={FolderX} title="Job not found" className="py-24">
          There is no job <span className="font-mono">{id}</span> in data/jobs. It may have been moved or never ingested.
        </EmptyState>
      );
    }
    return <ErrorState error={job.error} onRetry={() => void job.refetch()} className="py-24" />;
  }

  const d = job.data;
  const ctx: JobContext = { job: d };
  const tabKey = loc.pathname.split("/").slice(3, 4)[0] ?? "";
  const studioActive = tabKey === "clips" && loc.pathname.split("/").length > 4;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-panel/40">
        {/* The Studio needs the height for its players: compact header, warnings stay on the other tabs. */}
        <Header job={d} compact={studioActive} />
        {!studioActive ? <Warnings warnings={d.warnings} /> : null}
        <nav aria-label="Job sections" className="flex items-center gap-0.5 overflow-x-auto px-3 sm:px-5">
          {JOB_TABS.map((t) => {
            const path = t.jobTab!.path;
            const forceActive = t.id === "studio" && studioActive;
            const suppress = t.id === "clips" && studioActive;
            return (
              <NavLink
                key={t.id}
                to={`/jobs/${d.id}${path ? `/${path}` : ""}`}
                end={path === "" || t.id === "clips"}
                className={({ isActive }) =>
                  cn(
                    "relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-sm transition-colors duration-150",
                    (isActive && !suppress) || forceActive ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
                  )
                }
              >
                <t.icon className="size-3.5" aria-hidden />
                {t.label}
                {t.id === "clips" && d.clips.candidates ? <span className="font-mono text-xs text-faint tnum">{d.clips.candidates}</span> : null}
                {t.id === "runs" && d.active_run ? <span className="size-1.5 animate-pulse-dot rounded-full bg-run" aria-label="run active" /> : null}
              </NavLink>
            );
          })}
        </nav>
      </div>
      <div key={tabKey} className="min-h-0 flex-1 animate-fade-in overflow-auto">
        <Outlet context={ctx} />
      </div>
    </div>
  );
}
