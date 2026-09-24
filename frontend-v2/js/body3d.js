/* =====================================================================
   body3d.js — X-ray style 3D body viewer (three.js r128, no OrbitControls)

   COORDINATES (metres, body-local):
     - Feet at y = 0, top of head ≈ 1.75.  Body faces +Z (towards the viewer
       in the FRONT view).
     - PATIENT's LEFT = +X.  Facing the patient, their left is on the
       viewer's RIGHT — exactly like a doctor looking at them.
     - Spine sits at z ≈ -0.06 (inside the back).
   Edit ZONES / DETAIL_OFFSETS below to tune placement; open the app with
   ?debug=1 to see every point labelled on the model.
   ===================================================================== */

/* face: [x, z] direction the spot faces (in patient coords) so the camera can
   turn the body to show it. [0, 1] = front, [0, -1] = back.
   zoom: roughly how much body (metres × 1/0.6) stays visible around the spot
         in the free area above the sheet — bigger = more context. */
const ZONES = {
  head_brain:          { pos: [0, 1.655, 0.0],      face: [0, 1],  zoom: 0.85 },
  face_sinuses:        { pos: [0, 1.615, 0.085],    face: [0, 1],  zoom: 0.8 },
  neck:                { pos: [0, 1.5, 0.015],      face: [0, 1],  zoom: 0.85 },
  cervical_spine:      { pos: [0, 1.51, -0.03],     face: [0, -1], zoom: 0.9 },
  thyroid:             { pos: [0, 1.475, 0.04],     face: [0, 1],  zoom: 0.8 },
  shoulder_left:       { pos: [0.205, 1.405, 0],    face: [0, 1],  zoom: 1.0 },
  shoulder_right:      { pos: [-0.205, 1.405, 0],   face: [0, 1],  zoom: 1.0 },
  upper_arm_left:      { pos: [0.238, 1.265, 0],    face: [0, 1],  zoom: 1.0 },
  upper_arm_right:     { pos: [-0.238, 1.265, 0],   face: [0, 1],  zoom: 1.0 },
  elbow_left:          { pos: [0.262, 1.12, 0],     face: [0, 1],  zoom: 0.95 },
  elbow_right:         { pos: [-0.262, 1.12, 0],    face: [0, 1],  zoom: 0.95 },
  wrist_hand_left:     { pos: [0.296, 0.83, 0.02],  face: [0, 1],  zoom: 0.9 },
  wrist_hand_right:    { pos: [-0.296, 0.83, 0.02], face: [0, 1],  zoom: 0.9 },
  chest_lung_left:     { pos: [0.075, 1.3, 0.0],    face: [0, 1],  zoom: 1.1 },
  chest_lung_right:    { pos: [-0.075, 1.3, 0.0],   face: [0, 1],  zoom: 1.1 },
  heart:               { pos: [0.028, 1.245, 0.035], face: [0, 1], zoom: 1.0 },
  breast_left:         { pos: [0.085, 1.285, 0.085], face: [0, 1], zoom: 1.0 },
  breast_right:        { pos: [-0.085, 1.285, 0.085], face: [0, 1], zoom: 1.0 },
  thoracic_spine:      { pos: [0, 1.28, -0.072],    face: [0, -1], zoom: 1.25 },
  abdomen_general:     { pos: [0, 1.04, 0.055],     face: [0, 1],  zoom: 1.1 },
  liver:               { pos: [-0.065, 1.13, 0.025], face: [0, 1], zoom: 1.0 },
  gallbladder:         { pos: [-0.055, 1.095, 0.06], face: [0, 1], zoom: 0.95 },
  pancreas:            { pos: [0.01, 1.095, 0.0],   face: [0, 1],  zoom: 0.95 },
  spleen:              { pos: [0.1, 1.13, -0.025],  face: [0, 1],  zoom: 0.95 },
  stomach_intestines:  { pos: [0.03, 1.06, 0.05],   face: [0, 1],  zoom: 1.05 },
  kidney_left:         { pos: [0.065, 1.07, -0.045], face: [0, 1], zoom: 0.95 },
  kidney_right:        { pos: [-0.065, 1.06, -0.045], face: [0, 1], zoom: 0.95 },
  bladder:             { pos: [0, 0.935, 0.05],     face: [0, 1],  zoom: 0.95 },
  pelvis_reproductive: { pos: [0, 0.955, 0.02],     face: [0, 1],  zoom: 1.05 },
  lumbar_spine:        { pos: [0, 1.025, -0.062],   face: [0, -1], zoom: 1.05 },
  sacrum_coccyx:       { pos: [0, 0.92, -0.075],    face: [0, -1], zoom: 1.0 },
  hip_left:            { pos: [0.1, 0.925, 0.0],    face: [0, 1],  zoom: 1.0 },
  hip_right:           { pos: [-0.1, 0.925, 0.0],   face: [0, 1],  zoom: 1.0 },
  thigh_left:          { pos: [0.095, 0.72, 0],     face: [0, 1],  zoom: 1.05 },
  thigh_right:         { pos: [-0.095, 0.72, 0],    face: [0, 1],  zoom: 1.05 },
  knee_left:           { pos: [0.1, 0.5, 0.0],      face: [0, 1],  zoom: 1.0,  faceFromDetail: true },
  knee_right:          { pos: [-0.1, 0.5, 0.0],     face: [0, 1],  zoom: 1.0,  faceFromDetail: true },
  lower_leg_left:      { pos: [0.1, 0.3, 0.0],      face: [0, 1],  zoom: 1.0 },
  lower_leg_right:     { pos: [-0.1, 0.3, 0.0],     face: [0, 1],  zoom: 1.0 },
  ankle_foot_left:     { pos: [0.1, 0.06, 0.03],    face: [0, 1],  zoom: 0.85 },
  ankle_foot_right:    { pos: [-0.1, 0.06, 0.03],   face: [0, 1],  zoom: 0.85 },
};
// head_brain also turns towards the lobe that is involved.
ZONES.head_brain.faceFromDetail = true;

