# NalamNet Spatial: frontend v2

A premium, mobile-first frontend built with plain HTML, CSS and JS (no build step). It talks to the existing FastAPI backend. `backend/` and `frontend-xr/` are untouched.

```
frontend-v2/
  index.html          app shell + all four screens
  css/styles.css      design system (CSS variables, glass, components)
  js/config.js        API base detection (same logic as frontend-xr) + ?debug / ?demo flags
  js/util.js          api() with timeouts + cold-start hooks, tween() GSAP fallback, toast, storage
  js/voice.js         ported from frontend-xr/voice.js (recording, audio unlock, Sarvam/browser TTS)
  js/body3d.js        3D engine. ZONES / SPINE_LEVELS / DETAIL_OFFSETS tables are at the TOP.
  js/demo-reports.js  sample viewer JSON for ?demo=1
  js/body-ui.js       Body tab: data loading, bottom sheet, banners, demo menu
  js/scan.js          camera/upload -> /scan -> result cards
  js/assistant.js     chat + voice
  js/emergency.js     PIN card, call, QR, print
  vercel.json         static hosting headers
```

## Run locally

```bash
python -m http.server 3000 --directory frontend-v2
```

Open http://localhost:3000. **Use port 3000**: the local backend's `.env` only allows CORS from `http://localhost:3000` (and `https://nalamnetai.vercel.app`).

URL flags:
- `?demo=1` shows a Demo reports menu on the Body tab: left knee (severe + mild), right lower lobe (moderate), L4–L5 (mild), CT brain left fronto-parietal (severe, critical), and a normal study.
- `?debug=1` shows every zone (cyan) and every detail point (pink) labelled on the 3D body, plus camera numbers. Pinch in to separate labels.
- Flags combine: `?demo=1&debug=1`. A hash picks the start tab: `#body`, `#assistant`, `#emergency`.

## Deploying (read before the demo)

1. Deploy `frontend-v2/` as a static site on Vercel (root directory = `frontend-v2`, no build command).
2. **CORS:** Render's `ALLOWED_ORIGINS` must contain the exact origin v2 is served from. Today it allows `https://nalamnetai.vercel.app`. Either deploy v2 to that same Vercel project, or add the new URL (e.g. `https://nalamnet-v2.vercel.app`) to `ALLOWED_ORIGINS` on Render and redeploy. Without this, every API call fails and the app shows "Offline".
3. Render's free tier sleeps. Open the app about 2 minutes before presenting. It pings `/radiology/latest` on load to wake the server, and the UI shows "waking up" messages on slow calls.
4. After changing JS/CSS, bump the `?v=` numbers in `index.html` so phones don't serve stale cached files.

## What works (tested at 390 × 844 against the local backend)

- **Shell:** four-tab bar with sliding indicator, GSAP screen transitions, server status pill, toasts. If GSAP fails to load, a small rAF fallback keeps flights and transitions working. If WebGL fails, the Body tab still lists findings.
- **3D body (Body tab)**
  - X-ray glass mannequin (fresnel shader, additive), with a faint skeleton, spine ladder, ribs, lungs, heart, liver, kidneys, brain and bladder inside.
  - A pulsing marker per finding, coloured by `severity_level`, rendered through the body so it glows inside. Floating labels say "Patient's left/right". Non-selected labels shrink to a short tag and are pushed apart so they don't overlap.
  - On load: a gentle spin, then a 1.5 s GSAP flight to the most severe finding. The body turns so the spot faces the camera (spine → back view; knee medial/posterior → back-inner view; brain lobes → that side). Previous/Next walk all findings; tapping a label or marker selects it.
  - Bottom sheet: body part EN + TA, patient's side, plain-language location ("Between L4 and L5 in the lower back", "Lower part of the right lung", "Inner back part of the left knee"), severity chip, English/தமிழ் toggle, Listen (Sarvam via `/voice/tts`, phone-voice fallback), Stop, the report's original sentence, and always the disclaimer.
  - `is_critical`: calm red banner with a one-tap call to the emergency contact (or "Add contact" if none is saved).
  - `overall_normal`: the body glows green with "Your report does not mention any problem areas."
  - Layout (390 px): the top card is followed by a full-width "View in your room" pill (AR phones only) and any banner, then a reserved row holding the orientation hint and Front/Back. The body is always framed *below* that row. The hint shows the full sentence for 3 s, then shrinks to a 28 px chip.
  - Bottom sheet has 3 states. **Collapsed** (≈110 px peek: "Finding 1 of 2", zone, severity chip, Prev/Next) is the default on load, with the whole body visible. **Half** opens when you tap a marker or Prev/Next. **Full** shows scrollable details. Swipe the header up/down, tap the grab bar, or use the chevron button. After every change the camera re-frames so the selected spot stays centred above the sheet.
  - Labels: only the selected finding has a text label ("Left Knee · 2 findings" when a zone has several). Other findings are just glowing markers. The label layer is `pointer-events: none` and labels are clamped between the top controls and the sheet. Every control is ≥ 48 × 48 px; this was checked with an `elementFromPoint` hit-test at 390 × 844.
  - Controls: one-finger drag rotates, pinch or wheel zooms (own pointer handlers), Front/Back, Reset. A "Front view / Back view" hint explains which side is which.
  - Data: `GET /radiology/latest`; the Tamil explanation is fetched on demand via `GET /radiology/{id}?lang=ta`. Scan → "View on 3D body" opens the report just scanned.
  - `location_detail` is used when the backend sends it (`medial_posterior`, `lower_lobe`, `L4-L5`, `fronto_parietal`, `upper_pole`, `right_lobe` …). Otherwise it is parsed from `text_from_report`.
  - Performance: low-poly primitives, no shadows, pixel ratio capped at 2, render loop runs only while the Body tab is visible, and no backdrop blur over the canvas (expensive on Android GPUs).
