# 04 — Reframing: face detection, active-speaker detection, smart 9:16 cropping

Research date: 2026-11-15. Repo metadata (stars / last push / license) pulled live with `gh api` on that date.
Legend: **[V]** verified by reading the repo/docs; **[P]** number taken from the paper/README, not re-measured; **[EST]** my estimate for the target laptop (Intel i7-8665U, 4C/8T, 15 W, no NVIDIA GPU, 24 GB RAM). Nothing was installed or run, so all CPU timings are estimates. **[UNVERIFIED]** means I could not confirm it.

---

## 0. TL;DR

* **Nobody ships a reframer that meets a top-tier bar out of the box.** The best open implementation I read is **mutonby/openshorts** (MIT, 8.4k stars, very active). It is pragmatic and measured: MediaPipe faces, a dead-zone "heavy tripod" camera, jump confirmation, a reset at each scene cut, SPLIT/GENERAL layouts, and an optional mouth-motion + audio-RMS speaker signal. **ClipsAI** (MIT, last commit Jan 2024) does a static crop per diarized segment (MTCNN + MediaPipe FaceMesh mouth-aspect-ratio). Use it as a reference only: it breaks on MediaPipe ≥0.10.30. **AI-Youtube-Shorts-Generator** uses a Haar cascade + the largest face + EMA 0.15 locally, or a paid MuAPI call. Don't use it.
* **Recommended stack (all permissive licences, CPU-feasible):**
  1. PySceneDetect `AdaptiveDetector` (BSD-3) for shots. Add TransNetV2 (MIT) optionally, for dissolves.
  2. **YuNet** (OpenCV Zoo, MIT) face detector with 5 landmarks, run on a 640-px proxy.
  3. IoU/ByteTrack tracking (MIT, via `supervision`).
  4. **Light-ASD** (MIT, ~1M params, 94.1 mAP AVA) or **LR-ASD** (MIT, 94.5 mAP, better Columbia F1) per face track, **fused with pyannote diarization** to keep speaker identity across camera angles.
  5. A layout state machine per shot: TRACK / TWO-IN-FRAME / SPLIT-stack / FIT.
  6. An **offline L1-optimal camera path** (Grundmann et al. 2011) per shot. It gives static holds and constant-velocity pans. Do a hard cut, never a whip-pan, when the speaker changes across the frame.
  7. Render from the **highest-resolution source** with ffmpeg crop+lanczos.
* **Upscaling:** get 4K/1440p sources whenever they exist. A 4K crop is 1215×2160, which you *downscale* to 1080×1920 for a strictly better result. For 1080p sources, use lanczos + light sharpening. **Do not use Real-ESRGAN on real faces by default**: it hallucinates skin texture, flickers frame-to-frame, and is impractical on this CPU (hours per clip [EST]). If you do want it, run it on a cloud GPU (about $0.02–0.10 per clip [EST]).

---

## 1. Face detectors

