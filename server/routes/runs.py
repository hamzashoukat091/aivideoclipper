"""Run endpoints: start (with the PAID guard), list, detail, log polling, SSE stream, cancel."""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any, Literal, get_args

from fastapi import APIRouter, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from ..actions import ACTIONS, needs_paid_confirmation
from ..deps import AppState, State
from ..errors import ApiError
from ..estimate import estimate
from ..jobs import load_candidates
from ..paths import check_clip_id, check_job_id, check_run_id
from ..runner import FINISHED
from ..sources import normalize_source
from .jobs import LANGUAGE

router = APIRouter(prefix="/api", tags=["runs"])
LOG_CHUNK = 2 << 20               # max bytes per /log response
POLL_S = 0.25
HEARTBEAT_S = 15.0
CLIP_ACTIONS = ("reframe", "render", "produce")

RunAction = Literal["prepare", "ingest", "transcribe", "diarize", "sentences", "select", "reframe", "render",
                    "produce", "proxy"]
assert set(get_args(RunAction)) == set(ACTIONS)


class RunRequest(BaseModel):
    """docs/UI_SPEC.md POST /api/jobs/{id}/runs. `source`/`allow_lower` feed the ingest command."""
    model_config = ConfigDict(extra="forbid")
    action: RunAction
    clips: list[str] | None = Field(None, max_length=200)
    judge_model: Literal["haiku", "sonnet", "opus"] | None = None
    top: int | None = Field(None, ge=1, le=50)
    fast: StrictBool | None = None
    preview: StrictBool | None = None
    force: StrictBool | None = None
    confirm_paid: StrictBool | None = None
    language: str | None = Field(None, pattern=LANGUAGE)
    speakers: int | None = Field(None, ge=1, le=20)
    source: str | None = Field(None, min_length=1, max_length=4096)
    allow_lower: StrictBool | None = None


def _check_clips(d: Path, body: RunRequest) -> None:
    if not body.clips:
        return
    if body.action not in CLIP_ACTIONS:
        raise ApiError(400, "bad_param", f"`clips` only applies to {', '.join(CLIP_ACTIONS)}")
    known = {c["id"] for c in load_candidates(d)}
    for cid in body.clips:
        check_clip_id(cid)
        if cid not in known:
            raise ApiError(400, "unknown_clip", f"clip {cid} is not in candidates.json")
    body.clips = list(dict.fromkeys(body.clips))


@router.post("/jobs/{job_id}/runs", status_code=202, response_model=None)
async def start_run(st: State, job_id: str, body: RunRequest) -> dict[str, Any] | JSONResponse:
    d = st.job_dir(job_id)
    _check_clips(d, body)
    if body.source is not None:
        if body.action not in ("ingest", "prepare", "produce"):
            raise ApiError(400, "bad_param", "`source` only applies to ingest, prepare and produce")
        body.source = normalize_source(body.source)[0]     # same rule as POST /api/jobs: http(s) URL or a file
    busy = st.runner.active_for(job_id)
    if busy is not None:
        raise ApiError(409, "busy", f"job {job_id} already has a {busy['state']} run ({busy['id']})", run=busy)
    if needs_paid_confirmation(body.action, d) and body.confirm_paid is not True:
        est = await run_in_threadpool(estimate, st.root, job_id, body.judge_model or "sonnet", body.top or 10)
        usd = est.get("usd")
        cost = f"~${usd:.2f}" if isinstance(usd, (int, float)) else "an unknown amount"
        return JSONResponse(status_code=402, content={
            "error": "paid_confirmation_required",
            "message": f"clip selection calls the Anthropic API (PAID, {cost}); resend with confirm_paid: true",
            "estimate": est})
    params = body.model_dump(exclude_none=True, exclude={"action"})
    return st.runner.submit(job_id, d, body.action, params)


@router.get("/runs")
def list_runs(st: State, job: Annotated[str | None, Query()] = None,
              limit: Annotated[int, Query(ge=1, le=1000)] = 50) -> list[dict[str, Any]]:
    if job is not None:
        check_job_id(job)
    return st.runner.list(job, limit)


