# 03 — Highlight / Virality Detection: How to Pick the Best Moments

_Research date: 2026-11-15. Scope: how to choose which 15–90 s moments of a 1–2 h English podcast/interview/vlog become Shorts. "Verified" means I read the repo code, docs or paper myself; **[UNVERIFIED]** marks claims I could not confirm from a primary source._

---

## TL;DR

1. **The LLM reading the transcript does most of the work, and every serious open-source tool does it this way.** Pure signal methods (loudness, laughter, scene cuts) and academic highlight models do not pick *standalone, hook-first* talking-head clips on their own. They are useful as **hints and tie-breakers**.
2. **Zero-shot LLM "virality scores" are weakly calibrated.** On the only public podcast highlight benchmark (RHAPSODY, COLM 2025, labels from YouTube "Most replayed"), zero-shot GPT-4o did about as well as a frequency heuristic. Gemini was a bit better. A **fine-tuned 1B model with audio features beat both by 2–3×**. Treat LLM scores as a *ranking aid*, not a forecast. Commercial scores (OpusClip, Klap, etc.) have **no published validation**.
3. **The design patterns that matter, taken from the best repos:**
   - (a) Make the model cite **sentence/word IDs or verbatim quotes, never seconds**.
   - (b) **Score every window, then select globally**, not "top-3 per chunk".
   - (c) A **2-second cold-viewer test** and a **standalone test** go into the rubric.
   - (d) **Deterministic boundary snapping** to sentence ends plus silence troughs.
   - (e) **A second, comparative rerank pass**.
   - (f) **Feed in non-LLM evidence** as inline annotations: loud/laugh marks, the replay heatmap, timestamped comments.
   - (g) Keep a **feedback loop** from real clip performance.
4. **YouTube "Most replayed" heatmap: verified available via yt-dlp** (`heatmap` field, 100 points normalised 0–1). It is the strongest free audience signal there is, but it is coarse: a 2 h video gives 72 s bins. It only exists once a video has enough views.
5. **Recommended:** a 5-stage pipeline.
   1. Free CPU signals.
   2. Long-context candidate generation with **Claude Sonnet 5.5** (or Gemini 3.5 Flash).
   3. Deterministic boundary refinement.
   4. Per-candidate deep critique, boundary choice and cold-open suggestion with **Claude Opus 5.5**.
   5. Permutation-averaged listwise rerank, then human review.

   **PAID, about $1–2 per source hour, about $0.10–0.30 per published clip.** Batch API halves it. A local 8B fallback is possible but slow and noticeably worse on this laptop.

---

## 1. LLM-based transcript scoring — how existing tools do it

### 1.1 Repo survey (all read via `gh api`, 2026-11-15)

