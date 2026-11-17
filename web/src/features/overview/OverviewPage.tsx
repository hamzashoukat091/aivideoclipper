import { Play, PlayCircle, RotateCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useEstimate, useRuns, useSystem } from "@/api/hooks";
import type { JobDetail, Stage, StageKey } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Segmented } from "@/components/ui/Segmented";
import { Chip, StateBadge, StateIcon } from "@/components/ui/Status";
import { Tooltip } from "@/components/ui/Tooltip";
import { useJobContext } from "@/features/job/context";
import { PaidConfirmDialog } from "@/features/job/PaidConfirmDialog";
import { useRunAction } from "@/features/job/useRunAction";
import { RunConsole } from "@/features/runs/RunConsole";
import { cn } from "@/lib/cn";
import { fmtBytes, fmtDateTime, fmtDuration, fmtRelative, fmtUsd } from "@/lib/format";
import { useDefaults } from "@/lib/settings";
import { STAGE_INFO, isActive } from "@/lib/stages";

const DONEISH = new Set(["done", "skipped"]);

function blockedReason(job: JobDetail, key: StageKey, keys: { anthropic: boolean } | undefined): string | null {
  if (isActive(job.active_run)) return "A run is active for this job";
  const st = Object.fromEntries(job.stages.map((s) => [s.key, s.state])) as Record<StageKey, Stage["state"]>;
  switch (key) {
    case "ingest":
      return null;
    case "transcribe":
      return st.ingest === "done" ? null : "Needs ingest";
    case "diarize":
      return st.transcribe === "done" ? null : "Needs a transcript";
    case "sentences":
      return DONEISH.has(st.diarize) ? null : "Needs words.json (diarize)";
    case "select":
      if (st.sentences !== "done") return "Needs sentences";
      if (keys && !keys.anthropic) return "ANTHROPIC_API_KEY missing in .env";
      return null;
    case "reframe":
      if (st.select !== "done") return "Needs clip selection";
      return job.clips.candidates - job.clips.rejected > 0 ? null : "Every clip is rejected";
    case "render":
      if (st.select !== "done") return "Needs clip selection";
      if (st.reframe === "missing") return "Reframe clips first";
      return job.clips.candidates - job.clips.rejected > 0 ? null : "Every clip is rejected";
  }
}

function SelectEstimate({ job, enabled }: { job: JobDetail; enabled: boolean }) {
  const d = useDefaults();
  const [asked, setAsked] = useState(false);
  const selectDone = job.stages.find((s) => s.key === "select")?.state === "done";
  const want = enabled && (!selectDone || asked);
  const est = useEstimate(job.id, d.judgeModel, d.topN, want);
  if (!enabled) return null;
  if (!want) {
    return (
      <button type="button" onClick={() => setAsked(true)} className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
        Free estimate for a re-run
      </button>
    );
  }
  return (
    <span className="text-xs text-muted" aria-live="polite">
      {est.isLoading ? (
        "Estimating (free dry run)…"
      ) : est.isError ? (
        <span className="text-bad">Estimate failed</span>
      ) : est.data ? (
        <>
          Estimate <span className="font-mono text-fg tnum">~{fmtUsd(est.data.usd)}</span> with <span className="font-mono">{est.data.judge_model}</span> judge, top{" "}
          {d.topN}
        </>
      ) : null}
    </span>
  );
}

