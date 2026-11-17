"""Score every ASR output for one or more episodes and write a markdown report.

Usage:
  python bakeoff/score.py --ids ep1 ep2 ep3 [--listen 12]

Metrics (per episode, per system):
  WER vs human reference     only inside the window covered by reference cues; same normalizer for all systems
  speed                      runtime / audio duration (RTF) on this machine; cost from common.PRICE_PER_HOUR
  timing agreement           pairwise median / p90 |delta| of word start and end times on matched words
  boundary risk (heuristic)  share of sentence ends (starts) next to a real pause where the 50 ms just outside the
                             timestamp is >12 dB above that pause's own floor - i.e. a cut there would clip speech
  listening pack             the same sentences cut exactly at each system's timestamps, blind-labelled, for ears

Writes data/bakeoff/report.md and data/bakeoff/<id>/listen/.
"""
from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
from difflib import SequenceMatcher
from itertools import combinations
from pathlib import Path

import jiwer
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, PRICE_PER_HOUR, Word, episode_dir, load_asr, norm_tokens, sentences  # noqa: E402

PAUSE_S = 0.20      # gap that counts as a real pause between sentences
PROBE_S = 0.05      # how far past an end (before a start) we probe for energy
SPEECH_OVER_FLOOR_DB = 12.0  # probe this much louder than the pause's own floor = speech still going
FILLERS = {"uh", "um", "er", "ah", "eh", "hmm", "mm", "mhm", "uhm", "erm"}


def key_of(w: Word) -> str:
    return "".join(norm_tokens(w.w))


def wer_for(words: list[Word], cues: list[dict]) -> dict | None:
    if not cues:
        return None
    timed = cues[0]["start"] is not None
    if timed:
        lo, hi = cues[0]["start"], cues[-1]["end"]
        words = [w for w in words if lo <= (w.start + w.end) / 2 <= hi]
    ref_t = norm_tokens(" ".join(c["text"] for c in cues))
    hyp_t = norm_tokens(" ".join(w.w for w in words))
    o = jiwer.process_words(" ".join(ref_t), " ".join(hyp_t))
    # Fillers: human captions usually drop them and our captions will too, so this is the primary number.
    o2 = jiwer.process_words(" ".join(t for t in ref_t if t not in FILLERS),
                             " ".join(t for t in hyp_t if t not in FILLERS))
    return {"wer": o.wer, "wer_nf": o2.wer, "sub": o2.substitutions, "del": o2.deletions, "ins": o2.insertions,
            "ref_words": len(ref_t)}


def match(a: list[Word], b: list[Word]) -> list[tuple[int, int]]:
    sm = SequenceMatcher(None, [key_of(w) for w in a], [key_of(w) for w in b], autojunk=False)
    return [(blk.a + k, blk.b + k) for blk in sm.get_matching_blocks() for k in range(blk.size)]


def frame_db(wav: Path) -> tuple[np.ndarray, float, int]:
    x, sr = sf.read(str(wav), dtype="float32")
    hop = sr // 100
    n = len(x) // hop
    rms = np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    return db, float(np.percentile(db, 95)), sr


def boundary_risk(words: list[Word], db: np.ndarray, ref_db: float) -> dict:
    """A boundary is risky if the 50 ms just outside it is much louder than the quietest part of the same pause,
    i.e. speech continues past the timestamp. Relative to each pause's own floor, so room tone/reverb don't count."""

    def mean_db(t0: float, t1: float) -> float | None:
        a, b = max(int(t0 * 100), 0), min(int(t1 * 100), len(db))
        return float(db[a:b].mean()) if b > a else None

    def risky(probe: tuple[float, float], gap: tuple[float, float]) -> bool:
        a, b = max(int(gap[0] * 100), 0), min(int(gap[1] * 100), len(db))
        p = mean_db(*probe)
        if p is None or b - a < 3:
            return False
        floor = float(np.percentile(db[a:b], 20))
        return p - floor > SPEECH_OVER_FLOOR_DB

    sents = sentences(words)
    tail_n = tail_bad = head_n = head_bad = 0
    for i, s in enumerate(sents):
        if i + 1 < len(sents) and sents[i + 1][0].start - s[-1].end >= PAUSE_S:
            tail_n += 1
            tail_bad += risky((s[-1].end, s[-1].end + PROBE_S), (s[-1].end, sents[i + 1][0].start))
        if i > 0 and s[0].start - sents[i - 1][-1].end >= PAUSE_S:
            head_n += 1
            head_bad += risky((s[0].start - PROBE_S, s[0].start), (sents[i - 1][-1].end, s[0].start))
    return {"sentences": len(sents),
            "tail_risk": tail_bad / tail_n if tail_n else None, "tail_n": tail_n,
            "head_risk": head_bad / head_n if head_n else None, "head_n": head_n}


