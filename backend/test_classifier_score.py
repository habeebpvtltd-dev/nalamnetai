"""Quick local test of classifier keyword scores for the 8 demo reports."""

WEIGHTED_KEYWORDS = [
    ("impression:", 5), ("impression :", 5), ("findings:", 5),
    ("radiologist", 5), ("radiologist's report", 5),
    ("no evidence of", 5), ("pa view", 5), ("ap view", 4),
    ("clinical history", 4), ("clinical indication", 4),
    ("impression", 4), ("findings", 4),
    ("x-ray", 3), ("xray", 3), ("mri", 3), ("magnetic resonance", 3),
    ("ct scan", 3), ("hrct", 3), ("ultrasound", 3), ("usg", 3),
    ("sonography", 3), ("radiology", 3), ("contrast", 3),
    ("sagittal", 3), ("axial", 3), ("coronal", 3),
    ("plain film", 3), ("mammogram", 3), ("fluoroscopy", 3),
    ("ct brain", 3), ("ct abdomen", 3), ("ct chest", 3),
    ("ct plain", 3), ("with contrast", 3),
    ("lobe", 2), ("vertebr", 2), ("disc", 2), ("meniscus", 2),
    ("cortex", 2), ("effusion", 2), ("consolidation", 2),
    ("cardiomegaly", 2), ("opacity", 2), ("lucency", 2),
    ("calcification", 2), ("lesion", 2), ("mass", 2),
    ("haematoma", 2), ("haemorrhage", 2), ("hemorrhage", 2),
    ("hydronephrosis", 2), ("calculus", 2),
    ("referral", 1), ("referring doctor", 1), ("study date", 1),
    ("report date", 1), ("normal study", 2), ("abnormal", 1),
]

total_weight = sum(w for _, w in WEIGHTED_KEYWORDS)

SAMPLES = {
    "CT Brain (tess)": "study ct brain plain clinical history head trauma findings haematoma midline shift impression urgent neurosurgical",
    "CT Abdomen (tess)": "study ct abdomen with contrast clinical history right flank pain findings calculus hydronephrosis kidney impression fatty liver",
    "Normal CXR (tess)": "study chest x-ray pa view clinical history routine findings clear no evidence of consolidation impression normal study",
    "CT Chest Mass (tess)": "study ct chest clinical history chronic cough findings spiculated mass left upper lobe suspicious neoplasm impression biopsy",
    "CT Brain Normal (tess)": "study ct brain plain clinical history headache findings no haemorrhage no midline shift no evidence mass lesion impression normal ct brain",
}

THRESHOLD = 0.25
for name, text in SAMPLES.items():
    t = text.lower()
    hits = [(kw, w) for kw, w in WEIGHTED_KEYWORDS if kw in t]
    hit_w = sum(w for _, w in hits)
    score = hit_w / total_weight
    status = "OK" if score >= THRESHOLD else "FAIL"
    matching = [kw for kw, _ in hits]
    print(f"[{status}] {name}: score={score:.3f}  hits={matching}")
