"""Run actions -> ordered steps (docs/UI_SPEC.md "Run actions -> commands").

Each step's command is resolved lazily, right before it starts, so it sees the outputs of the steps before it
(e.g. `produce` decides which clips to reframe only after selection). A resolver returns None when there is
nothing to do (the step is then `skipped`) and raises StepError when the step cannot run.
"""
from __future__ import annotations

import os
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .jobs import load_candidates, reframe_state, render_state, source_path
from .paths import read_json

ACTIONS = ("prepare", "ingest", "transcribe", "diarize", "sentences", "select", "reframe", "render", "produce",
           "proxy")
PROXY_PART = "ui/source_proxy.part.mp4"
PROXY = "ui/source_proxy.mp4"


class StepError(Exception):
    """A step that cannot start (bad input, missing prerequisite, unconfirmed paid call)."""


@dataclass
class RunContext:
    root: Path
    job_dir: Path
    job_id: str
    params: dict[str, Any]
    hf_key: bool
    reframed: list[str] = field(default_factory=list)   # clips reframed earlier in this run (render must follow)


Resolver = Callable[[RunContext], "list[str] | None"]


@dataclass
class StepPlan:
    name: str
    resolve: Resolver
    ok_codes: tuple[int, ...] = (0,)
    on_success: Callable[[RunContext], None] | None = None


def _py(script: str, *args: str) -> list[str]:
    return [sys.executable, "-W", "ignore", f"clipper/{script}", *args]


def _meta(ctx: RunContext) -> dict[str, Any]:
    meta = read_json(ctx.job_dir / "meta.json")
    return meta if isinstance(meta, dict) else {}


def _has(ctx: RunContext, rel: str) -> bool:
    return (ctx.job_dir / rel).is_file()


def needs_paid_confirmation(action: str, job_dir: Path) -> bool:
    return action == "select" or (action == "produce" and not (job_dir / "candidates.json").is_file())


# ---------------------------------------------------------------- resolvers

def _ingest(skip_done: bool) -> Resolver:
    def resolve(ctx: RunContext) -> list[str] | None:
        if skip_done and _has(ctx, "meta.json") and _has(ctx, "probe.json"):
            return None
        source = ctx.params.get("source") or _meta(ctx).get("source")
        if not source:
            raise StepError("no source: pass `source` (URL or local file)")
        return _py("ingest.py", str(source), "--id", ctx.job_id,
                   *(["--allow-lower"] if ctx.params.get("allow_lower") else []))
    return resolve


def _transcribe(skip_done: bool) -> Resolver:
    def resolve(ctx: RunContext) -> list[str] | None:
        if skip_done and _has(ctx, "transcript.json"):
            return None
        return _py("transcribe.py", "--id", ctx.job_id, "--language", str(ctx.params.get("language") or "en"))
    return resolve


def _diarize(skip_done: bool) -> Resolver:
    def resolve(ctx: RunContext) -> list[str] | None:
        speakers = ["--speakers", str(ctx.params["speakers"])] if ctx.params.get("speakers") else []
        if skip_done:
            if _has(ctx, "diarization.json"):
                return None if _has(ctx, "words.json") else _py("diarize.py", "--id", ctx.job_id, "--merge-only")
            if _has(ctx, "words.json") and not ctx.hf_key:
                return None             # no token: diarize would only rewrite the same unlabelled words.json
        return _py("diarize.py", "--id", ctx.job_id, *speakers)
    return resolve


def _sentences(skip_done: bool) -> Resolver:
    def resolve(ctx: RunContext) -> list[str] | None:
        if skip_done and _has(ctx, "sentences.json"):
            return None
        return _py("sentences.py", "--id", ctx.job_id)
    return resolve


