# 06 — Video Download & Ingest

Research date: 2026-11-15. Target machine: Windows 11, i7-8665U (4C/8T, Whiskey Lake, 15 W), Intel UHD 620 iGPU, 24 GB RAM, ~101 GB free on C:.

**How claims were checked.** **[V]** means checked this session against a primary source: the GitHub API via `gh`, the yt-dlp README or wiki, yt-dlp source code, or a local `--help`/`-encoders` run. **[U]** means unverified (from memory, secondary sources or estimates), so test it before relying on it.

---

## 0. Local environment (read-only checks) [V]

| Item | Found |
|---|---|
| yt-dlp | **2026.10.26**, the latest release. Installed via winget as a standalone binary, so `yt-dlp-ejs` is bundled. |
| Deno | **2.9.8** on PATH. This is yt-dlp's default JS runtime (minimum 2.3.0), so YouTube JS challenges can be solved with no extra setup. |
| Node | v25.5.0. It can be used with `--js-runtimes node`, but yt-dlp does not need it. |
| ffmpeg | `2024-09-19` gyan.dev full build. It includes `libdav1d`, `libx264`, `prores_ks`, `dnxhd`, `ffv1`, `utvideo`, `libsvtav1`, `h264_qsv`/`hevc_qsv`, `vp9_qsv`/`av1_qsv` decoders and the `vfrdet` filter. Hardware acceleration: qsv, d3d11va, dxva2, vulkan, opencl. The build is about 14 months old, so consider updating it later. |
| GPU | Intel UHD 620 (Gen 9.5). It has **hardware VP9 decode, including 10-bit** [U: per Intel Gen9.5 specs] but **no AV1 hardware decode**. AV1 hardware decode only arrived with Gen12 / Tiger Lake. The `av1_qsv` decoder exists in the build but will fail on this GPU [U]. |
| Disk | About 101 GB free. This is the binding constraint on any mezzanine strategy (see §3). |

---

## 1. yt-dlp: status and YouTube restrictions as of late 2026

### 1.1 Project health [V]
- **License:** Unlicense (public domain). **Stars:** about 208k. **Open issues:** about 2.8k. **Last push:** 2026-11-14.
- **Releases in 2026:** 01.29, 01.31, 02.04, 02.21, 03.03, 03.13, 03.17, 06.09, 07.04, 08.19, 10.21, 10.26. That works out to roughly one or two stable releases a month, with fixes clustered whenever YouTube breaks something. Nightly and master builds ship more often.
- This is the de-facto standard. Every alternative listed below is either smaller or depends on yt-dlp-style internals. It is actively maintained, and YouTube breakages are usually fixed within days. **You must keep it updated**: plan on `yt-dlp -U`, or `winget upgrade yt-dlp`, before each batch.
- The repo now has a "NO AI / NO LLM POLICY" for issues. Bug reports must be written by a human.

### 1.2 JavaScript runtime and EJS (now required) [V]
- yt-dlp's old Python JS interpreter has been replaced by **EJS** (`yt-dlp/ejs`, Unlicense, pushed 2026-10-26). EJS runs YouTube's player JavaScript in a real JS runtime to solve the "n" and signature challenges.
- The README says `yt-dlp-ejs` is "Required for full YouTube support" and needs an external JS runtime.
  - **Deno** is the only runtime enabled by default (minimum 2.3.0).
  - **Node** (22 or later) and **QuickJS** (2025-04-26 or later recommended) must be enabled with `--js-runtimes`.
  - **Bun** is deprecated, and versions after 1.3.14 are unsupported.
- **With no JS runtime**, the YouTube extractor falls back to `_DEFAULT_JSLESS_CLIENTS = ('visionos',)`, which gives a reduced format set. Read in `_video.py` source.
- Standalone and winget binaries bundle the EJS scripts. A pip install needs `pip install -U "yt-dlp[default]"`. Alternatively, `--remote-components ejs:github` or `ejs:npm` fetches the scripts at runtime; by default no remote components are allowed.
- **Conclusion for this machine:** Deno 2.9.8 is already on PATH, so this works out of the box. Verify with `yt-dlp -v <url>` and look for the `[debug] JS runtimes: deno-2.9.8` line.

### 1.3 Player clients, PO tokens and SABR [V]
Default clients in the current source (`yt_dlp/extractor/youtube/_video.py`):

| Situation | Clients |
|---|---|
| Anonymous with a JS runtime (our case) | `tv_samsung, visionos, web` |
| No JS runtime | `visionos` |
| Logged in (cookies) | `tv_samsung, web_embedded, web` |
| Logged in with Premium | `web_creator, tv_samsung, web` |