/* Spine levels: absolute [y, z] of each vertebral body (a ladder down the back). */
const SPINE_LEVELS = (() => {
  const L = {};
  for (let i = 1; i <= 7; i++) L["C" + i] = [1.565 - (i - 1) * 0.0165, -0.03];
  for (let i = 1; i <= 12; i++) L["T" + i] = [1.44 - (i - 1) * 0.0295, -0.06 - Math.sin(((i - 1) / 11) * Math.PI) * 0.018];
  for (let i = 1; i <= 5; i++) L["L" + i] = [1.09 - (i - 1) * 0.031, -0.058 + Math.sin(((i - 1) / 4) * Math.PI) * 0.008];
  L.S1 = [0.94, -0.07];
  return L;
})();

/* DETAIL_OFFSETS — offsets from the zone base position.
   "lat" means the x value is LATERAL (away from the midline): it is multiplied
   by the side sign (+1 patient-left, -1 patient-right). "abs" x is absolute. */
const DETAIL_OFFSETS = {
  lung: {             // lat
    upper:        [0, 0.07, 0.005],
    middle:       [0.005, 0.0, 0.02],
    lower:        [0.005, -0.068, 0.0],
    costophrenic: [0.04, -0.105, -0.005],
  },
  knee: {             // lat  (medial = towards the other knee)
    medial:    [-0.036, 0, 0],
    lateral:   [0.036, 0, 0],
    anterior:  [0, 0.005, 0.042],
    posterior: [0, -0.005, -0.04],
  },
  kidney: {           // lat
    upper: [-0.004, 0.04, 0],
    lower: [0.006, -0.04, 0.004],
  },
  brain: {            // lat (+ hemisphere shift when a side is given)
    frontal:   [0, 0.012, 0.066],
    parietal:  [0, 0.058, -0.012],
    temporal:  [0.062, -0.022, 0.012],
    occipital: [0, 0.004, -0.074],
  },
  brainHemisphere: 0.034, // lat shift for a left/right brain finding
  liver: {            // abs (liver lies on the patient's right)
    right: [-0.03, 0, 0],
    left:  [0.055, 0.012, 0.012],
  },
};

const SEVERITY_COLORS = { mild: 0xfacc15, moderate: 0xfb923c, severe: 0xf43f5e, unknown: 0x60a5fa };
const SPINE_ZONES = ["cervical_spine", "thoracic_spine", "lumbar_spine", "sacrum_coccyx"];

/* ---------------------------------------------------------------------
   Location detail parsing: backend findings carry text_from_report (and
   maybe a location_detail). We derive a structured detail from them.
   --------------------------------------------------------------------- */
function sideSign(side) { return side === "left" ? 1 : side === "right" ? -1 : 0; }

const MIDLINE_ZONES = ["cervical_spine", "thoracic_spine", "lumbar_spine", "sacrum_coccyx", "neck", "thyroid", "bladder", "pancreas", "abdomen_general", "stomach_intestines", "pelvis_reproductive", "face_sinuses"];
function resolveSide(finding, zoneId) {
  const s = finding.side;
  if (s === "left" || s === "right" || s === "both") return s;
  if (/_left$/.test(zoneId)) return "left";
  if (/_right$/.test(zoneId)) return "right";
  if (MIDLINE_ZONES.includes(zoneId)) return "not_applicable";
  return s || "not_stated";
}

