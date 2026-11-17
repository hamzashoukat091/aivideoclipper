"""Job endpoints: list, create, detail, transcript, selection, estimate, files, thumbnail, export.zip."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from .. import jobs, media
from ..deps import State
from ..errors import ApiError
from ..estimate import estimate
from ..paths import JOB_ID, check_clip_id, check_job_id, read_json_cached
from ..sources import default_job_id, normalize_source

router = APIRouter(prefix="/api/jobs", tags=["jobs"])
LANGUAGE = r"^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$"


class CreateJob(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(min_length=1, max_length=4096)
    id: str | None = None
    language: str | None = Field(None, pattern=LANGUAGE)
    speakers: int | None = Field(None, ge=1, le=20)
    allow_lower: StrictBool | None = None


@router.get("")
def list_jobs(st: State) -> list[dict[str, Any]]:
    out = []
    if st.jobs_dir.is_dir():
        for d in st.jobs_dir.iterdir():
            if not (d.is_dir() and JOB_ID.fullmatch(d.name)):
                continue
            runs = st.runs(d.name)
            if jobs.is_listed(d, runs):
                out.append(jobs.job_summary(d, d.name, runs, st.hf_key()))
    out.sort(key=lambda j: j["updated"], reverse=True)
    return out


@router.post("", status_code=201)
def create_job(st: State, body: CreateJob) -> dict[str, Any]:
    source, is_url = normalize_source(body.source)
    job_id = check_job_id(body.id) if body.id is not None else default_job_id(source, is_url)
    d = st.job_dir(job_id, must_exist=False)
    if (d / "meta.json").is_file():
        raise ApiError(409, "exists", f"job {job_id} already exists (choose another id)", job_id=job_id)
    params: dict[str, Any] = {"source": source, "language": body.language or "en"}
    if body.speakers is not None:
        params["speakers"] = body.speakers
    if body.allow_lower:
        params["allow_lower"] = True
    d.mkdir(parents=True, exist_ok=True)
    run = st.runner.submit(job_id, d, "prepare", params)
    return {"job": jobs.job_summary(d, job_id, st.runs(job_id), st.hf_key()), "run": run}


@router.get("/{job_id}")
def job_detail(st: State, job_id: str) -> dict[str, Any]:
    d = st.job_dir(job_id)
    return jobs.job_detail(d, job_id, st.runs(job_id), st.hf_key())


@router.get("/{job_id}/transcript")
def transcript(st: State, job_id: str) -> dict[str, Any]:
    return jobs.transcript(st.job_dir(job_id))


@router.get("/{job_id}/selection")
def selection(st: State, job_id: str) -> dict[str, Any]:
    return jobs.selection(st.job_dir(job_id), job_id, st.runs(job_id))


@router.get("/{job_id}/estimate")
async def get_estimate(st: State, job_id: str, judge_model: Annotated[str, Query()] = "sonnet",
                       top: Annotated[int, Query(ge=1, le=50)] = 10) -> dict[str, Any]:
    st.job_dir(job_id)
    if st.runner.running_step(job_id) == "select":
        raise ApiError(409, "busy", f"job {job_id} is running clip selection")
    return await run_in_threadpool(estimate, st.root, job_id, judge_model, top)


@router.get("/{job_id}/files")
def files(st: State, job_id: str) -> list[dict[str, Any]]:
    return jobs.files(st.job_dir(job_id), job_id)


@router.get("/{job_id}/thumbnail")
def thumbnail(st: State, job_id: str) -> FileResponse:
    d = st.job_dir(job_id)
    meta = read_json_cached(d / "meta.json")
    probe = read_json_cached(d / "probe.json")
    src = jobs.source_path(d, meta if isinstance(meta, dict) else None)
    if src is None or not isinstance(probe, dict):
        raise ApiError(404, "not_found", f"job {job_id} has no ingested source yet")
    duration = probe.get("duration") if isinstance(probe.get("duration"), (int, float)) else None
    return media.file_response(media.thumbnail(d, src, duration), cache="no-cache")


@router.get("/{job_id}/export.zip")
def export_zip(st: State, job_id: str, clips: Annotated[str | None, Query()] = None) -> StreamingResponse:
    d = st.job_dir(job_id)
    if clips is not None and clips.strip():
        ids = [check_clip_id(c.strip()) for c in clips.split(",") if c.strip()]
    else:
        ids = [c["id"] for c in jobs.load_candidates(d) if (d / "renders" / f"{c['id']}.mp4").is_file()]
    members = media.export_members(d, list(dict.fromkeys(ids)))
    headers = {"Content-Disposition": f'attachment; filename="{job_id}-clips.zip"', "Cache-Control": "no-store"}
    return StreamingResponse(media.zip_stream(members), media_type="application/zip", headers=headers)