**SABR** is YouTube's proprietary "Server ABR" streaming protocol.
- Issue **#12482** "`web` only has SABR formats" is open and was updated 2026-08.
- The `web` client's `adaptiveFormats` no longer carry plain HTTPS URLs, so yt-dlp skips them with the warning "Some web client https formats have been skipped".
- A native SABR downloader is in progress: PR/issue **#13515** "[fd/sabr] Add YouTube SABR protocol downloader" is open and was updated 2026-10-28.
- Issue **#17666** (Sep 2026) reports that `mweb` and `web_embedded` also become SABR-only in some sessions, depending on per-IP or per-account A/B experiments. In that case `mweb` gets only format 18 (360p). A master-branch fix gives `web_embedded` the HLS formats 91–96, which go up to 1080p but are encoded in weaker H.264.
- **This is the main quality risk:** yt-dlp may silently fall back to a low-resolution or HLS-only format. The ingest pipeline must check the result (see §6.4).

**PO tokens.** These are "Proof of Origin" tokens generated with BotGuard. The PO Token Guide wiki was last edited 2026-07-12.

| Client | Token needed for | Notes |
|---|---|---|
| `web` | GVS and subtitles | SABR only |
| `mweb`, `web_music`, `tv_simply` | GVS | |
| `web_creator` | GVS | Needs account cookies |
| `android`, `ios` | GVS or player | |
| `tv`, `android_vr`, `web_embedded` | None | Limitations: `tv` returns DRM-protected formats without cookies; `android_vr` cannot play "made for kids" videos; `web_embedded` works only for embeddable videos. |
| `web_safari` | Its HLS formats currently need no GVS token | |

- **Premium accounts are exempt** from GVS tokens, but not from subtitle tokens.
- Tokens are bound to the video ID and may live as briefly as about 12 hours. Extracting them manually is no longer recommended.
- Without a token, affected formats return **HTTP 403**. The guide also warns that missing tokens may get "your account or IP address being blocked".

**bgutil-ytdlp-pot-provider** [V]
- Repo `Brainicism/bgutil-ytdlp-pot-provider`, GPL-3.0, about 905 stars, v2.0.2 released 2026-10-07. It is maintained by a yt-dlp maintainer and is the guide's primary recommendation.
- It uses LuanRT/BgUtils (about 350 stars, active).
- It has two parts: an HTTP server on `127.0.0.1:4416` (run via Docker or natively with Node 22+ or Deno 2+) and a plugin zip placed in a yt-dlp plugin folder.
- Its README warns: "Providing a PO token does not guarantee bypassing 403 errors or bot checks."
- The fallback provider is `coletdjnz/yt-dlp-getpot-wpc`, which mints tokens in a real browser (about 78 stars, active).
- **Recommendation:** don't install it on day one. The current defaults (`tv_samsung`, `visionos`) do not need tokens. Add bgutil only when you start seeing 403s, "Sign in to confirm you're not a bot", or format 18-only fallbacks. Native mode with Deno avoids needing Docker on Windows.

### 1.4 Cookies, rate limits and 403s
- **Cookies** [V for the client tables, U for the rest]:
  - Logged-in cookies switch the default clients and are needed for age-restricted or members-only content.
  - Two risks: (a) YouTube may flag or ban accounts used for bulk downloading, so use a throwaway account, not the channel's own account; (b) on Windows, `--cookies-from-browser chrome/edge` has been unreliable since Chrome 127's App-Bound Encryption [U]. **Firefox** cookie extraction, or an exported `cookies.txt` (Netscape format), is the reliable route.
- **Rate limiting** [U, based on reports]: aggressive downloading from one residential IP triggers "Sign in to confirm you're not a bot" and 403s. Use the `-t sleep` preset [V], which expands to `--sleep-subtitles 5 --sleep-requests 0.75 --sleep-interval 10 --max-sleep-interval 20`. Download serially. For a handful of long videos a day, a home IP is generally fine.
- **Recent open YouTube issues** [V] (2026-11-15), relevant to long downloads:
  - #18047: many "Read time out" and "X bytes read, Y more expected" errors.
  - #18031: HTTP 500 fragment failures on format 140.
  - #17812: tv_samsung formats skipped as DRM-protected.
  - #17740: auto-dubbed videos expose about 21 audio languages, some mislabelled as "original".
  - #17326: some videos fail to merge with "Conversion failed!".
  - #17412: "Did not get any data blocks" on subtitles.
