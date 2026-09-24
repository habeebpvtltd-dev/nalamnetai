"""
Document classifier: weighted keyword scoring, with Groq LLM fallback
for ambiguous cases. Covers electricity bills, prescriptions,
warranty cards, general shopping/retail bills, and radiology reports.

Scoring: each keyword has a weight (default 1). Domain-specific
high-signal terms get weight 3 so they can't be drowned out by generic
words like "bill", "amount", or "total" that appear on every document.

Radiology types:
  radiology_report  — a written radiologist report (what we explain)
  radiology_image   — the actual scan film/image (we cannot explain that)
"""
import os
import json
from app.ai.llm import chat, _parse_json

DOCUMENT_TYPES = [
    "electricity_bill", "prescription", "warranty_card", "shopping_bill",
    "radiology_report", "radiology_image", "unclassified",
]

# Each entry is (keyword, weight).  Weight 3 = strong domain signal.
WEIGHTED_KEYWORD_MAP = {
    "electricity_bill": [
        # Strong electricity-specific signals (weight 3)
        ("kwh", 3), ("units consumed", 3), ("kilo watt", 3), ("kilowatt", 3),
        ("meter reading", 3), ("previous reading", 3), ("present reading", 3),
        ("sanctioned load", 3), ("energy charges", 3), ("fixed charges", 3),
        ("tneb", 3), ("tangedco", 3), ("tnpdcl", 3), ("electricity board", 3),
        ("bi-monthly", 3), ("bimonthly", 3), ("service connection", 3),
        ("service number", 3), ("consumer number", 3), ("tariff", 3),
        # Tamil electricity terms (weight 3)
        ("மின்சாரம்", 3), ("மின் கட்டணம்", 3), ("யூனிட்", 3), ("மின்சார", 3),
        # Moderate signals (weight 1)
        ("electricity", 1), ("power", 1), ("load", 1), ("meter no", 1),
        ("eb ", 1), (" eb\n", 1), ("units", 1), ("reading", 1),
    ],
    "prescription": [
        ("rx", 3), ("dosage", 3), ("prescribed by", 3), ("prescription", 3),
        ("capsule", 2), ("tablet", 2), ("syrup", 2),
        ("mg", 1), ("doctor", 1), ("dr.", 1), ("dr ", 1), ("physician", 1), ("clinic", 1),
    ],
    "warranty_card": [
        ("warranty period", 3), ("serial number", 3), ("model number", 3),
        ("guarantee", 2), ("serial no", 2), ("model no", 2),
        ("warranty", 1), ("purchase date", 1),
    ],
    "shopping_bill": [
        # Retail-specific (weight 3)
        ("gstin", 3), ("mrp", 3), ("cashier", 3), ("hsn", 3),
        # Moderate retail (weight 2)
        ("qty", 2), ("store", 2), ("rate", 2),
        # Generic (weight 1) — not high-signal on their own
        ("invoice", 1), ("receipt", 1), ("item", 1), ("total", 1),
        ("cash bill", 1), ("bill no", 1), ("gst", 1), ("amount paid", 1),
    ],
    # ── Radiology written report (we explain this) ─────────────────────────
    "radiology_report": [
        # Ultra-strong radiology report signals (weight 5)
        ("impression:", 5), ("impression :", 5), ("findings:", 5),
        ("radiologist", 5), ("radiologist's report", 5),
        ("no evidence of", 5), ("pa view", 5), ("ap view", 4),
        ("clinical history", 4), ("clinical indication", 4),
        # Colon-free variants — Tesseract on clean PIL images sometimes drops ":"
        ("impression", 4), ("findings", 4),
        # Strong modality / technique terms (weight 3)
        ("x-ray", 3), ("xray", 3), ("mri", 3), ("magnetic resonance", 3),
        ("ct scan", 3), ("hrct", 3), ("ultrasound", 3), ("usg", 3),
        ("sonography", 3), ("radiology", 3), ("contrast", 3),
        ("sagittal", 3), ("axial", 3), ("coronal", 3),
        ("plain film", 3), ("mammogram", 3), ("fluoroscopy", 3),
        # CT-specific phrasing common in demo reports
        ("ct brain", 3), ("ct abdomen", 3), ("ct chest", 3),
        ("ct plain", 3), ("with contrast", 3),
        # Anatomy / report terms (weight 2)
        ("lobe", 2), ("vertebr", 2), ("disc", 2), ("meniscus", 2),
        ("cortex", 2), ("effusion", 2), ("consolidation", 2),
        ("cardiomegaly", 2), ("opacity", 2), ("lucency", 2),
        ("calcification", 2), ("lesion", 2), ("mass", 2),
        ("haematoma", 2), ("haemorrhage", 2), ("hemorrhage", 2),
        ("hydronephrosis", 2), ("calculus", 2),
        ("referral", 1), ("referring doctor", 1), ("study date", 1),
        ("report date", 1), ("normal study", 2), ("abnormal", 1),
    ],
    # ── Radiology scan image (warn user, do NOT explain) ───────────────────
    # Keyword scoring cannot reliably detect *images* from text alone;
    # this type is set only by the vision classifier. We include a minimal
    # keyword entry so DOCUMENT_TYPES stays consistent.
    "radiology_image": [
        ("dicom", 3), ("window width", 3), ("window level", 3),
    ],
}

