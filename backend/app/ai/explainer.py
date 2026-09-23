"""
Plain-language explainer: turns verified structured data into a simple
summary, in English or Tamil.
"""
import os
from groq import Groq

client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
GROQ_MODEL = "openai/gpt-oss-120b"

MEDICAL_DISCLAIMER_EN = "Not a medical diagnosis. Confirm with a qualified healthcare professional."
MEDICAL_DISCLAIMER_TA = "இது ஒரு மருத்துவ நோய் கண்டறிதல் அல்ல. தகுதிவாய்ந்த மருத்துவரை அணுகவும்."


def explain_document(document_type: str, verified_fields: dict, language: str = "en") -> str:
    """Only call with VERIFIED fields — never raw unverified extraction output."""
    lang_name = "Tamil" if language == "ta" else "English"

    prompt = f"""Summarize this {document_type} information in ONE short, simple paragraph
in {lang_name}, for someone with no technical background. Be warm and clear.
Do not invent any information not given below.

Data: {verified_fields}
"""
    response = client.chat.completions.create(
        model=GROQ_MODEL,
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    summary = response.choices[0].message.content.strip()

    if document_type == "prescription":
        disclaimer = MEDICAL_DISCLAIMER_TA if language == "ta" else MEDICAL_DISCLAIMER_EN
        summary = f"{summary}\n\n⚠️ {disclaimer}"

    return summary