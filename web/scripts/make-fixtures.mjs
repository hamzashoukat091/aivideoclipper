#!/usr/bin/env node
/**
 * Builds the dev-only mock fixtures (VITE_MOCK=1) from a REAL job folder, shaped exactly like the API types
 * in docs/UI_SPEC.md section 4. Read-only on data/: it never writes into the job folder.
 *
 *   node scripts/make-fixtures.mjs [job_id=test_fallon]
 *
 * Writes web/src/api/fixtures/*.json and, if ffmpeg is on PATH, web/.mock-cache/<job>/{thumb.jpg,posters/*.jpg}.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, "..");
const ROOT = resolve(WEB, "..");
const JOB = process.argv[2] ?? "test_fallon";
const DIR = join(ROOT, "data", "jobs", JOB);
const OUT = join(WEB, "src", "api", "fixtures");
const CACHE = join(WEB, ".mock-cache", JOB);

if (!existsSync(join(DIR, "meta.json"))) {
  console.error(`No job at ${DIR}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const readJson = (p, fallback = null) => {
  const f = join(DIR, p);
  if (!existsSync(f)) return fallback;
  return JSON.parse(readFileSync(f, "utf-8").replace(/^\uFEFF/, ""));
};
const readText = (p) => (existsSync(join(DIR, p)) ? readFileSync(join(DIR, p), "utf-8").replace(/^\uFEFF/, "") : null);
const iso = (ms) => new Date(ms).toISOString();
const media = (p) => `/media/${JOB}/${p}`;

// ---------- files ----------
const KIND = {
  mp4: "video", mkv: "video", webm: "video", mov: "video",
  wav: "audio", m4a: "audio", mp3: "audio", aac: "audio",
  json: "json", txt: "text", log: "text", md: "text",
  ass: "subtitle", srt: "subtitle", vtt: "subtitle",
  jpg: "image", jpeg: "image", png: "image", webp: "image",
};
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(DIR, full).split("\\").join("/");
    if (rel === "ui" || rel.startsWith("ui/")) continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else {
      const ext = name.split(".").pop().toLowerCase();
      out.push({ path: rel, size: st.size, mtime: iso(st.mtimeMs), kind: KIND[ext] ?? "other", url: media(rel) });
    }
  }
  return out;
}
const files = walk(DIR).sort((a, b) => a.path.localeCompare(b.path));
const fileMap = new Map(files.map((f) => [f.path, f]));
const has = (p) => fileMap.has(p);
const mtime = (p) => (fileMap.get(p)?.mtime ?? null);
const outputsWhere = (pred) => files.filter((f) => pred(f.path));

// ---------- core data ----------
const meta = readJson("meta.json");
const probe = readJson("probe.json");
const info = readJson("info.json");
const heatmap = readJson("heatmap.json", []);
const chapters = readJson("chapters.json", []);
const sentences = readJson("sentences.json", []);
const words = readJson("words.json");
const transcriptRaw = readJson("transcript.json");
const diar = readJson("diarization.json");
const cost = readJson("selection/cost.json");
const rawCands = readJson("candidates.json", []);
const judged = readJson("selection/judged.json", []);
const reviewMd = readText("review.md");

const near = (a, b) => Math.abs(a - b) <= 0.01;

function sentenceText(c) {
  const parts = sentences.slice(c.start_sentence, c.end_sentence + 1).map((s) => s.text);
  if (parts.length && c.start_word_offset) parts[0] = parts[0].split(/\s+/).slice(c.start_word_offset).join(" ");
  return parts.join(" ");
}

const plans = {};
const reports = {};
const captions = {};

function parseAssTime(t) {
  const [h, m, s] = t.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
function parseAss(text) {
  const events = [];
  let fmt = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("Format:") && fmt === null && text.indexOf("[Events]") < text.indexOf(line)) {
      fmt = line.slice(7).split(",").map((s) => s.trim());
      continue;
    }
    if (!line.startsWith("Dialogue:")) continue;
    const cols = fmt ?? ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
    const body = line.slice(9).trim();
    const parts = body.split(",");
    const head = parts.slice(0, cols.length - 1);
    const raw = parts.slice(cols.length - 1).join(",");
    const get = (k) => head[cols.indexOf(k)]?.trim() ?? "";
    const marked = raw.replace(/\{\\1c&H00E5FF&\}/g, "\u0001").replace(/\{[^}]*\}/g, "").replace(/\\N/g, " ");
    const toks = marked.split(/\s+/).filter(Boolean);
    let active = null;
    toks.forEach((w, i) => {
      if (w.includes("\u0001")) active = i;
    });
    const style = get("Style");
    const layer = Number(get("Layer"));
    events.push({
      start: parseAssTime(get("Start")),
      end: parseAssTime(get("End")),
      text: toks.join(" ").split("\u0001").join(""),
      active: style === "Hook" ? null : active,
      kind: layer === 1 && style === "Hook" ? "hook" : "caption",
    });
  }
  return events;
}

const candidates = rawCands.map((c) => {
  const plan = readJson(`reframe/${c.id}.json`);
  const report = readJson(`renders/${c.id}.report.json`);
  if (plan) plans[c.id] = plan;
  const ass = readText(`captions/${c.id}.ass`);
  if (ass !== null) captions[c.id] = { events: parseAss(ass), url: media(`captions/${c.id}.ass`) };
  const reState = plan ? (near(plan.cut_in, c.cut_in) && near(plan.cut_out, c.cut_out) ? "done" : "stale") : "missing";
  let rnState = "missing";
  if (report && has(`renders/${c.id}.mp4`)) {
    reports[c.id] = report;
    const [a, b] = report.source_range;
    rnState = !(near(a, c.cut_in) && near(b, c.cut_out)) ? "stale" : Object.values(report.checks).every(Boolean) ? "done" : "failed";
  }
  return {
    ...c,
    text: sentenceText(c),
    reframe: {
      state: reState,
      url: plan ? media(`reframe/${c.id}.json`) : null,
      preview_url: has(`reframe/${c.id}_preview.mp4`) ? media(`reframe/${c.id}_preview.mp4`) : null,
      qa: plan?.qa ?? null,
      layouts: plan ? [...new Set(plan.shots.map((s) => s.layout))] : [],
    },
    render: {
      state: rnState,
      video_url: rnState !== "missing" ? media(`renders/${c.id}.mp4`) : null,
      download_url: rnState !== "missing" ? `${media(`renders/${c.id}.mp4`)}?download=1` : null,
      poster_url: rnState !== "missing" ? `/api/jobs/${JOB}/clips/${c.id}/poster` : null,
      report: report ?? null,
      captions_url: ass !== null ? media(`captions/${c.id}.ass`) : null,
    },
  };
});

const live = candidates.filter((c) => c.approved !== false);
function aggregate(key) {
  if (!live.length) return "missing";
  const states = live.map((c) => c[key].state);
  if (key === "render" && states.includes("failed")) return "failed";
  if (states.includes("stale")) return "stale";
  if (states.every((s) => s === "done")) return "done";
  if (states.some((s) => s === "done")) return "partial";
  return "missing";
}

const stageDefs = [
  ["ingest", "Ingest", has("meta.json") && has("probe.json") ? "done" : "missing",
    (p) => /^(meta|probe|info|heatmap|chapters)\.json$|^source\.|^audio16k\.wav$/.test(p), "meta.json"],
  ["transcribe", "Transcribe", has("transcript.json") ? "done" : "missing", (p) => p === "transcript.json", "transcript.json"],
  ["diarize", "Diarize", has("diarization.json") ? "done" : has("words.json") ? "skipped" : "missing",
    (p) => p === "diarization.json" || p === "words.json", "words.json"],
  ["sentences", "Sentences", has("sentences.json") ? "done" : "missing", (p) => p === "sentences.json", "sentences.json"],
  ["select", "Select clips", has("candidates.json") ? "done" : "missing",
    (p) => p === "candidates.json" || p === "review.md" || p.startsWith("selection/"), "candidates.json"],
  ["reframe", "Reframe", aggregate("reframe"), (p) => p.startsWith("reframe/"), null],
  ["render", "Render", aggregate("render"), (p) => p.startsWith("renders/") || p.startsWith("captions/"), null],
];
const notes = {
  ingest: `${probe?.width}×${probe?.height} ${probe?.vcodec} · ${Math.round(meta.duration)} s${meta.has_heatmap ? " · heatmap" : ""}`,
  transcribe: transcriptRaw ? `${transcriptRaw.model} · RTF ${transcriptRaw.rtf} · ${words?.words.length ?? 0} words` : null,
  diarize: diar ? `${diar.speakers.length} speakers` : "No HF_TOKEN — speakers not labelled",
  sentences: `${sentences.length} sentences`,
  select: cost ? `$${cost.total_usd.toFixed(2)} spent · ${candidates.length} candidates` : `${candidates.length} candidates`,
  reframe: `${live.filter((c) => c.reframe.state === "done").length}/${live.length} clips`,
  render: `${live.filter((c) => c.render.state === "done").length}/${live.length} clips · all checks pass`,
};
const stages = stageDefs.map(([key, label, state, pred, main]) => {
  const outputs = outputsWhere(pred);
  const times = outputs.map((f) => f.mtime).sort();
  return { key, label, state, updated: main ? mtime(main) : (times.at(-1) ?? null), note: notes[key] ?? null, outputs };
});

const allTimes = files.map((f) => f.mtime).sort();
const clips = {
  candidates: candidates.length,
  approved: candidates.filter((c) => c.approved === true).length,
  rejected: candidates.filter((c) => c.approved === false).length,
  pending: candidates.filter((c) => c.approved === null).length,
  reframed: candidates.filter((c) => c.reframe.state === "done").length,
  rendered: candidates.filter((c) => c.render.state === "done" || c.render.state === "failed").length,
  failed_checks: candidates.filter((c) => c.render.state === "failed").length,
};
const warnings = [...(meta.warnings ?? [])];
if (!diar) warnings.push("No HF_TOKEN: speakers unlabelled");

const summary = {
  id: JOB,
  title: meta.title,
  channel: meta.channel ?? null,
  source: meta.source,
  duration: meta.duration ?? null,
  height: meta.height ?? probe?.height ?? null,
  fps: probe?.fps ?? null,
  created: mtime("meta.json") ?? allTimes[0],
  updated: allTimes.at(-1),
  thumbnail_url: `/api/jobs/${JOB}/thumbnail`,
  stages,
  clips,
  cost_usd: cost?.total_usd ?? 0,
  active_run: null,
  warnings,
};
const ext = meta.media.split(".").pop().toLowerCase();
const detail = {
  ...summary,
  meta,
  probe,
  heatmap,
  chapters,
  source_media: {
    url: `/media/${JOB}/source`,
    playable_hint: ["mp4", "webm"].includes(ext) && ["h264", "vp9", "av1"].includes(probe?.vcodec),
    proxy_url: null,
  },
  info: info
    ? { webpage_url: info.webpage_url, upload_date: info.upload_date, view_count: info.view_count, thumbnail: info.thumbnail }
    : null,
  speakers: diar?.speakers ?? [],
};

const transcript = {
  language: words?.language ?? transcriptRaw?.language ?? null,
  model: words?.asr_model ?? transcriptRaw?.model ?? null,
  sentences: sentences.map(({ i, start, end, speaker, text, heat, loud_z, pause_before, pause_after }) => ({
    i, start, end, speaker, text, heat, loud_z, pause_before, pause_after,
  })),
  word_count: words?.words.length ?? 0,
};

const rejected_by_judge = judged
  .filter((j) => j.judge?.verdict === "reject")
  .map((j) => {
    const s0 = j.judge?.start_sentence ?? j.start_sentence;
    const s1 = j.judge?.end_sentence ?? j.end_sentence;
    return {
      id: j.id,
      title: j.judge?.title ?? j.title,
      start_sentence: Number.isInteger(s0) && sentences[s0] ? s0 : null,
      end_sentence: Number.isInteger(s1) && sentences[s1] ? s1 : null,
      start: sentences[s0]?.start ?? null,
      end: sentences[s1]?.end ?? null,
      overall: j.judge?.overall ?? null,
      reason: j.judge?.reason ?? null,
      source: j.source,
    };
  });
const selection = { candidates, rejected_by_judge, cost, review_md: reviewMd };

// A real historical run, built from the actual selection log (select is never run by the mock).
const selLog = readText("selection/run.log");
const runs = [];
if (selLog) {
  const ended = Date.parse(mtime("selection/run.log"));
  const cmd = ["python", "-W", "ignore", "clipper/select_clips.py", "--id", JOB, "--top", "10", "--judge-model", "opus"];
  runs.push({
    info: {
      id: "r20261117-001300-a1f0",
      job_id: JOB,
      action: "select",
      params: { judge_model: "opus", top: 10, confirm_paid: true },
      state: "done",
      created: iso(ended - 44000),
      started: iso(ended - 43000),
      ended: iso(ended),
      steps: [{ name: "select", command: cmd, state: "done", started: iso(ended - 43000), ended: iso(ended), exit_code: 0 }],
      current_step: null,
      log_url: `/api/runs/r20261117-001300-a1f0/log`,
      stream_url: `/api/runs/r20261117-001300-a1f0/stream`,
      error: null,
    },
    log: `$ ${cmd.join(" ")}\n${selLog.trim()}\n[exit 0 in 42.0s]\n`,
  });
}

// Default EditContext per clip (UI_SPEC 5b): no edits file yet, words +-10 s around the cut.
const allWords = (words?.words ?? []).map((w, i) => ({ i, w: w.w, start: w.start, end: w.end })).filter((w) => typeof w.start === "number" && typeof w.end === "number");
const editsCtx = {};
for (const c of rawCands) {
  const plan = plans[c.id];
  editsCtx[c.id] = {
    edits: {
      version: 1,
      trim: null,
      shots: [],
      words: {},
      hook: { text: c.on_screen_hook, enabled: true, seconds: 3 },
      captions: { enabled: true, position: "auto", size: 84 },
      title: null,
    },
    original: { cut_in: c.cut_in, cut_out: c.cut_out, title: c.title, hook: c.on_screen_hook },
    words: allWords.filter((w) => w.end > c.cut_in - 10 && w.start < c.cut_out + 10),
    limits: { min_s: 3, max_s: 180, source_duration: meta.duration },
    plan_range: plan ? { cut_in: plan.cut_in, cut_out: plan.cut_out } : null,
    needs: [],
  };
}

const write = (name, data) => writeFileSync(join(OUT, name), JSON.stringify(data, null, 1) + "\n");
write("job.json", detail);
write("transcript.json", transcript);
write("selection.json", selection);
write("reframe.json", plans);
write("captions.json", captions);
write("files.json", files);
write("runs.json", runs);
write("edits.json", editsCtx);
console.log(`fixtures: ${OUT} (${candidates.length} candidates, ${files.length} files, ${sentences.length} sentences)`);

// ---------- optional images for the mock media middleware ----------
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  mkdirSync(join(CACHE, "posters"), { recursive: true });
  const thumb = join(CACHE, "thumb.jpg");
  if (!existsSync(thumb)) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String((meta.duration ?? 10) * 0.2), "-i", meta.media,
      "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", thumb]);
  }
  for (const c of candidates) {
    const src = join(DIR, "renders", `${c.id}.mp4`);
    const out = join(CACHE, "posters", `${c.id}.jpg`);
    if (existsSync(src) && !existsSync(out)) {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "1.0", "-i", src, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", out]);
    }
  }
  console.log(`mock images: ${CACHE}`);
} catch {
  console.log("ffmpeg not available: mock thumbnails/posters skipped (UI shows placeholders)");
}
