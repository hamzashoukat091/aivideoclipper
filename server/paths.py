"""Id validation, safe path resolution inside a job folder, timestamps and JSON file I/O."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .errors import ApiError

JOB_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
CLIP_ID = re.compile(r"^[a-z0-9_-]{1,32}$")
RUN_ID = re.compile(r"^r\d{8}-\d{6}-[0-9a-f]{4}$")


def check_job_id(job_id: str) -> str:
    if not JOB_ID.fullmatch(job_id):
        raise ApiError(400, "bad_id", f"invalid job id {job_id!r}: expected {JOB_ID.pattern}")
    return job_id


def check_clip_id(clip_id: str) -> str:
    if not CLIP_ID.fullmatch(clip_id):
        raise ApiError(400, "bad_id", f"invalid clip id {clip_id!r}: expected {CLIP_ID.pattern}")
    return clip_id


def check_run_id(run_id: str) -> str:
    if not RUN_ID.fullmatch(run_id):
        raise ApiError(400, "bad_id", f"invalid run id {run_id!r}: expected r<yyyymmdd-HHMMSS>-<4 hex>")
    return run_id


def safe_join(base: Path, rel: str) -> Path:
    """Resolve `rel` (a forward-slash relative path) inside `base`. Rejects absolute paths, `..`, drive letters,
    backslashes and anything (e.g. a symlink) that resolves outside `base` -> 400 bad_path. Does not check existence."""
    bad = (not rel or rel.startswith("/") or "\\" in rel or ":" in rel or "\x00" in rel
           or any(part in ("", ".", "..") for part in rel.split("/")))
    if bad:
        raise ApiError(400, "bad_path", f"invalid path {rel!r}")
    root = base.resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root):
        raise ApiError(400, "bad_path", f"path {rel!r} leaves the job folder")
    return target


@lru_cache(maxsize=8)
def _root_pattern(root: str) -> re.Pattern[str]:
    variants = {root, root.replace("\\", "/"), root.replace("/", "\\")}
    alts = "|".join(re.escape(v.rstrip("\\/")) + r"[\\/]" for v in sorted(variants, key=len, reverse=True))
    return re.compile(alts, re.IGNORECASE)


def strip_root(text: str, root: Path) -> str:
    """Show paths relative to the project folder in commands and logs: shorter, and it keeps the user's home
    path (Windows user name) out of anything displayed or screenshotted. Files on disk keep exact paths."""
    return _root_pattern(str(root)).sub("", text)


def strip_root_deep(obj: Any, root: Path) -> Any:
    if isinstance(obj, str):
        return strip_root(obj, root)
    if isinstance(obj, list):
        return [strip_root_deep(v, root) for v in obj]
    if isinstance(obj, dict):
        return {k: strip_root_deep(v, root) for k, v in obj.items()}
    return obj


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def media_url(job_id: str, rel: str) -> str:
    return f"/media/{job_id}/{quote(rel)}"


def read_json(path: Path) -> Any:
    """Parsed JSON, or None when the file is missing or unreadable (a stage may be mid-write)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


@lru_cache(maxsize=64)
def _cached(path: str, mtime_ns: int, size: int) -> Any:
    return read_json(Path(path))


def read_json_cached(path: Path) -> Any:
    """Like read_json, memoised on (path, mtime, size). The result is shared: callers must not mutate it."""
    try:
        st = path.stat()
    except OSError:
        return None
    return _cached(str(path), st.st_mtime_ns, st.st_size)


def write_json_atomic(path: Path, data: Any) -> None:
    """Write via a temp file in the same folder + os.replace, so readers never see a half-written file.
    Same formatting as clipper/common.py write_json."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
        for attempt in range(20):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:      # Windows: a reader holds the target open for a moment
                if attempt == 19:
                    raise
                time.sleep(0.025)
    finally:
        tmp.unlink(missing_ok=True)
