"""Runs: queue (one process at a time), commands, exit codes, logs, SSE, cancel (process tree), PAID guard,
crash recovery, job creation. Every clipper/*.py here is the fake script from conftest.py."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import runner as runner_mod
from server.app import create_app

from .helpers import BASE_URL, JOB, calls, set_fake, wait_run

RUN_KEYS = {"id", "job_id", "action", "params", "state", "created", "started", "ended", "steps", "current_step",
            "log_url", "stream_url", "error"}


def start(client: TestClient, body: dict, job: str = JOB) -> dict:
    r = client.post(f"/api/jobs/{job}/runs", json=body)
    assert r.status_code == 202, r.text
    return r.json()


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True,
                             check=False).stdout
        return str(pid) in out
    try:
        import os
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def test_simple_run_done_with_log(client: TestClient, root: Path, job_dir: Path) -> None:
    info = start(client, {"action": "sentences"})
    assert set(info) == RUN_KEYS
    assert info["id"].startswith("r") and info["action"] == "sentences" and info["job_id"] == JOB
    assert info["log_url"] == f"/api/runs/{info['id']}/log" and info["stream_url"] == f"/api/runs/{info['id']}/stream"
    done = wait_run(client, info["id"])
    assert done["state"] == "done" and done["error"] is None and done["current_step"] is None
    step = done["steps"][0]
    assert step["name"] == "sentences" and step["state"] == "done" and step["exit_code"] == 0
    assert step["command"][0] == sys.executable and step["command"][1:4] == ["-W", "ignore", "clipper/sentences.py"]
    # the fixture job already has clips, so sentences keeps its numbering and only relabels speakers
    assert step["command"][4:] == ["--id", JOB, "--relabel-only"]
    assert step["started"] and step["ended"] and done["started"] and done["ended"]
    log = client.get(f"/api/runs/{info['id']}/log").json()
    assert log["done"] is True and log["offset"] == len(log["text"].encode("utf-8"))
    text = log["text"]
    assert text.startswith(f"$ {' '.join(step['command'])}\n")
    assert "sentences.py start ünïcødé" in text and "to stderr" in text          # merged + utf-8
    assert "[exit 0 in " in text
    assert (job_dir / "runs" / f"{info['id']}.json").is_file() and (job_dir / "runs" / f"{info['id']}.log").is_file()
    persisted = json.loads((job_dir / "runs" / f"{info['id']}.json").read_text(encoding="utf-8"))
    assert persisted == done


def test_log_offset_paging(client: TestClient) -> None:
    info = wait_run(client, start(client, {"action": "sentences"})["id"])
    full = client.get(f"/api/runs/{info['id']}/log").json()["text"]
    part = client.get(f"/api/runs/{info['id']}/log?offset=5").json()
    assert part["text"] == full.encode("utf-8")[5:].decode("utf-8", errors="replace")
    end = client.get(f"/api/runs/{info['id']}/log?offset=999999").json()
    assert end["text"] == "" and end["done"] is True
    assert client.get(f"/api/runs/{info['id']}/log?offset=-1").status_code == 422


def test_failed_exit_code(client: TestClient, root: Path) -> None:
    set_fake(root, **{"sentences.py": {"exit": 1}})
    done = wait_run(client, start(client, {"action": "sentences"})["id"])
    assert done["state"] == "failed" and done["error"] == "sentences failed (exit 1)"
    assert done["steps"][0]["state"] == "failed" and done["steps"][0]["exit_code"] == 1
    job = client.get(f"/api/jobs/{JOB}").json()
    assert next(s for s in job["stages"] if s["key"] == "sentences")["state"] == "done"   # output still exists


def test_diarize_exit_2_is_done(client: TestClient, root: Path) -> None:
    set_fake(root, **{"diarize.py": {"exit": 2}})
    done = wait_run(client, start(client, {"action": "diarize", "speakers": 2})["id"])
    assert done["state"] == "done" and done["steps"][0]["exit_code"] == 2
    assert done["steps"][0]["command"][-2:] == ["--speakers", "2"]
    assert "done with warning" in client.get(f"/api/runs/{done['id']}/log").json()["text"]


def test_diarize_then_relabels_sentences(client: TestClient) -> None:
    """Re-running diarize copies the new speaker labels into sentences.json without renumbering it."""
    done = wait_run(client, start(client, {"action": "diarize"})["id"])
    assert done["state"] == "done" and [s["name"] for s in done["steps"]] == ["diarize", "sentences"]
    assert done["steps"][1]["state"] == "done" and done["steps"][1]["command"][-1] == "--relabel-only"


def test_prepare_skips_done_stages_unless_forced(client: TestClient, root: Path) -> None:
    done = wait_run(client, start(client, {"action": "prepare"})["id"])
    assert [(s["name"], s["state"]) for s in done["steps"]] == [
        ("ingest", "skipped"), ("transcribe", "skipped"), ("diarize", "skipped"), ("sentences", "skipped")]
    assert calls(root) == []
    forced = wait_run(client, start(client, {"action": "prepare", "force": True, "language": "de"})["id"])
    assert [s["state"] for s in forced["steps"]] == ["done"] * 4
    by_script = {c["script"]: c["argv"] for c in calls(root)}
    assert by_script["ingest.py"] == ["https://www.youtube.com/watch?v=ocGJWc2F1Yk", "--id", JOB]
    assert by_script["transcribe.py"] == ["--id", JOB, "--language", "de"]


def test_prepare_retries_diarize_when_hf_token_present(client: TestClient, root: Path) -> None:
    (root / ".env").write_text("HF_TOKEN=hf_x\n")
    done = wait_run(client, start(client, {"action": "prepare"})["id"])
    assert [s["state"] for s in done["steps"]] == ["skipped", "skipped", "done", "skipped"]


def test_step_failure_cancels_rest(client: TestClient, root: Path, job_dir: Path) -> None:
    (job_dir / "transcript.json").unlink()
    set_fake(root, **{"transcribe.py": {"exit": 3}})
    done = wait_run(client, start(client, {"action": "prepare"})["id"])
    assert [s["state"] for s in done["steps"]] == ["skipped", "failed", "cancelled", "cancelled"]
    assert done["state"] == "failed" and "transcribe" in done["error"]
    stages = {s["key"]: s["state"] for s in client.get(f"/api/jobs/{JOB}").json()["stages"]}
    assert stages["transcribe"] == "failed"


def test_one_process_at_a_time_and_busy(client: TestClient, root: Path) -> None:
    other = root / "data" / "jobs" / "second"
    other.mkdir()
    (other / "meta.json").write_text("{}")
    set_fake(root, **{"sentences.py": {"sleep": 1.5}})
    a = start(client, {"action": "sentences"})
    b = start(client, {"action": "sentences"}, job="second")
    r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "sentences"})
    assert r.status_code == 409 and r.json()["error"] == "busy"
    wait_run(client, a["id"], states=("running",))
    queue = client.app.state.clipper.runner.queue_info()       # type: ignore[attr-defined]
    assert queue["running"]["id"] == a["id"] and [q["id"] for q in queue["queued"]] == [b["id"]]
    assert client.get("/api/jobs/second").json()["active_run"]["state"] == "queued"
    a, b = wait_run(client, a["id"]), wait_run(client, b["id"])
    assert a["state"] == b["state"] == "done"
    assert b["started"] >= a["ended"]                        # strictly sequential
    runs = client.get("/api/runs").json()
    assert [r["id"] for r in runs[:2]] == [b["id"], a["id"]]
    assert [r["id"] for r in client.get(f"/api/runs?job={JOB}").json()] == [a["id"]]
    assert len(client.get("/api/runs?limit=1").json()) == 1
    assert client.get("/api/runs?job=BAD!").status_code == 400


def test_sse_finished_run(client: TestClient) -> None:
    info = wait_run(client, start(client, {"action": "sentences"})["id"])
    events: list[tuple[str, str]] = []
    with client.stream("GET", f"/api/runs/{info['id']}/stream") as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        event = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: ") and event:
                events.append((event, line[6:]))
    kinds = [e for e, _ in events]
    assert kinds[-1] == "end" and kinds.count("state") == 1
    logs = [d for e, d in events if e == "log"]
    assert logs[0].startswith("$ ") and "sentences.py start ünïcødé" in logs
    assert "progress 100%" in logs and not any("\r" in x for x in logs)
    assert any(x.startswith("[exit 0 in ") for x in logs)
    assert json.loads(next(d for e, d in events if e == "state"))["state"] == "done"
    assert json.loads(events[-1][1])["id"] == info["id"]


def test_sse_live_run(client: TestClient, root: Path) -> None:
    set_fake(root, **{"sentences.py": {"sleep": 0.6, "lines": 2}})
    info = start(client, {"action": "sentences"})
    states, logs = [], []
    with client.stream("GET", f"/api/runs/{info['id']}/stream") as r:
        event = None
        for line in r.iter_lines():
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                if event == "state":
                    states.append(json.loads(line[6:])["state"])
                elif event == "log":
                    logs.append(line[6:])
    assert states[-1] == "done" and states[0] in ("queued", "running")
    assert "line 1" in logs


def test_cancel_running_kills_process_tree(client: TestClient, root: Path) -> None:
    set_fake(root, **{"render.py": {"sleep": 60, "child": True}})
    info = start(client, {"action": "render", "clips": ["c03"]})
    deadline = time.monotonic() + 20
    while not (root / "child.pid").is_file() and time.monotonic() < deadline:
        time.sleep(0.05)
    child = int((root / "child.pid").read_text())
    assert pid_alive(child)
    t0 = time.monotonic()
    r = client.post(f"/api/runs/{info['id']}/cancel")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "cancelled" and body["steps"][0]["state"] == "cancelled"
    assert time.monotonic() - t0 < 10
    deadline = time.monotonic() + 5
    while pid_alive(child) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not pid_alive(child)                              # grandchild died with the tree
    assert "[cancelled]" in client.get(f"/api/runs/{info['id']}/log").json()["text"]
    r = client.post(f"/api/runs/{info['id']}/cancel")
    assert r.status_code == 409 and r.json()["error"] == "not_active"


def test_cancel_queued(client: TestClient, root: Path) -> None:
    other = root / "data" / "jobs" / "second"
    other.mkdir()
    set_fake(root, **{"sentences.py": {"sleep": 1.0}})
    a = start(client, {"action": "sentences"})
    b = start(client, {"action": "sentences"}, job="second")
    body = client.post(f"/api/runs/{b['id']}/cancel").json()
    assert body["state"] == "cancelled" and body["started"] is None
    assert wait_run(client, a["id"])["state"] == "done"
    assert client.get(f"/api/runs/{b['id']}").json()["state"] == "cancelled"
    assert client.post("/api/runs/r20200101-000000-0000/cancel").status_code == 404
    assert client.get("/api/runs/nope").status_code == 400


def test_paid_guard_select(client: TestClient, root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def no_spawn(*a: object, **k: object) -> None:
        raise AssertionError("a paid step must not be launched without confirm_paid")
    monkeypatch.setattr(runner_mod, "spawn", no_spawn)
    r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "select", "judge_model": "opus"})
    assert r.status_code == 402
    body = r.json()
    assert body["error"] == "paid_confirmation_required" and "~$0.12" in body["message"]
    est = body["estimate"]
    assert est == {"usd": 0.12, "proposal_calls": 2, "judge_calls": 8, "input_tokens": 12345, "judge_model": "opus",
                   "raw": est["raw"]}
    assert all("--dry-run" in c["argv"] for c in calls(root))          # only the free dry run ever ran
    assert client.post(f"/api/jobs/{JOB}/runs", json={"action": "select", "confirm_paid": False}).status_code == 402
    assert client.post(f"/api/jobs/{JOB}/runs", json={"action": "select", "confirm_paid": "true"}).status_code == 422
    assert client.get("/api/runs").json() == []


def test_paid_select_confirmed_runs_fake(client: TestClient, root: Path) -> None:
    done = wait_run(client, start(client, {"action": "select", "confirm_paid": True, "top": 3})["id"])
    assert done["state"] == "done"
    assert done["steps"][0]["command"][4:] == ["--id", JOB, "--top", "3", "--judge-model", "sonnet"]


def test_produce_needs_confirmation_only_without_candidates(client: TestClient, root: Path, job_dir: Path) -> None:
    done = wait_run(client, start(client, {"action": "produce"})["id"])     # candidates exist: no paid step
    assert [(s["name"], s["state"]) for s in done["steps"]] == [
        ("ingest", "skipped"), ("transcribe", "skipped"), ("diarize", "skipped"), ("sentences", "skipped"),
        ("select", "skipped"), ("reframe", "skipped"), ("render", "skipped")]
    (job_dir / "candidates.json").unlink()
    r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "produce"})
    assert r.status_code == 402 and r.json()["estimate"]["usd"] == 0.12
    assert not any(c["script"] == "select_clips.py" and "--dry-run" not in c["argv"] for c in calls(root))


def test_reframe_and_render_default_clips(client: TestClient, root: Path, job_dir: Path) -> None:
    plan = json.loads((job_dir / "reframe" / "c05.json").read_text(encoding="utf-8"))
    plan["cut_in"] += 1
    (job_dir / "reframe" / "c05.json").write_text(json.dumps(plan))
    (job_dir / "renders" / "c02.mp4").unlink()
    done = wait_run(client, start(client, {"action": "reframe", "preview": True})["id"])
    assert done["steps"][0]["command"][4:] == ["--id", JOB, "--clip", "c05", "--preview"]
    done = wait_run(client, start(client, {"action": "render", "fast": True})["id"])
    # c02 has no video; c05's plan was just rewritten, so its render is stale (plan newer than the mp4)
    assert done["steps"][0]["command"][4:] == ["--id", JOB, "--clip", "c02", "c05", "--fast"]
    forced = wait_run(client, start(client, {"action": "render", "force": True})["id"])
    assert forced["steps"][0]["command"][7:] == ["c02", "c03", "c05"]
    r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "render", "clips": ["c77"]})
    assert r.status_code == 400 and r.json()["error"] == "unknown_clip"
    r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "sentences", "clips": ["c02"]})
    assert r.status_code == 400 and r.json()["error"] == "bad_param"


def test_produce_renders_what_it_reframed(client: TestClient, job_dir: Path) -> None:
    plan = json.loads((job_dir / "reframe" / "c03.json").read_text(encoding="utf-8"))
    plan["cut_out"] += 1
    (job_dir / "reframe" / "c03.json").write_text(json.dumps(plan))
    done = wait_run(client, start(client, {"action": "produce"})["id"])
    by = {s["name"]: s for s in done["steps"]}
    assert by["reframe"]["command"][7:] == ["c03"] and by["render"]["command"][7:] == ["c03"]


def test_run_validation(client: TestClient) -> None:
    for body in ({"action": "nope"}, {"action": "select", "judge_model": "gpt"}, {"action": "render", "top": 0},
                 {"action": "render", "extra": 1}, {"action": "transcribe", "language": "EN; rm"}):
        r = client.post(f"/api/jobs/{JOB}/runs", json=body)
        assert r.status_code == 422 and r.json()["error"] == "invalid_request", body
    assert client.post("/api/jobs/missing/runs", json={"action": "sentences"}).status_code == 404


def test_proxy_run_real_ffmpeg(client: TestClient, job_dir: Path) -> None:
    done = wait_run(client, start(client, {"action": "proxy"})["id"], timeout=60)
    assert done["state"] == "done", client.get(f"/api/runs/{done['id']}/log").json()["text"]
    assert (job_dir / "ui" / "source_proxy.mp4").stat().st_size > 0
    assert not (job_dir / "ui" / "source_proxy.part.mp4").exists()
    detail = client.get(f"/api/jobs/{JOB}").json()
    assert detail["source_media"]["proxy_url"] == f"/media/{JOB}/ui/source_proxy.mp4"


def test_estimate_endpoint(client: TestClient, root: Path) -> None:
    r = client.get(f"/api/jobs/{JOB}/estimate?judge_model=haiku&top=5")
    assert r.status_code == 200 and r.json()["usd"] == 0.12 and r.json()["judge_model"] == "haiku"
    assert calls(root)[-1]["argv"] == ["--id", JOB, "--dry-run", "--judge-model", "haiku", "--top", "5"]
    assert client.get(f"/api/jobs/{JOB}/estimate?judge_model=gpt").json()["error"] == "bad_param"


def test_crash_recovery(root: Path, job_dir: Path) -> None:
    runs = job_dir / "runs"
    runs.mkdir()
    stale = {"id": "r20261117-090000-abcd", "job_id": JOB, "action": "prepare", "params": {}, "state": "running",
             "created": "2026-11-17T09:00:00.000Z", "started": "2026-11-17T09:00:00.000Z", "ended": None,
             "steps": [{"name": "ingest", "command": ["x"], "state": "done", "started": None, "ended": None,
                        "exit_code": 0},
                       {"name": "transcribe", "command": ["x"], "state": "running", "started": None, "ended": None,
                        "exit_code": None},
                       {"name": "diarize", "command": [], "state": "queued", "started": None, "ended": None,
                        "exit_code": None}],
             "current_step": 1, "log_url": "", "stream_url": "", "error": None}
    (runs / "r20261117-090000-abcd.json").write_text(json.dumps(stale))
    (runs / "r20261117-090000-abcd.log").write_text("$ x\n")
    with TestClient(create_app(root), base_url=BASE_URL) as c:
        info = c.get("/api/runs/r20261117-090000-abcd").json()
        assert info["state"] == "failed" and info["error"] == "server restarted" and info["current_step"] is None
        assert [s["state"] for s in info["steps"]] == ["done", "failed", "cancelled"]
        assert c.get(f"/api/jobs/{JOB}").json()["active_run"] is None
        assert start(c, {"action": "sentences"})["state"] in ("queued", "running")


def test_create_job_local_file(client: TestClient, root: Path, tmp_path: Path) -> None:
    src = tmp_path / "My Talk ü.mp4"
    src.write_bytes(b"fake")
    r = client.post("/api/jobs", json={"source": str(src), "speakers": 2, "allow_lower": True})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["job"]["id"] == "my-talk-u" and body["run"]["action"] == "prepare"
    assert body["job"]["source"] == str(src.resolve()) and body["job"]["active_run"]["id"] == body["run"]["id"]
    done = wait_run(client, body["run"]["id"])
    assert done["state"] == "done"
    argv = next(c["argv"] for c in calls(root) if c["script"] == "ingest.py")
    assert argv == [str(src.resolve()), "--id", "my-talk-u", "--allow-lower"]
    diar = next(c["argv"] for c in calls(root) if c["script"] == "diarize.py")
    assert diar == ["--id", "my-talk-u", "--speakers", "2"]
    assert "my-talk-u" in [j["id"] for j in client.get("/api/jobs").json()]   # listed via its run


def test_create_job_errors(client: TestClient, tmp_path: Path) -> None:
    r = client.post("/api/jobs", json={"source": "https://www.youtube.com/watch?v=ocGJWc2F1Yk", "id": JOB})
    assert r.status_code == 409 and r.json()["error"] == "exists"
    assert client.post("/api/jobs", json={"source": "not a thing"}).json()["error"] == "bad_source"
    assert client.post("/api/jobs", json={"source": "https://youtu.be/ocGJWc2F1Yk", "id": "Bad Id"}).json()[
        "error"] == "bad_id"
    assert client.post("/api/jobs", json={}).status_code == 422
    r = client.post("/api/jobs", json={"source": "https://youtu.be/ocGJWc2F1Yk"})
    assert r.status_code == 201 and r.json()["job"]["id"] == "ocgjwc2f1yk"
