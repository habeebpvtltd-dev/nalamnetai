/* ar.js — "View in your room": WebXR immersive-ar on top of the SAME three.js
   scene used by the 3D viewer (same body, materials and markers).
   - Session requested by hand (no ARButton): hit-test required, dom-overlay optional.
   - Ring reticle from hit-test, tap to place (faces the user), Table/Life size, Move, Exit.
   - Canvas-sprite labels, tap-to-pick markers from the XR select ray, finding card in the overlay.
   Any failure ends the session and returns to the normal 3D view. */

window.BodyAR = !window.THREE ? null : (() => {
  const $ = (id) => document.getElementById(id);
  const BODY_H = 1.75;                                  // model height in body units
  const SCALE = { table: 0.4 / BODY_H, life: 1.7 / BODY_H };
  const LABEL_W = { table: 0.12, life: 0.32 };          // label width in metres
  const PICK_ANGLE = THREE.MathUtils ? THREE.MathUtils.degToRad(8) : 0.14;

  let session = null, hitSource = null, refSpace = null;
  let I = null;                // Body3D internals
  let arRoot = null, reticle = null;
  let placed = false, size = "table", sel = -1;
  let items = [], report = null;
  let blendSaved = [], labelSprites = [];
  let cleaning = false, failed = false, overlayBound = false;
  const viewerPos = new THREE.Vector3();
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
          if (m.uniforms && m.uniforms.uAR) m.uniforms.uAR.value = 1;
          m.needsUpdate = true;
        });
      });
    } else {
      blendSaved.forEach((m) => {
        m.blending = THREE.AdditiveBlending;
        if (m.uniforms && m.uniforms.uAR) m.uniforms.uAR.value = 0;
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
      <div class="ar-hint" id="ar-hint"></div>
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
    $("ar-move").onclick = () => { placed = false; arRoot.visible = false; hideCard(); updateHint(); };
    const nx = $("ar-next");
    if (nx) nx.onclick = () => select(items.length ? (sel + 1 + items.length) % items.length : -1);
  }

  function updateHint() {
    const h = $("ar-hint");
    if (!h) return;
    $("ar-actions").hidden = !placed;
    if (!placed) { h.hidden = false; h.textContent = reticle && reticle.visible ? "Tap to place the body" : "Point at the floor and tap to place the body"; }
    else if (items.length && sel < 0) { h.hidden = false; h.textContent = "Tap a glowing spot to learn more"; }
    else h.hidden = true;
  }

  function setSize(s) {
    size = s;
    $("ar-overlay").querySelectorAll(".ar-seg button").forEach((b) => b.classList.toggle("active", b.dataset.size === s));
    if (arRoot) arRoot.scale.setScalar(SCALE[s]);
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
    try {
      if (!frame || !session) return;
      const pose = frame.getViewerPose(refSpace);
      if (pose) { const p = pose.transform.position; viewerPos.set(p.x, p.y, p.z); }
      if (!placed && hitSource) {
        const hits = frame.getHitTestResults(hitSource);
        const was = reticle.visible;
        if (hits.length) {
          const hp = hits[0].getPose(refSpace);
          if (hp) { reticle.matrix.fromArray(hp.transform.matrix); reticle.visible = true; }
        } else reticle.visible = false;
        if (was !== reticle.visible) updateHint();
      } else reticle.visible = false;

      // Markers pulse brighter in AR.
      const t = (performance.now() - t0) / 1000;
      I.markers.forEach((m) => {
        const k = m.sel ? 1.8 : 1.25;
        const s = Math.sin(t * 3.2 + m.phase);
        m.halo.scale.setScalar(0.13 * k * (1 + s * 0.3));
        m.core.scale.setScalar(k * (1 + s * 0.12));
        const rp = (t * 0.7 + m.phase) % 1;
        m.ripple.scale.setScalar(0.07 * k + rp * 0.28 * k);
        m.ripple.material.opacity = (1 - rp) * (m.sel ? 0.8 : 0.55);
      });
      I.renderer.render(I.scene, I.camera);
    } catch (e) {
      fail(e);
    }
  }

  function onSelect(ev) {
    try {
      if (!placed) {
        if (!reticle.visible) return;
        place();
        return;
      }
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

  function place() {
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    reticle.matrix.decompose(pos, quat, scl);
    arRoot.position.copy(pos);
    // Face the user: the body's front (+Z) points at the viewer, yaw only.
    arRoot.rotation.set(0, Math.atan2(viewerPos.x - pos.x, viewerPos.z - pos.z), 0);
    arRoot.scale.setScalar(SCALE[size]);
    arRoot.visible = true;
    placed = true;
    reticle.visible = false;
    updateHint();
  }

  /* ---------- enter / exit ---------- */
  function enterScene() {
    arRoot = new THREE.Group();
    arRoot.visible = false;
    I.scene.add(arRoot);
    I.pivot.remove(I.body);
    arRoot.add(I.body);
    I.body.position.set(0, 0, 0);
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
      placed = false; sel = -1;
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

  /* Must be called directly from a tap (user activation) — requestSession comes first. */
  async function start({ items: its, report: rep } = {}) {
    if (session) return;
    I = Body3D._internals();
    if (!I || !navigator.xr) { toast("AR is not available on this phone"); return; }
    items = its || []; report = rep || null; sel = -1; placed = false; size = "table"; failed = false;
    const ov = $("ar-overlay");
    ov.innerHTML = overlayHtml();
    ov.hidden = false;
    let s;
    try {
      s = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["dom-overlay"],
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
      const viewer = await s.requestReferenceSpace("viewer");
      hitSource = await s.requestHitTestSource({ space: viewer });
      s.addEventListener("select", onSelect);
      enterScene();
      updateHint();
      r.setAnimationLoop(onXRFrame);
    } catch (e) {
      fail(e);
    }
  }

  return {
    isSupported, start, exit, get active() { return !!session; },
    // Dev/test only: stage the AR scene + overlay inside the normal 3D canvas (no XR device needed).
    _dev: {
      stage({ items: its = [], report: rep = null, size: sz = "life" } = {}) {
        I = Body3D._internals(); items = its; report = rep; size = sz; sel = -1;
        const ov = $("ar-overlay"); ov.innerHTML = overlayHtml(); ov.hidden = false; bindOverlay();
        enterScene(); placed = true; arRoot.visible = true; arRoot.scale.setScalar(SCALE[size]); scaleLabels(); updateHint();
      },
      select: (i) => select(i),
      unstage: () => cleanup(),
    },
  };
})();