| Detector | Licence (code / weights) | Maintenance | WIDER-Face val AP (Easy/Med/Hard) | Landmarks | CPU on i7-8665U, 640×360 [EST] | 60 s @30 fps, every frame [EST] | Notes |
|---|---|---|---|---|---|---|---|
| **YuNet** (OpenCV Zoo, `cv2.FaceDetectorYN`) | MIT / MIT **[V]** | opencv_zoo pushed 2026-10-20; new `2026may` dynamic-shape ONNX **[V]** | 0.884 / 0.866 / 0.750 (zoo eval) **[V]**; paper says 0.834/0.824/0.708 **[V]** | 5 pts | ~4–8 ms | ~10–20 s | Already in OpenCV, no extra deps. Used by zhouxiaoka/autoclip. Weaker on tiny or profile faces, which don't matter much in podcasts. **Recommended.** |
| **MediaPipe BlazeFace** (Tasks API) | Apache-2.0 **[V]** | Very active (37.7k stars, pushed 2026-11-14) | Not published on WIDER | 6 pts | ~2–5 ms (Pixel 6 CPU 2.94 ms short-range **[V]**) | ~5–10 s | Short-range, full-range and sparse full-range models are now all "Latest" per docs **[V]**. 128×128 input, so small or far faces in wide shots get missed. **Legacy `mp.solutions` was removed in 0.10.30** **[V]** (issue #6192), which breaks ClipsAI and openshorts unless pinned. |
| **SCRFD** (InsightFace) | Code MIT, **weights non-commercial research only** **[V]** | insightface pushed 2026-10 | SCRFD-2.5G 93.8/92.2/77.9; 10G 95.2/93.9/83.1 (VGA protocol) **[V]** | 5 pts (_KPS) | 2.5G: ~15–25 ms; 500M: ~8 ms (README: 28 ms single-thread at 640×480 **[V]**) | ~30–45 s | Most accurate light model, but the **licence rules it out for a monetised channel** unless you retrain or get a commercial licence from InsightFace. |
| **RetinaFace** (serengil/retinaface, InsightFace R50 weights) | Code MIT; weights derive from InsightFace (non-commercial) **[V for insightface policy; derivation UNVERIFIED for serengil]** | pushed 2026-10 | R50 94.9/91.9/64.2 (SCRFD table, VGA) **[V]** | 5 pts | R50: 200–500 ms; MNet0.25 ~15–25 ms | R50: 7–15 min | Too slow on this CPU and has a licence cloud. |
| **YOLOv8-face** (derronqi / akanametov) | **GPL-3.0** repo; Ultralytics runtime **AGPL-3.0** **[V]** | akanametov active (2026-09) | ~94.6/92.9/80 (README claims **[UNVERIFIED]**) | 5 pts | n-model ~20–40 ms | ~1 min | Good accuracy, but copyleft. Fine only if the pipeline is never distributed or offered as a SaaS (AGPL network clause). |
| **S3FD** (bundled in TalkNet / Light-ASD demos) | MIT (repo) | stale | ~94/93/85 **[P]** | none | VGG16: ~150–400 ms at 480×270 | 5–10 min | It's the slow part of the ASD demos. Replace it with YuNet. |
| **MTCNN** (facenet-pytorch, used by ClipsAI) | MIT | facenet-pytorch stale | ~85/82/61 **[P]** | 5 pts | ~30–80 ms | ~2 min | Outdated. |
| **Haar cascade** (AI-YT-Shorts-Generator) | BSD | — | far lower | none | ~10 ms | — | False positives and lost profiles cause jitter. Don't use. |
| **libfacedetection** (ShiqiYu, YuNet origin) | NOASSERTION in API (BSD-3 in repo **[UNVERIFIED]**) | pushed 2026-06 | same family as YuNet | 5 pts | fastest (C++, SIMD) | <10 s | Only if you need a C++ speedup. |

**Pick:** YuNet as the primary detector. MediaPipe full-range is a free second opinion. For "person present but face not visible" (a turned head), use a person/pose detector. Prefer **MediaPipe Pose/Object detector (Apache)** over YOLO (AGPL).

---

## 2. Active-speaker detection (ASD)

AVA-ActiveSpeaker validation mAP (AVA is movie footage; podcasts are easier because faces are frontal and large):

| Model | AVA val mAP | Columbia F1 avg | Params | Licence | Last push | Inference on arbitrary video? | CPU feasibility, 60 s / 2 faces [EST] |
|---|---|---|---|---|---|---|---|
| **TalkNet** (TaoRuijie, ACM MM'21) | 92.3 (test 90.8) **[V]** | ~85 (TalkSet model) **[P]** | ~15 M | MIT | 2023-10 | **Yes**: `demoTalkNet.py` (S3FD + scenedetect + IoU tracker); CPU = swap `cuda`→`cpu` (issue #56) **[V]** | Model ~30–90 s; with S3FD +5–10 min; with YuNet ~1–2 min |
| **sieve-community/fast-asd** (optimised TalkNet) | same as TalkNet | — | ~15 M | MIT | 2024-05 | **Yes**. Faster pre/post, supports variable fps **[V]**. The full app calls Sieve-hosted YOLO (needs an account) **[V]**. | as above |
| **Light-ASD** (CVPR'23) | **94.06** **[V]** | 81.1 (AVA model) **[V]** | ~1.0 M **[P]** | MIT | 2025-03 | **Yes**: `Columbia_test.py --videoName X --videoFolder demo` (TalkNet-style pipeline, hard-coded `cuda`, S3FD) **[V]**. The author says swap S3FD for speed (issue #9) **[V]**. No ONNX. | Model ~5–20 s; **best CPU choice** |
| **LR-ASD** (IJCV'25, same author) | **94.45** **[V]** | **86.1** (AVA model), ~88+ with TalkSet fine-tune **[V]** | ~0.8–1 M **[P/UNVERIFIED]** | MIT | 2025-03 | **Yes**: same `Columbia_test.py` + `finetuning_TalkSet.model` **[V]** | ~5–20 s. **Primary recommendation** (better in-the-wild F1). |
| **LoCoNet** (CVPR'24) | 95.2 **[P]** | — | ~34 M **[P]** | **no licence file** **[V]** | 2023-05 | No. AVA train/eval only; weights on Google Drive **[V]** | heavy; needs all faces per frame |
| **TalkNCE** (ICASSP'24, LoCoNet + TalkNCE loss) | **95.5** **[V]** | — | ~34 M | MIT | 2025-04 | No. `test_multicard.py` on AVA only **[V]** | heavy |
| **SPELL** (ECCV'22, graph) | 94.2 **[P]** | — | small graph, but needs pre-extracted 2D-ResNet A/V features | MIT | 2023-10 | No (feature-based pipeline) **[V]** | not practical |
| **SyncNet** (joonson/syncnet_python) | n/a (A/V sync confidence) | used as baseline | ~13 M | MIT | 2026-04 | Yes. Gives an offset/confidence per track. | ~1–2 min; good **sanity check** for dubbed or out-of-sync audio |
| Mouth-motion heuristics (ClipsAI MAR, openshorts frame-diff + audio gate) | none published | — | 0 | MIT | — | Yes | seconds; error-prone on laughs, nods, chewing |

Others found: clovaai/lookwhostalking (76★, 2023), Jiang-Yidi/TS-TalkNet (target-speaker), and **UniTalk** (Interspeech 2026 in-the-wild ASD benchmark; it reports that AVA-trained models generalise worse in the wild; no licence **[V]**). Hosted: Sieve `active_speaker_detection` at ~$3.90/h processed and Sieve `autocrop` at $6.63/h (legacy page). The FAQ quotes $1.26/h. **PAID**, about $0.02–0.11 per 60-s clip, current pricing **[UNVERIFIED]**.

**Known ASD weaknesses** that matter here:
1. A speaker who is off-screen in the current shot. ASD says nobody is speaking; diarization says someone is.
2. Small faces in wide shots: below ~40 px the 112×112 crop gets mushy.
3. Laughing, eating, lip-sync-less B-roll.
4. Models score each track in isolation (except LoCoNet), so two simultaneous talkers both score high.
5. All the demos resample to 25 fps.

**Fusion with diarization** (strongly recommended):
* Run pyannote on the **whole source once** (see 02-transcription-diarization.md). For each diarization speaker S and each face track T, compute overlap = Σ over frames where S is active of ASD_logit(T).
* Hungarian-assign speakers to *face identities*. Cluster tracks across shots with a face embedding: OpenCV Zoo **SFace** (Apache-2.0 **[UNVERIFIED]**) is OK; avoid the InsightFace ArcFace weights (non-commercial).
* Then, at each frame, the speaker is the diarization label (robust to off-screen speech and laughs), and the *frame region* is that identity's face track if it's visible in the shot.
* If the identity isn't visible (multicam cut to the listener), **keep the listener shot**. Reaction shots are what the editor chose.
* When ASD and diarization disagree for more than 1 s, trust ASD inside the shot. Diarization overlaps and short back-channels ("yeah") are noisy.

---

## 3. Shot detection

| Tool | Licence | Status | Accuracy | CPU on a 60 s clip [EST] | Notes |
|---|---|---|---|---|---|
| **PySceneDetect** (`AdaptiveDetector` / `ContentDetector`) | BSD-3 | Very active (5.5k★, pushed 2026-11-13) **[V]** | Good on hard cuts; weak on dissolves | 5–10 s at downscale | Used by openshorts (ContentDetector), ClipsAI (own PyAV implementation), and the TalkNet/Light-ASD demos **[V]**. |
| **TransNetV2** | MIT | Stale (2023-12) but stable; PyTorch inference folder exists **[V]** | F1 ClipShots 77.9 / BBC 96.2 / RAI 93.9 **[P]** | ~15–40 s (48×27 input) | Better on dissolves and fast cuts; adds TF/torch. |
| ffmpeg `select='gt(scene,0.3)'` | LGPL | — | OK | ~5 s | zhouxiaoka/autoclip uses this plus its own dissolve check **[V]**. |
| AutoFlip `shot_boundary_calculator` | Apache | Support ended **[V]** | — | — | reference only |

**Pick:** PySceneDetect `AdaptiveDetector` with min shot 0.4 s. Keep 0.3 s of margin around cuts when sampling, as autoclip does: transition frames give wrong readings. TransNetV2 is the upgrade if dissolves show up.

---

## 4. Tracking and camera-path smoothing

### 4a. Trackers (link detections into per-person tracks)

| Tool | Licence | Status | Fit |
|---|---|---|---|
| Simple IoU tracker (TalkNet demo) | MIT | — | Enough for seated podcast guests inside a shot. |
| **ByteTrack** (FoundationVision) | MIT | 2024-06 | Robust to low-confidence frames. Use the **`supervision`** implementation (roboflow, MIT, 51.6k★, active **[V]**). |
| BoT-SORT | MIT | 2024-08 | Adds camera-motion compensation and ReID. Overkill for static podcast cams. |
| **norfair** | BSD-3 | 2025-04 | Easy Kalman tracker on points/boxes; nice API. |
| BoxMOT | **AGPL-3.0** **[V]** | active | Avoid (licence). |

Within one shot, faces in podcasts barely move, so ByteTrack/IoU plus gap interpolation (≤10 frames) is enough. Re-identify across shots with face embeddings, not trackers.

### 4b. Camera-path smoothing

| Method | Causal? | Look | Notes |
|---|---|---|---|
| EMA (AI-YT-Shorts-Generator: α=0.15 per frame **[V]**) | yes | laggy, constant micro-drift | Cheapest. Detector jitter leaks through. |
| **Dead-zone + capped linear pan + jump confirmation** (openshorts `SmoothedCameraman` **[V]**) | yes | "tripod operator" | Safe zone = 25% of crop width. A big jump must repeat 3 detections (JUMP_CONFIRM). Pan at 3 px/frame, or 15 px/frame if the distance is more than half the crop. Snap on scene cut. The authors measured reversals dropping 0.41→0.13/s with confirm=3 **[V]**. |
| One-Euro filter (Casiez 2012) | yes | adaptive: steady when still, responsive when moving | Good for any *live* path; 2 params. |
| Kalman (constant-velocity) | yes | smooth but overshoots | norfair has one. |
| Savitzky-Golay / Gaussian (offline) | no | smooth, but never perfectly static | Leaves "breathing" motion that viewers notice. |
| **AutoFlip** (`scene_camera_motion_analyzer`, `kinematic_path_solver`, `polynomial_regression_path_solver` **[V]**) | no | picks **stationary / panning / tracking** mode per scene | Best conceptual reference. Support ended in March 2023; code is still in the repo, needs Bazel + OpenCV 3 **[V]**. |
| **L1-optimal camera path** (Grundmann, Kwatra, Essa, CVPR 2011, the YouTube stabilizer) | no | **piecewise static / constant-velocity / constant-acceleration segments**: looks like a real operator | Minimise w1‖D¹p‖₁ + w2‖D²p‖₁ + w3‖D³p‖₁ + λ‖p − target‖₁, subject to the face box staying inside the crop with a margin. It's an LP, ~1800 variables per minute, so <1 s with `scipy.optimize.linprog` (HiGHS) or `cvxpy` [EST]. **Recommended.** |

---

## 5. Existing reframe implementations (code read)

| Project | Licence / activity | Detection | Speaker choice | Smoothing / camera | Layouts | Verdict |
|---|---|---|---|---|---|---|
| **mutonby/openshorts** (`main.py`, `reframe_v2.py`, `active_speaker.py`, `split_layout.py`, `layout_picker.py`) | MIT, 8.4k★, pushed 2026-11-14 **[V]** | MediaPipe face detection (legacy `mp.solutions`, so pinned) + **YOLOv8n person fallback (AGPL dep)** on a ≤640-px analysis pass **[V]** | `SpeakerTracker`: size-based score with 0.85 decay, ×3 sticky bonus, 15-frame stabilisation, 30-frame cooldown. Optional `SPEAKER_SIGNAL`: mouth-region frame-diff per 0.4 s window, normalised per person (20–80 percentile), gated by audio RMS ≥0.18 of peak, MIN_SHARE 0.2 to justify SPLIT **[V]** | Dead-zone tripod + jump confirmation + `begin_scene()` reset/snap at cuts **[V]** | TRACK, GENERAL (blurred bg), SPLIT, SCREENCAST, INSET, WIDE. Optional **Gemini picks the layout** from 12 frames at 1024 px: 92–96% on their 48-clip set, ~$0.002/video (**PAID, tiny**) **[V]**. Renders via ffmpeg **`sendcmd` dynamic crop** **[V]** | **Best reference.** Lots of real-footage tuning notes in comments. Weaknesses: no real ASD, causal smoothing, size-based speaker choice when the mouth signal is off. |
| **ClipsAI/clipsai** (`resize/resizer.py`) | MIT, 571★, **last push 2024-01** **[V]** | MTCNN (facenet-pytorch) on 13 sampled frames per diarized segment **[V]** | pyannote diarization segments ∩ scene changes. KMeans over face boxes (k = max faces), pick the cluster with the largest summed Δ mouth-aspect-ratio (MediaPipe FaceMesh landmarks), fall back to the most frequent face **[V]** | **None: one static crop per segment.** Adjacent segments within 4% of width are merged **[V]** | crop only | Sound concept (diarization + mouth), crude execution. Hard cuts at every speaker turn, no in-shot tracking, MediaPipe `solutions` API now removed. |
| **Anil-matcha (ex-SamurAIGPT)/AI-Youtube-Shorts-Generator** | MIT, 6.1k★, active **[V]** | Hosted: **MuAPI `/autocrop` (PAID)**. Local: OpenCV Haar cascade **[V]** | Largest face **[V]** | EMA α=0.15 per frame **[V]** | crop only | Not top-tier quality. |
| **zhouxiaoka/autoclip** (`backend/services/studio/framing.py`, 1.5k lines) | MIT, 10.5k★, pushed today **[V]** | **YuNet** (bundled 2023mar ONNX) at 480 px; ffmpeg scene score 0.3 + dissolve detector **[V]** | Mouth motion (grey diff over 0.25 s pairs, threshold 4.0). Frontal vs turned head via landmark geometry (nose-outside-eyes); rejects backs of heads; transcript speaker cues **[V]** | Shot-based: **jumps on a cut, eases 0.45 s on an in-shot speaker change**, drops reversals <0.8 s, MIN_HOLD 2 samples, min segment 1.2 s **[V]** | `crop` or `fit` (blurred backdrop for groups / no face) | Good engineering for edge cases (turned heads, groups). Samples ~1/s, so coarse. |
| **haziqahmedqasmi/PeakCut** (`studio/render.py`) | MIT, 394★ **[V]** | none | none | none | Centre crop / blur-fill / zoom-fill via ffmpeg **[V]** | No smart reframing. |
| **modelscope/FunClip** | MIT, 6.6k★ **[V]** | none | none | none | none | ASR/LLM clipping only. No reframing (file tree has no crop/face code **[V]**). |
| **TalkNet / Light-ASD demo pipelines** | MIT | S3FD every frame | ASD per track | none (they visualise boxes only) | — | The building blocks for the ASD stage. |
| AutoFlip (MediaPipe) | Apache, support ended 2023-03 **[V]** | faces + objects + saliency signals fused | "important" signals | stationary/panning/tracking per scene, polynomial path | crop + padding | Concept reference. Building it on Windows (Bazel, OpenCV 3) isn't worth it. |
| DaVinci Resolve Smart Reframe | Closed, **Studio only (~$295 one-time, PAID)** | proprietary | object of interest; manual reference point | auto | crop only | Reference only. Not scriptable in batch via the Resolve API **[UNVERIFIED]**. |
| Kdenlive / Shotcut | GPL | Shotcut "Motion Tracker" filter, Kdenlive object masking/tracking **[UNVERIFIED versions]** | manual | manual | — | Manual tools; not automatable. |
| Paid APIs: Sieve autocrop, MuAPI autocrop, OpusClip/Vizard ReframeAnything | **PAID** | — | ASD-based (Sieve uses TalkNet **[V]**) | — | — | Sieve ≈ $0.02–0.11 per 60 s clip **[UNVERIFIED current price]**. Not clearly better than the design below. |

---

## 6. Recommended reframing design

All stages work on a **640-px-wide, 25 fps analysis proxy**. Only the final render touches full resolution.

### Stage 0: source
Download the highest available resolution (4K > 1440p > 1080p; VP9/AV1 is fine). Keep the original for rendering and make the proxy with `ffmpeg -vf scale=640:-2,fps=25`.

### Stage 1: shots
Run PySceneDetect `AdaptiveDetector` on the clip range ± 2 s. Merge shots <0.4 s into their neighbour, and exclude ±0.3 s around each cut from statistics.

### Stage 2: faces
* Run YuNet on every proxy frame (score ≥0.7 for crop centres; ≥0.45 is enough to count people), keeping the 5 landmarks.
* Reject boxes wider than 55% of the frame, edge-stuck boxes, and faces narrower than 3.5% of frame width. These thresholds come from autoclip's tested values.
* Add a frontal/turned flag from landmark geometry.

### Stage 3: tracks
* ByteTrack (`supervision`) per shot. Interpolate gaps ≤10 frames and drop tracks <0.5 s.
* Re-identify tracks across shots with an SFace embedding plus diarization co-occurrence. That gives stable identities ("Host", "Guest") for the whole video.

### Stage 4: who is speaking
* **Primary:** **LR-ASD** (or Light-ASD) scores per track per frame. Feed it 112×112 grey face crops plus MFCC; it's the TalkNet-style pipeline with S3FD replaced by our tracks.
* **Fusion:** pyannote diarization of the full source → identity mapping (section 2) → a per-frame speaker posterior.
* **Temporal model:** a 2–4-state HMM/Viterbi per shot with a switch penalty. Minimum speaker hold 1.0 s, and ignore back-channels <0.7 s. Because processing is offline, **move switch points ~0.15–0.25 s earlier** so the cut lands on the speech onset, like a human editor.
* **Fallback when ASD isn't available or confident:** openshorts-style mouth-region motion, normalised per person and gated by audio RMS.

### Stage 5: layout per shot
Pick one layout per shot and change it only at cuts or confirmed speaker turns. Minimum layout duration is 2 s; otherwise keep the previous layout.

| Condition | Layout |
|---|---|
| 1 usable face, or the speaker's face clearly identified | **TRACK**: 9:16 crop following the speaker |
| 2 faces whose union box fits in ~85% of the crop width (607 px at 1080p) | **TWO-IN-FRAME**: one crop centred on the pair |
| 2 faces too far apart **and** both talk (each ≥20% of the shot's speech, or ≥1 turn per 8 s) | **SPLIT-stack**: two 1080×960 panels. Keep a fixed spatial order (left person on top) for the whole clip. Optionally a subtle highlight on the current speaker. |
| 2 faces too far apart, one silent listener | **TRACK** on the speaker; hard-cut between people on turns |
| ≥3 faces, wide/establishing shot, no usable face, slides or screen | **FIT**: full frame scaled to 1080 wide on a blurred, darkened backdrop. Or a WIDE centre crop if the faces cluster. |

Note on SPLIT quality: each 1080×960 panel needs only a ~960×853 region from a 1080p source, a ~1.1× upscale. **SPLIT is nearly lossless, while TRACK needs a 1.78× upscale.** That's an extra argument for SPLIT on 1080p two-shots.

### Stage 6: camera path (per shot, offline, per layout panel)
1. **Target.** Speaker face centre-x. Vertically, place the eyes ~38–42% from the top of the crop when there's vertical slack; at full height, y is fixed.
2. **Hard constraint.** The face box plus a 10% margin must stay inside the crop. Clamp to the frame.
3. **Solve the L1-optimal path** separately for x (and y/zoom if used), with weights roughly w1=10, w2=1, w3=100 as in Grundmann. The result is static holds, plus constant-velocity pans when the subject actually drifts. Treat these as tuning starting points.
4. **Speaker change inside a shot.**
   * If the new target is within 1/3 of the crop width: ease 0.4–0.5 s, cosine.
   * Otherwise: **hard cut** in the crop, on the speech onset. Never whip-pan across the frame.
5. **At shot boundaries.** Reset with no carry-over and snap to the new shot's first accepted target. This is openshorts' `begin_scene()` lesson.
6. **QA metrics per clip.** Log these and fail the clip, or fall back to FIT, past a threshold:
   * % of frames with the speaker face fully inside the crop (target >98%)
   * crop velocity p95
   * direction reversals/s (target <0.15/s, openshorts' measured number)
   * wrong-speaker rate vs diarization

### Stage 7: render
* Per shot, use ffmpeg `crop` with per-frame x via **`sendcmd`** (as openshorts does), or `crop=x='expr'`. Then `scale=1080:1920:flags=lanczos`, x264 `-crf 16–18 -preset slow`, yuv420p, audio copied.
* SPLIT: two crops → `vstack`.
* Integer crop x can show 1-px stepping on very slow pans. Either keep pans ≥1 px/frame (natural with the L1 path) or render with PyAV + `cv2.warpAffine` for sub-pixel accuracy.

### CPU budget for a 60 s 1080p30 clip on the i7-8665U [EST]

| Step | Time |
|---|---|
| Proxy decode | 5–10 s |
| Shots | 5–10 s |
| YuNet on 1500 proxy frames | 10–20 s |
| Tracking | <2 s |
| LR-ASD / Light-ASD, 2–3 tracks | 10–40 s |
| Diarization | amortised; done once per source (see 02) |
| Path solve | <1 s |
| **x264 slow render at 1080×1920** | **60–150 s**, the dominant cost; `-preset medium` halves it |

That's **~2–4 min per clip**, fine for batch work overnight. With TalkNet instead of LR-ASD, add ~1 min; with the stock S3FD demo, add 5–10 min. A cloud GPU isn't needed for reframing. If wanted, a RunPod/Vast RTX 4090 at ~$0.3–0.7/h runs the analysis in ~10–20 s per clip [EST].

---

## 7. Upscaling recommendation

* **The problem.** 1080p 16:9 → a 607×1080 region → 1080×1920 is a 1.78× upscale. Worse, YouTube 1080p streams are ~2–5 Mbps, so you're enlarging compression artefacts too.

**Options, in order of preference:**

1. **Get a higher-resolution source.** It's free and gives the best result.
   * 4K (3840×2160) → a 1215×2160 crop → **downscale** to 1080×1920: supersampled and sharper than native.
   * 1440p → 810×1440 → a 1.33× upscale, mild.
   * Many top podcasts upload in 4K. Make `yt-dlp -f "bv*[height>=2160]+ba/bv*+ba"` the default (see 06-download-ingest.md).
   * It costs download size and decode time: 4K VP9/AV1 decode on this CPU runs ~30–60 fps [EST], fine for one render pass. Analysis still runs on the proxy.
2. **1080p sources: classical upscaling.**
   * `scale=1080:1920:flags=lanczos` (or `zscale` spline36), then light sharpening: `unsharp=5:5:0.4` or `cas=0.3`. Optionally `hqdn3d=1:1:3:3` *before* scaling to calm blocking.
   * Encode at high quality (CRF 16–18). YouTube Shorts re-encodes, and a clean, high-bitrate upload survives better.
   * Cost is essentially zero.
3. **Real-ESRGAN** (BSD-3, 37.5k★, last push 2024-08 **[V]**). Use it selectively, not by default.
   * Quality: frame-independent GAN SR causes **temporal flicker** and **waxy, over-smoothed skin or hallucinated texture** on real faces. That reads as "AI-processed" on a premium channel.
   * Best candidate: `realesr-general-x4v3` (tiny model, `-dn` denoise-strength control **[V]**), run at 2× rather than 4×.
   * CPU speed: PyTorch `RealESRGAN_x4plus` on this CPU ≈ 5–20 s per frame → **3–10 h per 60 s clip [EST], infeasible**. The portable **realesrgan-ncnn-vulkan** binary supports Intel GPUs **[V]**; on the UHD 620 iGPU, general-x4v3 ≈ 0.5–2 s per frame → **15–60 min per clip [EST]**.
   * Cloud GPU: RTX 4090 / A10G at ~$0.4–1.0/h does a 1800-frame clip in ~2–6 min → **~$0.02–0.10 per clip [EST]**.
   * Face restorers: GFPGAN (37.7k★, NOASSERTION licence) and **CodeFormer (NTU S-Lab licence, non-commercial **[V]**)**. Avoid CodeFormer for a monetised channel. Both change identity subtly and flicker.
   * Video-native SR (BasicVSR++/RealBasicVSR, temporally consistent): GPU-only in practice **[UNVERIFIED licence for commercial use]**.
4. **Bottom line.** Use 4K source when available, lanczos + mild sharpen otherwise. Consider Real-ESRGAN only after an A/B test on real clips viewed on a phone; it needs a cloud GPU and should be `general-x4v3` at 2× with denoise around 0.5.

---

## 8. Evidence links

* MediaPipe legacy solutions support ended 2023-03-01, AutoFlip listed "Support ended": https://developers.google.com/edge/mediapipe/solutions/guide
* `mp.solutions` removed from 0.10.30: https://github.com/google-ai-edge/mediapipe/issues/6192
* MediaPipe Tasks face detector (short/full/sparse models): https://developers.google.com/edge/mediapipe/solutions/vision/face_detector
* AutoFlip code: https://github.com/google-ai-edge/mediapipe/tree/master/mediapipe/examples/desktop/autoflip
* YuNet: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
* SCRFD table + InsightFace licence: https://github.com/deepinsight/insightface/tree/master/detection/scrfd , https://github.com/deepinsight/insightface#license
* TalkNet: https://github.com/TaoRuijie/TalkNet-ASD (CPU: issue #56)
* fast-asd: https://github.com/sieve-community/fast-asd
* Light-ASD: https://github.com/Junhua-Liao/Light-ASD (speed and S3FD: issue #9)
* LR-ASD: https://github.com/Junhua-Liao/LR-ASD
* LoCoNet: https://github.com/SJTUwxz/LoCoNet_ASD
* TalkNCE: https://github.com/kaistmm/TalkNCE
* SPELL: https://github.com/SRA2/SPELL
* UniTalk: https://github.com/plnguyen2908/UniTalk-ASD-code
* openshorts: https://github.com/mutonby/openshorts (`main.py` SmoothedCameraman/SpeakerTracker, `active_speaker.py`, `reframe_v2.py`, `layout_picker.py`)
* ClipsAI resizer: https://github.com/ClipsAI/clipsai/blob/main/clipsai/resize/resizer.py
* AI-Youtube-Shorts-Generator local clipper: https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator/blob/main/shorts_generator/local/clipper.py
* autoclip framing: https://github.com/zhouxiaoka/autoclip/blob/main/backend/services/studio/framing.py
* PeakCut render: https://github.com/haziqahmedqasmi/PeakCut/blob/main/studio/render.py
* PySceneDetect: https://github.com/Breakthrough/PySceneDetect
* TransNetV2: https://github.com/soCzech/TransNetV2
* ByteTrack: https://github.com/FoundationVision/ByteTrack
* supervision: https://github.com/roboflow/supervision
* norfair: https://github.com/tryolabs/norfair
* BoxMOT (AGPL): https://github.com/mikel-brostrom/boxmot
* Grundmann et al., "Auto-Directed Video Stabilization with Robust L1 Optimal Camera Paths", CVPR 2011: https://research.google/pubs/auto-directed-video-stabilization-with-robust-l1-optimal-camera-paths/
* One-Euro filter: https://gery.casiez.net/1euro/
* Real-ESRGAN: https://github.com/xinntao/Real-ESRGAN
* CodeFormer licence: https://github.com/sczhou/CodeFormer
* Sieve pricing: https://www.sievedata.com/pricing , https://sievedata.com/functions/sieve/autocrop