- **Reliability for long (1–4 h) videos** [U, judged from issue patterns]:
  - Generally good. DASH downloads resume (`--continue`, `.part` files), and fragment retries cover transient errors.
  - The main failure modes are mid-download URL expiry, which shows up as a 403 after several hours, and fragment timeouts. Mitigate with `--retries infinite --fragment-retries infinite --retry-sleep fragment:exp=1:30`, and simply re-run the same command: it resumes. Also keep `--download-archive` so finished jobs are skipped.
  - Always validate after download that duration matches `info.json` within about 1 s and that ffprobe shows no truncated stream.

---

## 2. Choosing the highest-quality format

### 2.1 What YouTube serves
| Category | Typical itags | Notes |
|---|---|---|
| H.264 (avc1) DASH | 137 (1080p), 136 (720p), 299/298 (60fps) | Only up to **1080p**. Highest bitrate per resolution but the oldest codec. Usually not better visually than VP9/AV1 at the same resolution [U]. |
| VP9 DASH | 248 (1080p), 271 (1440p), 313 (2160p), 303/308/315 (60fps); VP9.2 HDR 33x | Available for 1440p/4K. Hardware-decodable on UHD 620. |
| AV1 DASH | 399 (1080p), 400 (1440p), 401 (2160p), 571 (8K); 69x (HDR) | Generally the default top choice. Often lower bitrate than VP9, with similar or slightly better perceived quality [U, community comparisons; varies per video]. |
| Premium "Enhanced bitrate" | **616** (VP9 1080p, HLS, Premium only) [V: the source tags 616/235 as "Premium"] | 1080p only. Matters only when 1080p is the maximum resolution. Needs Premium cookies, for which the default clients become `web_creator,tv_samsung,web`. |
| HLS (91–96, 23x) | Up to 1080p, H.264 | Fallback formats. Weaker. |
| Progressive 18 | 360p H.264 + AAC | The emergency fallback. **Never acceptable for production.** |
| Audio | **251** Opus about 130–160 kbps VBR (WebM); **140** AAC-LC 128 kbps (M4A); `251-drc` / `140-drc` are dynamic-range-compressed variants [V: the `-drc` suffix exists in source] | Opus 251 is the best standard audio. Avoid the `-drc` variants, because compressed dynamics are worse for mastering. **774** (Opus about 256 kbps, YouTube Music / Premium) [U: not referenced in yt-dlp source; reportedly appears on some Music tracks for Premium accounts; not relevant to podcasts]. |

yt-dlp's default video codec preference [V, README]: `av01 > vp9.2 > vp9 > h265 > h264 > vp8 …`. Audio: `flac/alac > wav/aiff > opus > vorbis > aac > mp4a > mp3 …`. The default sort is `lang,quality,res,fps,hdr:12,vcodec,channels,acodec,size,br,asr,proto,ext,hasaud,source,id`.

### 2.2 Recommended selection
- **Resolution beats codec.** Prefer the highest resolution first, then fps, then codec. yt-dlp's default already does this, so do **not** put `vcodec:h264` first (that is the `-t mp4` preset, which caps quality at 1080p).
- **HDR.** Podcasts are almost never HDR. Our deliverable is SDR (Shorts/Reels/TikTok), and tone-mapping adds risk. Prefer SDR when a same-resolution SDR stream exists: `-S "res,fps,hdr:SDR,vcodec,acodec"`. [U: confirm the `hdr:SDR` limit syntax with `-F` and `--print format_id` on a known HDR video. The README describes the `field:value` "prefer up to" semantics. If HDR is selected, the render step must tone-map.]
- **Audio.** Prefer the original language, and Opus over AAC; the default `lang` key handles the "original" track on auto-dubbed videos. Exclude DRC with a filter: `ba[format_id!*=drc]`.
- **AV1 vs VP9 on this CPU.** For final quality, AV1 at the same resolution is fine and usually the default. If AV1 decode turns out to be the bottleneck in testing, there is an override that is close to equal in quality: `-S "res,fps,hdr:SDR,vcodec:vp9,acodec"`, which can use the VP9 hardware decode on UHD 620.

