"""File serving (HTTP Range via Starlette's FileResponse), ffmpeg thumbnails/posters cached in ui/, zip export."""
from __future__ import annotations

import mimetypes
import shutil
import subprocess
import threading
import zipfile
from collections.abc import Iterator
from pathlib import Path

from fastapi.responses import FileResponse

from .errors import ApiError

MIME = {
    ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
    ".mov": "video/quicktime", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
    ".ass": "text/plain; charset=utf-8", ".ssa": "text/plain; charset=utf-8", ".srt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".json": "application/json",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
}
THUMB_WIDTH, POSTER_WIDTH = 640, 540
POSTER_AT_S = 1.0
FFMPEG_TIMEOUT_S = 120
ZIP_CHUNK = 1 << 20

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def mime_for(path: Path) -> str:
    return MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def file_response(path: Path, download_name: str | None = None, cache: str | None = None) -> FileResponse:
    """FileResponse handles Range/If-Range (206, Content-Range, Accept-Ranges, 416), ETag and Last-Modified."""
    headers = {"Cache-Control": cache} if cache else None
    return FileResponse(path, media_type=mime_for(path), filename=download_name, headers=headers,
                        content_disposition_type="attachment")


# ---------------------------------------------------------------- ffmpeg frame grabs

def _lock_for(path: Path) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(str(path), threading.Lock())


def _fresh(out: Path, src: Path) -> bool:
    try:
        return out.stat().st_mtime >= src.stat().st_mtime and out.stat().st_size > 0
    except OSError:
        return False


def _grab(src: Path, out: Path, at: float, width: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise ApiError(500, "ffmpeg_missing", "ffmpeg is not on PATH")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.stem}.tmp.jpg")
    for seek in (at, 0.0):            # a clip shorter than `at` yields no frame: fall back to the first frame
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{seek:.3f}", "-i", str(src),
               "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(tmp)]
        try:
            subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_S, stdin=subprocess.DEVNULL, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            tmp.unlink(missing_ok=True)
            raise ApiError(500, "ffmpeg_failed", f"ffmpeg could not grab a frame: {exc}") from exc
        if tmp.is_file() and tmp.stat().st_size > 0:
            tmp.replace(out)
            return
    tmp.unlink(missing_ok=True)
    raise ApiError(500, "ffmpeg_failed", f"ffmpeg produced no frame from {src.name}")


def cached_frame(src: Path, out: Path, at: float, width: int) -> Path:
    """`out` (a jpg in ui/) holding one frame of `src`; regenerated when `src` is newer."""
    with _lock_for(out):
        if not _fresh(out, src):
            _grab(src, out, at, width)
    return out


def thumbnail(job_dir: Path, src: Path, duration: float | None) -> Path:
    at = max(0.0, 0.2 * duration) if duration else 0.0
    return cached_frame(src, job_dir / "ui" / "thumb.jpg", at, THUMB_WIDTH)


def poster(job_dir: Path, cid: str) -> Path:
    video = job_dir / "renders" / f"{cid}.mp4"
    if not video.is_file():
        raise ApiError(404, "not_found", f"clip {cid} is not rendered yet")
    return cached_frame(video, job_dir / "ui" / "posters" / f"{cid}.jpg", POSTER_AT_S, POSTER_WIDTH)


# ---------------------------------------------------------------- zip export

class _Sink:
    """Write-only, unseekable buffer: zipfile writes into it, the generator drains it."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.pos = 0

    def write(self, b: bytes) -> int:
        self.buf += b
        self.pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self.pos

    def flush(self) -> None:
        pass

    def drain(self) -> bytes:
        out = bytes(self.buf)
        self.buf.clear()
        return out


def export_members(job_dir: Path, clip_ids: list[str]) -> list[tuple[Path, str]]:
    rels: list[str] = []
    for cid in clip_ids:
        rels += [f"renders/{cid}.mp4", f"renders/{cid}.report.json", f"captions/{cid}.ass"]
    rels += ["candidates.json", "review.md"]
    return [(job_dir / r, r) for r in rels if (job_dir / r).is_file()]


def zip_stream(members: list[tuple[Path, str]]) -> Iterator[bytes]:
    """Stream a zip without building it in memory or on disk (data descriptors; videos stored, text deflated)."""
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", allowZip64=True) as zf:  # type: ignore[arg-type]
        for path, arc in members:
            info = zipfile.ZipInfo.from_file(path, arc)
            info.compress_type = zipfile.ZIP_STORED if path.suffix.lower() in (".mp4", ".mkv") else zipfile.ZIP_DEFLATED
            with open(path, "rb") as src, zf.open(info, "w", force_zip64=True) as dst:
                while chunk := src.read(ZIP_CHUNK):
                    dst.write(chunk)
                    if len(sink.buf) >= ZIP_CHUNK:
                        yield sink.drain()
    if sink.buf:
        yield sink.drain()


def download_name(job_id: str, path: Path) -> str:
    return f"{job_id}-{path.name}"
