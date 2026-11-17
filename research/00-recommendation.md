# Recommendation — VideoClipper stack (2026-11-15)

Synthesis of `01`–`06`. Detail, evidence links and [V]/[U] (verified/unverified) marks live in those reports.
I re-checked headline repo facts via the GitHub API (licenses, stars, last push, file paths, openshorts' pinned
`mediapipe==0.10.14`). **All CPU timings are estimates scaled from published benchmarks — none were measured.**

## Assumptions
- Source language English. Monetized channel → **commercial-use licenses required** (this excludes several tools).
- Hardware: i7-8665U laptop, 24 GB RAM, no CUDA. A pay-per-second cloud GPU (Modal/RunPod) is acceptable for heavy steps.
- Clips are made with creator permission or from creator-supplied masters (see Risks).
- A human approves clips before publishing (selection models are not reliable enough to publish blind).
- Note: two different "autoclip" repos exist — `artbyjazi/autoclip` (the seed, MIT, 327★, 1 author) and
  `zhouxiaoka/autoclip` (MIT, 10.5k★, separate project). The reframing report references the latter in places.

---

## 1. End-to-end clippers

| Tool | License | Last push | ★ | Verdict |
|---|---|---|---|---|
| artbyjazi/autoclip (seed) | MIT | 2026-08 | 327 | **Best engineering**: single encode from source, LLM returns word indices, sentence+silence snapping, One-Euro smoothing, tests. Single maintainer; speaker detection is a heuristic. **Use as skeleton/borrow.** |
| mutonby/openshorts (seed) | MIT core (`cloud/` commercial) | 2026-11 | 8.4k | Most features (6 layouts, SPLIT). 3–4 lossy encodes, MediaPipe pinned to old 0.10.14, YOLO (AGPL), SaaS-coupled monolith. **Borrow ideas** (jump confirmation, rank-all-windows). |
| haziqahmedqasmi/PeakCut (seed) | MIT | 2026-11 (new) | 397 | No face tracking, forces 30 fps, CRF 21 veryfast. **Borrow** Parakeet-on-CPU transcribe and inline-signal idea only. |
| supoclip | AGPL | active | 3.2k | Mature product; 30 fps forced, 2 encodes, paid ASR default. Ideas only. |
| SamurAIGPT / AI-Youtube-Shorts-Generator | MIT | active | 6.1k | Funnel to paid API; Haar cascade, mp4v. Reject. |
| ClipsAI | MIT | 2024-01 (dead) | 571 | Topic segments, static crops. Reject. |
| FunClip | MIT | 2026-11 | 6.5k | Chinese-first, no 9:16 reframe. Reject. |
| clips-studio | AGPL | active | 258 | Only one with real AV speaker model (TalkNet). Ideas only. |
| open_clip (seed) | MIT-style | 2026-11 | 14k | Not a clipper. Optional later: layout classification, thumbnail/b-roll scoring. |

**None meets the quality bar out of the box.**

## 2. Transcription + diarization

| Option | License / cost | Quality evidence | Notes |
|---|---|---|---|
| **Parakeet-TDT-0.6B v2/v3** | CC-BY-4.0, free | WER 6.05 (Open ASR LB); native word timestamps + punctuation | ~6–15 min/hr on CPU via ONNX [U]; English-strong |
| WhisperX (large-v3 + wav2vec2 align) | BSD, free | WER 7.44; forced-aligned words | 1.5–2.5 h/hr on CPU; ~5 min/hr on Modal L4 (~$0.08) |
| CrisperWhisper | **non-commercial weights** | Best word-boundary error (vendor) | Excluded for monetized use |
| ElevenLabs Scribe v2 | **PAID** ~$0.20/hr (~$0.03/clip) | Word timings, diarization, audio events | Strongest paid option |
| AssemblyAI / Deepgram | PAID ~$0.23 / $0.26 per hr | Good | Alternatives |
| **pyannote community-1** | CC-BY-4.0 (HF gated) | DER 11.2 VoxConverse / 19.9 AMI | Slower than real-time on CPU [U] |
| pyannoteAI Precision | PAID €0.11/hr | DER 8.5 / 15.6 | Best measured diarization |
| DiariZen | **non-commercial** | DER 13.9 AMI | Excluded |
| NVIDIA Nemotron-3-Diarization | commercial OK | DER 12.7 DIHARD | GPU only |

