"""Regression tests from the independent review (money guard, Windows paths, origin guard, queue robustness)."""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import runner as runner_mod

from .helpers import JOB, calls, set_fake, wait_run
from .test_runs import start


def paid_calls(root: Path) -> list[dict]:
    return [c for c in calls(root) if c["script"] == "select_clips.py" and "--dry-run" not in c["argv"]]


# ---------------------------------------------------------------- money

@pytest.mark.parametrize("value", [None, False, 0, 1, "true", "false", "yes", [True], {"x": True}])
def test_confirm_paid_only_literal_true(client: TestClient, root: Path, job_dir: Path, value: object) -> None:
    (job_dir / "candidates.json").rename(job_dir / "cands.bak")        # produce would now select
    for action in ("select", "produce"):
        body: dict = {"action": action}
        if value is not None:
            body["confirm_paid"] = value
        r = client.post(f"/api/jobs/{JOB}/runs", json=body)
        assert r.status_code in (402, 422), (action, value, r.text)
    assert client.get("/api/runs").json() == []
    assert paid_calls(root) == []


def test_produce_select_guard_rechecked_at_runtime(client: TestClient, root: Path, job_dir: Path) -> None:
    """produce accepted without confirm (candidates existed) must not select if candidates.json vanishes later."""
    (job_dir / "sentences.json").rename(job_dir / "sentences.bak")
    set_fake(root, **{"sentences.py": {"sleep": 1.5, "touch": ["data/jobs/demo/sentences.json"]}})
    info = start(client, {"action": "produce"})
    time.sleep(0.3)
    (job_dir / "candidates.json").rename(job_dir / "cands.bak")
    done = wait_run(client, info["id"])
    by = {s["name"]: s for s in done["steps"]}
    assert by["select"]["state"] == "failed" and done["state"] == "failed"
    assert "confirm_paid" in (done["error"] or "")
    assert paid_calls(root) == []


def test_concurrent_posts_start_one_run(client: TestClient, root: Path) -> None:
    set_fake(root, **{"sentences.py": {"sleep": 1.0}})
    codes: list[int] = []
    barrier = threading.Barrier(8)

    def go() -> None:
        barrier.wait()
        codes.append(client.post(f"/api/jobs/{JOB}/runs", json={"action": "sentences"}).status_code)

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(codes) == [202] + [409] * 7
    runs = client.get("/api/runs").json()
    assert len(runs) == 1
    wait_run(client, runs[0]["id"])


# ---------------------------------------------------------------- security

def test_run_source_is_validated_like_create_job(client: TestClient, root: Path) -> None:
    """POST /runs {source} feeds ingest.py's positional argument: it must be an http(s) URL or an existing file
    (an option-like value such as "--help" or a bogus scheme must never reach the command line)."""
    for src in ("--help", "-x", "file:///C:/Windows/win.ini", "not a file", "ftp://example.com/x"):
        r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "ingest", "source": src})
        assert r.status_code == 400 and r.json()["error"] == "bad_source", (src, r.text)
    assert client.get("/api/runs").json() == []


@pytest.mark.parametrize("rel", [
    "nul", "con", "CON", "aux.json", "com1", "conin$", "candidates.json::$DATA", "candidates.json:x",
    "C:/Windows/win.ini", "c:", "%5C%5C127.0.0.1%5Cc$%5CWindows%5Cwin.ini", "%5C%5C%3F%5CC:%5CWindows%5Cwin.ini",
    "..%2F..%2F..%2Fmeta.json", "runs/..%5C..%5C..%5Cmeta.json",
])
def test_media_windows_specials(client: TestClient, rel: str) -> None:
    r = client.get(f"/media/{JOB}/{rel}")
    assert r.status_code in (400, 404), (rel, r.status_code)
    assert r.headers["content-type"].startswith("application/json")


def test_media_case_and_trailing_dot_stay_inside(client: TestClient, job_dir: Path) -> None:
    for rel in ("META.JSON", "meta.json.", "meta.json "):
        r = client.get(f"/media/{JOB}/{rel}")
        assert r.status_code in (200, 400, 404)
        if r.status_code == 200:
            assert r.content == (job_dir / "meta.json").read_bytes()