# Fallback to LLM when best score is below this, OR when top two are close
CONFIDENCE_THRESHOLD = 0.08   # lowered from 0.25: keyword scores on PIL-rendered reports are 0.10-0.18
# If the runner-up score is within this fraction of the best, use LLM
AMBIGUITY_RATIO = 0.80   # i.e., second >= 80% of first → ambiguous


def classify_keyword(text: str) -> tuple[str, float, dict]:
    """
    Weighted keyword scoring against WEIGHTED_KEYWORD_MAP.
    Returns (best_type, normalised_score_0_to_1, scores_dict).
    Score is sum_of_hit_weights / sum_of_all_weights (max possible = 1.0).
    """
    text_lower = text.lower()
    scores = {}
    for doc_type, kw_list in WEIGHTED_KEYWORD_MAP.items():
        total_weight = sum(w for _, w in kw_list)
        hit_weight = sum(w for kw, w in kw_list if kw in text_lower)
        scores[doc_type] = hit_weight / total_weight if total_weight else 0.0

    sorted_types = sorted(scores, key=scores.get, reverse=True)
    best_type = sorted_types[0]
    best_score = scores[best_type]

    if best_score == 0:
        return "unclassified", 0.0, scores

    return best_type, round(best_score, 3), scores


def classify_llm(text: str) -> tuple[str, float]:
    """LLM fallback classifier, used only when keyword scoring is ambiguous."""
    prompt = f"""Classify this document text into exactly one category:
electricity_bill, prescription, warranty_card, shopping_bill,
radiology_report, or unclassified.

Rules:
- "electricity_bill": any utility electricity/power bill (TNEB, TANGEDCO, EB, etc.)
- "prescription": doctor's prescription with medicines/dosages
- "warranty_card": product warranty or guarantee card
- "shopping_bill": retail receipt, grocery bill, general invoice. Use this ONLY
  if the document is clearly a retail/grocery purchase — NOT for utility bills.
- "radiology_report": a written report from a radiologist describing findings of
  an X-ray, MRI, CT, ultrasound or other imaging study. Key signals: modality
  name (X-ray/MRI/CT/USG), clinical history, findings section, impression section,
  radiologist signature, referring doctor, date of study.
- "unclassified": cannot be determined

NOTE: "radiology_image" (the actual scan film) is detected by visual inspection
only — do NOT return it for text-based classification.

Respond ONLY with JSON: {{"type": "...", "confidence": 0.0-1.0}}

Document text:
{text[:2000]}
"""
    try:
        raw = chat(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=500,
            temperature=0,
            response_format={"type": "json_object"}
        )
        parsed = _parse_json(raw)
        doc_type = parsed.get("type", "unclassified")
        confidence = float(parsed.get("confidence", 0.0))
        if doc_type not in DOCUMENT_TYPES:
            doc_type = "unclassified"
        return doc_type, confidence
    except (json.JSONDecodeError, ValueError, Exception):
        return "unclassified", 0.0


def classify_document(text: str) -> tuple[str, float]:
    """
    Main entrypoint: weighted keyword scoring first.
    Falls back to LLM when:
      - best score is below CONFIDENCE_THRESHOLD, OR
      - the runner-up score is within AMBIGUITY_RATIO of the best (close race)
    Logs: [CLASSIFY] method=keyword|llm type=<type> scores=<top two>
    """
    text_lower = text.lower()

    # Fast heuristic: text containing clinical history + impression/findings
    # is almost certainly a radiology report — skip LLM to avoid rate-limits.
    if ("clinical history" in text_lower
            and ("impression" in text_lower or "findings" in text_lower)
            and not any(k in text_lower for k in ["kwh", "units consumed", "meter reading", "gstin", "mrp"])):
        print("[CLASSIFY] method=heuristic type=radiology_report")
        return "radiology_report", 0.90

    best_type, best_score, scores = classify_keyword(text)

    # Get top two for ambiguity check
    sorted_items = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    top2_str = ", ".join(f"{t}={s:.3f}" for t, s in sorted_items[:2])

    # Decide if LLM is needed
    use_llm = False
    if best_type == "unclassified" or best_score < CONFIDENCE_THRESHOLD:
        use_llm = True
    elif len(sorted_items) > 1:
        second_score = sorted_items[1][1]
        if second_score > 0 and second_score >= AMBIGUITY_RATIO * best_score:
            use_llm = True

    if use_llm:
        llm_type, llm_conf = classify_llm(text)
        print(f"[CLASSIFY] method=llm type={llm_type} scores={top2_str}")
        return llm_type, llm_conf

    print(f"[CLASSIFY] method=keyword type={best_type} scores={top2_str}")
    return best_type, round(best_score, 2)