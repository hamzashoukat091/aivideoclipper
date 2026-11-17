# 01 — End-to-end open-source clipping tools

Research date: 2026-11-15. Method: `gh api` / `gh issue list` against each repo, plus reading README, architecture docs and the actual reframe, highlight, caption and encode source files. Nothing was cloned, installed or run. Star and commit figures are as of today.

Target machine: Intel i7-8665U (4C/8T, 15 W), 24 GB RAM, no NVIDIA GPU. "CPU-OK" means it runs on that machine (possibly slowly). Speed numbers marked *(est.)* are my estimates, not measurements.

---

## 1. Comparison table

| Tool | Covers | License | Last commit | Stars / forks / contrib / open issues | Hardware | Quality evidence | Key weaknesses |
|---|---|---|---|---|---|---|---|
| **mutonby/openshorts** | Full pipeline: ingest, ASR (faster-whisper / Parakeet), LLM highlights (Gemini or any OpenAI-compatible model), scene detection, 6 reframe layouts (TRACK/GENERAL/SPLIT/SCREENCAST/INSET/ALTERNATE), ASS word captions, hook overlay, loudnorm, publishing, dubbing | MIT core; `cloud/` dir is a **commercial licence** (NOTICE) | 2026-11-12 (very active) | 8,438 / 1,768 / 9 / 27 | CPU-OK (README: 5–8 min per 8-min video on CPU). Gemini (PAID, cheap) needed for the frame-based stages (layout picker, screencast, hook grounding) | Demo MP4s in `dashboard/public/demo/`, before/after GIF on a CC-BY podcast, measured tuning notes in code comments | Up to 4 x264 generations (cut, reframe, subtitle burn, hook) at CRF 18. Camera is a "heavy tripod" (fixed 3 px/frame pan, x-only). Active speaker is a mouth-pixel-diff heuristic and off by default. Monolith (`app.py` 457 KB, `main.py` 146 KB). Mostly SaaS-driven; issue tracker full of spam |
| **artbyjazi/autoclip** | Full pipeline: yt-dlp, faster-whisper (+ optional WhisperX diarization), LLM highlights (Ollama/Anthropic/OpenAI/Gemini), sentence and silence boundary refinement, shot-aware MediaPipe tracking, 1€ smoothing, 4 ASS caption styles, **single-pass** export, loudnorm | MIT | 2026-08-01 (idle 3.5 months) | 326 / 106 / 1 (19 commits) / 8 | CPU-OK (Whisper `small` default; MediaPipe on CPU). Diarization (pyannote via WhisperX) is heavy on CPU | e2e test asserts 1080×1920 yuv420p, −14 LUFS, crop tiling. Author says the reframe golden-set bar is **not yet met** (pre-v0.1) | Single author, young, stalled. Heuristic speaker detection (mouth-aspect variance + diarization), not an AV model. Single-pass loudnorm. Few users |
| **haziqahmedqasmi/PeakCut** | Ingest (incl. live streams), Parakeet ASR (sherpa-onnx, CPU), LLM + loudness/chat-spike highlights, ASS captions, posting | MIT | 2026-11-15 (repo **created 2026-11-14**) | 394 / 148 / 1 (15 commits) / 14 | CPU-OK, lightweight (no torch) | 3 demo MP4s in `web/brand/` | **No face tracking**: only blur-fill, zoom or centre crop (`studio/render.py`). Forces 30 fps. x264 `veryfast` CRF 21. Gaming/stream oriented. One day old; star count looks promotional |
| **mlfoundations/open_clip** | Not a clipper. Image-text embedding models (CLIP / SigLIP-style) | MIT-style (custom text, permissive) | 2026-11-10 (v4.2.2) | 14,266 / 1,339 / — / 30 | CPU-OK for ViT-B/32 and B/16 on sampled frames | Mature research library | Component only (see §3.4) |
| **FujiwaraChoki/supoclip** | Full pipeline + editor: AssemblyAI ASR (local fallback is openai-whisper `base`), LLM selection with boundary-strength planner, YuNet face detection + motion-based L/R speaker timeline, split/fit layouts, ASS captions, B-roll, loudnorm, publishing | **AGPL-3.0** | 2026-11-15 (very active) | 3,198 / — / 8 / many | Default needs **PAID** AssemblyAI (about $0.15–0.37 per audio hour, so roughly $0.10–0.40 per hour-long source, not per clip; *unverified current price*). Local path is CPU-OK but low quality (`base` Whisper) | Public demo page; a self-filed series of "[Clip quality]" issues (#280–#293) shows real quality QA | AGPL. Forces 30 fps output (`OUTPUT_FPS = 30`). Two encodes (intermediate CRF 16, then final CRF 19). Open issues: layouts jump between full height and a narrow strip (#283), fit layout too small (#282), caption collision with burned-in subs (#291) |
| **Anil-matcha/AI-Youtube-Shorts-Generator** (= SamurAIGPT, redirected) | Download, Whisper ASR, GPT/Gemini highlight JSON, crop. Default mode is a front for the **PAID MuAPI** service | MIT | 2026-11-12 | 6,101 / 1,108 / 3 / 27 | Local mode CPU-OK | README demo only | Local reframe is a **Haar cascade** with a per-frame EMA, written through OpenCV `mp4v` (lossy MPEG-4 Part 2) and then muxed. No scaling to 1080×1920. **No captions** in local mode. 2 encodes. Effectively a marketing funnel |
| **ClipsAI/clipsai** | Library: WhisperX transcription, TextTiling topic segmentation (not virality), pyannote diarization + MTCNN/MediaPipe face mesh + K-means speaker resize (crop coordinates) | MIT | **2024-01-17 (abandoned)**; a 1-star fork exists (EricksonLOOP/clipsai) | 571 / 104 / 4 / 16 | Diarization is heavy on CPU; otherwise CPU-OK | `report/resize.pdf` technical write-up | Dead. Dependency rot (#7, #13). Static crop per speaker segment (no in-shot panning). No captions. No hook scoring |
| **modelscope/FunClip** | ASR (Paraformer / SenseVoice / Fun-ASR-Nano), CAM++ speaker ID, LLM-picked timestamp clips, SRT burn via MoviePy | MIT (model weights Apache-2.0) | 2026-11-01 | 6,560 / 772 / 20 / 18 | CPU-OK | Gradio demo | Chinese-first; English uses the weaker `paraformer-en`. **No 9:16 reframe.** MoviePy `write_videofile` with default bitrate. Retired-model bug (#234) |
| **ColinGPT9/clips-studio** ("Clips Kitty") | Full pipeline: faster-whisper large-v3-turbo, Ollama LLM with audio/visual event fusion, YOLOv8-pose + Haar + **TalkNet active-speaker detection**, shot-aware cuts, ASS captions, editor, remote render workers | **AGPL-3.0** (TalkNet vendored as MIT) | 2026-11-15 (very active) | 258 / 50 / 16 / — | GPU-oriented (timings measured on an RTX 3060); CPU fallback exists but tracking at 8 fps plus TalkNet will be slow on a U-series CPU *(est.)* | Detailed measured notes in `video/asd.py` | AGPL. x264 `veryfast` CRF 20 on CPU. Cut then crop means at least 2 encodes. Huge scope (Discord campaigns, Twitch, sports) |
| **kamilstanuch/Autocrop-vertical** | Reframe only: PySceneDetect + YOLOv8n + Haar, per-scene TRACK or LETTERBOX | none stated in API | 2026-02-15 | 463 / — / 1 / 3 | CPU-OK | Demo GIF (the same Churchill GIF ships inside openshorts, which is likely its ancestor) | One static crop per scene (no in-shot tracking). Default CRF 23. ffmpeg v9 breakage (#15), A/V desync (#2) |
| Others found (not deep-dived) | xixihhhh/hotclip (463★, AGPL, Chinese platforms); Shaarav4795/ClippedAI (240★, built on clipsai); Blueturboguy07/publikclip (72★, AGPL); fralapo/clippyme (66★, MIT); GrepCut/OpenClipper (19★, MIT); RayVentura/ShortGPT (8.1k★, faceless generation, not clipping, last push 2025-02) | — | — | — | — | — | Small, new or off-target |

---

## 2. Per-tool notes

### 2.1 mutonby/openshorts — the most complete, but a SaaS-shaped codebase

Repo: https://github.com/mutonby/openshorts. The most widely used open-source clipper today: 8.4k stars and active daily commits. It doubles as the source for the paid openshorts.app.

**Pipeline, verified in source**
- **ASR** (`transcribe_backends.py`): faster-whisper singleton. The `.env.example` default for CPU is `WHISPER_MODEL=small`, int8. Production uses `large-v3-turbo` on CUDA. There is an optional Parakeet-TDT-0.6b-v3 ONNX backend (`istupakov/parakeet-tdt-0.6b-v3-onnx` via `onnx_asr`). It merges word fragments for word-level timing.
- **Highlights** (`clip_selection.py`, `docs/architecture/clip-selection.md`, `main.get_viral_clips`): about 90 s scoring windows. Every window is scored in batches, then a global shortlist of `min(10, duration//90+2)` goes to a second "detail" pass. A clip floor is enforced in code. Gemini 3.1 Flash-Lite is the default; `LLM_BASE_URL` routes the text passes to any OpenAI-compatible or local model. Boundaries come from `snap_clip_to_words` (word plus a little silence, **not sentence snapping**). They measured p90 boundary error of 0.4–0.5 s before the snap.
- **Reframe** (`reframe_v2.py`, `main.py:116–420`, `docs/architecture/layouts-and-reframing.md`):
  - Analysis runs at ≤640 px with PySceneDetect scene cuts.
  - Faces come from MediaPipe FaceDetection (`model_selection=1`), with a YOLOv8n fallback, every `DETECT_STRIDE=4` frames.
  - `SmoothedCameraman` is a "Heavy Tripod". It has a safe zone of 25 % of the crop width and moves at a fixed 3 px/frame, or 15 px/frame for large moves. A jump must be confirmed 3 times before the camera follows. Comments document a measured 69 % cut in reversals. The camera snaps (no pan) at scene cuts.
  - **Horizontal only, with no easing curve.** It is linear motion, not a filter.
  - `SpeakerTracker` uses ID-by-proximity matching with hysteresis (15-frame stabilisation, 30-frame cooldown).
  - `active_speaker.py` measures mouth-region frame differences gated by audio RMS. It is **off by default** (`SPEAKER_SIGNAL=0`).
  - SPLIT layout stacks two speakers, with captions on the seam. The layout picker sends 12 frames at 1024 px to Gemini (PAID, about 3k tokens).
- **Render**: the camera path becomes ffmpeg `sendcmd` crop commands per scene, then a concat with stream copy. Output is the native crop size, upscaled to at least 1080 wide (default bicubic scaler).
- **Encodes** (`ffmpeg_utils.py`): x264 `fast` CRF 18 for the intermediate cut and the reframe, then `medium` CRF 18 for the subtitle burn (`subtitles.py:687`) and the hook stage (`hooks.py`). **That is 3–4 lossy generations.** CRF 18 hides most of it, but it is avoidable. Audio uses `loudnorm=I=-14:TP=-2:LRA=11`, single pass, with comments on true-peak overshoot.
- **Captions**: ASS built from word timings, with presets (default, hormozi, lime, oneword, pill; demo MP4s in `dashboard/public/demo/caption-*.mp4`). There is also a Remotion renderer service (`remotion/`, `render-service/`). Issue #116 reports that its container crash-loops.

**Evidence and weaknesses**
- Code comments carry real measurements from production footage, which is rare and valuable.
- Issue #82: captions were stretched after the hook stage (closed).
- The open issue list is mostly spam from hosted-app users ("GTA6", raw YouTube links), so it says little about quality.
- Heavy coupling to Gemini and the SaaS: billing, metering, `cloud/` under a commercial licence, S3, Upload-Post.
- Hardware: CPU works but is slow. Expect about 1× source duration or worse for a full job on an i7-8665U *(est.)*.

### 2.2 artbyjazi/autoclip — the best-engineered render path; small and stalled

Repo: https://github.com/artbyjazi/autoclip. 19 commits by one author, last on 2026-08-01.

**Pipeline, verified**
- **ASR** (`pipeline/transcribe.py`): faster-whisper with `word_timestamps=True` and VAD (500 ms minimum silence). The default model is `small` (`config.py`). Optional WhisperX diarization.
- **Highlights** (`pipeline/highlights.py`, `prompts/highlight_v1.txt`):
  - The LLM returns **word indices, not seconds**. The model copies the index; timing comes from measured word timestamps.
  - The prompt ranks hook, then self-containment, then payoff, then quotability. It asks for harsh scoring and says "return nothing rather than pad".
  - A retry-with-validation-error loop handles small local models (`providers/base.py`).
- **Boundaries** (`pipeline/boundaries.py`): three passes.
  1. Sentence snap, searching ±12 words.
  2. Duration clamp to 20–90 s, ending on a sentence.
  3. Silence alignment: cut 0.12 s into the silence before the first word and hold 0.28 s after the last word, using a measured silence map. This is the strongest boundary logic of any repo reviewed.
- **Reframe** (`pipeline/reframe/`):
  - `scenes.py` detects shots first. Crop paths **never interpolate across a cut**.
  - `faces.py` uses the MediaPipe FaceLandmarker (Tasks API), so eye and mouth landmarks are available.
  - `tracker.py` builds face tracks.
  - `speaker.py` measures mouth-aspect-ratio variance. With diarization, it maps each diarized speaker to a face track once per clip, so speaker turns drive clean cuts. It uses a dominance margin of 1.6×. The author notes TalkNet/LR-ASD would be better ("v2 list").
  - `smoothing.py` chains a **One-Euro filter** (min_cutoff 0.6, beta 0.02), a 12 px dead zone and a 260 px/s velocity clamp.
  - `croppath.py` writes piecewise-linear ffmpeg expressions over `t`.
  - Fit fallback: blurred background with a lanczos-scaled foreground.
- **Export** (`pipeline/export.py`): **one ffmpeg pass from the original source.** Input seek, per-shot trim/crop, `scale=1080:1920:flags=lanczos`, concat, then the `ass=` burn, all in one filtergraph. x264 `medium` CRF 18 High profile, yuv420p, AAC 192k at 48 kHz, single-pass `loudnorm` at −14 LUFS, `+faststart`. Source fps is preserved (only the optional zoompan forces 30).
- **Captions** (`pipeline/captions.py`): bold_pop (the active word grows and turns yellow), karaoke_fill, clean_lower and boxed. Fonts (Anton, Inter) are bundled under the OFL.

**Weaknesses**
- The author states the reframe acceptance bar (no jitter, speaker on screen ≥95 % of speaking time, on a golden set) is **not yet validated**.
- Issues: Ollama timeouts on Windows (#3), MediaPipe GPU crash on macOS (#2).
- Bus factor of 1, with no commits since August.

### 2.3 haziqahmedqasmi/PeakCut — not suitable for talking-head content

Repo: https://github.com/haziqahmedqasmi/PeakCut. Created 2026-11-14. 394 stars in about 1 day suggests promotion.

- **ASR**: Parakeet 0.6b via sherpa-onnx, several CPU model copies (`studio/transcribe.py`). This is a good CPU idea.
- **Highlights** (`studio/brain.py`): 15-minute windows with a timestamped transcript. Lines are tagged `(LOUD)` and `(CHAT)` for spikes. The prompt targets gaming and streaming. The LLM returns seconds, then `sentence_ends()` snaps them.
- **Render** (`studio/render.py`): **no face detection at all.** The layouts are blur-fill, zoom or centre crop. Output is `fps=30` forced at 1080×1920. Encoding is x264 `veryfast` CRF 21 or QSV, `loudnorm` −14, AAC 160k.
- Verdict: useful only as a reference for Parakeet on CPU through sherpa-onnx, and for loudness/chat signal fusion.

### 2.4 FujiwaraChoki/supoclip — mature product, AGPL, paid ASR by default

Repo: https://github.com/FujiwaraChoki/supoclip. 3.2k stars, 8 contributors, active daily, with a hosted SaaS and an iOS app.

- **ASR**: AssemblyAI Universal-3.5-Pro (PAID) with speaker labels (`media/transcription.py`). The local fallback is openai-whisper `base`, which is low accuracy.
- **Selection**: the `workflows/` package. A boundary-strength model (`workflows/boundaries.py`) rates each gap: sentence end 0.75 or higher, speaker change 0.6, pause 0.55. The planner, partition and opening logic live in `clip_openings.py`. There is filler and pause cleanup (`clip_cleanup.py`) and a large prompt set (`workflows/prompts.py`, 55 KB).
- **Reframe** (`media/reframing.py`, 76 KB): YuNet ONNX face detector, then OpenCV DNN, then Haar. A motion-based left/right speaker timeline is smoothed with a moving average (window 15). Speaker changes become eased pan expressions. There are split-screen and "fit" layouts.
- **Encoding** (`media/common.py`): intermediate CRF 16 `veryfast`, final CRF 19 `medium`, lanczos plus unsharp to 1080×1920, **forced 30 fps**, `loudnorm` −14 / TP −1.5, AAC 192k.
- **Quality evidence**: the maintainer filed a "[Clip quality]" issue series (#280–#293).
  - Mid-sentence endings (#280, closed) and zero-duration words dropping caption text (#289, closed) were fixed.
  - Still open: layout jumps (#283), fit layout too small (#282), caption collision with burned-in subtitles (#291).
- **AGPL-3.0**: copying code into our pipeline would force AGPL on it. Borrow ideas only.

### 2.5 Anil-matcha / SamurAIGPT AI-Youtube-Shorts-Generator — popular, low quality

Repo: https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator.

- The default `--mode api` sends everything to MuAPI (PAID; `shorts_generator/muapi.py`).
- Local mode (`shorts_generator/local/clipper.py`):
  1. Cut with x264 CRF 20.
  2. Reframe with a Haar cascade (largest face, EMA 0.15), written through `cv2.VideoWriter('mp4v')`. This is MPEG-4 Part 2 at OpenCV's default bitrate, a visible quality loss.
  3. Mux, with no scale to 1080×1920 and **no captions**.
- Issue #81 confirms two-person podcast tracking is poor.
- Not a candidate base.

### 2.6 ClipsAI/clipsai — good ideas, dead code

Repo: https://github.com/ClipsAI/clipsai. Last commit 2024-01-17. Issue #17 asks "Is this project abandoned?"; the fork EricksonLOOP/clipsai has 1 star.

- **ClipFinder** (`clip/texttiler.py`, `clip/clipfinder.py`): TextTiling over sentence embeddings. It finds topic segments, not engaging moments.
- **Resizer** (`resize/resizer.py`):
  - Merges pyannote diarization segments with scene changes.
  - Samples 13 frames per segment and detects faces with MTCNN/FaceNet.
  - Uses the MediaPipe face mesh mouth-aspect ratio to find the speaker, and K-means to cluster face positions.
  - The result is **one static crop per speaker segment** (no panning). It is described in `report/resize.pdf`.
- Worth reading for the diarization × face-cluster mapping idea. Do not depend on it.

### 2.7 modelscope/FunClip — wrong tool for this job

Repo: https://github.com/modelscope/FunClip.

- Strong Chinese ASR with token timestamps, speaker-targeted clipping and LLM-chosen timestamp clips.
- No vertical reframe. MoviePy re-encodes at default settings (`funclip/videoclipper.py:397`). Issue #146: vertical video gets squashed.
- For English, Whisper or Parakeet is the better ASR.

### 2.8 ColinGPT9/clips-studio — the best active-speaker approach, AGPL

Repo: https://github.com/ColinGPT9/clips-studio.

- `video/asd.py` wraps **TalkNet-ASD** (vendored MIT, `third_party/talknet/`) on top of YOLOv8-pose tracks at 8 fps. Boxes are interpolated to TalkNet's 25 fps rather than re-detecting.
- The code comments explain why mouth-motion heuristics fail: a measured 7 % speaker/listener difference, against a 45 % size difference that dominates.
- Framing **cuts** on speaker change, with no panning, and ignores turns shorter than about 1 s.
- `video/encoding.py`: CPU uses x264 `veryfast` CRF 20; there is a probed hardware encoder chain (NVENC, AMF, QSV, VideoToolbox).
- AGPL, so take the approach, not the code. TalkNet itself is MIT and can be used directly.

### 2.9 kamilstanuch/Autocrop-vertical

Repo: https://github.com/kamilstanuch/Autocrop-vertical.

- Reframe only. Per scene, it picks a static TRACK crop or LETTERBOX (`main.py`, YOLOv8n + Haar).
- Likely the seed of openshorts' reframer (the same demo GIF ships in both repos).
- Too simple for the quality bar.

---

## 3. Cross-cutting findings

### 3.1 Encoding quality (the "no visible quality loss" requirement)

| Tool | Generations of lossy video encode | Settings | fps |
|---|---|---|---|
| autoclip | **1** (source → final) | x264 medium CRF 18, lanczos | source fps preserved |
| openshorts | 3–4 | CRF 18 fast/medium | source |
| supoclip | 2 | CRF 16 veryfast, then CRF 19 medium, lanczos + unsharp | **forced 30** |
| clips-studio | ≥2 | CRF 20 veryfast | source *(not fully verified)* |
| PeakCut | 1 | CRF 21 veryfast | **forced 30** |
| Anil-matcha | 2, including mp4v | CRF 20, then OpenCV mp4v | source |

autoclip's single-filtergraph approach (`pipeline/export.py`, `build_video_filtergraph`) is the pattern to copy. Trim, crop, lanczos scale, concat and the ASS burn happen in one pass. Our own pipeline should go further: CRF 16–18 `slow` (CPU time is acceptable because quality comes first), source fps preserved (or a 60 fps source kept at 60), and two-pass loudnorm. Two-pass loudnorm is not in any of these repos; all use single-pass.

### 3.2 Reframing and active speaker

- **Smoothing.** The best is autoclip's One-Euro filter plus dead zone plus velocity clamp (`reframe/smoothing.py`). openshorts' heavy tripod (`main.py:116`) is a good *policy*: confirm jumps, snap at cuts, sit still in a safe zone. Its motion model, however, is linear. A combination is ideal: openshorts' jump-confirmation and scene-cut snap, with autoclip's One-Euro filter, run as an offline pass over the whole clip.
- **Shot awareness.** autoclip, openshorts and clips-studio all reset framing at scene cuts. This is mandatory.
- **Active speaker.** Every tool except clips-studio uses mouth-motion heuristics (openshorts `active_speaker.py`, autoclip `speaker.py`, supoclip `build_speaker_timeline_from_motion`). clips-studio's own measurements show these fail in lively two-shots. **Use TalkNet or LR-ASD (Light-ASD) on face tracks.** On CPU that is feasible if detection stays at 5–8 fps and boxes are interpolated *(est.)*.
- **Layouts.** openshorts' SPLIT rule is a sound guard: both faces must appear in the same frame in at least half the samples, which separates a real two-shot from shot/reverse-shot. So is placing captions on the seam.

### 3.3 Highlight selection and boundaries

- **Best prompt and contract**: autoclip, with word indices instead of seconds, harsh scoring and "return nothing rather than pad" (`prompts/highlight_v1.txt`).
- **Best ranking structure**: openshorts' two-pass funnel. A scoring pass ranks *every* ~90 s window, then a global shortlist goes to the detail pass (`clip_selection.py`, `docs/architecture/clip-selection.md`).
- **Best boundary refinement**: autoclip `boundaries.py` (sentence snap, duration clamp, silence alignment). supoclip's boundary-strength scoring adds speaker change and pause signals (`workflows/boundaries.py`, AGPL, so ideas only).
- All of them depend on LLM quality. On this CPU-only machine, a local 7–8B model will pick noticeably worse clips (autoclip's README says so). A frontier model through an API is clearly better and cheap. It is PAID: about $0.01–0.10 per *source video* for transcript-only prompts on a flash or frontier model *(est.)*, i.e. under $0.02 per clip.

### 3.4 open_clip as a component

open_clip is a mature MIT-style library (v4.2.2, 2026-11-10). It runs on CPU for ViT-B/32 or B/16 at about 5–20 images/s on this laptop *(est.)*. Possible uses:
- **Zero-shot shot classification** ("talking head", "two people", "screen recording", "slide", "b-roll"). This would be a free local substitute for openshorts' Gemini layout picker. It is less accurate on fine distinctions; openshorts found closed-choice VLM prompts work best.
- **Thumbnail and cover-frame scoring**: rank candidate frames by text prompts ("expressive face", "eyes open, looking at camera") plus a sharpness check.
- **B-roll relevance**: embed transcript sentences against stock-clip keyframes. This fixes supoclip's issue #293 (keyword B-roll with the wrong emotional context).
- **Not useful** for highlight detection (which is text-driven) or for active speaker detection.

Verdict: an optional component for layout and thumbnail selection, not core.

---

## 4. Verdict

**No repository meets the quality bar as-is.** The closest are openshorts (feature breadth, real-world tuning) and autoclip (cleanest render path and boundary logic). Each falls short:
- **openshorts**: multi-generation encoding, linear tripod pan, heuristic and default-off speaker detection, Gemini dependence for layout stages, and a 600 KB monolith entangled with SaaS billing and a commercially licensed `cloud/` dir. Building on it means fighting its architecture.
- **autoclip**: the right architecture (resumable stage artifacts, single-pass export, shot-aware smoothing) and MIT. But it has one author, is unvalidated against its own reframe bar, and has heuristic active-speaker detection.
- **supoclip and clips-studio** contain the most sophisticated logic (boundary planner, TalkNet), but they are AGPL. Copying their code would make our pipeline AGPL.

**Recommendation: build a custom pipeline, using autoclip's architecture as the skeleton** (MIT, so it can be forked or vendored). Swap in better components and borrow specific ideas.

**Worth borrowing (MIT, code can be reused with attribution)**
- autoclip
  - `backend/autoclip/pipeline/export.py`: single-pass filtergraph render (trim, crop, lanczos, concat, `ass=`) and the relative-path trick for Windows filter escaping.
  - `backend/autoclip/pipeline/boundaries.py`: sentence snap, duration clamp and silence alignment.
  - `backend/autoclip/pipeline/reframe/smoothing.py`: One-Euro filter, dead zone and velocity clamp.
  - `backend/autoclip/pipeline/reframe/croppath.py` + `scenes.py`: per-shot piecewise crop expressions with no interpolation across cuts.
  - `backend/autoclip/prompts/highlight_v1.txt` + `pipeline/highlights.py`: word-index contract, rubric and windowing/dedupe.
  - `backend/autoclip/pipeline/captions.py`: ASS presets (bold_pop, karaoke_fill).
  - `backend/autoclip/providers/base.py`: schema-retry loop.
- openshorts (MIT core only; avoid `cloud/`)
  - `main.py` `SmoothedCameraman.update_target` / `begin_scene`: jump confirmation and scene-cut snap policy.
  - `clip_selection.py` + `docs/architecture/clip-selection.md`: rank-all-windows then shortlist funnel, clip floor.
  - `split_layout.py` guards and seam captions (`subtitles.generate_ass` `{\an5}`); `hook_placement.py`: hook position that avoids faces.
  - `burned_subtitles.py`: detect and trim existing burned-in subtitle bands.
  - `ffmpeg_utils.py` loudnorm comments: the true-peak overshoot findings.
- PeakCut `studio/transcribe.py`: Parakeet through sherpa-onnx with several CPU model copies (good CPU ASR throughput).
- TalkNet-ASD (MIT, https://github.com/TaoRuijie/TalkNet-ASD), used directly. Follow clips-studio's *approach*: detect at 8 fps, interpolate boxes to 25 fps, cut on speaker change and ignore turns under 1 s. Re-implement that adapter rather than copying the AGPL `video/asd.py`.

**Ideas only (AGPL, do not copy code)**
- supoclip: boundary-strength scoring, filler/pause cleanup and the quality issue list (#280–#293) as a test checklist.
- clips-studio: the TalkNet integration notes and audio/visual event fusion for highlights.

**Our own additions** (none of the repos do these):
- Encode once from the source at CRF 16–18 `slow`.
- Two-pass loudnorm.
- Preserve source fps.
- An offline (whole-clip) smoothing pass.
- An AV active-speaker model instead of mouth-motion heuristics.
- A golden-set evaluation for reframing (autoclip's §6.4 bar is a good spec: no visible jitter, no cut-off faces, speaker on screen ≥95 % of speaking time).

---

## 5. Not verified / caveats

- No tool was run. All quality judgements come from code, docs and issues, not from watching output.
- AssemblyAI and Gemini prices are from repo comments and memory, not today's pricing pages. CPU speed figures are estimates.
- clips-studio: I did not read `video/cropper.py` or `video/cutter.py`. The encode-generation count (≥2) is inferred from its repo-map doc (`docs/platform/repo-map/10-video-ffmpeg-render.md`).
- supoclip: the exact number of encodes in every layout path was not traced; two are confirmed (intermediate CRF 16 and final CRF 19).
- Star counts for PeakCut (394 in 1 day) and the openshorts issue spam suggest inflated or SaaS-driven popularity. Popularity is not a quality signal here.
- Autocrop-vertical's licence: the API returns none. Treat it as all-rights-reserved.
