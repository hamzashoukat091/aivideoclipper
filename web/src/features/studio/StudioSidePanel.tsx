import { CheckCircle2, Download, Eye, FileX, XCircle } from "lucide-react";
import { memo, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, withDownload } from "@/api/client";
import { useFiles } from "@/api/hooks";
import type { Candidate, CaptionEvent, ReframePlan, RenderReport } from "@/api/types";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { CopyButton, KeyValue, ScoreBar } from "@/components/ui/Misc";
import { Chip, StateBadge } from "@/components/ui/Status";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { LAYOUT_COLOR, LAYOUT_TEXT } from "@/lib/crop";
import { fmtBytes, fmtClock, fmtDateTime, fmtSeconds, num, parseRate, str } from "@/lib/format";

function Block({ title, copy, children }: { title: string; copy?: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-faint">
        {title}
        {copy ? <CopyButton text={copy} label={`Copy ${title.toLowerCase()}`} /> : null}
      </h4>
      {children}
    </div>
  );
}

function Details({ c }: { c: Candidate }) {
  return (
    <div className="space-y-4 p-4 text-sm">
      <Block title="Title" copy={c.title}>
        <p className="font-medium text-fg">{c.title}</p>
      </Block>
      <Block title="On-screen hook" copy={c.on_screen_hook}>
        <p className="font-semibold uppercase tracking-wide text-fg">{c.on_screen_hook}</p>
      </Block>
      <Block title="Hook quote" copy={c.hook_quote}>
        <blockquote className="border-l-2 border-accent/60 pl-3 italic text-fg/90">“{c.hook_quote}”</blockquote>
      </Block>
      <div className="space-y-1.5 rounded border border-line bg-bg/50 p-3">
        <ScoreBar label="Hook" value={c.scores.hook} />
        <ScoreBar label="Self-contained" value={c.scores.self_contained} />
        <ScoreBar label="Payoff" value={c.scores.payoff} />
        <ScoreBar label="Ending" value={c.scores.ending} />
        <ScoreBar label="Overall" value={c.scores.overall} />
      </div>
      <Block title="Why" copy={c.why}>
        <p className="text-fg/90">{c.why}</p>
      </Block>
      <Block title="Judge reason" copy={c.judge_reason}>
        <p className="text-fg/90">{c.judge_reason}</p>
      </Block>
      <KeyValue
        items={[
          ["Category", c.category],
          ["Rank / rerank", `${c.rank} / ${c.rerank_pos.toFixed(2)}`],
          ["Cut in → out", `${c.cut_in.toFixed(3)} → ${c.cut_out.toFixed(3)}`],
          ["Duration", fmtSeconds(c.duration, 2)],
          ["Sentences", `S${c.start_sentence}${c.start_word_offset ? `+${c.start_word_offset}w` : ""}–S${c.end_sentence}`],
          ["Max heat", c.max_heat === null ? "—" : c.max_heat.toFixed(3)],
          ["Proposed by", c.proposed_by.join(", ") || "—"],
          ["Speakers", c.speakers.join(", ") || "unlabelled"],
          ...(c.cut_notes && c.cut_notes.length ? ([["Cut notes", c.cut_notes.join(" · ")]] as [string, string][]) : []),
        ]}
      />
      <Block title="Full text" copy={c.text}>
        <p className="leading-relaxed text-muted">{c.text}</p>
      </Block>
    </div>
  );
}

const CHECK_LABEL: Record<string, (r: RenderReport) => string> = {
  "1080x1920": () => "Resolution 1080×1920",
  fps_matches_source: (r) => `Frame rate matches source (${str(r.output.fps) ?? "?"})`,
  frames_complete: (r) => `All frames piped (${r.frames_piped}/${r.frames_planned})`,
  "loudness_-14_pm1": (r) => `Loudness −14 ±1 LUFS (${num(r.output.loudness_lufs) ?? "?"})`,
  "true_peak_<=-1": (r) => `True peak ≤ −1 dBTP (${num(r.output.true_peak_dbfs) ?? "?"})`,
};

