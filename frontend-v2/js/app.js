/* app.js — shell: tab navigation, screen transitions, boot. Loaded last. */

const App = (() => {
  const ORDER = ["scan", "body", "assistant", "emergency"];
  const modules = {
    scan: window.ScanUI,
    body: window.BodyUI,
    assistant: window.AssistantUI,
    emergency: window.EmergencyUI,
  };
  let current = null;
  let busy = false;

  const screenEl = (name) => document.getElementById(`screen-${name}`);
  const tabEl = (name) => document.querySelector(`.tab[data-tab="${name}"]`);

  function moveIndicator(name, animate = true) {
    const ind = document.getElementById("tab-indicator");
    const x = ORDER.indexOf(name) * 100;
    if (window.gsap && animate) gsap.to(ind, { xPercent: x, duration: 0.45, ease: "power3.out" });
    else ind.style.transform = `translateX(${x}%)`;
  }

  function go(name, opts = {}) {
    if (!ORDER.includes(name)) return;
    if (name === current) { modules[name]?.onShow?.(opts); return; }
    const prev = current;
    current = name;

    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    moveIndicator(name, !!prev);

    const inEl = screenEl(name);
    const outEl = prev ? screenEl(prev) : null;
    const dir = prev ? Math.sign(ORDER.indexOf(name) - ORDER.indexOf(prev)) : 0;

    inEl.classList.add("active");
    // Let the incoming module size itself before it animates in (3D canvas needs layout).
    modules[name]?.onShow?.(opts);

    if (outEl) {
      modules[prev]?.onHide?.();
      if (window.gsap) {
        gsap.killTweensOf([inEl, outEl]);
        gsap.fromTo(outEl, { opacity: 1, x: 0 }, {
          opacity: 0, x: -40 * dir, duration: 0.28, ease: "power2.in",
          onComplete: () => { outEl.classList.remove("active"); gsap.set(outEl, { clearProps: "all" }); },
        });
        gsap.fromTo(inEl, { opacity: 0, x: 48 * dir }, { opacity: 1, x: 0, duration: 0.5, delay: 0.12, ease: "power3.out", clearProps: "transform" });
      } else {
        outEl.classList.remove("active");
      }
    } else if (window.gsap) {
      gsap.fromTo(inEl, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out", clearProps: "transform" });
    }
    try { history.replaceState(null, "", `${location.pathname}${location.search}#${name}`); } catch (e) {}
  }

  function boot() {
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => {
        // A tap is a user gesture: unlock audio so later async TTS can play on phones.
        if (t.dataset.tab === "assistant" && typeof unlockAudio === "function") unlockAudio();
        go(t.dataset.tab);
      })
    );

    Object.values(modules).forEach((m) => m?.init?.());

    const start = (location.hash || "").replace("#", "");
    go(ORDER.includes(start) ? start : "scan");

    // Warm the (possibly sleeping) Render backend and prefetch the latest report.
    Server.checking();
    window.BodyUI?.prefetch?.();

    window.addEventListener("resize", () => moveIndicator(current, false));
  }

  return { go, boot, get current() { return current; } };
})();

document.addEventListener("DOMContentLoaded", App.boot);
if (document.readyState !== "loading") App.boot();
