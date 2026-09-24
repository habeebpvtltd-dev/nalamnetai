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
  // ?anchors=0 turns them off (fixed transform in 'local' space) as a venue safety valve.
  const ANCHORS_ON = !/[?&]anchors=0\b/.test(window.location.search);
  const PICK_ANGLE = THREE.MathUtils ? THREE.MathUtils.degToRad(8) : 0.14;

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
  const PLACE_DEBOUNCE_MS = 400;
  const PLACE_DIST = 1.2, PLACE_DROP = 0.9;   // metres in front / below the viewer's eyes
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
    const w = LABEL_W[size] / SCALE[size];  // sprites live inside the scaled body
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
      ${ window.location.search.includes('ardebug=1') ? '<div id="ar-debug" style="position:absolute;top:100px;left:20px;color:lime;font-size:18px;font-weight:bold;z-index:9999;text-shadow: 1px 1px 2px black;">hits: 0</div>' : '' }
      <div class="ar-bottom">
        <div class="ar-card" id="ar-card" hidden></div>
        <div class="ar-actions" id="ar-actions" hidden>
          <button class="ar-btn" id="ar-move">↻ Move</button>
          ${items.length ? `<button class="ar-btn primary" id="ar-next">Next finding ›</button>` : ""}
        </div>
      </div>`;
  }

  function bindOverlay() {
    $("ar-exit").onclick = exit;
    $("ar-overlay").querySelectorAll(".ar-seg button").forEach((b) => (b.onclick = () => setSize(b.dataset.size)));
    // Placement is driven ONLY by these real DOM buttons (never by hit-test or screen taps).
    $("ar-place-btn").onclick = requestPlace;
    $("ar-move").onclick = () => { hideCard(); requestPlace(); };
    const nx = $("ar-next");
    if (nx) nx.onclick = () => select(items.length ? (sel + 1 + items.length) % items.length : -1);
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
    if (arRoot) { arRoot.scale.setScalar(SCALE[s]); arRoot.updateMatrixWorld(true); }
    scaleLabels();
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
  }

  /* ---------- XR loop ---------- */
  function onXRFrame(time, frame) {
    if (!frame || !session) return;
    step(frame);
  }

  /* One XR frame. After placement NOTHING here moves the body relative to the viewer:
     the viewer pose is only cached for the next "Tap to place"/"Move". The body's
     transform changes only from (a) placeInFront() on a button tap, (b) setSize()
     scale, or (c) its world anchor, which ARCore keeps fixed to the real room. */
  function step(frame) {
    // 1) Viewer pose (used only for the next placement). Null = tracking hiccup: keep going.
    try {
      const pose = frame.getViewerPose(refSpace);
      if (pose) {
        const p = pose.transform.position, o = pose.transform.orientation;
        setViewerPose(p, o);
      } else {
        hasPose = false;
      }
    } catch (e) {
      hasPose = false;
    }

    // 2) A tap that arrived without a pose is retried here, every frame, until one arrives.
    if (pendingPlace && hasPose) placeInFront();

    // 3) World anchor: create it (needs an active frame), then follow ITS world pose.
    updateAnchor(frame);

    // 4) Hit-test: cosmetic reticle only. Never gates placement; errors are swallowed.
    updateReticle(frame);

    // 5) Animate + render.
    try {
      const t = (performance.now() - t0) / 1000;
      const boost = MARKER_BOOST[size];
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
          made.then((a) => { if (placed && arRoot) anchor = a; else { try { a.delete(); } catch (e) {} } })
              .catch(() => { anchor = null; });   // unsupported: keep the fixed transform
        }
      }
      if (anchor && frame.trackedAnchors && frame.trackedAnchors.has(anchor)) {
        const ap = frame.getPose(anchor.anchorSpace, refSpace);
        if (ap) {
          const p = ap.transform.position, o = ap.transform.orientation;
          arRoot.position.set(p.x, p.y, p.z);
          arRoot.quaternion.set(o.x, o.y, o.z, o.w);   // scale is untouched (Table/Life)
        }
      }
    } catch (e) {
      // Anchors are optional; on any error keep the fixed placement.
      anchorWanted = false;
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
      const dbg = $("ar-debug");
      if (dbg) dbg.textContent = `hits: ${hits.length}`;
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
  function requestPlace() {
    const now = performance.now();
    if (now - lastPlaceTap < PLACE_DEBOUNCE_MS) return false;   // shaky double-tap
    lastPlaceTap = now;
    if (!arRoot) return false;
    if (hasPose) return placeInFront();
    // No pose right now (tracking hiccup / first frame): the XR loop retries every frame.
    pendingPlace = true;
    updateHint();
    return false;
  }

  // 1.2 m in front of the viewer along their horizontal heading, 0.9 m below eye level,
  // turned to face the viewer. Uses yaw only, so it works even when the phone points
  // straight down at a table (where a flattened forward vector would be ~zero).
  function placeInFront() {
    const yaw = new THREE.Euler().setFromQuaternion(viewerQuat, "YXZ").y;
    const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
    const pos = new THREE.Vector3(
      viewerPos.x + fwdX * PLACE_DIST,
      viewerPos.y - PLACE_DROP,
      viewerPos.z + fwdZ * PLACE_DIST
    );
    arRoot.position.copy(pos);
    arRoot.rotation.set(0, Math.atan2(viewerPos.x - pos.x, viewerPos.z - pos.z), 0);
    arRoot.scale.setScalar(SCALE[size]);
    arRoot.visible = true;
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
    I.pivot.remove(I.body);
    arRoot.add(I.body);
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
        if (arRoot) { arRoot.remove(I.body); I.scene.remove(arRoot); }
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
      session = null; arRoot = null; reticle = null; refSpace = null;
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
        const ov = $("ar-overlay"); ov.innerHTML = overlayHtml(); ov.hidden = false; bindOverlay();
        enterScene(); updateHint();
      },
      // Simulate what an XR frame delivers: a viewer pose (or null = tracking hiccup),
      // then run the same per-frame retry the real loop runs.
      frame(pose) {
        if (pose) setViewerPose(pose.position, pose.orientation); else hasPose = false;
        if (pendingPlace && hasPose) placeInFront();
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
      get state() {
        return { placed, pendingPlace, hasPose, arRoot, bodyInArRoot: !!(arRoot && I && I.body.parent === arRoot) };
      },
      select: (i) => select(i),
      unstage: () => cleanup(),
    },
  };
})();
