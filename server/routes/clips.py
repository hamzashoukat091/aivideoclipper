"""Per-clip endpoints: approve/reject (PATCH), reframe plan, parsed captions, poster frame."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, StrictBool

from .. import jobs, media
from ..deps import State
from ..errors import ApiError
from ..paths import check_clip_id

router = APIRouter(prefix="/api/jobs/{job_id}", tags=["clips"])


class PatchCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approved: StrictBool | None      # required key; null = undecided


@router.patch("/candidates/{cid}")
def patch_candidate(st: State, job_id: str, cid: str, body: PatchCandidate) -> dict[str, Any]:
    d = st.job_dir(job_id)
    check_clip_id(cid)
    if st.runner.running_step(job_id) == "select":
        raise ApiError(409, "busy", f"job {job_id} is running clip selection; candidates.json is being rewritten")
    return jobs.set_approved(d, job_id, cid, body.approved, st.runs(job_id))


@router.get("/clips/{cid}/reframe")
def reframe(st: State, job_id: str, cid: str) -> dict[str, Any]:
    return jobs.reframe_plan(st.job_dir(job_id), check_clip_id(cid))


@router.get("/clips/{cid}/captions")
def captions(st: State, job_id: str, cid: str) -> dict[str, Any]:
    return jobs.captions(st.job_dir(job_id), job_id, check_clip_id(cid))


@router.get("/clips/{cid}/poster")
def poster(st: State, job_id: str, cid: str) -> FileResponse:
    d = st.job_dir(job_id)
    return media.file_response(media.poster(d, check_clip_id(cid)), cache="no-cache")