function StageRow({
  stage,
  index,
  last,
  job,
  onRun,
  pending,
}: {
  stage: Stage;
  index: number;
  last: boolean;
  job: JobDetail;
  onRun: (key: StageKey, opts: { fast?: boolean; preview?: boolean }) => void;
  pending: boolean;
}) {
  const sys = useSystem();
  const d = useDefaults();
  const [fast, setFast] = useState(d.fastRenders);
  const [preview, setPreview] = useState(d.previewReframes);
  const info = STAGE_INFO[stage.key];
  const blocked = blockedReason(job, stage.key, sys.data?.keys);
  const rerun = stage.state === "done" || stage.state === "skipped";
  const label =
    stage.state === "running" || stage.state === "queued"
      ? "Running…"
      : stage.key === "select"
        ? rerun
          ? "Re-select"
          : "Select clips"
        : rerun
          ? "Re-run"
          : stage.state === "missing"
            ? "Run"
            : "Run missing";
  const shown = stage.outputs.slice(0, 6);

  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!last ? <span aria-hidden className="absolute left-[13px] top-7 h-[calc(100%-24px)] w-px bg-line" /> : null}
      <span
        className={cn(
          "relative z-[1] mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-panel font-mono text-xs",
          stage.state === "done" ? "border-ok/40" : stage.state === "running" ? "border-run/60" : stage.state === "failed" ? "border-bad/50" : "border-line",
        )}
      >
        {stage.state === "missing" ? <span className="text-faint">{index + 1}</span> : <StateIcon state={stage.state} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Tooltip content={info.what}>
            <h3 tabIndex={0} className="text-sm font-medium text-fg">
              {info.label}
            </h3>
          </Tooltip>
          {/* the stepper circle already shows a done check; a badge only for states that need attention */}
          {stage.state !== "done" ? <StateBadge state={stage.state} /> : null}
          {info.paid ? <Chip className="border-accent/40 font-semibold text-accent">PAID</Chip> : null}
          {stage.updated ? (
            <Tooltip content={fmtDateTime(stage.updated)}>
              <span tabIndex={0} className="text-xs text-faint">
                {fmtRelative(stage.updated)}
              </span>
            </Tooltip>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {stage.key === "render" && !blocked ? (
              <Segmented
                size="sm"
                label="Render quality"
                value={fast ? "fast" : "final"}
                onChange={(v) => setFast(v === "fast")}
                options={[
                  { value: "final", label: "Final", title: "x264 slow CRF 16 (quality bar)" },
                  { value: "fast", label: "Fast", title: "Quicker encode for checking" },
                ]}
              />
            ) : null}
            {stage.key === "reframe" && !blocked ? (
              <Segmented
                size="sm"
                label="Reframe previews"
                value={preview ? "on" : "off"}
                onChange={(v) => setPreview(v === "on")}
                options={[
                  { value: "off", label: "No preview" },
                  { value: "on", label: "+ Preview" },
                ]}
              />
            ) : null}
            <Tooltip content={blocked ?? (info.paid ? "Opens the PAID confirmation with a free estimate" : undefined)}>
              <span tabIndex={blocked ? 0 : -1} className="inline-flex">
                <Button
                  size="sm"
                  variant={info.paid ? "outline" : "secondary"}
                  disabled={!!blocked || pending}
                  icon={rerun ? <RotateCw className="size-3.5" aria-hidden /> : info.paid ? <Sparkles className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                  onClick={() => onRun(stage.key, { fast, preview })}
                  aria-label={`${label}: ${info.label}`}
                >
                  {label}
                </Button>
              </span>
            </Tooltip>
          </div>
        </div>
        {stage.note ? <p className="mt-0.5 text-sm text-fg/90">{stage.note}</p> : null}
        {blocked && !isActive(job.active_run) ? <p className="mt-1 text-xs text-warn">{blocked}</p> : null}
        {stage.key === "select" ? (
          <div className="mt-1">
            <SelectEstimate job={job} enabled={!blocked} />
          </div>
        ) : null}
        {shown.length ? (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`${info.label} outputs`}>
            {shown.map((f) => (
              <li key={f.path}>
                <Link
                  to={`/jobs/${job.id}/files?path=${encodeURIComponent(f.path)}`}
                  className="press inline-flex h-6 items-center gap-1.5 rounded-sm border border-line bg-panel2 px-1.5 font-mono text-xs text-muted hover:border-faint/60 hover:text-fg"
                  title={`${f.path} · ${fmtBytes(f.size)} · ${fmtDateTime(f.mtime)}`}
                >
                  {f.path}
                  <span className="text-faint">{fmtBytes(f.size)}</span>
                </Link>
              </li>
            ))}
            {stage.outputs.length > shown.length ? (
              <li>
                <Link to={`/jobs/${job.id}/files`} className="inline-flex h-6 items-center px-1 text-xs text-muted hover:text-fg">
                  +{stage.outputs.length - shown.length} more
                </Link>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

const RERUN_COPY: Partial<Record<StageKey, string>> = {
  ingest: "Downloads/reads the source again and rewrites meta.json, probe.json and the analysis audio.",
  transcribe: "Rewrites transcript.json. WhisperX runs at about 1.6× real time on this laptop.",
  diarize: "Rewrites diarization.json and words.json.",
  sentences: "Rewrites sentences.json. Clip cut points may change on the next selection.",
  reframe: "Re-analyses every non-rejected clip (force), replacing the reframe plans.",
  render: "Re-renders every non-rejected clip (force), replacing the MP4s and reports.",
};

export default function OverviewPage() {
  const { job } = useJobContext();
  const d = useDefaults();
  const actions = useRunAction(job.id);
  const runs = useRuns(job.id, 1);
  const [confirm, setConfirm] = useState<{ key: StageKey; fast?: boolean; preview?: boolean } | null>(null);
  const consoleRun = job.active_run ?? runs.data?.[0] ?? null;
  const selectDone = job.stages.find((s) => s.key === "select")?.state === "done";
  const busy = isActive(job.active_run);

  const doRun = (key: StageKey, o: { fast?: boolean; preview?: boolean }) => {
    if (key === "select") return actions.run({ action: "select", judge_model: d.judgeModel, top: d.topN });
    const stage = job.stages.find((s) => s.key === key);
    const done = stage?.state === "done" || stage?.state === "skipped";
    actions.run({
      action: key,
      ...(key === "render" ? { fast: o.fast } : {}),
      ...(key === "reframe" ? { preview: o.preview } : {}),
      ...((key === "render" || key === "reframe") && done ? { force: true } : {}),
    });
  };

  const onRun = (key: StageKey, o: { fast?: boolean; preview?: boolean }) => {
    const stage = job.stages.find((s) => s.key === key);
    if (key !== "select" && (stage?.state === "done" || stage?.state === "skipped")) setConfirm({ key, ...o });
    else doRun(key, o);
  };

  const runEverything = () => {
    const body = { action: "produce" as const, fast: d.fastRenders, preview: d.previewReframes, judge_model: d.judgeModel, top: d.topN };
    if (!selectDone) actions.setPaid({ action: "produce", body });
    else actions.run(body);
  };

  return (
    <div className="grid gap-4 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)] xl:items-start">
      <section aria-labelledby="pipeline-h" className="rounded border border-line bg-panel">
        <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
          <h2 id="pipeline-h" className="text-sm font-medium text-fg">
            Pipeline
          </h2>
          <span className="text-xs text-muted">
            {job.clips.candidates} clips · {job.clips.approved} approved · {job.clips.rendered} rendered · spent{" "}
            <span className="font-mono tnum">{fmtUsd(job.cost_usd)}</span>
            {job.duration ? <> · source {fmtDuration(job.duration)}</> : null}
          </span>
          <div className="ml-auto">
            <Tooltip content={busy ? "A run is active for this job" : selectDone ? "Prepare (skips done) → reframe → render" : "Includes PAID clip selection: you confirm the estimate first"}>
              <span tabIndex={busy ? 0 : -1} className="inline-flex">
                <Button variant="primary" size="sm" icon={<PlayCircle className="size-4" aria-hidden />} disabled={busy || actions.pending} onClick={runEverything}>
                  Run everything{!selectDone ? " (PAID step)" : ""}
                </Button>
              </span>
            </Tooltip>
          </div>
        </header>
        <ol className="p-4" aria-label="Stages">
          {job.stages.map((s, i) => (
            <StageRow key={s.key} stage={s} index={i} last={i === job.stages.length - 1} job={job} onRun={onRun} pending={actions.pending} />
          ))}
        </ol>
      </section>

      <div className="xl:sticky xl:top-4">
        <RunConsole run={consoleRun} className="h-[560px] xl:h-[calc(100vh-300px)] xl:min-h-[480px]" title={job.active_run ? "Live run" : "Latest run"} />
        {runs.data && runs.data.length > 0 ? (
          <p className="mt-2 text-right text-xs text-muted">
            <Link to={`/jobs/${job.id}/runs`} className="hover:text-fg hover:underline">
              All runs for this job →
            </Link>
          </p>
        ) : null}
      </div>

      <PaidConfirmDialog jobId={job.id} request={actions.paid} onClose={() => actions.setPaid(null)} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => (!o ? setConfirm(null) : undefined)}
        title={confirm ? `Re-run ${STAGE_INFO[confirm.key].label}?` : "Re-run?"}
        confirmLabel="Re-run"
        onConfirm={() => {
          if (confirm) doRun(confirm.key, confirm);
        }}
      >
        {confirm ? RERUN_COPY[confirm.key] : null} Free (runs on this machine). Existing outputs are overwritten.
      </ConfirmDialog>
    </div>
  );
}
