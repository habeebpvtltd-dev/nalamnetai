"""
Celery tasks: the actual background jobs.
process_document() is the full pipeline chaining OCR -> classify -> extract.
"""
from datetime import datetime, timezone
from app.workers.celery_app import celery_app
from app.ai import extract_text, classify_document, extract_fields
from app.core.db import SessionLocal
from app.models.document import Document, ExtractedEntity  # adjust import paths to your actual models


@celery_app.task(name="app.workers.tasks.process_document")
def process_document(document_id: str):
    """
    Full document pipeline, run in the background after upload.
    1. Mark status = processing
    2. OCR the file
    3. Classify document type
    4. Extract structured fields
    5. Save extracted_entities to DB (verified=False)
    6. Mark status = needs_review
    """
    db = SessionLocal()
    try:
        document = db.query(Document).filter(Document.id == document_id).first()
        if document is None:
            return {"error": "document not found"}

        # 1. Mark as processing
        document.status = "processing"
        db.commit()

        # 2. Fetch the file bytes (adjust to however you pull from MinIO/S3)
        image_bytes = _fetch_file_bytes(document.file_url)

        # 3. OCR
        raw_text = extract_text(image_bytes)
        document.extracted_text = raw_text

        # 4. Classify
        doc_type, class_confidence = classify_document(raw_text)
        document.document_type = doc_type

        # 5. Extract structured fields
        result = extract_fields(doc_type, raw_text)
        fields = result["fields"]
        confidences = result["confidence"]

        # 6. Save each field as an ExtractedEntity row
        for field_name, field_value in fields.items():
            entity = ExtractedEntity(
                document_id=document.id,
                field_name=field_name,
                field_value=str(field_value) if field_value is not None else "",
                confidence_score=confidences.get(field_name, 0.0),
                verified=False,
                edited_by_user=False,
            )
            db.add(entity)

        # 7. Transition status
        document.status = "needs_review"
        db.commit()

        return {"status": "success", "document_id": document_id, "document_type": doc_type}

    except Exception as e:
        db.rollback()
        document = db.query(Document).filter(Document.id == document_id).first()
        if document:
            document.status = "failed"
            db.commit()
        return {"status": "error", "message": str(e)}

    finally:
        db.close()


def _fetch_file_bytes(file_url: str) -> bytes:
    """
    Placeholder: pull the file from MinIO/S3 using file_url.
    Wire this to your actual storage service client.
    """
    raise NotImplementedError("Connect this to your MinIO/S3 client")


@celery_app.task(name="app.workers.tasks.check_due_reminders")
def check_due_reminders():
    """
    Runs every 60 seconds (see celery_app.py beat_schedule).
    Checks for reminders due soon and dispatches alerts.
    Placeholder — wire to your Reminder model + notification service in Phase 4.
    """
    pass