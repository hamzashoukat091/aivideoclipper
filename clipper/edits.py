"""User edits of a clip (docs/UI_SPEC.md section 5b): pure functions shared by the pipeline and the server.

The edits file `edits/<clip>.json` holds an Edits object plus `original` (the selection's cut and title, kept so
"back to automatic" can restore them). Nothing here touches the disk except load_edits; no numpy, no subprocess,
so the server can import it cheaply.

Plans: `reframe/<clip>.json` keeps `auto_shots`, the untouched automatic shots; `shots` is auto_shots with the
shot edits applied, so AUTO always restores the automatic framing.
"""
from __future__ import annotations

import copy
import json
import math
from fractions import Fraction
from pathlib import Path
from typing import Any

VERSION = 1
MIN_S, MAX_S = 3.0, 180.0
CAPTION_SIZE_MIN, CAPTION_SIZE_MAX, CAPTION_SIZE_DEFAULT = 64, 110, 84
HOOK_SECONDS_MIN, HOOK_SECONDS_MAX, HOOK_SECONDS_DEFAULT = 0.5, 10.0, 3.0
HOOK_TEXT_MAX, TITLE_MAX, WORD_MAX = 120, 200, 60
MAX_SHOT_EDITS = 500
POSITION_Y = {"upper": 520, "middle": 960, "lower": 1150}     # "auto" = per-layout rule in captions.py
POSITIONS = ("auto", *POSITION_Y)
LAYOUTS = ("AUTO", "TRACK", "FIXED", "GROUP", "SPLIT", "FIT")
ASPECT = 9 / 16
ASPECT_TOL = 0.01
RANGE_EPS = 0.0005                                           # seconds: "inside the plan" tolerance