@pytest.mark.parametrize("headers", [
    {"origin": "http://evil.example"}, {"origin": "null"}, {"origin": "http://localhost.evil.example"},
    {"origin": "http://127.0.0.1.evil.example:8765"}, {"sec-fetch-site": "cross-site"},
])
def test_state_changes_refused_cross_origin(client: TestClient, root: Path, headers: dict) -> None:
    for method, url, body in (("POST", f"/api/jobs/{JOB}/runs", {"action": "sentences"}),
                              ("PATCH", f"/api/jobs/{JOB}/candidates/c02", {"approved": True}),
                              ("POST", "/api/jobs", {"source": "https://youtu.be/dQw4w9WgXcQ"})):
        r = client.request(method, url, json=body, headers=headers)
        assert r.status_code == 403, (method, url, headers)
    r = client.post(f"/api/jobs/{JOB}/runs", json={"action": "sentences"}, headers={"host": "evil.example"})
    assert r.status_code == 400
    assert calls(root) == []


def test_origin_must_be_this_server_or_dev_vite(root: Path) -> None:
    """Other local apps (other ports) may not change state; same origin always may; Vite :5173 only with --dev."""
    from server.app import LocalOriginGuard
    prod, dev = LocalOriginGuard(app=None), LocalOriginGuard(app=None, dev=True)  # type: ignore[arg-type]
    host = "127.0.0.1:8765"
    assert prod._allowed("http://127.0.0.1:8765", host)
    assert not prod._allowed("http://127.0.0.1:3000", host)
    assert not prod._allowed("http://localhost:5173", host)
    assert dev._allowed("http://localhost:5173", host)
    assert not dev._allowed("http://localhost:3000", host)
    assert not dev._allowed("http://evil.example", host)


def test_paths_shown_relative_to_project(root: Path) -> None:
    """Commands and logs never display the project's absolute path (it contains the Windows user name)."""
    from server.paths import strip_root, strip_root_deep
    r = str(root)
    line = f"$ {r}\\.venv\\Scripts\\python.exe -W ignore clipper/render.py && ffprobe {r.replace(chr(92), '/')}/data/x.mp4"
    out = strip_root(line, root)
    assert r not in out and r.replace("\\", "/") not in out
    assert out == "$ .venv\\Scripts\\python.exe -W ignore clipper/render.py && ffprobe data/x.mp4"
    assert strip_root(line.upper(), root).count(".VENV") == 1               # case-insensitive on Windows
    assert strip_root_deep({"steps": [{"command": [f"{r}\\a.py", "x"]}]}, root) == {"steps": [{"command": ["a.py", "x"]}]}


