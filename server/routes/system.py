"""/api/health and /api/system."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import __version__
from ..deps import State
from ..system import asset_presence, key_presence, spend

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__}


@router.get("/system")
def system(st: State) -> dict[str, Any]:
    return {"version": __version__, "root": str(st.root), "jobs_dir": str(st.jobs_dir), "tools": st.tools.get(),
            "keys": key_presence(st.root), "assets": asset_presence(st.root), "queue": st.runner.queue_info(),
            "spend": spend(st.jobs_dir)}
