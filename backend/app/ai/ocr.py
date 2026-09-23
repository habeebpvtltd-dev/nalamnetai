"""
OCR module: image preprocessing (OpenCV) + text extraction (Tesseract),
with a Groq vision-model fallback for images Tesseract struggles with
(handwritten, stylized layouts, dense tables, small/decorative fonts),
automatic EXIF orientation correction, and PDF support.
"""
import os
import io
import json
import base64
import re
import cv2
import numpy as np
import pytesseract
import fitz  # PyMuPDF, for PDF page rendering
from PIL import Image, ImageOps
from groq import Groq

# Tesseract binary: env var > Windows default > Linux/Docker PATH
_tesseract_cmd = os.environ.get("TESSERACT_CMD")
if _tesseract_cmd:
    pytesseract.pytesseract.tesseract_cmd = _tesseract_cmd
elif os.name == "nt":
    pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
# else: leave as default "tesseract" found on PATH (Linux / Docker)

groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))

# Tesseract fallback thresholds
MIN_TEXT_LENGTH = 40
MIN_AVG_CONFIDENCE = 55
# Smarter fallback trigger threshold (characters)
VISION_TEXT_LENGTH_THRESHOLD = 150

# Vision model for direct classify+extract from image.
# Override with VISION_MODEL env var (e.g. in .env) without code changes.
VISION_MODEL = os.environ.get("VISION_MODEL", "qwen/qwen3.8-27b")

# Key fields whose absence signals we need a vision retry
_KEY_FIELDS = {
    "prescription": "medications",
    "shopping_bill": "items",
    "electricity_bill": "amount",
    "warranty_card": "product_name",
}

# Document-type JSON schemas for single-shot vision extraction
_DOC_SCHEMAS = {
    "prescription": {
        "doctor_name": "string or null",
        "date": "string or null",
        "medications": [
            {"name": "string", "dosage": "string or null", "frequency": "string or null", "duration_days": "integer or null"}
        ],
        "follow_up_date": "string or null"
    },
    "electricity_bill": {
        "provider": "string or null",
        "consumer_number": "string or null",
        "service_number": "string or null",
        "billing_period": "string or null",
        "previous_reading": "number or null",
        "present_reading": "number or null",
        "units_consumed": "number or null",
        "amount_due": "number or null",
        "due_date": "string or null",
        "energy_charges": "number or null",
        "fixed_charges": "number or null"
    },
    "shopping_bill": {
        "store_name": "string or null",
        "date": "string or null",
        "items": ["string"],
        "total_amount": "number or null",
        "payment_method": "string or null"
    },
    "warranty_card": {
        "product_name": "string or null",
        "brand": "string or null",
        "purchase_date": "string or null",
        "warranty_months": "integer or null",
        "serial_number": "string or null",
        "calculated_expiry_date": "string or null"
    }
}


def _fix_orientation(image_bytes: bytes) -> bytes:
    """
    Phones store photo orientation as EXIF metadata (a 'rotate this on
    display' instruction) rather than physically rotating the pixels.
    Most image-reading code ignores that tag, so sideways/upside-down
    photos get processed as-is — this is why a portrait photo can come
    out sideways to the AI even though it looks upright in your gallery
    app. This function bakes the correct rotation into the actual pixels
    before anything else runs.
    """
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)  # applies the EXIF rotation for real
    if img.mode != "RGB":
        img = img.convert("RGB")
    output = io.BytesIO()
    img.save(output, format="JPEG", quality=95)
    return output.getvalue()


