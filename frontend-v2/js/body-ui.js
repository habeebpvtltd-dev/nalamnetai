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
  let collapsed = false;
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
      Body3D.init($("body-canvas-host"), $("body-labels"), { onSelect: select, onView: onView });
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
    $("orient-hint").textContent = front
      ? "Front view · patient's left is on your right"
      : "Back view · patient's left is on your left";
    if (FLAGS.debug) $("debug-panel").textContent =
      `yaw ${(c.yaw * 57.3 % 360).toFixed(0)}° pitch ${c.pitch.toFixed(2)} dist ${c.dist.toFixed(2)}\nfocus ${c.fx.toFixed(3)}, ${c.fy.toFixed(3)}, ${c.fz.toFixed(3)}`;
  }

  function updateInsets() {
    if (!Body3D.ready) return;
    const wrap = $("body-wrap").getBoundingClientRect();
    const top = $("body-top").getBoundingClientRect();
    const sheet = $("body-sheet").getBoundingClientRect();
    const t = Math.max(0, top.bottom - wrap.top) + 8;
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
        if (items.length) select(0);
        else Body3D.resetView({ duration: 1.2 });
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
      const contact = store.get("contact");
      el.innerHTML = `
        <div class="body-banner banner-critical">
          <div class="row">
            <div style="flex:1">Your report mentions a finding the doctor may need to see soon. <strong>Please contact your doctor today.</strong></div>
            ${contact
              ? `<a class="btn btn-danger" href="tel:${escHtml(contact)}" aria-label="Call emergency contact">📞 Call</a>`
              : `<button class="btn btn-danger" id="banner-setup">📞 Add</button>`}
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

  function renderSheet() {
    const b = $("sheet-body");
    const r = report || {};
    if (!items.length) {
      const allF = (r.all_findings || []).filter((f) => f.explanation_en);
      const msg = r.overall_normal
        ? `<div class="notice notice-ok"><span class="n-ico">✅</span><span>Your report does not mention any problem areas.</span></div>`
        : `<div class="notice notice-info"><span class="n-ico">ℹ️</span><span>This report does not point to a specific body area.</span></div>`;
      b.innerHTML = `
        <div class="sheet-peek"><div class="count">${escHtml(r.study_name || "Scan report")}</div></div>
        ${msg}
        ${r.impression ? `<div class="section-label">Report summary</div><div class="quote">${escHtml(r.impression)}</div>` : ""}
        ${allF.length ? `<div class="section-label">What the report says</div>` + allF.slice(0, 6).map((f) => `<div class="finding-row">${escHtml(f.explanation_en)}</div>`).join("") : ""}
        ${DISCLAIMER}`;
      return;
    }
    const it = items[sel] || items[0];
    const i = sel < 0 ? 0 : sel;
    const f = it.f;
    const hasTa = !!(f.explanation_ta && f.explanation_ta.trim());
    const exp = lang === "ta" && hasTa ? f.explanation_ta : f.explanation_en || "The report mentions this area.";
    const sevHex = "#" + new THREE.Color(SEVERITY_COLORS[it.severity]).getHexString();
    b.innerHTML = `
      <div class="sheet-peek">
        <button class="nav-btn" id="f-prev" aria-label="Previous finding" ${items.length < 2 ? "disabled" : ""}>${ICON_PREV}</button>
        <div class="count" style="text-align:center">Finding ${i + 1} of ${items.length}<br><span style="color:${sevHex};font-weight:800">${escHtml(it.zone_en)}</span></div>
        <button class="nav-btn primary" id="f-next" aria-label="Next finding" ${items.length < 2 ? "disabled" : ""}>Next ${ICON_NEXT}</button>
      </div>
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

    $("f-prev").onclick = () => step(-1);
    $("f-next").onclick = () => step(1);
    $("f-stop").onclick = () => stopAnyAudio();
    $("f-listen").onclick = () => listen(it);
    b.querySelectorAll(".lang-seg button").forEach((btn) => (btn.onclick = () => setLang(btn.dataset.lang)));
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
    select((sel + d + items.length) % items.length);
  }

  function select(i, { fly = true } = {}) {
    if (!items[i]) return;
    sel = i;
    stopAnyAudio();
    if (collapsed) setCollapsed(false);
    renderSheet();
    if (window.gsap) gsap.fromTo("#sheet-body > :not(.sheet-peek)", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.03, ease: "power2.out", clearProps: "transform" });
    $("sheet-body").scrollTop = 0;
    requestAnimationFrame(updateInsets);
    if (Body3D.ready) {
      Body3D.highlight(i);
      if (fly) {
        const pl = items[i].placement;
        if (pl) setTimeout(() => Body3D.focusPlacement(pl), 30);
        else Body3D.resetView();
      }
    }
  }

  function setCollapsed(c) {
    collapsed = c;
    $("body-sheet").classList.toggle("collapsed", c);
    requestAnimationFrame(updateInsets);
  }

  function renderEmpty() {
    $("body-loading").hidden = true;
    items = [];
    if (Body3D.ready) { Body3D.setFindings([]); Body3D.setNormal(false); }
    $("study-title").textContent = "Your body map";
    const isErr = prefetchState === "error";
    $("study-meta").textContent = isErr ? "Could not reach the server" : "No scan report yet";
    $("body-banner").innerHTML = "";
    $("sheet-body").innerHTML = `
      <div class="sheet-peek"><div class="count">${isErr ? "Connection problem" : "Nothing to show yet"}</div></div>
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
    $("btn-front").onclick = () => Body3D.ready && Body3D.faceFront();
    $("btn-back").onclick = () => Body3D.ready && Body3D.faceBack();
    $("btn-reset").onclick = () => { if (Body3D.ready) { Body3D.highlight(sel >= 0 ? sel : null); Body3D.resetView(); } };
    $("sheet-handle").onclick = () => setCollapsed(!collapsed);
    if (FLAGS.demo) { $("btn-demo").hidden = false; $("btn-demo").onclick = () => toggleDemo(); buildDemoMenu(); }
    if (FLAGS.debug) $("debug-panel").hidden = false;
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

  return { init, onShow, onHide, prefetch, load, get report() { return report; } };
})();
