# XR API endpoints
"""
XR API endpoints: AR document scanning, emergency profile, spatial assistant.
"""
import os
import io
import json
import uuid
import base64
import qrcode
import groq
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, HTMLResponse
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from groq import Groq

from app.ai import (
    extract_text, extract_text_from_pdf, classify_document, extract_fields,
    vision_classify_and_extract, check_vision_needed,
    extract_radiology_fields, ZONE_BY_ID,
)
from app.ai.voice import transcribe, synthesize
from app.core.db import get_db
from app.models.document import Document, ExtractedEntity, EmergencyProfile
from pydantic import BaseModel

# Radiology image response message (constant)
_RADIOLOGY_IMAGE_MSG = (
    "Please scan the written report from the radiologist, not the scan film. "
    "We can only explain the printed report text, not the image itself."
)

class TTSRequest(BaseModel):
    text: str
    language: str = "en"


# ---------------------------------------------------------------------------
# Radiology viewer helper
# ---------------------------------------------------------------------------

def _build_radiology_viewer(document_id: str, fields: dict) -> dict:
    """
    Builds the viewer-ready JSON that /radiology/latest and /radiology/{id}
    return, and is also embedded in the /scan response for radiology_report.

    Returns:
    {
      document_id, study_name, modality, study_date, referring_doctor,
      radiologist, clinical_history, impression, overall_normal,
      zones: [
        { zone_id, zone_en, zone_ta, findings: [ ...abnormal... ] }
      ],
      all_findings: [ ...all... ]
    }
    Zones list only contains zones that have at least one abnormal finding.
    """
    findings = fields.get("findings", [])
    for f in findings:
        if "body_zone" in f:
            f["zone_id"] = f.pop("body_zone")

    # Group ABNORMAL findings by zone
    zone_map: dict[str, list] = {}
    for f in findings:
        if f.get("is_normal"):
            continue
        zone_id = f.get("zone_id") or "unzoned"
        zone_map.setdefault(zone_id, []).append(f)

    zones = []
    for zone_id, zone_findings in zone_map.items():
        zone_info = ZONE_BY_ID.get(zone_id, {"id": zone_id, "en": zone_id, "ta": zone_id})
        zones.append({
            "zone_id": zone_id,
            "zone_en": zone_info.get("en", zone_id),
            "zone_ta": zone_info.get("ta", zone_id),
            "findings": zone_findings,
        })

    return {
        "document_id": document_id,
        "study_name": fields.get("study_name"),
        "modality": fields.get("modality"),
        "study_date": fields.get("study_date"),
        "referring_doctor": fields.get("referring_doctor"),
        "radiologist": fields.get("radiologist"),
        "clinical_history": fields.get("clinical_history"),
        "impression": fields.get("impression"),
        "overall_normal": fields.get("overall_normal", False),
        "is_critical": fields.get("is_critical", False),
        "zones": zones,
        "all_findings": findings,
    }


router = APIRouter()
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")
from app.ai.llm import chat, _parse_json

