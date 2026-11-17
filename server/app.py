"""FastAPI app factory: create_app(root) wires the routers, error format, local-only guards, runner and web/dist."""
from __future__ import annotations

import re
from collections.abc import AsyncIterator, Awaitable, Callable, MutableMapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .deps import AppState
from .errors import ApiError, error_body, install_error_handlers
from .paths import safe_join
from .routes import ROUTERS
from .runner import Runner
from .system import ToolCache, key_presence

LOCAL_HOSTS = ("127.0.0.1", "localhost")
LOCAL_ORIGIN = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d{1,5})?$")
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
ASGIApp = Callable[[Scope, Callable[[], Awaitable[Message]], Callable[[Message], Awaitable[None]]], Awaitable[None]]


class LocalOriginGuard:
    """Refuse state-changing requests sent by other web origins (a page on the internet must not be able to
    start runs or edit candidates through the user's browser). Pure ASGI so SSE streaming is untouched."""

    def __init__(self, app: ASGIApp, dev: bool = False) -> None:
        self.app = app
        self.dev = dev

    def _allowed(self, origin: str, host: str | None) -> bool:
        """Same origin as this server (Origin host:port == Host header), or the Vite dev server with --dev.
        Other local apps on other ports may not change state (review finding, 2026-11-17)."""
        if not LOCAL_ORIGIN.fullmatch(origin):
            return False
        if host and origin.split("://", 1)[1] == host:
            return True
        return self.dev and origin in DEV_ORIGINS

    async def __call__(self, scope: Scope, receive: Callable[[], Awaitable[Message]],
                       send: Callable[[Message], Awaitable[None]]) -> None:
        if scope["type"] == "http" and scope["method"] not in SAFE_METHODS:
            headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
            origin = headers.get("origin")
            if (origin and not self._allowed(origin, headers.get("host"))) \
                    or headers.get("sec-fetch-site") == "cross-site":
                resp = JSONResponse(error_body("forbidden_origin", "requests from other sites are not allowed"),
                                    status_code=403)
                await resp(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(root: Path, *, dev: bool = False, allowed_hosts: tuple[str, ...] = LOCAL_HOSTS) -> FastAPI:
    """App for the project at `root` (jobs in root/data/jobs, pipeline scripts in root/clipper)."""
    root = root.resolve()
    jobs_dir = root / "data" / "jobs"
    runner = Runner(root, jobs_dir, hf_key=lambda: key_presence(root)["hf"])
    state = AppState(root=root, jobs_dir=jobs_dir, runner=runner, tools=ToolCache())

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        jobs_dir.mkdir(parents=True, exist_ok=True)
        runner.start()
        try:
            yield
        finally:
            runner.shutdown()

    app = FastAPI(title="Clipper Studio", version=__version__, lifespan=lifespan, docs_url="/api/docs",
                  redoc_url=None, openapi_url="/api/openapi.json")
    app.state.clipper = state
    install_error_handlers(app)
    for router in ROUTERS:
        app.include_router(router)
    _add_web(app, root / "web" / "dist")

    app.add_middleware(LocalOriginGuard, dev=dev)
    if dev:
        app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(allowed_hosts))
    return app


def _add_web(app: FastAPI, dist: Path) -> None:
    """Serve the built frontend (checked per request, so a build made after start is picked up); unknown non-API
    paths fall back to index.html for client-side routing."""

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def web(full_path: str) -> FileResponse:
        if full_path.split("/", 1)[0] in ("api", "media"):
            raise ApiError(404, "not_found", f"no endpoint /{full_path}")
        index = dist / "index.html"
        if not index.is_file():
            raise ApiError(404, "not_found", "web/dist is not built: run `npm run build` in web/")
        if full_path:
            try:
                target = safe_join(dist, full_path)
            except ApiError:
                target = None
            if target is not None and target.is_file():
                return FileResponse(target)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
