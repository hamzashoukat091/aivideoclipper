"""Run queue: ONE pipeline process at a time (the stages are CPU-bound), persisted runs, live logs, cancel.

Runs live in data/jobs/<job>/runs/<run_id>.json (rewritten atomically on every change) with the merged
stdout+stderr in <run_id>.log. A worker thread executes queued runs in order; every step is a child process in
its own process group so cancel can kill the whole tree.
"""
from __future__ import annotations

import os
import secrets
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import IO, Any

from .actions import RunContext, StepError, StepPlan, plan
from .errors import ApiError
from .paths import (
    JOB_ID,
    RUN_ID,
    now_iso,
    read_json,
    strip_root_deep,
    write_json_atomic,
)

FINISHED = ("done", "failed", "cancelled")
IS_WINDOWS = os.name == "nt"
READER_GRACE_S = 5.0          # wait this long for the output pipe to close after the step's process exited


@dataclass
class Step:
    plan: StepPlan
    command: list[str] = field(default_factory=list)
    state: str = "queued"
    started: str | None = None
    ended: str | None = None
    exit_code: int | None = None

    def info(self) -> dict[str, Any]:
        return {"name": self.plan.name, "command": list(self.command), "state": self.state, "started": self.started,
                "ended": self.ended, "exit_code": self.exit_code}


@dataclass
class Run:
    id: str
    job_id: str
    action: str
    params: dict[str, Any]
    steps: list[Step]
    job_dir: Path
    state: str = "queued"
    created: str = field(default_factory=now_iso)
    started: str | None = None
    ended: str | None = None
    current_step: int | None = None
    error: str | None = None
    proc: subprocess.Popen[bytes] | None = None
    cancel_requested: bool = False

    @property
    def json_path(self) -> Path:
        return self.job_dir / "runs" / f"{self.id}.json"

    @property
    def log_path(self) -> Path:
        return self.job_dir / "runs" / f"{self.id}.log"

    def info(self) -> dict[str, Any]:
        """RunInfo for display and persistence. Commands are shown relative to the project folder (root =
        <root>/data/jobs/<id>); execution always uses the absolute command built at run time."""
        info = {"id": self.id, "job_id": self.job_id, "action": self.action, "params": dict(self.params),
                "state": self.state, "created": self.created, "started": self.started, "ended": self.ended,
                "steps": [s.info() for s in self.steps], "current_step": self.current_step,
                "log_url": f"/api/runs/{self.id}/log", "stream_url": f"/api/runs/{self.id}/stream",
                "error": self.error}
        return strip_root_deep(info, self.job_dir.parents[2])


def new_run_id() -> str:
    return f"r{datetime.now().strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"


def spawn(cmd: list[str], cwd: Path) -> subprocess.Popen[bytes]:
    """Start one step: own process group (so the tree can be killed), stdout+stderr merged, unbuffered UTF-8."""
    env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
    kwargs: dict[str, Any] = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if IS_WINDOWS
                              else {"start_new_session": True})
    return subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, bufsize=0, **kwargs)


def kill_tree(pid: int) -> None:
    """Kill a process and all of its children."""
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, stdin=subprocess.DEVNULL,
                       check=False)
    else:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


