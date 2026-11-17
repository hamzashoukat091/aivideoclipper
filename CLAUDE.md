# VideoClipper — Viral Short Clips from Long YouTube Videos

## Goal
Pipeline: long YouTube video (podcast, interview, vlog) → vertical 9:16 short clips (Shorts / TikTok / Reels)
good enough for a top-tier channel. **Clip quality beats speed, simplicity, and cost.**

## Quality bar (a clip is rejected unless it meets all of these)
- Strong hook in the first 1–3 s; starts and ends on natural sentence/thought boundaries
- Self-contained story or payoff (makes sense without the full video)
- 1080x1920, no visible quality loss vs. source, smooth framerate (match source fps)
- Accurate active-speaker / face tracking for 16:9 → 9:16 (no jitter, no wrong-person crops)
- Word-level timed, accurate, styled captions (animated / highlighted words)
- Clean audio: no clipped words, consistent loudness

## Constraints
- Prefer free, open-source, self-hostable tools. Paid APIs only if clearly better on quality;
  flag as PAID with estimated cost per clip.
- Hardware (detected 2026-11-15): Intel i7-8665U laptop, 24 GB RAM, Intel UHD 620 iGPU, **no NVIDIA GPU / no CUDA**.
  GPU-heavy steps need a cloud GPU or a paid API, or must be CPU-feasible.
- Already installed: ffmpeg, Python 3.12, yt-dlp, git, node.
- Source language(s): **ASSUMED English** until the user confirms.

## Research findings (2026-11-15; full detail in `research/00-recommendation.md` and `research/01`–`06`)
- No end-to-end OSS clipper meets the bar: openshorts/supoclip re-encode 2–4×, PeakCut/supoclip force 30 fps,
  none of the permissive ones do real active-speaker detection. `artbyjazi/autoclip` (MIT) has the best architecture.
- ASR: Parakeet-TDT-0.6B (CC-BY, WER ~6, native word timestamps) or WhisperX; ElevenLabs Scribe v2 is the best PAID (~$0.20/h).
  Diarization: pyannote community-1 (CC-BY, HF-gated); pyannoteAI Precision is PAID and best measured.
- Selection: LLM over transcript is the engine, but zero-shot "virality" scores barely beat heuristics → rank, don't
  predict; human review + performance log. yt-dlp `heatmap` ("Most replayed") is a strong free prior when present.
- Reframe: YuNet + ByteTrack + LR-ASD fused with diarization, per-shot layout, L1-optimal offline camera path. CPU-feasible.
- Render: one ffmpeg pass, libass ASS captions, x264 slow CRF 16, source fps CFR, loudnorm −14 LUFS / −2 dBTP.
- Ingest: yt-dlp (needs Deno, present), prefer 4K/1440p; must verify downloaded height (SABR can silently downgrade).
- License blocklist (non-commercial or copyleft): CrisperWhisper, DiariZen, InsightFace/SCRFD, CodeFormer,
  Ultralytics/YOLO-face/BoxMOT, supoclip, clips-studio (ideas only, no code).
- All CPU timings in reports are estimates — benchmark before relying on them.

## Chosen stack — PROPOSED, awaiting user approval
Custom pipeline using `artbyjazi/autoclip` modules as skeleton (vendored, not depended on):
yt-dlp/local master → Parakeet-TDT (or Scribe after bake-off) + pyannote → Claude multi-stage selection
(Haiku windows → Sonnet full pass → code boundary snap → Opus judge → rerank) → YuNet/ByteTrack/LR-ASD reframe
→ single ffmpeg render (sendcmd crop, ASS, emoji overlay, loudnorm) → QA + human review.
**Do not install packages or write pipeline code until the user approves.**

Stack approved 2026-11-16, ASR bake-off first (`bakeoff/`, see its README). Smoke test (2-min TED slice, CPU):
Parakeet RTF 0.34, WER 6.2% (no fillers); WhisperX large-v3 RTF 1.80, WER 4.0%, but ends words early more often.
Bake-off on 3 real 20-min slices (2026-11-16, `data/bakeoff/report.md`), mean filler-free WER:
Parakeet 6.5% (RTF 0.28), WhisperX 5.0% (RTF 1.61); WhisperX wins WER on every episode (hotones 7.1 vs 10.3).
Energy boundary-risk is high for both (39–62%), so cuts must snap to measured silence, not raw ASR times.
**DECIDED 2026-11-16: WhisperX large-v3 (int8, CPU) + wav2vec2 alignment is the ASR engine** (user chose it
without the listening check). Parakeet stays as a fast fallback/draft option; Scribe untested (no API key). Open: cloud GPU allowed?; English-only confirmed?

