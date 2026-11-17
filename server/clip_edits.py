"""Clip edits (docs/UI_SPEC.md section 5b): EditContext, save (PUT) and back-to-automatic (DELETE).

The rules themselves live in clipper/edits.py (shared with the pipeline). This module owns the files:
- `edits/<cid>.json`       the saved Edits plus `original` (the selection's cut and title)
- `edits/<cid>.plan.json`  the last full (unsliced) reframe plan, kept while `reframe/<cid>.json` is a slice of
                           it, so a later, longer trim inside the analysed range still needs no re-analysis
- `reframe/<cid>.json`     sliced and/or re-framed in place; a sliced plan carries `sliced_from: [in, out]`.
                           A plan written by reframe.py has no marker, so a re-analysis resets the base.
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from clipper import edits as E

from .errors import ApiError
from .jobs import candidate_lock, reframe_state, render_state, same_range, step_clips
from .paths import read_json, read_json_cached, write_json_atomic

WORD_WINDOW_S = 10.0
CLIP_ACTIONS = ("reframe", "render")


def _paths(d: Path, cid: str) -> tuple[Path, Path, Path]:
    return d / "edits" / f"{cid}.json", d / "edits" / f"{cid}.plan.json", d / "reframe" / f"{cid}.json"


def _candidates(d: Path) -> list[dict[str, Any]]:
    data = read_json(d / "candidates.json")
    if not isinstance(data, list):
        raise ApiError(404, "not_found", "no candidates.json yet: run the select stage")
    return data


def _find(cands: list[dict[str, Any]], cid: str) -> dict[str, Any]:
    cand = next((c for c in cands if isinstance(c, dict) and c.get("id") == cid), None)
    if cand is None:
        raise ApiError(404, "not_found", f"clip {cid} is not in candidates.json")
    return cand


def _load(d: Path, cid: str, cand: dict[str, Any]) -> dict[str, Any] | None:
    try:
        return E.load_edits(_paths(d, cid)[0], cand)
    except (OSError, ValueError, TypeError) as exc:
        raise ApiError(500, "bad_edits_file", f"edits/{cid}.json is unreadable: {exc}") from exc


def _original(saved: dict[str, Any] | None, cand: dict[str, Any]) -> dict[str, Any]:
    orig = (saved or {}).get("original")
    if isinstance(orig, dict) and {"cut_in", "cut_out", "title"} <= set(orig):
        return {"cut_in": orig["cut_in"], "cut_out": orig["cut_out"], "title": orig["title"]}
    return {"cut_in": cand.get("cut_in"), "cut_out": cand.get("cut_out"), "title": cand.get("title") or ""}


def _source_info(d: Path) -> tuple[float, int, int]:
    probe = read_json_cached(d / "probe.json")
    meta = read_json_cached(d / "meta.json")
    probe = probe if isinstance(probe, dict) else {}
    meta = meta if isinstance(meta, dict) else {}
    dur = probe.get("duration") or meta.get("duration")
    w, h = probe.get("width"), probe.get("height")
    if not isinstance(dur, (int, float)) or not isinstance(w, int) or not isinstance(h, int):
        raise ApiError(409, "not_ingested", "the source has not been ingested (probe.json missing)")
    return float(dur), w, h


def _words(d: Path) -> list[dict[str, Any]]:
    data = read_json_cached(d / "words.json")
    words = data.get("words") if isinstance(data, dict) else None
    return words if isinstance(words, list) else []


def base_plan(d: Path, cid: str) -> dict[str, Any] | None:
    """The widest plan available without re-analysis: the saved full plan while the current one is a slice of it,
    else the current plan. None when the clip was never reframed."""
    _, base_path, plan_path = _paths(d, cid)
    plan = read_json(plan_path)
    if not isinstance(plan, dict):
        return None
    sliced_from = plan.get("sliced_from")
    if isinstance(sliced_from, list) and len(sliced_from) == 2:
        base = read_json(base_path)
        if isinstance(base, dict) and same_range(base.get("cut_in"), base.get("cut_out"), *sliced_from):
            return base
    return plan


def _write_plan(d: Path, cid: str, base: dict[str, Any] | None, cut_in: float, cut_out: float,
                edits: dict[str, Any] | None) -> None:
    """Make reframe/<cid>.json match the new cut (slice the base when it covers it) and the shot edits."""
    if base is None:
        return
    _, base_path, plan_path = _paths(d, cid)
    base = {k: v for k, v in base.items() if k != "sliced_from"}
    if same_range(base["cut_in"], base["cut_out"], cut_in, cut_out):
        plan = copy.deepcopy(base)
        base_path.unlink(missing_ok=True)            # the plan is the full analysis again
    elif E.covers(base, cut_in, cut_out):
        write_json_atomic(base_path, base)
        plan = E.slice_plan(base, cut_in, cut_out)
        plan["sliced_from"] = [base["cut_in"], base["cut_out"]]
    else:                                            # outside the analysed range: reframe must run; keep the plan
        current = read_json(plan_path)
        plan = current if isinstance(current, dict) else copy.deepcopy(base)
    E.apply_shot_edits(plan, edits)
    write_json_atomic(plan_path, plan)


def needs(d: Path, cand: dict[str, Any]) -> list[str]:
    """What must run for the saved edits to show in the video."""
    out = []
    if reframe_state(d, cand) != "done":
        out.append("reframe")
    if out or render_state(d, cand) in ("missing", "stale"):
        out.append("render")
    return out


def context(d: Path, cid: str) -> dict[str, Any]:
    cand = _find(_candidates(d), cid)
    saved = _load(d, cid, cand)
    duration, _, _ = _source_info(d)
    orig = _original(saved, cand)
    lo, hi = float(cand["cut_in"]) - WORD_WINDOW_S, float(cand["cut_out"]) + WORD_WINDOW_S
    words = [{"i": i, "w": w.get("w", ""), "start": w["start"], "end": w["end"]}
             for i, w in enumerate(_words(d)) if w.get("end", 0) > lo and w.get("start", 0) < hi]
    base = base_plan(d, cid)
    return {"edits": E.public(saved) if saved else E.default_edits(cand),
            "original": {**orig, "hook": str(cand.get("on_screen_hook") or "")},
            "words": words,
            "limits": {"min_s": E.MIN_S, "max_s": E.MAX_S, "source_duration": duration},
            "plan_range": {"cut_in": base["cut_in"], "cut_out": base["cut_out"]} if base else None,
            "needs": needs(d, cand)}


def _set_cut(cand: dict[str, Any], cut_in: float, cut_out: float, title: str) -> None:
    cand.update(cut_in=cut_in, cut_out=cut_out, duration=round(cut_out - cut_in, 2), title=title)


def save(d: Path, cid: str, body: Any) -> dict[str, Any]:
    edits_path = _paths(d, cid)[0]
    with candidate_lock(d):
        cands = _candidates(d)
        cand = _find(cands, cid)
        orig = _original(_load(d, cid, cand), cand)
        duration, src_w, src_h = _source_info(d)
        base = base_plan(d, cid)
        try:
            clean = E.validate_edits(body, base_cut=(float(orig["cut_in"]), float(orig["cut_out"])),
                                     source_duration=duration, src_w=src_w, src_h=src_h,
                                     word_count=len(_words(d)), plan=base)
        except E.EditError as exc:
            raise ApiError(400, exc.code, exc.message) from exc
        trim = clean["trim"] or {"cut_in": orig["cut_in"], "cut_out": orig["cut_out"]}
        _set_cut(cand, trim["cut_in"], trim["cut_out"], clean["title"] or orig["title"])
        write_json_atomic(edits_path, {**clean, "original": orig})
        write_json_atomic(d / "candidates.json", cands)
        _write_plan(d, cid, base, trim["cut_in"], trim["cut_out"], clean)
    return context(d, cid)


def reset(d: Path, cid: str) -> dict[str, Any]:
    """Back to automatic: restore the selection's cut and title, drop the edits, restore the automatic framing."""
    edits_path = _paths(d, cid)[0]
    with candidate_lock(d):
        cands = _candidates(d)
        cand = _find(cands, cid)
        saved = _load(d, cid, cand)
        if saved is None:                            # already automatic: nothing to restore, nothing to stale
            return context(d, cid)
        orig = _original(saved, cand)
        base = base_plan(d, cid)
        _set_cut(cand, orig["cut_in"], orig["cut_out"], orig["title"])
        write_json_atomic(d / "candidates.json", cands)
        edits_path.unlink(missing_ok=True)
        _write_plan(d, cid, base, orig["cut_in"], orig["cut_out"], None)
    return context(d, cid)


def clip_busy(active: dict[str, Any] | None, cid: str) -> bool:
    """A queued/running run that may read or rewrite this clip's candidate, plan or render."""
    if active is None:
        return False
    if active.get("action") in ("select", "produce"):
        return True
    return any(st.get("name") in CLIP_ACTIONS and st.get("state") in ("queued", "running")
               and (not st.get("command") or cid in step_clips(st))
               for st in active.get("steps", []))