function Checks({ c }: { c: Candidate }) {
  const r = c.render.report;
  if (!r) {
    return (
      <EmptyState icon={FileX} title="No render report">
        Render this clip to see its quality checks (resolution, fps, frames, loudness, true peak).
      </EmptyState>
    );
  }
  const o = r.output;
  const fps = parseRate(str(o.avg_fps) ?? str(o.fps));
  const entries = Object.entries(r.checks);
  const pass = entries.filter(([, v]) => v).length;
  const stale = Math.abs(r.source_range[0] - c.cut_in) > 0.01 || Math.abs(r.source_range[1] - c.cut_out) > 0.01;
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <span className={cn("font-mono text-lg font-semibold tnum", pass === entries.length ? "text-ok" : "text-bad")}>
          {pass}/{entries.length}
        </span>
        <span className="text-sm text-muted">checks pass</span>
        {stale ? <StateBadge state="stale" label="cuts changed since render" className="ml-auto" /> : null}
      </div>
      <ul className="divide-y divide-line/60 rounded border border-line">
        {entries.map(([k, v]) => (
          <li key={k} className="flex items-center gap-2 px-3 py-2 text-sm">
            {v ? <CheckCircle2 className="size-4 shrink-0 text-ok" aria-label="pass" /> : <XCircle className="size-4 shrink-0 text-bad" aria-label="fail" />}
            <span className="flex-1 text-fg">{CHECK_LABEL[k]?.(r) ?? k}</span>
            <span className="font-mono text-xs text-faint">{k}</span>
          </li>
        ))}
      </ul>
      <KeyValue
        items={[
          ["Resolution", `${num(o.width) ?? "?"}×${num(o.height) ?? "?"}`],
          ["Frame rate", `${str(o.fps) ?? "?"}${fps ? ` (${fps.toFixed(3)})` : ""}`],
          ["Frames", `${num(o.frames) ?? "?"} (planned ${r.frames_planned})`],
          ["Duration", fmtSeconds(num(o.duration), 3)],
          ["Video bitrate", num(o.video_kbps) !== null ? `${((num(o.video_kbps) ?? 0) / 1000).toFixed(1)} Mb/s` : "—"],
          ["Pixel format", str(o.pix_fmt) ?? "—"],
          ["Profile / colour", `${str(o.profile) ?? "?"} / ${str(o.color_space) ?? "?"}`],
          ["Audio", str(o.audio) ?? "—"],
          ["Loudness out", num(o.loudness_lufs) !== null ? `${num(o.loudness_lufs)} LUFS` : "—"],
          ["True peak out", num(o.true_peak_dbfs) !== null ? `${num(o.true_peak_dbfs)} dBTP` : "—"],
          ["Loudness in", `I ${r.loudness_in.I ?? "?"} · TP ${r.loudness_in.TP ?? "?"} · LRA ${r.loudness_in.LRA ?? "?"}`],
          ["Source range", `${r.source_range[0].toFixed(3)} → ${r.source_range[1].toFixed(3)}`],
          ["Render time", fmtSeconds(r.render_seconds)],
        ]}
      />
    </div>
  );
}

function flatten(obj: Record<string, unknown>, prefix = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v as Record<string, unknown>, key));
    else out.push([key, Array.isArray(v) ? JSON.stringify(v) : String(v)]);
  }
  return out;
}

