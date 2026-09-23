/**
 * config.js — Runtime API base URL detection.
 * Loaded before app.js so API_BASE is available globally.
 *
 * Logic:
 *  - localhost / 127.x / 10.x / 192.168.x  → local backend on same host, port 8000
 *  - anything else (Vercel, remote)          → production Render URL
 */

(function () {
  const host = window.location.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host);

  window.API_BASE = isLocal
    ? `http://${host}:8000/api/v1/xr`
    : "https://nalamnetai-api.onrender.com/api/v1/xr";
})();
