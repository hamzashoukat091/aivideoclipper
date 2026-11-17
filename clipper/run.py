"""Run the whole pipeline for one video, skipping work that is already done and still current.

Usage:
  python clipper/run.py <youtube-url | local-file> --id JOB [--select] [--review-first] [--clip c02 c05]
                        [--top 10] [--judge-model sonnet] [--language en] [--speakers N] [--preview] [--fast]
                        [--allow-lower] [--force]

Stages:
  1  ingest -> transcribe -> diarize               free, skipped when outputs exist
  2  sentences -> clip selection                   selection is PAID and runs only with --select (otherwise a free
                                                   cost estimate); skipped when candidates.json exists, unless --select
  3  reframe  (per clip)                           free; redone when the clip's cut times changed
  4  render   (per clip)                           free; redone when the clip's cut times changed
--review-first stops after stage 2 so you can read review.md and set "approved": false on clips you don't want.
Clips with approved=false are never reframed or rendered.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import job_dir, load_env  # noqa: E402


def step(script: str, *args: str, ok=(0,)) -> int:
    rc = subprocess.run([sys.executable, "-W", "ignore", str(HERE / script), *args]).returncode
    if rc not in ok:
        sys.exit(f"{script} failed (exit {rc})")
    return rc


def load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def same_range(a: float, b: float, c: float, e: float) -> bool:
    return abs(a - c) < 0.01 and abs(b - e) < 0.01


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--id", required=True)
    ap.add_argument("--language", default="en")
    ap.add_argument("--speakers", type=int)
    ap.add_argument("--allow-lower", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-run every free stage (selection still needs --select)")
    ap.add_argument("--select", action="store_true", help="run Claude clip selection (PAID; see dry-run estimate)")
    ap.add_argument("--judge-model", default="sonnet", choices=["haiku", "sonnet", "opus"])
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--review-first", action="store_true", help="stop after selection; render on the next run")
    ap.add_argument("--clip", nargs="*", help="only these clip ids (default: all not rejected)")
    ap.add_argument("--preview", action="store_true", help="also write low-res reframe previews")
    ap.add_argument("--fast", action="store_true", help="faster, slightly lower-quality encode for checking")
    args = ap.parse_args()
    d = job_dir(args.id)

    # ---- stage 1
    if args.force or not (d / "meta.json").exists():
        step("ingest.py", args.source, "--id", args.id, *(["--allow-lower"] if args.allow_lower else []))
    if args.force or not (d / "transcript.json").exists():
        step("transcribe.py", "--id", args.id, "--language", args.language)
    load_env()
    retry_diar = not (d / "words.json").exists() or bool(os.environ.get("HF_TOKEN"))   # no token: don't nag twice
    if args.force or (not (d / "diarization.json").exists() and retry_diar):
        rc = step("diarize.py", "--id", args.id, *(["--speakers", str(args.speakers)] if args.speakers else []),
                  ok=(0, 2))
        if rc == 2:
            print("continuing without speaker labels (add HF_TOKEN to .env and re-run to get them)")
    elif args.force or not (d / "words.json").exists():
        step("diarize.py", "--id", args.id, "--merge-only")

    # ---- stage 2
    if args.force or not (d / "sentences.json").exists():
        step("sentences.py", "--id", args.id)
    if args.select:
        step("select_clips.py", "--id", args.id, "--top", str(args.top), "--judge-model", args.judge_model)
    elif not (d / "candidates.json").exists():
        step("select_clips.py", "--id", args.id, "--dry-run", "--judge-model", args.judge_model)
        sys.exit("no clips picked yet: clip selection is PAID - re-run with --select after checking the estimate")

    cands = load(d / "candidates.json") or []
    todo = [c for c in cands if c.get("approved") is not False and (not args.clip or c["id"] in args.clip)]
    print(f"\n{len(cands)} candidates, {len(todo)} to reframe/render "
          f"({sum(c.get('approved') is False for c in cands)} rejected by you)")
    if args.review_first:
        print(f"review first: read {d / 'review.md'}, set \"approved\": false in candidates.json for clips to drop,"
              f" then run the same command without --review-first / --select")
        return
    if not todo:
        return

    # ---- stage 3 + 4, only for clips whose outputs are missing or stale
    def stale_plan(c) -> bool:
        p = load(d / "reframe" / f"{c['id']}.json")
        return args.force or p is None or not same_range(p["cut_in"], p["cut_out"], c["cut_in"], c["cut_out"])

    def stale_render(c) -> bool:
        r = load(d / "renders" / f"{c['id']}.report.json")
        mp4, plan = d / "renders" / f"{c['id']}.mp4", d / "reframe" / f"{c['id']}.json"
        return (args.force or r is None or not mp4.exists()
                or not same_range(*r["source_range"], c["cut_in"], c["cut_out"])
                or any(f.exists() and f.stat().st_mtime > mp4.stat().st_mtime        # framing / edits changed
                       for f in (plan, d / "edits" / f"{c['id']}.json")))

    need_plan = [c["id"] for c in todo if stale_plan(c)]
    if need_plan:
        step("reframe.py", "--id", args.id, "--clip", *need_plan, *(["--preview"] if args.preview else []))
    need_render = [c["id"] for c in todo if c["id"] in need_plan or stale_render(c)]
    if need_render:
        step("render.py", "--id", args.id, "--clip", *need_render, *(["--fast"] if args.fast else []))

    # ---- summary
    print("\nclips:")
    for c in todo:
        r = load(d / "renders" / f"{c['id']}.report.json") or {}
        bad = [k for k, v in (r.get("checks") or {}).items() if not v]
        state = "MISSING" if not r else ("checks FAILED: " + ", ".join(bad) if bad else "ok")
        print(f"  {c['id']}  {c.get('duration', 0):5.1f}s  {state:10s}  {c.get('title', '')}")
    print(f"\nvideos: {d / 'renders'}\nreview sheet: {d / 'review.md'}")


if __name__ == "__main__":
    main()
