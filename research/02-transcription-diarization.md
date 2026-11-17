# 02 — Transcription, Word-Level Timestamps and Speaker Diarization

Research date: 2026-11-15. Scope: turning 1–2 h English podcasts/interviews into 9:16 clips where (a) cuts land on sentence/thought boundaries, (b) captions are word-timed and animated, and (c) diarization drives the active-speaker reframer.

Legend: **[V]** = verified this session from repo/model card/vendor page; **[3P]** = third-party or vendor-self-reported number, not independently verified; **[EST]** = my estimate, not measured; **PAID** = paid service.

Target machine: Intel i7-8665U (4C/8T, 15 W Whiskey Lake, AVX2, no AVX-512), 24 GB RAM, no NVIDIA GPU. All CPU timings below for this machine are **[EST]**, extrapolated from published benchmarks on faster CPUs (roughly 3–4x slower than an i7-12700K with 8 threads, ~2x slower than an Apple M2 Pro CPU). Benchmark on a real episode before committing.

---

## 1. TL;DR recommendation

| Goal | Recommended stack | Why |
|---|---|---|
| **Best quality (any cost)** | Run a bake-off on 3 representative episodes between: **(A)** ElevenLabs Scribe v2/v3 (PAID, single call: words + timings + diarization + audio events) with diarization overridden by **pyannoteAI Precision** (PAID), and **(B)** self-hosted on cloud GPU: **Parakeet-TDT-0.6B-v2** or **Whisper large-v3 (WhisperX)** for text, word re-timing by forced alignment, **pyannote community-1 / pyannoteAI Precision** or **NVIDIA Nemotron-3-Diarization** for speakers. | No single benchmark compares these on podcast audio. Paid APIs are cheap enough ($0.2–0.5/h) that cost is irrelevant at this quality bar; diarization DER is where the big quality gaps are (Precision ~25–35% lower DER than open pyannote). |
| **Best free, this no-GPU laptop** | **faster-whisper/WhisperX `large-v3-turbo` int8 (VAD-batched) + wav2vec2 forced alignment + pyannote `speaker-diarization-community-1` (exclusive mode)**. Alternative ASR: **Parakeet-TDT-0.6B-v2 via ONNX** (much faster on CPU, better leaderboard WER, native word timestamps). | Mature, MIT/BSD/CC-BY-4.0, commercially usable. Expect ~1–2 h ASR + ~1–3 h diarization per 1 h of audio [EST] — run overnight. |
| **Best cloud-GPU** | WhisperX (large-v3, wav2vec2 align, community-1) **or** NeMo (Parakeet-TDT + Nemotron-3-Diarization) on **Modal L4 ($0.80/h)** or A10 ($1.10/h). | ~3–6 min wall-clock per hour of audio [EST] → **≈ $0.05–0.10 per source hour**, plus cold-start. |