def preprocess_image(image_bytes: bytes) -> np.ndarray:
    """Grayscale -> upscale small images -> deskew -> Otsu threshold -> denoise."""
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image bytes")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    if max(h, w) < 1500:
        scale = 1500 / max(h, w)
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    deskewed = _deskew(gray)
    _, thresh = cv2.threshold(deskewed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    denoised = cv2.medianBlur(thresh, 3)
    return denoised


def _deskew(gray_img: np.ndarray) -> np.ndarray:
    inverted = cv2.bitwise_not(gray_img)
    thresh = cv2.threshold(inverted, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(thresh > 0))
    if len(coords) == 0:
        return gray_img
    angle = cv2.minAreaRect(coords)[-1]
    angle = -(90 + angle) if angle < -45 else -angle
    (h, w) = gray_img.shape[:2]
    M = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
    return cv2.warpAffine(gray_img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def _tesseract_with_confidence(processed_img: np.ndarray, lang: str) -> tuple[str, float]:
    """Runs Tesseract, returns (text, average_word_confidence 0-100)."""
    pil_img = Image.fromarray(processed_img)
    data = pytesseract.image_to_data(pil_img, lang=lang, output_type=pytesseract.Output.DICT)
    words, confidences = [], []
    for i, word in enumerate(data["text"]):
        if word.strip():
            words.append(word)
            conf = int(data["conf"][i])
            if conf >= 0:
                confidences.append(conf)
    text = " ".join(words)
    avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0
    return text, avg_confidence


def _resize_for_vision_api(image_bytes: bytes, max_dimension: int = 1600, quality: int = 85) -> tuple[bytes, int, int]:
    """
    Shrinks + compresses the image before sending to Groq's vision API.
    Native phone camera photos can be 10-15+ MB, well over Groq's request
    size limit. Text stays perfectly readable at 1600px — we don't need
    full camera resolution for OCR purposes.
    """
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")

    w, h = img.size
    if max(w, h) > max_dimension:
        scale = max_dimension / max(w, h)
        w, h = int(w * scale), int(h * scale)
        img = img.resize((w, h), Image.LANCZOS)

    output = io.BytesIO()
    img.save(output, format="JPEG", quality=quality)
    return output.getvalue(), w, h


def _extract_text_vision_fallback(image_bytes: bytes) -> str:
    """Fallback plain-text OCR via Groq's vision model for hard images."""
    resized_bytes, w, h = _resize_for_vision_api(image_bytes, 1600, 85)
    b64_image = base64.b64encode(resized_bytes).decode("utf-8")

    if len(b64_image) > 3 * 1024 * 1024:
        resized_bytes, w, h = _resize_for_vision_api(image_bytes, 1200, 75)
        b64_image = base64.b64encode(resized_bytes).decode("utf-8")

    print(f"[OCR] Vision payload: {len(b64_image)//1024} KB, {w}x{h}")

    response = groq_client.chat.completions.create(
        model=VISION_MODEL,
        max_tokens=1500,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": (
                    "Read every piece of text visible in this image, exactly as written. "
                    "Include labels, numbers, dates, and table values. "
                    "Output plain text only, preserving reading order top to bottom. "
                    "Do not summarize or explain — just transcribe the text."
                )},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
            ],
        }],
    )
    raw_text = response.choices[0].message.content.strip()
    raw_text = re.sub(r'<think>.*?</think>', '', raw_text, flags=re.DOTALL).strip()
    print(f"[OCR] Vision output: {raw_text[:300]}")
    return raw_text