### 2.3 Container: MKV vs MP4
- **MKV** (`--merge-output-format mkv`) stores AV1/VP9 + Opus without any re-muxing compromise, supports embedded chapters, subtitles and attachments, and is robust to interrupted writes. **Recommended for the archive and source copy.**
- **MP4** can hold AV1 + Opus, but some tools (old NLEs, some Windows players) handle Opus-in-MP4 poorly. Since our own ffmpeg pipeline reads the file, MKV is the safer choice. Export finished clips as MP4 (H.264/AAC) separately.
- Do **not** use `--recode-video`, because it re-encodes and loses quality. `--remux-video` is fine.

---

## 3. Why 4K/1440p matters, and the mezzanine strategy

### 3.1 Crop math
A 9:16 crop from a 16:9 frame uses about 31.6 % of the frame width.

| Source | 9:16 crop size | Upscale to 1080×1920 | Comment |
|---|---|---|---|
| 1080p | **608×1080** | **1.78×** | Visibly soft, and compression artifacts get magnified. A punch-in (zoom) makes it worse. |
| 1440p | 810×1440 | 1.33× | Acceptable to good. |
| 2160p (4K) | 1215×2160 | **0.89× (downscale)** | True 1080×1920 detail, with room to punch in up to about 1.12× with no upscaling. |

YouTube's bitrate also scales with resolution. Downloading the 4K stream of a podcast filmed in 4K gives much better detail even within the cropped region, because 1080p YouTube streams are heavily compressed. This is why 4K/1440p sources are **the single biggest lever on clip quality** in this stage. When a source is 1080p-only, flag it and use a better upscaler at render time (e.g. `zscale`/`lanczos` or an ML upscaler, covered elsewhere) plus mild sharpening.

### 3.2 Decode cost on the i7-8665U [U, estimates; benchmark before relying on them]
- dav1d is the fastest AV1 decoder. With 8 threads on a 4C/8T AVX2 laptop at 15 W TDP, YouTube 4K 8-bit AV1 (about 10–20 Mb/s) should decode at roughly **40–90 fps**. Sustained throughput is lower under thermal throttling. 1440p should run about 1.8× faster.
- VP9 4K on the CPU (libvpx/ffvp9) runs at roughly 40–80 fps. With `-hwaccel qsv` or `d3d11va` on UHD 620 it can exceed 60–100 fps and use little CPU.
- In context, the final 1080×1920 x264 encode at `-preset slow` will run at about **10–25 fps** on this CPU, so **decode is not the bottleneck** for rendering clips. Decode matters for *whole-video analysis passes* (face tracking, scene detection), and those should run on a low-resolution proxy anyway.
- **Benchmark command** (read-only; run it once a sample exists):
  `ffmpeg -hide_banner -benchmark -threads 8 -c:v libdav1d -i source.mkv -t 60 -f null -`

### 3.3 Mezzanine options and disk cost (rough data rates for 4K 30p, 1 hour) [U, standard published rates]
| Option | Data rate | Size per hour | Edit-friendliness | Verdict |
|---|---|---|---|---|
| Keep YouTube original (AV1/VP9 + Opus in MKV) | 8–25 Mb/s | **4–11 GB** | Long GOP. Seeking costs up to about 5 s of decode per seek. | **Keep always (the master).** |
| ProRes 422 HQ UHD | about 700+ Mb/s | about 320 GB | Excellent | ❌ Does not fit on disk. Re-encoding a lossy source just wastes space. |
| ProRes 422 / DNxHR HQ UHD | about 470–730 Mb/s | 210–330 GB | Excellent | ❌ |
| DNxHR SQ / ProRes LT UHD | about 240–330 Mb/s | 110–150 GB | Good | ❌ for whole videos |
| x264 all-intra, CRF 12–14, UHD | about 150–300 Mb/s | 70–135 GB | Good, frame-accurate | ❌ for whole videos |
| x264 short GOP (`-g 15 -bf 0`), CRF 14–16, UHD | about 40–80 Mb/s | 18–36 GB | OK | Possible, but rarely needed |
| **Analysis proxy**: 720p or 540p H.264, CRF 23, `-g 30` | 2–4 Mb/s | about 1–2 GB | Fast to seek and decode | ✅ **Create for every source** |

**Recommendation:**
1. **Never re-encode the whole source to an intermediate.** Keep the YouTube original byte-for-byte; it already is the highest quality available. Any intermediate is a generation loss plus a huge amount of disk.
2. Create a **low-resolution proxy** (plus a 16 kHz mono WAV for ASR) for all analysis passes: ASR, diarization, face/speaker tracking, scene detection. Keep the timestamps identical: CFR, same start time, no trimming.
3. For each **selected clip**, decode straight from the original master with an accurate seek (`-ss` before `-i` is frame-accurate when transcoding in modern ffmpeg) and include a few seconds of handles. Optionally write a short **segment mezzanine** (x264 CRF 10–12, `-g 1` all-intra, or ProRes 422 HQ). That is only seconds to a minute long, so a few hundred MB at most, and gives fast scrubbing in a review UI. This keeps the "decode once" benefit at negligible disk cost.