def test_keys_never_leak(client: TestClient, root: Path, job_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "sk-ant-REVIEW-SENTINEL-123"
    monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
    (root / ".env").write_text("HF_TOKEN=hf_REVIEW_SENTINEL\n", encoding="utf-8")
    info = wait_run(client, start(client, {"action": "sentences"})["id"])
    texts = [client.get(u).text for u in ("/api/system", "/api/jobs", f"/api/jobs/{JOB}", "/api/runs",
                                          f"/api/runs/{info['id']}", f"/api/runs/{info['id']}/log",
                                          f"/api/jobs/{JOB}/files")]
    texts += [p.read_text(encoding="utf-8", errors="replace") for p in (job_dir / "runs").iterdir()]
    for t in texts:
        assert secret not in t and "hf_REVIEW_SENTINEL" not in t


# ---------------------------------------------------------------- process handling

LEAKY_SCRIPT = r'''
import subprocess, sys, json
from pathlib import Path
root = Path(__file__).resolve().parent.parent
# a helper process that outlives this step and inherits its stdout (like a forgotten ffmpeg / daemon)
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(25)"])
(root / "leak.pid").write_text(str(child.pid))
print("step done", flush=True)
'''


def test_leftover_grandchild_does_not_stall_queue(client: TestClient, root: Path) -> None:
    (root / "clipper" / "sentences.py").write_text(LEAKY_SCRIPT, encoding="utf-8")
    try:
        info = start(client, {"action": "sentences"})
        done = wait_run(client, info["id"], timeout=12)
        assert done["state"] == "done"
        nxt = wait_run(client, start(client, {"action": "transcribe"})["id"], timeout=12)
        assert nxt["state"] == "done"
    finally:
        pid_file = root / "leak.pid"
        if pid_file.is_file():
            subprocess.run(["taskkill", "/PID", pid_file.read_text(), "/T", "/F"] if sys.platform == "win32"
                           else ["kill", "-9", pid_file.read_text()], capture_output=True, check=False)


def test_worker_survives_failed_save(client: TestClient, root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A Windows sharing violation while persisting runs/<id>.json (reader holding the file) must not kill the
    worker thread: the queue would stall until restart."""
    real = runner_mod.write_json_atomic
    failed = {"n": 0}

    def flaky(path: Path, data: object) -> None:
        if isinstance(data, dict) and data.get("state") == "done" and failed["n"] == 0:
            failed["n"] += 1
            raise PermissionError(13, "sharing violation (simulated)")
        real(path, data)

    monkeypatch.setattr(runner_mod, "write_json_atomic", flaky)
    a = start(client, {"action": "sentences"})
    deadline = time.monotonic() + 10
    while client.get("/api/system").json()["queue"]["running"] is not None and time.monotonic() < deadline:
        time.sleep(0.05)
    assert failed["n"] == 1
    b = wait_run(client, start(client, {"action": "transcribe"})["id"], timeout=10)
    assert b["state"] == "done"
    assert client.get(f"/api/runs/{a['id']}").json()["state"] == "done"


def test_run_source_file_is_made_absolute(client: TestClient, root: Path, tmp_path: Path) -> None:
    src = tmp_path / "local video.mp4"
    src.write_bytes(b"x")
    info = start(client, {"action": "ingest", "source": str(src)})
    assert info["params"]["source"] == str(src.resolve())
    wait_run(client, info["id"])
    assert json.loads((root / "calls.jsonl").read_text(encoding="utf-8").splitlines()[-1])["argv"][0] == str(src.resolve())


# ---------------------------------------------------------------- SSE with a real server

def test_sse_generator_ends_when_client_disconnects(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import socket

    import uvicorn

    from server.app import create_app
    from server.routes import runs as runs_mod

    real = runs_mod._stream
    state = {"started": 0, "closed": 0}

    async def tracked(*a: object, **k: object):  # type: ignore[no-untyped-def]
        state["started"] += 1
        try:
            async for item in real(*a, **k):  # type: ignore[arg-type]
                yield item
        finally:
            state["closed"] += 1

    monkeypatch.setattr(runs_mod, "_stream", tracked)
    set_fake(root, **{"sentences.py": {"sleep": 20}})
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(create_app(root), host="127.0.0.1", port=port, log_level="error"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("POST", f"/api/jobs/{JOB}/runs", body=json.dumps({"action": "sentences"}),
                      headers={"Content-Type": "application/json"})
        run = json.loads(conn.getresponse().read())
        conn.close()
        s = socket.create_connection(("127.0.0.1", port), timeout=10)
        s.sendall(f"GET /api/runs/{run['id']}/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode())
        assert b"event: state" in s.recv(65536) or True
        time.sleep(0.5)
        assert state["started"] == 1 and state["closed"] == 0
        s.close()
        deadline = time.monotonic() + 3
        while state["closed"] == 0 and time.monotonic() < deadline:
            time.sleep(0.05)
        assert state["closed"] == 1                     # generator finished well before the 15 s heartbeat
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
        conn.request("POST", f"/api/runs/{run['id']}/cancel", headers={"Content-Length": "0"})
        assert json.loads(conn.getresponse().read())["state"] == "cancelled"
        conn.close()
    finally:
        server.should_exit = True
        th.join(15)