function Reframe({ plan, loading, error, frame, onSeek, fps }: { plan: ReframePlan | null; loading: boolean; error: unknown; frame: number; onSeek: (t: number) => void; fps: number }) {
  if (loading) return <SkeletonRows rows={6} className="p-4" />;
  if (!plan) {
    if (error && !(error instanceof ApiError && error.status === 404)) return <ErrorState error={error} />;
    return (
      <EmptyState icon={FileX} title="Not reframed yet">
        Run Reframe to compute shots, faces, the active speaker and the camera path for this clip.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4 p-4">
      <KeyValue
        items={[
          ["Speaker evidence", plan.speaker_evidence],
          ["Frames", `${plan.frames} @ ${plan.fps}`],
          ["Source → output", `${plan.src_w}×${plan.src_h} → ${plan.out_w}×${plan.out_h}`],
          ["Analysis", fmtSeconds(plan.analysis_seconds ?? null)],
          ["Active-speaker (LR-ASD)", fmtSeconds(plan.asd_seconds ?? null)],
        ]}
      />
      <div>
        <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">QA metrics</h4>
        <KeyValue items={flatten(plan.qa).map(([k, v]) => [<span key={k} className="font-mono text-xs">{k}</span>, v])} />
      </div>
      <div>
        <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-faint">Shots ({plan.shots.length})</h4>
        <ol className="space-y-1.5">
          {plan.shots.map((s, i) => {
            const cur = frame >= s.f0 && frame < s.f1;
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => onSeek((s.f0 + 0.5) / fps)}
                  className={cn("row-hover w-full rounded border px-3 py-2 text-left", cur ? "border-accent/50 bg-accent/[0.05]" : "border-line")}
                  aria-current={cur ? "true" : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-faint">#{i + 1}</span>
                    <span className="rounded-sm px-1.5 font-mono text-xs font-medium" style={{ color: LAYOUT_COLOR[s.layout], background: "rgb(var(--raised))" }}>
                      {s.layout}
                    </span>
                    <span className="font-mono text-xs text-muted tnum">
                      {fmtClock(s.f0 / fps, { ms: true })}–{fmtClock(s.f1 / fps, { ms: true })}
                    </span>
                    <span className="ml-auto font-mono text-xs text-faint tnum">
                      f{s.f0}–{s.f1}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {s.reason ?? LAYOUT_TEXT[s.layout]} · {s.faces} face{s.faces === 1 ? "" : "s"}
                    {s.face_inside !== undefined ? ` · face inside ${(s.face_inside * 100).toFixed(0)}%` : ""}
                  </p>
                  {s.talk_share && s.talk_share.length ? (
                    <div className="mt-1.5 flex items-center gap-2" aria-label={`Talk share ${s.talk_share.map((v) => `${Math.round(v * 100)}%`).join(", ")}`}>
                      <span className="text-xs text-faint">talk</span>
                      <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                        {s.talk_share.map((v, k) => (
                          <span key={k} className={k === 0 ? "bg-run" : k === 1 ? "bg-warn" : "bg-ok"} style={{ width: `${v * 100}%` }} />
                        ))}
                      </div>
                      <span className="font-mono text-xs text-muted tnum">{s.talk_share.map((v) => Math.round(v * 100)).join("/")}</span>
                    </div>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

const CaptionRow = memo(function CaptionRow({ e, active, onSeek }: { e: CaptionEvent; active: boolean; onSeek: (t: number) => void }) {
  const words = e.text.split(" ");
  return (
    <li data-active={active || undefined}>
      <button type="button" onClick={() => onSeek(e.start + 0.001)} className={cn("row-hover flex w-full items-start gap-3 px-4 py-1.5 text-left", active && "bg-accent/[0.08]")}>
        <span className={cn("w-16 shrink-0 font-mono text-xs tnum", active ? "text-accent" : "text-faint")}>{fmtClock(e.start, { ms: true })}</span>
        <span className="min-w-0 flex-1 text-sm">
          {e.kind === "hook" ? <Chip className="mr-1.5 border-accent/40 text-accent">hook</Chip> : null}
          {words.map((w, i) => (
            <span key={i} className={cn(i === e.active ? "font-semibold text-accent" : "text-fg/85")}>
              {w}
              {i < words.length - 1 ? " " : ""}
            </span>
          ))}
        </span>
      </button>
    </li>
  );
});

function Captions({ events, url, loading, error, t, onSeek }: { events: CaptionEvent[]; url: string | null; loading: boolean; error: unknown; t: number; onSeek: (t: number) => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const activeIdx = useMemo(() => {
    let idx = -1;
    events.forEach((e, i) => {
      if (e.kind === "caption" && t >= e.start && t < e.end) idx = i;
    });
    return idx;
  }, [events, t]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>("[data-active]");
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);
  if (loading) return <SkeletonRows rows={8} className="p-4" />;
  if (!events.length) {
    if (error && !(error instanceof ApiError && error.status === 404)) return <ErrorState error={error} />;
    return (
      <EmptyState icon={FileX} title="No captions yet">
        Captions are written by the render stage (captions/&lt;clip&gt;.ass).
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-muted">
        <span>
          {events.length} events · {events.filter((e) => e.kind === "hook").length} hook
        </span>
        {url ? (
          <a href={withDownload(url)} download className="text-muted hover:text-fg">
            Download .ass
          </a>
        ) : null}
      </div>
      <ol ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {events.map((e, i) => (
          <CaptionRow key={i} e={e} active={i === activeIdx || (e.kind === "hook" && t >= e.start && t < e.end)} onSeek={onSeek} />
        ))}
      </ol>
    </div>
  );
}

function ClipFiles({ jobId, cid }: { jobId: string; cid: string }) {
  const files = useFiles(jobId);
  if (files.isLoading) return <SkeletonRows rows={5} className="p-4" />;
  if (files.isError) return <ErrorState error={files.error} onRetry={() => void files.refetch()} />;
  const re = new RegExp(`(^|/)${cid.replace(/[-_]/g, "\\$&")}([._]|$)`);
  const mine = (files.data ?? []).filter((f) => re.test(f.path));
  if (!mine.length) return <EmptyState icon={FileX} title="No files for this clip yet" />;
  return (
    <ul className="divide-y divide-line/60">
      {mine.map((f) => (
        <li key={f.path} className="flex items-center gap-2 px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm text-fg" title={f.path}>
              {f.path}
            </div>
            <div className="text-xs text-muted">
              {f.kind} · {fmtBytes(f.size)} · {fmtDateTime(f.mtime)}
            </div>
          </div>
          <Link to={`/jobs/${jobId}/files?path=${encodeURIComponent(f.path)}`} className="press inline-flex size-8 items-center justify-center rounded text-muted hover:bg-fg/[0.06] hover:text-fg" aria-label={`View ${f.path}`} title="View">
            <Eye className="size-4" aria-hidden />
          </Link>
          <a href={withDownload(f.url)} download className="press inline-flex size-8 items-center justify-center rounded text-muted hover:bg-fg/[0.06] hover:text-fg" aria-label={`Download ${f.path}`} title="Download">
            <Download className="size-4" aria-hidden />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function StudioSidePanel({
  c,
  jobId,
  plan,
  planLoading,
  planError,
  events,
  captionsUrl,
  capLoading,
  capError,
  t,
  frame,
  fps,
  onSeek,
}: {
  c: Candidate;
  jobId: string;
  plan: ReframePlan | null;
  planLoading: boolean;
  planError: unknown;
  events: CaptionEvent[];
  captionsUrl: string | null;
  capLoading: boolean;
  capError: unknown;
  t: number;
  frame: number;
  fps: number;
  onSeek: (t: number) => void;
}) {
  const failed = c.render.report ? Object.values(c.render.report.checks).filter((v) => !v).length : 0;
  return (
    <TabsRoot defaultValue="details" className="flex h-full min-h-0 flex-col">
      <TabsList label="Clip details">
        <TabsTrigger value="details">Details</TabsTrigger>
        <TabsTrigger value="checks">
          Checks
          {c.render.report ? <span className={cn("size-1.5 rounded-full", failed ? "bg-bad" : "bg-ok")} aria-label={failed ? `${failed} failed` : "all pass"} /> : null}
        </TabsTrigger>
        <TabsTrigger value="reframe">Reframe</TabsTrigger>
        <TabsTrigger value="captions">Captions</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
      </TabsList>
      <TabsContent value="details" className="overflow-y-auto">
        <Details c={c} />
      </TabsContent>
      <TabsContent value="checks" className="overflow-y-auto">
        <Checks c={c} />
      </TabsContent>
      <TabsContent value="reframe" className="overflow-y-auto">
        <Reframe plan={plan} loading={planLoading} error={planError} frame={frame} onSeek={onSeek} fps={fps} />
      </TabsContent>
      <TabsContent value="captions" className="flex flex-col overflow-hidden">
        <Captions events={events} url={captionsUrl} loading={capLoading} error={capError} t={t} onSeek={onSeek} />
      </TabsContent>
      <TabsContent value="files" className="overflow-y-auto">
        <ClipFiles jobId={jobId} cid={c.id} />
      </TabsContent>
    </TabsRoot>
  );
}
