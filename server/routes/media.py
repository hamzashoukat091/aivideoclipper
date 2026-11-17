"""/media/{id}/source (the master, possibly outside the job folder) and /media/{id}/{path} (any job file)."""
from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse

from .. import media
from ..deps import State
from ..errors import ApiError
from ..jobs import source_path
from ..paths import read_json_cached, safe_join

router = APIRouter(prefix="/media", tags=["media"])


def _serve(job_id: str, path: Path, download: bool) -> FileResponse:
    return media.file_response(path, media.download_name(job_id, path) if download else None)


@router.api_route("/{job_id}/source", methods=["GET", "HEAD"])
def source(st: State, job_id: str, download: Annotated[bool, Query()] = False) -> FileResponse:
    d = st.job_dir(job_id)
    meta = read_json_cached(d / "meta.json")
    src = source_path(d, meta if isinstance(meta, dict) else None)
    if src is None:
        raise ApiError(404, "not_found", f"job {job_id} has no source media")
    return _serve(job_id, src, download)


@router.api_route("/{job_id}/{rel:path}", methods=["GET", "HEAD"])
def job_file(st: State, job_id: str, rel: str, download: Annotated[bool, Query()] = False) -> FileResponse:
    d = st.job_dir(job_id)
    path = safe_join(d, rel)
    if not path.is_file():
        raise ApiError(404, "not_found", f"no file {rel} in job {job_id}")
    return _serve(job_id, path, download)