def listening_pack(ep: Path, systems: dict[str, dict], n: int, sr: int) -> int:
    names = sorted(systems)
    base = names[0]
    maps = {s: dict(match(systems[base]["words"], systems[s]["words"])) for s in names[1:]}
    cands = [s for s in sentences(systems[base]["words"]) if len(s) >= 4]
    rng = random.Random(0)
    rng.shuffle(cands)
    x, _ = sf.read(str(ep / "audio16k.wav"), dtype="float32")
    out = ep / "listen"
    out.mkdir(exist_ok=True)
    for old in out.glob("*.wav"):
        old.unlink()
    key, made = {}, 0
    bw = systems[base]["words"]
    for sent in cands:
        if made >= n:
            break
        i0, i1 = bw.index(sent[0]), bw.index(sent[-1])
        spans = {base: (sent[0].start, sent[-1].end)}
        ok = True
        for s in names[1:]:
            j0, j1 = maps[s].get(i0), maps[s].get(i1)
            if j0 is None or j1 is None:
                ok = False
                break
            ws = systems[s]["words"]
            spans[s] = (ws[j0].start, ws[j1].end)
        if not ok:
            continue
        made += 1
        letters = list("ABCDEFG"[: len(names)])
        rng.shuffle(letters)
        key[f"s{made:02d}"] = {"text": " ".join(w.w for w in sent), **{l: s for l, s in zip(letters, names)}}
        for l, s in zip(letters, names):
            a, b = spans[s]
            sf.write(str(out / f"s{made:02d}_{l}.wav"), x[int(a * sr): int(b * sr)], sr)
    (out / "KEY_dont_peek.json").write_text(json.dumps(key, indent=1), encoding="utf-8")
    (out / "README.txt").write_text(
        "Each sNN_X.wav is the same sentence cut EXACTLY at one system's first-word start and last-word end "
        "(no padding).\nListen and note which letters clip the first or last syllable or include extra sound. "
        "Then open KEY_dont_peek.json.\n", encoding="utf-8")
    return made


def fmt(v, pct=False, nd=2):
    if v is None:
        return "-"
    return f"{v * 100:.1f}%" if pct else f"{v:.{nd}f}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", nargs="+", required=True)
    ap.add_argument("--listen", type=int, default=12)
    args = ap.parse_args()

    lines = ["# ASR bake-off report", "",
             "WER = agreement with the human reference after simple normalization (YouTube manual captions are often "
             "lightly cleaned, so verbatim systems can look slightly worse). Boundary risk is an energy heuristic - "
             "confirm with the listening pack.", ""]
    agg: dict[str, dict[str, list]] = {}

    for eid in args.ids:
        ep = episode_dir(eid)
        meta = json.loads((ep / "meta.json").read_text(encoding="utf-8"))
        cues = json.loads((ep / "reference.json").read_text(encoding="utf-8"))
        systems = {p.stem: load_asr(p) for p in sorted((ep / "asr").glob("*.json"))}
        if not systems:
            print(f"{eid}: no ASR outputs, skipping")
            continue
        db, ref_db, sr = frame_db(ep / "audio16k.wav")

        lines += [f"## {eid}", "",
                  f"Source: `{meta['source']}` - slice start {meta['start']}s, duration {meta['duration'] or 'full'}s. "
                  f"Reference: {meta['reference_origin'] or 'none'} ({len(cues)} cues).", "",
                  "| System | Model | WER (no fillers) | WER (raw) | S/D/I (no fillers) | RTF | $/audio-hr | Sentence-end risk | Sentence-start risk | Notes |",
                  "|---|---|---|---|---|---|---|---|---|---|"]
        for name, d in systems.items():
            w = wer_for(d["words"], cues)
            br = boundary_risk(d["words"], db, ref_db)
            price = PRICE_PER_HOUR.get(name if name != "scribe" else d["model"])
            notes = []
            if d.get("word_end_estimated"):
                notes.append("word ends estimated")
            if d.get("words_without_timing"):
                notes.append(f"{d['words_without_timing']} words untimed")
            lines.append(
                f"| {name} | {d['model']} | {fmt(w and w['wer_nf'], pct=True)} | {fmt(w and w['wer'], pct=True)} | "
                f"{'/'.join(str(w[k]) for k in ('sub', 'del', 'ins')) if w else '-'} | {fmt(d['rtf'])} | "
                f"{fmt(price) if price is not None else '?'} | {fmt(br['tail_risk'], pct=True)} (n={br['tail_n']}) | "
                f"{fmt(br['head_risk'], pct=True)} (n={br['head_n']}) | {'; '.join(notes)} |")
            a = agg.setdefault(name, {"wer": [], "rtf": [], "tail": [], "head": []})
            if w:
                a["wer"].append(w["wer_nf"])
            a["rtf"].append(d["rtf"])
            if br["tail_risk"] is not None:
                a["tail"].append(br["tail_risk"])
            if br["head_risk"] is not None:
                a["head"].append(br["head_risk"])

        if len(systems) > 1:
            lines += ["", "Timing agreement on matched words (seconds):", "",
                      "| Pair | Matched | median Δstart | p90 Δstart | median Δend | p90 Δend |", "|---|---|---|---|---|---|"]
            for s1, s2 in combinations(sorted(systems), 2):
                a, b = systems[s1]["words"], systems[s2]["words"]
                pairs = match(a, b)
                if not pairs:
                    continue
                ds = sorted(abs(a[i].start - b[j].start) for i, j in pairs)
                de = sorted(abs(a[i].end - b[j].end) for i, j in pairs)
                p90 = lambda v: v[int(0.9 * (len(v) - 1))]  # noqa: E731
                lines.append(f"| {s1} vs {s2} | {len(pairs)} | {statistics.median(ds):.3f} | {p90(ds):.3f} | "
                             f"{statistics.median(de):.3f} | {p90(de):.3f} |")
            made = listening_pack(ep, systems, args.listen, sr)
            lines += ["", f"Listening pack: {made} sentences in `data/bakeoff/{eid}/listen/`."]
        lines.append("")

    if len(args.ids) > 1 and agg:
        lines += ["## Across episodes (mean)", "",
                  "| System | WER (no fillers) | RTF | Sentence-end risk | Sentence-start risk |", "|---|---|---|---|---|"]
        m = lambda v: statistics.mean(v) if v else None  # noqa: E731
        for name, a in sorted(agg.items()):
            lines.append(f"| {name} | {fmt(m(a['wer']), pct=True)} | {fmt(m(a['rtf']))} | "
                         f"{fmt(m(a['tail']), pct=True)} | {fmt(m(a['head']), pct=True)} |")

    out = DATA / "report.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(out.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
