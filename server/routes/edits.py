"""Clip edits: GET / PUT / DELETE /api/jobs/{id}/clips/{cid}/edits (docs/UI_SPEC.md section 5b)."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body

from .. import clip_edits
from ..deps import State
from ..errors import ApiError
from ..paths import check_clip_id

router = APIRouter(prefix="/api/jobs/{job_id}/clips/{cid}", tags=["edits"])


def _check_idle(st: State, job_id: str, cid: str) -> None:
    active = st.runner.active_for(job_id)
    if clip_edits.clip_busy(active, cid):
        raise ApiError(409, "busy", f"a {active['action']} run for this clip is {active['state']}; edit after it ends",
                       run=active)


@router.get("/edits")
def get_edits(st: State, job_id: str, cid: str) -> dict[str, Any]:
    return clip_edits.context(st.job_dir(job_id), check_clip_id(cid))


@router.put("/edits")
def put_edits(st: State, job_id: str, cid: str, body: Annotated[Any, Body()]) -> dict[str, Any]:
    """Body: an Edits object. Validation failures are 400 with a specific code (bad_trim, bad_shot, ...)."""
    d = st.job_dir(job_id)
    check_clip_id(cid)
    _check_idle(st, job_id, cid)
    return clip_edits.save(d, cid, body)


@router.delete("/edits")
def delete_edits(st: State, job_id: str, cid: str) -> dict[str, Any]:
    d = st.job_dir(job_id)
    check_clip_id(cid)
    _check_idle(st, job_id, cid)
    return clip_edits.reset(d, cid)
