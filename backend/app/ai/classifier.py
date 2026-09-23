"""
Document classifier: fast keyword scoring, with Groq LLM fallback
for low-confidence cases. Covers electricity bills, prescriptions,
warranty cards, and general shopping/retail bills.
"""
import os
import json
from groq import Groq

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
GROQ_MODEL = "openai/gpt-oss-120b"

DOCUMENT_TYPES = ["electricity_bill", "prescription", "warranty_card", "shopping_bill", "unclassified"]

KEYWORD_MAP = {
    "electricity_bill": ["consumer number", "kwh", "units consumed", "electricity board", "tariff", "meter no"],
    "prescription": ["rx", "tablet", "mg", "dosage", "doctor", "dr.", "prescribed", "capsule"],
    "warranty_card": ["warranty", "serial no", "serial number", "purchase date", "guarantee", "model no"],
    "shopping_bill": ["total", "qty", "item", "receipt", "cash bill", "gst", "invoice", "amount paid", "bill no"],
}

CONFIDENCE_THRESHOLD = 0.5


def classify_keyword(text: str) -> tuple[str, float]:
    """Score OCR text against keyword sets. Free, instant, no API call."""
    text_lower = text.lower()
    scores = {}
    for doc_type, keywords in KEYWORD_MAP.items():
        hits = sum(1 for kw in keywords if kw in text_lower)
        scores[doc_type] = hits / len(keywords)

    best_type = max(scores, key=scores.get)
    best_score = scores[best_type]
    if best_score == 0:
        return "unclassified", 0.0
    return best_type, round(best_score, 2)


def classify_llm(text: str) -> tuple[str, float]:
    """LLM fallback classifier, used only when keyword confidence is low."""
    prompt = f"""Classify this document text into exactly one category:
electricity_bill, prescription, warranty_card, shopping_bill, or unclassified.

Use "shopping_bill" for any retail receipt, invoice, or general purchase bill
that isn't specifically an electricity bill, prescription, or warranty card.

Respond ONLY with JSON: {{"type": "...", "confidence": 0.0-1.0}}

Document text:
{text[:2000]}
"""
    response = client.chat.completions.create(
        model=GROQ_MODEL,
        max_tokens=500,
        response_format={"type": "json_object"},
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.choices[0].message.content.strip()

    try:
        parsed = json.loads(raw)
        doc_type = parsed.get("type", "unclassified")
        confidence = float(parsed.get("confidence", 0.0))
        if doc_type not in DOCUMENT_TYPES:
            doc_type = "unclassified"
        return doc_type, confidence
    except (json.JSONDecodeError, ValueError):
        return "unclassified", 0.0


def classify_document(text: str) -> tuple[str, float]:
    """Main entrypoint: keyword scoring first, LLM only if confidence is low."""
    doc_type, confidence = classify_keyword(text)
    if confidence < CONFIDENCE_THRESHOLD:
        doc_type, confidence = classify_llm(text)
    return doc_type, confidence