class EditError(ValueError):
    """Invalid edits. `code` is the API error code (400)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- defaults / loading

def default_edits(cand: dict[str, Any]) -> dict[str, Any]:
    return {"version": VERSION, "trim": None, "shots": [], "words": {},
            "hook": {"text": str(cand.get("on_screen_hook") or ""), "enabled": True, "seconds": HOOK_SECONDS_DEFAULT},
            "captions": {"enabled": True, "position": "auto", "size": CAPTION_SIZE_DEFAULT},
            "title": None}


def public(edits: dict[str, Any]) -> dict[str, Any]:
    """The Edits object without file-only bookkeeping (`original`)."""
    return {k: copy.deepcopy(v) for k, v in edits.items() if k != "original"}


def load_edits(path: Path, cand: dict[str, Any]) -> dict[str, Any] | None:
    """The saved edits (missing keys filled from the defaults), or None when there is no file. A file that is not
    valid JSON raises: a corrupt edits file must not silently render the automatic version."""
    if not path.is_file():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise TypeError(f"{path}: edits must be a JSON object")
    out = default_edits(cand)
    for key in ("trim", "shots", "words", "title", "original"):
        if key in raw:
            out[key] = raw[key]
    for key in ("hook", "captions"):
        if isinstance(raw.get(key), dict):
            out[key] = {**out[key], **raw[key]}
    return out


# ---------------------------------------------------------------- validation

def _num(v: Any, what: str, code: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise EditError(code, f"{what} must be a number")
    return float(v)


def _bool(v: Any, what: str, code: str) -> bool:
    if not isinstance(v, bool):
        raise EditError(code, f"{what} must be true or false")
    return v


def _obj(v: Any, what: str, keys: set[str], code: str = "invalid_edits") -> dict[str, Any]:
    if not isinstance(v, dict):
        raise EditError(code, f"{what} must be an object")
    extra = set(v) - keys
    if extra:
        raise EditError(code, f"{what}: unknown field(s) {', '.join(sorted(extra))}")
    missing = keys - set(v)
    if missing:
        raise EditError(code, f"{what}: missing field(s) {', '.join(sorted(missing))}")
    return v


def crop_width(src_h: int) -> int:
    """Width of a full-height 9:16 crop, as reframe.py computes it (even pixels)."""
    return int(round(src_h * ASPECT / 2) * 2)


def validate_edits(raw: Any, *, base_cut: tuple[float, float], source_duration: float, src_w: int, src_h: int,
                   word_count: int, plan: dict[str, Any] | None) -> dict[str, Any]:
    """A clean Edits object or EditError. `base_cut` is the selection's cut (used when trim is null); `plan` (the
    current framing plan, may be None) decides whether SPLIT is available for a shot."""
    e = _obj(raw, "edits", {"version", "trim", "shots", "words", "hook", "captions", "title"})
    if e["version"] != VERSION:
        raise EditError("invalid_edits", f"version must be {VERSION}")

    trim = None
    if e["trim"] is not None:
        t = _obj(e["trim"], "trim", {"cut_in", "cut_out"}, "bad_trim")
        a, b = _num(t["cut_in"], "trim.cut_in", "bad_trim"), _num(t["cut_out"], "trim.cut_out", "bad_trim")
        if not a < b:
            raise EditError("bad_trim", "trim.cut_in must be before trim.cut_out")
        if a < 0 or b > source_duration + RANGE_EPS:
            raise EditError("bad_trim", f"trim must lie inside the source (0-{source_duration:.2f} s)")
        trim = {"cut_in": round(a, 3), "cut_out": round(min(b, source_duration), 3)}
    cut_in, cut_out = (trim["cut_in"], trim["cut_out"]) if trim else base_cut
    length = cut_out - cut_in
    if not MIN_S - RANGE_EPS <= length <= MAX_S + RANGE_EPS:
        raise EditError("bad_trim", f"clip length must be {MIN_S:.0f}-{MAX_S:.0f} s (got {length:.2f} s)")

    if not isinstance(e["shots"], list) or len(e["shots"]) > MAX_SHOT_EDITS:
        raise EditError("bad_shot", f"shots must be a list of at most {MAX_SHOT_EDITS} edits")
    cw = crop_width(src_h)
    shots = []
    for i, s in enumerate(e["shots"]):
        if not isinstance(s, dict) or "at" not in s or "layout" not in s:
            raise EditError("bad_shot", f"shots[{i}] needs `at` and `layout`")
        allowed = {"at", "layout", "x", "crop"}
        if set(s) - allowed:
            raise EditError("bad_shot", f"shots[{i}]: unknown field(s) {', '.join(sorted(set(s) - allowed))}")
        at = _num(s["at"], f"shots[{i}].at", "bad_shot")
        if not cut_in <= at < cut_out:
            raise EditError("bad_shot", f"shots[{i}].at ({at:.2f} s) is outside the clip ({cut_in:.2f}-{cut_out:.2f} s)")
        layout = s["layout"]
        if layout not in LAYOUTS:
            raise EditError("bad_shot", f"shots[{i}].layout must be one of {', '.join(LAYOUTS)}")
        out: dict[str, Any] = {"at": round(at, 3), "layout": layout}
        if layout == "FIXED":
            x = _num(s.get("x"), f"shots[{i}].x", "bad_shot")
            if not 0 <= x <= src_w - cw:
                raise EditError("bad_shot", f"shots[{i}].x must be 0-{src_w - cw} (crop {cw} px wide)")
            out["x"] = round(x)
        elif layout == "GROUP":
            c = _obj(s.get("crop"), f"shots[{i}].crop", {"x", "y", "w", "h"}, "bad_shot")
            x, y, w, h = (_num(c[k], f"shots[{i}].crop.{k}", "bad_shot") for k in ("x", "y", "w", "h"))
            if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > src_w or y + h > src_h:
                raise EditError("bad_shot", f"shots[{i}].crop must lie inside the {src_w}x{src_h} frame")
            if abs((w / h) / ASPECT - 1) > ASPECT_TOL:
                raise EditError("bad_shot", f"shots[{i}].crop must be 9:16 (±1%)")
            out["crop"] = {"x": round(x), "y": round(y), "w": round(w), "h": round(h)}
        elif layout == "SPLIT":
            auto = shot_at(plan, at, auto=True) if plan else None
            if auto is None or auto.get("layout") != "SPLIT":
                raise EditError("split_unavailable", f"shots[{i}]: Split is only available where the automatic "
                                                     "framing found two people talking")
        shots.append(out)

    if not isinstance(e["words"], dict) or len(e["words"]) > 100_000:
        raise EditError("bad_word", "words must be an object of word index -> text")
    words = {}
    for k, v in e["words"].items():
        if not (isinstance(k, str) and k.isdigit() and int(k) < word_count):
            raise EditError("bad_word", f"words: {k!r} is not a word index (0-{word_count - 1})")
        if not isinstance(v, str) or len(v) > WORD_MAX or "\n" in v or "\r" in v:
            raise EditError("bad_word", f"words[{k}] must be text up to {WORD_MAX} characters, one line")
        words[str(int(k))] = v.strip()

    h = _obj(e["hook"], "hook", {"text", "enabled", "seconds"}, "bad_hook")
    if not isinstance(h["text"], str) or len(h["text"]) > HOOK_TEXT_MAX:
        raise EditError("bad_hook", f"hook.text must be text up to {HOOK_TEXT_MAX} characters")
    secs = _num(h["seconds"], "hook.seconds", "bad_hook")
    if not HOOK_SECONDS_MIN <= secs <= HOOK_SECONDS_MAX:
        raise EditError("bad_hook", f"hook.seconds must be {HOOK_SECONDS_MIN}-{HOOK_SECONDS_MAX:.0f}")
    hook = {"text": h["text"].strip(), "enabled": _bool(h["enabled"], "hook.enabled", "bad_hook"),
            "seconds": round(secs, 2)}

    c = _obj(e["captions"], "captions", {"enabled", "position", "size"}, "bad_captions")
    if c["position"] not in POSITIONS:
        raise EditError("bad_captions", f"captions.position must be one of {', '.join(POSITIONS)}")
    size = _num(c["size"], "captions.size", "bad_captions")
    if not CAPTION_SIZE_MIN <= size <= CAPTION_SIZE_MAX:
        raise EditError("bad_captions", f"captions.size must be {CAPTION_SIZE_MIN}-{CAPTION_SIZE_MAX}")
    caps = {"enabled": _bool(c["enabled"], "captions.enabled", "bad_captions"), "position": c["position"],
            "size": round(size)}

    title = e["title"]
    if title is not None:
        if not isinstance(title, str) or not title.strip() or len(title) > TITLE_MAX:
            raise EditError("bad_title", f"title must be null or 1-{TITLE_MAX} characters")
        title = title.strip()
    return {"version": VERSION, "trim": trim, "shots": shots, "words": words, "hook": hook, "captions": caps,
            "title": title}


# ---------------------------------------------------------------- plans: lookup, slicing, shot edits

def _fps(plan: dict[str, Any]) -> Fraction:
    return Fraction(plan["fps"])


def frame_at(plan: dict[str, Any], t: float) -> int:
    """Clip-relative frame index of source time t (frame i is shown at cut_in + i/fps)."""
    return math.floor((t - plan["cut_in"]) * _fps(plan) + 1e-6)


def shot_index(shots: list[dict[str, Any]], f: int) -> int | None:
    return next((k for k, s in enumerate(shots) if s["f0"] <= f < s["f1"]), None)


def shot_at(plan: dict[str, Any], t: float, auto: bool = False) -> dict[str, Any] | None:
    shots = (plan.get("auto_shots") or plan["shots"]) if auto else plan["shots"]
    k = shot_index(shots, frame_at(plan, t))
    return shots[k] if k is not None else None


def covers(plan: dict[str, Any], cut_in: float, cut_out: float) -> bool:
    return plan["cut_in"] - RANGE_EPS <= cut_in and cut_out <= plan["cut_out"] + RANGE_EPS


def _slice_shots(shots: list[dict[str, Any]], off: int, n: int) -> list[dict[str, Any]]:
    out = []
    for s in shots:
        a, b = max(s["f0"] - off, 0), min(s["f1"] - off, n)
        if b <= a:
            continue
        lo, hi = a + off - s["f0"], b + off - s["f0"]       # positions inside the old shot's per-frame arrays
        t = copy.deepcopy(s)
        t["f0"], t["f1"] = a, b
        for key in ("x", "speaker_track"):
            if isinstance(t.get(key), list):
                t[key] = t[key][lo:hi]
        if isinstance(t.get("hard_cuts"), list):
            t["hard_cuts"] = [c - off for c in t["hard_cuts"] if a < c - off < b]
        if t.get("hold_frame") is not None:
            hf = t["hold_frame"] - off
            if 0 <= hf < n:
                t["hold_frame"] = hf
            else:                           # the held frame was trimmed away: show the shot's own frames
                del t["hold_frame"]
        out.append(t)
    return out


def slice_plan(plan: dict[str, Any], new_in: float, new_out: float) -> dict[str, Any]:
    """The plan for a sub-range [new_in, new_out] of the plan's range, without re-analysis. Frames are re-indexed
    from new_in; shots outside are dropped, edge shots trimmed, per-frame arrays / hard cuts / held frames shifted.
    Raises ValueError when the range is not inside the plan."""
    if not covers(plan, new_in, new_out) or not new_in < new_out:
        raise ValueError(f"{new_in}-{new_out} is not inside the plan range {plan['cut_in']}-{plan['cut_out']}")
    fps = _fps(plan)
    off = max(0, min(round((new_in - plan["cut_in"]) * fps), plan["frames"] - 1))
    n = max(1, min(plan["frames"] - off, round((new_out - new_in) * fps)))
    out = copy.deepcopy(plan)
    out.update(cut_in=round(new_in, 3), cut_out=round(new_out, 3), duration=round(new_out - new_in, 3), frames=n)
    out["shots"] = _slice_shots(plan["shots"], off, n)
    if isinstance(plan.get("auto_shots"), list):
        out["auto_shots"] = _slice_shots(plan["auto_shots"], off, n)
    if isinstance(out.get("qa"), dict):
        out["qa"]["layouts"] = layout_counts(out["shots"])
    return out


def layout_counts(shots: list[dict[str, Any]]) -> dict[str, int]:
    return {k: sum(1 for s in shots if s.get("layout") == k) for k in ("TRACK", "GROUP", "SPLIT", "FIT")}


_COMMON = ("f0", "f1", "faces", "talk_share", "hold_frame")


def _fixed_track(auto: dict[str, Any], x: int, cw: int, src_h: int, reason: str) -> dict[str, Any]:
    n = auto["f1"] - auto["f0"]
    s = {k: auto[k] for k in _COMMON if k in auto}
    s.update(layout="TRACK", w=cw, h=src_h, x=[x] * n, hard_cuts=[], reason=reason)
    if auto.get("layout") == "TRACK" and isinstance(auto.get("speaker_track"), list):
        s["speaker_track"] = list(auto["speaker_track"])
    return s


def _follow_fallback_x(auto: dict[str, Any], src_w: int, cw: int) -> int:
    """Static crop centre for 'Follow speaker' on a shot the automatic plan did not track: the GROUP crop's centre,
    the more talkative SPLIT panel's centre, or the frame centre."""
    if auto.get("layout") == "GROUP" and isinstance(auto.get("crop"), dict):
        cx = auto["crop"]["x"] + auto["crop"]["w"] / 2
    elif auto.get("layout") == "SPLIT" and isinstance(auto.get("top"), dict):
        share = auto.get("talk_share") or [1, 0]
        panel = auto["top"] if share[0] >= (share[1] if len(share) > 1 else 0) else auto["bottom"]
        cx = panel["x"] + panel["w"] / 2
    else:
        cx = src_w / 2
    return round(min(max(cx - cw / 2, 0), src_w - cw))


