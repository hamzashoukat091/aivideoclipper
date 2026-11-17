"""Helpers shared by the server tests."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

BASE_URL = "http://127.0.0.1"
JOB = "demo"


def set_fake(root: Path, **scripts: dict[str, Any]) -> None:
    (root / "fake.json").write_text(json.dumps(scripts), encoding="utf-8")


def calls(root: Path) -> list[dict[str, Any]]:
    path = root / "calls.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def wait_run(client: TestClient, run_id: str, timeout: float = 30.0,
             states: tuple[str, ...] = ("done", "failed", "cancelled")) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        info = client.get(f"/api/runs/{run_id}").json()
        if info["state"] in states:
            return info
        time.sleep(0.05)
    raise AssertionError(f"run {run_id} did not reach {states} in {timeout}s: {info}")
