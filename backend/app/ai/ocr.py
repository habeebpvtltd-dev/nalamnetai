"""
OCR module: image preprocessing (OpenCV) + text extraction (Tesseract),
with a Groq vision-model fallback for images Tesseract struggles with
(stylized layouts, dense tables, small/decorative fonts), automatic
EXIF orientation correction, and PDF support.
"""
import os
import io
import base64
import cv2
import numpy as np
import pytesseract
import fitz  # PyMuPDF, for PDF page rendering
import re
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
VISION_MODEL = "qwen/qwen3.8-27b"

MIN_TEXT_LENGTH = 40
MIN_AVG_CONFIDENCE = 55


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
    """Fallback OCR via Groq's multimodal vision model for hard images."""
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


def extract_text(image_bytes: bytes, lang: str = "eng+tam") -> str:
    """
    Main entrypoint for images: correct orientation, try Tesseract first
    (fast, free). If the result is too short or too low-confidence, fall
    back to the Groq vision model.
    """
    image_bytes = _fix_orientation(image_bytes)
    processed = preprocess_image(image_bytes)
    text, avg_confidence = _tesseract_with_confidence(processed, lang)
    print(f"[OCR] Tesseract confidence: {avg_confidence:.1f}, length: {len(text)}")

    if len(text) < MIN_TEXT_LENGTH or avg_confidence < MIN_AVG_CONFIDENCE:
        print("[OCR] Falling back to Groq vision model...")
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