def apply_shot_edits(plan: dict[str, Any], edits: dict[str, Any] | None) -> list[str]:
    """Rebuild plan["shots"] from plan["auto_shots"] (created from plan["shots"] the first time) plus the shot
    edits, in place. Edits whose `at` falls outside the plan are ignored (the plan is for another range; reframe
    re-applies them). Returns warnings for edits that could not be applied."""
    if not isinstance(plan.get("auto_shots"), list):
        plan["auto_shots"] = copy.deepcopy(plan["shots"])
    auto = plan["auto_shots"]
    shots = copy.deepcopy(auto)
    src_w, src_h = plan["src_w"], plan["src_h"]
    cw = crop_width(src_h)
    warnings = []
    for e in (edits or {}).get("shots") or []:
        k = shot_index(auto, frame_at(plan, e["at"]))
        if k is None:
            continue
        a, layout = auto[k], e["layout"]
        if layout == "AUTO":
            shots[k] = copy.deepcopy(a)
        elif layout == "TRACK":
            shots[k] = copy.deepcopy(a) if a.get("layout") == "TRACK" else _fixed_track(
                a, _follow_fallback_x(a, src_w, cw), cw, src_h,
                "edited: follow speaker (no speaker track for this shot: centred crop)")
        elif layout == "FIXED":
            shots[k] = _fixed_track(a, min(max(int(e["x"]), 0), src_w - cw), cw, src_h, "edited: fixed crop")
        elif layout == "GROUP":
            s = {kk: a[kk] for kk in _COMMON if kk in a}
            s.update(layout="GROUP", crop=dict(e["crop"]), reason="edited: group crop")
            shots[k] = s
        elif layout == "FIT":
            s = {kk: a[kk] for kk in _COMMON if kk in a}
            s.update(layout="FIT", reason="edited: full frame")
            shots[k] = s
        elif layout == "SPLIT":
            if a.get("layout") == "SPLIT":
                shots[k] = copy.deepcopy(a)
            else:
                warnings.append(f"shot at {e['at']:.2f}s: Split unavailable (automatic layout {a.get('layout')})")
    plan["shots"] = shots
    return warnings


