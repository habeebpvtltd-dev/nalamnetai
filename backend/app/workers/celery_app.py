"""
Celery application setup: connects to Redis as the message broker,
so document processing can run in the background instead of blocking
the API request.
"""
import os
from celery import Celery

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "nalamnet_worker",
    broker=REDIS_URL,
    backend=REDIS_URL,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
)

# Celery Beat schedule: periodic checks for reminders (Phase 4 dependency)
celery_app.conf.beat_schedule = {
    "check-due-reminders-every-60-seconds": {
        "task": "app.workers.tasks.check_due_reminders",
        "schedule": 60.0,
    },
}