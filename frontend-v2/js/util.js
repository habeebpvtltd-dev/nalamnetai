/* util.js — small shared helpers: API fetch, tween, toast, storage, escaping. */

function escHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function titleCase(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

const store = {
  get(k, d = null) { try { const v = localStorage.getItem("nalam." + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("nalam." + k, v); } catch (e) {} },
};

let _toastTimer;
function toast(msg, ms = 3200) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/**
 * api(path, opts) — fetch against API_BASE with a timeout.
 * The Render free tier sleeps; the first request can take ~50 s, so the
 * default timeout is generous and callers get an onSlow() hook to reassure users.
 */
async function api(path, { method = "GET", body, json, timeout = 90000, onSlow, slowAfter = 9000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const slow = onSlow ? setTimeout(onSlow, slowAfter) : null;
  const init = { method, signal: ctrl.signal };
  if (json !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  try {
    const res = await fetch(`${window.API_BASE}${path}`, init);
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.detail)) || `Server returned ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    Server.mark(true);
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("The server took too long to answer. Please try again.");
      err.timeout = true;
      Server.mark(false);
      throw err;
    }
    if (!e.status) Server.mark(false); // network failure
    else Server.mark(true);
    throw e;
  } finally {
    clearTimeout(t);
    if (slow) clearTimeout(slow);
  }
}

/* Server status pill */
const Server = {
  mark(ok) {
    const p = document.getElementById("server-pill");
    if (!p) return;
    p.dataset.state = ok ? "ok" : "down";
    p.querySelector(".label").textContent = ok ? "Online" : "Offline";
  },
  checking(text = "Connecting…") {
    const p = document.getElementById("server-pill");
    if (!p) return;
    p.dataset.state = "checking";
    p.querySelector(".label").textContent = text;
  },
};

/**
 * tween(target, vars) — GSAP if loaded, otherwise a tiny rAF fallback so the
 * app keeps working if the CDN fails. Supports duration, ease (ignored in
 * fallback beyond easeInOut), onUpdate, onComplete, delay. Returns {kill()}.
 */
function tween(target, vars) {
  if (window.gsap) return gsap.to(target, vars);
  const dur = (vars.duration ?? 0.5) * 1000;
  const delay = (vars.delay ?? 0) * 1000;
  const keys = Object.keys(vars).filter((k) => typeof vars[k] === "number" && !["duration", "delay"].includes(k));
  const from = {};
  let raf, killed = false, start;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const step = (now) => {
    if (killed) return;
    if (start === undefined) { start = now; keys.forEach((k) => (from[k] = target[k])); }
    const p = Math.min(1, (now - start) / (dur || 1));
    const e = ease(p);
    keys.forEach((k) => (target[k] = from[k] + (vars[k] - from[k]) * e));
    vars.onUpdate && vars.onUpdate();
    if (p < 1) raf = requestAnimationFrame(step);
    else vars.onComplete && vars.onComplete();
  };
  const timer = setTimeout(() => (raf = requestAnimationFrame(step)), delay);
  return { kill() { killed = true; clearTimeout(timer); cancelAnimationFrame(raf); } };
}

/* Fade/slide an element in (no-op if GSAP missing) */
function animateIn(el, opts = {}) {
  if (!el || !window.gsap) return;
  gsap.fromTo(el, { opacity: 0, y: opts.y ?? 16 }, { opacity: 1, y: 0, duration: opts.duration ?? 0.5, ease: "power3.out", delay: opts.delay ?? 0, clearProps: "transform" });
}
function staggerIn(els, opts = {}) {
  if (!els || !els.length || !window.gsap) return;
  gsap.fromTo(els, { opacity: 0, y: opts.y ?? 18 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", stagger: opts.stagger ?? 0.07, delay: opts.delay ?? 0, clearProps: "transform" });
}

function isTamilText(text) { return /[஀-௿]/.test(text || ""); }
