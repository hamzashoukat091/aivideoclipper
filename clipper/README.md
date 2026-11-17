# clipper — the clip pipeline

Each stage is a standalone script that reads and writes files in `data/jobs/<job_id>/`, so any stage can be
inspected and re-run alone. Run everything with `.venv/Scripts/python`.

## One command

```
.venv/Scripts/python clipper/run.py <youtube-url | local-file> --id myjob                   # free: stage 1 + cost estimate
.venv/Scripts/python clipper/run.py <youtube-url | local-file> --id myjob --select --review-first   # PAID picking, then stop
.venv/Scripts/python clipper/run.py <youtube-url | local-file> --id myjob                   # reframe + render the picks
```
- Work that is done and still current is skipped. A clip is reframed/rendered again only if its cut times changed
  (e.g. after a new `--select`); `--force` redoes every free stage.
- Clip selection is the only paid step: it runs only with `--select`, otherwise the command prints a dry-run estimate
  and stops when no picks exist yet. `--judge-model haiku|sonnet|opus` (default sonnet).
- Set `"approved": false` in `candidates.json` to drop a clip; `--clip c02 c05` limits a run to some clips.
- `--preview` also writes reframe previews; `--fast` uses a quicker encode for checking.
- Ends with a table of clips and their render checks. Videos: `renders/`, review sheet: `review.md`.

## Stage 1: ingest → transcribe → diarize

```
.venv/Scripts/python clipper/run.py <youtube-url | local-file> --id myjob [--speakers 2]
```
Skips stages whose output already exists; `--force` re-runs all. Or run each stage directly:

| Script | Writes | Notes |
|---|---|---|
| `ingest.py <src> --id J` | `source.*`, `info.json`, `probe.json`, `heatmap.json`, `chapters.json`, `audio16k.wav`, `meta.json` | Best video up to 2160p, prefers higher fps and SDR. **Fails if YouTube served a lower height than it lists** (SABR downgrade) unless `--allow-lower`. Master is never re-encoded. |
| `transcribe.py --id J` | `transcript.json` | WhisperX large-v3 int8 + wav2vec2 alignment (bake-off winner). ~1.6× real time on this laptop. `--language auto` to detect. |
| `diarize.py --id J` | `diarization.json`, `words.json` | pyannote community-1. Needs `HF_TOKEN` in `.env` and the model's terms accepted on Hugging Face. Without a token it still writes `words.json` with `speaker: null` (exit 2). `--merge-only` rebuilds `words.json`. |

`words.json` is what later stages read: every word with `start`, `end`, `score`, `timed`, `speaker`.

## Stage 2: sentences → clip selection (Claude, PAID)

```
.venv/Scripts/python clipper/run.py <src> --id myjob --select     # or run the two scripts below
.venv/Scripts/python clipper/sentences.py --id myjob
.venv/Scripts/python clipper/select_clips.py --id myjob [--top 10 --min-s 15 --max-s 90] [--dry-run]
```
Needs `ANTHROPIC_API_KEY` in `.env`. `--dry-run` calls nothing: it writes the proposal prompts to `selection/`
and prints a cost estimate. Measured on the 10-min test video: $0.19 with an Opus judge. Estimates for the same
video: Sonnet judge (default) ~$0.20 or less, Haiku ~$0.06 (`--judge-model haiku|sonnet|opus`).
**Haiku as judge is not usable:** on the test video it cost $0.03 but rejected all 5 candidates, including the
two Opus kept (raccoon story 8/10). `review.md` always lists judge-rejected clips with reasons, for human review. Real spend is
logged to `selection/cost.json`.

| Step | Model | What |
|---|---|---|
| sentences | none | `sentences.json`: sentence units (punctuation, speaker change, ≥1.5 s pause) + replay heat + loudness z |
| propose | Haiku 5.5 per 12-min window (2-min overlap) + Sonnet 5.5 on the whole transcript | sentence-index ranges + verbatim `hook_quote` (checked against the start sentence) |
| pool | code | validate, duration 15–90 s, dedupe at IoU ≥ 0.5 (full-pass version wins) |
| judge | Sonnet 5.5 by default (`--judge-model`), one call per candidate, ±8 sentences context | keep/reject, may move start/end, title, on-screen hook, 1–10 scores |
| rerank | judge model, 3 shuffled listwise passes | Borda average position |
| finalize | code | silence-trough cut points, drop clips sharing >30% time, top N |

Outputs: `candidates.json` (ranked, each with `approved: null` for you to set), `review.md` (read this while
watching), `selection/{proposals,judged,rerank,cost}.json`. Sonnet/Opus calls use server-side refusal fallback. A clip may start up to 6 words into its first sentence when the hook quote skips a false start and there is a ≥0.10 s pause to cut in.

