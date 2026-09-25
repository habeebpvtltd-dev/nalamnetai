/* quicklook.js — Apple AR Quick Look for iPhone/iPad Safari (fully separate from WebXR AR).
   Shows a static USDZ of the body shape via iOS's built-in AR viewer. No findings, markers
   or interactivity: that stays in the 3D view. Additive only: shows nothing elsewhere. */
(function () {
  function shouldShow(ua, platform, maxTouchPoints, supportsAr) {
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1); // iPadOS reports "Mac"
    return !!(isIOS && supportsAr);
  }

  function browserSupportsQuickLook() {
    try {
      const a = document.createElement("a");
      return !!(a.relList && a.relList.supports && a.relList.supports("ar"));   // Apple's recommended check
    } catch (e) {
      return false;
    }
  }

  function init() {
    try {
      const wrap = document.getElementById("ql-wrap");
      if (!wrap) return;
      if (shouldShow(navigator.userAgent, navigator.platform, navigator.maxTouchPoints || 0, browserSupportsQuickLook())) {
        wrap.hidden = false;
      }
    } catch (e) {
      /* never affect the rest of the app */
    }
  }

  window.NalamQuickLook = { shouldShow, browserSupportsQuickLook };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