class Runner:
    def __init__(self, root: Path, jobs_dir: Path, hf_key: Callable[[], bool]) -> None:
        self.root = root
        self.jobs_dir = jobs_dir
        self._hf_key = hf_key
        self._lock = threading.RLock()
        self._wake = threading.Condition(self._lock)
        self._queue: deque[Run] = deque()
        self._current: Run | None = None
        self._runs: dict[str, Run] = {}            # runs created by this server process
        self._paths: dict[str, Path] = {}          # run id -> runs/<id>.json for older runs found on disk
        self._stopping = False
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        self.recover()
        self._stopping = False
        self._thread = threading.Thread(target=self._worker, name="clipper-runner", daemon=True)
        self._thread.start()

    def shutdown(self, timeout: float = 10.0) -> None:
        """Stop the worker; cancel queued runs and kill the running process (marked cancelled: server stopped)."""
        with self._lock:
            self._stopping = True
            while self._queue:
                run = self._queue.popleft()
                self._finish_unstarted(run, "cancelled", "server stopped")
            cur = self._current
            if cur is not None:
                cur.cancel_requested = True
                cur.error = "server stopped"
                if cur.proc is not None and cur.proc.poll() is None:
                    kill_tree(cur.proc.pid)
            self._wake.notify_all()
        if self._thread is not None:
            self._thread.join(timeout)

    def recover(self) -> int:
        """Mark runs left queued/running by a crashed or killed server as failed ("server restarted")."""
        fixed = 0
        for path in self._run_files():
            data = read_json(path)
            if not isinstance(data, dict) or data.get("state") not in ("queued", "running"):
                continue
            if data.get("id") in self._runs:
                continue
            ended = now_iso()
            for st in data.get("steps", []):
                if st.get("state") == "running":
                    st.update(state="failed", ended=ended)
                elif st.get("state") == "queued":
                    st["state"] = "cancelled"
            data.update(state="failed", ended=ended, current_step=None, error="server restarted")
            write_json_atomic(path, data)
            try:
                with open(path.with_suffix(".log"), "ab") as log:
                    log.write(b"\n[server restarted: run marked failed]\n")
            except OSError:
                pass
            fixed += 1
        return fixed

    # ------------------------------------------------------------ queries

    def _run_files(self, job_id: str | None = None) -> list[Path]:
        if not self.jobs_dir.is_dir():
            return []
        dirs = [self.jobs_dir / job_id] if job_id else [d for d in self.jobs_dir.iterdir() if JOB_ID.fullmatch(d.name)]
        out: list[Path] = []
        for d in dirs:
            runs = d / "runs"
            if runs.is_dir():
                out.extend(p for p in runs.glob("r*.json") if RUN_ID.fullmatch(p.stem))
        return out

    def _find_file(self, run_id: str) -> Path | None:
        """runs/<run_id>.json of a run not created by this process (cached lookup across job folders)."""
        path = self._paths.get(run_id)
        if path is not None and path.is_file():
            return path
        for path in self._run_files():
            self._paths[path.stem] = path
        path = self._paths.get(run_id)
        return path if path is not None and path.is_file() else None

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            run = self._runs.get(run_id)
            if run is not None:
                return strip_root_deep(run.info(), self.root)
        path = self._find_file(run_id)
        data = read_json(path) if path else None
        return strip_root_deep(data, self.root) if isinstance(data, dict) else None

    def log_path(self, run_id: str) -> Path | None:
        with self._lock:
            run = self._runs.get(run_id)
            if run is not None:
                return run.log_path
        path = self._find_file(run_id)
        return path.with_suffix(".log") if path else None

    def list(self, job_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        """RunInfo dicts, newest first (run ids sort chronologically)."""
        found: dict[str, dict[str, Any]] = {}
        for path in self._run_files(job_id):
            data = read_json(path)
            if isinstance(data, dict) and isinstance(data.get("id"), str):
                found[data["id"]] = data
        with self._lock:
            for run in self._runs.values():
                if job_id is None or run.job_id == job_id:
                    found[run.id] = run.info()
        newest = sorted(found.values(), key=lambda r: (r.get("created") or "", r["id"]), reverse=True)[:limit]
        return [strip_root_deep(r, self.root) for r in newest]

    def active_for(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            run = self._active_run(job_id)
            return run.info() if run else None

    def _active_run(self, job_id: str) -> Run | None:
        if self._current is not None and self._current.job_id == job_id:
            return self._current
        return next((r for r in self._queue if r.job_id == job_id), None)

    def queue_info(self) -> dict[str, Any]:
        with self._lock:
            return {"running": self._current.info() if self._current else None,
                    "queued": [r.info() for r in self._queue]}

    def running_step(self, job_id: str) -> str | None:
        with self._lock:
            cur = self._current
            if cur is None or cur.job_id != job_id or cur.current_step is None:
                return None
            return cur.steps[cur.current_step].plan.name

    # ------------------------------------------------------------ submit / cancel

    def submit(self, job_id: str, job_dir: Path, action: str, params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if self._stopping:
                raise ApiError(503, "shutting_down", "the server is stopping")
            busy = self._active_run(job_id)
            if busy is not None:
                raise ApiError(409, "busy", f"job {job_id} already has a {busy.state} run ({busy.id})",
                               run=busy.info())
            run_id = new_run_id()
            while run_id in self._runs or (job_dir / "runs" / f"{run_id}.json").exists():
                run_id = new_run_id()
            steps = [Step(p) for p in plan(action)]
            run = Run(id=run_id, job_id=job_id, action=action, params=params, steps=steps, job_dir=job_dir)
            self._preview_commands(run)
            run.log_path.parent.mkdir(parents=True, exist_ok=True)
            run.log_path.touch()
            self._runs[run_id] = run
            self._queue.append(run)
            self._save(run)
            self._wake.notify_all()
            return run.info()

    def _preview_commands(self, run: Run) -> None:
        """Best-guess commands for display while queued; every step is resolved again right before it starts."""
        ctx = self._context(run)
        for st in run.steps:
            try:
                st.command = st.plan.resolve(ctx) or []
            except (StepError, OSError):
                st.command = []

    def cancel(self, run_id: str) -> dict[str, Any]:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None or run.state in FINISHED:
                info = run.info() if run else self.get(run_id)
                if info is None:
                    raise ApiError(404, "not_found", f"no run {run_id}")
                raise ApiError(409, "not_active", f"run {run_id} is already {info.get('state')}", run=info)
            if run in self._queue:
                self._queue.remove(run)
                self._finish_unstarted(run, "cancelled", None)
                return run.info()
            run.cancel_requested = True
            proc = run.proc
        if proc is not None and proc.poll() is None:
            kill_tree(proc.pid)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with self._lock:
                if run.state in FINISHED:
                    return run.info()
            time.sleep(0.05)
        with self._lock:
            return run.info()

    # ------------------------------------------------------------ worker

    def _worker(self) -> None:
        while True:
            with self._lock:
                while not self._queue and not self._stopping:
                    self._wake.wait()
                if self._stopping:
                    return
                run = self._queue.popleft()
                self._current = run
                run.state, run.started = "running", now_iso()
                self._save(run)
            try:
                outcome = self._execute(run)
            except Exception as exc:  # noqa: BLE001 - the worker must survive any bug: record it, keep the queue going
                outcome = "failed"
                run.error = f"internal error: {type(exc).__name__}: {exc}"
            with self._lock:                     # one atomic transition to the final state
                for st in run.steps:
                    if st.state in ("queued", "running"):
                        st.state = "cancelled"
                run.state, run.ended, run.current_step = outcome, now_iso(), None
                self._current = None
                self._save(run)

    def _context(self, run: Run) -> RunContext:
        return RunContext(root=self.root, job_dir=run.job_dir, job_id=run.job_id, params=run.params,
                          hf_key=self._hf_key())

    def _execute(self, run: Run) -> str:
        """Run the steps in order; returns the run's final state. The run's `state` itself is only changed by
        the worker afterwards, so a client never sees a finished run with steps still queued."""
        ctx = self._context(run)
        with open(run.log_path, "ab", buffering=0) as log:
            for i, st in enumerate(run.steps):
                with self._lock:
                    if run.cancel_requested:
                        return "cancelled"
                    run.current_step = i
                try:
                    cmd = st.plan.resolve(ctx)
                except (StepError, OSError) as exc:
                    self._log(log, f"[{st.plan.name}] cannot start: {exc}\n")
                    with self._lock:
                        st.state, st.started, st.ended = "failed", now_iso(), now_iso()
                        run.error = f"{st.plan.name}: {exc}"
                        self._save(run)
                    return "failed"
                if cmd is None:
                    with self._lock:
                        st.command, st.state = [], "skipped"
                        self._save(run)
                    self._log(log, f"[{st.plan.name}] skipped: nothing to do\n")
                    continue
                outcome = self._run_step(run, st, cmd, log)
                if outcome == "done" and st.plan.on_success is not None:
                    try:
                        st.plan.on_success(ctx)
                    except OSError as exc:
                        self._log(log, f"[{st.plan.name}] finishing failed: {exc}\n")
                        outcome = "failed"
                        with self._lock:
                            st.state = "failed"
                            run.error = f"{st.plan.name}: {exc}"
                            self._save(run)
                if outcome != "done":
                    return outcome
        return "done"

    @staticmethod
    def _log(log: IO[bytes], text: str) -> None:
        log.write(text.encode("utf-8"))

    def _run_step(self, run: Run, st: Step, cmd: list[str], log: IO[bytes]) -> str:
        """Run one child process to completion; returns the step's final state."""
        self._log(log, f"$ {' '.join(cmd)}\n")
        t0 = time.monotonic()
        with self._lock:
            st.command, st.state, st.started = list(cmd), "running", now_iso()
            if run.cancel_requested:
                st.state, st.ended = "cancelled", now_iso()
                self._save(run)
                return "cancelled"
            try:
                proc = spawn(cmd, self.root)
            except OSError as exc:
                st.state, st.ended = "failed", now_iso()
                run.error = f"{st.plan.name}: could not start {cmd[0]}: {exc}"
                self._save(run)
                self._log(log, f"[could not start: {exc}]\n")
                return "failed"
            run.proc = proc
            self._save(run)
        reader = threading.Thread(target=_pump, args=(proc.stdout, run.log_path), name=f"log-{run.id}",
                                  daemon=True)
        reader.start()
        code = proc.wait()
        reader.join(READER_GRACE_S)
        if reader.is_alive():   # a leftover descendant still holds the output pipe: don't let it stall the queue
            self._log(log, "[warning: a leftover child process still holds the step's output; not waiting for it]\n")
        secs = time.monotonic() - t0
        self._log(log, f"[exit {code} in {secs:.1f}s]\n")
        with self._lock:
            run.proc = None
            st.exit_code, st.ended = code, now_iso()
            if run.cancel_requested:
                st.state = "cancelled"
                self._log(log, "[cancelled]\n")
            elif code in st.plan.ok_codes:
                st.state = "done"
                if code != 0:
                    self._log(log, f"[{st.plan.name}: exit {code} accepted (done with warning)]\n")
            else:
                st.state = "failed"
                run.error = f"{st.plan.name} failed (exit {code})"
            self._save(run)
            return st.state

    def _finish_unstarted(self, run: Run, state: str, error: str | None) -> None:
        run.state, run.ended, run.error = state, now_iso(), error
        for st in run.steps:
            st.state = "cancelled"
        self._save(run)

    def _save(self, run: Run) -> None:
        """Persist runs/<id>.json. Best effort: a failed write (e.g. a Windows sharing violation that outlasts the
        retries) must not kill the worker thread and stall the queue; memory stays authoritative and the next
        save rewrites the file."""
        try:
            write_json_atomic(run.json_path, run.info())
        except OSError as exc:
            print(f"[runner] could not save {run.json_path}: {exc}", file=sys.stderr, flush=True)


def _pump(stream: IO[bytes] | None, log_path: Path) -> None:
    """Copy a child's merged output into the run log as it arrives. Uses its own append handle, so it may outlive
    the step (a leftover grandchild holding the pipe) without writing to a closed file."""
    if stream is None:
        return
    read = getattr(stream, "read1", stream.read)
    try:
        with open(log_path, "ab", buffering=0) as log:
            while True:
                chunk = read(65536)
                if not chunk:
                    break
                log.write(chunk)
    finally:
        stream.close()