def vision_classify_and_extract(image_bytes: bytes) -> dict | None:
    """
    Single-shot vision extraction: sends the image directly to Llama 4 Scout
    and asks it to classify the document AND extract all fields in one call.
    Returns a dict with keys: doc_type, fields, confidence, handwritten.
    Returns None on failure.

    This is used instead of image->text->LLM when Tesseract struggles.
    Uses Llama 4 Scout (meta-llama/llama-4-scout-17b-16e-instruct) — the
    most capable natively multimodal model on Groq for handwriting tasks.
    """
    resized_bytes, w, h = _resize_for_vision_api(image_bytes, 1600, 85)
    b64_image = base64.b64encode(resized_bytes).decode("utf-8")

    if len(b64_image) > 3 * 1024 * 1024:
        resized_bytes, w, h = _resize_for_vision_api(image_bytes, 1200, 75)
        b64_image = base64.b64encode(resized_bytes).decode("utf-8")

    print(f"[OCR] Vision direct-extract payload: {len(b64_image)//1024} KB, {w}x{h}")

    schemas_json = json.dumps(_DOC_SCHEMAS, indent=2)
    prompt = f"""You are a medical document extraction specialist. Look at this image carefully.

STEP 1 — Classify: determine the document type. Choose exactly one:
  electricity_bill | prescription | warranty_card | shopping_bill | unclassified

STEP 2 — Extract: extract all fields using the schema for the detected type:
{schemas_json}

SAFETY RULES (mandatory):
- If a word is not clearly readable, return it exactly as seen with field confidence below 0.5.
- Never replace an unclear word with a similar-looking real medicine name.
- Never invent doses or timings that are not explicitly written in the document.
- Medicine names must appear in the document; do NOT guess common brand names.

STEP 3 — Assess: set "handwritten" to true ONLY if the main content (medicine names, items, doses, or quantities) is physically written by hand — NOT printed, typed, or computer-generated. A printed pharmacy label, printed bill, or typed receipt is NOT handwritten even if it has a handwritten signature or stamp. Set false for all printed documents.

Respond ONLY with a single JSON object with this exact structure:
{{
  "doc_type": "<one of the five types>",
  "classification_confidence": <0.0-1.0>,
  "handwritten": <true|false>,
  "fields": {{ <fields matching the schema for doc_type> }},
  "_confidence": {{ "<field_name>": <0.0-1.0>, ... }}
}}

For prescription medications, "_confidence" should include per-medication confidence like:
"_confidence": {{ "medications": 0.8, "medications_0_name": 0.9, "medications_0_dosage": 0.4 }}

If the document is unclassified, return "fields": {{}} and "_confidence": {{}}.
"""

    try:
        response = groq_client.chat.completions.create(
            model=VISION_MODEL,
            max_tokens=2000,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
                ],
            }],
        )
        raw = response.choices[0].message.content.strip()
        # Strip any <think> blocks (reasoning models)
        raw = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()
        # Extract JSON
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start:end+1]
        parsed = json.loads(raw)
        print(f"[OCR] Vision direct-extract result: type={parsed.get('doc_type')} handwritten={parsed.get('handwritten')}")
        return parsed
    except Exception as e:
        print(f"[ERROR] Vision direct-extract failed: {e}")
        return None


def _key_fields_missing(doc_type: str, fields: dict) -> bool:
    """Returns True if the critical field for this doc type is absent/empty."""
    key = _KEY_FIELDS.get(doc_type)
    if not key:
        return False
    val = fields.get(key)
    if val is None:
        return True
    if isinstance(val, list) and len(val) == 0:
        return True
    return False


def check_vision_needed(
    text: str,
    avg_confidence: float,
    doc_type: str,
    fields: dict,
) -> tuple[bool, str]:
    """
    Decide whether the vision direct-extract path should be triggered.
    Returns (should_use_vision, reason_string).
    """
    if avg_confidence < MIN_AVG_CONFIDENCE:
        return True, f"tesseract_confidence={avg_confidence:.1f}<{MIN_AVG_CONFIDENCE}"
    if len(text) < VISION_TEXT_LENGTH_THRESHOLD:
        return True, f"text_length={len(text)}<{VISION_TEXT_LENGTH_THRESHOLD}"
    if doc_type == "unclassified":
        return True, "classification=unclassified"
    if _key_fields_missing(doc_type, fields):
        return True, f"key_fields_missing_for_{doc_type}"
    return False, ""


def extract_text(image_bytes: bytes, lang: str = "eng+tam") -> str:
    """
    Main entrypoint for images: correct orientation, try Tesseract first
    (fast, free). If the result is too short or too low-confidence, fall
    back to the Groq vision model for plain-text OCR.
    """
    image_bytes = _fix_orientation(image_bytes)
    processed = preprocess_image(image_bytes)
    text, avg_confidence = _tesseract_with_confidence(processed, lang)
    print(f"[OCR] Tesseract confidence: {avg_confidence:.1f}, length: {len(text)}")

    if len(text) < MIN_TEXT_LENGTH or avg_confidence < MIN_AVG_CONFIDENCE:
        print("[OCR] Falling back to Groq vision model (plain text)...")
        text = _extract_text_vision_fallback(image_bytes)

    return text.strip()


def extract_text_from_pdf(pdf_bytes: bytes, lang: str = "eng+tam") -> str:
    """
    Renders each PDF page as an image, then runs it through the SAME
    extract_text() pipeline used for photos (Tesseract -> Groq fallback).
    Capped at 5 pages so a large PDF can't stall the demo.
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page_texts = []
    for page_num in range(min(len(doc), 5)):
        page = doc[page_num]
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))  # 2x zoom = sharper text
        img_bytes = pix.tobytes("jpeg")
        page_texts.append(extract_text(img_bytes, lang=lang))
    doc.close()
    return "\n".join(page_texts)