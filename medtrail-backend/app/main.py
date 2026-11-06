"""
MedTrail API.  Run:  uvicorn app.main:app --reload
Docs (Swagger UI) at /docs when running with FastAPI.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware

from .config import settings
from .db import get_db
from .errors import ApiError, api_error_handler
from .loadshed import LoadShedMiddleware
from .routes import router
from .seed import seed
from .worker import start_in_background

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app):
    db = get_db()
    db.migrate()
    if settings.seed_on_start:
        seed(db)
    stop = start_in_background() if settings.run_worker_in_process else None
    yield
    if stop:
        stop.set()
    db.close()


app = FastAPI(title="MedTrail API", version="0.1.0", lifespan=lifespan)
app.add_exception_handler(ApiError, api_error_handler)

# Order matters: CORS is outermost so even overload (429) responses carry CORS headers.
app.add_middleware(LoadShedMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Idempotency-Key", "If-Match", "X-Demo-User", "X-Demo-Drop-Response"],
    expose_headers=["Idempotent-Replayed", "Retry-After", "X-Load-Level"],
)
app.include_router(router)
