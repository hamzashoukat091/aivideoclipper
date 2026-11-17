"""`.venv/Scripts/python -m server [--port 8765] [--dev]` -> API + web/dist on http://127.0.0.1:<port> (local only).

--dev: debug logging and CORS for the Vite dev server (http://localhost:5173), for when the frontend calls the API
directly instead of through Vite's proxy.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .app import create_app

HOST = "127.0.0.1"           # never bind other interfaces: the API can start (paid) pipeline runs
ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m server", description="Clipper Studio backend")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dev", action="store_true", help="debug logging + CORS for the Vite dev server")
    args = ap.parse_args()
    if not 1 <= args.port <= 65535:
        ap.error("--port must be 1-65535")
    app = create_app(ROOT, dev=args.dev)
    print(f"Clipper Studio: http://{HOST}:{args.port}  (project {ROOT})", flush=True)
    uvicorn.run(app, host=HOST, port=args.port, log_level="debug" if args.dev else "info",
                timeout_graceful_shutdown=5)


if __name__ == "__main__":
    main()
