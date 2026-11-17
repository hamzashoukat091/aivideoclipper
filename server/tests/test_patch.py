"""PATCH /api/jobs/{id}/candidates/{cid}: approve/reject/undecide with an atomic rewrite of candidates.json."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from .helpers import JOB


def load(job_dir: Path) -> list[dict]:
    return json.loads((job_dir / "candidates.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("value", [True, False, None])
def test_patch_sets_value(client: TestClient, job_dir: Path, value: bool | None) -> None:
    before = load(job_dir)
    r = client.patch(f"/api/jobs/{JOB}/candidates/c03", json={"approved": value})
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "c03" and body["approved"] is value
    assert {"text", "reframe", "render"} <= set(body)
    after = load(job_dir)
    assert after[1]["approved"] is value
    for b, a in zip(before, after, strict=True):          # nothing else changed
        assert {k: v for k, v in b.items() if k != "approved"} == {k: v for k, v in a.items() if k != "approved"}
    assert sorted(p.name for p in job_dir.iterdir() if p.name.endswith(".tmp")) == []


def test_reject_updates_counts_and_stages(client: TestClient, job_dir: Path) -> None:
    client.patch(f"/api/jobs/{JOB}/candidates/c05", json={"approved": False})
    client.patch(f"/api/jobs/{JOB}/candidates/c02", json={"approved": True})
    clips = client.get(f"/api/jobs/{JOB}").json()["clips"]
    assert clips == {"candidates": 3, "approved": 1, "rejected": 1, "pending": 1, "reframed": 2, "rendered": 2,
                     "failed_checks": 0}


@pytest.mark.parametrize("body", [{}, {"approved": "yes"}, {"approved": 1}, {"approved": True, "x": 1}])
def test_patch_validation(client: TestClient, body: dict) -> None:
    r = client.patch(f"/api/jobs/{JOB}/candidates/c03", json=body)
    assert r.status_code == 422 and r.json()["error"] == "invalid_request" and r.json()["message"]


def test_patch_unknown_clip_and_ids(client: TestClient, root: Path) -> None:
    assert client.patch(f"/api/jobs/{JOB}/candidates/c99", json={"approved": True}).status_code == 404
    assert client.patch(f"/api/jobs/{JOB}/candidates/C!", json={"approved": True}).json()["error"] == "bad_id"
    (root / "data" / "jobs" / "bare").mkdir()
    assert client.patch("/api/jobs/bare/candidates/c01", json={"approved": True}).status_code == 404


def test_patch_busy_while_selecting(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    runner = client.app.state.clipper.runner        # type: ignore[attr-defined]
    monkeypatch.setattr(runner, "running_step", lambda job_id: "select")
    r = client.patch(f"/api/jobs/{JOB}/candidates/c03", json={"approved": True})
    assert r.status_code == 409 and r.json()["error"] == "busy"
