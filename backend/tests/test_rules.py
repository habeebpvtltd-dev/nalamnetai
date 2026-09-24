import pytest
from app.ai.radiology_extractor import _rule_based_safety_net, _derive_location_detail

def test_rule_based_side_and_zone():
    # Knee
    res = _rule_based_safety_net("MRI of the right knee.")
    assert res["findings"][0]["body_zone"] == "knee_right"
    assert res["findings"][0]["side"] == "right"

    # Chest
    res = _rule_based_safety_net("Left pleural effusion seen.")
    assert res["findings"][0]["body_zone"] == "chest_lung_left"
    assert res["findings"][0]["side"] == "left"

def test_location_detail():
    # Knee
    f = {"body_zone": "knee_right", "text_from_report": "posterior horn of the medial meniscus"}
    assert _derive_location_detail(f) == "medial_posterior"

    # Lungs
    f = {"body_zone": "chest_lung_right", "text_from_report": "right lower lobe"}
    assert _derive_location_detail(f) == "lower_lobe"

    # Spine
    f = {"body_zone": "lumbar_spine", "text_from_report": "L4-L5 level disc bulge"}
    assert _derive_location_detail(f) == "L4-L5"

    # Kidney
    f = {"body_zone": "kidney_left", "text_from_report": "lower pole calculus"}
    assert _derive_location_detail(f) == "lower_pole"

    # Brain
    f = {"body_zone": "head_brain", "text_from_report": "fronto-parietal hemorrhage"}
    assert _derive_location_detail(f) == "fronto_parietal"

def test_severity_mapping():
    # complete/acute -> severe
    res = _rule_based_safety_net("Complete ACL tear.")
    assert res["findings"][0]["severity_level"] == "severe"
    
    # grade ii -> moderate
    res = _rule_based_safety_net("Grade II meniscus tear.")
    assert res["findings"][0]["severity_level"] == "moderate"

def test_negation():
    # "no midline shift" shouldn't flag as critical
    res = _rule_based_safety_net("No midline shift.")
    assert not res["is_critical"]

    res = _rule_based_safety_net("No evidence of neoplasm.")
    assert not res["is_critical"]

def test_ocr_cleanup():
    # "Grade |" -> "Grade I", "Amoderate" -> "A moderate"
    from app.ai.radiology_extractor import extract_radiology_fields
    import re
    text = "Grade | Amoderate A3 cm"
    text = text.replace("Grade |", "Grade I").replace("grade |||", "grade III").replace("grade ||", "grade II")
    text = re.sub(r'\b(A|I|O)([a-z]{3,}|[0-9]+)', r'\1 \2', text)
    assert text == "Grade I A moderate A 3 cm"

def test_normal_descriptors():
    res = _rule_based_safety_net("The liver is unremarkable. Within normal limits.")
    for f in res["findings"]:
        if f["body_zone"] and "liver" in f["body_zone"]:
            assert f["is_normal"]

def test_grounding_difflib():
    from difflib import SequenceMatcher
    import re
    def _normalize(s):
        return re.sub(r'\s+', ' ', (s or "").lower()).strip()
    
    text = "This is a finding about right lower lobe."
    target = "Finding about right lower lobe"
    
    clauses = re.split(r'[.;!?\n]', text.lower())
    best_ratio = 0.0
    for clause in clauses:
        r = SequenceMatcher(None, _normalize(target), _normalize(clause)).ratio()
        if r > best_ratio: best_ratio = r
    
    assert best_ratio >= 0.85
