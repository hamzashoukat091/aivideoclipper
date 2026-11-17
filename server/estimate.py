"""Free cost estimate for the PAID selection step: `select_clips.py --dry-run` (calls no API) and parse its output."""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

from .errors import ApiError

JUDGE_MODELS = ("haiku", "sonnet", "opus")
DRY_RUN_TIMEOUT_S = 120
RE_USD = re.compile(r"Estimated cost:\s*~?\$([\d.]+)")
RE_PROPOSALS = re.compile(r"(\d+) proposal calls \(([\d,]+) input tokens\)")
RE_JUDGE = re.compile(r"~(\d+) judge calls")


def parse_estimate(raw: str, judge_model: str) -> dict[str, Any]:
    usd = RE_USD.search(raw)
    props = RE_PROPOSALS.search(raw)
    judge = RE_JUDGE.search(raw)
    return {"usd": float(usd.group(1)) if usd else None,
            "proposal_calls": int(props.group(1)) if props else None,
            "judge_calls": int(judge.group(1)) if judge else None,
            "input_tokens": int(props.group(2).replace(",", "")) if props else None,
            "judge_model": judge_model, "raw": raw}


def dry_run_command(job_id: str, judge_model: str, top: int) -> list[str]:
    return [sys.executable, "-W", "ignore", "clipper/select_clips.py", "--id", job_id, "--dry-run",
            "--judge-model", judge_model, "--top", str(top)]


def estimate(root: Path, job_id: str, judge_model: str, top: int) -> dict[str, Any]:
    """Run the dry run (free, a few seconds). A failed dry run still returns an Estimate (nulls + raw output)."""
    if judge_model not in JUDGE_MODELS:
        raise ApiError(400, "bad_param", f"judge_model must be one of {', '.join(JUDGE_MODELS)}")
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    try:
        p = subprocess.run(dry_run_command(job_id, judge_model, top), cwd=root, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=DRY_RUN_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired as exc:
        raise ApiError(504, "estimate_timeout", f"dry run took longer than {DRY_RUN_TIMEOUT_S}s") from exc
    except OSError as exc:
        raise ApiError(500, "estimate_failed", f"could not start the dry run: {exc}") from exc
    raw = p.stdout.decode("utf-8", errors="replace").replace("\r\n", "\n")
    if p.returncode != 0:
        raw += f"\n[exit {p.returncode}]"
    return parse_estimate(raw, judge_model)
