import os
import textwrap
from PIL import Image, ImageDraw, ImageFont

REPORTS = {
    "chest_xray_pa.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
NalamNet Demo Diagnostics
Patient: John Doe   Age: 45
Study: Chest X-ray PA

Clinical History: Cough for 2 weeks.

Findings:
Cardiothoracic ratio is normal.
There is a mild blunting of the left costophrenic angle.
A moderate consolidation is seen in the right lower lobe.
Trachea is centrally placed.

Impression:
1. Moderate right lower lobe consolidation, likely infective.
2. Mild left pleural effusion.""",

    "mri_lumbar_spine.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
NalamNet Demo Diagnostics
Patient: Jane Smith   Age: 55
Study: MRI Lumbar Spine

Clinical History: Lower back pain radiating to right leg.

Findings:
L4-L5 level: Mild disc bulge with bilateral nerve root contact, left more than right. No severe neural compression.
L5-S1 level: Mild disc desiccation.
Facet joints: Mild facet joint arthropathy at L4-L5 and L5-S1 levels.

Impression:
1. Mild L4-L5 bulge, bilateral nerve root contact, left more than right.
2. Mild degenerative changes at L5-S1.""",

    "mri_left_knee.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
Sample Scan Lab
Patient: Arun Kumar   Age: 32
Study: MRI Left Knee

Clinical History: Twisting injury during sports.

Findings:
There is a grade III signal intensity (tear) involving the posterior horn of the medial meniscus of the left knee. The tear extends to the articular surface, consistent with a complete medial meniscus tear.
Medial collateral ligament: Mild thickening and increased signal, suggestive of grade I sprain. No complete tear.
Joint effusion: Mild joint effusion noted in the left knee joint.
Articular cartilage: Mild thinning of articular cartilage over the medial femoral condyle.

Impression:
1. Complete tear of the posterior horn of the medial meniscus, left knee.
2. Mild joint effusion, left knee.
3. Grade I sprain of the medial collateral ligament.""",

    "ct_brain.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
Demo Imaging Centre
Patient: Robert Brown   Age: 68
Study: CT Brain (Plain)

Clinical History: Head trauma.

Findings:
There is an acute subdural haematoma noted on the left fronto-parietal region with 6mm midline shift to the right.
No underlying skull fracture is identified.
Ventricles appear compressed on the left side.

Impression:
Acute left fronto-parietal subdural haematoma with significant midline shift. Urgent neurosurgical consultation is recommended.""",

    "ct_abdomen.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
NalamNet Demo Diagnostics
Patient: Emily White   Age: 40
Study: CT Abdomen with Contrast

Clinical History: Right flank pain.

Findings:
The right kidney shows an 8 mm calculus in the lower pole. There is associated mild hydronephrosis.
The left kidney is normal in size and appearance.
Liver: Grade I fatty liver. No focal lesions.
Gallbladder is well distended, no radiopaque calculi.
Pancreas and spleen are unremarkable.

Impression:
1. 8mm calculus in the right kidney with mild hydronephrosis.
2. Grade I fatty liver.""",

    "chest_xray_normal.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
NalamNet Demo Diagnostics
Patient: Michael Green   Age: 30
Study: Chest X-ray PA View

Clinical History: Routine health checkup.

Findings:
Both lung fields are clear. No evidence of consolidation, collapse, or pleural effusion.
The cardiac silhouette is within normal limits.
The hilar and mediastinal shadows are unremarkable.
Bony thorax appears intact.
Both hemidiaphragms are normal in position and contour.

Impression:
Normal study. No abnormality detected.""",

    "ct_chest_mass.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
Sample Scan Lab
Patient: Sarah Connor   Age: 62
Study: CT Chest

Clinical History: Chronic cough, weight loss.

Findings:
A 3 cm spiculated mass is seen in the left upper lobe of the lung, suspicious for neoplasm.
There are a few subcentimeter mediastinal lymph nodes, likely reactive.
Right lung is clear. No pleural effusion.

Impression:
3 cm spiculated mass in the left upper lobe, suspicious for neoplasm. CT-guided biopsy recommended.""",

    "ct_brain_normal.jpg": """SAMPLE REPORT - FOR DEMONSTRATION ONLY
Demo Imaging Centre
Patient: David Lee   Age: 45
Study: CT Brain (Plain)

Clinical History: Headache.

Findings:
Brain parenchyma is normal in attenuation.
No haemorrhage. No midline shift.
No evidence of mass lesion or acute infarct.
Ventricles and basal cisterns are normal.
Calvarium is intact.

Impression:
Normal CT Brain. No evidence of intracranial bleed or midline shift."""
}

def generate_image(filename, text, output_dir):
    # A4 size roughly at 150 DPI
    width = 1240
    height = 1754
    image = Image.new('RGB', (width, height), color='white')
    draw = ImageDraw.Draw(image)
    
    try:
        font = ImageFont.truetype("arial.ttf", 32)
    except IOError:
        font = ImageFont.load_default(size=32)

    # Simple wrapping
    margin = 80
    offset = 80
    for paragraph in text.split('\n'):
        wrapped_lines = textwrap.wrap(paragraph, width=70)
        if not wrapped_lines:
            offset += 45
        for line in wrapped_lines:
            draw.text((margin, offset), line, font=font, fill='black')
            offset += 45

    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, filename)
    image.save(out_path)
    print(f"Generated {out_path}")

def main():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    output_dir = os.path.join(base_dir, "..", "demo", "reports")
    for filename, text in REPORTS.items():
        generate_image(filename, text, output_dir)

if __name__ == "__main__":
    main()
