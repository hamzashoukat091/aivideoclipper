"""Stage 1b - transcribe: WhisperX large-v3 (int8, CPU) + wav2vec2 forced alignment -> word timestamps.

Usage:
  python clipper/transcribe.py --id JOB [--language en|auto] [--model large-v3] [--batch-size 8]

Reads  data/jobs/<JOB>/audio16k.wav
Writes data/jobs/<JOB>/transcript.json:
  {model, language, audio_seconds, runtime_seconds, rtf,
   segments: [{start, end, text, w0, w1}],          # w0..w1 = word index range (inclusive start, exclusive end)
   words:    [{w, start, end, score, timed}]}       # timed=false: alignment gave no time, interpolated

Chosen in the ASR bake-off (CLAUDE.md): lowest WER on all 3 test episodes. Word times are NOT cut points - the
render stage snaps cuts to measured silence.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import job_dir, stage_banner, write_json  # noqa: E402


def interpolate(words: list[dict]) -> list[dict]:
    """Alignment leaves numbers/symbols untimed; spread them between their timed neighbours."""
    out = []
    i = 0
    while i < len(words):
        w = words[i]
        if w.get("start") is not None and w.get("end") is not None:
            out.append({"w": w["word"], "start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3),
                        "score": round(float(w.get("score") or 0), 3), "timed": True})
            i += 1
            continue
        j = i
        while j < len(words) and (words[j].get("start") is None or words[j].get("end") is None):
            j += 1
        lo = out[-1]["end"] if out else 0.0
        hi = float(words[j]["start"]) if j < len(words) else lo + 0.3 * (j - i)
        step = max(hi - lo, 0.0) / (j - i)
        for k in range(i, j):
            s = lo + step * (k - i)
            out.append({"w": words[k]["word"], "start": round(s, 3), "end": round(s + step, 3),
                        "score": 0.0, "timed": False})
        i = j
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--language", default="en", help="ISO code, or 'auto' to detect (CLAUDE.md assumes English)")
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--compute", default="int8")
    ap.add_argument("--batch-size", type=int, default=8)
    args = ap.parse_args()

    t0 = stage_banner("transcribe", args.id)
    d = job_dir(args.id)
    wav = d / "audio16k.wav"
    if not wav.exists():
        sys.exit(f"run ingest first: {wav} missing")

    import torch
    import whisperx
    torch.set_num_threads(os.cpu_count() or 4)
    audio = whisperx.load_audio(str(wav))
    secs = len(audio) / 16000
    lang = None if args.language == "auto" else args.language
    print(f"{secs / 60:.1f} min of audio; expect ~{secs * 1.6 / 60:.0f} min on this CPU (bake-off RTF ~1.6)", flush=True)

    model = whisperx.load_model(args.model, "cpu", compute_type=args.compute, language=lang)
    result = model.transcribe(audio, batch_size=args.batch_size, language=lang, print_progress=True)
    lang = result.get("language") or lang
    del model
    print(f"ASR done ({time.perf_counter() - t0:.0f}s); aligning words ({lang})", flush=True)

    align_model, align_meta = whisperx.load_align_model(language_code=lang, device="cpu")
    aligned = whisperx.align(result["segments"], align_model, align_meta, audio, "cpu",
                             return_char_alignments=False)

    words, segments = [], []
    for seg in aligned["segments"]:
        ws = interpolate(seg.get("words") or [])
        if not ws:
            continue
        segments.append({"start": ws[0]["start"], "end": ws[-1]["end"], "text": seg["text"].strip(),
                         "w0": len(words), "w1": len(words) + len(ws)})
        words.extend(ws)
    # enforce monotonic, non-overlapping times across segment joins
    for a, b in zip(words, words[1:]):
        if b["start"] < a["start"]:
            b["start"] = a["start"]
        if a["end"] > b["start"]:
            a["end"] = b["start"]
        if b["end"] < b["start"]:
            b["end"] = b["start"]

    elapsed = time.perf_counter() - t0
    out = write_json(d / "transcript.json", {
        "model": f"whisperx/{args.model}/{args.compute}", "language": lang,
        "audio_seconds": round(secs, 2), "runtime_seconds": round(elapsed, 1), "rtf": round(elapsed / secs, 3),
        "untimed_words": sum(not w["timed"] for w in words),
        "segments": segments, "words": words})
    print(f"{len(words)} words, {len(segments)} segments, RTF {elapsed / secs:.2f} -> {out}")


if __name__ == "__main__":
    main()
