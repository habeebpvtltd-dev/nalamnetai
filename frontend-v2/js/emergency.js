/* emergency.js — PIN-protected emergency card: setup, unlock, one-tap call,
   QR code for first responders, printable card. */

window.EmergencyUI = (() => {
  const $ = (id) => document.getElementById(id);
  let pin = null;       // kept in memory only while unlocked
  let profile = null;
  let qr = null;

  function show(which) {
    $("em-unlock-card").hidden = which !== "unlock";
    $("em-setup-card").hidden = which !== "setup";
    $("em-profile").hidden = which !== "profile";
    const el = which === "unlock" ? $("em-unlock-card") : which === "setup" ? $("em-setup-card") : $("em-profile");
    animateIn(el);
  }

  function setBusy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spinner" style="width:20px;height:20px;border-width:2px"></span> ${label}`; btn.disabled = true; }
    else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.disabled = false; }
  }

  async function unlock(p) {
    const btn = $("em-unlock-btn");
    if (!p || p.length < 4) { toast("Please enter your PIN (at least 4 digits)."); return; }
    setBusy(btn, true, "Opening…");
    try {
      profile = await api(`/emergency/unlock?${new URLSearchParams({ pin: p })}`, { method: "POST", timeout: 60000 });
      pin = p;
      if (profile.emergency_contact) store.set("contact", profile.emergency_contact);
      $("em-unlock-pin").value = "";
      renderProfile();
      show("profile");
      loadQr();
    } catch (e) {
      if (e.status === 401) toast("That PIN is not correct. Please try again.");
      else if (e.status === 404) { toast("No emergency card yet. Let's set one up."); show("setup"); }
      else toast("Can't reach the server. Please check your internet.");
    } finally {
      setBusy(btn, false);
    }
  }

  async function save() {
    const v = (id) => $(id).value.trim();
    const data = {
      blood_group: v("em-blood"), allergies: v("em-allergies") || "None known", conditions: v("em-conditions") || "None known",
      emergency_contact: v("em-contact"), preferred_hospital: v("em-hospital") || "Not set", pin: v("em-pin"),
    };
    if (!data.blood_group) return toast("Please choose your blood group.");
    if (!/^[+\d][\d\s-]{6,}$/.test(data.emergency_contact)) return toast("Please enter a valid phone number for your emergency contact.");
    if (!/^\d{4,8}$/.test(data.pin)) return toast("Please choose a PIN of 4 to 8 digits.");
    const btn = $("em-save-btn");
    setBusy(btn, true, "Saving…");
    try {
      await api(`/emergency/setup?${new URLSearchParams(data)}`, { method: "POST", timeout: 60000 });
      store.set("contact", data.emergency_contact);
      toast("Your emergency card is saved.");
      $("em-pin").value = "";
      setBusy(btn, false);
      await unlock(data.pin);
    } catch (e) {
      toast(e.status ? "Could not save. Please check all fields." : "Can't reach the server. Please check your internet.");
      setBusy(btn, false);
    }
  }

  function row(k, v) { return `<div class="em-row"><div class="k">${k}</div><div class="v">${escHtml(v || "—")}</div></div>`; }

  function renderProfile() {
    const p = profile || {};
    const tel = (p.emergency_contact || "").replace(/[^\d+]/g, "");
    $("em-profile").innerHTML = `
      <div class="card glass em-card">
        <div class="em-top">
          <div>
            <div class="em-label">Emergency medical card</div>
            <div class="blood">${escHtml(p.blood_group || "—")}</div>
            <div class="blood-cap">Blood group</div>
          </div>
          <button class="btn btn-ghost" id="em-lock" style="min-height:48px">🔒 Lock</button>
        </div>
        <div class="em-rows">
          ${row("Allergies", p.allergies)}
          ${row("Health conditions", p.conditions)}
          ${row("Preferred hospital", p.preferred_hospital)}
          ${row("Emergency contact", p.emergency_contact)}
        </div>
        ${tel ? `<a class="btn btn-danger call-btn" href="tel:${escHtml(tel)}">📞 Call emergency contact</a>` : ""}
      </div>

      <div class="card glass">
        <h3>QR code for helpers</h3>
        <div class="qr-box" id="em-qr">
          <div class="spinner"></div><p>Making your QR code…</p>
        </div>
        <div class="btn-row">
          <button class="btn btn-glass" id="em-print" disabled>🖨️ Print card</button>
          <button class="btn btn-glass" id="em-copy" disabled>📋 Copy text</button>
        </div>
        <button class="btn btn-ghost btn-block" id="em-regen">Get a new QR link</button>
      </div>

      <button class="btn btn-ghost btn-block" id="em-edit">Change my card</button>`;
    $("em-lock").onclick = lock;
    $("em-edit").onclick = () => { fillForm(); show("setup"); };
    $("em-regen").onclick = regenerate;
    $("em-print").onclick = printCard;
    $("em-copy").onclick = copyText;
    staggerIn($("em-profile").querySelectorAll(".card, #em-edit"));
  }

  async function loadQr() {
    const box = $("em-qr");
    if (!profile?.public_token) { box.innerHTML = `<p>QR code is not available.</p>`; return; }
    try {
      qr = await api(`/emergency/${profile.public_token}/qr`, { timeout: 45000 });
      box.innerHTML = `<img src="data:image/png;base64,${qr.qr_code_base64}" alt="Emergency QR code" />
        <p>Anyone can scan this to see your blood group, allergies and current medicines, and call your contact.</p>`;
      $("em-print").disabled = false;
      $("em-copy").disabled = false;
    } catch (e) {
      box.innerHTML = `<p>Couldn't make the QR code right now.</p>`;
    }
  }

  function lockText() {
    const p = profile || {};
    return `EMERGENCY MEDICAL INFO\nBlood: ${p.blood_group || "-"}\nAllergies: ${p.allergies || "-"}\nConditions: ${p.conditions || "-"}\nContact: ${p.emergency_contact || "-"}\n${qr ? "Scan QR or visit: " + qr.url : ""}`;
  }

  async function copyText() {
    try { await navigator.clipboard.writeText(lockText()); toast("Copied. You can paste it as your lock-screen note."); }
    catch (e) { toast("Couldn't copy on this phone."); }
  }

  function printCard() {
    const p = profile || {};
    const w = window.open("", "_blank");
    if (!w) { toast("Please allow pop-ups to print the card."); return; }
    w.document.write(`<html><head><title>Emergency card</title></head>
      <body style="font-family:sans-serif;width:105mm;min-height:148mm;margin:0;padding:10mm;box-sizing:border-box;border:2px solid #000">
        <h1 style="color:#dc2626;text-align:center;margin-top:0;font-size:20px">EMERGENCY MEDICAL ID</h1>
        <p><strong>Name:</strong> _____________________</p>
        <p><strong>Blood group:</strong> <span style="font-size:22px;color:#dc2626;font-weight:bold">${escHtml(p.blood_group || "-")}</span></p>
        <p><strong>Allergies:</strong> ${escHtml(p.allergies || "-")}</p>
        <p><strong>Conditions:</strong> ${escHtml(p.conditions || "-")}</p>
        <p><strong>Preferred hospital:</strong> ${escHtml(p.preferred_hospital || "-")}</p>
        <p><strong>Emergency contact:</strong> ${escHtml(p.emergency_contact || "-")}</p>
        <div style="text-align:center;margin-top:16px">
          <img src="data:image/png;base64,${qr ? qr.qr_code_base64 : ""}" style="width:110px" />
          <p style="font-size:11px;color:#555">Scan for current medicines</p>
        </div>
      </body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
  }

  async function regenerate() {
    if (!pin) return;
    if (!confirm("Make a new QR link? Old printed QR codes will stop working.")) return;
    try {
      const r = await api(`/emergency/regenerate?${new URLSearchParams({ pin })}`, { method: "POST", timeout: 45000 });
      profile.public_token = r.public_token;
      toast("New QR link ready. Old QR codes no longer work.");
      $("em-print").disabled = true; $("em-copy").disabled = true;
      $("em-qr").innerHTML = `<div class="spinner"></div><p>Making your QR code…</p>`;
      loadQr();
    } catch (e) { toast("Couldn't make a new link. Please try again."); }
  }

  function lock() {
    pin = null; profile = null; qr = null;
    $("em-profile").innerHTML = "";
    show("unlock");
  }

  function fillForm() {
    const p = profile || {};
    $("em-blood").value = p.blood_group || "";
    $("em-allergies").value = p.allergies && p.allergies !== "None known" ? p.allergies : "";
    $("em-conditions").value = p.conditions && p.conditions !== "None known" ? p.conditions : "";
    $("em-contact").value = p.emergency_contact || "";
    $("em-hospital").value = p.preferred_hospital && p.preferred_hospital !== "Not set" ? p.preferred_hospital : "";
  }

  function init() {
    $("em-unlock-btn").onclick = () => unlock($("em-unlock-pin").value.trim());
    $("em-unlock-pin").addEventListener("keydown", (e) => { if (e.key === "Enter") unlock($("em-unlock-pin").value.trim()); });
    $("em-show-setup").onclick = () => { fillForm(); show("setup"); };
    $("em-save-btn").onclick = save;
    $("em-cancel-setup").onclick = () => show(profile ? "profile" : "unlock");
  }

  function onShow(opts = {}) {
    if (opts.setup && !profile) { fillForm(); show("setup"); return; }
    staggerIn(document.querySelectorAll("#screen-emergency .hero, #screen-emergency .card:not([hidden])"));
  }

  return { init, onShow };
})();