function parseDetail(finding, zoneId) {
  let primary = (finding.location_detail || "").toString().trim();
  if (/^(not[_ ]?stated|null|none|n\/?a|unknown|mid)$/i.test(primary)) primary = "";
  const text = (primary + " " + (primary ? "" : (finding.text_from_report || "") + " " + (finding.explanation_en || "")))
    .toLowerCase().replace(/_/g, " ");
  const d = { kind: null };
  if (!zoneId) return d;

  if (SPINE_ZONES.includes(zoneId)) {
    const src = primary ? primary : (finding.text_from_report || "") + " " + (finding.explanation_en || "");
    const pair = src.match(/\b([CTLS])\s?(\d{1,2})\s*(?:-|–|\/|to|and)\s*([CTLS])?\s?(\d{1,2})\b/i);
    if (pair) {
      const a = pair[1].toUpperCase() + pair[2];
      const b = (pair[3] ? pair[3].toUpperCase() : pair[1].toUpperCase()) + pair[4];
      if (SPINE_LEVELS[a] && SPINE_LEVELS[b]) return { kind: "spine", levels: [a, b] };
    }
    // "T2" alone is usually an MRI sequence name, so in free text only trust C/L/S
    // (or "T12 vertebra"); a structured location_detail may use any letter.
    const single = (primary ? src.match(/\b([CTLS])\s?(\d{1,2})\b/i) : null)
      || src.match(/\b([CLS])\s?(\d{1,2})\b/) || src.match(/\bT\s?(\d{1,2})\s+vertebra/i);
    if (single) {
      const lv = single.length === 3 ? single[1].toUpperCase() + single[2] : "T" + single[1];
      if (SPINE_LEVELS[lv]) return { kind: "spine", levels: [lv] };
    }
    return d;
  }
  if (zoneId.startsWith("chest_lung")) {
    if (/costophrenic|cp angle/.test(text)) return { kind: "lung", part: "costophrenic" };
    if (/lower lobe|lower zone|\bbase\b|basal|\blower\b/.test(text)) return { kind: "lung", part: "lower" };
    if (/middle lobe|mid zone|middle zone|lingula/.test(text)) return { kind: "lung", part: "middle" };
    if (/upper lobe|upper zone|apex|apical|\bupper\b/.test(text)) return { kind: "lung", part: "upper" };
    return d;
  }
  if (zoneId.startsWith("knee")) {
    const parts = [];
    if (/\bmedial\b/.test(text)) parts.push("medial");
    if (/\blateral\b/.test(text)) parts.push("lateral");
    if (/\banterior\b|patell|front/.test(text)) parts.push("anterior");
    if (/\bposterior\b|baker|popliteal/.test(text)) parts.push("posterior");
    return parts.length ? { kind: "knee", parts } : d;
  }
  if (zoneId.startsWith("kidney")) {
    if (/upper pole|superior pole/.test(text)) return { kind: "kidney", part: "upper" };
    if (/lower pole|inferior pole/.test(text)) return { kind: "kidney", part: "lower" };
    return d;
  }
  if (zoneId === "head_brain") {
    const parts = [];
    if (/front/.test(text)) parts.push("frontal");
    if (/pariet/.test(text)) parts.push("parietal");
    if (/tempor/.test(text)) parts.push("temporal");
    if (/occipit/.test(text)) parts.push("occipital");
    return parts.length ? { kind: "brain", parts } : d;
  }
  if (zoneId === "liver") {
    if (/right lobe/.test(text)) return { kind: "liver", part: "right" };
    if (/left lobe/.test(text)) return { kind: "liver", part: "left" };
    return d;
  }
  return d;
}

