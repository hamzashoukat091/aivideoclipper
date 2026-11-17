"""One APIRouter per area; app.py includes them all."""
from . import clips, edits, jobs, media, runs, system

ROUTERS = [system.router, jobs.router, clips.router, edits.router, runs.router, media.router]
