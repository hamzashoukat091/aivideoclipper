"""Stage 1a - ingest: get the best-quality master, verify it, and extract analysis audio.

Usage:
  python clipper/ingest.py <youtube-url | local-media-file> --id JOB [--max-height 2160] [--allow-lower]

Writes data/jobs/<JOB>/:
  source.<ext>     master video+audio as delivered by YouTube (never re-encoded here). Local files are referenced,
                   not copied.
  info.json        yt-dlp metadata (title, chapters, heatmap, formats) - URL sources only
  heatmap.json     YouTube "Most replayed" curve [{start,end,value}] or [] if YouTube has none
  chapters.json    creator chapters [{start,end,title}] or []
  probe.json       ffprobe facts about the master (resolution, fps, VFR flag, codecs, loudness-relevant audio info)
  audio16k.wav     16 kHz mono PCM of the whole master, used by transcription and diarization only
  meta.json        source, paths, quality check result

Quality check: YouTube (SABR / missing PO token) can silently serve a lower resolution than it lists. We compare the
downloaded height with the best height listed in info.json and fail unless --allow-lower.
"""
from __future__ import annotations

import argparse
import re
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import job_dir, read_json, run, stage_banner, tls_env, write_json  # noqa: E402

MEDIA_EXT = {".mkv", ".mp4", ".webm", ".mov", ".m4v"}


def download(url: str, d: Path, max_height: int) -> Path:
    for old in d.glob("source.*"):
        old.unlink()
    # Sort: highest resolution (capped), then highest fps, prefer SDR (HDR needs tone-mapping for phones), then bitrate.
    run(["yt-dlp", "--compat-options", "no-certifi", "--no-playlist", "--retries", "10", "--fragment-retries", "10",
         "--no-progress", "-f", "bv*+ba/b", "-S", f"res:{max_height},fps,hdr:sdr,br",
         "--merge-output-format", "mkv", "-o", str(d / "source.%(ext)s"), "--write-info-json", url],
        env=tls_env(), attempts=3)
    media = [p for p in d.glob("source.*") if p.suffix.lower() in MEDIA_EXT]
    if not media:
        sys.exit("download finished but no media file found")
    info = next(d.glob("source.info.json"), None)
    if info:
        info.replace(d / "info.json")
    return media[0]


STANDARD_FPS = [Fraction(24000, 1001), Fraction(24), Fraction(25), Fraction(30000, 1001), Fraction(30),
                Fraction(50), Fraction(60000, 1001), Fraction(60)]


def snap_fps(r: Fraction) -> Fraction:
    """MKV's 1 ms timebase turns 30000/1001 into e.g. 16814/561; snap to the standard rate within 0.2%."""
    best = min(STANDARD_FPS, key=lambda s: abs(float(s) - float(r)))
    return best if abs(float(best) - float(r)) / float(best) < 0.002 else r


def probe(media: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(media)], capture=True)
    import json
    j = json.loads(out)
    v = next((s for s in j["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in j["streams"] if s["codec_type"] == "audio"), None)
    if v is None or a is None:
        sys.exit(f"master needs both video and audio; got video={v is not None} audio={a is not None}")
    r = Fraction(v["r_frame_rate"])
    avg = Fraction(v.get("avg_frame_rate") or v["r_frame_rate"]) if v.get("avg_frame_rate") not in (None, "0/0") else r
    rot = 0
    for sd in v.get("side_data_list", []):
        rot = int(sd.get("rotation", 0)) or rot
    render = snap_fps(r)
    return {
        "width": v["width"], "height": v["height"], "rotation": rot,
        "fps": float(r), "fps_exact": f"{r.numerator}/{r.denominator}",
        "fps_render": f"{render.numerator}/{render.denominator}",   # clean CFR rate the render stage must output
        "avg_fps": float(avg), "likely_vfr": abs(float(r) - float(avg)) > 0.05,
        "vcodec": v["codec_name"], "pix_fmt": v.get("pix_fmt"),
        "color_transfer": v.get("color_transfer"), "hdr": v.get("color_transfer") in ("smpte2084", "arib-std-b67"),
        "acodec": a["codec_name"], "sample_rate": int(a["sample_rate"]), "channels": a.get("channels"),
        "duration": float(j["format"]["duration"]), "bit_rate": int(j["format"].get("bit_rate", 0)),
    }


def best_listed_height(info: dict, max_height: int) -> int | None:
    hs = [f.get("height") for f in info.get("formats", []) if f.get("vcodec") not in (None, "none") and f.get("height")]
    hs = [h for h in hs if h <= max_height]
    return max(hs) if hs else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--id", required=True)
    ap.add_argument("--max-height", type=int, default=2160, help="cap; 2160 keeps headroom for 9:16 crops")
    ap.add_argument("--allow-lower", action="store_true", help="accept a download below the best listed height")
    args = ap.parse_args()

    t0 = stage_banner("ingest", args.id)
    d = job_dir(args.id)
    is_url = re.match(r"https?://", args.source) is not None
    if is_url:
        media = download(args.source, d, args.max_height)
    else:
        media = Path(args.source).resolve()
        if not media.exists():
            sys.exit(f"not found: {media}")

    pr = probe(media)
    write_json(d / "probe.json", pr)

    info = read_json(d / "info.json") if is_url and (d / "info.json").exists() else {}
    heat = [{"start": h["start_time"], "end": h["end_time"], "value": h["value"]} for h in info.get("heatmap") or []]
    chapters = [{"start": c["start_time"], "end": c["end_time"], "title": c["title"]} for c in info.get("chapters") or []]
    write_json(d / "heatmap.json", heat)
    write_json(d / "chapters.json", chapters)

    expected = best_listed_height(info, args.max_height) if info else None
    got = min(pr["width"], pr["height"]) if pr["rotation"] in (90, -90, 270) else pr["height"]
    height_ok = expected is None or got >= expected
    warnings = []
    if not height_ok:
        warnings.append(f"downloaded {got}p but YouTube lists {expected}p - likely SABR/PO-token downgrade")
    if got < 1080:
        warnings.append(f"master is only {got}p: 9:16 crops will be upscaled (visible softness)")
    if pr["likely_vfr"]:
        warnings.append(f"variable frame rate (r={pr['fps']:.3f}, avg={pr['avg_fps']:.3f}); render will force CFR")
    if pr["hdr"]:
        warnings.append("HDR master: render must tone-map to SDR")

    wav = d / "audio16k.wav"
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(media),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)])

    meta = {"source": args.source, "media": str(media), "title": info.get("title") or media.stem,
            "channel": info.get("channel"), "duration": pr["duration"],
            "expected_height": expected, "height": got, "height_ok": height_ok,
            "has_heatmap": bool(heat), "chapters": len(chapters), "warnings": warnings}
    write_json(d / "meta.json", meta)

    import time
    print(f"{meta['title']}: {got}p @ {pr['fps']:.3f} fps, {pr['duration'] / 60:.1f} min, "
          f"heatmap={'yes' if heat else 'no'}, chapters={len(chapters)} ({time.perf_counter() - t0:.0f}s)")
    for w in warnings:
        print("WARNING:", w)
    if not height_ok and not args.allow_lower:
        sys.exit("refusing a downgraded master; retry later, or pass --allow-lower to accept it")


if __name__ == "__main__":
    main()