---

## 4. Metadata worth ingesting

| Data | How | Verified? | Use in the pipeline |
|---|---|---|---|
| Full metadata | `--write-info-json` (resolved format IDs, codecs, fps, duration, uploader, upload date, view, like and comment counts, tags, categories) | V | Provenance, quality checks, title context |
| **Chapters** | The `chapters` field in info.json (`start_time`, `end_time`, `title`) comes from the description timestamps or creator chapters. `--embed-chapters` also writes them into the MKV. | V | Topic segmentation prior; candidate clip boundaries |
| **"Most replayed" heatmap** | The `heatmap` field in info.json. Verified in `common.py`: a list of `{start_time, end_time, value}` where `value` is normalized 0–1. `_video.py::_extract_heatmap` parses `MARKER_TYPE_HEATMAP` markers, and tests show `'heatmap': 'count:100'`, i.e. **100 equal buckets**. It is only present when YouTube shows the graph, which needs enough views. No extra flag is needed beyond writing info.json. | V | **A strong virality signal**: audience rewatch peaks. Weight candidate segments by the heatmap (buckets are about 1–2.4 min each on 2–4 h videos, so it is coarse). |
| Subtitles (manual) | `--write-subs --sub-langs "en.*,-live_chat" --sub-format "json3/vtt/best"` | V (options) | Manual subs are near ground truth; use them to check or correct ASR words and proper nouns. |
| Auto-captions | `--write-auto-subs`. Prefer `en-orig` or the original language; the other auto-subs are machine translations. `json3` has per-word timing. | V (options); U (`en-orig` naming per video) | **A cheap ASR cross-check**: compare WER against our Whisper output to flag hallucinations or drift, and spot proper-noun errors. Do not use as the primary ASR: there is no punctuation or speakers, and timing is coarser. Note that the `web` client needs a subs PO token, and issue #17412 shows that subtitle fetches can fail, so treat subtitles as optional. |
| Comments | `--write-comments` plus `--extractor-args "youtube:comment_sort=top;max_comments=1000,all,50,5"` (order: max-comments, max-parents, max-replies, max-replies-per-thread, max-depth; the default is all) | V | Parse `\b(\d{1,2}:)?\d{1,2}:\d{2}\b` timestamps in top comments to get **timestamped moments people talked about**, and weight them by like count. Comments also inspire hooks and titles. Cap the count, because fetching all comments on popular videos takes minutes and adds request load. |
| Description | `--write-description` (also in info.json) | V | Guest names and spellings, sponsor segments, links. |
| Thumbnail | `--write-thumbnail --convert-thumbnails jpg` | V | Reference for brand and visual style. |
| SponsorBlock | `--sponsorblock-mark all` writes segments as chapters; or query the SponsorBlock API | V (the option exists in yt-dlp) | **Exclude sponsor reads and intros** from clip candidates. Do not use `--sponsorblock-remove`, because it re-cuts the master. |
| Live chat replay (livestreams) | Downloaded as the `live_chat` subtitle "language" | U | Chat-density spikes act as a heatmap substitute for streams. |
| VFR detection | After download: `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,avg_frame_rate,nb_frames -of json` (mismatch suggests VFR), plus the `vfrdet` filter: `ffmpeg -i src -vf vfrdet -an -f null -` (V: filter exists in the local build) | V (tools) | YouTube DASH output is usually CFR, but frame drops and mixed-fps uploads happen [U]. If VFR is detected, the proxy must be CFR-normalised (`-fps_mode cfr`), and every timestamp in the pipeline must be in **seconds, not frame numbers**. |

---

## 5. Alternatives and backups

