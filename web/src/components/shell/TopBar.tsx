import { ChevronRight, Menu, Plus, Search, ServerOff } from "lucide-react";
import { Link, useLocation, useMatch } from "react-router-dom";
import { useJob, useSystem } from "@/api/hooks";
import { Button, IconButton } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Tooltip } from "@/components/ui/Tooltip";
import { JOB_TABS, NAV_FEATURES } from "@/features/registry";
import { cn } from "@/lib/cn";
import { elapsedSeconds, fmtClock } from "@/lib/format";
import { MOD } from "@/lib/platform";
import { ACTION_LABEL, currentStepName } from "@/lib/stages";
import { openNewJob, setUI } from "@/lib/ui-store";
import { useNow } from "@/lib/useNow";

function Breadcrumb() {
  const loc = useLocation();
  const jobMatch = useMatch({ path: "/jobs/:id/*" });
  const clipMatch = useMatch({ path: "/jobs/:id/clips/:cid" });
  const id = jobMatch?.params.id;
  const job = useJob(id);
  const crumbs: { label: string; to?: string; mono?: boolean }[] = [];
  if (id) {
    crumbs.push({ label: "Library", to: "/" });
    crumbs.push({ label: job.data?.title ?? id, to: `/jobs/${id}` });
    const seg = (jobMatch?.params["*"] ?? "").split("/")[0];
    if (clipMatch) {
      crumbs.push({ label: "Studio", to: `/jobs/${id}/clips` });
      crumbs.push({ label: clipMatch.params.cid ?? "", mono: true });
    } else {
      const tab = JOB_TABS.find((t) => t.jobTab?.path === seg);
      crumbs.push({ label: tab?.label ?? "Overview" });
    }
  } else {
    const f = NAV_FEATURES.find((n) => n.route === loc.pathname) ?? NAV_FEATURES[0];
    crumbs.push({ label: f.label });
  }
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((c, i) => (
          <li key={i} className={cn("flex min-w-0 items-center gap-1", i === 1 || crumbs.length === 1 ? "shrink" : "shrink-0")}>
            {i > 0 ? <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden /> : null}
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to} className="block truncate rounded px-1 text-muted hover:text-fg" title={c.label}>
                {c.label}
              </Link>
            ) : (
              <span aria-current="page" className={cn("block truncate px-1 text-fg", c.mono && "font-mono")} title={c.label}>
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function RunStatusPill() {
  const sys = useSystem();
  const running = sys.data?.queue.running ?? null;
  const queued = sys.data?.queue.queued.length ?? 0;
  const now = useNow(1000, !!running);
  if (sys.isError) {
    return (
      <Tooltip content="The Clipper server is not reachable. Start it with .venv/Scripts/python -m server">
        <span tabIndex={0} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-bad/30 bg-bad/10 px-2.5 text-xs text-bad">
          <ServerOff className="size-3.5" aria-hidden /> Offline
        </span>
      </Tooltip>
    );
  }
  if (!running) {
    return (
      <Link
        to="/activity"
        className="press hidden h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs text-muted hover:text-fg sm:inline-flex"
        aria-label={queued ? `${queued} runs queued` : "No run active — open Activity"}
      >
        <span className="size-1.5 rounded-full bg-idle" aria-hidden />
        {queued ? `${queued} queued` : "Idle"}
      </Link>
    );
  }
  const step = currentStepName(running);
  const el = elapsedSeconds(running.started ?? running.created, null, now);
  return (
    <Link
      to={`/jobs/${running.job_id}`}
      className="press inline-flex h-7 min-w-0 max-w-[340px] items-center gap-2 rounded-full border border-run/30 bg-run/10 px-2.5 text-xs text-fg hover:border-run/60"
      aria-label={`Running ${ACTION_LABEL[running.action]} on ${running.job_id}${step ? `, step ${step}` : ""}`}
    >
      <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-run" aria-hidden />
      <span className="truncate font-mono">{running.job_id}</span>
      <span className="shrink-0 text-muted">·</span>
      <span className="shrink-0 text-run">{step ?? ACTION_LABEL[running.action]}</span>
      <span className="shrink-0 font-mono text-muted tnum">{fmtClock(el)}</span>
      {queued ? <span className="shrink-0 text-muted">+{queued}</span> : null}
    </Link>
  );
}

export function TopBar() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-bg/80 px-3 sm:px-4">
      <IconButton label="Open sidebar" className="lg:hidden" onClick={() => setUI({ sidebar: true })}>
        <Menu className="size-4" aria-hidden />
      </IconButton>
      <div className="min-w-0 flex-1">
        <Breadcrumb />
      </div>
      <RunStatusPill />
      <button
        type="button"
        onClick={() => setUI({ palette: true })}
        className="press hidden h-8 items-center gap-2 rounded border border-line bg-panel px-2.5 text-sm text-muted hover:border-faint/60 hover:text-fg md:inline-flex"
        aria-label="Open command palette"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="hidden xl:inline">Search or jump to…</span>
        <span className="xl:hidden">Search</span>
        <Kbd>{MOD}K</Kbd>
      </button>
      <IconButton label="Command palette" shortcut={`${MOD}K`} className="md:hidden" onClick={() => setUI({ palette: true })}>
        <Search className="size-4" aria-hidden />
      </IconButton>
      <Button variant="primary" icon={<Plus className="size-4" aria-hidden />} onClick={() => openNewJob()}>
        <span className="hidden sm:inline">New job</span>
        <span className="sr-only sm:hidden">New job</span>
      </Button>
    </header>
  );
}
