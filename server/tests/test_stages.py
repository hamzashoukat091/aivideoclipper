"""Stage status rules (docs/UI_SPEC.md section 3): done/missing/stale/partial/skipped/failed/running/queued."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from server.jobs import compute_stages, selection

from .helpers import JOB


def states(d: Path, runs: list[dict[str, Any]] | None = None, hf: bool = False) -> dict[str, str]:
    return {s["key"]: s["state"] for s in compute_stages(d, JOB, runs or [], hf)}


def edit_json(path: Path, fn: Any) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    fn(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def run(state: str, steps: list[tuple[str, str]], rid: str = "r20261117-100000-aaaa") -> dict[str, Any]:
    return {"id": rid, "job_id": JOB, "action": "x", "params": {}, "state": state, "created": rid,
            "steps": [{"name": n, "command": [], "state": s} for n, s in steps]}


def test_all_done(job_dir: Path) -> None:
    assert states(job_dir) == {"ingest": "done", "transcribe": "done", "diarize": "skipped", "sentences": "done",
                               "select": "done", "reframe": "done", "render": "done"}


def test_missing_everything(root: Path) -> None:
    d = root / "data" / "jobs" / "empty"
    d.mkdir()
    assert set(states(d).values()) == {"missing"}


def test_ingest_needs_meta_and_probe(job_dir: Path) -> None:
    (job_dir / "probe.json").unlink()
    assert states(job_dir)["ingest"] == "missing"


def test_diarize_done_skipped_missing(job_dir: Path) -> None:
    (job_dir / "diarization.json").write_text(json.dumps({"speakers": [{"id": "S0", "seconds": 3, "share": 1}]}))
    assert states(job_dir)["diarize"] == "done"
    (job_dir / "diarization.json").unlink()
    assert states(job_dir)["diarize"] == "skipped"
    (job_dir / "words.json").unlink()
    assert states(job_dir)["diarize"] == "missing"


def test_reframe_stale_partial_missing(job_dir: Path) -> None:
    edit_json(job_dir / "reframe" / "c03.json", lambda p: p.update(cut_in=p["cut_in"] + 0.5))
    assert states(job_dir)["reframe"] == "stale"
    edit_json(job_dir / "reframe" / "c03.json", lambda p: p.update(cut_in=p["cut_in"] - 0.495))  # within 0.01 s
    assert states(job_dir)["reframe"] == "done"
    (job_dir / "reframe" / "c05.json").unlink()
    assert states(job_dir)["reframe"] == "partial"
    for f in (job_dir / "reframe").glob("*.json"):
        f.unlink()
    assert states(job_dir)["reframe"] == "missing"


def test_rejected_clips_are_ignored(job_dir: Path) -> None:
    (job_dir / "reframe" / "c05.json").unlink()
    (job_dir / "renders" / "c05.mp4").unlink()
    assert states(job_dir)["reframe"] == "partial"
    edit_json(job_dir / "candidates.json", lambda cs: [c.update(approved=False) for c in cs if c["id"] == "c05"])
    assert states(job_dir)["reframe"] == "done"
    assert states(job_dir)["render"] == "done"


def test_render_failed_stale_partial(job_dir: Path) -> None:
    edit_json(job_dir / "renders" / "c02.report.json", lambda r: r["checks"].update({"1080x1920": False}))
    assert states(job_dir)["render"] == "failed"
    sel = selection(job_dir, JOB, [])
    assert sel["candidates"][0]["render"]["state"] == "failed"
    edit_json(job_dir / "renders" / "c02.report.json", lambda r: r["checks"].update({"1080x1920": True}))
    edit_json(job_dir / "renders" / "c02.report.json", lambda r: r.update(source_range=[1.0, 2.0]))
    assert states(job_dir)["render"] == "stale"
    edit_json(job_dir / "renders" / "c02.report.json", lambda r: r.update(source_range=[100.465, 118.915]))
    (job_dir / "renders" / "c03.mp4").unlink()                  # report without video = missing for that clip
    assert states(job_dir)["render"] == "partial"


def test_running_and_queued_override(job_dir: Path) -> None:
    (job_dir / "transcript.json").unlink()
    active = run("running", [("ingest", "skipped"), ("transcribe", "running"), ("diarize", "queued"),
                             ("sentences", "queued")])
    s = states(job_dir, [active])
    assert s["ingest"] == "done" and s["transcribe"] == "running"
    assert s["diarize"] == "queued"                         # skipped (not done) -> queued shows
    assert s["sentences"] == "done"                         # done stays done while merely queued
    queued = run("queued", [("render", "queued")])
    (job_dir / "renders" / "c02.mp4").unlink()
    assert states(job_dir, [queued])["render"] == "queued"


def test_failed_when_last_run_failed_and_no_output(job_dir: Path) -> None:
    (job_dir / "sentences.json").unlink()
    newer = run("failed", [("sentences", "failed")], "r20261117-110000-bbbb")
    older = run("done", [("sentences", "done")], "r20261117-100000-aaaa")
    assert states(job_dir, [newer, older])["sentences"] == "failed"
    assert states(job_dir, [older, newer])["sentences"] == "missing"     # newest run succeeded
    (job_dir / "sentences.json").write_text("[]")
    assert states(job_dir, [newer, older])["sentences"] == "done"         # output exists -> not failed


def test_per_clip_running_state(job_dir: Path) -> None:
    active = run("running", [("reframe", "running")])
    active["steps"][0]["command"] = ["py", "clipper/reframe.py", "--id", JOB, "--clip", "c03"]
    sel = selection(job_dir, JOB, [active])
    by_id = {c["id"]: c["reframe"]["state"] for c in sel["candidates"]}
    assert by_id == {"c02": "done", "c03": "running", "c05": "done"}
