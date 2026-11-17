"""Re-check existing clips' edges against camera cuts (free; no API). Use on jobs selected before cutsnap existed.

Usage:
  python clipper/refine_cuts.py --id JOB [--dry-run]

For each candidate in candidates.json, moves cut_in/cut_out onto a camera cut that falls in the silence before the
first word / after the last word (see cutsnap.py). Changed clips become stale, so run.py / the UI reframe and
render them again. Writes candidates.json atomically and keeps every other field (approvals included).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cutsnap
from common import job_dir, read_json, stage_banner, write_json


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--dry-run", action="store_true", help="show changes, write nothing")
    args = ap.parse_args()
    stage_banner("refine cuts", args.id)
    d = job_dir(args.id)
    cands = read_json(d / "candidates.json")
    sents = read_json(d / "sentences.json")
    words = read_json(d / "words.json")["words"]
    media = Path(read_json(d / "meta.json")["media"])
    fps = read_json(d / "probe.json")["fps_render"]
    changed = 0
    for c in cands:
        a, b = c["start_sentence"], c["end_sentence"]
        speech_start = words[sents[a]["w0"] + int(c.get("start_word_offset") or 0)]["start"]
        new_in, new_out, notes = cutsnap.snap(media, fps, c["cut_in"], c["cut_out"], speech_start, sents[b]["end"])
        if notes:
            print(f"  {c['id']}: {'; '.join(notes)}  ({c['cut_in']:.3f}-{c['cut_out']:.3f} -> "
                  f"{new_in:.3f}-{new_out:.3f})")
            c.update(cut_in=new_in, cut_out=new_out, duration=round(new_out - new_in, 2),
                     cut_notes=c.get("cut_notes", []) + notes)
            changed += 1
        else:
            print(f"  {c['id']}: no camera cut in the edge silences")
    if changed and not args.dry_run:
        write_json(d / "candidates.json", cands)
    print(f"{changed} of {len(cands)} clips changed" + (" (dry run: nothing written)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
