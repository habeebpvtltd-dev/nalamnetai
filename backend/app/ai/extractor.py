"""
Structured information extraction using Pydantic schemas + Groq LLM.
Guarantees the LLM's output always matches an exact, predictable shape.
"""
import os
import json
from typing import Optional
from pydantic import BaseModel, Field, ValidationError
from app.ai.llm import chat, _parse_json

MANDATORY_FIELD_CONFIDENCE_THRESHOLD = 0.50


class ElectricityBillFields(BaseModel):
    provider: Optional[str] = None
    consumer_number: Optional[str] = None
    service_number: Optional[str] = None
    billing_period: Optional[str] = None
    previous_reading: Optional[float] = None
    present_reading: Optional[float] = None
    units_consumed: Optional[float] = None
    amount_due: Optional[float] = None
    due_date: Optional[str] = None
    energy_charges: Optional[float] = None
    fixed_charges: Optional[float] = None


class Medication(BaseModel):
    name: str
    dosage: Optional[str] = None
    frequency: Optional[str] = None
    duration_days: Optional[int] = None


class PrescriptionFields(BaseModel):
    doctor_name: Optional[str] = None
    date: Optional[str] = None
    medications: list[Medication] = Field(default_factory=list)
    follow_up_date: Optional[str] = None


class WarrantyCardFields(BaseModel):
    product_name: Optional[str] = None
    brand: Optional[str] = None
    purchase_date: Optional[str] = None
    warranty_months: Optional[int] = None
    serial_number: Optional[str] = None
    calculated_expiry_date: Optional[str] = None


class ShoppingBillFields(BaseModel):
    store_name: Optional[str] = None
    date: Optional[str] = None
    items: list[str] = Field(default_factory=list)
    total_amount: Optional[float] = None
    payment_method: Optional[str] = None


SCHEMA_MAP = {
    "electricity_bill": ElectricityBillFields,
    "prescription": PrescriptionFields,
    "warranty_card": WarrantyCardFields,
    "shopping_bill": ShoppingBillFields,
    # Radiology has its own dedicated extractor (radiology_extractor.py),
    # but register here so schema lookups don't crash.
    "radiology_report": None,  # handled by extract_radiology_fields
}


def _build_prompt(document_type: str, schema: BaseModel) -> str:
    schema_json = schema.model_json_schema()
    return f"""Extract structured data from this {document_type} document text.
Respond with only a JSON object matching this exact schema.
You MUST respond with ONLY valid JSON matching this exact schema:
{json.dumps(schema_json, indent=2)}

Also include a "_confidence" object with a 0.0-1.0 confidence score for EACH field,
e.g. "_confidence": {{"amount": 0.95, "due_date": 0.60}}

If a field is not present in the text, set it to null and confidence 0.0."""


def extract_fields(document_type: str, text: str) -> dict:
    """
    Returns: {"fields": {...}, "confidence": {...}}
    Fields below MANDATORY_FIELD_CONFIDENCE_THRESHOLD are forced to None
    so the frontend shows "Please enter manually" instead of a shaky guess.
    """
    schema = SCHEMA_MAP.get(document_type)
    if schema is None:
        return {"fields": {}, "confidence": {}}

    sys_prompt = _build_prompt(document_type, schema)

    import re
    text = re.sub(r'\n\s*\n+', '\n', text)
    text = re.sub(r' +', ' ', text).strip()
    text = text[:3000]

    try:
        raw = chat(
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": text}
            ],
            max_tokens=4096,
            temperature=0,
            response_format={"type": "json_object"}
        )
        parsed = _parse_json(raw)
    except Exception as e:
        print(f"[EXTRACT] LLM error: {e}")
        return {"fields": {}, "confidence": {}}

    print(f"[EXTRACT] raw: {json.dumps(parsed)}")

    confidence_scores = parsed.pop("_confidence", {})

    try:
        validated = schema(**parsed)
    except ValidationError:
        return {"fields": {}, "confidence": {}}

    validated_dict = validated.model_dump()
    
    if document_type == "prescription" and "medications" in validated_dict:
        import difflib
        import re
        words = re.findall(r'\w+', text.lower())
        for med in validated_dict["medications"]:
            name = med.get("name", "")
            if not name: continue
            
            name_words = re.findall(r'\w+', name.lower())
            n_len = len(name_words)
            best_r = 0.0
            if n_len > 0:
                for i in range(len(words) - n_len + 1):
                    window = " ".join(words[i:i+n_len])
                    r = difflib.SequenceMatcher(None, name.lower(), window).ratio()
                    if r > best_r: best_r = r
                    if best_r >= 0.8: break
                    
            if best_r < 0.8:
                print(f"[GROUNDING] med dropped confidence: {name}")
                confidence_scores["medications"] = 0.4

    final_fields = {}
    for field_name, value in validated_dict.items():
        score = confidence_scores.get(field_name, 0.0)
        if document_type == "prescription" and field_name == "medications":
            final_fields[field_name] = value
        elif isinstance(score, (int, float)) and score >= MANDATORY_FIELD_CONFIDENCE_THRESHOLD:
            final_fields[field_name] = value
        else:
            final_fields[field_name] = None if not isinstance(value, list) else []

    return {"fields": final_fields, "confidence": confidence_scores}