/* Returns { pos:[x,y,z], face:[x,z], zoom } for a zone + side + detail. */
function findingPlacement(zoneId, side, detail) {
  const z = ZONES[zoneId];
  if (!z) return null;
  const s = sideSign(side) || (zoneId.endsWith("_left") ? 1 : zoneId.endsWith("_right") ? -1 : 0);
  let p = z.pos.slice();
  let off = [0, 0, 0];
  const addLat = (o, k = 1) => { off[0] += o[0] * (s || 1) * k; off[1] += o[1] * k; off[2] += o[2] * k; };

  if (detail.kind === "spine") {
    const ys = detail.levels.map((l) => SPINE_LEVELS[l]);
    const y = ys.reduce((a, v) => a + v[0], 0) / ys.length;
    const zz = ys.reduce((a, v) => a + v[1], 0) / ys.length;
    p = [0, y, zz];
  } else if (detail.kind === "lung") addLat(DETAIL_OFFSETS.lung[detail.part]);
  else if (detail.kind === "knee") detail.parts.forEach((k) => addLat(DETAIL_OFFSETS.knee[k]));
  else if (detail.kind === "kidney") addLat(DETAIL_OFFSETS.kidney[detail.part]);
  else if (detail.kind === "brain") {
    const k = 1 / detail.parts.length;
    detail.parts.forEach((b) => addLat(DETAIL_OFFSETS.brain[b], k));
    if (s) off[0] += DETAIL_OFFSETS.brainHemisphere * s;
  } else if (detail.kind === "liver") {
    const o = DETAIL_OFFSETS.liver[detail.part];
    off = [o[0], o[1], o[2]];
  } else if (zoneId === "head_brain" && s) {
    off[0] += DETAIL_OFFSETS.brainHemisphere * s;
  }

  const pos = [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
  let face = z.face;
  if (z.faceFromDetail && (Math.abs(off[0]) + Math.abs(off[2]) > 0.01)) {
    // Blend towards the front a little so the person stays recognisable.
    const fx = off[0], fz = off[2] + (off[2] >= 0 ? 0.01 : 0);
    const n = Math.hypot(fx, fz) || 1;
    face = [fx / n, fz / n];
  }
  let zoom = z.zoom;
  if (detail.kind === "spine") zoom = 0.95;
  return { pos, face, zoom };
}

/* Plain-language location ("lower part of the right lung"). */
function plainLocation(zoneId, zoneEn, side, detail) {
  const t = plainLocationRaw(zoneId, zoneEn, side, detail);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function plainLocationRaw(zoneId, zoneEn, side, detail) {
  const sw = side === "left" ? "left" : side === "right" ? "right" : "";
  const region = (lv) => ({ C: "neck", T: "middle back", L: "lower back", S: "base of the spine" })[lv[0]];
  switch (detail.kind) {
    case "spine": {
      const [a, b] = detail.levels;
      return b ? `Between ${a} and ${b} in the ${region(a)}` : `At the ${a} bone in the ${region(a)}`;
    }
    case "lung":
      if (detail.part === "costophrenic") return `Lower outer corner of the ${sw} lung, where it meets the breathing muscle`.replace("  ", " ");
      return `${detail.part} part of the ${sw} lung`.replace("  ", " ");
    case "knee": {
      const words = { medial: "inner", lateral: "outer", anterior: "front", posterior: "back" };
      return `${detail.parts.map((p) => words[p]).join(" ")} part of the ${sw} knee`.replace("  ", " ");
    }
    case "kidney":
      return `${detail.part === "upper" ? "Top" : "Bottom"} part of the ${sw} kidney`.replace("  ", " ");
    case "brain": {
      const words = { frontal: "front", parietal: "top", temporal: "side", occipital: "back" };
      const w = detail.parts.map((p) => words[p]);
      const list = w.length > 1 ? w.slice(0, -1).join(", ") + " and " + w[w.length - 1] : w[0];
      return `${list} of the brain${sw ? `, ${sw} side` : ""}`;
    }
    case "liver":
      return detail.part === "right" ? "Right lobe (the larger part) of the liver" : "Left lobe (the smaller part) of the liver";
  }
  if (side === "both") return `${zoneEn}, both sides`;
  return zoneEn || "Location not stated in the report";
}

/* Short tag for labels ("inner back", "L4–L5") */
function shortDetail(detail) {
  switch (detail.kind) {
    case "spine": return detail.levels.join("–");
    case "lung": return detail.part === "costophrenic" ? "lower corner" : detail.part + " part";
    case "knee": return detail.parts.map((p) => ({ medial: "inner", lateral: "outer", anterior: "front", posterior: "back" })[p]).join(" ");
    case "kidney": return detail.part + " part";
    case "brain": return detail.parts.map((p) => ({ frontal: "front", parietal: "top", temporal: "side", occipital: "back" })[p]).join(" + ");
    case "liver": return detail.part + " lobe";
  }
  return "";
}

function sideLabel(side) {
  return side === "left" ? "Patient's left" : side === "right" ? "Patient's right" : side === "both" ? "Both sides"
    : side === "not_applicable" ? "Middle of the body" : "Side not stated";
}

/* =====================================================================
   ENGINE
   ===================================================================== */
const Body3D = (() => {
  let renderer, scene, camera, pivot, body, shellMat, organMat, boneMat, floorMat, glowTex;
  let host, labelHost, running = false, ready = false, raf = 0, t0 = performance.now();
  let markers = [];          // { group, core, halo, ripple, color, label, data, sel }
  let debugPts = [];
  let insets = { top: 0, bottom: 0 };
  let userBusy = false, flight = null, idleSpin = null;
  let onSelectCb = () => {}, onViewCb = () => {};
  const cam = { fx: 0, fy: 0.9, fz: 0, yaw: 0, pitch: 0.06, dist: 3.4, y0: 0 };
  const BODY_COLOR = new THREE.Color(0x9fd4ff);
  const OK_COLOR = new THREE.Color(0x34d399);

  /* ---------- materials ---------- */
  function fresnelMaterial(color, { power = 2.2, intensity = 1.1, base = 0.035 } = {}) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uPower: { value: power },
        uIntensity: { value: intensity },
        uBase: { value: base },
        uAR: { value: 0 }, // 1 only in AR: alpha follows brightness so the glow stays see-through over the camera
      },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uPower; uniform float uIntensity; uniform float uBase; uniform float uAR;
        varying vec3 vN; varying vec3 vV;
        void main(){
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          f = pow(f, uPower);
          vec3 col = uColor * (f * uIntensity + uBase);
          gl_FragColor = vec4(col, mix(1.0, clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0), uAR));
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  function makeGlowTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.18, "rgba(255,255,255,0.85)");
    grd.addColorStop(0.45, "rgba(255,255,255,0.25)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    return tex;
  }

  /* ---------- geometry helpers ---------- */
  // Smooth tapered capsule from a -> b (r128 has no CapsuleGeometry).
  function limb(a, b, ra, rb, mat, segs = 18) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    const pts = [];
    const cap = 6;
    for (let i = 0; i <= cap; i++) {
      const t = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, ra * Math.cos(t)), ra * Math.sin(t)));
    }
    for (let i = 0; i <= cap; i++) {
      const t = (i / cap) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, rb * Math.cos(t)), len + rb * Math.sin(t)));
    }
    const geo = new THREE.LatheGeometry(pts, segs);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(A);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    return m;
  }
  function ellipsoid(pos, scale, mat, w = 20, h = 14) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, w, h), mat);
    m.position.set(...pos);
    m.scale.set(...scale);
    return m;
  }
  function bone(a, b, r, mat) { return limb(a, b, r, r * 0.9, mat, 8); }

  /* ---------- build the mannequin ---------- */
  function buildBody() {
    body = new THREE.Group();
    shellMat = fresnelMaterial(BODY_COLOR, { power: 2.1, intensity: 1.0, base: 0.03 });
    organMat = fresnelMaterial(0x6fb6ff, { power: 1.6, intensity: 0.42, base: 0.02 });
    boneMat = fresnelMaterial(0xdbeafe, { power: 1.2, intensity: 0.5, base: 0.05 });

    // Torso: lathe profile (radius, y), flattened front-to-back.
    const prof = [
      [0.0001, 0.855], [0.08, 0.86], [0.14, 0.885], [0.163, 0.92], [0.168, 0.96], [0.158, 1.0],
      [0.14, 1.06], [0.138, 1.1], [0.148, 1.16], [0.162, 1.22], [0.17, 1.29], [0.176, 1.35],
      [0.18, 1.395], [0.165, 1.43], [0.12, 1.455], [0.07, 1.47], [0.052, 1.48], [0.0001, 1.485],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const torso = new THREE.Mesh(new THREE.LatheGeometry(prof, 36), shellMat);
    torso.scale.set(1, 1, 0.6);
    body.add(torso);

    // Neck + head
    body.add(limb([0, 1.44, -0.008], [0, 1.54, 0.0], 0.05, 0.047, shellMat));
    body.add(ellipsoid([0, 1.635, 0.005], [0.094, 0.118, 0.106], shellMat, 28, 20));
    // Nose hint + ears make front/back obvious
    body.add(ellipsoid([0, 1.615, 0.106], [0.012, 0.022, 0.014], shellMat, 10, 8));
    body.add(ellipsoid([0.094, 1.625, 0.0], [0.012, 0.024, 0.016], shellMat, 10, 8));
    body.add(ellipsoid([-0.094, 1.625, 0.0], [0.012, 0.024, 0.016], shellMat, 10, 8));

    [1, -1].forEach((s) => {
      // Arms
      body.add(limb([0.2 * s, 1.405, 0], [0.26 * s, 1.12, 0], 0.05, 0.039, shellMat));
      body.add(limb([0.26 * s, 1.12, 0], [0.292 * s, 0.87, 0.02], 0.037, 0.029, shellMat));
      const hand = limb([0.293 * s, 0.865, 0.02], [0.303 * s, 0.755, 0.03], 0.031, 0.024, shellMat);
      hand.scale.set(1, 1, 0.6);
      body.add(hand);
      // Legs
      body.add(limb([0.092 * s, 0.93, 0], [0.1 * s, 0.5, 0], 0.078, 0.052, shellMat));
      body.add(limb([0.1 * s, 0.5, 0], [0.1 * s, 0.085, -0.01], 0.05, 0.034, shellMat));
      body.add(limb([0.1 * s, 0.055, -0.02], [0.112 * s, 0.03, 0.14], 0.036, 0.03, shellMat));

      // Skeleton (dim, inside)
      body.add(bone([0.088 * s, 0.92, 0], [0.1 * s, 0.52, 0], 0.012, boneMat));   // femur
      body.add(bone([0.1 * s, 0.48, 0], [0.1 * s, 0.09, -0.01], 0.011, boneMat)); // tibia
      body.add(bone([0.205 * s, 1.39, 0], [0.258 * s, 1.135, 0], 0.01, boneMat)); // humerus
      body.add(bone([0.262 * s, 1.105, 0], [0.29 * s, 0.88, 0.02], 0.008, boneMat)); // forearm
      body.add(bone([0.01 * s, 1.44, 0.045], [0.185 * s, 1.425, 0.0], 0.007, boneMat)); // clavicle
      body.add(ellipsoid([0.1 * s, 0.5, 0.042], [0.022, 0.026, 0.01], boneMat, 12, 8)); // kneecap
      // Organs
      body.add(ellipsoid([0.075 * s, 1.3, 0.0], [0.058, 0.11, 0.062], organMat));      // lungs
      body.add(ellipsoid([0.065 * s, 1.065, -0.045], [0.024, 0.042, 0.02], organMat, 14, 10)); // kidneys
    });

    body.add(ellipsoid([0, 1.655, 0.0], [0.078, 0.07, 0.088], organMat));            // brain
    body.add(ellipsoid([0.028, 1.245, 0.035], [0.042, 0.048, 0.038], organMat, 16, 12)); // heart
    body.add(ellipsoid([-0.06, 1.13, 0.02], [0.085, 0.045, 0.06], organMat));        // liver
    body.add(ellipsoid([0.05, 1.125, 0.035], [0.045, 0.038, 0.035], organMat, 14, 10)); // stomach
    body.add(ellipsoid([0, 0.935, 0.05], [0.03, 0.026, 0.026], organMat, 12, 8));    // bladder

    // Ribs (dimmer than other bones so they don't dominate the chest)
    const ribMat = fresnelMaterial(0xbfdbfe, { power: 1.4, intensity: 0.28, base: 0.02 });
    for (let i = 0; i < 5; i++) {
      const y = 1.39 - i * 0.045;
      const r = 0.12 + Math.sin((i / 5) * Math.PI) * 0.03 + i * 0.004;
      const rib = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 4, 40), ribMat);
      rib.rotation.x = Math.PI / 2 + 0.25;
      rib.position.set(0, y, 0);
      rib.scale.set(r, r * 0.65, 0.12); // local y -> depth after rotation; z squashes the tube
      body.add(rib);
    }
    // Pelvis ring
    const pelvis = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 40), boneMat);
    pelvis.rotation.x = Math.PI / 2 - 0.35;
    pelvis.position.set(0, 0.97, 0);
    pelvis.scale.set(0.11, 0.07, 0.3);
    body.add(pelvis);
    // Spine ladder
    Object.keys(SPINE_LEVELS).forEach((k) => {
      const [y, z] = SPINE_LEVELS[k];
      const w = k[0] === "C" ? 0.018 : k[0] === "T" ? 0.022 : 0.028;
      const v = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, w * 0.8), boneMat);
      v.position.set(0, y, z);
      body.add(v);
    });

    // Floor glow ring
    floorMat = new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.315, 64), floorMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    body.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.3, 48), new THREE.MeshBasicMaterial({ color: 0x1e3a8a, transparent: true, opacity: 0.18, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    body.add(disc);

    return body;
  }

  /* ---------- markers ---------- */
  function makeMarker(pos, colorHex, { size = 1, halo = true } = {}) {
    const g = new THREE.Group();
    g.position.set(...pos);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.014 * size, 16, 12),
      new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, depthTest: false, depthWrite: false })
    );
    core.renderOrder = 20;
    g.add(core);
    let haloS = null, ripple = null;
    if (halo) {
      haloS = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: colorHex, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }));
      haloS.scale.setScalar(0.11 * size);
      haloS.renderOrder = 19;
      g.add(haloS);
      ripple = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: colorHex, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, opacity: 0.5 }));
      ripple.renderOrder = 18;
      g.add(ripple);
    }
    return { group: g, core, halo: haloS, ripple, phase: Math.random() * 6 };
  }

  function clearMarkers() {
    markers.forEach((m) => { pivot && body.remove(m.group); m.label && m.label.remove(); });
    markers = [];
  }

  function setFindings(list) {
    clearMarkers();
    const placed = [];
    list.forEach((item, idx) => {
      if (!item.placement) return;
      let p = item.placement.pos.slice();
      // nudge apart markers that sit on the same spot
      let dup = 0;
      placed.forEach((q) => { if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 0.012) dup++; });
      if (dup) p[0] += (dup % 2 ? 1 : -1) * Math.ceil(dup / 2) * 0.02;
      placed.push(p);
      item.placement.pos = p;
      const color = SEVERITY_COLORS[item.severity] ?? SEVERITY_COLORS.unknown;
      const m = makeMarker(p, color);
      m.color = color;
      m.data = item;
      m.index = idx;
      body.add(m.group);
      const label = document.createElement("div");
      label.className = "mlabel";
      label.style.color = "#" + new THREE.Color(color).getHexString();
      const shortName = item.short || item.zone_en;
      label.innerHTML = `<b><span class="sw"></span><span style="color:var(--text)"><span class="full">${escHtml(item.zone_en)}</span><span class="brief">${escHtml(shortName)}</span></span></b><small>${escHtml(sideLabel(item.side))}${item.short ? " · " + escHtml(item.short) : ""}</small>`;
      label.addEventListener("click", (e) => { e.stopPropagation(); onSelectCb(idx); });
      labelHost.appendChild(label);
      m.label = label;
      markers.push(m);
    });
  }

  function highlight(idx) {
    markers.forEach((m) => {
      m.sel = m.index === idx;
      m.label.classList.toggle("sel", m.sel);
      m.label.classList.toggle("dim", idx != null && !m.sel);
      m.lw = 0; // width changes with the compact/full style
    });
  }

  function setNormal(isNormal) {
    const target = isNormal ? OK_COLOR : BODY_COLOR;
    const c = shellMat.uniforms.uColor.value;
    const o = { r: c.r, g: c.g, b: c.b };
    tween(o, { r: target.r, g: target.g, b: target.b, duration: 1.2, onUpdate: () => c.setRGB(o.r, o.g, o.b) });
    const oc = organMat.uniforms.uColor.value;
    const t2 = isNormal ? new THREE.Color(0x4ade80) : new THREE.Color(0x6fb6ff);
    const o2 = { r: oc.r, g: oc.g, b: oc.b };
    tween(o2, { r: t2.r, g: t2.g, b: t2.b, duration: 1.2, onUpdate: () => oc.setRGB(o2.r, o2.g, o2.b) });
    floorMat.color.set(isNormal ? 0x34d399 : 0x2dd4bf);
  }

  /* ---------- debug overlay ---------- */
  function buildDebug() {
    const add = (pos, text, cls, color) => {
      const m = makeMarker(pos, color, { size: 0.55, halo: false });
      body.add(m.group);
      const l = document.createElement("div");
      l.className = "mlabel debug " + cls;
      l.textContent = text;
      labelHost.appendChild(l);
      m.label = l;
      debugPts.push(m);
    };
    Object.keys(ZONES).forEach((id) => add(ZONES[id].pos, id, "", 0x22d3ee));
    const det = (zone, side, detail, text) => {
      const pl = findingPlacement(zone, side, detail);
      if (pl) add(pl.pos, text, "detail", 0xe879f9);
    };
    ["left", "right"].forEach((sd) => {
      const S = sd[0].toUpperCase();
      ["upper", "middle", "lower", "costophrenic"].forEach((p) => det("chest_lung_" + sd, sd, { kind: "lung", part: p }, `lung${S} ${p}`));
      ["medial", "lateral", "anterior", "posterior"].forEach((p) => det("knee_" + sd, sd, { kind: "knee", parts: [p] }, `knee${S} ${p}`));
      ["upper", "lower"].forEach((p) => det("kidney_" + sd, sd, { kind: "kidney", part: p }, `kid${S} ${p}`));
      ["frontal", "parietal", "temporal", "occipital"].forEach((p) => det("head_brain", sd, { kind: "brain", parts: [p] }, `br${S} ${p}`));
    });
    ["right", "left"].forEach((p) => det("liver", "not_stated", { kind: "liver", part: p }, `liver ${p}`));
    Object.keys(SPINE_LEVELS).forEach((lv) => {
      const [y, z] = SPINE_LEVELS[lv];
      add([0, y, z], lv, "detail", 0xe879f9);
    });
  }

  /* ---------- camera ---------- */
  function applyCamera() {
    body.position.set(-cam.fx, -cam.fy, -cam.fz);
    pivot.rotation.set(cam.pitch, cam.yaw, 0, "XYZ");
    camera.position.set(0, 0, cam.dist);
    camera.lookAt(0, 0, 0);
  }

  function updateViewOffset() {
    if (!renderer) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const c = (insets.top + (h - insets.bottom)) / 2;
    cam.y0 = h / 2 - c;
    camera.setViewOffset(w, h, 0, cam.y0, w, h);
    camera.updateProjectionMatrix();
  }

  function overviewDist() {
    const h = host.clientHeight || 600, w = host.clientWidth || 400;
    const visH = Math.max(160, h - insets.top - insets.bottom);
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const byH = (1.9 / 2) / (tanH * (visH / h));
    const byW = (0.85 / 2) / (tanH * (w / h));
    return Math.max(byH, byW) * 1.06;
  }

  function nearestYaw(target) {
    let t = target;
    while (t - cam.yaw > Math.PI) t -= Math.PI * 2;
    while (t - cam.yaw < -Math.PI) t += Math.PI * 2;
    return t;
  }

  function flyTo({ fx, fy, fz, yaw, pitch = 0.06, dist, duration = 1.5 }) {
    stopIdle();
    if (flight) flight.kill();
    flight = tween(cam, {
      fx, fy, fz, yaw: nearestYaw(yaw), pitch, dist, duration, ease: "power3.inOut",
      onUpdate: () => { applyCamera(); onViewCb(cam); },
      onComplete: () => { flight = null; },
    });
  }

  function spanDist(span) {
    const h = host.clientHeight || 600;
    const visH = Math.max(160, h - insets.top - insets.bottom);
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return span / (2 * tanH * (visH / h));
  }

  function focusPlacement(pl) {
    const [fx, fz] = pl.face;
    const yaw = Math.atan2(-fx, fz);
    const dist = Math.min(spanDist(pl.zoom * 0.6), overviewDist());
    flyTo({ fx: pl.pos[0], fy: pl.pos[1], fz: pl.pos[2], yaw, dist });
  }

  function resetView({ yaw = 0, duration = 1.2 } = {}) {
    flyTo({ fx: 0, fy: 0.9, fz: 0, yaw, pitch: 0.06, dist: overviewDist(), duration });
  }

  function introSpin(then) {
    stopIdle();
    cam.fx = 0; cam.fy = 0.9; cam.fz = 0; cam.dist = overviewDist(); cam.yaw = -0.9; cam.pitch = 0.06;
    applyCamera();
    idleSpin = tween(cam, { yaw: 0.35, duration: 1.8, ease: "sine.inOut", onUpdate: () => { applyCamera(); onViewCb(cam); }, onComplete: () => { idleSpin = null; then && then(); } });
  }
  function stopIdle() { if (idleSpin) { idleSpin.kill(); idleSpin = null; } }

  /* ---------- input: own pointer handlers (drag rotate, pinch/wheel zoom, tap) ---------- */
  function bindInput(el) {
    const pts = new Map();
    let pinch0 = 0, dist0 = 0, downPos = null, moved = 0;
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      userBusy = true; stopIdle(); if (flight) { flight.kill(); flight = null; }
      if (pts.size === 1) { downPos = { x: e.clientX, y: e.clientY }; moved = 0; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y); dist0 = cam.dist;
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 1) {
        const dx = cur.x - prev.x, dy = cur.y - prev.y;
        moved += Math.abs(dx) + Math.abs(dy);
        cam.yaw += dx * 0.009;
        cam.pitch = Math.max(-0.7, Math.min(0.7, cam.pitch + dy * 0.005));
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0 > 0) cam.dist = clampDist(dist0 * (pinch0 / d));
        moved += 100;
      }
      applyCamera(); onViewCb(cam);
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size === 0) {
        userBusy = false;
        if (downPos && moved < 8) tapAt(e.clientX, e.clientY);
        downPos = null;
      }
      if (pts.size === 1) { downPos = null; pinch0 = 0; }
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      stopIdle(); if (flight) { flight.kill(); flight = null; }
      cam.dist = clampDist(cam.dist * Math.exp(e.deltaY * 0.0015));
      applyCamera(); onViewCb(cam);
    }, { passive: false });
  }
  function clampDist(d) { return Math.max(0.45, Math.min(overviewDist() * 1.5, d)); }

  function tapAt(cx, cy) {
    const r = host.getBoundingClientRect();
    let best = null, bd = 44;
    markers.forEach((m) => {
      if (!m.screen) return;
      const d = Math.hypot(m.screen.x - (cx - r.left), m.screen.y - (cy - r.top));
      if (d < bd) { bd = d; best = m; }
    });
    if (best) onSelectCb(best.index);
  }

  /* ---------- loop ---------- */
  const v3 = new THREE.Vector3();
  function projectLabel(m, offX = 16, offY = 0) {
    m.group.getWorldPosition(v3);
    v3.project(camera);
    const w = host.clientWidth, h = host.clientHeight;
    const x = (v3.x * 0.5 + 0.5) * w, y = (-v3.y * 0.5 + 0.5) * h;
    m.screen = { x, y };
    const vis = v3.z < 1 && x > -40 && x < w + 40 && y > -20 && y < h + 20;
    m.label.style.display = vis ? "" : "none";
    if (vis) {
      // flip label to the left if it would overflow the right edge
      if (!m.lw) m.lw = m.label.offsetWidth;
      const lw = m.lw || 120;
      let left = x + offX + lw > w - 70 ? x - offX - lw : x + offX;
      left = Math.max(4, Math.min(w - lw - 4, left));
      m.lp = { x: left, y: y + offY };
      m.label.style.transform = `translate(${left.toFixed(1)}px, ${(y - 16 + offY).toFixed(1)}px)`;
      m.label.classList.toggle("flip", left < x);
    }
  }

  // Push overlapping finding labels apart vertically (selected label wins its spot).
  function declutter() {
    const vis = markers.filter((m) => m.lp && m.label.style.display !== "none");
    if (vis.length < 2) return;
    vis.sort((a, b) => (b.sel - a.sel) || (a.lp.y - b.lp.y));
    const placed = [];
    vis.forEach((m) => {
      const h = m.sel ? 46 : 32;
      let y = m.lp.y;
      for (let k = 0; k < 8; k++) {
        const hit = placed.find((p) => Math.abs(p.y - y) < (p.h + h) / 2 + 2 && p.x < m.lp.x + m.lw && m.lp.x < p.x + p.w);
        if (!hit) break;
        y = hit.y + (hit.h + h) / 2 + 3;
      }
      placed.push({ x: m.lp.x, y, w: m.lw || 120, h });
      if (y !== m.lp.y) m.label.style.transform = `translate(${m.lp.x.toFixed(1)}px, ${(y - 16).toFixed(1)}px)`;
    });
  }

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const t = (performance.now() - t0) / 1000;
    markers.forEach((m) => {
      const k = m.sel ? 1.6 : 1;
      const pulse = 1 + Math.sin(t * 3 + m.phase) * 0.18;
      m.halo.scale.setScalar(0.1 * k * pulse);
      m.core.scale.setScalar(k * (0.95 + Math.sin(t * 3 + m.phase) * 0.08));
      const rp = ((t * 0.6 + m.phase) % 1);
      m.ripple.scale.setScalar(0.06 * k + rp * 0.2 * k);
      m.ripple.material.opacity = (1 - rp) * (m.sel ? 0.55 : 0.3);
    });
    renderer.render(scene, camera);
    markers.forEach((m) => projectLabel(m));
    declutter();
    debugPts.forEach((m) => projectLabel(m, 6, 0));
  }

  function resize() {
    if (!renderer) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    updateViewOffset();
  }

  /* ---------- public ---------- */
  function init(hostEl, labelEl, { onSelect, onView } = {}) {
    if (ready) return true;
    host = hostEl; labelHost = labelEl;
    onSelectCb = onSelect || onSelectCb;
    onViewCb = onView || onViewCb;
    if (!window.THREE) throw new Error("3D library did not load");
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.05, 30);
    pivot = new THREE.Group();
    scene.add(pivot);
    glowTex = makeGlowTexture();
    pivot.add(buildBody());
    if (window.FLAGS && FLAGS.debug) buildDebug();
    bindInput(renderer.domElement);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(host);
    window.addEventListener("resize", resize);
    resize();
    cam.dist = overviewDist();
    applyCamera();
    ready = true;
    return true;
  }

  function start() { if (!ready || running) return; running = true; resize(); frame(); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  function setInsets(top, bottom) {
    const o = { top: insets.top, bottom: insets.bottom };
    tween(o, { top, bottom, duration: 0.45, ease: "power2.out", onUpdate: () => { insets.top = o.top; insets.bottom = o.bottom; updateViewOffset(); } });
  }

  return {
    init, start, stop, setFindings, highlight, setNormal, focusPlacement, resetView, introSpin,
    setInsets, get cam() { return cam; }, get ready() { return ready; },
    faceFront: () => resetView({ yaw: 0 }),
    faceBack: () => resetView({ yaw: Math.PI }),
    get shellColor() { return shellMat && shellMat.uniforms.uColor.value.getHexString(); },
    // Used by ar.js to reuse the same renderer, scene, body and markers in WebXR.
    _internals: () => ready ? {
      renderer, scene, camera, pivot, body, markers, glowTex,
      applyCamera, resize, stopLoop: stop, startLoop: start,
    } : null,
  };
})();
