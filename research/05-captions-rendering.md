# 05 — Caption Rendering + Final Encoding

Research date: 2026-11-15. Target box: Intel i7-8665U (4C/8T, 15 W laptop part), UHD 620 iGPU, 24 GB RAM, no NVIDIA, ffmpeg installed.

Legend: **[V]** verified from a primary source during this research (repo/docs/official page or local `ffmpeg -h`). **[U]** unverified, my estimate, or third-party only.

---

## 0. TL;DR recommendation

1. **Captions: generate ASS files (pysubs2 or plain string templates) from word-level timestamps and burn them with libass via ffmpeg's `subtitles` filter in the same single encode as the cut, crop, scale and loudnorm.** libass gives anti-aliased text, thick outlines, shadows, blur/glow, boxes, per-word color, karaoke `\k` and `\t` scale/alpha/color animation. It costs almost nothing in CPU and it is already in the installed ffmpeg build [V]. That covers Hormozi- and MrBeast-style pop-in captions.
2. **libass can't draw color emoji** (open issue #381, maintainer says the architecture does not permit multicoloured glyphs [V]). Draw emoji as PNG overlays (Noto Emoji OFL-1.1 [V] or Twemoji CC-BY-4.0) through ffmpeg `overlay=...:enable='between(t,a,b)'` in the same filter graph.
3. **Premium upgrade path (optional):** use **pycaps** (MIT, CSS/Chromium-rendered, alpha) for templates libass can't do: gradients, real color emoji, CSS animations. **Remotion** is excellent but needs a **PAID** company license unless the operator is an individual or a company of ≤3 people [V]: Automators cost $0.01/render with a $100/month minimum [V].
4. **Encode:** a single pass from the original source. Use `libx264 -preset slow -crf 16 -tune film`, High profile, yuv420p 8-bit, BT.709 tags, CFR at the source fps, closed GOP, `-movflags +faststart`, AAC-LC 48 kHz 320k. Skip HEVC, AV1 and 10-bit for upload: every platform re-encodes, and H.264 at a high bitrate is the safest and best-supported mezzanine.
5. **Audio:** two-pass `loudnorm` at I=-14 LUFS, TP=-1.5 to -2.0 dBTP, plus `aresample=48000` after it. Add 20–30 ms fade-in and 60–100 ms fade-out at cuts, and pad 150–250 ms before the first word and 300–500 ms after the last word. Snap cuts to inter-word silence.
6. **Biggest quality lever that isn't a codec setting:** fetch the **highest-resolution source** (4K if available). A 9:16 crop of a 1080p landscape video is only 608×1080, so scaling it to 1080×1920 is a 1.78× *upscale* that no encoder setting can hide. A 9:16 crop of 2160p is 1215×2160, which *downscales* cleanly.

---

## 1. Caption renderers — comparison

