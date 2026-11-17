# VideoClipper Studio — UI spec (single source of truth for `server/` and `web/`)

A local app to drive and inspect the clip pipeline in `clipper/`. Written 2026-11-17. Backend and frontend are
built in parallel from this document; **if code and spec disagree, the spec wins** — change the spec first.

## 0. Principles (from the user's brief)
- **Transparent**: the user sees everything the pipeline does and has done: every stage's state, the exact command
  it ran, live logs, every intermediate file, costs, QA checks, warnings. Nothing hidden behind a spinner.
  (Assumption, recorded: "full transparent" = process transparency, not a see-through visual style.)
- **Simple, clean**: a professional developer tool (Linear / Vercel / Figma-tool feel). Dark first, one accent.
- **Room for features**: feature modules plug into a registry (frontend) and a router per feature (backend).
- **Never surprise-spend money**: the only PAID action is clip selection (Anthropic API). It always shows a free
  estimate first and needs an explicit confirm; the backend refuses it without `confirm_paid: true`.
- **No destructive actions** in v1: no delete of jobs or files. Approve/reject only edits `candidates.json`.
- Local only: server binds `127.0.0.1`. Secrets (API keys) are never sent to the browser — only booleans.

## 1. Architecture
```
server/                      Python 3.12, FastAPI + uvicorn, runs in the project .venv
  __main__.py                `.venv/Scripts/python -m server [--port 8765] [--dev]` -> serves API + web/dist
  app.py                     FastAPI app factory create_app(root: Path) (root = project root; testable)
  jobs.py                    reads data/jobs/<id>/ into the JSON shapes below (pure functions, no subprocess)
  runner.py                  run queue: ONE pipeline process at a time (CPU-bound), logs, cancel
  media.py                   file serving with HTTP Range, thumbnails/posters (ffmpeg), zip export
  tests/                     pytest, uses a temp copy of a fake job dir; no network, no paid calls
web/                         React 18 + TypeScript + Vite; built to web/dist (served by the server)
docs/UI_SPEC.md              this file
```
Dev: `npm run dev` in `web/` on 5173 proxies `/api` and `/media` to `127.0.0.1:8765`.
Prod: `npm run build` then `python -m server` serves everything on `http://127.0.0.1:8765`.

