# Main FastAPI application entry point
"""
FastAPI application entrypoint.
"""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import xr
from app.core.db import Base, engine
from app.models import document  # noqa: registers models before create_all

Base.metadata.create_all(bind=engine)  # creates nalamnet.db + tables on first run

app = FastAPI(title="NalamNet AI", version="0.1.0")

# CORS: read from env so Render/Vercel can restrict origins in production.
# Local default keeps all the usual dev origins working without touching .env.
_raw_origins = os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:8080,http://127.0.0.1:8080,"
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://10.196.196.182:8080,http://10.196.196.165:8080",
)
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(xr.router, prefix="/api/v1/xr", tags=["xr"])


@app.get("/")
def root():
    return {"status": "NalamNet AI backend running"}


@app.get("/health")
def health():
    """Render health-check probe + pre-demo wake endpoint."""
    return {"status": "ok"}