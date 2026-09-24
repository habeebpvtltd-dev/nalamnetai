/* scan.js — camera capture / upload -> POST /scan -> premium result cards. */

window.ScanUI = (() => {
  const $ = (id) => document.getElementById(id);
  let statusTimer = null, busy = false, lastFile = null;

  const STEPS = ["Finding the text", "Understanding the document", "Picking out the important parts", "Almost there"];

  /* Big phone photos (4–12 MB) upload slowly on venue Wi-Fi. Shrink JPEG/PNG
     photos to 2400 px max; anything that fails to decode is sent unchanged. */
  async function prepareFile(file) {
    if (!file.type.startsWith("image/") || file.size < 2.5 * 1024 * 1024) return file;
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const max = 2400;
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      if (k >= 1) { URL.revokeObjectURL(url); return file; }
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
      if (!blob) return file;
      return new File([blob], (file.name || "scan").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
    } catch (e) {
      return file;
    }
  }

  function showStage(file) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    $("scan-stage").hidden = false;
    $("scan-how").hidden = true;
    $("scan-result").innerHTML = "";
    const img = $("scan-preview");
    if (isPdf) {
      img.hidden = true;
      $("scan-pdf").hidden = false;
      $("scan-pdf-name").textContent = file.name || "document.pdf";
    } else {
      $("scan-pdf").hidden = true;
      img.hidden = false;
      img.src = URL.createObjectURL(file);
    }
    $("scan-frame").classList.add("scanning");
    $("scan-status").hidden = false;
    let i = 0;
    $("scan-status-sub").textContent = STEPS[0];
    const t0 = Date.now();
    clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      i = Math.min(i + 1, STEPS.length - 1);
      $("scan-status-sub").textContent = Date.now() - t0 > 14000
        ? "The server may be waking up. This can take up to a minute the first time."
        : STEPS[i];
    }, 3000);
    animateIn($("scan-stage"));
    setTimeout(() => $("scan-stage").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function stopStage() {
    clearInterval(statusTimer);
    $("scan-frame").classList.remove("scanning");
    $("scan-status").hidden = true;
  }

  async function handleFile(file, input) {
    if (input) input.value = ""; // allow re-selecting the same file
    if (!file || busy) return;
    const ok = file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (!ok) { toast("Please choose a photo or a PDF file."); return; }
    lastFile = file;
    busy = true;
    showStage(file);
    try {
      const upload = await prepareFile(file);
      const fd = new FormData();
      fd.append("file", upload, upload.name || "scan.jpg");
      const data = await api("/scan", { method: "POST", body: fd, timeout: 150000 });
      stopStage();
      $("scan-stage").hidden = true;
      renderResult(data);
    } catch (e) {
      stopStage();
      renderError(e);
    } finally {
      busy = false;
    }
  }

  /* ---------- formatting helpers ---------- */
  const has = (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);
  function money(v) {
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.]/g, ""));
    if (isNaN(n)) return escHtml(v);
    return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function num(v) { const n = parseFloat(v); return isNaN(n) ? escHtml(v) : n.toLocaleString("en-IN"); }
  function parseDate(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      const d = new Date(y, +m[2] - 1, +m[1]);
      return isNaN(d) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function kv(label, value, { conf, full, fmt } = {}) {
    if (!has(value)) return "";
    const v = fmt ? fmt(value) : escHtml(value);
    const check = conf !== undefined && conf < 0.6 ? `<span class="check-tag">⚠ check</span>` : "";
    return `<div class="${full ? "full" : ""}"><div class="k">${escHtml(label)}</div><div class="v">${v}${check}</div></div>`;
  }
  function head(icon, kind, title) {
    return `<div class="result-head"><div class="result-icon">${icon}</div><div><div class="result-kind">${escHtml(kind)}</div><div class="result-title">${escHtml(title)}</div></div></div>`;
  }
  // Title-case medicine names but keep short abbreviations ("XR", "SR", "D3") as written.
  function medName(n) {
    return String(n).split(/\s+/).map((w) => (/^[A-Z0-9]{1,3}$/.test(w) ? w : titleCase(w))).join(" ");
  }
  const FREQ = {
    od: "Once a day", qd: "Once a day", bd: "Twice a day", bid: "Twice a day", tds: "Three times a day", tid: "Three times a day",
    qid: "Four times a day", hs: "At bedtime", sos: "Only when needed", prn: "Only when needed", stat: "Right away",
    ac: "Before food", pc: "After food",
  };
  function friendlyFreq(f) {
    if (!f) return "";
    const s = String(f).trim();
    const m = s.match(/^(\d(?:\/\d)?)\s*[-–]\s*(\d(?:\/\d)?)\s*[-–]\s*(\d(?:\/\d)?)(?:\s*[-–]\s*(\d))?/);
    if (m) {
      const parts = [];
      if (m[1] !== "0") parts.push(`Morning ${m[1]}`);
      if (m[2] !== "0") parts.push(`Afternoon ${m[2]}`);
      if (m[4] !== undefined) { if (m[3] !== "0") parts.push(`Evening ${m[3]}`); if (m[4] !== "0") parts.push(`Night ${m[4]}`); }
      else if (m[3] !== "0") parts.push(`Night ${m[3]}`);
      return parts.join(" · ") + (s.length > m[0].length ? " " + s.slice(m[0].length).trim() : "");
    }
    const key = s.toLowerCase().replace(/[^a-z]/g, "");
    return FREQ[key] ? `${FREQ[key]} (${s})` : s;
  }

  /* ---------- renderers ---------- */
  function renderResult(data) {
    const type = data.object_type;
    const f = data.fields || {};
    const c = data.field_confidence || {};
    let html = "";
    if (type === "radiology_image") html = radiologyImage(data);
    else if (type === "radiology_report") html = radiologyReport(data);
    else if (type === "prescription") html = prescription(f, c, data);
    else if (type === "electricity_bill") html = electricity(f, c);
    else if (type === "shopping_bill") html = shopping(f, c);
    else if (type === "warranty_card") html = warranty(f, c);
    else html = unknownDoc();

    const el = $("scan-result");
    $("scan-how").hidden = true;
    el.innerHTML = html + `<button class="btn btn-glass btn-block" id="scan-again">📷 Scan another document</button>`;
    $("scan-again").onclick = () => { el.innerHTML = ""; $("scan-how").hidden = false; $("screen-scan").scrollTo({ top: 0, behavior: "smooth" }); };
    const v3d = $("btn-view-3d");
    if (v3d) v3d.onclick = () => App.go("body", { report: data.radiology });
    const ask = $("btn-ask-meds");
    if (ask) ask.onclick = () => App.go("assistant", { ask: "What medicines should I take and when?" });
    const retry = $("btn-retake");
    if (retry) retry.onclick = () => $("input-camera").click();
    staggerIn(el.querySelectorAll(".result > *, #scan-again"), { stagger: 0.05 });
    setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }

  function prescription(f, c, data) {
    const meds = Array.isArray(f.medications) ? f.medications : [];
    const medConf = (i) => c[`medications_${i}_name`] ?? c[`medications_${i}`] ?? c.medications ?? 1;
    const anyUnclear = meds.some((m, i) => medConf(i) < 0.5);
    let h = `<div class="result glass">${head("💊", "Prescription", f.doctor_name ? `From ${f.doctor_name}` : "Your prescription")}`;
    if (data.handwritten || anyUnclear) {
      h += `<div class="notice notice-warn"><span class="n-ico">⚠️</span><span><strong>${data.handwritten ? "Handwritten prescription" : "Some medicines are unclear"}</strong>. Please confirm these medicines with your pharmacist or doctor before taking them.</span></div>`;
    }
    h += `<div class="kv">${kv("Date", f.date, { conf: c.date })}${kv("Next visit", f.follow_up_date, { conf: c.follow_up_date })}</div>`;
    if (meds.length) {
      h += `<div class="section-label">Medicines (${meds.length})</div>`;
      meds.forEach((m, i) => {
        if (!m) return;
        const unclear = medConf(i) < 0.5;
        const rows = [];
        if (m.dosage) rows.push(`<span class="chip">💊 ${escHtml(m.dosage)}</span>`);
        if (m.frequency) rows.push(`<span class="chip">🕘 ${escHtml(friendlyFreq(m.frequency))}</span>`);
        if (m.duration_days) rows.push(`<span class="chip">📅 For ${escHtml(m.duration_days)} days</span>`);
        h += `<div class="med ${unclear ? "unclear" : ""}">
          <div class="med-name"><span class="med-pill">${i + 1}</span>${escHtml(medName(m.name || "Unnamed medicine"))}</div>
          ${rows.length ? `<div class="med-rows">${rows.join("")}</div>` : ""}
          ${unclear ? `<div class="med-unclear-tag">⚠ Unclear. Confirm with your doctor or pharmacist.</div>` : ""}
        </div>`;
      });
      h += `<button class="btn btn-primary btn-block" id="btn-ask-meds">🗣️ Ask the assistant about these medicines</button>`;
    } else {
      h += `<div class="notice notice-info"><span class="n-ico">ℹ️</span><span>We couldn't read the medicine names. Please try a clearer photo in good light.</span></div>`;
    }
    return h + `</div>`;
  }

  function electricity(f, c) {
    let h = `<div class="result glass">${head("⚡", "Electricity bill", f.provider || "Electricity bill")}`;
    if (has(f.amount_due)) {
      const due = parseDate(f.due_date);
      let sub = f.due_date ? `Pay by <strong>${escHtml(f.due_date)}</strong>` : "";
      if (due) {
        const days = Math.ceil((due - new Date().setHours(0, 0, 0, 0)) / 86400000);
        if (days > 1) sub += ` · ${days} days left`;
        else if (days === 1) sub += ` · due tomorrow`;
        else if (days === 0) sub += ` · due today`;
        else sub += ` · <span style="color:#fca5a5">past the due date</span>`;
      }
      h += `<div class="big-amount"><div class="label">Amount to pay</div><div class="num">${money(f.amount_due)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
    }
    h += `<div class="kv">
      ${kv("Units used", f.units_consumed, { conf: c.units_consumed, fmt: (v) => num(v) + " units" })}
      ${!has(f.amount_due) ? kv("Due date", f.due_date, { conf: c.due_date }) : ""}
      ${kv("Billing period", f.billing_period, { conf: c.billing_period })}
      ${kv("Previous reading", f.previous_reading, { conf: c.previous_reading, fmt: num })}
      ${kv("Present reading", f.present_reading, { conf: c.present_reading, fmt: num })}
      ${kv("Energy charges", f.energy_charges, { conf: c.energy_charges, fmt: money })}
      ${kv("Fixed charges", f.fixed_charges, { conf: c.fixed_charges, fmt: money })}
      ${kv("Consumer number", f.consumer_number, { conf: c.consumer_number, full: true })}
      ${kv("Service number", f.service_number, { conf: c.service_number, full: true })}
    </div>`;
    if (!Object.values(f).some(has)) h += cantRead();
    return h + `</div>`;
  }

  function shopping(f, c) {
    const items = Array.isArray(f.items) ? f.items : [];
    let h = `<div class="result glass">${head("🧾", "Shopping bill", f.store_name || "Shopping bill")}`;
    if (has(f.total_amount)) h += `<div class="big-amount"><div class="label">Total</div><div class="num">${money(f.total_amount)}</div>${f.date ? `<div class="sub">${escHtml(f.date)}</div>` : ""}</div>`;
    h += `<div class="kv">${!has(f.total_amount) ? kv("Date", f.date) : ""}${kv("Paid by", f.payment_method, { conf: c.payment_method })}</div>`;
    if (items.length) {
      h += `<div class="section-label">Items (${items.length})</div><ul class="items-list">` +
        items.map((it) => `<li>${escHtml(typeof it === "object" ? Object.values(it).filter(has).join(" · ") : it)}</li>`).join("") + `</ul>`;
    }
    if (!Object.values(f).some(has)) h += cantRead();
    return h + `</div>`;
  }

  function warranty(f, c) {
    let h = `<div class="result glass">${head("🛡️", "Warranty card", f.product_name || f.brand || "Warranty")}`;
    h += `<div class="kv">
      ${kv("Brand", f.brand, { conf: c.brand })}
      ${kv("Bought on", f.purchase_date, { conf: c.purchase_date })}
      ${kv("Warranty", f.warranty_months, { conf: c.warranty_months, fmt: (v) => `${escHtml(v)} months` })}
      ${kv("Valid until", f.calculated_expiry_date)}
      ${kv("Serial number", f.serial_number, { conf: c.serial_number, full: true })}
    </div>`;
    if (!Object.values(f).some(has)) h += cantRead();
    return h + `</div>`;
  }

  function radiologyReport(data) {
    const r = data.radiology || {};
    const zones = r.zones || [];
    const findings = zones.flatMap((z) => (z.findings || []).map((f) => ({ z, f })));
    const counts = { severe: 0, moderate: 0, mild: 0, unknown: 0 };
    findings.forEach(({ f }) => (counts[f.severity_level in counts ? f.severity_level : "unknown"]++));
    const mod = { xray: "X-ray", mri: "MRI", ct: "CT scan", ultrasound: "Ultrasound" }[r.modality] || "Scan report";
    let h = `<div class="result glass">${head("🩻", mod, r.study_name || "Your scan report")}`;
    h += `<div class="kv">${kv("Date", r.study_date)}${kv("Radiologist", r.radiologist)}</div>`;
    if (r.is_critical) {
      h += `<div class="notice notice-danger"><span class="n-ico">⚠️</span><span>Your report mentions a finding the doctor may need to see soon. <strong>Please contact your doctor today.</strong></span></div>`;
    } else if (r.overall_normal && !findings.length) {
      h += `<div class="notice notice-ok"><span class="n-ico">✅</span><span>Your report does not mention any problem areas.</span></div>`;
    }
    if (findings.length) {
      h += `<div class="chips-row" style="margin:8px 0 4px">` +
        ["severe", "moderate", "mild", "unknown"].filter((k) => counts[k]).map((k) =>
          `<span class="chip sev sev-${k}">${counts[k]} ${k === "unknown" ? "not graded" : k}</span>`).join("") + `</div>`;
      h += `<button class="btn btn-primary btn-xl btn-block" id="btn-view-3d">🧍 View on 3D body</button>`;
      h += `<div class="section-label">What the report found</div>`;
      findings.forEach(({ z, f }) => {
        const sev = f.severity_level in counts ? f.severity_level : "unknown";
        const side = f.side === "left" ? "Patient's left" : f.side === "right" ? "Patient's right" : "";
        h += `<div class="finding-row">
          <div class="fr-head"><span class="fr-zone">${escHtml(z.zone_en || "Location not stated")}</span><span class="chip sev sev-${sev}">${sev === "unknown" ? "Not graded" : titleCase(sev)}</span></div>
          ${side ? `<div style="color:var(--text-2);font-size:15px;margin-bottom:4px">${side}</div>` : ""}
          <div>${escHtml(f.explanation_en || f.text_from_report || "")}</div>
        </div>`;
      });
    } else {
      if (!r.overall_normal) h += `<div class="notice notice-info"><span class="n-ico">ℹ️</span><span>This report does not point to a specific body area.</span></div>`;
      h += `<button class="btn btn-glass btn-block" id="btn-view-3d">🧍 View on 3D body</button>`;
    }
    if (r.impression) h += `<div class="section-label">Report summary</div><div class="quote">${escHtml(r.impression)}</div>`;
    h += `<div class="disclaimer">ℹ️ This explains your report in simple words. Please discuss it with your doctor.</div>`;
    return h + `</div>`;
  }

  function radiologyImage(data) {
    return `<div class="result glass">${head("🩻", "Scan film", "This looks like the scan image")}
      <div class="notice notice-info"><span class="n-ico">📄</span><span>${escHtml(data.radiology_image_warning || "Please scan the written report from the radiologist, not the scan film.")}</span></div>
      <button class="btn btn-primary btn-block" id="btn-retake">📷 Scan the written report</button></div>`;
  }

  function unknownDoc() {
    return `<div class="result glass">${head("🔍", "Not recognised", "We couldn't tell what this is")}
      <p style="margin:0 0 8px">NalamNet reads <strong>prescriptions, electricity bills, shopping bills and scan reports</strong>.</p>
      ${tips()}
      <button class="btn btn-primary btn-block" id="btn-retake">📷 Try again</button></div>`;
  }

  function cantRead() {
    return `<div class="notice notice-warn"><span class="n-ico">⚠️</span><span>We couldn't read the details clearly.</span></div>${tips()}`;
  }
  function tips() {
    return `<ul style="margin:6px 0 4px;padding-left:20px;color:var(--text-2)">
      <li>Place the paper on a flat, dark surface</li><li>Use good light and avoid shadows</li><li>Fit the whole page in the photo</li></ul>`;
  }

  function renderError(e) {
    const el = $("scan-result");
    const net = !e.status;
    const title = e.timeout ? "This is taking too long" : net ? "Can't reach the server" : "Couldn't read this document";
    const msg = e.timeout
      ? "The server is slow right now. Please try again in a moment."
      : net ? "Please check your internet connection and try again."
      : (e.message || "Please retake the photo.");
    el.innerHTML = `<div class="result glass">${head(net ? "📡" : "📄", "Something went wrong", title)}
      <p style="margin:0 0 8px">${escHtml(msg)}</p>${!net && !e.timeout ? tips() : ""}
      <div class="btn-row">
        <button class="btn btn-primary" id="err-retry">Try again</button>
        <button class="btn btn-glass" id="err-new">New photo</button>
      </div></div>`;
    $("err-retry").onclick = () => lastFile && handleFile(lastFile);
    $("err-new").onclick = () => $("input-camera").click();
    $("scan-stage").hidden = true;
    animateIn(el.firstElementChild);
  }

  function init() {
    $("btn-camera").onclick = () => $("input-camera").click();
    $("btn-upload").onclick = () => $("input-upload").click();
    $("input-camera").onchange = (e) => handleFile(e.target.files[0], e.target);
    $("input-upload").onchange = (e) => handleFile(e.target.files[0], e.target);
  }

  function onShow() {
    staggerIn(document.querySelectorAll("#screen-scan .hero, #screen-scan .scan-actions > .btn, #scan-kinds, #scan-how:not([hidden])"), { stagger: 0.08 });
  }

  return { init, onShow, renderResult, handleFile };
})();