## Stage 3: reframe 16:9 → 9:16 (free, CPU)

```
.venv/Scripts/python clipper/reframe.py --id myjob [--clip c02 c05] [--preview]
.venv/Scripts/python clipper/reframe.py --id myjob --start 100 --end 130 --preview    # any time range
```
One-time setup (done on this machine):
```
.venv/Scripts/python -m pip install opencv-python-headless scenedetect python_speech_features
git -c http.sslBackend=schannel clone --depth 1 https://github.com/Junhua-Liao/LR-ASD vendor/LR-ASD
# YuNet face model (MIT) -> models/face_detection_yunet_2023mar.onnx, from
# https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```

| Step | How |
|---|---|
| shots | PySceneDetect `AdaptiveDetector` on a 640-wide proxy, min shot 0.4 s |
| faces | YuNet every frame (score ≥ 0.45; width 3.5–55% of frame) |
| tracks | per shot, ByteTrack-style IoU + Hungarian, gaps ≤ 0.35 s interpolated, tracks < 0.5 s dropped |
| speaker | **LR-ASD** (MIT, TalkSet weights) on 25 fps 112×112 face crops + MFCC, cut from a full-res pass; speech-gated; Viterbi switch penalty, 1 s min hold, switches 0.2 s early. `--no-asd` = mouth-motion fallback (weak) |
| layout | per shot: **TRACK** (follow speaker), **GROUP** (faces fit one crop), **SPLIT** (two far apart, both ≥ 20% of talk; left person on top), **FIT** (no face / 3+ spread: full frame on blur) |
| camera | TRACK: L1-optimal path (Grundmann 2011, HiGHS LP) with a 6% deadband and face-inside constraints; hard cut instead of pan when the speaker jumps > 1/3 crop width |

Writes `reframe/<clip>.json` (per-shot layout, per-frame crop x for TRACK, panel boxes for SPLIT/GROUP, QA:
layout counts, crop velocity p95, direction reversals/s, face-inside rate) and with `--preview` a 540×960
`<clip>_preview.mp4` with the layout name burned in (a check, not the final render).

Speed on this laptop: analysis ~1× clip length, LR-ASD ~3–4× clip length (a 30 s clip ≈ 2 min total).
Tested on 3 talk-show clips: LR-ASD fixed the mouth-motion failure (a laughing listener read as the speaker).

## Stage 4: render (free, CPU)

```
.venv/Scripts/python clipper/render.py --id myjob [--clip c02] [--fast] [--no-hook]
```
One encode from the source per clip. ffmpeg decodes the cut range to raw BGR (explicit BT.709); Python composes
each 1080×1920 frame from `reframe/<clip>.json` (Lanczos when enlarging, area when shrinking; light unsharp only for
sources under 1600 px tall); a single ffmpeg encode burns the captions and normalises audio:
x264 `slow` CRF 16 `film`, High, yuv420p BT.709, closed GOP of 0.5 s, maxrate 25M, source fps CFR, AAC 320k 48 kHz,
two-pass `loudnorm` −14 LUFS / −2 dBTP, 25 ms fade-in / 80 ms fade-out, `+faststart`. `--fast` = medium CRF 17.

Captions (`clipper/captions.py`, written to `captions/<clip>.ass`, kept out of `renders/` so video players do not auto-load it as a second subtitle track): Montserrat Black 84 px (SIL OFL, bundled in
`assets/fonts/`, licence in `assets/licenses/`), caps, 1–3 words / ≤ 14 chars per chunk (punctuation, pauses
> 0.28 s, 1.8 s max; never ends on a function word), active word yellow, chunk pops in once. Position by layout:
y 1150 (TRACK/GROUP), 960 on the SPLIT seam, 520 above a FIT band. The judge's `on_screen_hook` sits in a box at
y 290 for the first 3 s.

Each render writes `renders/<clip>.report.json` with measured output and pass/fail checks (1080×1920, fps = source,
all frames present, loudness −14 ± 1 LUFS, peak ≤ −1 dBFS). Clips with `approved: false` are skipped.
Test video: 3 clips, all checks passed, ~10.4 Mbps, −14.0 to −14.2 LUFS, peak −1.9 to −2.0 dBFS; ~5 s of
render time per second of clip. Softness at 100% comes from the 1080p, ~3 Mbps source enlarged 1.78× — use 1440p/4K
sources when they exist.

### Caveats
- Word times are for captions and selection, **not** cut points: cuts get snapped to measured silence at render.
- `timed: false` words (numbers, symbols) had no alignment and were interpolated.
- `diarization.json` keeps both overlapping `turns` (for the reframe stage: crosstalk) and `exclusive` turns (for word labels).
- Pass `--speakers N` when the count is known; it's the biggest diarization accuracy win.
