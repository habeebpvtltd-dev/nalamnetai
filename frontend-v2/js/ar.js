/* ar.js — "View in your room": WebXR immersive-ar on top of the SAME three.js
   scene used by the 3D viewer (same body, materials and markers).
   - Session requested by hand (no ARButton): hit-test and dom-overlay both OPTIONAL.
   - Placement never depends on hit-test: "Tap to place body" puts the body 1.2 m in
     front of / 0.9 m below the viewer, facing them (retries next frame if no pose).
     The hit-test reticle is cosmetic only. Table/Life size, Move, Exit.
   - Canvas-sprite labels, tap-to-pick markers from the XR select ray, finding card in the overlay.
   Any failure ends the session and returns to the normal 3D view. */

window.BodyAR = !window.THREE ? null : (() => {
  const $ = (id) => document.getElementById(id);
  // Target standing heights in metres. The scale is computed from the MEASURED mesh
  // height on AR entry (see fitModel), so the rendered figure really is this tall.
  const TARGET_H = { table: 0.38, life: 1.65 };
  let modelH = 1.75;                                    // refined by fitModel()
  const SCALE = { table: TARGET_H.table / modelH, life: TARGET_H.life / modelH };
  const LABEL_W = { table: 0.13, life: 0.32 };          // label width in metres
  // Markers scale with the body; at table size that makes the core only ~3 mm wide,
  // so give markers a minimum readable size there (life size needs no boost).
  const MARKER_BOOST = { table: { core: 1.8, halo: 1.3 }, life: { core: 1, halo: 1 } };
  // Over a real camera image the faint body shell nearly disappears; brighten it in AR only.
  const AR_GLOW = { intensity: 1.7, base: 2.2 };        // multipliers, restored on exit
  // WebXR anchors keep the body locked to the real world while ARCore refines tracking.
  // DEFAULT: anchors ON (tracking-state gating, implausible-jump rejection, smoothing).
  // ?anchors=0 turns them off (fixed transform set at placement, in 'local' space) as a
  // venue safety valve.
  const ANCHORS_ON = !/[?&]anchors=0\b/.test(window.location.search);
  const PICK_ANGLE = THREE.MathUtils ? THREE.MathUtils.degToRad(8) : 0.14;
  // ?ardebug=1: live on-screen diagnostics (read-only; never changes placement/scale/anchor).
  const DEBUG = /[?&]ardebug=1\b/.test(window.location.search);
  const dbg = {
    pose: null, hits: 0, anchorErr: "", anchorMade: 0, frames: 0, lostFrames: 0,
    lastPos: null, lastQuat: null, delta: 0, rotDelta: 0, maxDelta1s: 0, deltas: [],
    fpsN: 0, fpsT: 0, fps: 0, lastSampleT: 0, history: [], lastText: "",
  };

  let session = null, hitSource = null, refSpace = null;
  let I = null;                // Body3D internals
  let arRoot = null, reticle = null;
  let placed = false, size = "table", sel = -1;
  let items = [], report = null;
  let blendSaved = [], labelSprites = [];
  let cleaning = false, failed = false, overlayBound = false;
  // Latest viewer pose, refreshed every XR frame. hasPose=false until a frame
  // delivers a pose (or after a tracking hiccup returns null).
  const viewerPos = new THREE.Vector3();
  const viewerQuat = new THREE.Quaternion();
  let hasPose = false;
  let pendingPlace = false;       // tap arrived with no pose -> place on the next frame that has one
  let lastPlaceTap = -Infinity;   // debounce for the place/move buttons
  let anchor = null;              // XRAnchor pinning the placed body to the world (if supported)
  let anchorWanted = false;       // create an anchor on the next XR frame (needs an active frame)
  // Anchor sanity guard. A stationary anchor never legitimately teleports: after a tracking
  // LOST -> OK recovery ARCore can report a bogus anchor pose (seen on device: +11 m in Y).
  const MAX_ANCHOR_JUMP_M = 2.0;                            // per applied update
  const MAX_ANCHOR_TURN = THREE.MathUtils.degToRad(45);
  const ANCHOR_DETACH_AFTER = 30;                           // consecutive rejects -> stop following
  const goodAnchorPos = new THREE.Vector3(), goodAnchorQuat = new THREE.Quaternion();
  let haveGoodAnchor = false, anchorRejects = 0, anchorLog = [];
  let trackingOK = false;         // this frame has a real (non-emulated) viewer pose
  let pendingFocus = -1;          // focus requested while tracking was not OK -> retry when it is
  const PLACE_DEBOUNCE_MS = 400;
  // Placement distance per size: Life is placed further away so the whole 1.65 m figure
  // fits in the phone's view without stepping back. Base is 0.9 m below the viewer's eyes.
  const PLACE_DIST = { table: 1.2, life: 2.3 }, PLACE_DROP = 0.9;
  const FOCUS_MS = 600;           // eased tap-to-focus / return
  const FOCUS_REGION = 0.35;      // metres of body shown around a focused finding
  let camVFov = THREE.MathUtils.degToRad(50);   // phone camera vertical FOV (read from XR views)
  let rig = null;                 // child of arRoot: temporary focus transform (identity when idle)
  let focusAnim = null;           // { from:{p,q,s}, to:{p,q,s}, t0 } eased inside step()
  let focusedIdx = -1;
  let pendingMode = "place";      // what a pose-less tap should do when a pose arrives
  const t0 = performance.now();

  /* ---------- support check ---------- */
  async function isSupported() {
    try {
      if (!window.isSecureContext || !navigator.xr || !navigator.xr.isSessionSupported) return false;
      return !!(await navigator.xr.isSessionSupported("immersive-ar"));
    } catch (e) {
      return false;
    }
  }

  /* ---------- AR-only blending (restored on exit) ----------
     Additive glow writes alpha=1, which the XR compositor would draw as a dark
     silhouette over the camera. In AR: add colour, and let alpha follow brightness. */
  function setArBlending(on) {
    if (on) {
      blendSaved = [];
      const seen = new Set();
      I.body.traverse((o) => {
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        mats.forEach((m) => {
          if (seen.has(m) || m.blending !== THREE.AdditiveBlending) return;
          seen.add(m);
          blendSaved.push(m);
          m.blending = THREE.CustomBlending;
          m.blendEquation = THREE.AddEquation;
          m.blendSrc = m.isShaderMaterial ? THREE.OneFactor : THREE.SrcAlphaFactor;
          m.blendDst = THREE.OneFactor;
          m.blendSrcAlpha = THREE.OneFactor;
          m.blendDstAlpha = THREE.OneFactor;
          if (m.uniforms && m.uniforms.uAR) {
            m.uniforms.uAR.value = 1;
            // Brighter body over the camera feed (originals restored on exit).
            m.userData.arSaved = { i: m.uniforms.uIntensity.value, b: m.uniforms.uBase.value };
            m.uniforms.uIntensity.value *= AR_GLOW.intensity;
            m.uniforms.uBase.value *= AR_GLOW.base;
          }
          m.needsUpdate = true;
        });
      });
    } else {
      blendSaved.forEach((m) => {
        m.blending = THREE.AdditiveBlending;
        if (m.uniforms && m.uniforms.uAR) {
          m.uniforms.uAR.value = 0;
          if (m.userData.arSaved) {
            m.uniforms.uIntensity.value = m.userData.arSaved.i;
            m.uniforms.uBase.value = m.userData.arSaved.b;
            delete m.userData.arSaved;
          }
        }
        m.needsUpdate = true;
      });
      blendSaved = [];
    }
  }

  /* ---------- 3D labels (canvas-texture sprites, always face the camera) ---------- */
  function drawLabel(sp) {
    const { ctx, item, color } = sp.userData;
    const c = ctx.canvas, selected = sp.userData.index === sel;
    ctx.clearRect(0, 0, c.width, c.height);
    const r = 34, x = 6, y = 6, w = c.width - 12, h = c.height - 12;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    ctx.fillStyle = selected ? "rgba(8,18,40,0.94)" : "rgba(5,11,26,0.82)";
    ctx.fill();
    ctx.lineWidth = selected ? 7 : 3;
    ctx.strokeStyle = selected ? color : "rgba(148,197,255,0.45)";
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(52, 64, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#eef4ff";
    ctx.font = "700 42px Inter, system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fit(ctx, item.zone_en, w - 90), 82, 60);
    ctx.fillStyle = "#bccbe3";
    ctx.font = "500 32px Inter, system-ui, sans-serif";
    ctx.fillText(fit(ctx, sideLabel(item.side), w - 90), 82, 102);
    sp.material.map.needsUpdate = true;
  }
  function fit(ctx, text, max) {
    let t = String(text || "");
    if (ctx.measureText(t).width <= max) return t;
    while (t.length > 3 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
    return t + "…";
  }

  function buildLabels() {
    labelSprites = [];
    I.markers.forEach((m) => {
      const c = document.createElement("canvas");
      c.width = 512; c.height = 128;
      const tex = new THREE.CanvasTexture(c);
      tex.minFilter = THREE.LinearFilter;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
      sp.center.set(-0.1, 0.5);   // anchor left-middle, a little right of the marker
      sp.renderOrder = 30;
      sp.userData = { ctx: c.getContext("2d"), item: m.data, index: m.index, color: "#" + new THREE.Color(m.color).getHexString() };
      m.group.add(sp);
      labelSprites.push(sp);
      drawLabel(sp);
    });
    scaleLabels();
  }
  function scaleLabels() {
    const w = LABEL_W[size] / (SCALE[size] * (rig ? rig.scale.x : 1));  // sprites live inside the scaled body
    labelSprites.forEach((sp) => sp.scale.set(w, w / 4, 1));
  }
  function removeLabels() {
    labelSprites.forEach((sp) => {
      sp.parent && sp.parent.remove(sp);
      sp.material.map.dispose();
      sp.material.dispose();
    });
    labelSprites = [];
  }

  function buildReticle() {
    const g = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.07, 0.085, 40).rotateX(-Math.PI / 2);
    const dotGeo = new THREE.CircleGeometry(0.012, 20).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.95, depthTest: false });
    g.add(new THREE.Mesh(ringGeo, mat), new THREE.Mesh(dotGeo, mat));
    g.matrixAutoUpdate = false;
    g.visible = false;
    g.renderOrder = 40;
    return g;
  }

  /* ---------- overlay UI ---------- */
  function overlayHtml() {
    const r = report || {};
    const contact = (store.get("contact") || "").replace(/[^\d+]/g, "");
    let banner = "";
    if (r.is_critical) {
      banner = `<div class="ar-banner crit">Your report mentions a finding the doctor may need to see soon. <strong>Please contact your doctor today.</strong>
        ${contact ? `<a class="btn btn-danger" href="tel:${escHtml(contact)}">📞 Call</a>` : ""}</div>`;
    } else if (r.overall_normal && !items.length) {
      banner = `<div class="ar-banner ok">✅ Your report does not mention any problem areas.</div>`;
    }
    return `
      <div class="ar-top">
        <button class="ar-btn" id="ar-exit">✕ Exit AR</button>
        <div class="ar-seg" role="group" aria-label="Size">
          <button data-size="table" class="${size === "table" ? "active" : ""}">Table size</button>
          <button data-size="life" class="${size === "life" ? "active" : ""}">Life size</button>
        </div>
      </div>
      ${banner}
      <button id="ar-place-btn" class="ar-place-btn" type="button">Tap to place body</button>
      <div class="ar-hint" id="ar-hint" hidden></div>
      ${DEBUG ? `<div id="ar-debug" class="ar-debug"><pre id="ar-debug-text">AR debug: waiting for first frame…</pre><button id="ar-debug-copy" type="button">Copy debug log</button></div>` : ""}
      <div class="ar-bottom">
        <div class="ar-card" id="ar-card" hidden></div>
        <div class="ar-actions" id="ar-actions" hidden>
          ${items.length > 1 ? `<button class="ar-btn" id="ar-prev" aria-label="Previous finding">‹ Prev</button>` : ""}
          <button class="ar-btn" id="ar-fit" aria-label="Fit whole body in view">⤢ Fit</button>
          <button class="ar-btn" id="ar-move">↻ Move</button>
          ${items.length ? `<button class="ar-btn primary" id="ar-next">Next ›</button>` : ""}
        </div>
      </div>`;
  }

  function bindOverlay() {
    $("ar-exit").onclick = exit;
    $("ar-overlay").querySelectorAll(".ar-seg button").forEach((b) => (b.onclick = () => setSize(b.dataset.size)));
    // Placement is driven ONLY by these real DOM buttons (never by hit-test or screen taps).
    $("ar-place-btn").onclick = () => requestPlace("place");
    $("ar-move").onclick = () => { hideCard(); requestPlace("place"); };
    $("ar-fit").onclick = () => { hideCard(); requestPlace("fit"); };
    const nx = $("ar-next");
    if (nx) nx.onclick = () => select(items.length ? (sel + 1 + items.length) % items.length : -1);
    const pv = $("ar-prev");
    if (pv) pv.onclick = () => select(items.length ? (Math.max(sel, 0) - 1 + items.length) % items.length : -1);
    const dc = $("ar-debug-copy");
    if (dc) dc.onclick = copyDebug;
  }

  function updateHint() {
    const h = $("ar-hint");
    if (!h) return;
    $("ar-actions").hidden = !placed;
    const btn = $("ar-place-btn");
    if (btn) btn.hidden = placed;
    if (placed && items.length && sel < 0) { h.hidden = false; h.textContent = "Tap a glowing spot to learn more"; }
    else if (!placed && pendingPlace) { h.hidden = false; h.textContent = "Finding your position…"; }
    else h.hidden = true;
  }

  // Rescale in place: only the scale changes. arRoot's origin is the body's feet, so the
  // figure grows/shrinks where it stands; position, rotation and the anchor are untouched.
  function setSize(s) {
    size = s;
    $("ar-overlay").querySelectorAll(".ar-seg button").forEach((b) => b.classList.toggle("active", b.dataset.size === s));
    clearFocus(true);
    if (arRoot) { arRoot.scale.setScalar(SCALE[s]); arRoot.updateMatrixWorld(true); }
    scaleLabels();
    // Rescaling in place keeps the anchor; if a Life-size figure is now too close to see
    // whole, point the user at "Fit" rather than silently moving it.
    if (placed && s === "life" && hasPose && arRoot && viewerPos.distanceTo(arRoot.position) < 2.0) {
      const h = $("ar-hint");
      if (h) { h.hidden = false; h.textContent = "Tap ⤢ Fit to see the whole body"; }
      const f = $("ar-fit"); if (f) f.classList.add("pulse");
    }
  }

  const SEV_WORD = { severe: "Severe", moderate: "Moderate", mild: "Mild", unknown: "Not stated" };
  function showCard(it) {
    const card = $("ar-card");
    card.innerHTML = `
      <div class="ar-card-head">
        <div>
          <div class="ar-card-title">${escHtml(it.zone_en)}</div>
          ${it.zone_ta ? `<div class="f-title-ta" lang="ta">${escHtml(it.zone_ta)}</div>` : ""}
        </div>
        <button class="ar-x" id="ar-card-close" aria-label="Close">✕</button>
      </div>
      <div class="f-chips">
        <span class="chip chip-side">${escHtml(sideLabel(it.side))}</span>
        <span class="chip sev sev-${it.severity}">${SEV_WORD[it.severity] || "Not stated"}</span>
      </div>
      <div class="ar-loc">📍 ${escHtml(it.location)}</div>
      <div class="ar-exp">${escHtml(it.f.explanation_en || "The report mentions this area.")}</div>
      <button class="btn btn-primary btn-block" id="ar-listen">🔊 Listen</button>
      <div class="disclaimer">ℹ️ This explains your report in simple words. Please discuss it with your doctor.</div>`;
    card.hidden = false;
    $("ar-card-close").onclick = hideCard;
    $("ar-listen").onclick = () => listen(it);
  }
  function hideCard() {
    const c = $("ar-card");
    if (c) c.hidden = true;
    stopAnyAudio();
    if (focusedIdx >= 0) unfocus();
  }

  async function listen(it) {
    const b = $("ar-listen");
    b.disabled = true; b.textContent = "Preparing voice…";
    try {
      const text = `${it.zone_en}, ${sideLabel(it.side).toLowerCase()}. ${it.location}. ${it.f.explanation_en || ""} This explains your report in simple words. Please discuss it with your doctor.`;
      await speakText(`ar-${sel}`, text, "en");
      if ($("ar-listen") === b) b.textContent = "🔊 Listen again";
    } catch (e) {
      if ($("ar-listen") === b) b.textContent = "🔊 Listen";
    } finally {
      if ($("ar-listen") === b) b.disabled = false;
    }
  }

  function select(i) {
    if (i < 0 || !items[i]) return;
    sel = i;
    Body3D.highlight(i);
    labelSprites.forEach(drawLabel);
    showCard(items[i]);
    updateHint();
    focusOn(i);
  }

  /* ---------- tap-to-focus (AR version of the 3D fly-to-finding) ----------
     The phone is the camera, so instead the BODY eases (~0.6 s) to sit in front of the
     viewer, turned so the finding faces them and scaled so ~35 cm around it fills the view.
     The target is computed ONCE from the viewer pose at tap time, as an offset of `rig`
     under the anchored arRoot, so the result is world-fixed and does not follow the phone. */
  const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _vA = new THREE.Vector3();
  function rigNow() { return { p: rig.position.clone(), q: rig.quaternion.clone(), s: rig.scale.x }; }
  const IDENTITY = () => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1 });

  function animateRig(to) {
    if (!rig) return;
    focusAnim = { from: rigNow(), to, t0: performance.now() };
  }

  function focusOn(i) {
    try {
      const m = I.markers.find((x) => x.index === i);
      const pl = items[i] && items[i].placement;
      // No TRACKING pose right now (LOST/LIMITED): focus as soon as tracking is back,
      // rather than computing from an untrustworthy pose.
      if (placed && rig && m && pl && !hasPose) { pendingFocus = i; return; }
      if (!placed || !rig || !hasPose || !m || !pl) { if (focusedIdx >= 0) unfocus(); return; }
      arRoot.updateMatrixWorld(true);
      const sRoot = arRoot.scale.x;
      // Scale: show FOCUS_REGION metres around the finding; never shrink below current size.
      const span = (pl.zoom || 1) * 0.6;                   // body units around the spot
      const sWorld = Math.max(sRoot, FOCUS_REGION / span);
      // Distance so that region fills ~60% of the camera's vertical view.
      const dist = Math.min(1.4, Math.max(0.45, (span * sWorld) / (2 * Math.tan(camVFov / 2)) / 0.6));
      // Where the finding should end up: straight ahead, a little below eye level.
      const yaw = new THREE.Euler().setFromQuaternion(viewerQuat, "YXZ").y;
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const target = viewerPos.clone().addScaledVector(fwd, dist); target.y -= 0.08;
      // Turn so the finding's face direction points back at the viewer.
      const [fx, fz] = pl.face || [0, 1];
      const toViewer = fwd.clone().negate();
      const psi = Math.atan2(toViewer.x, toViewer.z) - Math.atan2(fx, fz);
      const qW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), psi);
      // Marker position in rig space = body offset + marker offset (body units).
      const mInRig = I.body.position.clone().add(m.group.position);
      const tW = target.clone().sub(mInRig.clone().multiplyScalar(sWorld).applyQuaternion(qW));
      // Desired rig WORLD transform -> rig LOCAL (relative to the anchored arRoot).
      _m1.compose(tW, qW, new THREE.Vector3(sWorld, sWorld, sWorld));
      _m2.copy(arRoot.matrixWorld).invert().multiply(_m1);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      _m2.decompose(p, q, sc);
      focusedIdx = i;
      animateRig({ p, q, s: sc.x });
    } catch (e) {
      console.warn("AR focus failed", e);
    }
  }

  function unfocus() {
    focusedIdx = -1;
    animateRig(IDENTITY());
  }

  // Instant reset (used before Move/Fit/size switch so placement math starts clean).
  function clearFocus(instant) {
    focusedIdx = -1;
    focusAnim = null;
    if (rig && instant) { rig.position.set(0, 0, 0); rig.quaternion.identity(); rig.scale.setScalar(1); rig.updateMatrixWorld(true); scaleLabels(); }
  }

  function stepFocus(now) {
    if (!focusAnim || !rig) return;
    const k = Math.min(1, (now - focusAnim.t0) / FOCUS_MS);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // easeInOutCubic
    const { from, to } = focusAnim;
    rig.position.lerpVectors(from.p, to.p, e);
    rig.quaternion.copy(from.q).slerp(to.q, e);
    rig.scale.setScalar(from.s + (to.s - from.s) * e);
    scaleLabels();
    if (k >= 1) focusAnim = null;
  }

  /* ---------- XR loop ---------- */
  function onXRFrame(time, frame) {
    if (!frame || !session) return;
    step(frame);
  }

  /* One XR frame. After placement NOTHING here moves the body relative to the viewer:
     the viewer pose is only cached for the next "Tap to place"/"Move". The body's
     transform changes only from (a) placeInFront() on a button tap (Place/Move/Fit),
     (b) setSize() scale, (c) its world anchor, which ARCore keeps fixed to the real room,
     or (d) the eased tap-to-focus offset on `rig`, whose target is computed once at tap time. */
  function step(frame) {
    // 1) Viewer pose (used only for the next placement). Null = tracking hiccup: keep going.
    try {
      const pose = frame.getViewerPose(refSpace);
      if (DEBUG) dbg.pose = pose;
      if (pose && pose.views && pose.views[0] && pose.views[0].projectionMatrix) {
        const m5 = pose.views[0].projectionMatrix[5];
        if (m5 > 0.2) camVFov = 2 * Math.atan(1 / m5);    // real camera vertical FOV
      }
      // Only a TRACKING pose is trusted for placement/focus. LIMITED (emulatedPosition)
      // has a made-up position, and LOST has none: both count as "no pose" here.
      trackingOK = !!(pose && !pose.emulatedPosition);
      if (trackingOK) {
        const p = pose.transform.position, o = pose.transform.orientation;
        setViewerPose(p, o);
      } else {
        hasPose = false;
      }
    } catch (e) {
      hasPose = false;
      trackingOK = false;
    }

    // 2) Taps that arrived without a good pose are retried here once tracking is OK.
    if (pendingPlace && hasPose) doPlace(pendingMode);
    if (pendingFocus >= 0 && hasPose) { const i = pendingFocus; pendingFocus = -1; focusOn(i); }

    // 3) World anchor: create it (needs an active frame), then follow ITS world pose.
    updateAnchor(frame);
    smoothAnchorStep(performance.now());

    // 4) Hit-test: cosmetic reticle only. Never gates placement; errors are swallowed.
    updateReticle(frame);

    // 5) Animate + render.
    try {
      stepFocus(performance.now());
      const t = (performance.now() - t0) / 1000;
      const rk = rig ? rig.scale.x : 1;   // when focused (scaled up), drop the table-size boost
      const boost = { core: Math.max(1, MARKER_BOOST[size].core / rk), halo: Math.max(1, MARKER_BOOST[size].halo / rk) };
      I.markers.forEach((m) => {
        const k = m.sel ? 1.8 : 1.25;
        const s = Math.sin(t * 3.2 + m.phase);
        m.halo.scale.setScalar(0.13 * k * boost.halo * (1 + s * 0.3));
        m.core.scale.setScalar(k * boost.core * (1 + s * 0.12));
        const rp = (t * 0.7 + m.phase) % 1;
        m.ripple.scale.setScalar(0.07 * k + rp * 0.28 * k);
        m.ripple.material.opacity = (1 - rp) * (m.sel ? 0.8 : 0.55);
      });
      I.renderer.render(I.scene, I.camera);
    } catch (e) {
      fail(e);
    }
    if (DEBUG) debugFrame(frame);
  }

  /* ---------- ?ardebug=1 live diagnostics (reads state only; changes nothing) ---------- */
  const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
  const f3 = (x, y, z) => `${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)}`;

  function trackingState(pose) {
    if (!pose) return "NOT TRACKING (no viewer pose)";
    if (pose.emulatedPosition) return "LIMITED (orientation only)";
    return "TRACKING";
  }

  function debugFrame(frame) {
    try {
      const now = performance.now();
      dbg.frames++;
      dbg.fpsN++;
      if (now - dbg.fpsT >= 1000) { dbg.fps = dbg.fpsN * 1000 / (now - dbg.fpsT || 1); dbg.fpsN = 0; dbg.fpsT = now; }
      if (!dbg.pose) dbg.lostFrames++;

      const lines = [];
      lines.push(`frame ${dbg.frames}  ${dbg.fps.toFixed(0)} fps   size=${size}  placed=${placed}${pendingPlace ? " (pending)" : ""}`);
      lines.push(`tracking: ${trackingState(dbg.pose)}   lost frames: ${dbg.lostFrames}`);
      if (dbg.pose) { const p = dbg.pose.transform.position; lines.push(`viewer: ${f3(p.x, p.y, p.z)}`); }

      if (arRoot && I) {
        // The scale actually applied to the mesh = world scale of the body (arRoot × body).
        I.body.updateMatrixWorld(true);
        I.body.matrixWorld.decompose(_v, _q, _s);
        lines.push(`scale: arRoot=${arRoot.scale.x.toFixed(4)}  mesh(world)=${_s.x.toFixed(4)}  → ${(_s.x * modelH).toFixed(3)} m tall (modelH ${modelH.toFixed(3)})`);
        lines.push(`body world pos: ${f3(_v.x, _v.y, _v.z)}   visible=${arRoot.visible}`);
        const vd = dbg.pose ? Math.hypot(arRoot.position.x - viewerPos.x, arRoot.position.z - viewerPos.z) : 0;
        lines.push(`placed dist: ${vd.toFixed(2)} m   cam vFOV: ${THREE.MathUtils.radToDeg(camVFov).toFixed(1)}°   focus: ${focusedIdx >= 0 ? "#" + (focusedIdx + 1) : "none"}${focusAnim ? " (easing)" : ""} rig×${rig ? rig.scale.x.toFixed(3) : "-"}`);
        // Frame-to-frame change of the body's world transform (should be ~0 when untouched).
        if (dbg.lastPos) {
          dbg.delta = _v.distanceTo(dbg.lastPos);
          dbg.rotDelta = THREE.MathUtils.radToDeg(_q.angleTo(dbg.lastQuat));
        } else { dbg.lastPos = new THREE.Vector3(); dbg.lastQuat = new THREE.Quaternion(); }
        dbg.lastPos.copy(_v); dbg.lastQuat.copy(_q);
        dbg.deltas.push({ t: now, d: dbg.delta });
        while (dbg.deltas.length && now - dbg.deltas[0].t > 1000) dbg.deltas.shift();
        dbg.maxDelta1s = dbg.deltas.reduce((m, x) => Math.max(m, x.d), 0);
        lines.push(`Δ per frame: ${(dbg.delta * 1000).toFixed(2)} mm, ${dbg.rotDelta.toFixed(3)}°   max Δ last 1s: ${(dbg.maxDelta1s * 1000).toFixed(2)} mm`);
      } else {
        lines.push(`body: not in AR scene yet`);
      }

      // Anchor: raw pose straight from ARCore (not our copy of it).
      if (anchor) {
        const tracked = !!(frame.trackedAnchors && frame.trackedAnchors.has(anchor));
        let raw = "no pose";
        try { const ap = frame.getPose(anchor.anchorSpace, refSpace); if (ap) { const p = ap.transform.position; raw = f3(p.x, p.y, p.z); } } catch (e) { raw = "getPose error"; }
        lines.push(`anchor: ACTIVE  tracked=${tracked}  raw pose: ${raw}`);
      } else {
        lines.push(`anchor: none  (enabled=${ANCHORS_ON}, wanted=${anchorWanted}, created=${dbg.anchorMade}, api=${typeof frame.createAnchor === "function"})`);
      }
      if (dbg.anchorErr) lines.push(`anchor error: ${dbg.anchorErr}`);
      if (anchorLog.length) lines.push(`anchor guard: ${anchorRejects} rejects in a row; last: ${anchorLog[anchorLog.length - 1]}`);
      const feats = session && session.enabledFeatures ? Array.from(session.enabledFeatures).join(",") : "n/a";
      lines.push(`hit-test: ${hitSource ? "on" : "off"}  hits=${dbg.hits}   features: ${feats}`);

      const text = lines.join("\n");
      dbg.lastText = text;
      // Twice a second, keep a compact history line for "Copy debug log" (last 30 s).
      if (now - dbg.lastSampleT >= 500) {
        dbg.lastSampleT = now;
        const pos = arRoot && I ? f3(_v.x, _v.y, _v.z) : "-";
        dbg.history.push(`${((now - t0) / 1000).toFixed(1)}s trk=${dbg.pose ? (dbg.pose.emulatedPosition ? "LIM" : "OK") : "LOST"} pos=${pos} sc=${arRoot ? arRoot.scale.x.toFixed(4) : "-"} dMax1s=${(dbg.maxDelta1s * 1000).toFixed(1)}mm anc=${anchor ? "Y" : "N"}`);
        if (dbg.history.length > 60) dbg.history.shift();
      }
      const el = $("ar-debug-text");
      if (el) el.textContent = text;
    } catch (e) {
      const el = $("ar-debug-text");
      if (el) el.textContent = "debug error: " + e.message;
    }
  }

  async function copyDebug() {
    const text = `${dbg.lastText}\n--- last 30 s (2/s) ---\n${dbg.history.join("\n")}\n--- anchor guard ---\n${anchorLog.join("\n") || "(no rejections)"}\nUA: ${navigator.userAgent}`;
    try { await navigator.clipboard.writeText(text); toast("Debug log copied"); }
    catch (e) { toast("Copy failed — take a screenshot instead"); }
  }

  function resetDebug() {
    Object.assign(dbg, { pose: null, hits: 0, anchorErr: "", anchorMade: 0, frames: 0, lostFrames: 0,
      lastPos: null, lastQuat: null, delta: 0, rotDelta: 0, maxDelta1s: 0, deltas: [],
      fpsN: 0, fpsT: performance.now(), fps: 0, lastSampleT: 0, history: [], lastText: "" });
  }

  function setViewerPose(p, o) {
    viewerPos.set(p.x, p.y, p.z);
    viewerQuat.set(o.x, o.y, o.z, o.w);
    hasPose = true;
  }

  function updateAnchor(frame) {
    if (!placed || !arRoot) return;
    try {
      if (anchorWanted && frame.createAnchor && refSpace && window.XRRigidTransform) {
        anchorWanted = false;
        const p = arRoot.position, q = arRoot.quaternion;
        const made = frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), refSpace);
        if (made && made.then) {
          made.then((a) => { if (DEBUG) dbg.anchorMade++; if (placed && arRoot) anchor = a; else { try { a.delete(); } catch (e) {} } })
              .catch((e) => { anchor = null; if (DEBUG) dbg.anchorErr = String((e && e.message) || e); });   // unsupported: keep the fixed transform
        }
      }
      // Follow the anchor only on TRACKING frames, and only by plausible amounts.
      if (anchor && trackingOK && frame.trackedAnchors && frame.trackedAnchors.has(anchor)) {
        const ap = frame.getPose(anchor.anchorSpace, refSpace);
        if (ap) {
          const p = ap.transform.position, o = ap.transform.orientation;
          const np = new THREE.Vector3(p.x, p.y, p.z), nq = new THREE.Quaternion(o.x, o.y, o.z, o.w);
          if (haveGoodAnchor) {
            const jump = np.distanceTo(goodAnchorPos), turn = nq.angleTo(goodAnchorQuat);
            if (jump > MAX_ANCHOR_JUMP_M || turn > MAX_ANCHOR_TURN) {
              rejectAnchorPose(np, jump, turn);
              return;                                   // keep the last good position
            }
          }
          // Accepted: this becomes the TARGET. smoothAnchorStep() eases the body to it
          // (ARCore's legit 10–30 cm corrections would otherwise pop in one frame).
          goodAnchorPos.copy(np); goodAnchorQuat.copy(nq); haveGoodAnchor = true;
          anchorRejects = 0;
        }
      }
    } catch (e) {
      // Anchors are optional; on any error keep the fixed placement.
      anchorWanted = false;
    }
  }

  /* Critically damped smoothing of the body toward the last ACCEPTED anchor pose.
     Position: critically damped spring (no overshoot, starts with zero velocity),
     95% settled in ~ANCHOR_SETTLE_S. Rotation: exponential slerp with the same settle time.
     Placement (Place/Move/Fit) sets target = current, so it stays instant. */
  const ANCHOR_SETTLE_S = 0.2;
  const ANCHOR_OMEGA = 4.74 / ANCHOR_SETTLE_S;      // (1+ωt)e^(-ωt) = 5% at t = settle
  const smoothVel = new THREE.Vector3();
  let lastSmoothT = 0;

  function smoothAnchorStep(now) {
    if (!placed || !arRoot || !haveGoodAnchor) { lastSmoothT = now; return; }
    const dt = Math.min(0.1, Math.max(0, (now - (lastSmoothT || now)) / 1000));
    lastSmoothT = now;
    const pos = arRoot.position, tgt = goodAnchorPos;
    if (pos.distanceToSquared(tgt) < 1e-12 && smoothVel.lengthSq() < 1e-12) {
      pos.copy(tgt); smoothVel.set(0, 0, 0);            // settled: exactly on target, no creep
    } else if (dt > 0) {
      // Game Programming Gems 4 / Unity SmoothDamp form of a critically damped spring.
      const x = ANCHOR_OMEGA * dt;
      const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      for (const k of ["x", "y", "z"]) {
        const change = pos[k] - tgt[k];
        const temp = (smoothVel[k] + ANCHOR_OMEGA * change) * dt;
        smoothVel[k] = (smoothVel[k] - ANCHOR_OMEGA * temp) * e;
        let out = tgt[k] + (change + temp) * e;
        if ((tgt[k] - pos[k] > 0) === (out > tgt[k])) { out = tgt[k]; smoothVel[k] = 0; }   // no overshoot
        pos[k] = out;
      }
    }
    const q = arRoot.quaternion;
    if (q.angleTo(goodAnchorQuat) < 1e-6) q.copy(goodAnchorQuat);
    else if (dt > 0) q.slerp(goodAnchorQuat, 1 - Math.exp(-3 * dt / ANCHOR_SETTLE_S));
  }

  function rejectAnchorPose(np, jump, turn) {
    anchorRejects++;
    const fmt = (v) => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
    const msg = `[ANCHOR] rejected implausible jump: ${fmt(goodAnchorPos)} -> ${fmt(np)} (${jump.toFixed(2)} m, ${THREE.MathUtils.radToDeg(turn).toFixed(0)}°)`;
    // Log the first few and then every 10th, so a stuck anchor doesn't flood the console.
    if (anchorRejects <= 3 || anchorRejects % 10 === 0) console.warn(msg + (anchorRejects > 1 ? ` x${anchorRejects}` : ""));
    anchorLog.push(`${((performance.now() - t0) / 1000).toFixed(1)}s ${msg}`);
    if (anchorLog.length > 20) anchorLog.shift();
    if (anchorRejects === 1) {
      const h = $("ar-hint");
      if (h) { h.hidden = false; h.textContent = "Tracking hiccup — tap ↻ Move if the body looks off"; }
    }
    if (anchorRejects >= ANCHOR_DETACH_AFTER) {
      // The anchor keeps reporting nonsense: stop following it and keep the fixed placement.
      console.warn(`[ANCHOR] detached after ${anchorRejects} implausible poses; keeping last good position ${fmt(goodAnchorPos)}`);
      anchorLog.push(`[ANCHOR] detached after ${anchorRejects} rejects`);
      try { anchor && anchor.delete(); } catch (e) {}
      anchor = null;
      anchorRejects = 0;
    }
  }

  function dropAnchor() {
    try { anchor && anchor.delete(); } catch (e) {}
    anchor = null;
    anchorWanted = false;
  }

  function updateReticle(frame) {
    if (!reticle) return;
    try {
      if (placed || !hitSource) { reticle.visible = false; return; }
      const hits = frame.getHitTestResults(hitSource);
      if (DEBUG) dbg.hits = hits.length;
      const hp = hits.length ? hits[0].getPose(refSpace) : null;
      if (hp) { reticle.matrix.fromArray(hp.transform.matrix); reticle.visible = true; }
      else reticle.visible = false;
    } catch (e) {
      // Hit-test is optional: disable it quietly and carry on.
      reticle.visible = false;
      try { hitSource && hitSource.cancel(); } catch (x) {}
      hitSource = null;
    }
  }

  // Screen taps only pick markers after placement. They never place the body.
  function onSelect(ev) {
    try {
      if (!placed) return;
      const pose = ev.frame && ev.frame.getPose(ev.inputSource.targetRaySpace, refSpace);
      if (!pose) return;
      const o = pose.transform.position, q = pose.transform.orientation;
      const origin = new THREE.Vector3(o.x, o.y, o.z);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).normalize();
      // Ray pick: the marker closest (by angle) to the tap ray. Markers are
      // millimetres wide at table size, so a small cone is friendlier than exact hits.
      let best = null, bestA = PICK_ANGLE;
      const wp = new THREE.Vector3();
      I.markers.forEach((m) => {
        m.group.getWorldPosition(wp);
        const a = wp.sub(origin).normalize().angleTo(dir);
        if (a < bestA) { bestA = a; best = m; }
      });
      if (best) select(best.index);
    } catch (e) {
      console.warn("AR select failed", e);
    }
  }

  /* ---------- placement (never depends on hit-test) ---------- */
  // Called by the "Tap to place body" and "Move" buttons.
  function requestPlace(mode = "place") {
    const now = performance.now();
    if (now - lastPlaceTap < PLACE_DEBOUNCE_MS) return false;   // shaky double-tap
    lastPlaceTap = now;
    if (!arRoot) return false;
    const f = $("ar-fit"); if (f) f.classList.remove("pulse");
    pendingMode = mode;
    if (hasPose) return doPlace(mode);
    // No pose right now (tracking hiccup / first frame): the XR loop retries every frame.
    pendingPlace = true;
    updateHint();
    return false;
  }

  // 1.2 m in front of the viewer along their horizontal heading, 0.9 m below eye level,
  // turned to face the viewer. Uses yaw only, so it works even when the phone points
  // straight down at a table (where a flattened forward vector would be ~zero).
  function doPlace(mode) {
    if (mode === "fit") {
      // Whole body in view: distance from the real camera FOV (25% margin), body centred
      // slightly below eye level. Scale (Table/Life) is kept.
      const H = modelH * SCALE[size];
      const dist = Math.max(0.5, (H * 1.25) / (2 * Math.tan(camVFov / 2)));
      return placeInFront(dist, H * 0.55);
    }
    return placeInFront(PLACE_DIST[size], PLACE_DROP);
  }

  function placeInFront(dist = PLACE_DIST[size], drop = PLACE_DROP) {
    clearFocus(true);
    const yaw = new THREE.Euler().setFromQuaternion(viewerQuat, "YXZ").y;
    const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
    const pos = new THREE.Vector3(
      viewerPos.x + fwdX * dist,
      viewerPos.y - drop,
      viewerPos.z + fwdZ * dist
    );
    arRoot.position.copy(pos);
    arRoot.rotation.set(0, Math.atan2(viewerPos.x - pos.x, viewerPos.z - pos.z), 0);
    arRoot.scale.setScalar(SCALE[size]);
    arRoot.visible = true;
    // Baseline for the anchor sanity guard: the anchor is created at exactly this pose.
    goodAnchorPos.copy(arRoot.position); goodAnchorQuat.copy(arRoot.quaternion);
    haveGoodAnchor = true; anchorRejects = 0;
    smoothVel.set(0, 0, 0);          // placement is instant: target == current, no easing
    arRoot.updateMatrixWorld(true);
    placed = true;
    pendingPlace = false;
    // Pin this spot to the real world (created on the next XR frame). Move = new anchor.
    dropAnchor();
    anchorWanted = ANCHORS_ON;
    if (reticle) reticle.visible = false;
    updateHint();
    return true;
  }

  // Mesh-only bounds of the body in arRoot space (skips glow/label sprites).
  function meshBounds() {
    const box = new THREE.Box3(), b = new THREE.Box3();
    arRoot.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(arRoot.matrixWorld).invert();
    I.body.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      box.union(b);
    });
    return box;
  }

  // Measure the real model once (unscaled), then: scale = target / measured height, and
  // lift the body so its soles sit exactly on arRoot's origin, the placement/anchor point.
  // Size switches then grow/shrink the figure from its feet with no base jump.
  function fitModel() {
    arRoot.scale.setScalar(1);
    const box = meshBounds();
    const h = box.max.y - box.min.y;
    if (h > 0.5 && h < 3) {
      modelH = h;
      I.body.position.y = -box.min.y;
    }
    SCALE.table = TARGET_H.table / modelH;
    SCALE.life = TARGET_H.life / modelH;
  }

  /* ---------- enter / exit ---------- */
  function enterScene() {
    arRoot = new THREE.Group();
    arRoot.visible = false;
    I.scene.add(arRoot);
    rig = new THREE.Group();
    arRoot.add(rig);
    I.pivot.remove(I.body);
    rig.add(I.body);
    I.body.position.set(0, 0, 0);
    fitModel();
    reticle = buildReticle();
    I.scene.add(reticle);
    setArBlending(true);
    buildLabels();
  }

  function cleanup() {
    if (cleaning) return;
    cleaning = true;
    try {
      if (session) {
        session.removeEventListener("select", onSelect);
        session.removeEventListener("end", cleanup);
      }
      try { hitSource && hitSource.cancel(); } catch (e) {}
      hitSource = null;
      dropAnchor();
      if (I) {
        try { I.renderer.setAnimationLoop(null); } catch (e) {}
        I.renderer.xr.enabled = false;
        if (blendSaved.length) setArBlending(false);
        removeLabels();
        if (I.body.parent && I.body.parent !== I.pivot) I.body.parent.remove(I.body);
        if (arRoot) I.scene.remove(arRoot);
        if (I.body.parent !== I.pivot) I.pivot.add(I.body);
        if (reticle) I.scene.remove(reticle);
        Body3D.highlight(null);
        I.resize();
        I.applyCamera();
        I.startLoop();
      }
    } catch (e) {
      console.error("AR cleanup error", e);
    } finally {
      stopAnyAudio();
      const ov = $("ar-overlay");
      ov.hidden = true;
      ov.innerHTML = "";
      document.documentElement.classList.remove("in-ar");
      session = null; arRoot = null; reticle = null; refSpace = null; rig = null; focusAnim = null; focusedIdx = -1;
      resetPlacementState();
      cleaning = false;
      window.BodyUI && BodyUI.afterAR && BodyUI.afterAR();
    }
  }

  function fail(e) {
    console.error("AR error", e);
    if (failed) return;
    failed = true;
    toast("AR is not available on this phone");
    const s = session;
    if (s) { try { s.end().catch(() => cleanup()); } catch (x) { cleanup(); } }
    else cleanup();
  }

  function exit() {
    if (!session) return cleanup();
    try { session.end().catch(() => cleanup()); } catch (e) { cleanup(); }
  }

  function resetPlacementState() {
    placed = false; sel = -1; hasPose = false; pendingPlace = false; lastPlaceTap = -Infinity;
    haveGoodAnchor = false; anchorRejects = 0; anchorLog = []; trackingOK = false; pendingFocus = -1;
  }

  // Hit-test is a cosmetic bonus: requested in the background, any failure is ignored.
  async function startHitTest(s) {
    try {
      if (!s.requestHitTestSource) return;
      const viewer = await s.requestReferenceSpace("viewer");
      const src = await s.requestHitTestSource({ space: viewer });
      if (session === s) hitSource = src; else { try { src.cancel(); } catch (e) {} }
    } catch (e) {
      console.info("Hit-test unavailable; placement still works without it.", e);
      hitSource = null;
    }
  }

  /* Must be called directly from a tap (user activation) — requestSession comes first. */
  async function start({ items: its, report: rep } = {}) {
    if (session) return;
    I = Body3D._internals();
    if (!I || !navigator.xr) { toast("AR is not available on this phone"); return; }
    items = its || []; report = rep || null; size = "table"; failed = false;
    resetPlacementState();
    resetDebug();
    const ov = $("ar-overlay");
    ov.innerHTML = overlayHtml();
    ov.hidden = false;
    let s;
    try {
      s = await navigator.xr.requestSession("immersive-ar", {
        // hit-test is OPTIONAL: phones without it still get AR with button placement.
        optionalFeatures: ANCHORS_ON ? ["hit-test", "dom-overlay", "anchors"] : ["hit-test", "dom-overlay"],
        domOverlay: { root: ov },
      });
    } catch (e) {
      ov.hidden = true; ov.innerHTML = "";
      console.error("requestSession failed", e);
      toast("AR is not available on this phone");
      return;
    }
    session = s;
    try {
      document.documentElement.classList.add("in-ar");
      bindOverlay();
      if (!overlayBound) {
        // Taps on overlay buttons/cards must not also count as an AR tap.
        ov.addEventListener("beforexrselect", (e) => { if (e.target !== ov) e.preventDefault(); });
        overlayBound = true;
      }
      I.stopLoop();
      const r = I.renderer;
      r.xr.enabled = true;
      r.xr.setReferenceSpaceType("local");
      if (r.xr.setFramebufferScaleFactor) r.xr.setFramebufferScaleFactor(0.85); // cap resolution for mid-range phones
      s.addEventListener("end", cleanup);
      await r.xr.setSession(s);
      refSpace = r.xr.getReferenceSpace();
      s.addEventListener("select", onSelect);
      enterScene();
      updateHint();
      r.setAnimationLoop(onXRFrame);
      // No dom-overlay on this phone = no buttons can be shown, so place the body
      // automatically in front of the viewer as soon as a pose arrives.
      if (!s.domOverlayState) pendingPlace = true;
      startHitTest(s); // not awaited: never blocks or gates placement
    } catch (e) {
      fail(e);
    }
  }

  return {
    isSupported, start, exit, get active() { return !!session; },
    // Dev/test only: stage the AR scene + overlay inside the normal 3D canvas (no XR device needed).
    _dev: {
      stage({ items: its = [], report: rep = null, size: sz = "table" } = {}) {
        I = Body3D._internals(); items = its; report = rep; size = sz;
        resetPlacementState();
        resetDebug();
        const ov = $("ar-overlay"); ov.innerHTML = overlayHtml(); ov.hidden = false; bindOverlay();
        enterScene(); updateHint();
      },
      // Simulate what an XR frame delivers: a viewer pose (or null = tracking hiccup),
      // then run the same per-frame retry the real loop runs.
      frame(pose) {
        trackingOK = !!pose;
        if (pose) setViewerPose(pose.position, pose.orientation); else hasPose = false;
        if (pendingPlace && hasPose) doPlace(pendingMode);
      },
      // Run the REAL per-frame step with a fake XRFrame (no device needed).
      step(fakeFrame) { step(fakeFrame); },
      // Height/base of the rendered body in world metres (meshes only: skips glow/label sprites).
      measure() {
        const box = new THREE.Box3(), b = new THREE.Box3();
        I.body.updateMatrixWorld(true);
        I.body.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
          box.union(b);
        });
        return { height: box.max.y - box.min.y, minY: box.min.y, maxY: box.max.y };
      },
      setAnchor(a) { anchor = a; },
      get anchorLog() { return anchorLog.slice(); },
      get anchorActive() { return !!anchor; },
      get state() {
        return { placed, pendingPlace, hasPose, arRoot, rig, focusedIdx, focusAnimating: !!focusAnim, camVFovDeg: THREE.MathUtils.radToDeg(camVFov),
          bodyInArRoot: !!(arRoot && I && rig && I.body.parent === rig && rig.parent === arRoot) };
      },
      select: (i) => select(i),
      unstage: () => cleanup(),
    },
  };
})();
