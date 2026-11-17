"""Shared request plumbing: the app state object and job-folder lookup."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, Request

from .errors import ApiError
from .paths import check_job_id
from .runner import Runner
from .system import ToolCache, key_presence


@dataclass
class AppState:
    root: Path
    jobs_dir: Path
    runner: Runner
    tools: ToolCache

    def hf_key(self) -> bool:
        return key_presence(self.root)["hf"]

    def job_dir(self, job_id: str, must_exist: bool = True) -> Path:
        """data/jobs/<job_id> for a valid id; 404 not_found when it must exist and doesn't."""
        d = self.jobs_dir / check_job_id(job_id)
        if must_exist and not d.is_dir():
            raise ApiError(404, "not_found", f"no job {job_id}")
        return d

    def runs(self, job_id: str) -> list[dict[str, Any]]:
        return self.runner.list(job_id, limit=1000)


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.clipper
    return state


State = Annotated[AppState, Depends(get_state)]
