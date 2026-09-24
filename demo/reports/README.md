# Demo Radiology Reports

Three **fictional** printed report images for testing Part 2 of NalamNet AI.

| File | Study | Expected Zone |
|------|-------|---------------|
| `chest_xray_pa.jpg` | X-Ray Chest PA View — Kovai Rainbow Diagnostics | `chest_lung_right` |
| `mri_lumbar_spine.jpg` | MRI Lumbar Spine — Surya Scan & Diagnostics | `lumbar_spine` |
| `mri_left_knee.jpg` | MRI Left Knee — Meenakshi Advanced MRI Centre | `knee_left` (side=left) |

All patient names, hospitals, doctors, and report numbers are **fictional**.

## How to test

```bash
# From project root, with backend running on port 8000
python backend/scripts/test_radiology.py
```
