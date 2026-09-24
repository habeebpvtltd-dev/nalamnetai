"""
AI module: OCR, classification, extraction, explanation, anomaly detection.
Loads .env FIRST, using an explicit absolute path, so GROQ_API_KEY is
guaranteed available regardless of what working directory the process
was launched from (uvicorn's --reload subprocess can vary this on Windows).
"""
from pathlib import Path
from dotenv import load_dotenv

# backend/app/ai/__init__.py -> go up 2 levels -> backend/.env
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

from .ocr import extract_text, extract_text_from_pdf, vision_classify_and_extract, check_vision_needed
from .classifier import classify_document
from .extractor import extract_fields
from .explainer import explain_document
from .anomaly import check_bill_anomaly
from .radiology_extractor import extract_radiology_fields
from .body_zones import BODY_ZONES, VALID_ZONE_IDS, ZONE_BY_ID

__all__ = [
    "extract_text",
    "extract_text_from_pdf",
    "vision_classify_and_extract",
    "check_vision_needed",
    "classify_document",
    "extract_fields",
    "explain_document",
    "check_bill_anomaly",
    "extract_radiology_fields",
    "BODY_ZONES",
    "VALID_ZONE_IDS",
    "ZONE_BY_ID",
]