def _select(only_if_missing: bool) -> Resolver:
    def resolve(ctx: RunContext) -> list[str] | None:
        if only_if_missing and _has(ctx, "candidates.json"):
            return None
        if ctx.params.get("confirm_paid") is not True:
            raise StepError("clip selection is PAID and was not confirmed (confirm_paid)")
        return _py("select_clips.py", "--id", ctx.job_id, "--top", str(ctx.params.get("top") or 10),
                   "--judge-model", str(ctx.params.get("judge_model") or "sonnet"))
    return resolve


def _live_clips(ctx: RunContext) -> list[dict[str, Any]]:
    return [c for c in load_candidates(ctx.job_dir) if c.get("approved") is not False]


def _reframe(ctx: RunContext) -> list[str] | None:
    if ctx.params.get("clips"):
        ids = list(ctx.params["clips"])
    else:
        force = bool(ctx.params.get("force"))
        ids = [c["id"] for c in _live_clips(ctx) if force or reframe_state(ctx.job_dir, c) != "done"]
    ctx.reframed = ids
    if not ids:
        return None
    return _py("reframe.py", "--id", ctx.job_id, "--clip", *ids, *(["--preview"] if ctx.params.get("preview") else []))


def _render(ctx: RunContext) -> list[str] | None:
    if ctx.params.get("clips"):
        ids = list(ctx.params["clips"])
    else:
        force = bool(ctx.params.get("force"))
        ids = [c["id"] for c in _live_clips(ctx)
               if force or c["id"] in ctx.reframed or render_state(ctx.job_dir, c) != "done"]
    if not ids:
        return None
    return _py("render.py", "--id", ctx.job_id, "--clip", *ids, *(["--fast"] if ctx.params.get("fast") else []))


def _proxy(ctx: RunContext) -> list[str] | None:
    src = source_path(ctx.job_dir, _meta(ctx))
    if src is None:
        raise StepError("no source media: run ingest first")
    (ctx.job_dir / "ui").mkdir(exist_ok=True)
    return [shutil.which("ffmpeg") or "ffmpeg", "-y", "-i", str(src), "-vf", "scale=-2:720", "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
            str(ctx.job_dir / PROXY_PART)]


def _proxy_done(ctx: RunContext) -> None:
    """Publish the proxy only once ffmpeg finished, so a cancelled run never leaves a broken preview behind."""
    os.replace(ctx.job_dir / PROXY_PART, ctx.job_dir / PROXY)


# ---------------------------------------------------------------- plans

def plan(action: str) -> list[StepPlan]:
    if action == "prepare":
        return _prepare_steps(skip_done=None)
    if action == "produce":
        return [*_prepare_steps(skip_done=True), StepPlan("select", _select(only_if_missing=True)),
                StepPlan("reframe", _reframe), StepPlan("render", _render)]
    single: dict[str, StepPlan] = {
        "ingest": StepPlan("ingest", _ingest(False)),
        "transcribe": StepPlan("transcribe", _transcribe(False)),
        "diarize": StepPlan("diarize", _diarize(False), ok_codes=(0, 2)),
        "sentences": StepPlan("sentences", _sentences(False)),
        "select": StepPlan("select", _select(only_if_missing=False)),
        "reframe": StepPlan("reframe", _reframe),
        "render": StepPlan("render", _render),
        "proxy": StepPlan("proxy", _proxy, on_success=_proxy_done),
    }
    if action not in single:
        raise ValueError(f"unknown action {action!r}")
    return [single[action]]


def _prepare_steps(skip_done: bool | None) -> list[StepPlan]:
    """prepare: skip each stage whose output exists unless `force` (skip_done=None: decided by params.force)."""
    def gate(make: Callable[[bool], Resolver]) -> Resolver:
        def resolve(ctx: RunContext) -> list[str] | None:
            skip = skip_done if skip_done is not None else not ctx.params.get("force")
            return make(skip)(ctx)
        return resolve
    return [StepPlan("ingest", gate(_ingest)), StepPlan("transcribe", gate(_transcribe)),
            StepPlan("diarize", gate(_diarize), ok_codes=(0, 2)), StepPlan("sentences", gate(_sentences))]