## 3. Highlight selection

| Approach | Value | Evidence |
|---|---|---|
| LLM over transcript (quotes/IDs, not seconds) | **Primary engine** | Universal across serious repos |
| Zero-shot LLM "virality" score | Ranking only, not prediction | RHAPSODY: GPT-4o F1 0.057 ≈ heuristic |
| Commercial virality scores (OpusClip etc.) | Unvalidated | No published evidence |
| YouTube "Most replayed" heatmap (yt-dlp) | Strong free prior when present | Verified field, 100 bins; absent on low-view videos |
| Loudness / laughter / VAD silences | Tie-breakers + boundary snapping | Cheap on CPU |
| Scene cuts / CLIP visual scoring | Little value for podcasts | — |

## 4. Reframing

| Component | Pick | License | Why |
|---|---|---|---|
| Shot detection | PySceneDetect `AdaptiveDetector` (TransNetV2 optional) | BSD / MIT | CPU-cheap, reliable on hard cuts |
| Face detection | **YuNet** (OpenCV) | MIT | Fast on CPU, permissive (SCRFD/InsightFace weights non-commercial; YOLO-face GPL/AGPL) |
| Tracking | ByteTrack (`supervision`) + face embeddings | MIT | Identity across angles |
| Active speaker | **LR-ASD** (94.45 AVA mAP) / Light-ASD, fused with diarization | MIT | Best permissive model with usable inference; demo hard-codes CUDA + S3FD (swap out) |
| Camera path | L1-optimal offline path (Grundmann et al.) + hard cut for far switches | — | Static holds + smooth pans, no whip-pans |
| Layouts | TRACK / two-in-frame / SPLIT stacked / FIT on blur | — | Per shot |
| Upscale | Lanczos + mild sharpen; prefer 4K sources. Real-ESRGAN off by default | — | ESRGAN flickers/waxy faces; 3–10 h/clip on CPU |

Est. 2–4 min per 60 s clip on CPU [U]. No GPU needed.

## 5. Captions + render

