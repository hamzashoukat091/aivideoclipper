"""Stage 4 - final render: ONE encode from the source master per clip (CLAUDE.md conventions).

Usage:
  python clipper/render.py --id JOB [--clip c02 ...] [--fast] [--no-hook]

Reads  source.*, probe.json, words.json, candidates.json, reframe/<clip>.json, edits/<clip>.json (optional user
       edits: word fixes, hook text/seconds/on-off, caption on-off/position/size; see clipper/edits.py)
Writes captions/<clip>.ass         captions (inspectable; open in Aegisub). Deliberately NOT in renders/: video
                                   players auto-load a same-named .ass and draw it twice over the burned-in text
       renders/<clip>.mp4          1080x1920, source fps CFR, H.264 High CRF 16 slow, BT.709, AAC 320k 48 kHz,
                                   -14 LUFS / -2 dBTP (two-pass loudnorm), faststart
       renders/<clip>.report.json  measured output: resolution, fps, frames, duration, loudness, true peak

Pipeline per clip: ffmpeg decodes the source range to raw BGR (explicit BT.709) -> Python composes each 1080x1920
frame from the reframe plan (TRACK crop / GROUP crop / SPLIT stack / FIT on blur; Lanczos up, area down) -> raw
frames piped into a single ffmpeg encode that burns the ASS captions (libass, bundled fonts) and normalises audio.
Clips marked approved=false in candidates.json are skipped.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from captions import build_ass  # noqa: E402
from common import ROOT, job_dir, read_json, run, stage_banner, write_json  # noqa: E402
from edits import caption_spec, clip_words, hook_spec, load_edits  # noqa: E402
from reframe import OUT_H, OUT_W, frames, frames_with_holds  # noqa: E402

FONTS = ROOT / "assets" / "fonts"
LOUD_I, LOUD_TP, LOUD_LRA = -14.0, -2.0, 11.0
FADE_IN_S, FADE_OUT_S = 0.025, 0.08


def rel(p: Path) -> str:
    """Path for ffmpeg filter args: relative to ROOT, forward slashes, so no drive-letter colon to escape."""
    return p.resolve().relative_to(ROOT).as_posix()


def measure_loudness(media: Path, t0: float, dur: float) -> dict:
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{t0:.3f}", "-i", str(media), "-t", f"{dur:.3f}",
                        "-vn", "-af", f"loudnorm=I={LOUD_I}:TP={LOUD_TP}:LRA={LOUD_LRA}:print_format=json",
                        "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr, re.S)
    if not m:
        raise RuntimeError("loudnorm pass 1 produced no measurement")
    return json.loads(m.group(0))


def compose(img: np.ndarray, shot: dict, j: int, upscale_interp) -> np.ndarray:
    import cv2

    def fit(region: np.ndarray, w: int, h: int) -> np.ndarray:
        interp = upscale_interp if region.shape[1] < w else cv2.INTER_AREA
        return cv2.resize(region, (w, h), interpolation=interp)

    L = shot["layout"]
    if L == "TRACK":
        x = shot["x"][min(j, len(shot["x"]) - 1)]
        return fit(img[:, x:x + shot["w"]], OUT_W, OUT_H)
    if L == "GROUP":
        c = shot["crop"]
        return fit(img[c["y"]:c["y"] + c["h"], c["x"]:c["x"] + c["w"]], OUT_W, OUT_H)
    if L == "SPLIT":
        return np.vstack([fit(img[c["y"]:c["y"] + c["h"], c["x"]:c["x"] + c["w"]], OUT_W, OUT_H // 2)
                          for c in (shot["top"], shot["bottom"])])
    H, W = img.shape[:2]                                        # FIT: full frame on a blurred, darkened cover
    small = cv2.resize(img, (OUT_W // 8, int(H * (OUT_W // 8) / W) or 1), interpolation=cv2.INTER_AREA)
    cover_h = OUT_H // 8
    cover_w = int(small.shape[1] * cover_h / small.shape[0])
    cov = cv2.resize(small, (cover_w, cover_h), interpolation=cv2.INTER_AREA)
    off = (cover_w - OUT_W // 8) // 2
    cov = cv2.GaussianBlur(cov[:, off:off + OUT_W // 8], (0, 0), 3)
    bg = (cv2.resize(cov, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR) * 0.45).astype(np.uint8)
    fg = fit(img, OUT_W, int(round(H * OUT_W / W / 2)) * 2)
    y0 = (OUT_H - fg.shape[0]) // 2
    bg[y0:y0 + fg.shape[0]] = fg
    return bg


def probe_out(path: Path) -> dict:
    j = json.loads(run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json",
                        str(path)], capture=True))
    v = next(s for s in j["streams"] if s["codec_type"] == "video")
    a = next(s for s in j["streams"] if s["codec_type"] == "audio")
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", "ebur128=peak=true",
                        "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    summ = p.stderr[p.stderr.rfind("Summary:"):]
    li = re.search(r"I:\s+(-?[\d.]+) LUFS", summ)
    tp = re.search(r"Peak:\s+(-?[\d.]+) dBFS", summ)
    return {"width": v["width"], "height": v["height"], "fps": v["r_frame_rate"], "avg_fps": v["avg_frame_rate"],
            "frames": int(v.get("nb_read_frames", 0)), "pix_fmt": v["pix_fmt"], "color_space": v.get("color_space"),
            "profile": v.get("profile"), "duration": float(j["format"]["duration"]),
            "video_kbps": round(int(v.get("bit_rate", 0)) / 1000), "audio": f"{a['codec_name']} {a['sample_rate']} Hz",
            "loudness_lufs": float(li.group(1)) if li else None, "true_peak_dbfs": float(tp.group(1)) if tp else None}


def render_clip(d: Path, cand: dict, plan: dict, pr: dict, media: Path, words: list, fast: bool, hook: bool) -> dict:
    import cv2
    t0 = time.perf_counter()
    rd = d / "renders"
    rd.mkdir(exist_ok=True)
    cid, cut_in, dur, fps = plan["clip"], plan["cut_in"], plan["duration"], plan["fps"]
    fpsf = float(Fraction(fps))
    W, H = plan["src_w"], plan["src_h"]

    by_frame = []
    for s in plan["shots"]:
        by_frame += [s] * (s["f1"] - s["f0"])

    def layout_at(t: float) -> str:
        return by_frame[min(max(int(t * fpsf), 0), len(by_frame) - 1)]["layout"]

    edits = load_edits(d / "edits" / f"{cid}.json", cand)
    rel_words = clip_words(words, cut_in, cut_in + dur, (edits or {}).get("words"))
    hook_text, hook_s = hook_spec(edits, cand, enabled=hook)
    cap = caption_spec(edits)
    # NOT next to the mp4: VLC/MPC auto-load a same-named .ass and draw it over the burned-in captions, which looks
    # like a ghost behind the text (user report 2026-11-17). Keep caption sources in their own folder.
    cap_dir = d / "captions"
    cap_dir.mkdir(exist_ok=True)
    ass = cap_dir / f"{cid}.ass"
    ass.write_text(build_ass(rel_words, dur, layout_at, hook_text, hook_s=hook_s, captions=cap["enabled"],
                             position=cap["position"], size=cap["size"]), encoding="utf-8")

    ln = measure_loudness(media, cut_in, dur)
    af = (f"loudnorm=I={LOUD_I}:TP={LOUD_TP}:LRA={LOUD_LRA}:measured_I={ln['input_i']}:"
          f"measured_TP={ln['input_tp']}:measured_LRA={ln['input_lra']}:measured_thresh={ln['input_thresh']}:"
          f"offset={ln['target_offset']}:linear=true,aresample=48000,"
          f"afade=t=in:d={FADE_IN_S},afade=t=out:st={max(dur - FADE_OUT_S, 0):.3f}:d={FADE_OUT_S}")
    sharpen = "unsharp=5:5:0.35:5:5:0," if H < 1600 else ""      # light sharpening only when upscaling 1080p
    vf = (f"[0:v]{sharpen}ass={rel(ass)}:fontsdir={rel(FONTS)},"
          f"scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v];[1:a]{af}[a]")
    gop = max(1, round(fpsf / 2))
    out = rd / f"{cid}.mp4"
    enc = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{OUT_W}x{OUT_H}", "-r", fps, "-i", "-",
           "-ss", f"{cut_in:.3f}", "-t", f"{dur:.3f}", "-i", str(media),
           "-filter_complex", vf, "-map", "[v]", "-map", "[a]",
           "-c:v", "libx264", "-preset", "medium" if fast else "slow", "-crf", "17" if fast else "16",
           "-tune", "film", "-profile:v", "high", "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
           "-bf", "2", "-x264-params", "open-gop=0", "-maxrate", "25M", "-bufsize", "50M",
           "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
           "-r", fps, "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-movflags", "+faststart", "-shortest", str(out)]
    p = subprocess.Popen(enc, stdin=subprocess.PIPE, cwd=str(ROOT))
    interp = cv2.INTER_LANCZOS4
    n = 0
    try:
        for i, img in frames_with_holds(frames(media, cut_in, dur, fps, W, H, matrix="bt709"), plan["shots"]):
            s = by_frame[min(i, len(by_frame) - 1)]
            p.stdin.write(np.ascontiguousarray(compose(img, s, i - s["f0"], interp)).tobytes())
            n += 1
    finally:
        p.stdin.close()
        rc = p.wait()
    if rc != 0:
        raise RuntimeError(f"encoder failed (exit {rc})")

    rep = {"clip": cid, "title": cand.get("title"), "source_range": [cut_in, round(cut_in + dur, 3)],
           "frames_piped": n, "frames_planned": plan["frames"], "render_seconds": round(time.perf_counter() - t0, 1),
           "loudness_in": {"I": ln["input_i"], "TP": ln["input_tp"], "LRA": ln["input_lra"]},
           "output": probe_out(out)}
    o = rep["output"]
    checks = {"1080x1920": (o["width"], o["height"]) == (OUT_W, OUT_H),
              "fps_matches_source": o["fps"] == fps or abs(float(Fraction(o["fps"])) - fpsf) < 0.01,
              "frames_complete": abs(o["frames"] - plan["frames"]) <= 1,
              "loudness_-14_pm1": o["loudness_lufs"] is not None and abs(o["loudness_lufs"] - LOUD_I) <= 1.0,
              "true_peak_<=-1": o["true_peak_dbfs"] is not None and o["true_peak_dbfs"] <= -1.0}
    rep["checks"] = checks
    write_json(rd / f"{cid}.report.json", rep)
    bad = [k for k, v in checks.items() if not v]
    print(f"  {cid}: {o['width']}x{o['height']} @ {o['fps']}, {o['duration']:.1f}s, {o['video_kbps']} kbps, "
          f"{o['loudness_lufs']} LUFS / peak {o['true_peak_dbfs']} dBFS, {rep['render_seconds']:.0f}s"
          + (f"  FAILED: {bad}" if bad else "  all checks OK"), flush=True)
    return rep


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--clip", nargs="*")
    ap.add_argument("--fast", action="store_true", help="x264 medium CRF 17 for quick iteration")
    ap.add_argument("--no-hook", action="store_true", help="omit the on-screen hook text")
    args = ap.parse_args()
    stage_banner("render", args.id)
    d = job_dir(args.id)
    pr = read_json(d / "probe.json")
    media = Path(read_json(d / "meta.json")["media"])
    words = read_json(d / "words.json")["words"]
    cands = {c["id"]: c for c in read_json(d / "candidates.json")} if (d / "candidates.json").exists() else {}
    plans = sorted((d / "reframe").glob("*.json"))
    for pf in plans:
        plan = read_json(pf)
        cid = plan["clip"]
        if args.clip and cid not in args.clip:
            continue
        cand = cands.get(cid, {})
        if cand.get("approved") is False:
            print(f"  {cid}: skipped (approved=false)")
            continue
        render_clip(d, cand, plan, pr, media, words, args.fast, not args.no_hook)


if __name__ == "__main__":
    main()