| Tool | What it does | License | Activity [V, 2026-11] | Community | Reliability and weaknesses |
|---|---|---|---|---|---|
| **yt-dlp** | CLI/Python downloader for YouTube and 1000+ sites | Unlicense | push 2026-11-14, release 2026.10.26, about 1–2 releases/month | about 208k★, 2.8k open issues | **Best overall.** Fastest response to YouTube changes. Weak spots: SABR-only sessions (#12482, #17666), the PO-token arms race, and a dependency on Deno/EJS. |
| **pytubefix** (fork of pytube) | Python library for YouTube only | MIT | v11.2.1, 2026-10-16 | about 1.7k★, 19 open issues | Simpler Python API with its own PO-token/BotGuard support [U]. Smaller team, slower fixes, and fewer clients and format options. A reasonable second backend but not a replacement. |
| **cobalt** (imputnet) | Self-hostable web/API downloader | AGPL-3.0 | **last push 2026-04-06** (v11.7) | about 46k★, 292 open issues | Uses YouTube.js plus an optional session server (`YOUTUBE_SESSION_SERVER`, `WEB_EMBEDDED` client). Its env docs show `DISABLED_SERVICES=bilibili,youtube` as an example. The public instance has often disabled or limited YouTube [U]. Inactive for 7 months. ❌ Not for a quality pipeline: it caps at configured qualities and adds a server hop. |
| **Invidious** (+ invidious-companion) | Alternative YouTube front-end and API | AGPL-3.0 | push 2026-11-14 (companion 2026-11-07) | about 26k★ | Public instances are frequently blocked by YouTube. Self-hosting needs Docker plus a companion for PO tokens. Its API proxies streams and is fine for metadata. ❌ Not a download backend for us. |
| **Piped** | Privacy front-end (uses NewPipeExtractor) | AGPL-3.0 | push 2026-11-13 | about 10k★ | Same instance-blocking problem. ❌ |
| **NewPipeExtractor** | Java extraction library (NewPipe Android app) | GPL-3.0 | release v0.27.1, 2026-11-10 | about 2k★ | Active and good, but Java and Android-focused. Only worth it for a JVM stack. ❌ for us. |
| **YouTube.js** (LuanRT) | JS/TS InnerTube client | MIT [U] | push 2026-11-11 | about 5.4k★ | Used by cobalt, FreeTube and bgutil. A good library if a Node-native backend is ever wanted. |
| **gallery-dl** | Image/gallery downloader | GPL-2.0 | v1.32.20, 2026-11-14 | about 20k★ | For YouTube it **delegates to yt-dlp/youtube-dl** [U, per its docs]. Irrelevant here. |
| **Browser / "4K Video Downloader"-type GUI apps** | Commercial and freemium | Proprietary | — | — | Not open source. Out of scope. |

**Backup strategy:**
1. Stick with yt-dlp and update it before each batch; try `--update-to nightly` when a breakage is fresh.
2. Then try alternative `player_client` sets: `tv,web_safari` with cookies; `android_vr`; `web_embedded`.
3. Then add the bgutil POT provider, or cookies from a throwaway account.
4. As a last resort, use pytubefix as a programmatic backend.
5. **Above all, ingest from creator-supplied masters (§6).**

### 5.1 Legal / ToS (flag only, not legal advice)
- The **YouTube Terms of Service** prohibit downloading content except through features YouTube provides, or with the permission of YouTube and the rights holder. yt-dlp usage technically conflicts with the ToS whatever the copyright position. Enforcement is mostly technical (blocks and bans), but channel strikes or account termination are possible.
- **Copyright:** clips are derivative works. "Fair use" (US) or "fair dealing" (UK/CA) is a narrow, case-by-case defence. Clipping channels that repost substantial verbatim segments with captions are **not reliably protected**, and Content ID claims, revenue diversion or strikes are common.
- **Industry practice:** professional clipping channels and agencies work **with creator permission**, often under revenue-share or "clipper program" agreements in which creators explicitly invite clipping. Many podcasters also supply **raw multicam or ISO masters**, which are far better quality than YouTube downloads.
- **Recommendation:** keep a per-source `rights` record (permission yes/no, contact, terms, date) and make it a gate before publishing.

---

## 6. Ingest design

### 6.1 Supported inputs
1. **YouTube URL** downloaded with yt-dlp (§6.2).
2. **Local master files** (strongly recommended as the first-class path). These are creator-supplied 4K/6K camera ISOs, a program feed, separate audio (WAV/multitrack), and `.srt`/`.vtt` files.
   - **Why:** they avoid YouTube re-compression, so a 4K ProRes or H.264 master gives much better crops. They also give lossless or clean audio, carry no ToS risk, and per-camera ISOs make speaker-tracked reframing trivial, since you cut to the speaker's camera instead of cropping a wide shot.
   - **Handling:** run `ffprobe` to fill the same `source.json` schema. Optionally hash and link to the published YouTube URL to fetch its heatmap, chapters and comments, since that metadata is still valuable even with local video.
   - **Multicam alignment:** when several files are supplied, align them by audio cross-correlation (covered in another research area). Store the offsets in `source.json`.
3. Other sites (Twitch VODs, X, Rumble…) work via yt-dlp generically, but metadata such as the heatmap is YouTube-specific.

### 6.2 Recommended yt-dlp command lines (Windows, PowerShell)

**One-time config file** at `%APPDATA%\yt-dlp\config.txt`, or better, a project-local `--config-location`:
```
# --- quality ---
-f "bv*[height>=720]+ba[format_id!*=drc]/bv*+ba/b"
-S "res,fps,hdr:SDR,vcodec,acodec,channels,br"
--merge-output-format mkv
--embed-chapters
--embed-metadata
# --- metadata ---
--write-info-json
--write-description
--write-thumbnail
--convert-thumbnails jpg
--write-subs
--write-auto-subs
--sub-langs "en.*,en-orig,-live_chat"
--sub-format "json3/vtt/best"
--write-comments
--extractor-args "youtube:comment_sort=top;max_comments=1000,all,50,5"
--sponsorblock-mark all
# --- robustness ---
--retries infinite
--fragment-retries infinite
--retry-sleep "fragment:exp=1:30"
--extractor-retries 5
--concurrent-fragments 4
--continue
--no-overwrites
--download-archive "D:/VideoClipper/sources/archive.txt"
--sleep-requests 0.75
--sleep-subtitles 5
--min-sleep-interval 10
--max-sleep-interval 20
# --- layout ---
-P "D:/VideoClipper/sources"
-o "%(id)s/master.%(ext)s"
-o "infojson:%(id)s/info"
-o "subtitle:%(id)s/subs/subs"
-o "thumbnail:%(id)s/thumb"
-o "description:%(id)s/description"
--ffmpeg-location "C:/ffmpeg/bin"
```
Notes:
- `[height>=720]` stops a silent fallback to format 18. The final `/bv*+ba/b` still lets the download succeed, so the ingest checks in §6.4 must still reject a source whose height is below the maximum available.
- Each comma-separated item in `-o "TYPE:…"` is a separate type override [V: the README documents per-type `-o TYPE:TEMPLATE`]. Adjust the paths to match the storage drive. **About 101 GB is free on C:,** so an external or secondary drive is advisable.
- Do not add `--cookies-from-browser` by default. Use `--cookies cookies.txt` (exported from Firefox or a throwaway account) only when needed.

**Commands:**
```powershell
# 0) keep current (before each batch)
yt-dlp -U            # or: winget upgrade yt-dlp.yt-dlp

# 1) Inspect formats first (no download) – confirms 4K/1440p availability & what client served it
yt-dlp -F --config-location .\ytdlp.conf "https://www.youtube.com/watch?v=VIDEO_ID"

# 2) Dry-run selection: print exactly what would be fetched
yt-dlp --config-location .\ytdlp.conf -s --print "%(format_id)s | %(resolution)s | %(vcodec)s | %(acodec)s | %(fps)s | %(dynamic_range)s" "URL"

# 3) Metadata only (fast; heatmap/chapters/comments/subs, no media)
yt-dlp --config-location .\ytdlp.conf --skip-download "URL"

# 4) Full ingest
yt-dlp --config-location .\ytdlp.conf "URL"

# 5) Fallbacks when formats are missing / 403
yt-dlp --config-location .\ytdlp.conf --extractor-args "youtube:player_client=tv_samsung,web_safari,android_vr" "URL"
yt-dlp --config-location .\ytdlp.conf --cookies .\cookies.txt "URL"      # logged-in client set
# (then install bgutil-ytdlp-pot-provider if still failing)
```

### 6.3 Per-source folder layout
```
sources/<source_id>/            # source_id = YouTube id, or sha1[:12] of local master
  master.mkv                    # untouched original (YouTube) — or masters/ for local files
  masters/                      # (local ingest) cam_a.mov, cam_b.mov, audio.wav ... read-only
  info.json                     # yt-dlp info dict (incl. heatmap, chapters, formats, comments)
  description.txt
  thumb.jpg
  subs/subs.en-orig.json3, subs.en.vtt ...
  derived/
    proxy_540p.mp4              # CFR H.264, -g 30, analysis only
    audio_16k_mono.wav          # ASR input
    audio_48k.wav               # optional: decoded Opus->PCM for analysis/loudness
    heatmap.csv                 # start,end,value
    chapters.json
    comment_timestamps.json     # [{t, text, likes, comment_id}]
    sponsor_segments.json
  source.json                   # normalized manifest (below)
  ingest.log
```

### 6.4 `source.json` schema (normalized, the same for YouTube and local)
```json
{
  "source_id": "dQw4w9WgXcQ",
  "kind": "youtube | local",
  "url": "https://www.youtube.com/watch?v=...",
  "title": "...", "channel": "...", "channel_id": "...", "upload_date": "2026-11-01",
  "duration_s": 7342.5,
  "ingested_at": "2026-11-15T12:00:00Z",
  "tool_versions": {"yt_dlp": "2026.10.26", "ffmpeg": "...", "deno": "2.9.8"},
  "video": {"path": "master.mkv", "format_id": "401", "codec": "av01.0.12M.08", "width": 3840, "height": 2160,
            "fps": 29.97, "is_vfr": false, "dynamic_range": "SDR", "bitrate_kbps": 14500,
            "max_available_height": 2160, "quality_ok": true},
  "audio": {"format_id": "251", "codec": "opus", "sample_rate": 48000, "channels": 2, "language": "en", "is_drc": false},
  "cameras": [],                       
  "chapters": [{"start": 0, "end": 312.0, "title": "Intro"}],
  "heatmap": {"buckets": 100, "path": "derived/heatmap.csv"},
  "subtitles": {"manual": ["en"], "auto": ["en-orig"]},
  "comments": {"count_fetched": 1000, "timestamped": 87},
  "sponsor_segments": [{"start": 60, "end": 120, "category": "sponsor"}],
  "rights": {"permission": "unknown | granted | denied", "contact": "", "terms": "", "date": ""},
  "checksums": {"master.mkv": "sha256:..."}
}
```

### 6.5 Ingest checks (fail loudly, never silently degrade)
1. **Resolution check:** `video.height` must equal the maximum height listed in `info.json.formats` for video-only DASH formats. Otherwise mark `quality_ok=false`, retry with the fallback clients or cookies, and alert the user. This catches the SABR / format-18 trap.
2. **Integrity:**
   - The ffprobe duration must be within ±1 s of `info.duration`.
   - Run a full-decode check: `ffmpeg -v error -i master.mkv -f null -`. It is slow on 4K, so it can run in the background or on the proxy pass.
   - Both an audio stream and a video stream must be present.
3. **VFR:** use `vfrdet` or compare avg vs r frame rates, then record `is_vfr`.
4. **HDR:** if `dynamic_range != SDR`, flag the source so the render step applies tone-mapping (`zscale` + `tonemap`).
5. **Audio language:** with auto-dubbed multi-audio, assert that the selected audio is the original track. Compare its `language` against `info.language`, or check that `format_note` contains "original" [U for the exact field].
6. **Provenance:** record tool versions and the chosen `format_id`s so results are reproducible.

### 6.6 Derived artifacts (ffmpeg, after download)
```powershell
# analysis proxy (CFR, short GOP, fast seeking); keep same time base
ffmpeg -hide_banner -i master.mkv -map 0:v:0 -vf "scale=-2:540:flags=bicubic" -fps_mode cfr -c:v libx264 -preset veryfast -crf 23 -g 30 -an derived\proxy_540p.mp4
# ASR audio
ffmpeg -hide_banner -i master.mkv -map 0:a:0 -ac 1 -ar 16000 -c:a pcm_s16le derived\audio_16k_mono.wav
```
(If VFR was detected, add the source's nominal rate, e.g. `-r 30000/1001`, to the proxy so analysis timestamps stay consistent.)

---

## 7. Bottom line
- Use **yt-dlp 2026.10.26 + Deno (already installed)**, with format sort `res,fps,hdr:SDR,vcodec,acodec`, **MKV** output and Opus 251 audio without DRC. Collect all metadata (info.json with **heatmap** and **chapters**, subtitles, top comments, SponsorBlock).
- **4K/1440p is the biggest quality lever** for 9:16 crops. Enforce it with an ingest check that compares the downloaded height to the maximum available, because SABR rollouts can silently push yt-dlp onto 360p or HLS fallbacks.
- **Don't build a whole-file mezzanine:** about 100 GB free cannot hold ProRes or DNxHR of multi-hour 4K. Keep the original, analyse a 540p proxy, and decode clip segments from the master, optionally writing short all-intra segment intermediates.
- Keep bgutil POT provider, cookies and alternative clients as escalation steps, not defaults.
- **Make local-master ingest first-class.** It gives the best quality, carries no ToS risk, and matches how real clipping channels work, with creator permission.