| Item | Pick | Notes |
|---|---|---|
| Captions | **ASS via libass** (pysubs2), burned in the single encode | Already in local ffmpeg; outlines, karaoke highlight, pop-in. Pop whole 1–3-word chunk; color emoji via PNG overlay (libass #381) |
| Premium alt | pycaps (MIT, alpha) / Remotion (**PAID** for >3-person companies) | Only if libass styling proves insufficient |
| Video | libx264 slow CRF 16, `-tune film`, yuv420p 8-bit, BT.709 tags, CFR at source fps, closed GOP fps/2, faststart | One lossy encode from source; `-ss` before `-i` with re-encode |
| Audio | Two-pass loudnorm −14 LUFS, TP −2.0 dBTP, AAC 320k 48 kHz; 150–250 ms pre-pad, 300–500 ms post-pad, 25/80 ms fades | Denoise off by default (DeepFilterNet if needed) |
| Fonts | Montserrat Black / Anton (OFL) | Avoid unlicensed "The Bold Font"/Komika |

~1.5–2.5 min per 60 s clip on CPU [U].

## 6. Download + ingest

| Item | Pick |
|---|---|
| Downloader | **yt-dlp** (installed, latest 2026.10.26; Deno present for EJS). pytubefix as backup only |
| Format | `-S "res,fps,hdr:SDR,vcodec,acodec"` → MKV; prefer 4K/1440p AV1/VP9 + Opus 251 |
| Guard | **Verify downloaded height == max available** (SABR can silently drop to 360p/1080p) |
| Metadata | info.json (heatmap, chapters), manual+auto subs, comments, SponsorBlock, VFR check |
| Storage | Keep original; make 540p proxy + 16 kHz WAV for analysis; no whole-file mezzanine (~101 GB free) |
| Local masters | First-class input (best quality + rights) |

---

## Recommended stack: custom pipeline, artbyjazi/autoclip as skeleton

**Why custom, not one repo:** every end-to-end tool fails at least one hard requirement — multiple lossy encodes
(openshorts, supoclip), forced 30 fps (PeakCut, supoclip), no real active-speaker detection (all MIT ones), or AGPL.
autoclip has the right architecture (single-pass render, word-index LLM output, boundary snapping, tests), so we start
from its patterns/modules and replace the weak stages.

```
ingest (yt-dlp / local master) ──► proxy + WAV + metadata
   ──► ASR: Parakeet-TDT (default)  |  ElevenLabs Scribe v2 (paid, if bake-off wins)
   ──► diarization: pyannote community-1
   ──► signals: VAD silences, loudness, laughter, heatmap, comments, chapters
   ──► selection: Claude Haiku windows + Sonnet full-pass → code boundary snap → Opus per-candidate judge
                  → shuffled comparative rerank ×3 → diversity filter → human review
   ──► reframe: shots → YuNet → ByteTrack → LR-ASD ⊕ diarization → layout per shot → L1 camera path
   ──► render: one ffmpeg pass (cut + sendcmd crop + lanczos + ASS burn + emoji overlay + loudnorm)
   ──► QA: automated checks + golden-set review + performance log
```

**Cost per 2 h podcast (PAID parts):** Claude selection ~$2–4; optional Scribe ~$0.40; optional cloud GPU for
ASR/diarization ~$0.20. ≈ **$0.10–0.30 per published clip**. Fully free path exists (local Parakeet + pyannote overnight)
with paid Claude selection as the only spend.

## Risks
1. **yt-dlp / YouTube breakage** — SABR + PO tokens; silent quality downgrade. Mitigate: height check, update before batches, local masters.
2. **Legal/ToS** — downloading conflicts with YouTube ToS; clips are not automatically fair use. Work with creator permission; record rights per source. (Not legal advice.)
3. **Selection is the weakest science** — no model reliably predicts virality. Mitigate: human review, performance logging, re-weight rubric after a few hundred clips.
4. **CPU speeds unverified** — diarization and ASD could be much slower than estimated on this laptop. Benchmark in week 1; fall back to Modal.
5. **License traps** — CrisperWhisper, DiariZen, InsightFace/SCRFD, CodeFormer (non-commercial); Ultralytics/YOLO-face/BoxMOT (AGPL/GPL); supoclip & clips-studio (AGPL — ideas only). pyannote needs HF token + terms.
6. **Base-repo bus factor** — autoclip has 1 author; we vendor what we use rather than depend on it.
7. **1080p sources** — 1.78× upscale is visibly softer than 4K; this is a ceiling we can't fully fix.

## What we must build ourselves
- Active-speaker fusion (LR-ASD + diarization + switch penalty/min-hold) and per-shot layout selection — no OSS does this well.
- L1-optimal offline camera path + hard-cut logic.
- Multi-stage Claude selection with quote verification, boundary refinement rules, comparative rerank.
- Single-pass ffmpeg render builder (sendcmd crop track, ASS generator with chunk-pop style, emoji PNG overlay, two-pass loudnorm).
- Ingest validation (max-height check, VFR handling) and per-source metadata/rights store.
- QA harness: golden set of reference clips, automated checks (boundaries, loudness, fps, resolution, caption sync), review UI or simple review sheet, performance log.

## Decisions needed from you
1. **Hardware:** OK to use a pay-per-use cloud GPU (Modal ~$0.80/h L4) for ASR/diarization, or stay laptop-only?
2. **ASR:** run a 3-episode bake-off (Parakeet vs. WhisperX vs. ElevenLabs Scribe) before locking it in? (Recommended.)
3. **Language:** confirm English only.
4. **Base:** approve custom pipeline using artbyjazi/autoclip modules as the starting skeleton.
