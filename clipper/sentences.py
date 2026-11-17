"""Stage 2a - sentences + signals (offline, no API): the units clip selection works in.

Usage:
  python clipper/sentences.py --id JOB

Reads  words.json, audio16k.wav, heatmap.json
Writes sentences.json  [{i, start, end, speaker, text, w0, w1, pause_before, pause_after, heat, loud_z}]

Clips always start and end on these sentence boundaries; selection works with sentence indices (the model copies
indices and never does time arithmetic - lesson from artbyjazi/autoclip). Also home of the silence-trough cut snap
used for the final cut points.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import job_dir, read_json, stage_banner, write_json  # noqa: E402

SENT_END = re.compile(r"[.?!][\"')\]]*$")
BREAK_GAP_S = 1.5        # a silence this long ends a sentence even without punctuation
MAX_WORDS = 60           # split run-ons at their largest internal gap
LEAD_MAX_S, TAIL_MAX_S = 0.40, 0.60   # how far into a pause a cut may move
LEAD_MIN_S, TAIL_MIN_S = 0.03, 0.08   # never cut closer than this to speech


def frame_db(wav: Path) -> np.ndarray:
    """10 ms RMS frames in dB."""
    import soundfile as sf
    x, sr = sf.read(str(wav), dtype="float32")
    hop = sr // 100
    n = len(x) // hop
    rms = np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms)


def _split_runon(ws: list[dict]) -> list[list[dict]]:
    if len(ws) <= MAX_WORDS:
        return [ws]
    k = max(range(MAX_WORDS // 3, len(ws) - MAX_WORDS // 3), key=lambda j: ws[j]["start"] - ws[j - 1]["end"])
    return _split_runon(ws[:k]) + _split_runon(ws[k:])


def build(words: list[dict]) -> list[list[dict]]:
    groups, cur = [], []
    for i, w in enumerate(words):
        if cur:
            gap = w["start"] - cur[-1]["end"]
            spk_change = w.get("speaker") and cur[-1].get("speaker") and w["speaker"] != cur[-1]["speaker"]
            if gap >= BREAK_GAP_S or spk_change:
                groups.append(cur)
                cur = []
        cur.append(dict(w, idx=i))
        if SENT_END.search(w["w"]):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return [g for grp in groups for g in _split_runon(grp)]


def heat_at(heat: list[dict], t0: float, t1: float) -> float | None:
    if not heat:
        return None
    vals = [h["value"] for h in heat if h["end"] > t0 and h["start"] < t1]
    return round(max(vals), 3) if vals else None


def snap_cut(sents: list[dict], i0: int, i1: int, db: np.ndarray,
             start: float | None = None, prev_end: float | None = None) -> tuple[float, float]:
    """Cut-in/out for a clip spanning sentences i0..i1: the quietest 10 ms frame inside the neighbouring pause,
    never closer than LEAD_MIN/TAIL_MIN to speech. Word times are only a guide; the energy decides.
    start/prev_end override the clip start when it begins a few words into sentence i0 (false start trimmed)."""
    s, e = (start if start is not None else sents[i0]["start"]), sents[i1]["end"]
    if prev_end is None:
        prev_end = sents[i0 - 1]["end"] if i0 > 0 else 0.0
    next_start = sents[i1 + 1]["start"] if i1 + 1 < len(sents) else len(db) / 100

    def quietest(a: float, b: float, fallback: float) -> float:
        fa, fb = int(a * 100), int(b * 100)
        if fb - fa < 1:
            return fallback
        return (fa + int(np.argmin(db[fa:fb]))) / 100 + 0.005

    cut_in = quietest(max(prev_end, s - LEAD_MAX_S), s - LEAD_MIN_S, fallback=max(prev_end, s - LEAD_MIN_S))
    cut_out = quietest(e + TAIL_MIN_S, min(next_start, e + TAIL_MAX_S), fallback=min(next_start, e + TAIL_MIN_S))
    return round(max(cut_in, 0.0), 3), round(cut_out, 3)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--relabel-only", action="store_true",
                    help="only update speaker labels from words.json (keeps sentence numbering for existing clips)")
    args = ap.parse_args()
    stage_banner("sentences", args.id)
    d = job_dir(args.id)
    words = read_json(d / "words.json")["words"]
    if args.relabel_only:
        relabel(d, words)
        return
    heat = read_json(d / "heatmap.json") if (d / "heatmap.json").exists() else []
    db = frame_db(d / "audio16k.wav")
    speech = db[db > np.percentile(db, 30)]
    mu, sd = float(speech.mean()), float(speech.std() or 1.0)

    groups = build(words)
    out = []
    for i, g in enumerate(groups):
        s, e = g[0]["start"], g[-1]["end"]
        spk = [w.get("speaker") for w in g if w.get("speaker")]
        seg = db[int(s * 100): max(int(e * 100), int(s * 100) + 1)]
        out.append({"i": i, "start": s, "end": e,
                    "speaker": max(set(spk), key=spk.count) if spk else None,
                    "text": " ".join(w["w"] for w in g).strip(), "w0": g[0]["idx"], "w1": g[-1]["idx"] + 1,
                    "heat": heat_at(heat, s, e), "loud_z": round((float(seg.mean()) - mu) / sd, 2)})
    for a, b in zip(out, out[1:]):
        a["pause_after"] = b["pause_before"] = round(b["start"] - a["end"], 3)
    if out:
        out[0]["pause_before"] = round(out[0]["start"], 3)
        out[-1]["pause_after"] = round(len(db) / 100 - out[-1]["end"], 3)
    write_json(d / "sentences.json", out)
    print(f"{len(out)} sentences from {len(words)} words "
          f"(median {np.median([o['end'] - o['start'] for o in out]):.1f}s); heatmap={'yes' if heat else 'no'}")


def relabel(d, words: list[dict]) -> None:
    """Set each existing sentence's speaker from words.json without re-splitting. Used after diarization is added
    to a job that already has clips: candidates.json refers to sentences by index, so the split must not change."""
    sents = read_json(d / "sentences.json")
    for s in sents:
        spk = [w.get("speaker") for w in words[s["w0"]:s["w1"]] if w.get("speaker")]
        s["speaker"] = max(set(spk), key=spk.count) if spk else None
    write_json(d / "sentences.json", sents)
    named = sorted({s["speaker"] for s in sents if s["speaker"]})
    print(f"relabelled {len(sents)} sentences (split unchanged); speakers: {', '.join(named) or 'none'}")


if __name__ == "__main__":
    main()