## 2. Job folder facts (what exists on disk)  — `data/jobs/<id>/`
| File | Written by | Meaning |
|---|---|---|
| `meta.json` | ingest | `{source, media, title, channel, duration, expected_height, height, height_ok, has_heatmap, chapters, warnings[]}` |
| `probe.json` | ingest | `{width,height,rotation,fps,fps_exact,fps_render,avg_fps,likely_vfr,vcodec,pix_fmt,color_transfer,hdr,acodec,sample_rate,channels,duration,bit_rate}` |
| `info.json` | ingest (URL only) | raw yt-dlp metadata (large). Use only for `thumbnail` (URL), `upload_date`, `view_count`, `webpage_url`. |
| `heatmap.json` | ingest | `[{start,end,value}]` (value 0..1) or `[]` |
| `chapters.json` | ingest | `[{start,end,title}]` |
| `source.<ext>` | ingest | master video (mkv/webm/mp4). Local-file jobs: `meta.media` points elsewhere. |
| `audio16k.wav` | ingest | analysis audio (don't serve in UI except via files list) |
| `transcript.json` | transcribe | `{model,language,audio_seconds,runtime_seconds,rtf,untimed_words,segments[],words[]}` |
| `diarization.json` | diarize | `{model,runtime_seconds,speakers:[{id,seconds,share}],turns[],exclusive[]}` — may not exist (no HF token) |
| `words.json` | diarize (also without token) | `{language,asr_model,diarization,unlabelled_words,words:[{w,start,end,score,timed,speaker}]}` |
| `sentences.json` | sentences | `[{i,start,end,speaker,text,w0,w1,heat,loud_z,pause_before,pause_after}]` |
| `selection/cost.json` | select | `{models:{<model>:{calls,input,output,cache_read,usd}}, total_usd}` — the LATEST run only |
| `selection/cost_history.jsonl` | select | one JSON line per paid run `{time, judge_model, models, total_usd}`; `cost_usd` = its sum (fallback cost.json) |
| `selection/proposals.json`, `judged.json`, `rerank.json`, `prompt_*.txt` | select | intermediates |
| `candidates.json` | select | ranked list, see Candidate below. User edits `approved` (true/false/null) |
| `review.md` | select | human review sheet (markdown) |
| `reframe/<cid>.json` | reframe | crop plan, see ReframePlan; `reframe/<cid>_preview.mp4` optional |
| `captions/<cid>.ass` | render | captions source |
| `renders/<cid>.mp4`, `renders/<cid>.report.json` | render | final clip + RenderReport |
| `runs/<run_id>.json`, `runs/<run_id>.log` | **server runner (new)** | run history + full log |
| `ui/thumb.jpg`, `ui/posters/<cid>.jpg`, `ui/source_proxy.mp4` | **server (new)** | UI caches, never used by the pipeline |

## 3. Stages and status rules (backend computes, frontend displays)
Stage keys in order: `ingest, transcribe, diarize, sentences, select, reframe, render`.
- `ingest` done ⇔ `meta.json` and `probe.json` exist.
- `transcribe` done ⇔ `transcript.json`.
- `diarize`: done ⇔ `diarization.json`; `skipped` ⇔ `words.json` exists without it (note: "No HF_TOKEN — speakers not labelled"); else missing.
- `sentences` done ⇔ `sentences.json`.
- `select` done ⇔ `candidates.json`. Note shows `$<total_usd>` spent if cost.json.
- `reframe`: per clip (non-rejected candidates). done ⇔ every such clip has `reframe/<cid>.json` whose cut_in/cut_out equal the candidate's (±0.01 s); `stale` if any exists with different cuts; `partial` if some missing; missing if none.
- `render`: same rule with `renders/<cid>.mp4` + `report.json` (`report.source_range` vs candidate cuts); `failed` if any report has a false check.
- `running` overrides when the active run's current step is that stage; `failed` when the last run of that stage failed and no output exists.
States: `"done" | "missing" | "stale" | "partial" | "skipped" | "running" | "queued" | "failed"`.

## 4. HTTP API (JSON; errors are `{"error": "<code>", "message": "<human text>", ...extra}` with 4xx/5xx)
Job ids: `^[a-z0-9][a-z0-9_-]{0,63}$`. Clip ids: `^[a-z0-9_-]{1,32}$`. All file paths are resolved and must stay
inside the job folder (reject `..`, absolute paths, symlinks out) → 400 `bad_path`.

### TypeScript shapes (frontend copies these into `web/src/api/types.ts` verbatim; backend returns exactly them)
```ts
export type StageKey = "ingest"|"transcribe"|"diarize"|"sentences"|"select"|"reframe"|"render";
export type StageState = "done"|"missing"|"stale"|"partial"|"skipped"|"running"|"queued"|"failed";
export interface FileEntry { path: string; size: number; mtime: string; kind: "video"|"audio"|"json"|"text"|"image"|"subtitle"|"other"; url: string }
export interface Stage { key: StageKey; label: string; state: StageState; updated: string|null; note: string|null; outputs: FileEntry[] }
export interface ClipCounts { candidates: number; approved: number; rejected: number; pending: number; reframed: number; rendered: number; failed_checks: number }
export interface JobSummary {
  id: string; title: string; channel: string|null; source: string; duration: number|null;
  height: number|null; fps: number|null; created: string; updated: string;
  thumbnail_url: string|null;              // /api/jobs/<id>/thumbnail (server-generated jpg) or null before ingest
  stages: Stage[];                        // always all 7, in order
  clips: ClipCounts; cost_usd: number;     // cost from selection/cost.json, 0 if none
  active_run: RunInfo|null;                // queued or running run for this job
  warnings: string[];                      // meta.warnings + derived (e.g. "No HF_TOKEN: speakers unlabelled")
}
export interface JobDetail extends JobSummary {
  meta: Record<string, unknown>|null; probe: Record<string, unknown>|null;
  heatmap: {start:number; end:number; value:number}[]; chapters: {start:number; end:number; title:string}[];
  source_media: { url: string; playable_hint: boolean; proxy_url: string|null } | null; // playable_hint: mp4/webm with h264/vp9/av1
  info: { webpage_url?: string; upload_date?: string; view_count?: number; thumbnail?: string } | null;
  speakers: {id:string; seconds:number; share:number}[];   // from diarization.json or []
}
export interface Sentence { i:number; start:number; end:number; speaker:string|null; text:string; heat:number|null; loud_z:number; pause_before?:number; pause_after?:number }
export interface Transcript { language: string|null; model: string|null; sentences: Sentence[]; word_count: number }
export interface Scores { hook:number; self_contained:number; payoff:number; ending:number; overall:number }
export interface Candidate {
  rank:number; id:string; approved: boolean|null; start_sentence:number; start_word_offset?:number; end_sentence:number;
  cut_in:number; cut_out:number; duration:number; title:string; on_screen_hook:string; hook_quote:string; category:string;
  why:string; judge_reason:string; scores:Scores; rerank_pos:number; max_heat:number|null; proposed_by:string[]; speakers:string[];
  cut_notes?: string[];                           // e.g. "start moved +0.250s to a camera cut" (clipper/cutsnap.py)
  // added by server:
  text: string;                                   // joined sentence text of the clip
  reframe: { state: StageState; url: string|null; preview_url: string|null; qa: Record<string, unknown>|null; layouts: string[] } ;
  render: { state: StageState; video_url: string|null; download_url: string|null; poster_url: string|null;
            report: RenderReport|null; captions_url: string|null };
}
export interface JudgeRejected { id:string; title:string; start_sentence:number|null; end_sentence:number|null; start:number|null; end:number|null; overall:number|null; reason:string|null; source:string }  // null when judged.json has a missing/out-of-range sentence index
export interface Selection { candidates: Candidate[]; rejected_by_judge: JudgeRejected[]; cost: Record<string, unknown>|null; review_md: string|null }
export interface RenderReport { clip:string; title?:string; source_range:[number,number]; frames_piped:number; frames_planned:number; render_seconds:number; loudness_in: Record<string,string>; output: Record<string, unknown>; checks: Record<string, boolean> }
export interface Shot { f0:number; f1:number; layout:"TRACK"|"GROUP"|"SPLIT"|"FIT"; faces:number; talk_share?:number[]; reason?:string;
  w?:number; h?:number; x?:number[]; speaker_track?:number[]; hard_cuts?:number[]; face_inside?:number;
  crop?:{x:number;y:number;w:number;h:number}; top?:{x:number;y:number;w:number;h:number}; bottom?:{x:number;y:number;w:number;h:number};
  hold_frame?:number }   // clip-relative source frame shown frozen for this whole (edge) shot: a camera cut inside speech
                         // within 0.5 s of the clip edge. The render shows THAT frame with this shot's framing; the UI
                         // overlay draws the crop on the held frame time (seek the source there) and labels it "Held frame".
export interface ReframePlan { clip:string; cut_in:number; cut_out:number; duration:number; fps:string; frames:number; src_w:number; src_h:number; out_w:number; out_h:number; speaker_evidence:string; asd_seconds?:number; analysis_seconds?:number; shots:Shot[]; qa:Record<string, unknown> }
export interface CaptionEvent { start:number; end:number; text:string; active:number|null; kind:"caption"|"hook" }
export interface Captions { events: CaptionEvent[]; url: string }   // url = raw .ass
export type RunAction = "prepare"|"ingest"|"transcribe"|"diarize"|"sentences"|"select"|"reframe"|"render"|"produce"|"proxy";
export interface RunStep { name: string; command: string[]; state: "queued"|"running"|"done"|"failed"|"skipped"|"cancelled"; started: string|null; ended: string|null; exit_code: number|null }
export interface RunInfo { id:string; job_id:string; action:RunAction; params:Record<string, unknown>; state:"queued"|"running"|"done"|"failed"|"cancelled";
  created:string; started:string|null; ended:string|null; steps:RunStep[]; current_step:number|null; log_url:string; stream_url:string; error:string|null }
export interface Estimate { usd:number|null; proposal_calls:number|null; judge_calls:number|null; input_tokens:number|null; judge_model:string; raw:string }
export interface SystemInfo { version:string; root:string; jobs_dir:string;
  tools: Record<string, {ok:boolean; version:string|null}>;            // ffmpeg, ffprobe, yt-dlp, deno, python, node
  keys: { anthropic:boolean; hf:boolean; elevenlabs:boolean };          // presence only, NEVER values
  assets: { yunet:boolean; lrasd:boolean; fonts:boolean };
  queue: { running: RunInfo|null; queued: RunInfo[] };
  spend: { total_usd:number; by_job: {job_id:string; usd:number}[] } }
```

### Endpoints
| Method | Path | Returns / does |
|---|---|---|
| GET | `/api/health` | `{ok:true, version}` |
| GET | `/api/system` | `SystemInfo` (tool versions cached 60 s) |
| GET | `/api/jobs` | `JobSummary[]` sorted by `updated` desc. Folders without `meta.json` and without an active/past run are skipped; `_certs`, names starting `.` or `_` skipped. |
| POST | `/api/jobs` | body `{source:string, id?:string, language?:"en"\|string, speakers?:number, allow_lower?:boolean}` → `{job: JobSummary, run: RunInfo}`; validates source (http(s) URL or existing local file); id default: YouTube video id lower-cased (`yt-<id>` if it starts with `-`), else file stem slug; 409 `exists` if folder already has meta.json. Starts a `prepare` run. |
| GET | `/api/jobs/{id}` | `JobDetail` |
| GET | `/api/jobs/{id}/transcript` | `Transcript` (from sentences.json; fallback: transcript segments as sentences with i=index) |
| GET | `/api/jobs/{id}/selection` | `Selection` |
| PATCH | `/api/jobs/{id}/candidates/{cid}` | body `{approved: true\|false\|null}` → `Candidate`; atomic write of candidates.json (tmp + replace); 409 `busy` if a run for this job is running a select step |
| GET | `/api/jobs/{id}/clips/{cid}/reframe` | `ReframePlan` (404 `not_found`) |
| GET | `/api/jobs/{id}/clips/{cid}/captions` | `Captions` parsed from captions/<cid>.ass (Dialogue lines; strip `{...}` tags; `active` = index of the word wrapped in the `\1c&H00E5FF&` colour tag; layer 1 Hook style → kind "hook") |
| GET | `/api/jobs/{id}/estimate?judge_model=sonnet&top=10` | `Estimate` by running `select_clips.py --dry-run` (free, ~2 s); parse `Estimated cost: ~$X`, `N proposal calls (M input tokens)`, `~K judge calls` |
| GET | `/api/jobs/{id}/files` | `FileEntry[]` recursive (skip `ui/`), sorted by path |
| GET | `/api/jobs/{id}/thumbnail` | jpg (cached `ui/thumb.jpg`; ffmpeg frame at 20% of duration, 640 wide); 404 before ingest |
| GET | `/api/jobs/{id}/clips/{cid}/poster` | jpg (cached `ui/posters/<cid>.jpg`, regenerated if render is newer; frame at 1.0 s, 540 wide) |
| GET | `/api/jobs/{id}/export.zip?clips=c02,c03` | streamed zip: `renders/<cid>.mp4`, `renders/<cid>.report.json`, `captions/<cid>.ass`, `candidates.json`, `review.md` (only existing files); default all rendered clips |
| GET | `/media/{id}/{path}` | raw file inside the job folder with **HTTP Range** (206) support, correct MIME (`.mkv`→`video/x-matroska`, `.mp4`→`video/mp4`, `.ass`→`text/plain; charset=utf-8`, `.md`→`text/markdown; charset=utf-8`); `?download=1` → `Content-Disposition: attachment` with filename `<job>-<file>` |
| GET | `/media/{id}/source` | the master (`meta.media`, may be outside the job folder — allowed only for that exact path) |
| POST | `/api/jobs/{id}/runs` | body `{action: RunAction, clips?:string[], judge_model?:"haiku"\|"sonnet"\|"opus", top?:number, fast?:boolean, preview?:boolean, force?:boolean, confirm_paid?:boolean, language?:string, speakers?:number}` → `RunInfo` (202). `select`, and `produce` when it would select, require `confirm_paid:true` else 402 `{error:"paid_confirmation_required", estimate: Estimate}`. 409 `busy` if this job already has a queued/running run. |
| GET | `/api/runs?job=<id>&limit=50` | `RunInfo[]` newest first (from runs/*.json across jobs) |
| GET | `/api/runs/{run_id}` | `RunInfo` |
| GET | `/api/runs/{run_id}/log?offset=0` | `{text, offset, done}` (bytes from offset; utf-8 with replacement) |
| GET | `/api/runs/{run_id}/stream` | **SSE**: `event: log` `data: <line>` per line (replays existing log first), `event: state` `data: <RunInfo json>` on every state/step change, `event: end` when finished. Heartbeat comment every 15 s. |
| POST | `/api/runs/{run_id}/cancel` | kills the process tree (Windows: `taskkill /PID <pid> /T /F`), marks step + run `cancelled` |

### Run actions → commands (always `[sys.executable, "-W", "ignore", "clipper/<script>.py", ...]`, cwd = root)
- `ingest`: `ingest.py <meta.source or body.source> --id <id> [--allow-lower]`
- `transcribe`: `transcribe.py --id <id> --language <lang>`
- `diarize`: `diarize.py --id <id> [--speakers N]` — **exit code 2 = done with warning** (no HF token), not failure.
- `sentences`: `sentences.py --id <id>`
- `prepare`: ingest → transcribe → diarize → sentences, each skipped (`state:"skipped"`) when its output exists unless `force`.
- `select` (PAID): `select_clips.py --id <id> --top <top=10> --judge-model <judge_model=sonnet>`
- `reframe`: `reframe.py --id <id> --clip <ids...> [--preview]`; default ids = non-rejected candidates whose reframe is missing/stale (or all non-rejected with `force`).
- `render`: `render.py --id <id> --clip <ids...> [--fast]`; default ids = non-rejected candidates whose render is missing/stale/failed (or all with `force`).
- `produce`: prepare (skip done) → select (only if no candidates.json; needs confirm_paid) → reframe → render.
- `proxy`: `ffmpeg -y -i <source> -vf scale=-2:720 -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart ui/source_proxy.mp4` (browser-playable source preview; UI cache only).
Steps with nothing to do are `skipped`. The log file contains, before each step, a header line
`$ <command joined with spaces>` and after it `[exit <code> in <secs>s]`. stdout+stderr merged, unbuffered
(`PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`). Runs are persisted on every change (`runs/<run_id>.json`). On
server start, runs left `running`/`queued` from a crash are marked `failed` with error "server restarted".
Run ids: `r<yyyymmdd-HHMMSS>-<4 hex>`.

## 5. Screens (frontend)
Global shell: left **sidebar** (logo "Clipper Studio", nav: Library, Activity, Settings; below: jobs list with
thumbnail, title, mini stage dots, live run indicator), top **bar** (breadcrumb, global run status pill showing the
running job + step + elapsed, "New job" button, ⌘K command palette). Content area max-width none (tool layout),
panes resizable where noted. Toasts for run start/finish/fail. Keyboard: ⌘K palette, `j/k` next/prev clip in Clips,
space play/pause in players, `a`/`r` approve/reject focused clip.

1. **Library** `/` — grid of job cards (thumbnail 16:9, title, channel, duration, resolution chip, 7-dot stage
   strip with tooltips, clip counts, cost). Empty state with the New job form inline. Search/filter by title.
2. **New job** (dialog) — source input (URL or local path), detected kind + id preview (editable), language,
   speaker count (optional), allow lower quality toggle with explanation. Submit → navigates to the job, run visible.
3. **Job › Overview** `/jobs/:id` — header (title, channel, source link, duration, resolution/fps/codecs chips,
   warnings banner). **Pipeline panel**: 7 stages as a vertical stepper: state badge, note, updated time, output files
   (click → file viewer), per-stage action button (Run / Re-run / disabled with reason), "Run everything" (produce).
   Select stage shows the free estimate and a **PAID confirm dialog** (amount, judge model selector haiku/sonnet/opus
   with one-line trade-offs: haiku too strict in tests; sonnet default; opus best ~2×). Right column: **live run
   console** (SSE) with step list, exact command lines, elapsed timers, cancel, auto-scroll toggle, copy log.
4. **Job › Source** — 16:9 player of the master (`/media/<id>/source`; if it fails to play, offer "Make preview
   copy" → `proxy` run then play `ui/source_proxy.mp4`). Under it: **timeline** showing the YouTube "Most replayed"
   heatmap curve, chapter bands, candidate clip ranges (coloured by approved state), playhead; click to seek.
   Right: **transcript** (sentences with time, speaker chip, heat/loud markers, search, auto-follow playback,
   click to seek; clip ranges highlighted).
5. **Job › Clips** — the review table/list: rank, title, duration, timecodes, category, 4 score bars + overall,
   rerank position, max heat, proposed_by, reframe/render state chips, approve / reject / undecided segmented
   control (PATCH). Expandable row: why, judge reason, hook quote, on-screen hook, full text. Section "Rejected by
   the judge" (from judged.json) with reasons. Cost summary card. Bulk: "Render approved", "Export zip".
6. **Job › Studio** `/jobs/:id/clips/:cid` — the **player view**: left the final 9:16 render (or reframe preview if
   not rendered, or "not rendered yet" with Render button); centre the **source with crop overlay**: the 16:9 source
   synced to the same time, with the crop rectangle(s) for the current frame drawn on top (TRACK: x[f]×w×h; GROUP:
   crop; SPLIT: top+bottom boxes; FIT: whole frame), current layout + speaker evidence label; below both a shared
   **clip timeline**: shot segments coloured by layout, hard cuts, caption chunks track, hook span, playhead,
   in/out times; play/pause/step-frame/loop/speed controls; players stay in sync (render time t ↔ source time
   cut_in + t). Right panel tabs: **Details** (title, hook, scores, why, judge reason; copy buttons),
   **Checks** (RenderReport checks as pass/fail rows + output facts: resolution, fps, frames, bitrate, LUFS, peak,
   render time), **Reframe** (QA metrics, per-shot list with layout, reason, talk share), **Captions** (event list,
   click to seek), **Files** (all files for this clip with view/download). Actions: Re-reframe, Re-render (fast /
   final), Download MP4, Download captions (.ass), Download report, Approve/Reject. Prev/next clip arrows.
7. **Job › Files** — tree of every file with size/mtime/kind; viewer pane: JSON (collapsible, syntax-coloured),
   text/markdown (review.md rendered), video/audio player, image; Download button for each.
8. **Job › Runs** — run history for the job; select a run → steps, commands, exit codes, durations, full log.
9. **Activity** `/activity` — all runs across jobs, queue (running + queued), cancel.
10. **Settings** `/settings` — system checks (tools with versions, keys present ✓/✗ with how to add them in
   `.env` — never an input for the key itself), assets (YuNet, LR-ASD, fonts), spend ledger by job, paths,
   app version. Defaults saved in localStorage: judge model, top N, fast renders, preview reframes.

### Feature registry (room for features)
`web/src/features/registry.ts` exports an array of `{ id, label, icon, route?, jobTab?, commands? }`; the sidebar,
job tabs and ⌘K palette are generated from it. Adding a feature = add a folder under `web/src/features/<name>/`
and one registry entry. Backend: one `APIRouter` per area in `server/routes/` included by `app.py`.

## 5b. Clip editing (added 2026-11-17, user: "after generating clips, I should have a way to adjust things using
proper tools" and "do not make it noisy")
Studio gets an **Edit** toggle. Off = today's review view. On = the same players with editing tools; one tool panel
open at a time; no extra badges or banners. Edits are saved explicitly (Save / Discard), then applied with Render.

**Edits file** `data/jobs/<id>/edits/<cid>.json` (server-owned, atomic writes; the pipeline reads it):
```ts
export interface ShotEdit { at: number;                 // source time (s) inside the shot it applies to (stable key)
  layout: "AUTO"|"TRACK"|"FIXED"|"GROUP"|"SPLIT"|"FIT";  // AUTO = keep the automatic plan for this shot
  x?: number;                                           // FIXED: crop left edge in source px (crop w = h*9/16, full height)
  crop?: {x:number;y:number;w:number;h:number} }        // GROUP: 9:16 crop box in source px
export interface Edits { version: 1;
  trim: { cut_in: number; cut_out: number } | null;     // null = the selection's cut
  shots: ShotEdit[];
  words: Record<string, string>;                        // global word index -> replacement text ("" hides the word)
  hook: { text: string; enabled: boolean; seconds: number };      // defaults: candidate.on_screen_hook, true, 3
  captions: { enabled: boolean; position: "auto"|"upper"|"middle"|"lower"; size: number };  // size px, 64-110, default 84
  title: string | null }                                // null = candidate.title
export interface EditContext { edits: Edits; original: { cut_in:number; cut_out:number; title:string; hook:string };
  words: { i:number; w:string; start:number; end:number }[];   // words from 10 s before cut_in to 10 s after cut_out
  limits: { min_s:number; max_s:number; source_duration:number };
  plan_range: { cut_in:number; cut_out:number } | null;        // range the current reframe plan covers
  needs: ("reframe"|"render")[] }                       // what must run for the saved edits to show in the video
```
**Endpoints**: `GET /api/jobs/{id}/clips/{cid}/edits` → `EditContext` (defaults when no file);
`PUT …/edits` body `Edits` → `EditContext` (validates: trim inside source, 3 s ≤ length ≤ 180 s, cut_in < cut_out;
shots `at` inside the clip; sizes/positions in range; FIXED x / GROUP crop inside the frame, GROUP crop 9:16 ±1%);
`DELETE …/edits` → `EditContext` (back to automatic; restores the selection's cuts and title). 409 `busy` while a
run for this clip is queued/running.
**Apply rules** (server, on PUT/DELETE, via `clipper/edits.py` so the pipeline uses the same code):
- `title` → candidate.title. `trim` → candidate.cut_in/cut_out/duration (originals kept in the edits file).
- If the new range lies inside the current plan's range, the server **slices the reframe plan** (no re-analysis, instant)
  so only `render` is needed; outside it, `reframe` is needed (UI says so: "Framing for the added part needs re-analysis, ~2 min").
- Shot edits are applied to the plan immediately (the plan keeps `auto_shots`, the untouched automatic shots, so AUTO
  restores them): FIXED → TRACK shot with constant x; GROUP → crop; FIT; SPLIT only for shots whose automatic plan was
  SPLIT (else 400 `split_unavailable`); TRACK → automatic follow. `reframe.py` re-applies the edits file after every run.
- `words`, `hook`, `captions` are read by `render.py` (caption text, hook text/duration/enabled, caption size/position).
- Every save marks render stale (plan/edits newer than the mp4) — the existing staleness rules then show "Render".
**UI tools** (Edit mode): (1) **Trim** — in/out handles on the shared timeline with word ticks, snapping to word gaps
(hold Alt to disable), ±1 frame and ±1 word nudge buttons, live duration, playback of the trimmed range;
(2) **Framing** — click a shot on the timeline → segmented control Auto / Follow speaker / Fixed / Group / Split /
Full frame; Fixed and Group: drag the crop box on the source view (Group also resizes with a locked 9:16 ratio); the
9:16 view shows the result live (canvas, no render needed); (3) **Captions** — word list of the clip, click a word to
fix its text or hide it, captions on/off, position, size; (4) **Hook** — text, on/off, seconds; (5) **Title**.
A quiet footer shows "Unsaved changes · Discard · Save" and, after saving, "Render to apply · Final / Fast".
Undo/redo (Ctrl+Z / Ctrl+Shift+Z) inside the unsaved session. Keyboard: I / O set in/out at the playhead.

## 6. Visual design
- Dark default (`#0B0C0E` ground, panels `#111317`/`#15181D`, hairlines `#23262D`, text `#E8EAED`, muted `#8B9099`).
  Light theme optional later (tokens ready). Accent **amber-yellow `#FFD43B`** (matches the caption highlight)
  used sparingly: primary buttons, focus ring, playhead, active states. Status colours: done `#3FB950`,
  running `#4C9AFF`, warning/stale/partial `#E3B341`, failed `#F85149`, skipped/missing `#6E7681`. **No violet.**
- Type: **Geist** (UI) + **Geist Mono** (times, ids, commands, numbers) via the `geist` npm package (OFL). Tabular
  numerals everywhere numbers align. Sizes 12/13/14/16/20/28.
- Radius 6 px (sharp-ish developer tool), 1 px borders, no heavy shadows; subtle glass only on overlays
  (dialogs, palette, toasts: `backdrop-filter: blur(12px)` over 70% panel colour).
- Motion: 120–180 ms ease-out for hover/press (buttons press scale .98, cards lift 1–2 px, rows highlight),
  route content fades 120 ms; respects `prefers-reduced-motion`. No scroll-triggered animation, no parallax.
- Icons: `lucide-react`. Every icon-only button has `aria-label` and a tooltip. 44 px min hit area on touch.
- Data viz in plain SVG (heatmap curve, timelines, score bars) — crisp, no chart library needed.
- Empty, loading (skeletons) and error states for every view. Errors show the server's `message` and the code.

## 7. Libraries (frontend)
React 18, react-router-dom 6, @tanstack/react-query 5, Tailwind CSS 3 (tokens as CSS variables), Radix
primitives (`@radix-ui/react-*`: dialog, dropdown-menu, tabs, tooltip, toggle-group, scroll-area, toast),
`cmdk` (palette), `lucide-react`, `geist`, `react-resizable-panels`, `clsx` + `tailwind-merge`, `motion` (only for
small transitions). Markdown: `react-markdown`. No three.js/WebGL: nothing in this tool benefits; it would only
cost CPU the renders need (decision recorded).

## 8. Quality gates
- Backend: `pytest server/tests` green; ruff-clean if available; manual curl of every endpoint against the real
  `test_fallon` job (read-only endpoints) documented in the agent's report.
- Frontend: `npm run build` (tsc strict, no `any` in API layer) green; `npm run lint` green; every screen renders
  with the real `test_fallon` job and with an empty jobs dir; no console errors.
- Integration (lead): browser walk-through of every screen, keyboard, the PAID guard (must NOT actually run
  select), a real free run (e.g. `sentences` or a `render --fast` of one clip), cancel, downloads.
