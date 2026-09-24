"""
Fixed body zones for radiology report mapping.
Each zone has an id (snake_case), an English display name, and a Tamil display name.
This list is the single source of truth — the JSON copy at frontend-xr/body_zones.json
is generated from this module and must stay in sync.
"""

# Ordered list of zone dicts; ids are the canonical identifiers used in
# RadiologyFinding.body_zone and the /radiology viewer endpoints.
BODY_ZONES: list[dict] = [
    # ── Head & Neck ──────────────────────────────────────────────────────────
    {"id": "head_brain",          "en": "Head / Brain",              "ta": "தலை / மூளை"},
    {"id": "face_sinuses",        "en": "Face / Sinuses",            "ta": "முகம் / சைனஸ்"},
    {"id": "neck",                "en": "Neck",                      "ta": "கழுத்து"},
    {"id": "cervical_spine",      "en": "Cervical Spine (Neck)",     "ta": "கர்வியல் முதுகெலும்பு"},
    {"id": "thyroid",             "en": "Thyroid Gland",             "ta": "தைராய்டு சுரப்பி"},

    # ── Shoulder & Upper Limb ─────────────────────────────────────────────
    {"id": "shoulder_left",       "en": "Left Shoulder",             "ta": "இடது தோள்பட்டை"},
    {"id": "shoulder_right",      "en": "Right Shoulder",            "ta": "வலது தோள்பட்டை"},
    {"id": "upper_arm_left",      "en": "Left Upper Arm",            "ta": "இடது மேல் கை"},
    {"id": "upper_arm_right",     "en": "Right Upper Arm",           "ta": "வலது மேல் கை"},
    {"id": "elbow_left",          "en": "Left Elbow",                "ta": "இடது முழங்கை"},
    {"id": "elbow_right",         "en": "Right Elbow",               "ta": "வலது முழங்கை"},
    {"id": "wrist_hand_left",     "en": "Left Wrist / Hand",         "ta": "இடது மணிக்கட்டு / கை"},
    {"id": "wrist_hand_right",    "en": "Right Wrist / Hand",        "ta": "வலது மணிக்கட்டு / கை"},

    # ── Chest ─────────────────────────────────────────────────────────────
    {"id": "chest_lung_left",     "en": "Left Lung",                 "ta": "இடது நுரையீரல்"},
    {"id": "chest_lung_right",    "en": "Right Lung",                "ta": "வலது நுரையீரல்"},
    {"id": "heart",               "en": "Heart",                     "ta": "இதயம்"},
    {"id": "breast_left",         "en": "Left Breast",               "ta": "இடது மார்பகம்"},
    {"id": "breast_right",        "en": "Right Breast",              "ta": "வலது மார்பகம்"},
    {"id": "thoracic_spine",      "en": "Thoracic Spine (Mid-Back)", "ta": "மார்பு முதுகெலும்பு"},

    # ── Abdomen ───────────────────────────────────────────────────────────
    {"id": "abdomen_general",     "en": "Abdomen (General)",         "ta": "வயிறு (பொது)"},
    {"id": "liver",               "en": "Liver",                     "ta": "கல்லீரல்"},
    {"id": "gallbladder",         "en": "Gallbladder",               "ta": "பித்தப்பை"},
    {"id": "pancreas",            "en": "Pancreas",                  "ta": "கணையம்"},
    {"id": "spleen",              "en": "Spleen",                    "ta": "மண்ணீரல்"},
    {"id": "stomach_intestines",  "en": "Stomach / Intestines",      "ta": "வயிறு / குடல்"},
    {"id": "kidney_left",         "en": "Left Kidney",               "ta": "இடது சிறுநீரகம்"},
    {"id": "kidney_right",        "en": "Right Kidney",              "ta": "வலது சிறுநீரகம்"},
    {"id": "bladder",             "en": "Bladder",                   "ta": "சிறுநீர்ப்பை"},
    {"id": "pelvis_reproductive", "en": "Pelvis / Reproductive",     "ta": "இடுப்பு / இனப்பெருக்க உறுப்புகள்"},

    # ── Lumbar & Sacral ───────────────────────────────────────────────────
    {"id": "lumbar_spine",        "en": "Lumbar Spine (Lower Back)", "ta": "இடுப்பு முதுகெலும்பு"},
    {"id": "sacrum_coccyx",       "en": "Sacrum / Coccyx",           "ta": "சேக்ரம் / கோக்கிக்ஸ்"},

    # ── Lower Limb ────────────────────────────────────────────────────────
    {"id": "hip_left",            "en": "Left Hip",                  "ta": "இடது இடுப்பு மூட்டு"},
    {"id": "hip_right",           "en": "Right Hip",                 "ta": "வலது இடுப்பு மூட்டு"},
    {"id": "thigh_left",          "en": "Left Thigh",                "ta": "இடது தொடை"},
    {"id": "thigh_right",         "en": "Right Thigh",               "ta": "வலது தொடை"},
    {"id": "knee_left",           "en": "Left Knee",                 "ta": "இடது முழங்கால்"},
    {"id": "knee_right",          "en": "Right Knee",                "ta": "வலது முழங்கால்"},
    {"id": "lower_leg_left",      "en": "Left Lower Leg",            "ta": "இடது கால் (கீழ்)"},
    {"id": "lower_leg_right",     "en": "Right Lower Leg",           "ta": "வலது கால் (கீழ்)"},
    {"id": "ankle_foot_left",     "en": "Left Ankle / Foot",         "ta": "இடது கணுக்கால் / பாதம்"},
    {"id": "ankle_foot_right",    "en": "Right Ankle / Foot",        "ta": "வலது கணுக்கால் / பாதம்"},
]

# Fast lookup set for validation
VALID_ZONE_IDS: set[str] = {z["id"] for z in BODY_ZONES}

# Lookup dict by id
ZONE_BY_ID: dict[str, dict] = {z["id"]: z for z in BODY_ZONES}
