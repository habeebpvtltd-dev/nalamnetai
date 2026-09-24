# NalamNet AI - API Documentation

This document describes all the backend endpoints available for the frontend to consume. The base URL for all `xr` endpoints is `/api/v1/xr`.

## 1. Document Scanning

### `POST /api/v1/xr/scan`
Uploads a medical document (prescription or radiology report) for OCR and AI extraction.

- **Request Format**: `multipart/form-data`
  - `file`: The image file (JPEG/PNG/PDF)
  - `language`: (Optional) `en` or `ta`. Defaults to `en`.

- **Response (Radiology Report Example)**:
```json
{
  "status": "success",
  "document_id": "498c6d72-c8c3-444a-8289-73cc4c7c35af",
  "document_type": "radiology_report",
  "radiology": {
    "document_id": "498c6d72-c8c3-444a-8289-73cc4c7c35af",
    "study_name": "Chest X-ray PA",
    "modality": "xray",
    "study_date": "2023-10-27",
    "referring_doctor": "Dr. Smith",
    "radiologist": "Dr. Jones",
    "clinical_history": "Cough and fever",
    "impression": "1. Moderate right lower lobe consolidation, likely infective. 2. Mild left pleural effusion.",
    "overall_normal": false,
    "is_critical": false,
    "zones": [
      {
        "zone_id": "chest_lung_left",
        "zone_en": "Left Lung",
        "zone_ta": "இடது நுரையீரல்",
        "findings": [
          {
            "id": "f1",
            "text_from_report": "There is a mild blunting of the left costophrenic angle.",
            "zone_id": "chest_lung_left",
            "side": "left",
            "severity_as_written": "mild",
            "severity_level": "mild",
            "is_normal": false,
            "explanation_en": "A mild flattening (blunting) is seen at the left costophrenic angle.",
            "explanation_ta": "இடது நுரையீரலின் கீழ் விளிம்பில் ஒரு சிறிய தட்டையான தன்மை (blunting) காணப்படுகிறது.",
            "location_detail": "costophrenic_angle"
          }
        ]
      }
    ],
    "all_findings": [ ... ]
  }
}
```

## 2. Radiology Viewer Polling

### `GET /api/v1/xr/radiology/latest`
Fetches the most recently scanned radiology report in a viewer-ready format (used by the 3D body viewer).

- **Query Parameters**:
  - `lang`: (Optional) `en` or `ta`. If `ta`, it will generate Tamil translations on-demand if missing.

- **Response Format**: Same JSON object as the `radiology` key in the `/scan` response above.

### `GET /api/v1/xr/radiology/{document_id}`
Fetches a specific radiology report by its ID.

- **Query Parameters**:
  - `lang`: (Optional) `en` or `ta`. If `ta`, it will generate Tamil translations on-demand if missing.

- **Response Format**: Same JSON object as the `radiology` key in the `/scan` response above.

## 3. AI Assistant (Chat)

### `POST /api/v1/xr/assistant`
Ask questions about the scanned documents. It uses all the data from the current database context.

- **Request Format**: `application/json`
```json
{
  "question": "What is wrong with my left lung?",
  "language": "en"
}
```

- **Response Example**:
```json
{
  "display_text": "You have a mild pleural effusion (fluid) in your left lung.",
  "speech_text": "The report shows a small amount of fluid in your left lung."
}
```

## 4. Voice Processing

### `POST /api/v1/xr/voice/transcribe`
Transcribes a user's voice message (audio file) into text to be sent to the `/assistant`.

- **Request Format**: `multipart/form-data`
  - `file`: Audio file (e.g., WAV, MP3, WebM)

- **Response Example**:
```json
{
  "text": "What does my x-ray say?"
}
```

### `GET /api/v1/xr/voice/tts`
Converts text into a spoken audio file.

- **Query Parameters**:
  - `text`: The text to speak.
  - `language`: `en` or `ta`.

- **Response**: `audio/mpeg` (Returns the raw audio stream).

## 5. Emergency Setup & Access

### `POST /api/v1/xr/emergency/setup`
Creates or overwrites the emergency profile.

- **Request Format**: `multipart/form-data`
  - `pin`: Security PIN (e.g. "1234")
  - `blood_group`: (Optional) e.g. "O+"
  - `allergies`: (Optional) e.g. "Penicillin"
  - `conditions`: (Optional) e.g. "Diabetes"
  - `emergency_contact`: (Optional) e.g. "+91 9876543210"
  - `preferred_hospital`: (Optional) e.g. "Apollo"

- **Response Example**:
```json
{
  "status": "saved",
  "public_token": "a1b2c3d4e5f67890"
}
```

### `POST /api/v1/xr/emergency/regenerate`
Regenerates the public token (invalidating the old QR code).

- **Query Parameters**:
  - `pin`: The user's PIN to authorize the regeneration.

- **Response Example**:
```json
{
  "status": "regenerated",
  "public_token": "new987token654"
}
```

### `GET /api/v1/xr/emergency/{public_token}`
Publicly accessible HTML page for first responders to view the patient's emergency info and latest medications.

- **Response**: `text/html` rendering the Emergency Information page.

### `GET /api/v1/xr/emergency/{public_token}/qr`
Returns a generated QR code image that links to the public emergency page.

- **Response**: `image/png` (Returns the raw image stream).

## 6. System Health

### `GET /health`
A simple health check probe.

- **Response Example**:
```json
{
  "status": "ok"
}
```