| Tool | Stars / License / Last push | Selection method | Chunking | Timing contract | Boundary refinement | Multi-pass | Default model | Verdict |
|---|---|---|---|---|---|---|---|---|
| **mutonby/openshorts** | 8.4k / MIT / 2026-11-14 | Two passes: (1) **score every ~90 s window** 0–100 with a "2-second test", global top-N shortlist; (2) detail pass picks 15–60 s clips inside shortlisted windows, with rules for standalone, diversity and min/max count | ~90 s windows, near-equal batches | Absolute seconds (with a word JSON in the older single-pass prompt) | Prompt-level only ("start 0.2–0.4 s before hook") | Yes: score → detail; optional vision-grounded hook rewrite | Gemini (3.x Flash family); any OpenAI-compatible local LLM | **Best-documented production lessons.** Also the most mature prompts. |
| **artbyjazi/autoclip** | 326 / MIT / 2026-08 | Per-window candidate proposal with a 4-criterion rubric (hook > self-containment > payoff > quotability) | 8 min windows, 60 s overlap, IoU 0.4 dedupe | **Word indices** (`[1042]word`): the model copies indices, never does arithmetic | **Yes, the best one found:** sentence snap (±12 words, ties go earlier for start and later for end), duration clamp on sentence ends, **silence-trough alignment** (0.12 s lead, 0.28 s tail) | Validate → retry with the error message | Ollama / OpenAI / Anthropic / Gemini | **Best boundary code to copy**, and an excellent prompt. Single pass, no rerank. |
| **SamurAIGPT/AI-Youtube-Shorts-Generator** | 6.1k / MIT / 2026-11-12 | Content-type detection, then an 8-signal virality rubric (hook, emotion, opinion bomb, revelation, conflict, quotable, story peak, practical value); returns `hook_sentence` + `virality_reason` | 20 min chunks, 60 s overlap (above 30 min) | Seconds (segment-level `[t s]`) | None beyond the prompt ("never cut mid-sentence") | Score-based dedupe | gpt-5-mini via MuAPI (PAID proxy) or local | Good rubric list. Weak timing and boundary handling. |
| **haziqahmedqasmi/PeakCut** | 394 / MIT / 2026-11-15 | Transcript lines annotated inline with **(LOUD)** (loudness z-score) and **(CHAT)** (live-chat spike); a loudness-only fallback when there is no LLM | 15 min windows, 60 s overlap | Seconds | Small pad/tail tweak | Separate "signal judge" (signals only) + "words judge" for live | Gemini 2.5 Flash default; many providers | **Best example of fusing signals into the prompt.** Gaming/stream oriented. |
| **ColinGPT9/clips-studio** ("Clips Kitty") | 258 / AGPL-3.0 / 2026-11-15 | Signal analysis (audio excitement, visual activity, reaction) proposes windows → LLM `score_windows` → **listwise `rerank`** ("order ALL N clips… judge them against each other") | Signal-driven windows | Seconds | — | **Yes: score → listwise rerank** | Ollama or OpenRouter (README claims about $0.11 per 2 h VOD **[UNVERIFIED]**) | Clean prompt files in `config/prompts/`. Stream oriented. AGPL. |
| **xixihhhh/hotclip** | 463 / AGPL-3.0 / 2026-10 | Long prompt (zh/en): content-type-aware evidence weighting; ranked hunt list (self-contradiction, conflict, counter-intuitive one-liners, emotional peaks, setup→punchline jokes, saveable value); **verbatim `quoteStart`/`quoteEnd` + sentence IDs**, reverse-matched to time; **multi-part "stitch" clips** (2–3 parts in source order, with an explicit rule against creating meaning that wasn't said); **quality gate** (dangling openers, endings on commas, frequent speaker changes → "review"); LLM re-review; **performance memory** (imports real views/likes CSV and injects strong/weak examples into the next prompt) | Sentence-level | Quotes + IDs, never clock times | Deterministic gate + LLM review | **Yes: detect → gate → review (+ vision review)** | Configurable | **Most complete selection design found.** AGPL, so borrow ideas, not code. |
| **modelscope/FunClip** | 6.6k / MIT / 2026-11 | Generic prompt (Chinese demo): "pick the most meaningful, continuous parts" from SRT | Whole SRT | SRT timestamps | None | No | Qwen / OpenAI / litellm | Not virality-oriented. Skip for selection. |
| **ClipsAI/clipsai** | 571 / MIT / **2024-01 (stale)** | **No virality scoring.** TextTiling over sentence embeddings finds *topic boundaries* only | n/a | n/a | Topic segmentation | n/a | Local embeddings (CPU OK) | Useful only as a topic-segmentation prior. Unmaintained. |
| SamurAIGPT/Clip-Anything | 315 / MIT / 2026-07 | Prompt-driven multimodal clipping (thin wrapper) | — | — | — | — | Paid API | Not relevant. |

### 1.2 Notable prompt and rubric excerpts (short, paraphrased; follow links for full text)

- **openshorts score pass** ([gemini_worker.py `SCORE_PROMPT_TEMPLATE`](https://github.com/mutonby/openshorts/blob/main/gemini_worker.py)): "Score EVERY window… Do not drop the weak ones." "Most windows of a normal video are not clippable, so reserve 70+…" Main criterion: *THE 2-SECOND TEST*, i.e. would the first 2 s make a cold viewer keep watching?
- **openshorts detail pass** (`DETAIL_PROMPT_TEMPLATE`):
  - *STANDS ALONE*: if a clip opens on a pronoun, "that", "so anyway", or an answer to an earlier question, move the start back or skip it.
  - Fix context by moving the **start earlier, never by cutting the payoff**.
  - *DIVERSITY*: never two clips making the same point.
  - *ABOUT THIS MOMENT, NOT THE VIDEO*: hooks must name the concrete thing in the clip.
- **openshorts production lessons** (comments in [clip_selection.py](https://github.com/mutonby/openshorts/blob/main/clip_selection.py), [docs/architecture/clip-selection.md](https://github.com/mutonby/openshorts/blob/main/docs/architecture/clip-selection.md)):
  - "Choose up to 3 per batch" capped the shortlist and **threw away the ranking**. A trailing batch of one window was always selected, "by arithmetic rather than merit".
  - Fix: score all windows, take the global top-N, and use near-equal batches so scores are comparable ("a window judged alone is judged against nothing").
  - Their retention data says users who got 1–3 clips returned far less than users who got 4–9. That is a *product* metric, not clip quality.
  - With local LLMs (4–8k context) they drop to 3 windows per call, because "a truncated prompt scores garbage silently".
- **autoclip `highlight_v1.txt`** ([link](https://github.com/artbyjazi/autoclip/blob/main/backend/autoclip/prompts/highlight_v1.txt)):
  - Four ordered criteria.
  - Score bands: 85+ "would genuinely perform", below 50 "do not return".
  - "Do not extend a clip to reach a length target."
  - "Most sections of most videos contain nothing worth clipping; saying so is a correct answer."
  - `hook` must quote the clip's actual opening words verbatim, as a self-check of the start position.
- **SamurAIGPT** ([highlights.py](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator/blob/main/shorts_generator/highlights.py)): an 8-item "virality signals, ranked by impact" list (hook moments, emotional peaks, opinion bombs, revelations, conflict, quotable one-liners, story peaks, practical value). A 45–90 s "sweet spot", 20–44 s only for perfect one-liners.
- **hotclip** ([src/core/highlight/prompt.ts](https://github.com/xixihhhh/hotclip/blob/main/src/core/highlight/prompt.ts)):
  - "Viral material is RARE". Decide the content type first, then which evidence to trust.
  - Jokes count only as complete setup→punchline units.
  - **Never quote-mine** ("the clipped meaning must match what was actually said").
- **clips-studio rerank** ([config/prompts/rerank.txt](https://github.com/ColinGPT9/clips-studio/blob/main/config/prompts/rerank.txt)): listwise: "Order ALL {count} clips… Judge them against each other". Candidates carry signal scores next to the text.

### 1.3 Chunking vs. long context

- **Size:** a 1–2 h podcast is 15–30k words, about 20–40k tokens (about 1.33 tokens/word). With per-sentence IDs it is about 25–45k tokens.
- **Every current frontier model fits this in one call:** Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5 are 1M context; Gemini 3.x is 1M; GPT-5.5 is large.
- **Most OSS tools chunk anyway** (8–20 min windows, 60 s overlap). They do it for local-model compatibility and output-length limits, not because chunking is better.
- **Trade-offs:**
  - A single long call sees callbacks, running jokes and setups that pay off 20 min later (hotclip's "self-contradiction" category needs this). It also ranks globally.
  - Single long calls suffer "lost in the middle" attention decay (Liu et al. 2023, arXiv 2307.03172 — a general finding, not clip-specific). They also tend to **under-return**: they nominate a dozen moments and miss mid-video ones.
  - Chunked calls give better *recall* per region, but scores are not comparable across chunks (the openshorts lesson). They also miss cross-chunk arcs.
- **Recommendation:** use both.
  - **Coverage pass:** overlapping 10–15 min windows, *propose, don't select*.
  - **Global pass:** full transcript to catch long arcs and set a global ranking.
  - Union, then dedupe by sentence-span IoU. A cheap model is fine for the coverage pass.

### 1.4 Timing contract (important for boundary quality)

- **Never let the model output seconds.** Seconds force the model to do arithmetic, and seconds pulled from segment-level timestamps are off by up to a segment.
- **Three proven alternatives:**
  - Word indices (autoclip). Most precise, but about 2× token cost.
  - **Sentence IDs plus verbatim opening/closing quote** (hotclip). Cheaper. The quote doubles as a check: if fuzzy match fails, reject or retry.
  - Segment start times (SamurAIGPT, PeakCut). Worst.
- **Recommendation:** sentence IDs with verbatim quote verification, then deterministic word-level refinement.

### 1.5 Pointwise vs. pairwise / listwise / tournament

- **Pointwise 0–100 scores** from LLMs cluster (everything is 75–90) and drift between calls. Every good prompt fights this with explicit bands ("reserve 70+", "be harsh, use the whole range").
- **Pairwise judging** is generally more discriminative. But position bias is pervasive across pointwise, pairwise and listwise formats ([Shi et al., arXiv 2406.07791](https://arxiv.org/html/2406.07791v5)). Pairwise preferences can be non-transitive, and pairwise protocols are more vulnerable to distraction ([Tripathi et al., arXiv 2504.14716](https://fugumt.com/fugumt/paper_check/2504.14716v2_enmode)).
- **Permutation-averaging** rubric judgments improves agreement with humans ([arXiv 2602.02219](https://arxiv.org/abs/2602.02219v1), read via abstract/summary only — numbers **[UNVERIFIED]**).
- **Practical choice for 10–20 finalists:**
  - **Listwise rerank, 3 shuffled orderings**, averaging Borda ranks. That is about 3 calls, cheap, and kills position bias.
  - Or a Swiss/knockout tournament with swapped-order pairs for the top 6–8 only.
  - A full round-robin of 20 candidates means 190 pairs (380 with swaps). It works but is wasteful.
- **No published eval compares these specifically for clip selection.** Treat it as an engineering choice and validate on our own data.

### 1.6 Which models do it best — evidence

| Evidence | What it says | Quality of evidence |
|---|---|---|
| **RHAPSODY** ([arXiv 2505.19429](https://arxiv.org/html/2505.19429v2), COLM 2025; [code](https://github.com/younghanstark/rhapsody), Apache-2.0 repo / CC BY-NC-SA paper) | 13.4k YouTube podcasts; label = top "Most replayed" segments (100 bins, threshold 0.5). F1 by method: random 0.039, GPT-4o zero-shot 0.057, **Gemini zero-shot 0.065**, **fine-tuned Llama-3.2-1B (QLoRA) text 0.163, + HuBERT audio 0.197**. Audio helps the fine-tuned model but not zero-shot Gemini. LLMs do worst on News & Politics and best on Comedy. | **Strong, peer-reviewed.** Caveat: "replayed" is not the same as "a good standalone short", and the models tested are old (GPT-4o era). |
| MEETYOO 17-model test ([article](https://contenthub.meetyoo.com/resources/best-ai-video-highlights)) | Gemini family returned concise "moments"; Qwen3-235B and Nova Pro returned chapter-length spans; big models were not reliably best. | Weak: 2 famous speeches (contamination), vendor-run, no scores. |
| Vendor claims (Videotto: Claude Opus for 2 h arcs) | Marketing. | None. |

**Conclusion:**
- There is **no rigorous public head-to-head** of current Claude, GPT and Gemini models on clip selection.
- Gemini Flash is the de-facto default in OSS tools. The reasons are price, structured-output schema support and native video input (openshorts, PeakCut), not proven quality.
- For the judgment-heavy stages (standalone? hook? payoff? does a stitch distort meaning?), use the strongest reasoning model we can afford per call. Measure on our own labelled set (see §7).
- **Long-run quality lever:** RHAPSODY shows a *small model fine-tuned on audience signals* beats zero-shot frontier LLMs at predicting where audiences engage. Once we have ≥ a few hundred labelled clips (heatmap data and our own Shorts performance), a fine-tuned small ranker is the strongest path. It runs on CPU at inference; training needs a cloud GPU for an hour.

**Model pricing** (Claude from Anthropic's model table cached 2026-11-03; others from third-party aggregators, so verify before budgeting):

| Model | $/1M in | $/1M out | Context | Notes |
|---|---|---|---|---|
| Claude Opus 5.5 (`claude-opus-5-5`) | 4.00 | 20.00 | 1M | Thinking always on; set effort explicitly (default `medium`) |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | 2.00 | 10.00 | 1M | |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | 0.10 | 0.50 | 1M | $0.50/$2.50 above 100k prompt tokens |
| Gemini 3.5 Flash | 1.50 | 9.00 | 1M | Matches the openshorts `MODEL_PRICES` table; aggregator-confirmed |
| Gemini 3.1 Flash-Lite | 0.25 | 1.50 | 1M | Per openshorts code |
| GPT-5.5 | 5.00 | 30.00 | — | Aggregators; batch is half |
| Local Qwen3-8B / Llama-3.1-8B Q4 (Ollama) | free | free | 32–128k | i7-8665U CPU: prompt processing of 30–40k tokens is likely **15–40 min per pass [UNVERIFIED estimate]**, and judgment quality is clearly below frontier models **[UNVERIFIED]** |

Batch APIs (Anthropic, OpenAI, Google) give about 50% off when results can wait. Prompt caching cuts repeated transcript input to about 5–10% of the input price (Claude cache reads $0.20/M on Opus 5.5).

---

## 2. Non-LLM signals — honest usefulness assessment

| Signal | Tool (license, status) | CPU cost | Usefulness for talking-head podcasts | How to use |
|---|---|---|---|---|
| **YouTube "Most replayed" heatmap** | yt-dlp `heatmap` field (Unlicense, very active) | ~0 (one metadata request) | **High where available.** Real audience behaviour; it is RHAPSODY's ground truth. | Normalise, annotate transcript sentences with replay percentile, use as a prior and tie-breaker in rerank. |
| **Timestamped comments** ("37:12 I'm dead 😂") | yt-dlp `--write-comments` (+ `max_comments` extractor arg) | Minutes for big videos | **High precision, low recall.** Viewers mark exactly the moments that land. | Regex `\b\d{1,2}:\d{2}(:\d{2})?\b`, weight by comment likes, annotate as (COMMENTED ×N). |
| YouTube chapters | yt-dlp `chapters` (verified field) | ~0 | Medium: topic boundaries plus human-written topic titles. | Context for "standalone" checks; never start a clip across a chapter boundary without reason. |
| Loudness / RMS z-score | ffmpeg `ebur128`/`astats`, numpy | Seconds | Medium: catches shouting and laughter bursts. Plenty of false positives (music, crosstalk). | PeakCut-style inline "(LOUD)" mark; never select on it alone. |
| **Laughter / applause / cheering** | PANNs CNN14 AudioSet tagger ([qiuqiangkong/audioset_tagging_cnn](https://github.com/qiuqiangkong/audioset_tagging_cnn), MIT, last push 2024); jrgillick/laughter-detection (MIT, 2024, stale) | PANNs on CPU is likely several× real-time for a 2 h file, minutes **[UNVERIFIED estimate]** | **Medium-high for comedic/banter podcasts.** Laughter right after a line is the best cheap payoff indicator. Low for solemn interviews. | Annotate "(LAUGHTER 0.8)" on the sentence after it; boost payoff score. |
| Prosody: pitch variance, intensity, speech rate | Parselmouth/Praat ([GPL-3.0](https://github.com/YannickJadoul/Parselmouth), active); openSMILE (custom licence, research/non-commercial free — check); librosa `pyin` (ISC); words/sec from word timestamps | Minutes | Low-medium. Excitement shows up, but so does a mere speaker change. RHAPSODY found audio embeddings (HuBERT) help a *trained* model, not a zero-shot one. | Feature for the later learned ranker; light inline marks at most. Prefer librosa (permissive) over Parselmouth (GPL) if we ever distribute. |
| VAD / silence map | Silero VAD (MIT, active, CPU-fast) | Seconds–minutes | **Essential for boundaries**, not for selection. | Cut points in silence troughs; dead-air trimming. |
| Scene changes | PySceneDetect (BSD-3, very active) | Minutes | Low for selection on 2–3 camera podcasts (cuts follow the speaker, not interest). Useful for **avoiding a start/end within a few frames of a hard cut** and for vlogs. | Boundary nudging only. |
| CLIP/open_clip visual scoring, gestures | open_clip (MIT-ish, active) | Slow on CPU | **Low.** Frames say what kind of shot it is, not which 40 s to cut (openshorts arrived at the same lesson). Useful only for silent or visual vlogs. | Skip for v1. If needed, use Gemini video input as a fallback for low-speech sources (openshorts does this). |
| Topic segmentation (TextTiling on embeddings) | ClipsAI (MIT, stale) or own sentence-transformers code | Minutes on CPU | Medium as **context**: tells the LLM where a thought starts. | Optional precursor for the standalone check. |

### 2.1 yt-dlp heatmap — verified details

- **Code:** `yt_dlp/extractor/youtube/_video.py::_extract_heatmap` reads `frameworkUpdates.entityBatchUpdate.mutations[*].payload.macroMarkersListEntity.markersList` where `markerType == 'MARKER_TYPE_HEATMAP'`. It returns `[{start_time, end_time, value∈[0,1]}]`. Documented in `common.py` and set as `info['heatmap']`. Test fixtures expect `count:100`.
- **How to get it:** `yt-dlp --skip-download --write-info-json URL`, or `--print-to-file "%(heatmap)j" file.json` (maintainer's recipe in [issue #13251](https://github.com/yt-dlp/yt-dlp/issues/13251)).
- **Fragility:** it broke once, in Sept 2023, when YouTube changed its data structure. It was fixed within days ([#8189](https://github.com/yt-dlp/yt-dlp/issues/8189)). Expect occasional breakage. Keep yt-dlp updated and degrade gracefully when the field is `None`.
- **Caveats:**
  - **Fixed 100 bins**: 36 s for a 1 h video, 72 s for 2 h. It localises a *region*, not a boundary.
  - Only present when YouTube shows the graph (enough views). For a top-tier channel's fresh upload it may take hours or days to appear **[UNVERIFIED timing]**.
  - The first bin is inflated (RHAPSODY replaces it with the second).
  - Peaks can be people *seeking past* sponsor reads to the next segment start. Combine with the transcript.

---

## 3. Academic work — what transfers

| Line of work | Representative | Transfer to our problem |
|---|---|---|
| Query-based moment retrieval / highlight detection (QVHighlights, Moment-DETR, UniVTG, Saliency-Guided DETR) | [Moment-DETR](https://github.com/jayleicn/moment_detr) (MIT), [UniVTG](https://github.com/showlab/UniVTG) (MIT, last push 2024), [SG-DETR arXiv 2410.01615](https://arxiv.org/html/2410.01615v2) | **Low.** Trained on visual YouTube vlogs/news with *natural-language queries* ("man shows his dog"). Visual saliency is not podcast virality, and they need GPU feature extraction (CLIP+SlowFast). Possibly useful later for *vlog* sources with a query ("the funniest moment"). Not for v1. |
| Podcast highlight detection | **RHAPSODY** (above) | **High conceptual transfer.** (1) Audience replay is a learnable target. (2) Zero-shot LLMs are weak at it. (3) Fine-tuned small models plus audio features win. Gives us a dataset (13k episodes of replay graphs) to pretrain a ranker before we have our own data. Licence CC BY-NC-SA on the paper/dataset: **non-commercial**, so check before commercial use. |
| Podcast summarisation (TREC Podcasts 2020–21, Spotify) | TREC Podcasts track | Low-medium: summary-worthy is not clip-worthy; older models. |
| Short-video engagement prediction | [SMP Challenge 2025 video track](https://arxiv.org/abs/2507.00950) (winner: metadata + XCLIP features + CatBoost; *uploader follower/like counts dominate*); [VQualA 2025 / SnapUGC](https://openaccess.thecvf.com/content/ICCV2025W/VQualA/html/Li_VQualA_2025_Challenge_on_Engagement_Prediction_for_Short_Videos_Methods_ICCVW_2025_paper.html) (120k Snapchat clips; top teams used LMMs like Qwen2.5-VL) | **Low for selection.** Account-level factors dominate. The models predict for *finished* videos and need GPU. Lesson: content-only "virality scores" can explain only part of the variance. Do not over-trust any score, ours included. |
| LLM-as-judge reliability | Position-bias and permutation papers (§1.5) | **High:** directly shapes the rerank design. |

---

## 4. Commercial references

| Product | What it says about its score | Validation evidence |
|---|---|---|
| **OpusClip** "Virality Score" 0–99 ([help doc](https://help.opus.pro/docs/article/virality-score)) | AI rates **Hook** (grabs attention + on-topic), **Flow** (logical progression, satisfying end), **Value** (value/emotional resonance), **Trend** (fits current trends); plus prompt relevance in ClipAnything. Weights undisclosed. | **None published.** Help doc makes no accuracy claim. Third-party anecdotes: one reviewer says 50 clips scoring >75 got about 2.3× the views of clips scoring <50 **[UNVERIFIED, uncontrolled]**. Others say a 92 vs 78 doesn't predict order. A tester of a 15-min talk ([marcandrews.com](https://marcandrews.com/?p=6263)) did not publish any clips: scores matched his picks, but there is no performance data. |
| OpusClip "13.5M clips" blog ([link](https://www.opus.pro/blog/anatomy-of-a-viral-tiktok-2026)) | Viral-tier median length 41 s (vs 50 s overall); 15–30 s overrepresented in top tier; 80% of viral clips have burned-in captions. | Vendor data, correlational, internal inconsistencies. **First-3-seconds hook advice is not measured there.** |
| **Klap** | 0–100 score "based on what's actually performing across TikTok, Reels, and Shorts"; looks for hooks, punchlines, contrarian takes, emotional peaks. | Marketing only. |
| **Vizard** (Model v2, "virality reasons") | Explains why a clip may perform. A competitor (Klap) calls Vizard's score "decorative" (biased). | None found. |
| **Munch** | "Data-backed" score + trend matching. | None found. |
| **Descript** (Create clips / Underlord) | "Self-contained" clips, 1–20 clips, 10 s–5 min; Underlord was "taught what works on social". No score methodology. | None. |

**Takeaway:** every vendor's rubric is close to *hook + flow/standalone + value/emotion (+ trend)*, which matches the OSS prompts above. No vendor publishes evidence that its score predicts views. "Trend" signals are unverifiable black boxes. Our edge has to come from **better boundaries, real audience signals (heatmap/comments) and our own performance feedback loop**, not from a magic score.

---

## 5. Boundary refinement, hook-first editing, cold opens

### 5.1 Deterministic boundary refinement (copy the autoclip approach and extend it)

1. **Sentence snap.** Use punctuated ASR output (WhisperX/Whisper word timestamps, see report 02).
   - Start snaps to the first word of the nearest sentence within ±12 words; on ties prefer earlier, because "clipping the hook is not recoverable".
   - End snaps to the last word of a sentence; on ties prefer later.
2. **Dangling-opener check.** If the first sentence begins with a conjunction or discourse marker, move the start back one sentence or flag it.
   - Markers: "so", "and", "but", "because", "which", "yeah", "right", "exactly", "anyway", "like I said", or an unresolved pronoun ("he", "that", "it") as subject.
   - The LLM re-checks the edge cases (hotclip gate idea).
3. **Answer-without-question check.** If the clip opens on speaker B answering a question from speaker A, include A's question, or make the answer's first line the hook and burn the question as on-screen text. Requires diarization.
4. **Ending check.** The end must be on a payoff (the final sentence carries the conclusion or punchline), not a trailing qualifier ("…but yeah, anyway"). Trim trailing filler sentences. If laughter follows the punchline, hold until the laughter decays (cap at about 1.5 s).
5. **Duration clamp** only on sentence boundaries. Drop the candidate rather than butcher it.
6. **Silence alignment:** move the cut into the measured silence trough (Silero VAD / ffmpeg `silencedetect`), with about 0.1 s lead and 0.25–0.3 s tail. Avoid cuts within about 2 frames of a hard scene cut (PySceneDetect).
7. **Intra-clip tightening (optional, careful):**
   - Remove filler ("um", "uh", false starts) and pauses longer than 0.6 s using word timestamps.
   - Jump-cut only when the reframe hides it, or keep it as a stylistic punch-in.
   - Never remove words that change meaning.
   - Keep a max-removal ratio (for example ≤ 8% of duration) to avoid robotic pacing. This is how Descript-style "remove filler words" works; implement it ourselves on word timestamps.

### 5.2 Ensuring a hook in the first 3 s

The options, in order of safety:
1. **Pick a better start.** The deep-critique stage evaluates 2–4 alternative start sentences and picks the earliest one that passes the 2-second test without losing needed context (openshorts rule: move the start, don't cut the payoff).
2. **Text hook overlay** (0–3 s) naming the concrete payoff, while the audio starts at the natural sentence ("He turned down $50M — here's why"). Every vendor does this. Generated by the same LLM call, constrained to facts in the clip.
3. **Cold open / "teaser flash-forward":** put the punchiest 2–5 s line (often the payoff or most quotable sentence) at the very start, then cut to the natural beginning. Optionally add a whoosh or "rewind" transition.
   - hotclip's multi-part "stitch" is the same mechanism. Its guardrails are the right ones:
     - parts in source order, or a clearly signposted flash-forward;
     - each part a complete sentence ≥ 2 s;
     - **never create a meaning that wasn't said**;
     - no stitching across a "but/however" reversal.
   - For a top-tier channel, a cold-open variant should be **an alternate render for human choice**, not the default. A mis-stitched clip damages trust.
   - The LLM proposes `cold_open_sentence_id` and a one-line justification. Code validates that it is inside the clip, 1.5–5 s long, and on clean word boundaries.
4. **Question-as-hook:** if the clip is an answer, open on the interviewer's question (audio), or show it as text over the first words of the answer.

---

## 6. Recommended selection design

### Stage 0 — Ingest and free signals (CPU, about 5–15 min per source hour, $0)

Inputs: WhisperX/word-timestamped, punctuated, diarized transcript (report 02).

Compute:
- sentence list with IDs, speaker, start/end, words/sec;
- Silero VAD silence map;
- per-sentence loudness z-score (ffmpeg);
- PANNs laughter/applause/cheer probabilities (optional, comedic content);
- yt-dlp metadata: `heatmap`, `chapters`, title/description, and **top N comments** (parse timestamps, weight by likes);
- optional TextTiling topic boundaries.

Output `signals.json` (an inspectable intermediate, per CLAUDE.md conventions).

### Stage 1 — Candidate generation (PAID, high recall)

**Render the transcript compactly**, one line per sentence:

```
[s0412|B|37:12] Sentence text… {LOUD} {LAUGH .82} {REPLAY p95} {COMMENTED ×7}
```

Annotations only where they fire. Add chapter headers as section separators.

**Coverage pass:** 12 min windows with 2 min overlap. Model: **Claude Haiku 5.5** or Sonnet 5.5. Prompt: autoclip/openshorts-style rubric. "Propose every moment that could be a standalone short; return none if none."
- Output per candidate:
  - `start_sid`, `end_sid`, `quote_start`, `quote_end` (verbatim ≥ 6 words);
  - `type` (story / opinion / revelation / advice / joke / conflict / emotional);
  - `hook_line_sid`, `payoff_sid`;
  - a one-line `why`.
- Use structured outputs (JSON schema) to avoid parse failures.

**Global pass:** full transcript in one call with **Claude Sonnet 5.5** (or Opus 5.5 at low/medium effort).
- Asks for the 25–40 best moments overall, including **long-range arcs** and setups paid off later.
- Also asks for any "multi-part" candidates (hotclip-style), flagged for review.

**Merge:** verify quotes by fuzzy match (reject or retry failures), union both passes, dedupe by sentence-span IoU > 0.4, keeping the better-justified one.

Typical output: 30–60 raw candidates per source hour.

### Stage 2 — Deterministic refinement and hard gates ($0)

- Apply §5.1 steps 1–6.
- Reject clips < 15 s or > 90 s after snapping (configurable; Shorts allow up to 3 min, but vendor data favours about 20–60 s).
- Flag dangling openers, answer-without-question, and > N speaker switches per 10 s.
- Compute a **signal prior** per candidate: max replay percentile, comment count, laughter after the payoff, loudness peaks.

### Stage 3 — Deep critique and boundary decision, one call per candidate (PAID, the judgment step)

**Model: Claude Opus 5.5** at `high` effort. Sonnet 5.5 is the cheaper alternative; A/B them on our labelled set.

**Input:**
- the candidate plus **±90 s of surrounding transcript** with sentence IDs;
- signal annotations;
- 2–4 deterministic alternative start/end options from Stage 2;
- the channel's style notes;
- 3–5 examples of past clips that performed well and badly (hotclip-style performance memory, once available).

**Output (structured):**
- **rubric scores 1–10 with a one-line justification each, justification first, then the score:**
  - Hook (2-second cold-viewer test on the *actual first sentence*)
  - Standalone (zero-context intelligibility; unresolved references listed)
  - Payoff (name what the viewer walks away with; if you can't, ≤ 4)
  - Emotional intensity
  - Novelty / counter-intuitiveness / controversy (flag *harmful* controversy separately)
  - Quotability
  - Pacing (density, no dead stretches)
- **chosen** `start_sid`/`end_sid` (from the options or a justified new one);
- `cold_open_sid` (optional) + `meaning_preserved: bool`;
- `hook_text` (≤ 10 words, factual, about *this* moment);
- title;
- `publish | review | drop` with a reason.

**Weighted score** (initial weights, to be learned later):

`0.30·Hook + 0.25·Standalone + 0.25·Payoff + 0.10·Emotion + 0.05·Novelty + 0.05·Quotability`, plus the signal prior as a bonus (for example +0.5 for replay p90+, +0.3 for 3+ timestamped comments, +0.3 for laughter after the payoff). Hard-fail if Standalone ≤ 4 or Hook ≤ 4.

Prompt-cache the system prompt and rubric; candidates differ only in the tail.

### Stage 4 — Comparative rerank and diversity (PAID, small)

- Take the top about 15 by Stage-3 score.
- **Listwise rerank × 3 random orderings** (Opus 5.5 or Sonnet 5.5). The model sees the hook line, a 2-sentence summary, the payoff line, the signal prior and the Stage-3 scores. Average the ranks (Borda).
- Optionally run a swapped-order pairwise tie-break for adjacent finalists whose ranks differ by < 1.
- Apply **diversity**: MMR on sentence-embedding similarity plus a "same point / same story" LLM check (openshorts DIVERSITY rule).
- Output the ranked final list of N (for example 6–12 per source hour), each with a `publish`/`review` tier.

### Stage 5 — Human-in-the-loop and learning loop ($0, the biggest long-term quality lever)

- A review UI shows each clip with its rubric, why, signals and alternative boundaries/cold-open renders. The editor accepts or rejects, and the reasons are logged (review memory).
- Import real Shorts/TikTok performance (views, average view duration / % viewed, likes, shares) and store it per clip. Use YouTube Analytics API retention for our own channel's Shorts.
- After about 100–300 published clips:
  - fit a simple model (logistic or GBM) on rubric scores and signals → performance, and re-weight Stage 3;
  - later, fine-tune a small ranker (RHAPSODY-style, optionally pre-trained on RHAPSODY's 13k replay graphs, licence permitting) as an extra feature. Training needs a cloud GPU for about $1–5; inference runs on CPU.

### Cost estimate (PAID; 1 h source ≈ 13k words ≈ 18–22k tokens with IDs and annotations)

| Stage | Model | Input tokens / source h | Output tokens (incl. thinking) / source h | Cost / source h |
|---|---|---|---|---|
| 1a Coverage pass | Haiku 5.5 | ~30k (overlap + prompt) | ~8k | **~$0.01** (Sonnet 5.5: ~$0.14) |
| 1b Global pass | Sonnet 5.5 | ~25k | ~12k | **~$0.17** |
| 3 Deep critique | Opus 5.5, ~30 candidates × (~4k in, ~2k out) | ~120k (~70% cacheable) | ~60k | **~$1.5** (Sonnet 5.5: ~$0.8) |
| 4 Rerank ×3 | Opus 5.5 | ~25k | ~6k | **~$0.22** |
| **Total** | | | | **≈ $1.9 / source h with Opus judge; ≈ $1.1 with all-Sonnet; ≈ $1 / $0.6 via Batch API** |

- **Per published clip** (about 8 per source hour): **≈ $0.10–0.25**.
- **For a 2 h podcast:** about **$2–4** (Opus judge) or about **$1.2–2.2** (Sonnet).
- **Thinking tokens are the main uncertainty.** Measure with `usage` on the first 5 videos and cap via the effort setting.
- **Gemini 3.5 Flash** ($1.5/$9) would land around Sonnet-level cost. A Gemini-only stack is viable and is what openshorts/PeakCut default to.
- **No-cost fallback:** a local Qwen3-8B Q4 via Ollama for Stages 1/3/4. Expect 1–3 h of CPU time per source hour on the i7-8665U and lower judgment quality **[UNVERIFIED estimates]**. Suitable for offline experiments, not for the top-tier bar.

---

## 7. How to validate (do this before trusting any of the above)

1. **Build a small gold set:** 10–20 of the channel's own long videos.
   - Positives: clips the channel already published as Shorts that performed well, plus human-picked moments.
   - Negatives: random windows, and clips that flopped.
   - Also record heatmap and comment data.
2. **Metrics:**
   - recall@K of gold moments (sentence-span overlap ≥ 50%);
   - boundary error in words vs the human cut;
   - % of clips passing the standalone/hook human check;
   - pairwise agreement of the final ranking with real performance.
3. **A/B the knobs:** Opus vs Sonnet vs Gemini judge; with and without the signal annotations; listwise vs pointwise rank; chunked + global vs global only. Change one variable at a time; each run costs a few dollars.

---

## Sources (primary unless noted)

- Repos (code read): [mutonby/openshorts](https://github.com/mutonby/openshorts), [artbyjazi/autoclip](https://github.com/artbyjazi/autoclip), [SamurAIGPT/AI-Youtube-Shorts-Generator](https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator), [haziqahmedqasmi/PeakCut](https://github.com/haziqahmedqasmi/PeakCut), [ColinGPT9/clips-studio](https://github.com/ColinGPT9/clips-studio), [xixihhhh/hotclip](https://github.com/xixihhhh/hotclip), [modelscope/FunClip](https://github.com/modelscope/FunClip), [ClipsAI/clipsai](https://github.com/ClipsAI/clipsai)
- yt-dlp: [`_video.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py) (`_extract_heatmap`), [`common.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/common.py) field docs, issues [#3888](https://github.com/yt-dlp/yt-dlp/issues/3888), [#8189](https://github.com/yt-dlp/yt-dlp/issues/8189), [#13251](https://github.com/yt-dlp/yt-dlp/issues/13251)
- Papers: [RHAPSODY arXiv 2505.19429](https://arxiv.org/html/2505.19429v2); [Position bias, arXiv 2406.07791](https://arxiv.org/html/2406.07791v5); [Pairwise vs pointwise, arXiv 2504.14716](https://fugumt.com/fugumt/paper_check/2504.14716v2_enmode); [Permutation calibration, arXiv 2602.02219](https://arxiv.org/abs/2602.02219v1); [SMP 2025 winner, arXiv 2507.00950](https://arxiv.org/abs/2507.00950); [VQualA 2025](https://openaccess.thecvf.com/content/ICCV2025W/VQualA/html/Li_VQualA_2025_Challenge_on_Engagement_Prediction_for_Short_Videos_Methods_ICCVW_2025_paper.html); [QVHighlights](https://arxiv.org/pdf/2107.09609); [UniVTG](https://arxiv.org/pdf/2307.16715); [SG-DETR](https://arxiv.org/html/2410.01615v2); Lost in the Middle (arXiv 2307.03172, from memory)
- Commercial: [OpusClip virality score doc](https://help.opus.pro/docs/article/virality-score), [OpusClip 13.5M-clip blog](https://www.opus.pro/blog/anatomy-of-a-viral-tiktok-2026), [marcandrews.com test](https://marcandrews.com/?p=6263), [Klap viral clip generator](https://klap.app/tools/viral-clip-generator), [Vizard Model v2 blog](https://vizard.ai/blog/meet-vizard-model-v2-full-context-clips-that-the-algorithm-actually-rewards), [Descript create clips](https://help.descript.com/repurpose/create-clips-from-your-content), [MEETYOO 17-model test](https://contenthub.meetyoo.com/resources/best-ai-video-highlights) (vendor)
- Pricing: Anthropic model table (cached 2026-11-03); Gemini/OpenAI from aggregators ([devtk.ai](https://devtk.ai/en/blog/gemini-api-pricing-guide-2026/), [apidog GPT-5.5](https://apidog.com/blog/gpt-5-5-pricing/)): verify on official pages before budgeting.