- **AR: "View in your room" (`js/ar.js`)**
  - An extra mode; the 3D viewer is unchanged. The button appears only when `navigator.xr.isSessionSupported('immersive-ar')` is true: Android Chrome with ARCore over HTTPS. It stays hidden on iPhone and desktop.
  - The session is requested directly (no ARButton) with `requiredFeatures: ['hit-test']` and `optionalFeatures: ['dom-overlay']`, using `#ar-overlay` as the root. It uses the same renderer, scene, body group, materials and markers as 3D; the framebuffer scale is 0.85 and there are no shadows.
  - A ring reticle follows hit-test ("Point at the floor and tap to place the body"). Tapping places the body facing you. Table size (≈40 cm) is the default; Life size is ≈1.7 m. Move places it again; Exit AR ends the session.
  - Markers pulse brighter and carry canvas-sprite 3D labels (body part + "Patient's left/right"). Tapping near a marker picks it using the XR `select` ray (nearest marker within ~8°) and opens the finding card: location, severity, explanation, Listen, disclaimer. Next finding steps through all findings. The critical banner and the green "normal" body carry over.
  - During AR only, the additive materials switch to a blend whose alpha follows brightness, so the glow stays see-through over the camera. Everything is restored on exit.
  - Any AR error ends the session, shows "AR is not available on this phone" and returns to 3D. Tested on desktop by forcing failures and by staging the AR scene in the 3D canvas (`BodyAR._dev.stage()`); a real session still needs a phone check.
- **Scan:** camera (`capture="environment"`) and upload (images + PDF). Big photos are shrunk to 2400 px before upload. Animated scanning line while "Reading your document…". Cards for prescription (medicine cards, "1-0-1" → "Morning 1 · Night 1", BD/OD/TDS in words, handwritten and per-medicine "Unclear" warnings), electricity bill (big amount, days left to due date), shopping bill, warranty card, radiology report (severity counts, findings, big "View on 3D body"), scan-film warning, unrecognised document, and friendly network/timeout/422 errors with retry.
- **Assistant:** greeting spoken on first open, text and voice input, live mic level bars with pulsing rings, Tamil/English detection (STT language + Tamil-script regex, as in voice.js), Sarvam replies with browser fallback, Repeat/Stop per message, suggestion chips, and a "Tap to listen" hint if the phone blocks autoplay.
- **Emergency:** PIN unlock, setup/edit form with validation, profile card with large blood group, one-tap call, QR (from the backend), print card, copy text for a lock-screen note, and a new QR link (regenerate). The contact is remembered locally so the Body tab's critical banner can call it.

## Not finished / known issues

- **Backend (not changed by me):**
  - `/assistant` returns an empty `display_text`, or Tamil `speech_text` for English questions. The frontend works around this (shows `speech_text`, picks the voice by script), but the answers themselves come from the backend.
  - During testing the local backend began returning **500** on `/radiology/latest`: `column documents.file_hash does not exist`. The model gained a column that the local Postgres table doesn't have yet (migration needed).
- Emergency **setup** and the **real QR** were not exercised against the local backend, because `/emergency/setup` deletes the existing profile. The wrong-PIN path was tested live; the profile, QR and print layout were checked with mock data.
- Prescription, electricity and shopping cards were checked with mock responses shaped like the backend's (there are no sample photos of those in `demo/`). The radiology scan was tested end to end with `demo/reports/mri_lumbar_spine.jpg`.
- The mic was only tested with simulated audio levels (the test browser has no microphone). The recording/upload code is the unchanged frontend-xr logic.
- Findings with no `body_zone` are listed in the sheet but have no marker (the camera shows the whole body).

## 3D model: source and license

No downloaded model is used. The body is generated in code (`buildBody()` in `js/body3d.js`) from three.js primitives: a lathe-profile torso, tapered capsule limbs built with `LatheGeometry` (r128 has no `CapsuleGeometry`), and ellipsoid organs. It is **original work, so there are no third-party license or attribution requirements**, and nothing to download at runtime besides three.js and GSAP.

Why not a GLB: every zone and spine-level coordinate had to be calibrated against the exact geometry, and a procedural mesh removes the risk of a download, license or loading failure on stage. Swapping in a CC0 GLB later is possible: load it into the `body` group and re-tune `ZONES` using `?debug=1`.

Libraries: three.js r128 (MIT), GSAP 3.12 (standard "no charge" GSAP license), Inter and Noto Sans Tamil fonts (SIL OFL), all loaded from CDNs.