## Pipeline status
- Stage 1 (ingest → WhisperX transcript → pyannote diarization → `words.json`) built 2026-11-16 in `clipper/`
  (see `clipper/README.md`). Job files in `data/jobs/<id>/`. Diarization needs `HF_TOKEN` (user adds it).
- Stage 2 (sentences → Haiku/Sonnet propose → Sonnet judge → Sonnet 3× listwise rerank (`--judge-model opus`
  optional) → silence-snapped cuts → `candidates.json` + `review.md`) built 2026-11-17 in `clipper/select_clips.py`.
  First real run (Opus judge) on the 10-min test: $0.19, 6 candidates → 2 kept, both good (#1 matched the replay
  peak). Haiku judge run: $0.03, rejected everything (too strict) → not usable as judge. Sonnet judge run: $0.10,
  kept trivia + Princess Diaries clips; raccoon story (7/10) lost to a hook-quote technicality, now fixed
  (judge may start a clip at any word with a pause; unmatched quote = flag, not reject). Sonnet = default.
  **User wants credits kept low: cheaper models by default; never run paid steps without asking.**
- Stage 3 reframe built 2026-11-17 (`clipper/reframe.py`, `clipper/asd.py`): PySceneDetect shots, YuNet faces,
  ByteTrack-style tracks, LR-ASD speaker (vendored `vendor/LR-ASD`, MIT), TRACK/GROUP/SPLIT/FIT per shot, L1 camera
  path. Checked by eye on 3 test clips: framing good; mouth-motion alone picked a laughing listener, LR-ASD fixed it.
  Not yet used: diarization fusion (no HF_TOKEN), cross-shot identity, min 2 s layout hold, sub-pixel crops.
- Stage 4 render built 2026-11-17 (`clipper/render.py`, `clipper/captions.py`): raw decode → Python compose → one
  x264 slow CRF 16 encode with libass captions (Montserrat, bundled) and two-pass loudnorm. 3 test clips pass all
  checks (1080×1920, 29.97 CFR, −14 LUFS, −2 dBTP). Pipeline is complete end to end; human review still required.
- `clipper/run.py` chains all 4 stages (2026-11-17): skips current work, redoes clips whose cuts changed, paid
  selection only with `--select`, `--review-first` to stop before rendering, honours `approved: false`.
- Caption lessons (user-reported): never two caption events at once; no drop shadow (looked like ghost text);
  keep .ass files out of `renders/` (players auto-load them as a second subtitle layer).
- Open: diarization (HF_TOKEN), cross-shot identity, 2 s min layout hold, emoji/keyword emphasis.
- **Clipper Studio UI** (2026-11-17): `server/` (FastAPI, 203 tests) + `web/` (React/Vite) per `docs/UI_SPEC.md`;
  launch with `Clipper Studio.cmd` → http://127.0.0.1:8765. Paid selection refused server-side without
  `confirm_paid: true` (StrictBool) and always preceded by a free dry-run estimate. Studio Edit mode (spec 5b): trim,
  per-shot framing, caption word fixes, hook, title → `edits/<cid>.json`, applied by `clipper/edits.py`.
- Pipeline fixes found via the UI: camera cuts near clip edges (`clipper/cutsnap.py` snaps edges to cuts in
  silence; `reframe.apply_edge_holds` holds a frame when the cut is inside speech); spend now sums
  `selection/cost_history.jsonl`; render is stale when the plan or edits are newer than the mp4.
- User preferences: quiet UI ("do not make it noisy"); proper editing tools after generation.

## Environment notes
- Python venv at `.venv` (CPU torch). Run scripts with `.venv/Scripts/python`.
- This machine re-signs TLS (Windows-store root). Never disable verification: Python uses `truststore`
  (injected in `bakeoff/common.py`); yt-dlp needs `--compat-options no-certifi` + Windows-roots PEM via
  `CURL_CA_BUNDLE`/`SSL_CERT_FILE` (see `bakeoff/ingest.py`).
- YouTube media downloads intermittently 403; ingest retries.

## Conventions
- Research reports live in `research/NN-area.md`; summarize conclusions here, keep detail there.
- Verify tool claims against the repo (README, issues, code), not marketing descriptions.
- Never re-encode more than once from the source; cut and render in a single high-quality pass.
- Every pipeline stage writes an inspectable intermediate (transcript JSON, clip candidates JSON,
  crop track JSON, ASS subtitle file) so stages can be debugged and re-run independently.
- When a choice is ambiguous, write down the assumption instead of guessing silently.
