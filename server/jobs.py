"""Read data/jobs/<id>/ into the spec's JSON shapes (docs/UI_SPEC.md sections 2-4). Pure file reads: no subprocesses.

Run state is passed in by the caller (a list of RunInfo dicts for the job, newest first) so this module stays
independent of the runner.
"""
from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .ass import parse_ass
from .errors import ApiError
from .paths import (
    JOB_ID,
    iso,
    media_url,
    read_json,
    read_json_cached,
    write_json_atomic,
)

Run = dict[str, Any]

STAGES: list[tuple[str, str]] = [("ingest", "Ingest"), ("transcribe", "Transcribe"), ("diarize", "Diarize"),
                                 ("sentences", "Sentences"), ("select", "Select"), ("reframe", "Reframe"),
                                 ("render", "Render")]
ACTIVE_RUN_STATES = ("queued", "running")
CUT_TOLERANCE_S = 0.01
NO_HF_NOTE = "No HF_TOKEN — speakers not labelled"
NO_HF_WARNING = "No HF_TOKEN: speakers unlabelled"
PLAYABLE_EXT = {".mp4", ".webm"}
PLAYABLE_CODECS = {"h264", "vp9", "av1"}
KINDS = {
    "video": {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi"},
    "audio": {".wav", ".mp3", ".m4a", ".aac", ".flac", ".opus", ".ogg"},
    "json": {".json"},
    "text": {".txt", ".md", ".log", ".csv"},
    "image": {".jpg", ".jpeg", ".png", ".webp", ".gif"},
    "subtitle": {".ass", ".ssa", ".srt", ".vtt"},
}
INGEST_FILES = ("meta.json", "probe.json", "info.json", "heatmap.json", "chapters.json", "audio16k.wav")

_candidate_locks: dict[str, threading.Lock] = {}
_candidate_locks_guard = threading.Lock()


# ---------------------------------------------------------------- small helpers

def file_kind(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return next((k for k, exts in KINDS.items() if ext in exts), "other")


def file_entry(d: Path, job_id: str, rel: str) -> dict[str, Any] | None:
    try:
        st = (d / rel).stat()
    except OSError:
        return None
    return {"path": rel, "size": st.st_size, "mtime": iso(st.st_mtime), "kind": file_kind(rel),
            "url": media_url(job_id, rel)}


def _entries(d: Path, job_id: str, rels: Iterable[str]) -> list[dict[str, Any]]:
    return [e for e in (file_entry(d, job_id, r) for r in rels) if e is not None]


def _dir_files(d: Path, sub: str) -> list[str]:
    folder = d / sub
    if not folder.is_dir():
        return []
    return sorted(f"{sub}/{p.name}" for p in folder.iterdir() if p.is_file() and not p.name.startswith("."))


def same_range(a: Any, b: Any, c: Any, e: Any) -> bool:
    try:
        return abs(float(a) - float(c)) <= CUT_TOLERANCE_S and abs(float(b) - float(e)) <= CUT_TOLERANCE_S
    except (TypeError, ValueError):
        return False


def source_path(d: Path, meta: dict[str, Any] | None) -> Path | None:
    """The master video (`meta.media`; may live outside the job folder for local-file jobs), if it exists."""
    media = (meta or {}).get("media")
    if not isinstance(media, str) or not media:
        return None
    p = Path(media)
    if not p.is_absolute():
        p = d / p
    return p if p.is_file() else None


def load_candidates(d: Path) -> list[dict[str, Any]]:
    data = read_json(d / "candidates.json")
    return [c for c in data if isinstance(c, dict) and isinstance(c.get("id"), str)] if isinstance(data, list) else []


def _sentences(d: Path) -> list[dict[str, Any]]:
    data = read_json_cached(d / "sentences.json")
    return data if isinstance(data, list) else []


def active_run(runs: list[Run]) -> Run | None:
    return next((r for r in runs if r.get("state") in ACTIVE_RUN_STATES), None)


def step_clips(step: dict[str, Any]) -> list[str]:
    cmd = step.get("command") or []
    return list(cmd[cmd.index("--clip") + 1:]) if "--clip" in cmd else []


# ---------------------------------------------------------------- per-clip status

def reframe_state(d: Path, cand: dict[str, Any]) -> str:
    plan = read_json_cached(d / "reframe" / f"{cand['id']}.json")
    if not isinstance(plan, dict):
        return "missing"
    return "done" if same_range(plan.get("cut_in"), plan.get("cut_out"), cand.get("cut_in"), cand.get("cut_out")) \
        else "stale"


def render_report(d: Path, cid: str) -> dict[str, Any] | None:
    rep = read_json_cached(d / "renders" / f"{cid}.report.json")
    return rep if isinstance(rep, dict) else None


def render_state(d: Path, cand: dict[str, Any]) -> str:
    rep = render_report(d, cand["id"])
    if rep is None or not (d / "renders" / f"{cand['id']}.mp4").is_file():
        return "missing"
    rng = rep.get("source_range")
    if not (isinstance(rng, list) and len(rng) == 2
            and same_range(rng[0], rng[1], cand.get("cut_in"), cand.get("cut_out"))):
        return "stale"
    mp4_mtime = (d / "renders" / f"{cand['id']}.mp4").stat().st_mtime
    for later in (d / "reframe" / f"{cand['id']}.json", d / "edits" / f"{cand['id']}.json"):
        if later.is_file() and later.stat().st_mtime > mp4_mtime:     # framing or user edits changed since
            return "stale"
    checks = rep.get("checks") or {}
    return "failed" if any(v is False for v in checks.values()) else "done"


def _clip_run_state(stage: str, cid: str, active: Run | None) -> str | None:
    if active is None:
        return None
    for st in active.get("steps", []):
        if st.get("name") == stage and cid in step_clips(st):
            if st.get("state") == "running":
                return "running"
            if st.get("state") == "queued":
                return "queued"
    return None


def _aggregate(states: list[str]) -> str:
    """Spec section 3: done iff every clip current; stale if any outdated; missing if none exist; else partial."""
    if not states or all(s == "missing" for s in states):
        return "missing"
    if "failed" in states:
        return "failed"
    if "stale" in states:
        return "stale"
    if "missing" in states:
        return "partial"
    return "done"


# ---------------------------------------------------------------- stages

def _stage_override(key: str, base: str, runs: list[Run]) -> str:
    active = active_run(runs)
    if active:
        steps = [s for s in active.get("steps", []) if s.get("name") == key]
        if any(s.get("state") == "running" for s in steps):
            return "running"
        if base != "done" and any(s.get("state") == "queued" for s in steps):
            return "queued"
    if base == "missing":
        for run in runs:
            if run.get("state") in ACTIVE_RUN_STATES:
                continue
            ran = [s for s in run.get("steps", []) if s.get("name") == key and s.get("state") in ("done", "failed")]
            if ran:
                return "failed" if ran[-1]["state"] == "failed" else base
    return base


def _fmt_dur(seconds: float) -> str:
    s = round(seconds)
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _counts_note(states: list[str], what: str) -> str | None:
    if not states:
        return "no clips to process"
    done = sum(s == "done" for s in states)
    parts = [f"{done}/{len(states)} clips {what}"]
    for label in ("stale", "failed", "missing"):
        n = sum(s == label for s in states)
        if n:
            parts.append(f"{n} {'checks failed' if label == 'failed' else label}")
    return ", ".join(parts)


def compute_stages(d: Path, job_id: str, runs: list[Run], hf_key: bool) -> list[dict[str, Any]]:
    meta = read_json_cached(d / "meta.json")
    probe = read_json_cached(d / "probe.json")
    cands = load_candidates(d)
    live = [c for c in cands if c.get("approved") is not False]
    stages: list[dict[str, Any]] = []

    def add(key: str, label: str, base: str, outputs: list[str], note: str | None) -> None:
        entries = _entries(d, job_id, outputs)
        updated = max((e["mtime"] for e in entries), default=None)
        stages.append({"key": key, "label": label, "state": _stage_override(key, base, runs), "updated": updated,
                       "note": note, "outputs": entries})

    labels = dict(STAGES)
    # ingest
    src = source_path(d, meta if isinstance(meta, dict) else None)
    ingest_out = list(INGEST_FILES) + _source_rels(d, src)
    note = None
    if isinstance(probe, dict):
        bits = [f"{probe.get('height')}p" if probe.get("height") else None,
                f"{probe['fps']:.2f} fps" if isinstance(probe.get("fps"), (int, float)) else None,
                probe.get("vcodec"),
                _fmt_dur(probe["duration"]) if isinstance(probe.get("duration"), (int, float)) else None]
        note = " · ".join(b for b in bits if b) or None
    add("ingest", labels["ingest"], "done" if (d / "meta.json").is_file() and (d / "probe.json").is_file()
        else "missing", ingest_out, note)

    # transcribe
    tr = read_json_cached(d / "transcript.json")
    note = None
    if isinstance(tr, dict):
        words = tr.get("words")
        note = f"{tr.get('model') or 'unknown model'}, {len(words) if isinstance(words, list) else 0} words"
        if isinstance(tr.get("rtf"), (int, float)):
            note += f", RTF {tr['rtf']:.2f}"
    add("transcribe", labels["transcribe"], "done" if (d / "transcript.json").is_file() else "missing",
        ["transcript.json"], note)

    # diarize
    if (d / "diarization.json").is_file():
        diar = read_json_cached(d / "diarization.json")
        spk = diar.get("speakers") if isinstance(diar, dict) else None
        base, note = "done", f"{len(spk)} speakers" if isinstance(spk, list) else None
    elif (d / "words.json").is_file():
        base = "skipped"
        note = NO_HF_NOTE if not hf_key else "Speakers not labelled: HF_TOKEN is now set, re-run diarize"
    else:
        base, note = "missing", None
    add("diarize", labels["diarize"], base, ["diarization.json", "words.json"], note)

    # sentences
    sents = _sentences(d)
    add("sentences", labels["sentences"], "done" if (d / "sentences.json").is_file() else "missing",
        ["sentences.json"], f"{len(sents)} sentences" if sents else None)

    # select
    note = None
    if (d / "candidates.json").is_file():
        note = f"{len(cands)} candidates"
        spent = cost_usd(d)
        if spent:
            note += f", ${spent:.2f} spent"
    add("select", labels["select"], "done" if (d / "candidates.json").is_file() else "missing",
        ["candidates.json", "review.md", *_dir_files(d, "selection")], note)

    # reframe / render (per clip)
    rf = [reframe_state(d, c) for c in live]
    add("reframe", labels["reframe"], _aggregate(rf), _dir_files(d, "reframe"), _counts_note(rf, "reframed"))
    rd = [render_state(d, c) for c in live]
    add("render", labels["render"], _aggregate(rd), _dir_files(d, "renders") + _dir_files(d, "captions"),
        _counts_note(rd, "rendered"))
    return stages


def _source_rels(d: Path, src: Path | None) -> list[str]:
    """Master file(s) inside the job folder (source.<ext>)."""
    rels = sorted(p.name for p in d.glob("source.*") if p.is_file())
    if src is not None and src.resolve().parent == d.resolve() and src.name not in rels:
        rels.append(src.name)
    return rels


# ---------------------------------------------------------------- job summary / detail

def is_listed(d: Path, runs: list[Run]) -> bool:
    name = d.name
    if name.startswith((".", "_")) or not JOB_ID.fullmatch(name) or not d.is_dir():
        return False
    return (d / "meta.json").is_file() or bool(runs)


def _created(d: Path) -> str:
    st = d.stat()
    return iso(getattr(st, "st_birthtime", st.st_ctime))


def _updated(d: Path) -> str:
    newest = d.stat().st_mtime
    for dirpath, dirnames, filenames in os.walk(d):
        if Path(dirpath) == d:
            dirnames[:] = [n for n in dirnames if n != "ui"]
        for name in filenames:
            try:
                newest = max(newest, os.stat(os.path.join(dirpath, name)).st_mtime)
            except OSError:
                continue
    return iso(newest)


def clip_counts(d: Path, cands: list[dict[str, Any]]) -> dict[str, int]:
    live = [c for c in cands if c.get("approved") is not False]
    rstates = [render_state(d, c) for c in live]
    return {"candidates": len(cands),
            "approved": sum(c.get("approved") is True for c in cands),
            "rejected": sum(c.get("approved") is False for c in cands),
            "pending": sum(c.get("approved") is None for c in cands),
            "reframed": sum(reframe_state(d, c) == "done" for c in live),
            "rendered": sum(s in ("done", "failed") for s in rstates),
            "failed_checks": sum(s == "failed" for s in rstates)}


def cost_usd(d: Path) -> float:
    """Total spent on this job: the sum of selection/cost_history.jsonl (one line per paid run). cost.json only
    holds the latest run, so it is the fallback for jobs selected before the history existed."""
    hist = d / "selection" / "cost_history.jsonl"
    if hist.is_file():
        total = 0.0
        for line in hist.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                val = json.loads(line).get("total_usd")
            except (ValueError, AttributeError):
                continue
            if isinstance(val, (int, float)):
                total += float(val)
        return round(total, 4)
    cost = read_json_cached(d / "selection" / "cost.json")
    val = cost.get("total_usd") if isinstance(cost, dict) else None
    return float(val) if isinstance(val, (int, float)) else 0.0


def job_summary(d: Path, job_id: str, runs: list[Run], hf_key: bool) -> dict[str, Any]:
    meta = read_json_cached(d / "meta.json")
    meta = meta if isinstance(meta, dict) else {}
    probe = read_json_cached(d / "probe.json")
    probe = probe if isinstance(probe, dict) else {}
    stages = compute_stages(d, job_id, runs, hf_key)
    ingested = (d / "meta.json").is_file() and (d / "probe.json").is_file()
    run_source = next((r.get("params", {}).get("source") for r in runs if r.get("params", {}).get("source")), None)
    warnings = [str(w) for w in meta.get("warnings") or []]
    if stages[2]["state"] == "skipped" and not hf_key:
        warnings.append(NO_HF_WARNING)
    num = (int, float)
    return {
        "id": job_id,
        "title": meta.get("title") or job_id,
        "channel": meta.get("channel"),
        "source": meta.get("source") or run_source or "",
        "duration": meta.get("duration") if isinstance(meta.get("duration"), num)
        else probe.get("duration") if isinstance(probe.get("duration"), num) else None,
        "height": meta.get("height") if isinstance(meta.get("height"), int)
        else probe.get("height") if isinstance(probe.get("height"), int) else None,
        "fps": probe.get("fps") if isinstance(probe.get("fps"), num) else None,
        "created": _created(d),
        "updated": _updated(d),
        "thumbnail_url": f"/api/jobs/{job_id}/thumbnail" if ingested and source_path(d, meta) else None,
        "stages": stages,
        "clips": clip_counts(d, load_candidates(d)),
        "cost_usd": cost_usd(d),
        "active_run": active_run(runs),
        "warnings": warnings,
    }


def job_detail(d: Path, job_id: str, runs: list[Run], hf_key: bool) -> dict[str, Any]:
    out = job_summary(d, job_id, runs, hf_key)
    meta = read_json_cached(d / "meta.json")
    probe = read_json_cached(d / "probe.json")
    heat = read_json_cached(d / "heatmap.json")
    chapters = read_json_cached(d / "chapters.json")
    info = read_json_cached(d / "info.json")
    diar = read_json_cached(d / "diarization.json")
    meta = meta if isinstance(meta, dict) else None
    probe = probe if isinstance(probe, dict) else None
    src = source_path(d, meta)
    source_media = None
    if src is not None:
        proxy = d / "ui" / "source_proxy.mp4"
        playable = src.suffix.lower() in PLAYABLE_EXT and str((probe or {}).get("vcodec", "")).lower() in PLAYABLE_CODECS
        source_media = {"url": f"/media/{job_id}/source", "playable_hint": playable,
                        "proxy_url": media_url(job_id, "ui/source_proxy.mp4") if proxy.is_file() else None}
    info_out = None
    if isinstance(info, dict):
        info_out = {k: info[k] for k in ("webpage_url", "upload_date", "view_count", "thumbnail")
                    if info.get(k) is not None}
    speakers = []
    if isinstance(diar, dict) and isinstance(diar.get("speakers"), list):
        speakers = [{"id": str(s.get("id")), "seconds": s.get("seconds", 0), "share": s.get("share", 0)}
                    for s in diar["speakers"] if isinstance(s, dict)]
    out.update({
        "meta": meta, "probe": probe,
        "heatmap": [h for h in heat if isinstance(h, dict)] if isinstance(heat, list) else [],
        "chapters": [c for c in chapters if isinstance(c, dict)] if isinstance(chapters, list) else [],
        "source_media": source_media, "info": info_out, "speakers": speakers,
    })
    return out


# ---------------------------------------------------------------- transcript / selection / clips

SENTENCE_KEYS = ("i", "start", "end", "speaker", "text", "heat", "loud_z")


def transcript(d: Path) -> dict[str, Any]:
    tr = read_json_cached(d / "transcript.json")
    tr = tr if isinstance(tr, dict) else {}
    words = read_json_cached(d / "words.json")
    sents = _sentences(d)
    if sents:
        out = []
        for s in sents:
            row = {k: s.get(k) for k in SENTENCE_KEYS}
            row["loud_z"] = s.get("loud_z") if isinstance(s.get("loud_z"), (int, float)) else 0.0
            for k in ("pause_before", "pause_after"):
                if isinstance(s.get(k), (int, float)):
                    row[k] = s[k]
            out.append(row)
    elif isinstance(tr.get("segments"), list):
        out = [{"i": i, "start": s.get("start"), "end": s.get("end"), "speaker": s.get("speaker"),
                "text": str(s.get("text", "")).strip(), "heat": None, "loud_z": 0.0}
               for i, s in enumerate(tr["segments"]) if isinstance(s, dict)]
    else:
        raise ApiError(404, "not_found", "no transcript yet: run the transcribe stage")
    if isinstance(words, dict) and isinstance(words.get("words"), list):
        word_count = len(words["words"])
    else:
        word_count = len(tr["words"]) if isinstance(tr.get("words"), list) else 0
    lang = tr.get("language") or (words.get("language") if isinstance(words, dict) else None)
    model = tr.get("model") or (words.get("asr_model") if isinstance(words, dict) else None)
    return {"language": lang, "model": model, "sentences": out, "word_count": word_count}


def _clip_text(sents: list[dict[str, Any]], cand: dict[str, Any]) -> str:
    a, b = cand.get("start_sentence"), cand.get("end_sentence")
    if not (isinstance(a, int) and isinstance(b, int)) or not sents:
        return ""
    parts = [str(s.get("text", "")) for s in sents[max(a, 0): b + 1]]
    k = cand.get("start_word_offset") or 0
    if parts and isinstance(k, int) and k > 0:
        parts[0] = " ".join(parts[0].split()[k:])
    return " ".join(p for p in parts if p).strip()


def _fresh_preview(preview: Path, plan: Path) -> bool:
    """A reframe preview is written right after its plan; a plan rewritten later (clip edits, slicing) makes it
    outdated, so it is not offered."""
    try:
        return preview.stat().st_mtime >= plan.stat().st_mtime
    except OSError:
        return False


def candidate_view(d: Path, job_id: str, cand: dict[str, Any], sents: list[dict[str, Any]],
                   active: Run | None) -> dict[str, Any]:
    """A candidates.json entry plus the server-added fields (text, reframe, render)."""
    cid = cand["id"]
    plan_path = d / "reframe" / f"{cid}.json"
    preview = d / "reframe" / f"{cid}_preview.mp4"
    plan = read_json_cached(plan_path)
    layouts: list[str] = []
    for shot in (plan.get("shots") or []) if isinstance(plan, dict) else []:
        lay = shot.get("layout") if isinstance(shot, dict) else None
        if isinstance(lay, str) and lay not in layouts:
            layouts.append(lay)
    video = d / "renders" / f"{cid}.mp4"
    captions = d / "captions" / f"{cid}.ass"
    out = dict(cand)
    out["text"] = _clip_text(sents, cand)
    out["reframe"] = {
        "state": _clip_run_state("reframe", cid, active) or reframe_state(d, cand),
        "url": media_url(job_id, f"reframe/{cid}.json") if plan_path.is_file() else None,
        "preview_url": media_url(job_id, f"reframe/{cid}_preview.mp4") if _fresh_preview(preview, plan_path) else None,
        "qa": plan.get("qa") if isinstance(plan, dict) and isinstance(plan.get("qa"), dict) else None,
        "layouts": layouts,
    }
    has_video = video.is_file()
    out["render"] = {
        "state": _clip_run_state("render", cid, active) or render_state(d, cand),
        "video_url": media_url(job_id, f"renders/{cid}.mp4") if has_video else None,
        "download_url": media_url(job_id, f"renders/{cid}.mp4") + "?download=1" if has_video else None,
        "poster_url": f"/api/jobs/{job_id}/clips/{cid}/poster" if has_video else None,
        "report": render_report(d, cid),
        "captions_url": media_url(job_id, f"captions/{cid}.ass") if captions.is_file() else None,
    }
    return out


def _judge_rejected(d: Path, sents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    judged = read_json_cached(d / "selection" / "judged.json")
    out = []
    for c in judged if isinstance(judged, list) else []:
        if not isinstance(c, dict):
            continue
        j = c.get("judge") if isinstance(c.get("judge"), dict) else {}
        if j.get("verdict") == "keep":
            continue
        a = j.get("start_sentence", c.get("start_sentence"))
        b = j.get("end_sentence", c.get("end_sentence"))
        start = sents[a]["start"] if isinstance(a, int) and 0 <= a < len(sents) else None
        end = sents[b]["end"] if isinstance(b, int) and 0 <= b < len(sents) else None
        overall = j.get("overall")
        out.append({"id": str(c.get("id", "")), "title": str(j.get("title") or c.get("title") or ""),
                    "start_sentence": a, "end_sentence": b, "start": start, "end": end,
                    "overall": overall if isinstance(overall, (int, float)) else None,
                    "reason": j.get("reason") or c.get("judge_error") or None,
                    "source": str(c.get("source", ""))})
    return out


def selection(d: Path, job_id: str, runs: list[Run]) -> dict[str, Any]:
    sents = _sentences(d)
    active = active_run(runs)
    cost = read_json_cached(d / "selection" / "cost.json")
    review = d / "review.md"
    return {
        "candidates": [candidate_view(d, job_id, c, sents, active) for c in load_candidates(d)],
        "rejected_by_judge": _judge_rejected(d, sents),
        "cost": cost if isinstance(cost, dict) else None,
        "review_md": review.read_text(encoding="utf-8", errors="replace") if review.is_file() else None,
    }


def candidate_lock(d: Path) -> threading.Lock:
    """Serialises every read-modify-write of one job's candidates.json (approve/reject, clip edits)."""
    key = str(d.resolve())
    with _candidate_locks_guard:
        return _candidate_locks.setdefault(key, threading.Lock())


def set_approved(d: Path, job_id: str, cid: str, approved: bool | None, runs: list[Run]) -> dict[str, Any]:
    """Set `approved` on one candidate; atomic rewrite of candidates.json (tmp + replace)."""
    with candidate_lock(d):
        data = read_json(d / "candidates.json")
        if not isinstance(data, list):
            raise ApiError(404, "not_found", "no candidates.json yet: run the select stage")
        cand = next((c for c in data if isinstance(c, dict) and c.get("id") == cid), None)
        if cand is None:
            raise ApiError(404, "not_found", f"clip {cid} is not in candidates.json")
        cand["approved"] = approved
        write_json_atomic(d / "candidates.json", data)
    return candidate_view(d, job_id, cand, _sentences(d), active_run(runs))


def reframe_plan(d: Path, cid: str) -> dict[str, Any]:
    plan = read_json_cached(d / "reframe" / f"{cid}.json")
    if not isinstance(plan, dict):
        raise ApiError(404, "not_found", f"no reframe plan for clip {cid}")
    return plan


def captions(d: Path, job_id: str, cid: str) -> dict[str, Any]:
    path = d / "captions" / f"{cid}.ass"
    if not path.is_file():
        raise ApiError(404, "not_found", f"no captions for clip {cid}")
    return {"events": parse_ass(path.read_text(encoding="utf-8-sig", errors="replace")),
            "url": media_url(job_id, f"captions/{cid}.ass")}


def files(d: Path, job_id: str) -> list[dict[str, Any]]:
    """Every file in the job folder (recursive) except the UI cache `ui/`, sorted by path."""
    root = d.resolve()
    rels: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        if here == root:
            dirnames[:] = [n for n in dirnames if n != "ui"]
        dirnames[:] = [n for n in dirnames if not n.startswith(".")]
        for name in filenames:
            p = here / name
            if name.startswith(".") or not p.resolve().is_relative_to(root):
                continue
            rels.append(p.relative_to(root).as_posix())
    return _entries(root, job_id, sorted(rels))
