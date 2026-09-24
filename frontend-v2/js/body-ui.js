/* body-ui.js — Body tab: loads the radiology report, drives Body3D, renders
   the finding bottom sheet, banners, demo menu. */

window.BodyUI = (() => {
  const $ = (id) => document.getElementById(id);
  let report = null;          // viewer JSON currently shown
  let items = [];             // flattened findings
  let sel = -1;
  let lang = "en";
  let glOk = true;
  let pendingIntro = false;
  let prefetchState = "idle"; // idle | loading | done | empty | error
  let prefetchErr = null;
  let visible = false;
  let sheetState = "collapsed";   // collapsed | half | full
  let focusMode = "overview";     // overview | finding (what the camera is framing)
  let hintTimer = null, lastFront = null;
  let applied = null;       // report object last pushed to the 3D view
  const SEV_RANK = { severe: 0, moderate: 1, mild: 2, unknown: 3 };
  const SEV_WORD = { severe: "Severe", moderate: "Moderate", mild: "Mild", unknown: "Not stated" };

  /* ---------- data ---------- */
  function flatten(r) {
    const out = [];
    (r.zones || []).forEach((z) => {
      (z.findings || []).forEach((f) => {
        const zoneId = ZONES[z.zone_id] ? z.zone_id : (ZONES[f.body_zone] ? f.body_zone : null);
        const side = resolveSide(f, zoneId || "");
        const detail = parseDetail(f, zoneId);
        const zone_en = zoneId ? z.zone_en : "Location not stated";
        out.push({
          f, zone_id: zoneId, zone_en, zone_ta: zoneId ? z.zone_ta : "",
          side, detail,
          severity: SEV_WORD[f.severity_level] ? f.severity_level : "unknown",
          placement: zoneId ? findingPlacement(zoneId, side, detail) : null,
          location: plainLocation(zoneId, zone_en, side, detail),
          short: shortDetail(detail),
        });
      });
    });
    out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    const perZone = {};
    out.forEach((x) => { if (x.zone_id) perZone[x.zone_id] = (perZone[x.zone_id] || 0) + 1; });
    out.forEach((x) => (x.zoneCount = x.zone_id ? perZone[x.zone_id] : 1));
    return out;
  }

  async function prefetch() {
    if (prefetchState === "loading") return;
    prefetchState = "loading";
    try {
      const r = await api("/radiology/latest", { timeout: 75000, onSlow: () => Server.checking("Waking server…") });
      prefetchState = "done";
      if (!report) { report = r; if (visible) applyReport(true); }
    } catch (e) {
      if (e.status === 404) { prefetchState = "empty"; Server.mark(true); }
      else { prefetchState = "error"; prefetchErr = e; }
      if (visible && !report) renderEmpty();
    }
  }

  /* ---------- engine ---------- */
  function ensureEngine() {
    if (Body3D.ready || !glOk) return;
    try {
      Body3D.init($("body-canvas-host"), $("body-labels"), { onSelect: (i) => select(i, { user: true }), onView: onView });
    } catch (e) {
      console.error("3D init failed", e);
      glOk = false;
      $("body-canvas-host").innerHTML = `<div class="nogl">3D view is not available on this device, but your findings are listed below.</div>`;
    }
  }

  function onView(c) {
    const front = Math.cos(c.yaw) >= 0;
    $("btn-front").classList.toggle("active", front);
    $("btn-back").classList.toggle("active", !front);
    if (front !== lastFront) { lastFront = front; showHint(front); }
    if (FLAGS.debug) $("debug-panel").textContent =
      `yaw ${(c.yaw * 57.3 % 360).toFixed(0)}° pitch ${c.pitch.toFixed(2)} dist ${c.dist.toFixed(2)}\nfocus ${c.fx.toFixed(3)}, ${c.fy.toFixed(3)}, ${c.fz.toFixed(3)}`;
  }

  // Orientation hint: full sentence for 3 s, then shrinks to a small chip.
  function showHint(front) {
    const el = $("orient-hint");
    el.className = "orient-hint full";
    el.innerHTML = front
      ? "<b>Front view</b> · Patient's left is on your right"
      : "<b>Back view</b> · Patient's left is on your left";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      el.className = "orient-hint chip";
      el.innerHTML = front ? "<b>Front view</b>" : "<b>Back view</b>";
      if (window.gsap) gsap.fromTo(el, { opacity: 0.4 }, { opacity: 1, duration: 0.35 });
    }, 3000);
  }

  function updateInsets() {
    if (!Body3D.ready) return;
    const wrap = $("body-wrap").getBoundingClientRect();
    const top = $("body-top").getBoundingClientRect();
    const sheet = $("body-sheet").getBoundingClientRect();
    const row = Math.max(0, top.bottom - wrap.top) + 6;   // view row (hint chip + Front/Back)
    $("body-wrap").style.setProperty("--top-row", row + "px");
    const t = row + 60;                                    // body is framed below the view row
    const b = sheet.height ? Math.max(0, wrap.bottom - sheet.top) + 8 : 0;
    Body3D.setInsets(t, b);
  }

  /* ---------- report ---------- */
  function applyReport(intro) {
    applied = report;
    $("body-loading").hidden = true;
    items = flatten(report);
    sel = -1;
    lang = "en";
    renderHeader();
    renderBanner();
    if (Body3D.ready) {
      Body3D.setFindings(items);
      Body3D.setNormal(!!report.overall_normal && !items.length);
      Body3D.highlight(null);
    }
    focusMode = "overview";
    setSheet("collapsed", { reframe: false });
    renderSheet();
    requestAnimationFrame(updateInsets);
    if (intro) runIntro();
  }

  function runIntro() {
    if (!Body3D.ready) { if (items.length) select(0, { fly: false }); return; }
    if (!visible) { pendingIntro = true; return; }
    pendingIntro = false;
    setTimeout(() => {
      updateInsets();
      Body3D.introSpin(() => {
        // First load: sheet collapsed, whole body in view, first finding highlighted.
        if (items.length) select(0, { fly: false });
        focusMode = "overview";
        Body3D.resetView({ duration: 1.2 });
      });
    }, 350);
  }

  function renderHeader() {
    const r = report || {};
    $("study-title").textContent = r.study_name || "Your scan report";
    const bits = [];
    if (r.modality && r.modality !== "other") bits.push({ xray: "X-ray", mri: "MRI", ct: "CT scan", ultrasound: "Ultrasound" }[r.modality] || r.modality.toUpperCase());
    if (r.study_date) bits.push(r.study_date);
    if (items.length) bits.push(`${items.length} finding${items.length > 1 ? "s" : ""}`);
    $("study-meta").textContent = bits.join(" · ") || "Scan report";
  }

  function renderBanner() {
    const el = $("body-banner");
    const r = report || {};
    if (r.is_critical) {
      const contact = (store.get("contact") || "").replace(/[^\d+]/g, "");
      el.innerHTML = `
        <div class="body-banner banner-critical">
          <div class="row">
            <div style="flex:1">Your report mentions a finding the doctor may need to see soon. <strong>Please contact your doctor today.</strong></div>
            ${contact
              ? `<a class="btn btn-danger" href="tel:${escHtml(contact)}" aria-label="Call emergency contact">📞 Call</a>`
              : `<button class="btn btn-danger" id="banner-setup">📞 Add contact</button>`}
          </div>
        </div>`;
      const b = $("banner-setup");
      if (b) b.onclick = () => { toast("Add an emergency contact so you can call in one tap."); App.go("emergency", { setup: true }); };
      animateIn(el.firstElementChild, { y: -10 });
    } else if (r.overall_normal && !items.length) {
      el.innerHTML = `<div class="body-banner banner-ok">✅ Your report does not mention any problem areas.</div>`;
      animateIn(el.firstElementChild, { y: -10 });
    } else {
      el.innerHTML = "";
    }
  }

  /* ---------- sheet ---------- */
  const ICON_PREV = `<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_NEXT = `<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const ICON_PIN = `<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9.5" r="2.5" fill="currentColor"/></svg>`;
  const DISCLAIMER = `<div class="disclaimer">ℹ️ This explains your report in simple words. Please discuss it with your doctor.</div>`;

  const ICON_CHEV = `<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function headHtml(countText, rowB) {
    return `
      <div class="sheet-row-a">
        <div class="count">${countText}</div>
        <button class="sheet-grab" id="sheet-grab" aria-label="Show or hide details"><span></span></button>
        <button class="sheet-chev" id="sheet-chev" aria-label="${sheetState === "collapsed" ? "Show details" : "Hide details"}">${ICON_CHEV}</button>
      </div>
      <div class="sheet-row-b">${rowB}</div>`;
  }

  function bindHead() {
    const toggle = () => { if (!consumeSwipe()) setSheet(sheetState === "collapsed" ? "half" : "collapsed"); };
    $("sheet-grab").onclick = toggle;
    $("sheet-chev").onclick = toggle;
    const p = $("f-prev"), n = $("f-next");
    if (p) p.onclick = () => { if (!consumeSwipe()) step(-1); };
    if (n) n.onclick = () => { if (!consumeSwipe()) step(1); };
  }

  function renderSheet() {
    const head = $("sheet-head"), b = $("sheet-body");
    const r = report || {};
    if (!items.length) {
      const allF = (r.all_findings || []).filter((f) => f.explanation_en);
      const peek = r.overall_normal ? "✅ No problem areas mentioned" : "No specific body area in this report";
      head.innerHTML = headHtml(escHtml(r.study_name || "Scan report"), `<div class="peek-text">${peek}</div>`);
      const msg = r.overall_normal
        ? `<div class="notice notice-ok"><span class="n-ico">✅</span><span>Your report does not mention any problem areas.</span></div>`
        : `<div class="notice notice-info"><span class="n-ico">ℹ️</span><span>This report does not point to a specific body area.</span></div>`;
      b.innerHTML = `
        ${msg}
        ${r.impression ? `<div class="section-label">Report summary</div><div class="quote">${escHtml(r.impression)}</div>` : ""}
        ${allF.length ? `<div class="section-label">What the report says</div>` + allF.slice(0, 6).map((f) => `<div class="finding-row">${escHtml(f.explanation_en)}</div>`).join("") : ""}
        ${DISCLAIMER}`;
      bindHead();
      return;
    }
    const i = sel < 0 ? 0 : sel;
    const it = items[i];
    const f = it.f;
    const hasTa = !!(f.explanation_ta && f.explanation_ta.trim());
    const exp = lang === "ta" && hasTa ? f.explanation_ta : f.explanation_en || "The report mentions this area.";
    const one = items.length < 2 ? "disabled" : "";
    head.innerHTML = headHtml(
      `Finding ${i + 1} of ${items.length}`,
      `<button class="nav-btn" id="f-prev" aria-label="Previous finding" ${one}>${ICON_PREV}</button>
       <div class="peek-text">${escHtml(it.zone_en)}<span class="chip sev sev-${it.severity}">${SEV_WORD[it.severity]}</span></div>
       <button class="nav-btn primary" id="f-next" aria-label="Next finding" ${one}>Next ${ICON_NEXT}</button>`);
    b.innerHTML = `
      <div class="f-title">${escHtml(it.zone_en)}</div>
      ${it.zone_ta ? `<div class="f-title-ta" lang="ta">${escHtml(it.zone_ta)}</div>` : ""}
      <div class="f-chips">
        <span class="chip chip-side">${escHtml(sideLabel(it.side))}</span>
        <span class="chip sev sev-${it.severity}">${SEV_WORD[it.severity]}</span>
      </div>
      <div class="f-loc">${ICON_PIN}<span>${escHtml(it.location)}</span></div>
      <div class="lang-seg" role="group" aria-label="Language">
        <button data-lang="en" class="${lang === "en" ? "active" : ""}">English</button>
        <button data-lang="ta" class="ta ${lang === "ta" ? "active" : ""}">தமிழ்</button>
      </div>
      <div class="f-exp ${lang === "ta" && hasTa ? "ta" : ""}" ${lang === "ta" && hasTa ? 'lang="ta"' : ""} id="f-exp">${escHtml(exp)}</div>
      <div class="f-actions">
        <button class="btn btn-primary" id="f-listen">🔊 Listen</button>
        <button class="btn btn-glass" id="f-stop" style="flex:0 0 auto">■ Stop</button>
      </div>
      ${f.text_from_report ? `<details class="f-quote"><summary>What the report says</summary><div class="quote">${escHtml(f.text_from_report)}</div></details>` : ""}
      ${DISCLAIMER}`;
    bindHead();
    $("f-stop").onclick = () => stopAnyAudio();
    $("f-listen").onclick = () => listen(it);
    b.querySelectorAll(".lang-seg button").forEach((btn) => (btn.onclick = () => setLang(btn.dataset.lang)));
  }

  /* ---------- sheet states + swipe ---------- */
  const SHEET_ORDER = ["collapsed", "half", "full"];
  let reframeTimer = null;
  function setSheet(state, { reframe = true } = {}) {
    if (!SHEET_ORDER.includes(state)) return;
    const changed = state !== sheetState;
    sheetState = state;
    $("body-sheet").dataset.state = state;
    const chev = $("sheet-chev");
    if (chev) chev.setAttribute("aria-label", state === "collapsed" ? "Show details" : "Hide details");
    if (!changed || !reframe) return;
    // After the height transition, keep the selected spot centred above the sheet.
    clearTimeout(reframeTimer);
    reframeTimer = setTimeout(() => {
      updateInsets();
      if (!Body3D.ready) return;
      const pl = sel >= 0 && items[sel] ? items[sel].placement : null;
      if (focusMode === "finding" && pl) Body3D.focusPlacement(pl);
      else Body3D.resetView({ yaw: Body3D.cam.yaw, duration: 0.8 });
    }, 340);
  }

  // Swipe up/down on the sheet header changes state; a short tap still clicks.
  let swipe = null, swallowClick = false;
  function consumeSwipe() { if (swallowClick) { swallowClick = false; return true; } return false; }
  function bindSwipe() {
    const head = $("sheet-head");
    head.addEventListener("pointerdown", (e) => { swipe = { y: e.clientY }; });
    // Listen on window: a swipe usually ends outside the header.
    window.addEventListener("pointerup", (e) => {
      if (!swipe) return;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dy) < 28) return;
      swallowClick = true;                    // don't also press the button under the finger
      setTimeout(() => (swallowClick = false), 350);
      const idx = SHEET_ORDER.indexOf(sheetState);
      setSheet(SHEET_ORDER[Math.max(0, Math.min(2, idx + (dy < 0 ? 1 : -1)))]);
    });
    window.addEventListener("pointercancel", () => (swipe = null));
  }

  async function setLang(l) {
    if (l === lang) return;
    lang = l;
    const it = items[sel];
    if (l === "ta" && it && !(it.f.explanation_ta || "").trim()) {
      const id = report.document_id;
      if (id && !String(id).startsWith("demo")) {
        $("f-exp").innerHTML = `<span class="typing"><i></i><i></i><i></i></span> Getting the Tamil explanation…`;
        try {
          const r = await api(`/radiology/${encodeURIComponent(id)}?lang=ta`, { timeout: 60000 });
          // merge explanation_ta into current items without resetting the view
          const byId = {};
          (r.zones || []).forEach((z) => (z.findings || []).forEach((f) => (byId[f.id || f.text_from_report] = f)));
          items.forEach((x) => { const m = byId[x.f.id || x.f.text_from_report]; if (m && m.explanation_ta) x.f.explanation_ta = m.explanation_ta; });
        } catch (e) {
          toast("Tamil explanation is not available right now.");
        }
      }
      if (!(it.f.explanation_ta || "").trim()) toast("Tamil explanation is not available for this finding.");
    }
    renderSheet();
  }

  async function listen(it) {
    unlockAudio();
    const btn = $("f-listen");
    const useTa = lang === "ta" && (it.f.explanation_ta || "").trim();
    const text = useTa
      ? `${it.zone_ta || it.zone_en}. ${it.f.explanation_ta}. இது உங்கள் அறிக்கையை எளிய வார்த்தைகளில் விளக்குகிறது. தயவுசெய்து உங்கள் மருத்துவரிடம் பேசுங்கள்.`
      : `${it.zone_en}, ${sideLabel(it.side).toLowerCase()}. ${it.location}. ${it.f.explanation_en || ""} This explains your report in simple words. Please discuss it with your doctor.`;
    btn.disabled = true;
    btn.textContent = "Preparing voice…";
    try {
      const provider = await speakText(`finding-${sel}-${lang}`, text, useTa ? "ta" : "en");
      if ($("f-listen") === btn) btn.textContent = `🔊 Playing (${provider})`;
    } catch (e) {
      toast("Could not play the voice. Please try again.");
    } finally {
      setTimeout(() => { if ($("f-listen") === btn) { btn.disabled = false; btn.textContent = "🔊 Listen again"; } }, 1200);
    }
  }

  function step(d) {
    if (!items.length) return;
    select((sel + d + items.length) % items.length, { user: true });
  }

  function select(i, { fly = true, user = false } = {}) {
    if (!items[i]) return;
    sel = i;
    stopAnyAudio();
    const opening = user && sheetState === "collapsed";
    if (opening) setSheet("half", { reframe: false });
    renderSheet();
    if (window.gsap && sheetState !== "collapsed") gsap.fromTo("#sheet-body > *", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.03, ease: "power2.out", clearProps: "transform" });
    $("sheet-body").scrollTop = 0;
    if (Body3D.ready) {
      Body3D.highlight(i);
      if (fly) {
        focusMode = "finding";
        const pl = items[i].placement;
        // If the sheet is opening, fly after its height settles so framing uses the final size.
        const go = () => { updateInsets(); if (pl) Body3D.focusPlacement(pl); else { focusMode = "overview"; Body3D.resetView(); } };
        setTimeout(go, opening ? 340 : 30);
      }
    }
  }

  function renderEmpty() {
    $("body-loading").hidden = true;
    items = [];
    if (Body3D.ready) { Body3D.setFindings([]); Body3D.setNormal(false); }
    $("study-title").textContent = "Your body map";
    const isErr = prefetchState === "error";
    $("study-meta").textContent = isErr ? "Could not reach the server" : "No scan report yet";
    $("body-banner").innerHTML = "";
    $("sheet-head").innerHTML = headHtml(isErr ? "Connection problem" : "Nothing to show yet",
      `<div class="peek-text">${isErr ? "Couldn't load your report" : "No scan report yet"}</div>`);
    bindHead();
    setSheet("half", { reframe: false });
    $("sheet-body").innerHTML = `
      <p style="margin:8px 0 12px;font-size:18px">${isErr
        ? "We couldn't load your latest scan report. Please check your internet and try again."
        : "Scan an X-ray, MRI, CT or ultrasound <strong>report</strong>, and the areas it mentions will light up on this body."}</p>
      <div class="f-actions">
        ${isErr ? `<button class="btn btn-primary" id="empty-retry">Try again</button>` : `<button class="btn btn-primary" id="empty-scan">Scan a report</button>`}
        ${FLAGS.demo ? `<button class="btn btn-glass" id="empty-demo">Demo reports</button>` : ""}
      </div>`;
    const s = $("empty-scan"); if (s) s.onclick = () => App.go("scan");
    const rt = $("empty-retry"); if (rt) rt.onclick = () => { $("body-loading").hidden = false; prefetchState = "idle"; prefetch(); };
    const dm = $("empty-demo"); if (dm) dm.onclick = () => toggleDemo(true);
    requestAnimationFrame(updateInsets);
    if (Body3D.ready && visible) Body3D.introSpin(() => Body3D.resetView({ duration: 1 }));
  }

  /* ---------- demo menu ---------- */
  function buildDemoMenu() {
    const m = $("demo-menu");
    m.innerHTML = `<div class="dm-title">Demo reports</div>` +
      DEMO_REPORTS.map((d) => `<button data-k="${d.key}">${escHtml(d.menu)}<small>${escHtml(d.menuSub)}</small></button>`).join("") +
      `<button data-k="__latest">Latest scanned report<small>From the server</small></button>`;
    m.querySelectorAll("button").forEach((b) => (b.onclick = () => {
      toggleDemo(false);
      if (b.dataset.k === "__latest") { report = null; prefetchState = "idle"; $("body-loading").hidden = false; prefetch(); return; }
      const d = DEMO_REPORTS.find((x) => x.key === b.dataset.k);
      load(JSON.parse(JSON.stringify(d.data)));
    }));
  }
  function toggleDemo(show) {
    const m = $("demo-menu");
    const s = show ?? m.hidden;
    m.hidden = !s;
    if (s) animateIn(m, { y: -8, duration: 0.3 });
  }

  /* ---------- public ---------- */
  function load(r) {
    report = r;
    prefetchState = "done";
    if (visible) applyReport(true);
  }

  function init() {
    $("btn-front").onclick = () => { if (Body3D.ready) { focusMode = "overview"; Body3D.faceFront(); } };
    $("btn-back").onclick = () => { if (Body3D.ready) { focusMode = "overview"; Body3D.faceBack(); } };
    $("btn-reset").onclick = () => { if (Body3D.ready) { focusMode = "overview"; Body3D.highlight(sel >= 0 ? sel : null); Body3D.resetView(); } };
    bindSwipe();
    if (FLAGS.demo) { $("btn-demo").hidden = false; $("btn-demo").onclick = () => toggleDemo(); buildDemoMenu(); }
    if (FLAGS.debug) $("debug-panel").hidden = false;
    // AR is an extra mode: the button only appears when the phone supports immersive-ar.
    if (window.BodyAR) {
      BodyAR.isSupported().then((ok) => {
        if (!ok || !glOk) return;
        $("btn-ar").hidden = false;
        animateIn($("btn-ar"), { y: 8 });
      });
      $("btn-ar").onclick = () => {
        if (!Body3D.ready) { toast("AR is not available on this phone"); return; }
        stopAnyAudio();
        try { BodyAR.start({ items, report }); }
        catch (e) { console.error(e); toast("AR is not available on this phone"); }
      };
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => updateInsets());
      ro.observe($("body-sheet")); ro.observe($("body-top"));
    }
  }

  function onShow(opts = {}) {
    visible = true;
    ensureEngine();
    Body3D.ready && Body3D.start();
    if (opts.report) report = opts.report;
    if (report && report !== applied) { applyReport(true); return; }
    if (report) { if (pendingIntro) runIntro(); requestAnimationFrame(updateInsets); return; }
    if (prefetchState === "empty" || prefetchState === "error") renderEmpty();
    else { $("body-loading").hidden = false; if (prefetchState === "idle") prefetch(); }
  }

  function onHide() {
    visible = false;
    Body3D.ready && Body3D.stop();
    stopAnyAudio();
    toggleDemo(false);
  }

  function afterAR() {
    if (Body3D.ready) Body3D.highlight(sel >= 0 ? sel : null);
    requestAnimationFrame(updateInsets);
  }

  return { init, onShow, onHide, prefetch, load, afterAR, get report() { return report; } };
})();
