"""
test_radiology.py — sends all three mock radiology reports to /scan
and prints the type, zones, sides, and severities.

Usage (from backend/ dir, with server running):
    python scripts/test_radiology.py

Expected:
  a) chest_xray_pa.jpg   → type=radiology_report  zone=chest_lung_right  side=not_stated/right
  b) mri_lumbar_spine.jpg → type=radiology_report  zone=lumbar_spine
  c) mri_left_knee.jpg    → type=radiology_report  zone=knee_left  side=left
"""
import os
import sys
import json
import requests
import argparse

# Force UTF-8 output on Windows consoles if no out file is specified
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Allow running from project root or backend/ dir
BASE_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")
SCAN_URL = f"{BASE_URL}/api/v1/xr/scan"

# Paths to the three demo report images
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_BACKEND_DIR = os.path.dirname(_SCRIPT_DIR)   # backend/scripts/ -> backend/
_PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)  # backend/ -> project root
REPORTS_DIR = os.path.join(_PROJECT_ROOT, "demo", "reports")

REPORTS = [
    ("chest_xray_pa.jpg",     "a) Chest X-ray PA"),
    ("mri_lumbar_spine.jpg",  "b) MRI Lumbar Spine"),
    ("mri_left_knee.jpg",     "c) MRI Left Knee"),
    ("ct_brain.jpg",          "d) CT Brain"),
    ("ct_abdomen.jpg",        "e) CT Abdomen"),
    ("chest_xray_normal.jpg", "f) Chest X-ray Normal"),
    ("ct_chest_mass.jpg",     "g) CT Chest Mass"),
    ("ct_brain_normal.jpg",   "h) CT Brain Normal"),
]


def _print_separator():
    print("-" * 70)


