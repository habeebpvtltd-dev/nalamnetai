/* demo-reports.js — sample viewer JSON (same shape as GET /radiology/latest).
   Only offered in the UI with ?demo=1. */

const DEMO_REPORTS = [
  {
    key: "knee",
    menu: "Left knee MRI",
    menuSub: "Meniscus tear (severe) + mild fluid",
    data: {
      document_id: "demo-knee",
      study_name: "MRI Left Knee",
      modality: "mri",
      study_date: "12-09-2026",
      radiologist: "Dr. S. Meenakshi, MD (Radiology)",
      impression: "Complex tear of the posterior horn of the medial meniscus. Mild joint effusion.",
      overall_normal: false,
      is_critical: false,
      zones: [
        {
          zone_id: "knee_left", zone_en: "Left Knee", zone_ta: "இடது முழங்கால்",
          findings: [
            {
              id: "k1",
              text_from_report: "Complex tear involving the posterior horn of the medial meniscus, extending to the inferior articular surface.",
              body_zone: "knee_left", side: "left", location_detail: "medial_posterior",
              severity_as_written: "complex", severity_level: "severe", is_normal: false,
              explanation_en: "The cushion inside your left knee has a tear at the inner back part. This cushion helps the knee move smoothly and take your weight.",
              explanation_ta: "உங்கள் இடது முழங்காலின் உள்ளே, உள் பக்கம் பின்பகுதியில் இருக்கும் மென்மையான மெத்தை போன்ற பகுதியில் கிழிசல் இருக்கிறது என்று அறிக்கை சொல்கிறது. இந்த மெத்தைதான் முழங்கால் சுலபமாக அசைய உதவுகிறது.",
            },
            {
              id: "k2",
              text_from_report: "Mild joint effusion.",
              body_zone: "knee_left", side: "left", location_detail: "",
              severity_as_written: "mild", severity_level: "mild", is_normal: false,
              explanation_en: "There is a small amount of extra fluid inside your left knee joint.",
              explanation_ta: "உங்கள் இடது முழங்கால் மூட்டுக்குள் கொஞ்சம் அதிகமான நீர் சேர்ந்திருக்கிறது.",
            },
          ],
        },
      ],
      all_findings: [
        { text_from_report: "Anterior and posterior cruciate ligaments are intact.", is_normal: true, explanation_en: "The main ligaments that hold your knee together look normal." },
      ],
    },
  },
  {
    key: "lung",
    menu: "Chest X-ray",
    menuSub: "Right lung, lower lobe (moderate)",
    data: {
      document_id: "demo-lung",
      study_name: "Chest X-ray PA View",
      modality: "xray",
      study_date: "15-09-2026",
      radiologist: "Dr. R. Karthik, DMRD",
      impression: "Right lower lobe consolidation, likely infective. Clinical correlation advised.",
      overall_normal: false,
      is_critical: false,
      zones: [
        {
          zone_id: "chest_lung_right", zone_en: "Right Lung", zone_ta: "வலது நுரையீரல்",
          findings: [
            {
              id: "l1",
              text_from_report: "Moderate patchy consolidation noted in the right lower lobe.",
              body_zone: "chest_lung_right", side: "right", location_detail: "lower_lobe",
              severity_as_written: "moderate", severity_level: "moderate", is_normal: false,
              explanation_en: "A part at the bottom of your right lung looks thicker than normal. The report says this may be due to an infection; your doctor will check.",
              explanation_ta: "உங்கள் வலது நுரையீரலின் கீழ்ப் பகுதி வழக்கத்தை விட அடர்த்தியாகத் தெரிகிறது. இது தொற்றால் இருக்கலாம் என்று அறிக்கை சொல்கிறது. மருத்துவர் சரிபார்ப்பார்.",
            },
          ],
        },
      ],
      all_findings: [
        { text_from_report: "Heart size is normal.", is_normal: true, explanation_en: "Your heart size looks normal." },
      ],
    },
  },
  {
    key: "spine",
    menu: "Lumbar spine MRI",
    menuSub: "Disc bulge L4–L5 (mild)",
    data: {
      document_id: "demo-spine",
      study_name: "MRI Lumbar Spine",
      modality: "mri",
      study_date: "18-09-2026",
      radiologist: "Dr. A. Farhana, MD",
      impression: "Mild diffuse disc bulge at L4-L5 without significant nerve root compression.",
      overall_normal: false,
      is_critical: false,
      zones: [
        {
          zone_id: "lumbar_spine", zone_en: "Lumbar Spine (Lower Back)", zone_ta: "இடுப்பு முதுகெலும்பு",
          findings: [
            {
              id: "s1",
              text_from_report: "Mild diffuse disc bulge at L4-L5 level indenting the thecal sac.",
              body_zone: "lumbar_spine", side: "not_applicable", location_detail: "L4-L5",
              severity_as_written: "mild", severity_level: "mild", is_normal: false,
              explanation_en: "The soft cushion between two bones in your lower back (L4 and L5) is pushing out a little.",
              explanation_ta: "உங்கள் கீழ் முதுகில் L4, L5 என்ற இரண்டு எலும்புகளுக்கு இடையே உள்ள மென்மையான மெத்தை கொஞ்சம் வெளியே தள்ளியிருக்கிறது.",
            },
          ],
        },
      ],
      all_findings: [
        { text_from_report: "Other disc levels are normal.", is_normal: true, explanation_en: "The other parts of your lower back look normal." },
      ],
    },
  },
  {
    key: "brain",
    menu: "CT Brain",
    menuSub: "Left fronto-parietal (severe, urgent)",
    data: {
      document_id: "demo-brain",
      study_name: "CT Brain (Plain)",
      modality: "ct",
      study_date: "20-09-2026",
      radiologist: "Dr. V. Prakash, MD",
      impression: "Acute intraparenchymal haemorrhage in the left fronto-parietal region with perilesional oedema. Urgent neurosurgical opinion advised.",
      overall_normal: false,
      is_critical: true,
      zones: [
        {
          zone_id: "head_brain", zone_en: "Head / Brain", zone_ta: "தலை / மூளை",
          findings: [
            {
              id: "b1",
              text_from_report: "Acute intraparenchymal haemorrhage measuring 2.8 x 2.1 cm in the left fronto-parietal region with perilesional oedema.",
              body_zone: "head_brain", side: "left", location_detail: "fronto_parietal",
              severity_as_written: "acute", severity_level: "severe", is_normal: false,
              explanation_en: "The report says there is bleeding inside the left side of the brain, near the front and top. A doctor needs to see this soon.",
              explanation_ta: "மூளையின் இடது பக்கத்தில், முன் மற்றும் மேல் பகுதியில் இரத்தக் கசிவு இருப்பதாக அறிக்கை சொல்கிறது. இதை மருத்துவர் விரைவில் பார்க்க வேண்டும்.",
            },
          ],
        },
      ],
      all_findings: [
        { text_from_report: "No skull fracture.", is_normal: true, explanation_en: "There is no break in the skull bone." },
      ],
    },
  },
  {
    key: "normal",
    menu: "Normal chest X-ray",
    menuSub: "No problem areas",
    data: {
      document_id: "demo-normal",
      study_name: "Chest X-ray PA View",
      modality: "xray",
      study_date: "21-09-2026",
      radiologist: "Dr. R. Karthik, DMRD",
      impression: "No active lung lesion. Normal study.",
      overall_normal: true,
      is_critical: false,
      zones: [],
      all_findings: [
        { text_from_report: "Both lung fields are clear.", is_normal: true, explanation_en: "Both lungs look clear." },
      ],
    },
  },
];
