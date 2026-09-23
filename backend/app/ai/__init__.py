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

from .ocr import extract_text, extract_text_from_pdf
from .classifier import classify_document
from .extractor import extract_fields
from .explainer import explain_document
from .anomaly import check_bill_anomaly

__all__ = [
    "extract_text",
    "extract_text_from_pdf",
    "classify_document",
    "extract_fields",
    "explain_document",
    "check_bill_anomaly",
]