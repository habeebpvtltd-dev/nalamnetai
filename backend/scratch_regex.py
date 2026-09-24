import re
text = "No evidence of mass lesion or acute infarct. Ventricles and basal cisterns are normal. Calvarium is intact. Impression: Normal CT Brain. No evidence of intracranial bleed or midline shift. Suspicious for neoplasm."
is_critical = False
critical_keywords = ["neoplasm", "malignancy", "biopsy", "urgent", "critical", "haematoma", "hemorrhage", "bleed", "midline shift", "pneumothorax", "fracture", "mass", "lesion", "emergency", "immediate"]

sentences = text.lower().split('.')
for s in sentences:
    for k in critical_keywords:
        if k in s:
            if not re.search(r'\b(no\s|negative\sfor|without\s|absence\sof)[^.]*?\b' + re.escape(k), s):
                print("CRITICAL:", k, "in", s)
                is_critical = True
                break
print(is_critical)