# ---------------------------------------------------------------- captions / hook

def clip_words(words: list[dict[str, Any]], cut_in: float, cut_out: float,
               replacements: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Words overlapping the clip, times relative to cut_in, with replacement text applied ("" hides a word)."""
    rep = replacements or {}
    out = []
    for i, w in enumerate(words):
        if w["end"] > cut_in and w["start"] < cut_out:
            text = rep.get(str(i), w["w"])
            if text.strip():
                out.append({"w": text.strip(), "start": w["start"] - cut_in, "end": w["end"] - cut_in})
    return out


def hook_spec(edits: dict[str, Any] | None, cand: dict[str, Any], enabled: bool = True) -> tuple[str | None, float]:
    """(hook text or None, seconds) for the render; without edits: the candidate's hook for the default seconds."""
    h = (edits or default_edits(cand))["hook"]
    text = str(h.get("text") or "").strip()
    secs = float(h.get("seconds") or HOOK_SECONDS_DEFAULT)
    return (text if enabled and h.get("enabled", True) and text else None), secs


def caption_spec(edits: dict[str, Any] | None) -> dict[str, Any]:
    c = (edits or {}).get("captions") or {}
    return {"enabled": bool(c.get("enabled", True)), "position": c.get("position", "auto"),
            "size": int(c.get("size", CAPTION_SIZE_DEFAULT))}