| Tool | What it is | License | Maintenance (pushed / release) | Stars | HW needs | Animation | Typography quality | Color emoji | Speed (60 s 1080×1920, this CPU) | Weaknesses |
|---|---|---|---|---|---|---|---|---|---|---|
| **libass via ffmpeg `subtitles`/`ass` filter** | ASS/SSA renderer inside ffmpeg | ISC [V] | Active, pushed 2026-11-10 [V] | 1.2k [V] | CPU only, negligible | `\k/\kf/\ko` karaoke, `\t(t1,t2,accel,…)` on scale/color/alpha/blur/border/rotation, `\move`, `\fad`, `\clip` | Very good: AA, `\bord` outlines, `\shad`, `\blur`/`\be` glow, BorderStyle 3 boxes, HarfBuzz shaping [V: build has libharfbuzz/fribidi/freetype] | **No** (issue #381 open; grey/mono emoji only if the font has outlines) [V] | Adds ~0–5 % to the encode [U] | No gradients, no RGBA bitmaps, only power-curve easing (`accel`), `\fscx` on one word changes its advance width so neighbours *shift* during a pop (workaround below), fonts must be passed via `fontsdir` |
| **pysubs2** | Python lib to write/edit ASS/SRT | MIT [V] | Pushed 2026-11-10 [V] | 448 [V] | — | (authoring only) | — | — | instant | Just a file writer; you still write the override tags yourself |
| **pycaps** | CSS-styled word captions; renders word images with Playwright/Chromium (or a lighter "Pictex" renderer) and composites with `movielite` | MIT [V] | v0.3.0 on 2026-09-30; README says "very alpha", not on PyPI [V] | 233 [V] | CPU; Chromium (~300 MB) | CSS states (`.word-being-narrated`), built-in pop/fade/slide, emoji insertion, word tagging via regex/AI [V] | Browser-grade (CSS text-stroke, shadows, gradients) | **Yes** (ships emoji asset releases) [V] | Minutes [U] (Chromium screenshots, cached per word) | Alpha-quality, small community, extra composite pipeline (the encode settings are movielite's, not yours) |
| **Remotion** | React → video, headless Chrome frames + ffmpeg | Custom source-available. **Free** for individuals and companies of ≤3 people. Otherwise **PAID**: Creators $25/seat/month, or Automators $0.01/render, billed in 1,000-render blocks, $100/month minimum [V] | Very active, v4.0.543 on 2026-11-11 [V] | 73k [V] | CPU + Chrome; 8 GB+ RAM | Anything CSS/JS/Canvas/Lottie/WebGL | Best (browser text engine) | Yes | ~2–6 min at concurrency 4 [U] | License cost for a business, Node toolchain, slower than libass by roughly 50× [U] |
| **Revideo** (fork of Motion Canvas) | TypeScript scene → video, headless render API | MIT [V] | Repo moved to `midrender/revideo`, pushed 2026-07-15 [V] | 4.2k [V] | CPU + browser | Rich, code-driven tweens | Browser/canvas | Yes | Minutes [U] | Smaller community, slower cadence; you build the caption component yourself |
| **Motion Canvas** | Animation editor/library (canvas) | MIT [V] | Pushed 2026-07-02 [V] | 19.9k [V] | Browser | Excellent tween system | Canvas-grade | Yes | Minutes [U] | Built around an editor, not headless batch video compositing with source footage |
| **MoviePy 2.x** | Python compositing over ffmpeg pipes, numpy frames | MIT [V] | v2.2.1 on 2025-05-21; repo pushed 2026-08 [V] | 15k [V] | CPU | Per-frame Python functions | PIL `TextClip` (OK AA, basic stroke) | Not really (PIL color-font support is limited) [U] | Slow: Python per-frame, typically several × slower than ffmpeg alone (its docs acknowledge it is slower than ffmpeg directly) [V-partial] | v2 broke the v1 API (`moviepy.editor` removed) [V], slow, double encode if misused |
| **captacity** | Whisper + MoviePy captions for Shorts | MIT [V] | Last push 2024-06 (stale) [V] | 141 [V] | CPU | Word highlight | MoviePy TextClip | No | Slow | Abandoned, MoviePy 1.x era |
| **auto-subtitle (m1guelpf)** | Whisper → SRT → ffmpeg burn | MIT [V] | Last push 2024-07 (stale) [V] | 2.3k [V] | CPU/GPU for Whisper | None (plain SRT) | Plain | No | Fast | No word-level styling |
| **OpenShorts (mutonby/openshorts)** | Full clipping SaaS, open source | MIT [V] | Very active, pushed 2026-11-14 [V] | 8.4k [V] | CPU/NVENC | ASS presets: karaoke, pop (`\fscx90→\t(0,110,\fscx108)`), glow, box, highlight; Remotion composition for the browser editor [V] | libass | No (libass) | Fast | Uses PlayResY=288 (coarse units), and its grouping is chars/duration only (no phrase awareness) |
| **AI-Youtube-Shorts-Generator** (SamurAIGPT → now `Anil-matcha/…`) | Highlight picking + crop | MIT [V] | Pushed 2026-11-12 [V] | 6.1k [V] | CPU | — | — | — | — | `local/clipper.py` re-encodes with `libx264 -preset fast -crf 20` and uses Haar cascades; I found no word-level caption renderer in the local clipper [V] |
| **ClipsAI** | Clip finding + resizing library | MIT [V] | Last push 2024-01 (stale) [V] | 571 [V] | GPU helpful | — | — | — | — | Stale. Caption rendering not part of the library [U] |
| **ffmpeg `drawtext`** | Text via FreeType | LGPL/GPL | ffmpeg | — | CPU | Expressions on x/y/alpha/fontsize per frame; one style per filter instance | Decent AA, `borderw`, `shadowx` | No | Fast, but one drawtext per word gets unwieldy | No per-word styling in one line, no shaping control, gets messy fast |
| **Blender VSE** | NLE with Python API | GPL | Active | — | CPU/GPU | Keyframe anything | Good | Limited | Slow (minutes), heavy | Overkill; headless scripting is clunky |
| **Natron** | Node compositor (Nuke-like) | GPL | Last tagged release v2.5.1-pre2, 2024-09 [V]; low activity | — | CPU | Keyframes | Good | No | Slow | Effectively unmaintained for production pipelines |

### Notes and evidence

- **libass emoji:** [libass#381](https://github.com/libass/libass/issues/381), still open. The maintainer statement is quoted in the table. A January 2026 analysis says RGBA output would be needed first [V].
- **OpenShorts libass lessons** (read from [`subtitles.py`](https://github.com/mutonby/openshorts/blob/main/subtitles.py)) [V]:
  - Dimming inactive words with **alpha** looks muddy because libass draws the outline under a semi-transparent fill. They **scale RGB toward black** instead and keep alpha 1.0.
  - "Highlight box" behind only the active word: a second style with `BorderStyle=3` applied via `{\rActive}`. libass boxes each style run separately.
  - Their pop effect, "75→112 read as a sizing bug", was toned down to `\fscx90\fscy90\t(0,110,\fscx108\fscy108)`.
  - Event pattern: **one Dialogue event per active word**, each containing the whole chunk. Event end = next word start, so there's no flicker in gaps.
  - Filter-arg escaping bug with apostrophes in paths: keep ASS paths simple (no quotes or colons) or escape them properly.
- **OpenShorts loudness measurement** (in [`ffmpeg_utils.py`](https://github.com/mutonby/openshorts/blob/main/ffmpeg_utils.py)) [V]: across 14 clips, `TP=-1.5` still produced +0.2 dBTP after AAC encoding (1 clip clipping). `TP=-2.0` peaked at -0.3 dBTP with 0 clipping. Neither `alimiter` after loudnorm nor linear two-pass fixed the AAC inter-sample overshoot, so headroom is the only lever. Their production value is `loudnorm=I=-14:TP=-2.0:LRA=11`.
- **pycaps** composites through the author's own `movielite` library (MIT, 73 stars [V]). Final-encode quality depends on that library, so render captions with pycaps only if you can export an alpha layer or control its encoder [U].
- **Remotion license page:** https://www.remotion.dev/docs/license/pricing.md [V].

### libass capability cheat-sheet for "top creator" styles

Set `PlayResX: 1080`, `PlayResY: 1920` (and `LayoutResX/Y` the same) so every number is in output pixels. Add `ScaledBorderAndShadow: yes`. Use `WrapStyle: 2` (no auto wrap) and insert `\N` yourself.

| Effect | ASS recipe |
|---|---|
| Pop-in word (overshoot) | `{\fscx70\fscy70\t(0,90,\fscx112\fscy112)\t(90,160,\fscx100\fscy100)}WORD` |
| Fade + rise | `{\fad(60,0)\move(540,1240,540,1220,0,120)}` |
| Active-word color | `{\1c&H00E1FF&}WORD{\r}` (ASS colors are **BGR**: yellow = `&H00FFFF&`, Hormozi green ≈ `&H5AE63C&`) |
| Glow | `{\3c&H00FFFF&\bord8\blur6}` on a layer-0 copy under a crisp layer-1 copy |
| Box behind active word | 2nd style `BorderStyle=3`, `Outline`=padding, `OutlineColour`=box color; switch with `{\rActive}` |
| Karaoke sweep | `{\kf35}word` (centiseconds) with SecondaryColour as the un-sung color |
| Shake / rotate | `\t(0,60,\frz-4)\t(60,120,\frz3)\t(120,160,\frz0)` |
| Easing | `\t(t1,t2,accel,…)`: accel <1 = ease-out, >1 = ease-in (power curve only) |

**Pop without reflow (important):** `\fscx` changes a word's advance, so the other words in the line jiggle while one word scales. For 1–3-word chunks, either:
- scale the *whole chunk* on entry, and change only color on the active word (Hormozi look); or
- lay out words yourself. Measure advances with fontTools/HarfBuzz/PIL `ImageFont.getlength`, then emit each word as its own event with `\an5\pos(x,y)` and scale around its own centre.

The second option is what pro tools effectively do. [U: approach, standard practice]

### Word grouping (chunking) algorithm

Input is word timestamps from the ASR stage (WhisperX / faster-whisper `word_timestamps`). Rules I recommend; OpenShorts uses only `max_chars=20, max_duration=2.0` [V]:

1. **Size:** 1–3 words or ≤ ~14–18 characters per line for bold 90–110 px fonts (Montserrat Black is wide: OpenShorts budgets 9 chars per line at its size 44 vs. 16 for condensed Anton [V]). One line by default, two lines max.
2. **Hard breaks:** sentence punctuation `. ? !`. Soft breaks: `, ; : —`.
3. **Pause break:** gap to the next word > 250–300 ms.
4. **Don't end a chunk on a function word** (`a, the, to, of, and, in, I, my, your…`). Carry it to the next chunk. Keep number+unit and name pairs ("$10 million", "Elon Musk") together.
5. **Max chunk duration** ~1.5–2.0 s. **Minimum on-screen** ~250–300 ms: merge micro-chunks.
6. **Event timing:** chunk start = first word start minus ~0–40 ms (captions feel late otherwise [U]). Chunk end = next chunk start if the gap is < 300 ms (no flicker), else last word end + 150 ms.
7. **Emphasis:** tag keywords (numbers, money, superlatives, an LLM-picked "power word" per chunk) for color, a bigger scale, or an emoji.
8. **Caps:** ALL CAPS for Hormozi/MrBeast styles. Strip filler words ("um", "uh") only if the ASR output keeps them and the audio cut doesn't.

### Safe zones (1080×1920)

None of the three platforms publishes one simple pixel table for organic posts. Third-party measurements disagree [V that they disagree; individual numbers U]:

- **TikTok:** the official answer is downloadable safe-zone templates in TikTok Ads Manager. Third-party readings: top 130–240 px, **bottom 440–660 px**, sides 80–120 px, right action column ~120–160 px.
- **Meta Reels (ads):** widely cited as top 14 % (~270 px), **bottom 35 % (~670 px)**, sides 6 % (~65 px). Third parties say this is the ad spec; organic Reels have no official spec.
- **YouTube Shorts:** no official pixel table found. Commonly cited: keep the bottom ~20–25 % and the right ~15 % clear.

**Conservative union to use:** keep captions inside **x ∈ [120, 960]** (max text width 840 px) and **y ∈ [270, 1250]**. A good caption anchor is **`\an5` centre at y ≈ 1100–1180** (about 58–61 % of the height), with the chunk block ≤ ~180 px tall. That clears the TikTok and Reels bottom UI and the description text on all three platforms. Verify against TikTok's official template files before locking the layout.

### Fonts (licenses)

| Font | Look | License | Notes |
|---|---|---|---|
| **Montserrat** Black/ExtraBold | Hormozi-ish geometric heavy | SIL OFL 1.1 (Google Fonts) [V: widely known; OpenShorts ships it] | Safe default |
| **Anton** | Condensed impact | SIL OFL 1.1 [U] | Fits more chars per line |
| **The Bold Font** | The "Hormozi font" | Commercial foundry (the-bold-font.com / MyFonts). Free DaFont copies may be personal-use only [U] | Buy a license, or use Montserrat Black |
| **Komika Axis** | MrBeast-style comic | Apostrophic Labs license: aggregators say free for commercial use, but no selling/repackaging, and the primary text is vague [U] | Check the bundled readme. Don't redistribute it inside a product |
| **Bebas Neue**, **Poppins** Black, **Inter** Black | Clean variants | OFL [U] | Good alternates |
| **Noto Color Emoji** / **Twemoji (jdecked fork)** PNGs | Emoji overlays | OFL-1.1 [V] / CC-BY-4.0 graphics (attribution) [U] | Don't use Apple emoji art (not licensed for this) |

Bundle fonts in `assets/fonts/` and always pass `fontsdir=`. Otherwise libass silently falls back through fontconfig to a different font.

---

## 2. Encoding for max quality

### Official upload specs

**YouTube** (official, [support.google.com/youtube/answer/1722171](https://support.google.com/youtube/answer/1722171)) [V]:

| Setting | Spec |
|---|---|
| Container | MP4, no edit lists, moov at the front (faststart) |
| Video | H.264 High Profile, CABAC, 4:2:0, VBR, no bitrate cap required |
| GOP | Progressive. Closed GOP, GOP length = half the frame rate, 2 consecutive B-frames |
| Frame rate | Keep the original frame rate |
| Bitrate (1080p SDR) | 8 Mbps (24–30 fps), 12 Mbps (48–60 fps) |
| Audio | AAC-LC (or Opus), stereo, 48 kHz |
| Color | BT.709 primaries/transfer/matrix |

**TikTok:**
- Official ad specs, via third parties: ≥540×960, bitrate ≥2.5 Mbps (≥516 kbps also cited), MP4/MOV, H.264.
- Organic uploads accept 1080×1920. TikTok re-encodes heavily (H.264/H.265 at a few Mbps) [U].

**Instagram Reels:** no official Meta page was found in this session. Third-party consensus [U]:
- MP4/MOV, H.264, AAC 48 kHz, 1080×1920, 23.976–60 fps, **CFR** (VFR reportedly causes upload problems), ~8–15 Mbps.

### Codec comparison for the *upload master*

| Codec | Quality/bit | Platform ingest | Encode speed on i7-8665U, 1080×1920 60 s @30 fps [U estimates] | Verdict |
|---|---|---|---|---|
| **libx264** `-preset slow -crf 16 -tune film` | Baseline; at ≥12 Mbps visually transparent | Universal; YouTube's recommended codec | ~12–20 fps → **~1.5–2.5 min** | **Use this** |
| libx264 `-preset medium -crf 17` | Slightly worse per bit; irrelevant at this bitrate | Universal | ~25–40 fps → **~45–75 s** | Fast-iteration / preview mode |
| libx264 `-preset veryslow -crf 16` | Marginal gain | Universal | ~5–8 fps → **~4–6 min** | Not worth it |
| libx265 `-preset slow -crf 18` | ~25–40 % fewer bits for the same quality | YouTube/TikTok/IG accept it, but some web uploaders and older Android paths mis-handle HEVC [U] | ~2–4 fps → **~8–15 min** | No benefit: the platform re-encodes anyway |
| SVT-AV1 `-preset 6 -crf 24` | Best per bit | YouTube accepts it. TikTok/IG ingest support unclear [U] | ~4–8 fps → **~4–8 min** | Not for upload; maybe for archive |
| h264_qsv (UHD 620 Quick Sync) `-global_quality 18` | Visibly worse per bit than x264 slow; OK at very high bitrate | Universal | ~100–200 fps → **~10–20 s** | Draft previews only |

The local ffmpeg (gyan.dev 2024-09-19 full build) has libx264, libx265, libsvtav1, QSV encoders, libzimg (zscale), libass, libvmaf and libplacebo [V via `ffmpeg -buildconf`]. It has the native `aac` encoder (no libfdk_aac). Native AAC at 256–320 kbps is transparent enough for speech [U].

### Settings rationale

- **CRF 16–17, not two-pass.** Two-pass ABR only helps when you must hit a file size. CRF gives constant quality. Cap the spikes with `-maxrate 25M -bufsize 50M` so a high-motion clip doesn't produce a 60 Mbps file that a platform decimates [U on platform behaviour]. A 60 s talking-head clip at CRF 16 slow ≈ 8–20 Mbps ≈ 60–150 MB [U].
- **Upload high bitrate.** Platforms transcode everything, and a cleaner input means fewer artifacts after their encode (generation loss stacks). Aim for ≥ YouTube's 12 Mbps HFR figure even at 30 fps.
- **`-tune film`** suits live-action talking heads: lower deblock, keeps texture. Don't use `-tune animation` or `stillimage`. Leave psy defaults.
- **GOP:**
  - YouTube asks for a closed GOP of half the frame rate with 2 B-frames [V].
  - With x264: `-g <fps/2 rounded> -keyint_min <same> -sc_threshold 0 -bf 2 -x264-params open-gop=0`. At CRF 16 the extra I-frames cost little.
  - Alternative: `-g <fps>` (1 s). Either is fine for TikTok/IG [U].
- **Profile/level:** `-profile:v high -level:v 4.2` covers 1080×1920 up to 60 fps.
- **Pixel format and color:**
  - Use `-pix_fmt yuv420p` (8-bit). Platforms deliver 8-bit SDR, and 10-bit H.264 (High10) is poorly supported on ingest, so don't use 10-bit for upload.
  - Tag BT.709 explicitly: `-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`.
  - When scaling, pass `out_color_matrix=bt709` (and `in_color_matrix=bt709` if the source is untagged HD). Otherwise swscale may assume BT.601 and shift skin tones [U: common pitfall].
- **`-movflags +faststart`** [V YouTube requirement].
- **Scaling filter:**
  - Downscale (4K crop → 1080×1920): `lanczos` or zscale `spline36`. Both are sharp with minimal ringing.
  - Upscale (1080p crop 608×1080 → 1080×1920): `lanczos` (slight ringing) or `spline36` (a touch softer, less ringing). Optionally add a light `unsharp=5:5:0.4` or AI upscaling (section 4).
  - Avoid the default `bicubic` and `bilinear`. Add `+accurate_rnd+full_chroma_int` to swscale flags.
- **Frame-accurate cutting:**
  - With `-ss` **before** `-i` and transcoding, ffmpeg seeks to the previous keyframe, then *decodes and discards* up to the exact position (`-accurate_seek` is on by default). With stream copy, the extra segment is *kept* [V: ffmpeg.html]. So **never `-c copy` for clip cuts.** Always cut in the same encode that does crop/scale/captions.
  - Input `-ss` resets timestamps to 0, so write the ASS file in **clip-relative** time.
- **Avoid generational loss:**
  - Exactly one lossy encode: source → final.
  - If the reframing stage (OpenCV/Python) must produce frames, **pipe rawvideo straight into the final ffmpeg** (`-f rawvideo -pix_fmt bgr24 -s WxH -r FPS -i -`), with audio taken from the source by a second `-i` and the same `-ss`.
  - If an intermediate file is unavoidable, make it lossless (`-c:v libx264 -qp 0` or FFV1) or at least CRF ≤ 10. OpenShorts uses CRF 18 intermediates, which is a second generation [V].
- **VFR → CFR:**
  - Detect with ffprobe: `r_frame_rate` ≠ `avg_frame_rate`, or `ffmpeg -vf vfrdet`.
  - Force CFR at the *source's nominal* rate with the `fps=<rate>` filter early in the graph, plus `-fps_mode cfr` (ffmpeg ≥5.1; older versions use `-vsync cfr`). The fps filter duplicates or drops only where the source timing really had gaps.
  - Never change 30→60 or 24→30. Keep the source rate per YouTube [V].
  - yt-dlp YouTube sources are normally CFR. Phone and screen recordings are often VFR.
- **Burning captions and chroma:** do `format=yuv444p` (or `gbrp`) → `subtitles` → `format=yuv420p` so libass blends at full chroma resolution. The final 4:2:0 subsampling is unavoidable, but this avoids double chroma rounding around the colored outlines [U, minor].

---

## 3. Audio

| Item | Recommendation | Evidence |
|---|---|---|
| Target loudness | **-14 LUFS integrated** for all three platforms | YouTube normalises playback to ~-14 LUFS (downward only). TikTok/IG targets are unpublished; -14 is the consensus practice [U]. Don't master hotter than -12 |
| True peak | **-1.5 dBTP, or -2.0 dBTP with native AAC** | AAC adds inter-sample overshoot; measured +1.7 dB in OpenShorts' corpus [V repo comment] |
| LRA | 11 (or 7–9 for punchier speech) | |
| Method | **Two-pass loudnorm**, `linear=true`. Linear mode needs target LRA ≥ source LRA and a gain that doesn't break TP; otherwise loudnorm silently falls back to dynamic mode [V docs mirror 7.0.3]. In dynamic mode it upsamples to 192 kHz, so **always follow it with `aresample=48000`** [V] | `ffmpeg -h filter=loudnorm` [V] |
| Pre-levelling (optional) | Podcasts with one quiet and one loud guest: `speechnorm=e=6:r=0.0001:l=1` or gentle `acompressor=threshold=-20dB:ratio=3:attack=10:release=200` before loudnorm. `highpass=f=70` to remove rumble | [U tuning] |
| Cut boundaries | Pad **150–250 ms before the first word and 300–500 ms after the last word**. Snap to the nearest inter-word gap ≥ 120 ms (word timestamps or a VAD such as Silero). `afade=t=in:d=0.025`, `afade=t=out:st=DUR-0.08:d=0.08`. Whisper word *end* times are often early by 50–200 ms, so be generous at the tail [U] | |
| Sample rate / codec | AAC-LC 48 kHz stereo, 256–320 kbps (`-c:a aac -b:a 320k -ar 48000`) | YouTube spec [V] |
| Tooling | `ffmpeg-normalize` (slhck, 1.5k stars, active Nov 2026 [V]) wraps two-pass loudnorm if you'd rather not parse JSON | |

### Speech enhancement / denoise (optional; default OFF for already-clean podcast audio)

| Tool | License | Status | HW | Quality | Artifacts / weaknesses |
|---|---|---|---|---|---|
| **DeepFilterNet 3** | MIT / Apache-2.0 dual [V: LICENSE-MIT + LICENSE-APACHE] | Repo pushed 2026-11; last tagged release v0.5.6 (2023-08) [V] | CPU real-time; full-band 48 kHz | Best free option for noise and room tone | Over-suppression makes voices thin or watery. Use `--atten-lim 12–20` dB to blend [U] |
| **ffmpeg `arnndn`** (RNNoise) | BSD (model files from GregorR/rnnoise-models, no license field, last updated 2018 [V]) | Built into ffmpeg [V] | CPU, very fast | Decent on steady noise | 48 kHz only. Can gate breaths and word tails and "underwater" music beds. Use `mix=0.7` [U] |
| `afftdn` / `anlmdn` | ffmpeg | Built in [V] | CPU | Mild broadband hiss removal | Musical-noise artifacts if pushed |
| **Resemble Enhance** | MIT [V] | Last push 2024-12 (stale) [V] | GPU recommended; CPU very slow | Denoise + bandwidth restoration | Generative: can alter timbre or hallucinate. Risky for "authentic" podcast voices [U] |
| **Adobe Podcast Enhance** — **PAID** (Premium ~US$9.99–19.99/month [U]) | Proprietary cloud | Active | Cloud | Very strong "studio" effect | Over-processed at 100 % strength (use 40–70 %). Upload/privacy, manual or unofficial API |

---

## 4. Upscaling (note only; the reframing agent covers it)

- **Real-ESRGAN** (BSD-3 [V], 37.5k stars, last push 2024-08 [V]): the `realesrgan-ncnn-vulkan` build runs on Intel iGPUs via Vulkan. On UHD 620, expect roughly 0.3–2 fps for 608×1080→2× [U]. That's 15–90 min per 60 s clip, so only for hero clips. It can over-smooth skin ("waxy"). Prefer `realesr-general-x4v3` with a denoise strength around 0.5 [U].
- **Video2X** (AGPL-3.0 [V], 22.7k stars, last push 2026-03 [V]): front-end for Real-ESRGAN/RealCUGAN/Anime4K, Vulkan.
- **waifu2x**: anime-oriented, not for faces.
- **ffmpeg `dnn_processing`/`sr`:** needs TF/OpenVINO backends that this build lacks [U]. Not practical.
- **Better first step:** download a 4K source, so no upscale is needed.

---

## 5. Recommended render recipe

### 5.1 Pipeline

1. Probe the source (ffprobe): fps (`r_frame_rate`/`avg_frame_rate` → CFR/VFR), color tags, width/height, audio sample rate.
2. Choose `START`/`END` from the clip-selection stage. Snap both to word gaps, then pad (pre 0.2 s, post 0.4 s). `DUR = END - START`.
3. Build `clip.ass` in clip-relative time from word timestamps using the chunking rules (PlayRes 1080×1920).
4. **Loudnorm pass 1** on exactly the same segment and pre-chain. Parse the JSON.
5. **Final single encode:** seek → crop (or the reframer's rawvideo pipe) → scale → CFR → subtitles (+ emoji overlays) → x264. Audio: pre-chain → loudnorm pass 2 → resample → AAC.
6. QA (optional, automated):
   - `ffmpeg -i out.mp4 -af ebur128=peak=true -f null -` to confirm -14 ± 1 LUFS and TP < -1.
   - Compare `ffprobe -count_frames` against `DUR*fps` (no dropped or duplicated frames).
   - Spot-check VMAF against a lossless reference render (libvmaf is in the build [V]).

### 5.2 Loudnorm pass 1 (measure)

```bash
ffmpeg -hide_banner -nostats -ss START -i "src.mp4" -t DUR -vn \
  -af "highpass=f=70,afade=t=in:st=0:d=0.025,afade=t=out:st=DUR_MINUS_0.08:d=0.08,loudnorm=I=-14:TP=-2.0:LRA=11:print_format=json" \
  -f null - 2> loudnorm_pass1.log
# parse input_i, input_tp, input_lra, input_thresh, target_offset from the JSON at the end of the log
```

### 5.3 Final single encode (static crop; captions; loudnorm pass 2)

```bash
ffmpeg -hide_banner -y \
  -ss START -i "src.mp4" -t DUR \
  -filter_complex "\
[0:v]crop=CW:CH:CX:CY,\
scale=1080:1920:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=tv,\
fps=SRC_FPS,setsar=1,format=yuv444p,\
subtitles=filename=clip.ass:fontsdir=assets/fonts,\
format=yuv420p[v];\
[0:a]aresample=48000,highpass=f=70,\
afade=t=in:st=0:d=0.025,afade=t=out:st=DUR_MINUS_0.08:d=0.08,\
loudnorm=I=-14:TP=-2.0:LRA=11:measured_I=MI:measured_TP=MTP:measured_LRA=MLRA:measured_thresh=MTH:offset=OFF:linear=true,\
aresample=48000[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset slow -crf 16 -tune film -profile:v high -level:v 4.2 \
  -maxrate 25M -bufsize 50M \
  -g GOP -keyint_min GOP -sc_threshold 0 -bf 2 -x264-params open-gop=0 \
  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -fps_mode cfr \
  -c:a aac -b:a 320k -ar 48000 -ac 2 \
  -movflags +faststart \
  "out_1080x1920.mp4"
```

- `GOP` = round(fps/2), per YouTube [V]. Using `fps` (1 s) is also acceptable.
- **Windows paths inside filter args:** escape the drive colon, e.g. `subtitles=filename='C\:/clips/clip.ass':fontsdir='C\:/proj/assets/fonts'`. Or `cd` into the work dir and use bare relative names; that's the simplest and avoids the escaping bug OpenShorts hit [V].
- **Speed / preview mode:** swap to `-preset medium -crf 17` (~45–75 s per 60 s clip [U]), or `h264_qsv -global_quality 18` for drafts (~15 s [U]).
- **Dynamic crop** (speaker tracking) from the reframer: replace `[0:v]crop=…` with a rawvideo pipe input already at 1080×1920:
  ```bash
  ffmpeg -f rawvideo -pix_fmt bgr24 -s 1080x1920 -r SRC_FPS -i - -ss START -i src.mp4 -t DUR \
    -filter_complex "[0:v]format=yuv444p,subtitles=...,format=yuv420p[v];[1:a]...[a]" ...
  ```
  For a bgr24 pipe, add `scale=out_color_matrix=bt709` in the RGB→YUV step. Alternatively, drive `crop` with `sendcmd` keyframes (no Python frame I/O; faster).

### 5.4 Emoji overlays in the same graph

```bash
-i assets/emoji/1f525.png  # input #1, 160x160 PNG (Noto/Twemoji)
... [vcap][1:v]overlay=x=(W-w)/2:y=930:enable='between(t,3.20,4.10)':format=auto[v] ...
```

Many emoji mean many inputs; alternatively, pre-composite all emoji into a transparent `qtrle`/PNG-sequence layer. Optionally animate the pop with `scale=…:eval=frame` on the emoji stream.

### 5.5 ASS template (Hormozi-style, per-word pop + active color)

```ass
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
LayoutResX: 1080
LayoutResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Montserrat Black,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H99000000,-1,0,0,0,100,100,0,0,1,7,4,5,120,120,0,1
Style: Glow,Montserrat Black,96,&H00FFFFFF,&H00FFFFFF,&H0000E1FF,&H00000000,-1,0,0,0,100,100,0,0,1,12,0,5,120,120,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
; chunk "THIS IS HUGE" — chunk pops in once, active word turns yellow
Dialogue: 1,0:00:01.20,0:00:01.46,Cap,,0,0,0,,{\pos(540,1140)\fscx80\fscy80\t(0,80,\fscx108\fscy108)\t(80,150,\fscx100\fscy100)}{\1c&H00E1FF&}THIS{\r} IS HUGE
Dialogue: 1,0:00:01.46,0:00:01.62,Cap,,0,0,0,,{\pos(540,1140)}THIS {\1c&H00E1FF&}IS{\r} HUGE
Dialogue: 1,0:00:01.62,0:00:02.30,Cap,,0,0,0,,{\pos(540,1140)}THIS IS {\1c&H3CE65A&\fscx115\fscy115}HUGE{\r}
```

The `YCbCr Matrix: TV.709` header makes libass skip its BT.601 colour mangling, so caption colors match the design [U: libass behaviour, widely documented].

Generator pseudo-logic: for each chunk, for each word index i, emit one event `[word_i.start, next.start)` containing the whole chunk. Give word i the active override, and give the first event the entry-pop transform. Use per-word `\pos` layout if you want the active word itself to scale without reflow.

---

## 6. Render-time estimates (60 s, 1080×1920, 30 fps, i7-8665U) [all U, extrapolated from typical x264 throughput on 4-core mobile CPUs]

| Approach | Estimated wall time |
|---|---|
| ffmpeg + libass + x264 slow CRF16 (recommended) | **~1.5–2.5 min** (4K VP9/AV1 source decode adds ~10–30 %) |
| same, x264 medium | ~45–75 s |
| same, h264_qsv draft | ~10–20 s |
| + emoji overlays | +2–5 % |
| + DeepFilterNet on audio | +5–15 s |
| pycaps (Chromium word renders + movielite composite) | ~3–8 min |
| Remotion (concurrency 4) | ~2–6 min |
| MoviePy 2.x with TextClip captions | ~4–10 min |
| x265 slow / SVT-AV1 p6 | ~8–15 min / ~4–8 min |
| + Real-ESRGAN upscale on UHD 620 (Vulkan) | +15–90 min |

---

## Sources

- libass emoji issue: https://github.com/libass/libass/issues/381
- YouTube recommended upload encoding: https://support.google.com/youtube/answer/1722171
- Remotion pricing/license: https://www.remotion.dev/docs/license/pricing.md
- ffmpeg `-ss` semantics: https://ffmpeg.org/ffmpeg.html
- loudnorm docs (7.0.3 mirror): https://ayosec.github.io/ffmpeg-filters-docs/7.0/Filters/Audio/loudnorm.html
- ffmpeg-normalize FAQ (linear fallback): https://slhck.info/ffmpeg-normalize/advanced/faq/
- OpenShorts code: https://github.com/mutonby/openshorts (`subtitles.py`, `ffmpeg_utils.py`, `dashboard/src/remotion/lib/captions.ts`)
- AI-Youtube-Shorts-Generator: https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator (`shorts_generator/local/clipper.py`)
- pycaps: https://github.com/francozanardi/pycaps
- Revideo: https://github.com/midrender/revideo · Motion Canvas: https://github.com/motion-canvas/motion-canvas · MoviePy: https://github.com/Zulko/moviepy
- captacity: https://github.com/unconv/captacity · auto-subtitle: https://github.com/m1guelpf/auto-subtitle · ClipsAI: https://github.com/ClipsAI/clipsai
- DeepFilterNet: https://github.com/Rikorose/DeepFilterNet · Resemble Enhance: https://github.com/resemble-ai/resemble-enhance · rnnoise-models: https://github.com/GregorR/rnnoise-models
- Real-ESRGAN: https://github.com/xinntao/Real-ESRGAN · Video2X: https://github.com/k4yt3x/video2x
- Noto Emoji: https://github.com/googlefonts/noto-emoji · Twemoji fork: https://github.com/jdecked/twemoji
- Safe-zone third-party measurements (disagree): https://www.socialync.io/tools/safe-zones/tiktok, https://www.manypixels.co/blog/social-media-design/tiktok-ad-specs, https://adkit.so/tools/safe-zones/meta, https://blog.adnabu.com/meta-ads/meta-safe-zones/
- Fonts: https://www.fontsquirrel.com/license/Komika-Axis, https://www.myfonts.com/foundry/Sven_Pels
- Loudness practice (third-party): https://openclip.app/learn/audio-normalization, https://www.forasoft.com/learn/audio-for-video/articles-audio/lufs-targets-per-platform-2026
