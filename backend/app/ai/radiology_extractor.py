"""
Radiology report extraction: Pydantic schemas + Groq LLM.
Extracts structured findings from a radiologist's written report,
maps each finding to a fixed body zone, and validates zone ids.

SAFETY BOUNDARIES:
- We explain the radiologist's WRITTEN report only.
- We never interpret scan images and never diagnose.
- body_zone is only set when the report explicitly names the body part.
- side (left/right) is only set when the report explicitly states it.
- Severity uses only the report's own words; never inferred.
- Explanations are plain-language paraphrases of what the report says.
  No prognosis, no treatment advice, no alarming language.
"""
from __future__ import annotations

import os
import time
import uuid
import httpx
import json
from typing import Literal, Optional

from pydantic import BaseModel, Field, ValidationError
from app.ai.llm import chat, _parse_json

from app.ai.body_zones import VALID_ZONE_IDS
from app.ai.tamil_medical_glossary import TAMIL_MEDICAL_GLOSSARY


# ---------------------------------------------------------------------------
# Pydantic schema
# ---------------------------------------------------------------------------

class RadiologyFinding(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    text_from_report: str                          # copied exactly from the report
    body_zone: Optional[str] = None               # one of VALID_ZONE_IDS or null
    side: Literal["left", "right", "both", "not_stated", "not_applicable"] = "not_stated"
    severity_as_written: str = "not_stated"        # report's own word; never inferred
    severity_level: Literal["mild", "moderate", "severe", "unknown"] = "unknown"
    is_normal: bool = False
    explanation_en: str = ""                       # 1-2 simple sentences in English
    explanation_ta: str = ""                       # 1-2 simple sentences in Tamil
    location_detail: Optional[str] = None          # extracted from specific validation lists


class RadiologyReportFields(BaseModel):
    modality: Literal["xray", "mri", "ct", "ultrasound", "other"] = "other"
    study_name: Optional[str] = None
    study_date: Optional[str] = None
    referring_doctor: Optional[str] = None
    radiologist: Optional[str] = None
    clinical_history: Optional[str] = None
    findings: list[RadiologyFinding] = Field(default_factory=list)
    impression: Optional[str] = None
    overall_normal: bool = False
    is_critical: bool = False


# ---------------------------------------------------------------------------
# Body-zone lookup helpers
# ---------------------------------------------------------------------------

# Natural language aliases → canonical zone id.
# These supplement the LLM's direct zone selection for common alternate names.
_ZONE_ALIASES: dict[str, str] = {
    "right lower lobe": "chest_lung_right",
    "left lower lobe": "chest_lung_left",
    "right upper lobe": "chest_lung_right",
    "left upper lobe": "chest_lung_left",
    "right lung": "chest_lung_right",
    "left lung": "chest_lung_left",
    "l4-l5": "lumbar_spine",
    "l5-s1": "lumbar_spine",
    "l3-l4": "lumbar_spine",
    "lumbar": "lumbar_spine",
    "lumbosacral": "lumbar_spine",
    "cervical": "cervical_spine",
    "thoracic": "thoracic_spine",
    "fronto-parietal": "head_brain",
    "ventricles": "head_brain",
    "costophrenic angle": None,  # Needs side to determine left or right
    "knee": None,           # side-dependent; handled by side field
    "meniscus": None,
}


def _validate_zone(zone: Optional[str]) -> Optional[str]:
    """Return the zone id if valid, else None (and log it)."""
    if zone is None:
        return None
    if zone in VALID_ZONE_IDS:
        return zone
    # Try alias lookup
    alias = _ZONE_ALIASES.get(zone.lower())
    if alias is not None:
        return alias
    # Invalid — drop and log
    print(f"[RADIOLOGY] invalid zone dropped: {zone!r}")
    return None


def _map_severity(severity_as_written: str, text_from_report: str = "") -> Literal["mild", "moderate", "severe", "unknown"]:
    """Maps the raw severity to one of the 4 strict categories based on severity field and finding text."""
    sev = (severity_as_written or "").lower().strip()
    if sev in ["mild", "moderate", "severe"]:
        return sev
    if sev in ["grade i", "grade 1"]: return "mild"
    if sev in ["grade ii", "grade 2"]: return "moderate"
    if sev in ["grade iii", "grade 3"]: return "severe"
    
    combined = f"{severity_as_written or ''} {text_from_report}".lower()
    
    # If the finding is negated, it's not severe.
    if any(w in combined for w in ["no evidence of", "no ", "negative for"]):
        return "unknown"
        
    if any(w in combined for w in ["severe", "large", "complete", "acute", "significant"]):
        return "severe"
    if "moderate" in combined:
        return "moderate"
    if any(w in combined for w in ["mild", "small", "minimal"]):
        return "mild"
        
    return "unknown"


# ---------------------------------------------------------------------------
# Extraction prompt
# ---------------------------------------------------------------------------

_ZONE_LIST_STR = ", ".join(sorted(VALID_ZONE_IDS))

_RADIOLOGY_PROMPT_TEMPLATE = """You are a medical language assistant. Your job is to extract structured data from a radiologist's WRITTEN REPORT — NOT from a scan image. You explain what the report says; you do NOT diagnose.

SAFETY RULES (mandatory — never violate):
1. Map body_zone to the closest matching VALID body_zone id. If the report names a sub-part (e.g. 'costophrenic angle' or 'lobe' -> 'chest_lung_right'/'chest_lung_left', 'fronto-parietal' or 'ventricles' -> 'head_brain'), map it to the parent organ's zone id. If completely unsure, set body_zone to null.
2. Set side to "left" or "right" ONLY if the report explicitly says so. For paired organs with no side stated, use side="not_stated". NEVER guess a side.
3. severity_as_written: copy the report's own word (mild / moderate / severe / small / large / normal / not_stated). NEVER infer severity beyond what the report says.
4. explanation_en: describe what the report says in 1-2 simple sentences. MUST NOT add anything the report doesn't say. Replace medical terms with plain words using the JARGON REPLACEMENTS below. You MUST preserve the radiologist's exact level of certainty (e.g. if they say "suspicious for cancer", say "suspicious for cancer"; if they say "possible tumor", say "possible tumor"). Do not soften or strengthen their words. Explanations must contain ONLY facts in text_from_report.
5. is_normal: true ONLY for findings that are explicitly stated as normal (e.g. "no abnormality", "unremarkable", "intact", "centrally placed", "normal", "within normal limits", "clear") OR negated findings (e.g. "no evidence of...", "no haemorrhage", "no midline shift").
6. For overall_normal: set true if the impression says it is a normal study AND ALL findings are normal or negated.
7. is_critical: true if report uses words like: acute haemorrhage, bleed, midline shift, pneumothorax, fracture of spine/skull, mass or lesion suspicious for malignancy/neoplasm, "urgent", "critical", "immediate", "emergency", or if urgent referral is recommended. IMPORTANT: You MUST ignore NEGATED phrases (e.g. "no haemorrhage", "no midline shift", "no evidence of bleed", "negative for malignancy"). If the critical word is negated, is_critical remains false.
8. location_detail: Add exact location string ONLY if stated in the report, validated against these lists (else null):
   - lungs: upper_lobe | middle_lobe | lower_lobe | costophrenic_angle
   - spine: exact level (e.g. "L4-L5", "C5-C6", "T12")
   - knee: medial | lateral | anterior | posterior or combined (e.g. "medial_posterior")
   - kidney: upper_pole | mid | lower_pole
   - brain: frontal | parietal | temporal | occipital or combinations (e.g. "fronto_parietal")
   - liver: right_lobe | left_lobe

JARGON REPLACEMENTS (Use these exact phrases in your explanation instead of the medical term):
- subdural haematoma -> a collection of blood between the brain and its outer covering
- midline shift -> the brain is pushed towards one side
- ventricles -> fluid spaces inside the brain
- consolidation -> an area of the lung that looks dense
- costophrenic angle -> the lower edge of the lung
- joint effusion -> fluid in the joint
- meniscus -> the cushion inside the knee
- posterior horn -> back part
- medial -> inner side
- femoral condyle -> the lower end of the thigh bone
- articular cartilage -> the smooth covering of the joint
- disc bulge -> the disc between the bones is bulging slightly
- desiccation -> drying of the disc
- facet arthropathy -> wear in the small joints of the spine
- calculus -> stone
- hydronephrosis -> swelling of the kidney
- spiculated mass suspicious for neoplasm -> a lump with uneven edges; the report says more tests are needed to find out what it is
- lymph nodes -> small glands
- ligament sprain -> a stretch injury of the ligament

VALID body_zone ids (use ONLY these, or null):
{zone_list}

VALID side values: left, right, both, not_stated, not_applicable
VALID modality values: xray, mri, ct, ultrasound, other

Respond ONLY with a single JSON object matching this exact schema:
{{
  "modality": "xray|mri|ct|ultrasound|other",
  "study_name": "string or null",
  "study_date": "string or null",
  "referring_doctor": "string or null",
  "radiologist": "string or null",
  "clinical_history": "string or null",
  "findings": [
    {{
      "id": "short unique string e.g. f1, f2, ...",
      "text_from_report": "exact quote from report",
      "body_zone": "one of the valid zone ids, or null",
      "side": "left|right|both|not_stated|not_applicable",
      "severity_as_written": "report's own word or not_stated",
      "is_normal": true or false,
      "explanation_en": "1-2 simple English sentences explaining what the report says",
      "location_detail": "exact location string from validation lists, or null"
    }}
  ],
  "impression": "exact copy of the Impression section text, or null",
  "overall_normal": true or false,
  "is_critical": true or false,
  "_confidence": {{
    "modality": 0.0-1.0,
    "study_name": 0.0-1.0,
    "study_date": 0.0-1.0,
    "findings": 0.0-1.0,
    "impression": 0.0-1.0
  }}
}}

Radiology report text:
{text}
"""

_TRANSLATE_PROMPT_TEMPLATE = """Explain the MEANING of this medical finding in simple spoken Tamil, as a caring family member would explain to an elderly person. Do NOT translate word by word. Do NOT write English words in Tamil letters (no மீடியல், போஸ்டீரியர், ஃப்ளூயிட், ஹெர்னியேஷன்). Only these may stay in English: vertebra levels like L4-L5, medicine names, and numbers. Leave out imaging jargon like 'signal' or 'intensity' completely. Use the glossary terms naturally inside sentences, not pasted as-is.

APPROVED GLOSSARY:
{glossary}

INPUT ENGLISH TEXT:
{english_explanation}

Respond ONLY with the translated Tamil string in plain text, nothing else. Do not use JSON.
"""


# ---------------------------------------------------------------------------
# Main extraction function
# ---------------------------------------------------------------------------

def extract_radiology_fields(text: str) -> dict:
    """
    Extract structured radiology fields from a report's text.
    Returns {"fields": RadiologyReportFields dict, "confidence": {...}}.
    After LLM call, any body_zone not in VALID_ZONE_IDS is set to null.
    """
    # OCR Cleanup
    import re
    text = text.replace("Grade |", "Grade I").replace("grade |||", "grade III").replace("grade ||", "grade II")
    # Fix single capital letters stuck to words: Amoderate -> A moderate, A3 cm -> A 3 cm
    text = re.sub(r'\b([A-Z])([a-z0-9])', r'\1 \2', text)

    prompt = _RADIOLOGY_PROMPT_TEMPLATE.format(
        zone_list=_ZONE_LIST_STR,
        text=text[:4000],
    )

    raw = ""
    try:
        raw = chat(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=4096,
            response_format={"type": "json_object"}
        )
        parsed = _parse_json(raw)
    except Exception as e:
        print(f"[RADIOLOGY EXTRACT] Main error: {e}")
        return {"fields": {}, "confidence": {}}

    print(f"[RADIOLOGY EXTRACT] raw keys={list(parsed.keys())}")

    confidence_scores = parsed.pop("_confidence", {})

    # Validate body_zone for every finding BEFORE Pydantic validation
    raw_findings = parsed.get("findings", [])
    for f in raw_findings:
        f["body_zone"] = _validate_zone(f.get("body_zone"))
        if "severity_as_written" in f and isinstance(f["severity_as_written"], str):
            f["severity_as_written"] = f["severity_as_written"].lower()
        f["severity_level"] = _map_severity(f.get("severity_as_written", ""), f.get("text_from_report", ""))

    # 1. Verify English explanations for faithfulness and plain words
    # 2. Tamil generation is deferred to on-demand requests
    _verify_english_explanations(raw_findings, text)

    # Fallback keyword check for is_critical in case LLM missed it.
    # IMPORTANT: negated phrases must NOT trigger is_critical.
    # Examples that must NOT trigger: "no haemorrhage", "no midline shift",
    # "no evidence of neoplasm", "negative for malignancy".
    import re

    _CRITICAL_KEYWORDS = [
        "neoplasm", "malignancy", "biopsy", "urgent",
        "haematoma", "hemorrhage", "haemorrhage",
        "bleed", "midline shift", "pneumothorax",
        "spinal fracture", "skull fracture",
        "suspicious for", "emergency", "immediate",
    ]

    # Negation prefixes that invalidate a keyword hit within the same clause.
    # We allow up to ~6 words between the negation word and the keyword.
    _NEGATION_RE = re.compile(
        r'\b(?:no|not|without|absent|absence\s+of|negative\s+for|no\s+evidence\s+of'
        r'|no\s+sign\s+of|no\s+signs\s+of|no\s+features?\s+of)\b'
        r'(?:\s+\S+){0,6}\s*'
    )

    def _keyword_negated(sentence: str, keyword: str) -> bool:
        """Return True if every occurrence of keyword in sentence is preceded
        by a negation phrase within the same clause."""
        kw_re = re.compile(r'\b' + re.escape(keyword))
        for m in kw_re.finditer(sentence):
            # Look at the text *before* this keyword hit (within the sentence)
            prefix = sentence[:m.start()]
            # Find all negation phrases and check if any covers this keyword
            neg_hits = list(_NEGATION_RE.finditer(prefix))
            if not neg_hits:
                return False  # no negation → keyword is positive
            # The closest preceding negation must end close to the keyword
            last_neg = neg_hits[-1]
            gap = m.start() - last_neg.end()
            if gap > 50:          # negation is too far away
                return False
        return True  # all occurrences are negated

    is_critical_flag = False
    # Split on sentence-ending punctuation to get individual clauses
    clauses = re.split(r'[.;!?\n]', text.lower())
    for clause in clauses:
        clause = clause.strip()
        if not clause:
            continue
        for kw in _CRITICAL_KEYWORDS:
            if kw in clause:
                if not _keyword_negated(clause, kw):
                    is_critical_flag = True
                    break
        if is_critical_flag:
            break

    parsed["is_critical"] = is_critical_flag

    try:
        validated = RadiologyReportFields(**parsed)
    except ValidationError as e:
        print(f"[RADIOLOGY EXTRACT] ValidationError: {e}")
        return {"fields": {}, "confidence": {}}

    return {"fields": validated.model_dump(), "confidence": confidence_scores}


def _faithfulness_check(report_text: str, explanation: str, full_report: str) -> str | None:
    if not report_text:
        return None
    if not explanation:
        return "Explanation is empty"
    
    report_lower = report_text.lower()
    exp_lower = explanation.lower()
    full_report_lower = full_report.lower()

    # 1. Same facts / Plain words: if it exactly matches the medical text, it's not 'plain'
    if exp_lower.strip() == report_lower.strip():
        return "Explanation is identical to report text"

    # 2. Side check
    for side in ["left", "right", "bilateral"]:
        if side in report_lower and side not in exp_lower:
            return f"Missing side '{side}'"
                
    # Opposite side check
    if "left" in report_lower and "right" not in report_lower and "right" in exp_lower:
        return "Opposite side 'right' added"
    if "right" in report_lower and "left" not in report_lower and "left" in exp_lower:
        return "Opposite side 'left' added"

    # 3. Severity check
    for sev in ["mild", "moderate", "severe"]:
        if sev in report_lower and sev not in exp_lower:
            return f"Missing severity '{sev}'"

    # 4. Forbid reassurance
    reassurances = [
        "nothing to worry", "don't worry", "no need to worry", "harmless", 
        "nothing to worry about"
    ]
    for r in reassurances:
        if r in exp_lower and r not in report_lower:
            return f"Hallucinated reassurance: '{r}'"

    # 5. NO NEW MEDICAL CLAIMS
    diagnosis_words = [
        "effusion", "infection", "pneumonia", "cancer", "tumour", "tumor", 
        "malignant", "malignancy", "fracture", "stroke", "bleeding", 
        "blockage", "obstruction", "tuberculosis", "heart attack"
    ]
    for word in diagnosis_words:
        if word in exp_lower and word not in full_report_lower:
            return f"New medical claim added: '{word}'"

    # 6. Jargon check (plain English)
    jargon = [
        "subdural haematoma", "midline shift", "ventricles", "consolidation",
        "costophrenic angle", "joint effusion", "meniscus", "posterior horn",
        "medial", "femoral condyle", "articular cartilage", "disc bulge",
        "desiccation", "facet arthropathy", "calculus", "hydronephrosis",
        "spiculated mass", "neoplasm", "lymph nodes", "ligament sprain"
    ]
    for term in jargon:
        if term in exp_lower and term in report_lower: # Only warn if it's copied from report without replacement
            return f"JARGON {term}"

    return None

def _verify_english_finding(finding: dict, full_report: str):
    text_from_report = finding.get("text_from_report", "")
    if not text_from_report:
        return

    exp_en = finding.get("explanation_en", "")
    for attempt in range(2):
        fail_reason = _faithfulness_check(text_from_report, exp_en, full_report)
        if not fail_reason:
            break
            
        print(f"[FAITHFULNESS] EN fail reason={fail_reason} attempt={attempt+1}")
        
        # If it's just jargon, we log it and keep the result anyway if it's the 2nd attempt
        if fail_reason.startswith("JARGON"):
            print(f"[PLAIN] jargon={fail_reason.split('JARGON ')[1]}")
            if attempt == 1:
                break # keep the text with jargon
            
        if attempt == 0:
            if fail_reason.startswith("JARGON"):
                prompt = f"Rewrite this explanation by replacing the medical term '{fail_reason.split('JARGON ')[1]}' with simple everyday words. Exactly preserve side and severity. Report: '{text_from_report}'. Bad explanation: '{exp_en}'."
            else:
                prompt = f"Rewrite this explanation in simple, everyday words. Exactly preserve side and severity. Do NOT add facts, reassurances, or medical claims like '{fail_reason.split(':')[-1].strip()}'. Report: '{text_from_report}'. Bad explanation: '{exp_en}'."
            try:
                exp_en = chat(messages=[{"role": "user", "content": prompt}], max_tokens=100).strip()
            except Exception:
                exp_en = "" # Force empty so it fails the next check and uses the fallback template
        else:
            clean_text = text_from_report.strip()
            if clean_text.endswith("."):
                clean_text = clean_text[:-1]
            exp_en = f"The report says: {clean_text}. Please discuss this with your doctor."
            
    finding["explanation_en"] = exp_en
    finding["location_detail"] = _derive_location_detail(finding)

def _derive_location_detail(finding: dict) -> str | None:
    if finding.get("location_detail"):
        return finding["location_detail"]
    
    zone = finding.get("body_zone") or ""
    text = finding.get("text_from_report", "").lower()
    
    if zone.startswith("knee"):
        parts = []
        if "medial" in text: parts.append("medial")
        elif "lateral" in text: parts.append("lateral")
        if "anterior" in text: parts.append("anterior")
        elif "posterior" in text: parts.append("posterior")
        if parts: return "_".join(parts)
        
    elif zone.startswith("chest"):
        if "upper lobe" in text: return "upper_lobe"
        if "middle lobe" in text: return "middle_lobe"
        if "lower lobe" in text: return "lower_lobe"
        if "costophrenic angle" in text: return "costophrenic_angle"
        
    elif zone.endswith("spine"):
        import re
        match = re.search(r'\b([clt]\d{1,2}(?:-[clt]\d{1,2})?)\b', text)
        if match: return match.group(1).upper()
        
    elif zone.startswith("kidney"):
        if "upper pole" in text: return "upper_pole"
        if "lower pole" in text: return "lower_pole"
        if "mid" in text: return "mid"
        
    elif zone == "head_brain":
        parts = []
        if "front" in text: parts.append("frontal")
        if "parietal" in text: parts.append("parietal")
        if "temporal" in text: parts.append("temporal")
        if "occipital" in text: parts.append("occipital")
        if parts: return "_".join(parts)
        
    elif zone == "liver":
        if "right lobe" in text: return "right_lobe"
        if "left lobe" in text: return "left_lobe"
        
    return None

def _verify_english_explanations(findings: list[dict], full_report: str):
    for f in findings:
        _verify_english_finding(f, full_report)

def generate_tamil_translations_batch(findings: list[dict]):
    """Translates all findings in one batch LLM call."""
    if not findings:
        return
    glossary_str = "\n".join(f"- {k}: {v}" for k, v in TAMIL_MEDICAL_GLOSSARY.items())
    
    # Extract explanations that need translation
    to_translate = []
    for i, f in enumerate(findings):
        if "explanation_ta" not in f or not f["explanation_ta"]:
            to_translate.append((i, f.get("explanation_en", "")))
            
    if not to_translate:
        return
        
    prompt = f"""You are a medical translator. Translate these short medical explanations from English to plain, spoken Tamil (Tamil script).
Use simple words that an elderly person understands.
Glossary to use:
{glossary_str}

Respond ONLY with a numbered list matching the input numbers. Do not include English text, just the Tamil translations.

Input:
"""
    for idx, (original_idx, text) in enumerate(to_translate):
        prompt += f"{idx+1}. {text}\n"
        
    try:
        response = chat(messages=[{"role": "user", "content": prompt}], temperature=0.1, max_tokens=1500, use_ta_chain=True).strip()
        lines = response.split('\n')
        # Simple extraction by numbering
        result_map = {}
        for line in lines:
            line = line.strip()
            if not line: continue
            if '.' in line:
                parts = line.split('.', 1)
                if parts[0].isdigit():
                    result_map[int(parts[0])] = parts[1].strip()
                    
        for idx, (original_idx, text) in enumerate(to_translate):
            translated = result_map.get(idx + 1, "")
            if not translated:
                translated = f"{text} (Tamil explanation not available)"
            findings[original_idx]["explanation_ta"] = translated
            
    except Exception as e:
        print(f"[LLM-TA] Batch translation failed: {e}")
        for idx, (original_idx, text) in enumerate(to_translate):
            findings[original_idx]["explanation_ta"] = f"{text} (Tamil explanation not available)"

# ---------------------------------------------------------------------------
# Vision schema for radiology (for OCR.py vision path)
# ---------------------------------------------------------------------------

RADIOLOGY_VISION_SCHEMA = {
    "modality": "xray|mri|ct|ultrasound|other",
    "study_name": "string or null",
    "study_date": "string or null",
    "referring_doctor": "string or null",
    "radiologist": "string or null",
    "clinical_history": "string or null",
    "findings": [
        {
            "id": "f1",
            "text_from_report": "string",
            "body_zone": "zone_id or null",
            "side": "left|right|both|not_stated|not_applicable",
            "severity_as_written": "string or not_stated",
            "is_normal": "boolean",
            "explanation_en": "string",
            "explanation_ta": "string or null",
            "location_detail": "string or null"
        }
    ],
    "impression": "string or null",
    "overall_normal": "boolean",
    "is_critical": "boolean"
}
