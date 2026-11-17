"""New-job sources: validate a URL or local file and derive the default job id (docs/UI_SPEC.md POST /api/jobs)."""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .errors import ApiError

YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be",
            "youtube-nocookie.com", "www.youtube-nocookie.com"}
YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
YT_PATH_PREFIXES = ("shorts", "live", "embed", "v")


def normalize_source(source: str) -> tuple[str, bool]:
    """(source to pass to ingest, is_url). URLs must be http(s) with a host; files must exist (made absolute)."""
    src = source.strip()
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", src):
        u = urlparse(src)
        if u.scheme not in ("http", "https") or not u.netloc or any(c.isspace() for c in src):
            raise ApiError(400, "bad_source", "source must be an http(s) URL or an existing local file")
        return src, True
    path = Path(src).expanduser()
    if not src or not path.is_file():
        raise ApiError(400, "bad_source", f"source is not an http(s) URL and no such file exists: {src!r}")
    return str(path.resolve()), False


def youtube_id(url: str) -> str | None:
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if host not in YT_HOSTS:
        return None
    parts = [p for p in u.path.split("/") if p]
    candidate = None
    if host.endswith("youtu.be"):
        candidate = parts[0] if parts else None
    elif parts[:1] == ["watch"]:
        candidate = (parse_qs(u.query).get("v") or [None])[0]
    elif len(parts) >= 2 and parts[0] in YT_PATH_PREFIXES:
        candidate = parts[1]
    return candidate if candidate and YT_ID.fullmatch(candidate) else None


def slug(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9_-]+", "-", ascii_text.lower()).strip("-_")
    s = re.sub(r"-{2,}", "-", s)[:64].rstrip("-_")
    return s or "job"


def default_job_id(source: str, is_url: bool) -> str:
    """YouTube: video id lower-cased (`yt-<id>` when it doesn't start with a letter/digit); else a slug of the
    file stem (for other URLs: the last path segment's stem, or the host)."""
    if is_url:
        vid = youtube_id(source)
        if vid:
            vid = vid.lower()
            return vid if re.match(r"^[a-z0-9]", vid) else f"yt-{vid}"
        u = urlparse(source)
        last = [p for p in u.path.split("/") if p]
        return slug(Path(last[-1]).stem if last else (u.hostname or ""))
    return slug(Path(source).stem)