Key pitfalls to design around (all verified in issues/READMEs):
1. **Whisper drops / hallucinates on long audio** — always use VAD-chunked inference (WhisperX, faster-whisper `vad_filter`, CrisperWhisper's continuation); never feed a 2 h file to vanilla Whisper.
2. **Whisper's native word timestamps are DTW-on-cross-attention guesses** (often 100–500 ms off); use forced alignment (wav2vec2 / NeMo Forced Aligner / CTC-seg) or a model with native token timing (TDT, CrisperWhisper 2.0).
3. **WhisperX alignment cannot time tokens without alphabet chars** ("2014.", "£13.60") — words get no timestamp ([README Limitations](https://github.com/m-bain/whisperX#limitations)) [V]. Interpolate, or normalize numbers before alignment.
4. **Whisper "clean-verbatim" drops fillers** ("um", "uh", false starts) — this means word timings around disfluencies get smeared. For tight cut points, verbatim models (CrisperWhisper, Parakeet, Scribe) are better.
5. **Overlapping speech** is handled poorly by every ASR ([WhisperX README](https://github.com/m-bain/whisperX#limitations): "Overlapping speech is not handled particularly well by whisper nor whisperx") [V]. Use pyannote's **exclusive** diarization output to map each word to one speaker; avoid cutting a clip start/end inside an overlap region.

---

## 2. ASR comparison (open / self-hostable)

Open ASR Leaderboard (HF) English short-form average WER and RTFx (GPU), from the leaderboard paper snapshot [arXiv 2510.06961v3](https://arxiv.org/html/2510.06961v3) [V]. The live Space ([hf-audio/open_asr_leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)) did not render for automated fetch; newer models (Qwen3-ASR-1.7B ~5.4, Cohere Transcribe ~5.8, Granite Speech 4.1 ~5.3–6.0) are reported by secondary sites with inconsistent numbers [3P].

| Model / tool | Avg WER (OASR) | GPU RTFx | Word timestamps | Punct./casing | Fillers | Languages | License (code / weights) | CPU est. on i7-8665U for 1 h audio [EST] |
|---|---|---|---|---|---|---|---|---|
| Canary-Qwen-2.5B (NVIDIA) | **5.63** | 418 | No native word timing (LLM decoder) — needs external aligner | Yes | Partial | EN | Apache-2.0 / CC-BY-4.0 | Impractical (2.5B, LLM decoder): many hours |
| Parakeet-TDT-0.6B-v2 | 6.05 | 3386 | **Native** (TDT token durations), word + segment + char | Yes | Mostly verbatim | EN | Apache-2.0 / CC-BY-4.0 | ~6–15 min (ONNX int8) |
| Parakeet-TDT-0.6B-v3 | 6.32 | 3333 | Native word/segment/char [V] | Yes [V] | Mostly verbatim | 25 EU langs [V] | CC-BY-4.0 [V] | ~6–15 min |
| Canary-1B-Flash | 6.35 | 1046 | Yes (via NeMo timestamps) | Yes | — | EN/DE/FR/ES | CC-BY-4.0 | ~20–40 min |
| CrisperWhisper 2.0 (large) | 6.67 (v1 figure) | 84 | **Native, best measured boundary error 29.6 ms** (vendor) | Yes | **Yes, typed (filler/cutoff/sound)** | ~Whisper langs | MIT code / **Non-commercial weights** [V] | ~1.5–2.5 h (large); medium ~45–75 min |
| Whisper large-v3 (OpenAI / faster-whisper int8) | 7.44 | 146 | DTW cross-attention (approx.); use alignment | Yes (good) | **Drops most fillers** | 99 | MIT / MIT | ~1.5–2.5 h (VAD-batched int8) |
| Whisper large-v3-turbo | ~7.7–7.8 [3P] | ~5–6x large-v3 | as above | Yes | Drops fillers | 99 (weaker on some) | MIT / MIT | ~35–70 min |
| distil-large-v3.5 | 7.21 | 202 | as above | Yes | Drops fillers | EN only | MIT / MIT | ~30–60 min |
| whisper.cpp (any Whisper weights) | same as model | — | DTW token timestamps (experimental) | same | same | same | MIT | Similar to or slightly faster than faster-whisper on CPU |

CPU basis: faster-whisper README shows `small` int8 batch 8 transcribing 13 min in 51 s on i7-12700K/8 threads ([README benchmark](https://github.com/SYSTRAN/faster-whisper#benchmark)) [V]. large-v3 is ~6x the compute of small; the 8665U is ~3–4x slower → large-v3 ≈ 0.5–0.8x real-time. Parakeet CPU numbers are extrapolated from TDT's ~20x RTFx advantage over Whisper large on GPU; the model card gives no CPU benchmark [V].

### Word-timestamp methods compared

| Method | Used by | Typical accuracy | Notes |
|---|---|---|---|
| DTW over Whisper cross-attention | openai/whisper `word_timestamps`, faster-whisper, whisper.cpp | Worst; frequently 100–500 ms off, word ends stretched across pauses [3P, widely reported] | stable-ts improves this with silence suppression / regrouping |
| wav2vec2 CTC forced alignment | WhisperX | 64.8 ms mean boundary error on TIMIT (from CrisperWhisper's table [3P]) | Language-specific model; fails on digits/symbols; regression reported in v3.3.3–3.4.2 ([#1220](https://github.com/m-bain/whisperX/issues/1220), closed) [V] |
| NeMo Forced Aligner / CTC-seg | NeMo, ctc-forced-aligner | 49–60 ms [3P] | Good, works on any transcript text |
| Native TDT/transducer timing | Parakeet-TDT | Not on that table; generally frame-accurate at 80 ms resolution [EST] | No second pass needed |
| Supervised cross-attention + nyra aligner | CrisperWhisper 2.0 | **29.6 ms** [3P, vendor] | Also marks fillers/cut-offs — ideal for cut points, but NC license |

Vendor table (CrisperWhisper README, TIMIT read speech): CrisperWhisper 2.0 29.6 ms; xAI Grok STT 37.1; CTC-seg 49.3; ElevenLabs Scribe v2 51.3; NeMo-FA 60.0; Deepgram Nova-3 63.3; WhisperX 64.8; Canary 85.5 ([source](https://github.com/nyrahealth/CrisperWhisper)) [3P]. Read speech is easier than podcasts; relative ordering is the useful part.

---

## 3. Diarization comparison

DER %, lower is better, no collar unless noted.

| System | AMI-SDM | AMI-IHM | DIHARD3 full | VoxConverse | CALLHOME p2 | License | Gated? | CPU est. 1 h audio on i7-8665U [EST] |
|---|---|---|---|---|---|---|---|---|
| pyannote 3.1 (legacy) | 22.7 | 18.8 | 21.4 | 11.2 | 28.5 | MIT / MIT | HF gated | 1.5–3 h |
| **pyannote community-1** (4.x) | 19.9 | 17.0 | 20.2 | 11.2 | 26.7 | MIT / **CC-BY-4.0** [V] | **HF gated: accept conditions + token** [V] | ~1.5–3 h (M2 Pro CPU third-party RTF ≈0.82–0.86 [3P]) |
| pyannoteAI Precision-2 (PAID; Precision-3 now listed) | 15.6 | 12.9 | 14.7 | **8.5** | **16.6** | Commercial | API key | n/a (API) |
| DiariZen Large-s80-v2 (BUT) | 13.9 | — | 14.5 | 9.1 | — | MIT / **CC-BY-NC-4.0** [V] | No | ~3–6 h (WavLM-Large) |
| NVIDIA Sortformer 4spk v2.1 | 17.8 | 15.9 | 19.5 | — | 10.1 (0.25 s collar) | NVIDIA Open Model License [V] | No | Not designed for CPU; **max 4 speakers** |
| **NVIDIA Nemotron-3-Diarization** (Sep 2026) | — | 9.25 (MHM) | **12.7** | — | 9.1 | OpenMDW-1.1, commercial OK [V] | No | GPU-oriented; CPU untested |

Sources: pyannote README table ([repo](https://github.com/pyannote/pyannote-audio)) [V]; DiariZen README ([repo](https://github.com/BUTSpeechFIT/DiariZen)) [V]; [Sortformer card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1) [V]; [Nemotron-3-Diarization card](https://huggingface.co/nvidia/nemotron-3-diarization) [V]. Note numbers come from different papers with different eval setups — compare within a row-source, not strictly across.

Podcast relevance: typical podcasts are 2–4 speakers, studio mics, moderate overlap — closest benchmark is VoxConverse / AMI-IHM. All modern systems are good on the 2-speaker case; the failures that hurt clips are (a) short backchannels ("yeah", "right") mis-attributed, causing reframer jitter, and (b) speaker confusion after long monologues. Mitigations: pass `num_speakers`/`min/max_speakers` when known; smooth speaker turns (< 0.5–1 s) before driving the camera; fuse with visual active-speaker detection (lip activity) in the reframer.

---

## 4. Paid APIs (PAID)

Cost per clip assumes a 1.5 h source yields ~10 clips (transcription is billed per source hour, not per clip).

| Service | Model | Price / source hour | ≈ Per clip | Word timestamps | Diarization | Fillers | Notes |
|---|---|---|---|---|---|---|---|
| ElevenLabs | Scribe v2 (v3 newer) | $0.20/h (v2) [V]; v3 price **unverified** | ~$0.03 | Yes [V docs] | Yes, up to 32 spk (v3) [V] | Yes (verbatim, 79.2 disfluency F1 per Nyra [3P]) | Scribe v1 OASR WER 6.88 [V]; audio-event tags (laughter) useful for clip picking; 15 h file limit |
| AssemblyAI | Universal-3.5 Pro | $0.21/h + $0.02 diarization (std) or +$0.065 (experimental) [V] | ~$0.035 | Yes | Yes | Configurable (`disfluencies`) | $50 free credit [V] |
| Deepgram | Nova-3 pre-recorded | $0.0043/min = $0.26/h [V]; batch diarization add-on price not clearly listed | ~$0.04 | Yes | Yes | `filler_words` option | $200 free credit [V]; 63.3 ms boundary error [3P] |
| pyannoteAI | Precision-3 diarization | €0.112/h; Community-1 hosted €0.035/h; STT orchestration (Parakeet v3 / Whisper turbo + diarization) €0.168/h [V] | ~€0.02 | via orchestration | **Best DER available** | — | Free trial 150 h [V]; can be used diarization-only on top of any ASR |
| OpenAI | gpt-4o-transcribe / -diarize | ~$0.006/min = $0.36/h [3P] | ~$0.05 | **No word timestamps** on gpt-4o models (only whisper-1 has them) [3P] | -diarize gives segment-level speakers [3P] | No | **Not suitable** as the timing source |
| Speechmatics | Enhanced | ~$0.13–0.30/h [3P, inconsistent] | ~$0.03 | Yes | Yes | Yes | OASR WER 6.91 [V] |
| Rev.ai | Reverb / Fusion | from ~$0.10/h [3P] | ~$0.015 | Yes | Yes | Verbatim option | OASR WER 7.12 (Fusion) [V]; Reverb weights open but non-commercial [unverified] |
| Gladia | Solaria | ~$0.61/h PAYG [3P] | ~$0.09 | Yes | Yes (pyannote-based) | — | Price currency unclear (EUR?) |

Verdict on paid: all are cheap relative to the value of a clip. Their advantages over a well-tuned self-hosted stack are (1) better diarization (pyannoteAI Precision, Scribe), (2) verbatim fillers and audio events (Scribe), (3) no ops. Disadvantage: no control over segmentation/punctuation and vendor drift. **Recommended paid combo: ElevenLabs Scribe (text + word timings + events) + pyannoteAI Precision-3 (speakers)** ≈ $0.33/source hour ≈ $0.05/clip.

---

## 5. Cloud GPU options

| Provider | GPU | Price | Est. time for 1 h audio, full WhisperX (large-v3 + align + community-1) [EST] | Cost per source hour |
|---|---|---|---|---|
| Modal | L4 | $0.80/h ($0.000222/s) [V] | 4–6 min (ASR ~1–2 min batched, align ~1 min, diarization ~1–2 min) | ~$0.06–0.08 |
| Modal | A10 | $1.10/h [V] | 3–5 min | ~$0.06–0.09 |
| Modal | T4 | $0.59/h [V] | 8–12 min | ~$0.08–0.12 |
| Modal | Free credit | $30/month Starter [V] | ≈ 400+ source hours/month on L4 | free |
| RunPod / Replicate | RTX 4090 / A40 etc. | ~$0.3–0.8/h community cloud [unverified] | similar | similar |

Parakeet-TDT on GPU is ~20x faster than Whisper large → ASR is seconds; diarization dominates. pyannote reports community-1 at ~31 s per hour of audio on an H100 [V]. WhisperX issue [#274 "Diarization too slow"](https://github.com/m-bain/whisperX/issues/274) (open) reports > 1 h diarization for 1.5 h audio on an RTX 3090 with older pipelines [V] — check config (embedding batch size) if you see that.

---

## 6. Per-tool notes

### WhisperX — github.com/m-bain/whisperX
- **What:** faster-whisper batched ASR + Silero/pyannote VAD chunking + wav2vec2 phoneme forced alignment + pyannote diarization + word→speaker assignment. Now uses **pyannote community-1** [V]. 2026 adds context-aware batching (`--interleaved_context`) to restore cross-chunk context (better punctuation/proper nouns) [V, README].
- **License:** BSD-2-Clause code; Whisper MIT; wav2vec2 models Apache/MIT; community-1 CC-BY-4.0 gated.
- **Maintenance:** 25.3k stars, pushed 2026-11-12, latest v3.8.6 (May 2026) / 3.8.7rc1 [V]. 218 open issues.
- **Hardware:** CPU via `--device cpu --compute_type int8` [V]. Optional Numba speeds alignment 30–100x [V].
- **Weaknesses (issues):** alignment regression 3.3.3–3.4.2 ([#1220](https://github.com/m-bain/whisperX/issues/1220)); historic sentence-segmentation complaints — segments too long ([#232](https://github.com/m-bain/whisperX/issues/232), [#200](https://github.com/m-bain/whisperX/issues/200)); diarization slow ([#274](https://github.com/m-bain/whisperX/issues/274)); numbers/symbols unalignable; overlap not handled; batched mode without context can reduce punctuation quality (faster-whisper [#1179](https://github.com/SYSTRAN/faster-whisper/issues/1179) "BatchedInferencePipeline degrades transcription quality heavily").
- **Fit:** the de-facto open baseline; good enough for captions; re-segment sentences yourself from punctuation + pauses rather than trusting its segment boundaries.

### faster-whisper — github.com/SYSTRAN/faster-whisper
- CTranslate2 Whisper reimplementation; int8 on CPU; `vad_filter`; batched pipeline. MIT. 26.8k stars, pushed 2026-11-12, last release v1.2.1 (2025-10-31) [V]. Best Python CPU option for Whisper weights. Known: large-v3 sometimes worse than v2 on hallucination ([#587](https://github.com/SYSTRAN/faster-whisper/issues/587)) [V].

### whisper.cpp — github.com/ggml-org/whisper.cpp
- C/C++ ggml port, MIT, 55k stars, v1.9.5 (2026-10-06) [V]. Fastest pure-CPU Whisper with OpenVINO option on Intel (README benchmark: 1m45s vs faster-whisper 2m37s, fp32 small, non-batched) [V]. Has VAD and DTW token timestamps, but no forced alignment and no diarization (only tinydiarize, weak). Good if you want a single native binary; pair with external aligner.

### OpenAI Whisper large-v3 / large-v3-turbo
- MIT weights; the reference. Turbo = 4 decoder layers, ~5–8x faster, slightly worse WER and weaker on some languages. Vanilla repo (112k stars, pushed 2026-08) is slow and prone to long-audio hallucination loops; use via faster-whisper/WhisperX.

### distil-whisper
- English-only distilled Whisper; distil-large-v3.5 OASR 7.21 [V]. Repo last pushed 2025-01 (stale) [V]. Little reason to choose over turbo or Parakeet now.

### NVIDIA Parakeet / Canary (NeMo) — github.com/NVIDIA-NeMo/Speech
- NeMo toolkit Apache-2.0, 18.8k stars, v3.0.0 (2026-08), very active [V].
- **Parakeet-TDT-0.6B-v2/v3:** best speed/quality ratio on OASR; native word/segment/char timestamps, punctuation + capitalization; CC-BY-4.0 (commercial OK); v3 handles up to 3 h with local attention (24 min full attention on A100) [V]. Card notes a C++ runtime "NeMo-Speech.cpp" with GGUF [V]; CPU inference also commonly done via ONNX exports (sherpa-onnx, onnx-asr) [unverified this session]. Weakness: trained transcripts are less "Whisper-polished" on punctuation for long rambling sentences [EST]; no prompt/context biasing out of the box.
- **Canary-Qwen-2.5B:** top OASR WER (5.63) but no native word timestamps and slow; would need NeMo Forced Aligner. Canary-1B-Flash has timestamps.

### stable-ts — github.com/jianfch/stable-ts
- Post-processing/wrapper for Whisper/faster-whisper: silence-suppressed timestamp refinement, regrouping into sentence-like segments, `align()` to re-time an existing transcript. MIT, 2.3k stars, pushed 2026-05, 0 open issues, last tagged release old (2.0.0, 2023; updates ship via PyPI) [V]. Useful for **regrouping words into caption lines and sentences**, less so for timing precision vs. forced alignment.

### CrisperWhisper 2.0 — github.com/nyrahealth/CrisperWhisper
- Verbatim Whisper fine-tune: transcribes fillers, repetitions, cut-offs; typed word kinds; seamless long-form continuation; hallucination mitigation; CTranslate2 runtime; best published word-boundary error (29.6 ms) [V, vendor-reported]. Sizes large/medium/turbo/small + Pro.
- **License blocker:** code MIT but **weights non-commercial research license**; commercial use needs a license from Nyra [V]. A monetized YouTube channel is commercial → contact vendor or don't use. 1.5k stars, pushed 2026-11-11 [V].

### pyannote.audio 4.x / pyannoteAI — github.com/pyannote/pyannote-audio
- MIT code, 10.8k stars, v4.0.7 (2026-06) [V]. `speaker-diarization-community-1`: CC-BY-4.0 weights, **gated** on HF (accept conditions + token) [V]; provides `exclusive_speaker_diarization` output designed for reconciling with ASR word timestamps [V] — use this for word→speaker mapping and the reframer.
- CPU: runs on CPU by default [V]; third-party M2 Pro CPU RTF ≈ 0.82 [3P] → slower than real time on this laptop [EST]. Embedding extraction is the bottleneck.
- pyannoteAI (PAID): Precision-2/3 materially better DER (e.g., CALLHOME 16.6 vs 26.7; VoxConverse 8.5 vs 11.2) [V]; €0.112/h [V].

### DiariZen — github.com/BUTSpeechFIT/DiariZen
- WavLM + pyannote-style pipeline; best open DER on AMI/DIHARD (13.9/14.5) [V]. **Weights CC-BY-NC-4.0** [V] → not for commercial channel. 567 stars, pushed 2026-08 [V].

### NVIDIA Sortformer / Nemotron-3-Diarization
- Sortformer 4spk v2.1: end-to-end, max 4 speakers, NVIDIA Open Model License [V]. Superseded by **Nemotron-3-Diarization** (2026-09-23): 8 speakers, DIHARD3 12.7% DER, OpenMDW (commercial OK), GPU-optimized [V]. Strong cloud-GPU candidate; integrates naturally with Parakeet in NeMo. CPU viability unverified.

### Others worth knowing
- **Qwen3-ASR, Cohere Transcribe, Granite Speech 4.x** — top of recent OASR snapshots [3P]; check timestamp support before adopting (LLM-decoder models generally lack native word timing).
- **ctc-forced-aligner / NeMo Forced Aligner** — drop-in aligners to re-time any transcript (e.g., from Scribe or Canary-Qwen).
- **FunASR (SenseVoice + CAM++)** — suggested in WhisperX #274 as a fast ASR+diarization alternative [V, issue comment]; mainly Chinese-focused.

---

## 7. Sentence-boundary detection (for clip in/out points)

None of these tools gives reliable "thought" boundaries directly. Recommended approach:
1. Get word list with start/end + punctuation + speaker (exclusive diarization).
2. Candidate boundaries = sentence-final punctuation **AND** inter-word gap ≥ ~300 ms **AND** not inside an overlap region.
3. Snap clip start to just before first word's onset (minus ~100–150 ms pad) and end to last word's offset (plus ~200–300 ms, or to the next silence trough via VAD energy), never to the Whisper segment boundary.
4. Use an LLM pass over the punctuated transcript to choose thought-complete spans; validate against step 2 candidates.
5. Verbatim models (Parakeet, Scribe, CrisperWhisper) help because fillers/false starts are timed instead of silently absorbed into neighbours.

---

## 8. Open questions / to verify by testing
- Real CPU speeds on the i7-8665U (all [EST] above).
- Parakeet punctuation quality vs Whisper on long, rambling podcast sentences.
- ElevenLabs Scribe v3 price and diarization quality vs pyannoteAI on our content.
- Whether OpenAI gpt-4o-transcribe-diarize has gained word timestamps (currently reported as no).
- Nemotron-3-Diarization CPU performance.