def _run_or_404(st: AppState, run_id: str) -> dict[str, Any]:
    info = st.runner.get(check_run_id(run_id))
    if info is None:
        raise ApiError(404, "not_found", f"no run {run_id}")
    return info


@router.get("/runs/{run_id}")
def get_run(st: State, run_id: str) -> dict[str, Any]:
    return _run_or_404(st, run_id)


def _complete_utf8(data: bytes) -> bytes:
    """Drop a trailing, incomplete UTF-8 sequence (it is returned by the next read instead)."""
    for back in range(1, min(4, len(data)) + 1):
        b = data[-back]
        if b & 0xC0 == 0x80:          # continuation byte: keep looking for the lead byte
            continue
        need = 2 if b & 0xE0 == 0xC0 else 3 if b & 0xF0 == 0xE0 else 4 if b & 0xF8 == 0xF0 else 1
        return data if need <= back else data[:-back]
    return data


def _read_from(path: Path | None, offset: int, limit: int) -> bytes:
    if path is None or not path.is_file():
        return b""
    with open(path, "rb") as f:
        f.seek(offset)
        return f.read(limit)


@router.get("/runs/{run_id}/log")
def get_log(st: State, run_id: str, offset: Annotated[int, Query(ge=0)] = 0) -> dict[str, Any]:
    info = _run_or_404(st, run_id)
    path = st.runner.log_path(run_id)
    size = path.stat().st_size if path is not None and path.is_file() else 0
    offset = min(offset, size)
    finished = info.get("state") in FINISHED
    data = _read_from(path, offset, LOG_CHUNK)
    if not (finished and offset + len(data) >= size):
        data = _complete_utf8(data)
    new_offset = offset + len(data)
    return {"text": data.decode("utf-8", errors="replace"), "offset": new_offset,
            "done": finished and new_offset >= size}


def _sse(event: str, data: str) -> str:
    return f"event: {event}\n" + "".join(f"data: {line}\n" for line in data.split("\n")) + "\n"


def _display_line(raw: bytes) -> str:
    """One log line as a terminal would show it: progress bars rewrite the line with \\r; keep the last state."""
    text = raw.decode("utf-8", errors="replace").rstrip("\r")
    if "\r" in text:
        parts = [p for p in text.split("\r") if p.strip()]
        text = parts[-1] if parts else ""
    return text


async def _stream(request: Request, st: AppState, run_id: str) -> AsyncIterator[str]:
    path = st.runner.log_path(run_id)
    offset, pending, last_state = 0, b"", None
    last_beat = time.monotonic()
    while True:
        if await request.is_disconnected():
            return
        info = st.runner.get(run_id) or {}
        finished = info.get("state") in FINISHED
        chunk = _read_from(path, offset, LOG_CHUNK)   # a finished run's log is complete before its state flips
        offset += len(chunk)
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for line in lines:
            yield _sse("log", _display_line(line))
        state_json = json.dumps(info, ensure_ascii=False)
        if state_json != last_state:
            last_state = state_json
            yield _sse("state", state_json)
        if finished and len(chunk) < LOG_CHUNK:
            if pending:
                yield _sse("log", _display_line(pending))
            yield _sse("end", state_json)
            return
        if time.monotonic() - last_beat >= HEARTBEAT_S:
            last_beat = time.monotonic()
            yield ": heartbeat\n\n"
        if len(chunk) < LOG_CHUNK:
            await asyncio.sleep(POLL_S)


@router.get("/runs/{run_id}/stream")
def stream(st: State, run_id: str, request: Request) -> StreamingResponse:
    _run_or_404(st, run_id)
    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}
    return StreamingResponse(_stream(request, st, run_id), media_type="text/event-stream", headers=headers)


@router.post("/runs/{run_id}/cancel")
async def cancel(st: State, run_id: str) -> dict[str, Any]:
    _run_or_404(st, run_id)
    return await run_in_threadpool(st.runner.cancel, run_id)
