/**
 * DEV-ONLY mock API (enabled with VITE_MOCK=1; tree-shaken out of production builds).
 * Serves fixtures generated from the REAL data/jobs/test_fallon files by scripts/make-fixtures.mjs and simulates
 * runs (log lines, step states, SSE) in memory. It never calls anything paid and never touches disk.
 * Add `?mock=empty` to the URL once to see the empty-library state (kept for the browser session).
 */
import { ApiError, type RequestOptions } from "./client";
import type { StreamHandlers } from "./stream";
import type {
  Candidate,
  Captions,
  EditContext,
  Edits,
  Estimate,
  FileEntry,
  JobDetail,
  JobSummary,
  ReframePlan,
  RunAction,
  RunInfo,
  RunStep,
  Selection,
  Stage,
  StageKey,
  SystemInfo,
  Transcript,
} from "./types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/* Fixtures are generated locally (`npm run fixtures`) from one of your own jobs and are NOT committed: they hold a
 * full transcript of someone else's video plus local paths. Without them, mock mode shows the empty library. */
const FIXTURES = import.meta.glob<unknown>("./fixtures/*.json", { eager: true, import: "default" });
const fx = (name: string): unknown => FIXTURES[`./fixtures/${name}.json`];
const HAS_FIXTURES = fx("job") !== undefined;
if (!HAS_FIXTURES) console.info("[mock] no fixtures: run `npm run fixtures` to build them from data/jobs/test_fallon");
const jobFx = fx("job");
const transcriptFx = fx("transcript");
const selectionFx = fx("selection");
const reframeFx = fx("reframe") ?? {};
const captionsFx = fx("captions") ?? {};
const filesFx = fx("files") ?? [];
const editsFx = fx("edits") ?? {};
const runsFx = fx("runs") ?? [];

const EMPTY = !HAS_FIXTURES || (() => {
  try {
    const q = new URLSearchParams(window.location.search).get("mock");
    if (q === "empty") window.sessionStorage.setItem("clipper-mock", "empty");
    if (q === "full") window.sessionStorage.removeItem("clipper-mock");
    return window.sessionStorage.getItem("clipper-mock") === "empty";
  } catch {
    return false;
  }
})();

interface JobData {
  detail: JobDetail;
  transcript: Transcript | null;
  selection: Selection | null;
  plans: Record<string, ReframePlan>;
  captions: Record<string, Captions>;
  files: FileEntry[];
  baseStates: Record<StageKey, Stage["state"]>;
  edits: Record<string, EditContext>;
}

interface MockRun {
  info: RunInfo;
  lines: string[];
  subs: Set<StreamHandlers>;
  timer: number | undefined;
  failAt: number | null;
}

const jobs = new Map<string, JobData>();
const runs = new Map<string, MockRun>();

function baseStates(d: JobDetail): Record<StageKey, Stage["state"]> {
  const out = {} as Record<StageKey, Stage["state"]>;
  d.stages.forEach((s) => {
    out[s.key] = s.state;
  });
  return out;
}

if (!EMPTY) {
  const detail = clone(jobFx as unknown as JobDetail);
  jobs.set(detail.id, {
    detail,
    transcript: transcriptFx === undefined ? null : clone(transcriptFx as Transcript),
    selection: selectionFx === undefined ? null : clone(selectionFx as Selection),
    plans: clone(reframeFx as unknown as Record<string, ReframePlan>),
    captions: clone(captionsFx as unknown as Record<string, Captions>),
    files: clone(filesFx as unknown as FileEntry[]),
    baseStates: baseStates(detail),
    edits: clone(editsFx as unknown as Record<string, EditContext>),
  });
  for (const r of runsFx as unknown as { info: RunInfo; log: string }[]) {
    runs.set(r.info.id, { info: clone(r.info), lines: r.log.split("\n").filter((l, i, a) => l || i < a.length - 1), subs: new Set(), timer: undefined, failAt: null });
  }
}

const delay = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function summary(d: JobDetail): JobSummary {
  const { id, title, channel, source, duration, height, fps, created, updated, thumbnail_url, stages, clips, cost_usd, active_run, warnings } = d;
  return { id, title, channel, source, duration, height, fps, created, updated, thumbnail_url, stages, clips, cost_usd, active_run, warnings };
}

function getJob(id: string): JobData {
  const j = jobs.get(id);
  if (!j) throw new ApiError(404, "not_found", `No job "${id}"`);
  return j;
}

