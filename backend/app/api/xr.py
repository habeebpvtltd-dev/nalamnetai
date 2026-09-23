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

from app.ai import extract_text, extract_text_from_pdf, classify_document, extract_fields
from app.core.db import get_db
from app.models.document import Document, ExtractedEntity, EmergencyProfile

router = APIRouter()
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")
groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
GROQ_MODEL = "openai/gpt-oss-120b"


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
    
    try:
        raw_text = extract_text_from_pdf(file_bytes) if is_pdf else extract_text(file_bytes)
        doc_type, class_confidence = classify_document(raw_text)
        result = extract_fields(doc_type, raw_text)
    except Exception as e:
        print(f"[ERROR] Scan pipeline failed: {e}")
        return JSONResponse(
            status_code=422,
            content={"status": "error", "message": "Couldn't read this document clearly, please retake the photo"}
        )


    document = Document(document_type=doc_type, extracted_text=raw_text, status="needs_review")
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

    return {
        "document_id": document.id,
        "object_type": doc_type,
        "classification_confidence": class_confidence,
        "fields": result["fields"],
        "field_confidence": result["confidence"],
    }


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

    return {
        "blood_group": profile.blood_group,
        "allergies": profile.allergies,
        "conditions": profile.conditions,
        "emergency_contact": profile.emergency_contact,
        "preferred_hospital": profile.preferred_hospital,
        "public_token": profile.public_token,
    }


@router.post("/assistant")
def ask_assistant(question: str, db: Session = Depends(get_db)):
    """Answers a question grounded only in documents scanned so far (simple RAG)."""
    documents = db.query(Document).order_by(Document.created_at.desc()).limit(10).all()
    context_data = []
    
    for doc in documents:
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
        
    context_json = json.dumps(context_data, indent=2)

    prompt = f"""You are NalamNet, a helpful family health & household assistant.
Answer ONLY using the document data provided.
Copy medicine names and doctor names exactly as they appear. If the answer is not in the data, say you don't have that information.
Never guess. For 'previous/last prescription' use only the most recent prescription.

Output MUST be a JSON object with two keys:
1. "display_text": short simple sentences; medicines as a list, one per line, each with name + how to take it. Name in Title Case, not ALL CAPS.
2. "speech_text": plain spoken sentences for elderly listeners, no symbols, no bullets, no slashes. Expand abbreviations: TAB -> tablet, INJ -> injection, MG -> milligram, IU -> units. Example: "Diamicron XR. Take one tablet in the morning and at night, before food."

Scanned data:
{context_json}

Question: {question}
"""
    
    fallback_response = {
        "display_text": "Sorry, I couldn't answer that. Please try again.",
        "speech_text": "Sorry, I couldn't answer that. Please try again."
    }

    try:
        response = groq_client.chat.completions.create(
            model=GROQ_MODEL, 
            max_tokens=4096, 
            temperature=0.2,
            extra_body={"reasoning_effort": "low"},
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.choices[0].message.content.strip()
    except groq.BadRequestError:
        try:
            response = groq_client.chat.completions.create(
                model=GROQ_MODEL, 
                max_tokens=4096, 
                temperature=0.2,
                extra_body={"reasoning_effort": "low"},
                messages=[{"role": "user", "content": prompt}],
            )
            raw = response.choices[0].message.content.strip()
            start = raw.find("{")
            end = raw.rfind("}")
            if start != -1 and end != -1 and end >= start:
                raw = raw[start:end+1]
        except Exception:
            return fallback_response
    except Exception:
        return fallback_response

    try:
        parsed = json.loads(raw)
        if "display_text" not in parsed or "speech_text" not in parsed:
            return fallback_response
        return parsed
    except json.JSONDecodeError:
        return fallback_response