def test_report(filename: str, label: str) -> bool:
    path = os.path.join(REPORTS_DIR, filename)
    if not os.path.exists(path):
        print(f"[SKIP] File not found: {path}")
        return False

    print(f"\n{label}")
    print(f"  File: {filename}")

    with open(path, "rb") as f:
        files = {"file": (filename, f, "image/jpeg")}
        for attempt in range(1, 3):  # up to 2 attempts
            try:
                resp = requests.post(SCAN_URL, files=files, timeout=300)
                break
            except requests.ConnectionError:
                print(f"  [ERROR] Cannot connect to {SCAN_URL}")
                print("  Make sure the backend is running: docker compose up -d")
                return False
            except requests.ReadTimeout:
                if attempt < 2:
                    print(f"  [WARN] Timeout on attempt {attempt}, retrying...")
                    f.seek(0)
                    continue
                print(f"  [ERROR] Timed out after 300 s (attempt {attempt})")
                return False

    if not resp.ok:
        print(f"  [ERROR] HTTP {resp.status_code}: {resp.text[:300]}")
        return False

    data = resp.json()
    doc_type = data.get("object_type", "?")
    doc_id = data.get("document_id", "?")
    print(f"  document_id : {doc_id}")
    print(f"  type        : {doc_type}")

    # Radiology image guard
    if doc_type == "radiology_image":
        print(f"  [WARN] Got radiology_image — supply the written report, not the scan film.")
        return False

    if doc_type != "radiology_report":
        print(f"  [WARN] Unexpected type: {doc_type} (expected radiology_report)")
        fields = data.get("fields", {})
        print(f"  fields: {json.dumps(fields, indent=4)[:500]}")
        return False

    # Parse radiology viewer payload
    radiology = data.get("radiology", {})
    if not radiology:
        # Try fetching from /radiology/{id}
        try:
            r2 = requests.get(f"{BASE_URL}/api/v1/xr/radiology/{doc_id}", timeout=30)
            radiology = r2.json() if r2.ok else {}
        except Exception:
            radiology = {}

    study_name = radiology.get("study_name") or data.get("fields", {}).get("study_name", "?")
    impression = radiology.get("impression") or data.get("fields", {}).get("impression", "?")
    overall_normal = radiology.get("overall_normal", "?")
    zones = radiology.get("zones", [])
    all_findings = radiology.get("all_findings", data.get("fields", {}).get("findings", []))

    is_critical = radiology.get("is_critical") or data.get("fields", {}).get("is_critical", False)

    print(f"  study_name  : {study_name}")
    print(f"  overall_normal: {overall_normal}")
    print(f"  is_critical : {is_critical}")
    print(f"  impression  : {str(impression)[:120]}")
    print(f"  zones ({len(zones)} abnormal):")
    for z in zones:
        print(f"    → zone_id={z['zone_id']}  en=\"{z['zone_en']}\"  ta=\"{z['zone_ta']}\"")
        for f in z["findings"]:
            side = f.get("side", "?")
            sev_written = f.get("severity_as_written", "?")
            sev_level = f.get("severity_level", "?")
            is_n = f.get("is_normal", "?")
            print(f"       finding: side={side}  sev_written={sev_written}  sev_level={sev_level}  is_normal={is_n}")
            print(f"       text   : {f.get('text_from_report','')}")
            print(f"       expl_en: {f.get('explanation_en','')}")
            print(f"       expl_ta: {f.get('explanation_ta','')}")

    if not all_findings:
        print("  [WARN] No findings extracted.")

    # Complex assertions
    zone_ids_found = [z["zone_id"] for z in zones]
    
    ok = True
    # Check Faithfulness for all findings
    for f in all_findings:
        text = str(f.get("text_from_report", "")).lower()
        exp_en = str(f.get("explanation_en", "")).lower()
        
        # Side check
        for side in ["left", "right", "bilateral"]:
            if side in text and side not in exp_en:
                print(f"  ❌ FAIL: side '{side}' in report but missing in expl_en")
                ok = False
        
        if "left" in text and "right" not in text and "right" in exp_en:
            print("  ❌ FAIL: side 'right' hallucinated in expl_en")
            ok = False
        if "right" in text and "left" not in text and "left" in exp_en:
            print("  ❌ FAIL: side 'left' hallucinated in expl_en")
            ok = False
            
        # Severity check
        for sev in ["mild", "moderate", "severe"]:
            if sev in text and sev not in exp_en:
                print(f"  ❌ FAIL: severity '{sev}' in report but missing in expl_en")
                ok = False

    if filename == "chest_xray_pa.jpg":
        ok = ok and "chest_lung_right" in zone_ids_found
    elif filename == "mri_lumbar_spine.jpg":
        ok = "lumbar_spine" in zone_ids_found
    elif filename == "mri_left_knee.jpg":
        ok = "knee_left" in zone_ids_found
        has_severe = any(f.get("severity_level") == "severe" for f in all_findings)
        if not has_severe:
            print("  ❌ FAIL: missing severe tear finding")
            ok = False
    elif filename == "ct_brain.jpg":
        ok = "head_brain" in zone_ids_found and is_critical
        left_side = any(f.get("side") == "left" for f in all_findings)
        if not left_side:
            print("  ❌ FAIL: side=left missing")
            ok = False
    elif filename == "ct_abdomen.jpg":
        ok = "kidney_right" in zone_ids_found and "liver" in zone_ids_found
    elif filename == "chest_xray_normal.jpg":
        ok = overall_normal is True and len(zones) == 0
    elif filename == "ct_chest_mass.jpg":
        ok = "chest_lung_left" in zone_ids_found
        if not ok:
            print(f"  ❌ FAIL: chest_lung_left not in {zone_ids_found}")
        if not is_critical:
            print("  ❌ FAIL: is_critical is False")
            ok = False
        cancer_mentioned = any("cancer" in str(f.get("explanation_en")).lower() for f in all_findings)
        if cancer_mentioned:
            print("  ❌ FAIL: 'cancer' mentioned in expl_en")
            ok = False
    elif filename == "ct_brain_normal.jpg":
        ok = overall_normal is True and is_critical is False
        if not ok:
            print(f"  ❌ FAIL: overall_normal={overall_normal}, is_critical={is_critical}")
            
    if ok:
        print(f"\n  ✅ PASS — Assertions succeeded")
    else:
        print(f"\n  ❌ FAIL — Assertions failed")

    return ok


def main():
    parser = argparse.ArgumentParser(description="Test radiology OCR pipeline")
    parser.add_argument("--only", type=str, help="Run only a specific file, e.g., chest_xray_pa.jpg")
    parser.add_argument("--out", type=str, help="Output file path (will be written in UTF-8)")
    args = parser.parse_args()
    
    if args.out:
        sys.stdout = open(args.out, "w", encoding="utf-8")

    print("=" * 70)
    print("NalamNet Radiology Report Test")
    print(f"Backend: {SCAN_URL}")
    print("=" * 70)

    test_files = REPORTS
    if args.only:
        only_files = [x.strip() for x in args.only.split(",")]
        test_files = [(f, l) for f, l in test_files if f in only_files]
        if not test_files:
            print(f"Error: file {args.only} not found in tests.")
            return

    results = []
    for i, (filename, label) in enumerate(test_files):
        _print_separator()
        if i > 0:
            print("  [pause 20 s to stay within Groq TPM limits...]")
            import time; time.sleep(20)
        ok = test_report(filename, label)
        results.append((label, ok))

    _print_separator()
    print("\nSUMMARY")
    all_pass = True
    for label, ok in results:
        status = "✅ PASS" if ok else "❌ FAIL"
        print(f"  {status}  {label}")
        if not ok:
            all_pass = False

    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