function recount(j: JobData): void {
  if (!j.selection) return;
  const c = j.selection.candidates;
  j.detail.clips.approved = c.filter((x) => x.approved === true).length;
  j.detail.clips.rejected = c.filter((x) => x.approved === false).length;
  j.detail.clips.pending = c.filter((x) => x.approved === null).length;
}

// ---------------------------------------------------------------- runs

const PY = ".venv/Scripts/python.exe";
const script = (name: string, args: string[]) => [PY, "-W", "ignore", `clipper/${name}.py`, ...args];

function stepPlan(job: JobData, action: RunAction, body: Record<string, unknown>): RunStep[] {
  const id = job.detail.id;
  const force = body.force === true;
  const st = job.baseStates;
  const clips = Array.isArray(body.clips) ? (body.clips as string[]) : (job.selection?.candidates ?? []).filter((c) => c.approved !== false).map((c) => c.id);
  const mk = (name: string, command: string[], skip = false): RunStep => ({
    name, command, state: skip ? "skipped" : "queued", started: null, ended: null, exit_code: null,
  });
  const lang = typeof body.language === "string" ? body.language : "en";
  const prepare = [
    mk("ingest", script("ingest", [job.detail.source, "--id", id]), !force && st.ingest === "done"),
    mk("transcribe", script("transcribe", ["--id", id, "--language", lang]), !force && st.transcribe === "done"),
    mk("diarize", script("diarize", ["--id", id]), !force && (st.diarize === "done" || st.diarize === "skipped")),
    mk("sentences", script("sentences", ["--id", id]), !force && st.sentences === "done"),
  ];
  const select = mk("select", script("select_clips", ["--id", id, "--top", String(body.top ?? 10), "--judge-model", String(body.judge_model ?? "sonnet")]));
  const reframe = mk("reframe", script("reframe", ["--id", id, "--clip", ...clips, ...(body.preview ? ["--preview"] : [])]), clips.length === 0);
  const render = mk("render", script("render", ["--id", id, "--clip", ...clips, ...(body.fast ? ["--fast"] : [])]), clips.length === 0);
  switch (action) {
    case "prepare":
      return prepare;
    case "ingest":
      return [mk("ingest", script("ingest", [job.detail.source, "--id", id]))];
    case "transcribe":
      return [mk("transcribe", script("transcribe", ["--id", id, "--language", lang]))];
    case "diarize":
      return [mk("diarize", script("diarize", ["--id", id]))];
    case "sentences":
      return [mk("sentences", script("sentences", ["--id", id]))];
    case "select":
      return [select];
    case "reframe":
      return [reframe];
    case "render":
      return [render];
    case "produce":
      return [...prepare, { ...select, state: st.select === "done" ? "skipped" : "queued" }, reframe, render];
    case "proxy":
      return [mk("proxy", ["ffmpeg", "-y", "-i", `data/jobs/${id}/source`, "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "ui/source_proxy.mp4"])];
  }
}

function emitState(r: MockRun): void {
  const snap = clone(r.info);
  r.subs.forEach((s) => s.onState(snap));
}
function emitLog(r: MockRun, line: string): void {
  r.lines.push(line);
  r.subs.forEach((s) => s.onLog(line));
}
function finishRun(r: MockRun): void {
  const job = jobs.get(r.info.job_id);
  if (job) {
    job.detail.active_run = null;
    job.detail.stages.forEach((s) => {
      s.state = job.baseStates[s.key];
    });
    job.detail.updated = nowIso();
  }
  emitState(r);
  r.subs.forEach((s) => {
    s.onConnection("closed");
    s.onEnd();
  });
  r.subs.clear();
  startNext();
}

const STEP_STAGE: Record<string, StageKey | undefined> = {
  ingest: "ingest", transcribe: "transcribe", diarize: "diarize", sentences: "sentences", select: "select", reframe: "reframe", render: "render",
};

function fakeLines(name: string): string[] {
  const p = (n: number) => `  ${name}: ${"█".repeat(n)}${"░".repeat(10 - n)} ${n * 10}%`;
  const base = [`[mock] ${name}: simulated step — mock mode runs no pipeline code and spends nothing`];
  for (let i = 1; i <= 10; i += 1) base.push(p(i));
  return base;
}

function advance(r: MockRun): void {
  const info = r.info;
  const job = jobs.get(info.job_id);
  const idx = info.steps.findIndex((s) => s.state === "queued");
  if (idx < 0) {
    info.state = "done";
    info.ended = nowIso();
    info.current_step = null;
    finishRun(r);
    return;
  }
  const step = info.steps[idx];
  step.state = "running";
  step.started = nowIso();
  info.current_step = idx;
  if (job) {
    job.detail.active_run = info;
    job.detail.stages.forEach((s) => {
      s.state = s.key === STEP_STAGE[step.name] ? "running" : job.baseStates[s.key];
    });
  }
  emitState(r);
  emitLog(r, `$ ${step.command.join(" ")}`);
  const lines = fakeLines(step.name);
  let i = 0;
  const t0 = Date.now();
  const tick = () => {
    if (r.failAt !== null && i === r.failAt) {
      emitLog(r, "ERROR: mock mode has no pipeline to run for a new job (start the real server).");
      emitLog(r, `[exit 1 in ${((Date.now() - t0) / 1000).toFixed(1)}s]`);
      step.state = "failed";
      step.exit_code = 1;
      step.ended = nowIso();
      info.steps.slice(idx + 1).forEach((s) => {
        if (s.state === "queued") s.state = "cancelled";
      });
      info.state = "failed";
      info.error = `step ${step.name} exited with code 1`;
      info.ended = nowIso();
      info.current_step = null;
      finishRun(r);
      return;
    }
    if (i < lines.length) {
      emitLog(r, lines[i]);
      i += 1;
      r.timer = window.setTimeout(tick, 380);
      return;
    }
    emitLog(r, `[exit 0 in ${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    step.state = "done";
    step.exit_code = 0;
    step.ended = nowIso();
    r.timer = window.setTimeout(() => advance(r), 300);
  };
  r.timer = window.setTimeout(tick, 400);
}

function runningRun(): MockRun | null {
  for (const r of runs.values()) if (r.info.state === "running") return r;
  return null;
}
function startNext(): void {
  if (runningRun()) return;
  const next = [...runs.values()].filter((r) => r.info.state === "queued").sort((a, b) => a.info.created.localeCompare(b.info.created))[0];
  if (!next) return;
  next.info.state = "running";
  next.info.started = nowIso();
  advance(next);
}

function newRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `r${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${hex}`;
}

function startRun(jobId: string, body: Record<string, unknown>): RunInfo {
  const job = getJob(jobId);
  const action = body.action as RunAction;
  const valid: RunAction[] = ["prepare", "ingest", "transcribe", "diarize", "sentences", "select", "reframe", "render", "produce", "proxy"];
  if (!valid.includes(action)) throw new ApiError(400, "bad_action", `Unknown action "${String(action)}"`);
  if (job.detail.active_run) throw new ApiError(409, "busy", "This job already has a queued or running run.", { run: job.detail.active_run });
  const needsPaid = action === "select" || (action === "produce" && job.baseStates.select !== "done");
  if (needsPaid && body.confirm_paid !== true) {
    throw new ApiError(402, "paid_confirmation_required", "Clip selection uses the Anthropic API (PAID). Confirm the estimate first.", {
      estimate: estimateFor(String(body.judge_model ?? "sonnet"), Number(body.top ?? 10)),
    });
  }
  const id = newRunId();
  const info: RunInfo = {
    id,
    job_id: jobId,
    action,
    params: { ...body },
    state: "queued",
    created: nowIso(),
    started: null,
    ended: null,
    steps: stepPlan(job, action, body),
    current_step: null,
    log_url: `/api/runs/${id}/log`,
    stream_url: `/api/runs/${id}/stream`,
    error: null,
  };
  const r: MockRun = { info, lines: [], subs: new Set(), timer: undefined, failAt: job.detail.stages[0].state === "done" ? null : 3 };
  runs.set(id, r);
  job.detail.active_run = info;
  startNext();
  return clone(info);
}

function cancelRun(id: string): RunInfo {
  const r = runs.get(id);
  if (!r) throw new ApiError(404, "not_found", `No run "${id}"`);
  if (r.info.state !== "running" && r.info.state !== "queued") throw new ApiError(409, "not_active", "Run is not active.");
  window.clearTimeout(r.timer);
  r.info.steps.forEach((s) => {
    if (s.state === "running" || s.state === "queued") {
      s.state = "cancelled";
      s.ended = nowIso();
    }
  });
  emitLog(r, "[cancelled by user]");
  r.info.state = "cancelled";
  r.info.ended = nowIso();
  r.info.current_step = null;
  finishRun(r);
  return clone(r.info);
}

export function mockSubscribe(runId: string, h: StreamHandlers): () => void {
  const r = runs.get(runId);
  if (!r) {
    h.onConnection("closed");
    return () => undefined;
  }
  h.onConnection("open");
  h.onOpen();
  r.lines.forEach((l) => h.onLog(l));
  h.onState(clone(r.info));
  if (r.info.state !== "running" && r.info.state !== "queued") {
    h.onConnection("closed");
    h.onEnd();
    return () => undefined;
  }
  r.subs.add(h);
  return () => {
    r.subs.delete(h);
  };
}

// ---------------------------------------------------------------- estimate / system

function estimateFor(judge: string, top: number): Estimate {
  const perJudge: Record<string, number> = { haiku: 0.004, sonnet: 0.016, opus: 0.034 };
  const judgeCalls = Math.max(3, Math.min(top, 12));
  const usd = Math.round((0.02 + judgeCalls * (perJudge[judge] ?? 0.016) + 3 * (perJudge[judge] ?? 0.016)) * 100) / 100;
  return {
    usd,
    proposal_calls: 2,
    judge_calls: judgeCalls,
    input_tokens: 33040,
    judge_model: judge,
    raw: [
      "[mock] select_clips.py --dry-run (no API call)",
      "Wrote selection/prompt_window01.txt, selection/prompt_fullpass.txt",
      `2 proposal calls (33040 input tokens)`,
      `~${judgeCalls} judge calls + 3 rerank passes (${judge})`,
      `Estimated cost: ~$${usd.toFixed(2)}`,
    ].join("\n"),
  };
}

function system(): SystemInfo {
  const running = runningRun();
  const queued = [...runs.values()].filter((r) => r.info.state === "queued").map((r) => clone(r.info));
  const byJob = [...jobs.values()].filter((j) => j.detail.cost_usd > 0).map((j) => ({ job_id: j.detail.id, usd: j.detail.cost_usd }));
  return {
    version: "0.1.0-mock",
    root: "C:\\Users\\you\\VideoClipper",
    jobs_dir: "C:\\Users\\you\\VideoClipper\\data\\jobs",
    tools: {
      ffmpeg: { ok: true, version: "7.1" },
      ffprobe: { ok: true, version: "7.1" },
      "yt-dlp": { ok: true, version: "2026.10.30" },
      deno: { ok: true, version: "2.5.4" },
      python: { ok: true, version: "3.12.7" },
      node: { ok: true, version: "25.5.0" },
    },
    keys: { anthropic: true, hf: false, elevenlabs: false },
    assets: { yunet: true, lrasd: true, fonts: true },
    queue: { running: running ? clone(running.info) : null, queued },
    spend: { total_usd: byJob.reduce((a, b) => a + b.usd, 0), by_job: byJob },
  };
}

// ---------------------------------------------------------------- create job

function deriveId(source: string): string {
  const yt = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(source);
  if (yt) {
    const v = yt[1].toLowerCase();
    return v.startsWith("-") ? `yt-${v}` : v;
  }
  const stem = source.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "job";
  return stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 64) || "job";
}

function createJob(body: Record<string, unknown>): { job: JobSummary; run: RunInfo } {
  const source = typeof body.source === "string" ? body.source.trim() : "";
  if (!/^https?:\/\//i.test(source) && !/^([A-Za-z]:[\\/]|\/|\\\\)/.test(source)) {
    throw new ApiError(400, "bad_source", "Source must be an http(s) URL or an existing local file path.");
  }
  const id = typeof body.id === "string" && body.id ? body.id : deriveId(source);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new ApiError(400, "bad_id", "Job id must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  if (jobs.has(id)) throw new ApiError(409, "exists", `Job "${id}" already exists.`, { job_id: id });
  const labels: Record<StageKey, string> = {
    ingest: "Ingest", transcribe: "Transcribe", diarize: "Diarize", sentences: "Sentences", select: "Select clips", reframe: "Reframe", render: "Render",
  };
  const stages: Stage[] = (Object.keys(labels) as StageKey[]).map((key) => ({ key, label: labels[key], state: "missing", updated: null, note: null, outputs: [] }));
  const t = nowIso();
  const detail: JobDetail = {
    id, title: source.split(/[\\/]/).pop() ?? id, channel: null, source, duration: null, height: null, fps: null,
    created: t, updated: t, thumbnail_url: null, stages,
    clips: { candidates: 0, approved: 0, rejected: 0, pending: 0, reframed: 0, rendered: 0, failed_checks: 0 },
    cost_usd: 0, active_run: null, warnings: [], meta: null, probe: null, heatmap: [], chapters: [], source_media: null, info: null, speakers: [],
  };
  const data: JobData = { detail, transcript: null, selection: null, plans: {}, captions: {}, files: [], baseStates: baseStates(detail), edits: {} };
  jobs.set(id, data);
  const run = startRun(id, { action: "prepare", language: body.language, speakers: body.speakers });
  return { job: summary(detail), run };
}

// ---------------------------------------------------------------- clip edits (UI_SPEC 5b)

function validateEdits(ctx: EditContext, e: Edits): void {
  const bad = (msg: string) => {
    throw new ApiError(400, "bad_param", msg);
  };
  if (e.version !== 1) bad("version must be 1");
  if (e.trim) {
    const { cut_in, cut_out } = e.trim;
    if (!(cut_in >= 0 && cut_out <= ctx.limits.source_duration)) bad("trim must lie inside the source");
    if (!(cut_in < cut_out)) bad("cut_in must be before cut_out");
    const len = cut_out - cut_in;
    if (len < ctx.limits.min_s || len > ctx.limits.max_s) bad(`clip length must be ${ctx.limits.min_s}-${ctx.limits.max_s} s`);
  }
  if (e.captions.size < 64 || e.captions.size > 110) bad("caption size must be 64-110");
  if (e.hook.seconds <= 0 || e.hook.seconds > 15) bad("hook seconds must be 0-15");
  for (const sh of e.shots) {
    if (sh.layout === "GROUP" && sh.crop && Math.abs(sh.crop.w / sh.crop.h - 9 / 16) > 0.01 * (9 / 16)) bad("GROUP crop must be 9:16");
  }
}

function putEdits(job: JobData, cid: string, e: Edits): EditContext {
  const ctx = job.edits[cid];
  const cand = job.selection?.candidates.find((c) => c.id === cid);
  if (!ctx || !cand) throw new ApiError(404, "not_found", `No clip "${cid}"`);
  if (job.detail.active_run) throw new ApiError(409, "busy", "A run for this job is queued or running.");
  validateEdits(ctx, e);
  const cutIn = e.trim?.cut_in ?? ctx.original.cut_in;
  const cutOut = e.trim?.cut_out ?? ctx.original.cut_out;
  const pr = ctx.plan_range;
  const inside = !!pr && cutIn >= pr.cut_in - 1e-3 && cutOut <= pr.cut_out + 1e-3;
  ctx.edits = clone(e);
  ctx.needs = inside ? ["render"] : ["reframe", "render"];
  cand.cut_in = cutIn;
  cand.cut_out = cutOut;
  cand.duration = Math.round((cutOut - cutIn) * 1000) / 1000;
  cand.title = e.title ?? ctx.original.title;
  cand.on_screen_hook = e.hook.text;
  cand.render = { ...cand.render, state: "stale" };
  if (!inside) cand.reframe = { ...cand.reframe, state: "stale" };
  return clone(ctx);
}

function resetEdits(job: JobData, cid: string): EditContext {
  const ctx = job.edits[cid];
  const cand = job.selection?.candidates.find((c) => c.id === cid);
  if (!ctx || !cand) throw new ApiError(404, "not_found", `No clip "${cid}"`);
  if (job.detail.active_run) throw new ApiError(409, "busy", "A run for this job is queued or running.");
  ctx.edits = { version: 1, trim: null, shots: [], words: {}, hook: { text: ctx.original.hook, enabled: true, seconds: 3 }, captions: { enabled: true, position: "auto", size: 84 }, title: null };
  ctx.needs = ["render"];
  cand.cut_in = ctx.original.cut_in;
  cand.cut_out = ctx.original.cut_out;
  cand.duration = Math.round((ctx.original.cut_out - ctx.original.cut_in) * 1000) / 1000;
  cand.title = ctx.original.title;
  cand.on_screen_hook = ctx.original.hook;
  cand.render = { ...cand.render, state: "stale" };
  return clone(ctx);
}

// ---------------------------------------------------------------- router

export async function mockRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  const url = new URL(path, window.location.origin);
  const p = url.pathname;
  const method = opts.method ?? "GET";
  const body = (opts.body ?? {}) as Record<string, unknown>;
  await delay(p.endsWith("/estimate") ? 900 : 120 + Math.random() * 160);
  const out = (v: unknown) => clone(v) as T;
  let m: RegExpExecArray | null;

  if (p === "/api/health") return out({ ok: true, version: "0.1.0-mock" });
  if (p === "/api/system") return out(system());
  if (p === "/api/jobs" && method === "GET") {
    return out([...jobs.values()].map((j) => summary(j.detail)).sort((a, b) => b.updated.localeCompare(a.updated)));
  }
  if (p === "/api/jobs" && method === "POST") return out(createJob(body));
  if (p === "/api/runs") {
    const job = url.searchParams.get("job");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return out([...runs.values()].map((r) => r.info).filter((r) => !job || r.job_id === job).sort((a, b) => b.created.localeCompare(a.created)).slice(0, limit));
  }
  if ((m = /^\/api\/runs\/([^/]+)$/.exec(p))) {
    const r = runs.get(m[1]);
    if (!r) throw new ApiError(404, "not_found", `No run "${m[1]}"`);
    return out(r.info);
  }
  if ((m = /^\/api\/runs\/([^/]+)\/log$/.exec(p))) {
    const r = runs.get(m[1]);
    if (!r) throw new ApiError(404, "not_found", `No run "${m[1]}"`);
    const text = r.lines.join("\n") + (r.lines.length ? "\n" : "");
    return out({ text, offset: text.length, done: r.info.state !== "running" && r.info.state !== "queued" });
  }
  if ((m = /^\/api\/runs\/([^/]+)\/cancel$/.exec(p)) && method === "POST") return out(cancelRun(m[1]));

  if ((m = /^\/api\/jobs\/([a-z0-9][a-z0-9_-]{0,63})(\/.*)?$/.exec(p))) {
    const job = getJob(m[1]);
    const rest = m[2] ?? "";
    if (rest === "") return out(job.detail);
    if (rest === "/transcript") {
      if (!job.transcript) throw new ApiError(404, "not_found", "No sentences.json or transcript.json yet.");
      return out(job.transcript);
    }
    if (rest === "/selection") {
      if (!job.selection) throw new ApiError(404, "not_found", "No candidates.json yet: run clip selection.");
      return out(job.selection);
    }
    if (rest === "/files") return out(job.files);
    if (rest === "/estimate") return out(estimateFor(url.searchParams.get("judge_model") ?? "sonnet", Number(url.searchParams.get("top") ?? 10)));
    if (rest === "/runs" && method === "POST") return out(startRun(job.detail.id, body));
    let c: RegExpExecArray | null;
    if ((c = /^\/candidates\/([a-z0-9_-]{1,32})$/.exec(rest)) && method === "PATCH") {
      const cand = job.selection?.candidates.find((x) => x.id === c![1]);
      if (!cand) throw new ApiError(404, "not_found", `No clip "${c[1]}"`);
      const v = body.approved;
      if (v !== true && v !== false && v !== null) throw new ApiError(400, "bad_value", "approved must be true, false or null");
      (cand as Candidate).approved = v;
      recount(job);
      return out(cand);
    }
    if ((c = /^\/clips\/([a-z0-9_-]{1,32})\/reframe$/.exec(rest))) {
      const plan = job.plans[c[1]];
      if (!plan) throw new ApiError(404, "not_found", `No reframe plan for ${c[1]}`);
      return out(plan);
    }
    if ((c = /^\/clips\/([a-z0-9_-]{1,32})\/edits$/.exec(rest))) {
      const cid = c[1];
      if (method === "GET") {
        const ctx = job.edits[cid];
        if (!ctx) throw new ApiError(404, "not_found", `No clip "${cid}"`);
        return out(ctx);
      }
      if (method === "PUT") return out(putEdits(job, cid, body as unknown as Edits));
      if (method === "DELETE") return out(resetEdits(job, cid));
    }
    if ((c = /^\/clips\/([a-z0-9_-]{1,32})\/captions$/.exec(rest))) {
      const cap = job.captions[c[1]];
      if (!cap) throw new ApiError(404, "not_found", `No captions for ${c[1]}`);
      return out(cap);
    }
  }
  throw new ApiError(404, "not_found", `Mock has no route for ${method} ${p}`);
}