@router.post("/scan")
def scan_document(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """
    AR scan: image in -> AI pipeline -> saved to DB -> structured data out.

    IMPORTANT: this is a plain `def`, not `async def`, on purpose. Everything
    inside (Tesseract, OpenCV, Groq calls) is blocking, synchronous code.
    A plain `def` route tells FastAPI to run it in a background thread pool,
    so it doesn't freeze the whole server for other requests (like the
    Assistant chat) while a scan is processing. `async def` would run this
    directly on the main event loop and block everything else.
    """    
    file_bytes = file.file.read()
    filename = (file.filename or "").lower()
    is_pdf = filename.endswith(".pdf") or file.content_type == "application/pdf"

    handwritten = False

    try:
        if is_pdf:
            raw_text = extract_text_from_pdf(file_bytes)
            doc_type, class_confidence = classify_document(raw_text)
            if doc_type == "radiology_report":
                result = extract_radiology_fields(raw_text)
            else:
                result = extract_fields(doc_type, raw_text)
        else:
            # Step 1: Tesseract + standard pipeline
            from app.ai.ocr import (
                _fix_orientation, preprocess_image, _tesseract_with_confidence,
                MIN_TEXT_LENGTH, MIN_AVG_CONFIDENCE
            )
            oriented = _fix_orientation(file_bytes)
            lang = os.environ.get("TESSERACT_LANG", "eng+tam")
            processed = preprocess_image(oriented)
            tess_text, avg_confidence = _tesseract_with_confidence(processed, lang)
            print(f"[SCAN] Tesseract confidence: {avg_confidence:.1f}, length: {len(tess_text)}")

            # Step 2: run standard classify+extract on Tesseract text
            raw_text = tess_text.strip()
            doc_type = "unclassified"
            class_confidence = 0.0
            result = {"fields": {}, "confidence": {}}

            if len(raw_text) >= MIN_TEXT_LENGTH:
                doc_type, class_confidence = classify_document(raw_text)
                if doc_type == "radiology_report":
                    result = extract_radiology_fields(raw_text)
                else:
                    result = extract_fields(doc_type, raw_text)

            # Step 3: check all four vision-retry triggers.
            # EXCEPTION: if Tesseract already classified as radiology_report with
            # high confidence and sufficient text, skip vision entirely.
            # vision_classify_and_extract() always returns None for radiology_report
            # (by design), so triggering vision for it only wastes API tokens and
            # triggers duplicate LLM extraction calls that exhaust TPD limits.
            _is_high_conf_radiology = (
                doc_type == "radiology_report"
                and avg_confidence >= MIN_AVG_CONFIDENCE
                and len(raw_text) >= 300
            )
            if _is_high_conf_radiology:
                needs_vision, vision_reason = False, ""
            else:
                needs_vision, vision_reason = check_vision_needed(
                    raw_text, avg_confidence, doc_type, result["fields"]
                )

            if needs_vision:
                print(f"[SCAN] vision retry reason={vision_reason}")
                vision_result = vision_classify_and_extract(file_bytes)
                if vision_result:
                    doc_type = vision_result.get("doc_type", doc_type)
                    class_confidence = vision_result.get("classification_confidence", class_confidence)
                    # Only show handwritten warning for prescriptions
                    handwritten = bool(vision_result.get("handwritten", False)) and doc_type == "prescription"
                    v_fields = vision_result.get("fields", {})
                    v_confidence = vision_result.get("_confidence", {})
                    # Validate through the pydantic schema
                    from app.ai.extractor import SCHEMA_MAP, MANDATORY_FIELD_CONFIDENCE_THRESHOLD
                    from pydantic import ValidationError as _VE
                    schema = SCHEMA_MAP.get(doc_type)
                    if schema:
                        try:
                            validated = schema(**v_fields)
                            final_fields = {}
                            for field_name, value in validated.model_dump().items():
                                score = v_confidence.get(field_name, 0.0)
                                # For medications, keep even low-confidence ones so UI can warn
                                if doc_type == "prescription" and field_name == "medications":
                                    final_fields[field_name] = value
                                elif isinstance(score, (int, float)) and score >= MANDATORY_FIELD_CONFIDENCE_THRESHOLD:
                                    final_fields[field_name] = value
                                else:
                                    final_fields[field_name] = None if not isinstance(value, list) else []
                            result = {"fields": final_fields, "confidence": v_confidence}
                        except _VE:
                            result = {"fields": v_fields, "confidence": v_confidence}
                    else:
                        result = {"fields": v_fields, "confidence": v_confidence}
                    raw_text = json.dumps(v_fields)  # store extracted JSON as text
                else:
                    # direct-extract failed — fallback to vision OCR text path
                    print(f"[SCAN] vision direct-extract failed, fallback=vision_ocr")
                    try:
                        from app.ai.ocr import _extract_text_vision_fallback
                        fallback_text = _extract_text_vision_fallback(file_bytes)
                    except Exception as _ve:
                        print(f"[SCAN] vision OCR fallback error (rate-limit?): {_ve}")
                        fallback_text = ""
                    if fallback_text.strip():
                        raw_text = fallback_text.strip()
                        doc_type, class_confidence = classify_document(raw_text)
                        # After vision OCR, route radiology reports to the
                        # dedicated extractor (not the generic extract_fields)
                        if doc_type == "radiology_report":
                            result = extract_radiology_fields(raw_text)
                        else:
                            result = extract_fields(doc_type, raw_text)
                    elif doc_type == "unclassified" and avg_confidence >= MIN_AVG_CONFIDENCE and len(raw_text) >= MIN_TEXT_LENGTH:
                        # Vision OCR unavailable (rate-limited) but Tesseract gave us
                        # good quality text — force LLM classification on it.
                        from app.ai.classifier import classify_llm
                        doc_type, class_confidence = classify_llm(raw_text)
                        print(f"[SCAN] LLM re-classify on tess text → {doc_type}")
                        if doc_type == "radiology_report":
                            result = extract_radiology_fields(raw_text)
                        elif doc_type != "unclassified":
                            result = extract_fields(doc_type, raw_text)

    except Exception as e:
        print(f"[ERROR] Scan pipeline failed: {e}")
        return JSONResponse(
            status_code=422,
            content={"status": "error", "message": "Couldn't read this document clearly, please retake the photo"}
        )

    # ── Radiology image guard: tell user to scan the written report instead
    if doc_type == "radiology_image":
        return JSONResponse(
            status_code=200,
            content={
                "document_id": None,
                "object_type": "radiology_image",
                "classification_confidence": class_confidence,
                "fields": {},
                "field_confidence": {},
                "handwritten": False,
                "radiology_image_warning": _RADIOLOGY_IMAGE_MSG,
            }
        )

    # ── Radiology report: dedicated extractor ──────────────────────────────
    if doc_type == "radiology_report":
        # If vision already gave us the fields (from vision_classify_and_extract path)
        # they are already in result["fields"]. Otherwise run dedicated extractor.
        if not result.get("fields"):
            result = extract_radiology_fields(raw_text)
        # Store the full structured fields as a JSON blob in extracted_text
        radiology_fields = result.get("fields", {})
        raw_text_to_store = json.dumps(radiology_fields, ensure_ascii=False)
    else:
        raw_text_to_store = raw_text
    document = Document(document_type=doc_type, extracted_text=raw_text_to_store, status="needs_review")
    db.add(document)
    db.flush()

    for field_name, value in result["fields"].items():
        db.add(ExtractedEntity(
            document_id=document.id,
            field_name=field_name,
            field_value=str(value) if value is not None else None,
            confidence_score=result["confidence"].get(field_name, 0.0),
        ))
    db.commit()

    response_payload = {
        "document_id": document.id,
        "object_type": doc_type,
        "classification_confidence": class_confidence,
        "fields": result["fields"],
        "field_confidence": result["confidence"],
        "handwritten": handwritten,
    }

    # Attach radiology-specific viewer key so the frontend can render the card
    if doc_type == "radiology_report":
        response_payload["radiology"] = _build_radiology_viewer(
            document.id, result["fields"]
        )

    return response_payload


@router.post("/emergency/setup")
def setup_emergency_profile(
    blood_group: str, allergies: str, conditions: str,
    emergency_contact: str, preferred_hospital: str, pin: str,
    db: Session = Depends(get_db),
):
    """Creates/overwrites the (single, demo) emergency profile, PIN-protected."""
    db.query(EmergencyProfile).delete()
    new_profile = EmergencyProfile(
        blood_group=blood_group, allergies=allergies, conditions=conditions,
        emergency_contact=emergency_contact, preferred_hospital=preferred_hospital,
        pin_hash=pwd_context.hash(pin),
        public_token=uuid.uuid4().hex
    )
    db.add(new_profile)
    db.commit()
    return {"status": "saved", "public_token": new_profile.public_token}


@router.post("/emergency/regenerate")
def regenerate_emergency_link(pin: str, db: Session = Depends(get_db)):
    """Issues a new public token."""
    profile = db.query(EmergencyProfile).first()
    if not profile or not pwd_context.verify(pin, profile.pin_hash):
        raise HTTPException(status_code=401, detail="Incorrect PIN")
    profile.public_token = uuid.uuid4().hex
    db.commit()
    return {"status": "regenerated", "public_token": profile.public_token}


@router.get("/emergency/{public_token}", response_class=HTMLResponse)
def public_emergency_profile(public_token: str, db: Session = Depends(get_db)):
    profile = db.query(EmergencyProfile).filter(EmergencyProfile.public_token == public_token).first()
    if not profile:
        return HTMLResponse("<h1>Profile not found</h1>", status_code=404)
        
    latest_doc = db.query(Document).filter(Document.document_type == "prescription").order_by(Document.created_at.desc()).first()
    meds_list = "No recent medications found."
    date_str = "Unknown"
    
    if latest_doc:
        date_str = latest_doc.created_at.strftime("%d-%b-%Y")
        date_entity = db.query(ExtractedEntity).filter(ExtractedEntity.document_id == latest_doc.id, ExtractedEntity.field_name == "date").first()
        if date_entity and date_entity.field_value:
            date_str = date_entity.field_value
            
        meds = db.query(ExtractedEntity).filter(
            ExtractedEntity.document_id == latest_doc.id,
            ExtractedEntity.field_name == "medications"
        ).first()
        if meds and meds.field_value:
            try:
                meds_data = json.loads(meds.field_value)
                if isinstance(meds_data, str): meds_data = json.loads(meds_data.replace("'", '"'))
                if isinstance(meds_data, list):
                    meds_list = "<ul>"
                    for m in meds_data:
                        name = m.get("name", "")
                        dose = m.get("dosage", "")
                        freq = m.get("frequency", "")
                        meds_list += f"<li><strong>{name}</strong> - {dose} ({freq})</li>"
                    meds_list += "</ul>"
            except:
                meds_list = str(meds.field_value)
                
    html = f"""
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Emergency Info</title></head>
    <body style="font-family:-apple-system,sans-serif; padding:20px; max-width:600px; margin:0 auto; background:#fff; color:#000;">
        <h1 style="color:#ef4444; text-align:center; margin-bottom: 5px;">🚨 EMERGENCY MEDICAL INFO</h1>
        <hr style="border: 1px solid #eee; margin-bottom: 20px;">
        <p style="font-size: 18px; margin: 5px 0;"><strong>Blood Group:</strong> <span style="color:#ef4444; font-weight:bold; font-size: 22px;">{profile.blood_group or '-'}</span></p>
        <p style="font-size: 18px; margin: 5px 0;"><strong>Allergies:</strong> {profile.allergies or '-'}</p>
        <p style="font-size: 18px; margin: 5px 0;"><strong>Conditions:</strong> {profile.conditions or '-'}</p>
        <hr style="border: 1px solid #eee; margin: 20px 0;">
        <h3 style="margin-bottom: 5px;">Current Medications</h3>
        <p style="font-size: 13px; color: #666; margin-top: 0; font-style: italic;">Medicines from prescription dated {date_str}</p>
        <div style="background: #f9f9f9; padding: 10px; border-radius: 8px;">
            {meds_list}
        </div>
        <hr style="border: 1px solid #eee; margin: 20px 0;">
        <div style="text-align:center; margin-top:30px;">
            <a href="tel:{profile.emergency_contact}" style="background:#ef4444; color:white; padding:15px 30px; text-decoration:none; border-radius:10px; font-size:20px; display:inline-block; font-weight: bold; width: 100%; box-sizing: border-box;">📞 Call Emergency Contact</a>
        </div>
    </body>
    </html>
    """
    return HTMLResponse(content=html)


@router.get("/emergency/{public_token}/qr")
def get_emergency_qr(public_token: str, request: Request, db: Session = Depends(get_db)):
    profile = db.query(EmergencyProfile).filter(EmergencyProfile.public_token == public_token).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Not found")
        
    base_url = os.environ.get("PUBLIC_BASE_URL", str(request.base_url).rstrip("/"))
    url = f"{base_url}/api/v1/xr/emergency/{public_token}"
    
    qr = qrcode.QRCode(version=1, box_size=10, border=4)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    
    buffered = io.BytesIO()
    img.save(buffered, format="PNG")
    img_str = base64.b64encode(buffered.getvalue()).decode()
    return {"qr_code_base64": img_str, "url": url}


@router.post("/emergency/unlock")
def unlock_emergency_profile(pin: str, db: Session = Depends(get_db)):
    """Verifies PIN, returns emergency data only if correct."""
    profile = db.query(EmergencyProfile).first()
    if not profile:
        raise HTTPException(status_code=404, detail="No emergency profile set up yet")
    if not pwd_context.verify(pin, profile.pin_hash):
        raise HTTPException(status_code=401, detail="Incorrect PIN")
        
    if not profile.public_token:
        profile.public_token = uuid.uuid4().hex
        db.commit()

    return {
        "blood_group": profile.blood_group,
        "allergies": profile.allergies,
        "conditions": profile.conditions,
        "emergency_contact": profile.emergency_contact,
        "preferred_hospital": profile.preferred_hospital,
        "public_token": profile.public_token,
    }


@router.post("/voice/transcribe")
def voice_transcribe(file: UploadFile = File(...)):
    try:
        audio_bytes = file.file.read()
        mime_type = file.content_type
        return transcribe(audio_bytes, mime_type)
    except Exception as e:
        print(f"[ERROR] Voice transcribe error: {e}")
        return {"text": "", "language": "en", "provider": "error"}

@router.post("/voice/tts")
def voice_tts(req: TTSRequest):
    try:
        return synthesize(req.text, req.language)
    except Exception as e:
        print(f"[ERROR] Voice TTS error: {e}")
        return {"provider": "browser"}

@router.post("/assistant")
def ask_assistant(question: str, language: str = "en", db: Session = Depends(get_db)):
    """Answers a question grounded only in documents scanned so far (simple RAG)."""
    documents = db.query(Document).order_by(Document.created_at.desc()).limit(10).all()
    context_data = []
    
    for doc in documents:
        if doc.document_type == "radiology_report":
            if language == "ta":
                _ensure_tamil_translations(doc, db)
            try:
                fields = json.loads(doc.extracted_text or "{}")
                context_data.append({
                    "document_type": "radiology_report",
                    "created_at": doc.created_at.isoformat(),
                    "study_name": fields.get("study_name"),
                    "modality": fields.get("modality"),
                    "study_date": fields.get("study_date"),
                    "radiologist": fields.get("radiologist"),
                    "clinical_history": fields.get("clinical_history"),
                    "impression": fields.get("impression"),
                    "overall_normal": fields.get("overall_normal", False),
                    "findings": [
                        {
                            "body_zone": f.get("body_zone"),
                            "side": f.get("side"),
                            "severity_as_written": f.get("severity_as_written"),
                            "is_normal": f.get("is_normal"),
                            "explanation_en": f.get("explanation_en"),
                            "explanation_ta": f.get("explanation_ta"),
                            "text_from_report": f.get("text_from_report"),
                        }
                        for f in (fields.get("findings") or [])
                    ],
                })
            except Exception:
                pass
        else:
            entities = db.query(ExtractedEntity).filter(ExtractedEntity.document_id == doc.id).all()
            doc_dict = {
                "document_type": doc.document_type,
                "created_at": doc.created_at.isoformat(),
                "fields": {}
            }
            for e in entities:
                if e.field_value:
                    doc_dict["fields"][e.field_name] = e.field_value
            context_data.append(doc_dict)

    context_json = json.dumps(context_data, indent=2, ensure_ascii=False)

    prompt = f"""You are NalamNet, a helpful family health & household assistant.
Answer ONLY using the document data provided.
Copy medicine names and doctor names exactly as they appear. If the answer is not in the data, say you don't have that information.
Never guess. For 'previous/last prescription' use only the most recent prescription.

UNCERTAINTY RULE: If a document was scanned from a handwritten prescription, or if any medicine has a confidence score below 0.5,
you MUST mention in your response that those medicines could not be read clearly and the patient should confirm with a doctor or pharmacist.
Never present an unclear medicine name as a confirmed fact.

RADIOLOGY RULE: For radiology_report documents, only describe what the report says using the explanation_en/explanation_ta fields. Do NOT diagnose, prognose, or advise treatment. Always end radiology answers with: "Please discuss this report with your doctor."
Critical explanation rules: keep the report's hedging exactly ('suspicious for' stays 'may be / needs more tests', never 'you have cancer'); no survival or prognosis talk; don't downplay either.

Reply in the language given: {language}. For 'ta', write display_text in simple spoken Tamil (Tamil script). Write speech_text in warm, natural spoken Tamil — the way a caring family member talks to an elderly person. Short sentences, polite forms (e.g. -ங்க endings), no formal written Tamil, no English symbols. Medicine names stay in English letters.

Output MUST be a JSON object with two keys:
1. "display_text": short simple sentences; medicines as a list, one per line, each with name + how to take it. Name in Title Case, not ALL CAPS. Flag unclear medicines with "(⚠ Unclear — confirm with doctor)".
2. "speech_text": short (max 3 sentences), no symbols, write times and doses in words (e.g. 'night 8 o'clock', 'one tablet'; in Tamil: 'இரவு 8 மணிக்கு', 'ஒரு மாத்திரை'). Expand abbreviations: TAB -> tablet, INJ -> injection, MG -> milligram, IU -> units. Example: "Diamicron XR. Take one tablet in the morning and at night, before food."

Scanned data:
{context_json}

Question ({language}): {question}
"""
    
    fallback_response = {
        "display_text": "Sorry, I couldn't answer that. Please try again.",
        "speech_text": "Sorry, I couldn't answer that. Please try again."
    }

    try:
        full_prompt = prompt
        if language == "ta":
            full_prompt += "\n\nRespond with {\"display_text\": \"...\", \"speech_text\": \"...\"}"
        raw = chat(
            messages=[{"role": "user", "content": full_prompt}],
            temperature=0.2,
            max_tokens=4096,
            response_format={"type": "json_object"},
            use_ta_chain=(language == "ta")
        )
        raw = _parse_json(raw)
        # Convert dict to string for the following json.loads block (or just assign to parsed directly)
        raw = json.dumps(raw)
    except Exception as e:
        print(f"[ASSISTANT] LLM error: {e}")
        return fallback_response

    try:
        parsed = json.loads(raw)
        if "display_text" not in parsed or "speech_text" not in parsed:
            return fallback_response
        return parsed
    except json.JSONDecodeError:
        return fallback_response


# ---------------------------------------------------------------------------
# Radiology viewer endpoints
# ---------------------------------------------------------------------------

def _load_radiology_viewer(doc: "Document", db: Session) -> dict:
    """Reconstruct viewer JSON from a stored radiology_report Document."""
    try:
        fields = json.loads(doc.extracted_text or "{}")
    except (json.JSONDecodeError, TypeError):
        fields = {}
    return _build_radiology_viewer(doc.id, fields)


def _ensure_tamil_translations(doc: "Document", db: Session):
    try:
        fields = json.loads(doc.extracted_text or "{}")
        findings = fields.get("findings", [])
        
        needs_ta = False
        for f in findings:
            if "explanation_ta" not in f or not f["explanation_ta"]:
                needs_ta = True
                break
                
        if needs_ta:
            from app.ai.radiology_extractor import generate_tamil_translations_batch
            generate_tamil_translations_batch(findings)
            fields["findings"] = findings
            doc.extracted_text = json.dumps(fields, ensure_ascii=False)
            db.commit()
    except Exception as e:
        print(f"Error generating Tamil on demand: {e}")

@router.get("/radiology/latest")
def get_latest_radiology(lang: str = "en", db: Session = Depends(get_db)):
    """
    Returns the most recently scanned radiology_report in viewer-ready JSON.
    This is what the Part 3 3D viewer will poll.
    """
    doc = (
        db.query(Document)
        .filter(Document.document_type == "radiology_report")
        .order_by(Document.created_at.desc())
        .first()
    )
    if not doc:
        raise HTTPException(status_code=404, detail="No radiology report scanned yet")
        
    if lang == "ta":
        _ensure_tamil_translations(doc, db)
        
    return _load_radiology_viewer(doc, db)


@router.get("/radiology/{document_id}")
def get_radiology_by_id(document_id: str, lang: str = "en", db: Session = Depends(get_db)):
    """
    Returns a specific radiology_report by document_id in viewer-ready JSON.
    """
    doc = db.query(Document).filter(
        Document.id == document_id,
        Document.document_type == "radiology_report",
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Radiology report not found")
        
    if lang == "ta":
        _ensure_tamil_translations(doc, db)
        
    return _load_radiology_viewer(doc, db)