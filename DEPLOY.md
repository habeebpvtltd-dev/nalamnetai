# NalamNet Deployment Guide

## Local Development (unchanged)

```bash
# Backend
cd backend
python -m venv venv
venv\Scripts\activate          # Windows
pip install -r requirements.txt
cp .env.example .env           # fill in real values
uvicorn app.main:app --reload --reload-dir app --host 0.0.0.0 --port 8000

# Frontend — plain static file server
cd frontend-xr
python -m http.server 8080
# Then open http://localhost:8080 or http://<your-lan-ip>:8080 on your phone
```

---

## Docker (local test before pushing to Render)

```bash
cd backend

# Build
docker build -t nalamnet-backend .

# Run (mirrors what Render does)
docker run --rm -p 8000:8000 \
  --env-file .env \
  nalamnet-backend

# Health check
curl http://localhost:8000/health
```

> **Note:** On Windows, Docker Desktop must be running.
> If Docker is not installed, skip this step — Render will build the image in the cloud.

---

## Cloud Deployment

### Backend → Render

1. Push the repo to GitHub (make sure `.env` is gitignored — it is).
2. In Render → New → Web Service → connect your repo → select `backend/` as root directory.
3. Set **Environment** to **Docker** (Render auto-detects the `Dockerfile`).
4. Set the following **Environment Variables** in the Render dashboard:

| Variable | Value |
|---|---|
| `GROQ_API_KEY` | Your Groq API key (`gsk_...`) |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `PUBLIC_BASE_URL` | `https://YOUR-RENDER-APP.onrender.com` |
| `ALLOWED_ORIGINS` | `https://YOUR-VERCEL-APP.vercel.app` |
| `SECRET_KEY` | Random 64-char string |
| `FIELD_ENCRYPTION_KEY` | Random 32-char string |
| `TESSERACT_LANG` | `eng+tam` |

> `TESSERACT_CMD` is **not needed** on Render — Tesseract is installed by the Dockerfile and is on PATH.

5. Set **Health Check Path** to `/health`.
6. Deploy. After first deploy, copy the service URL (e.g. `https://nalamnet-backend.onrender.com`) and update `PUBLIC_BASE_URL` + `ALLOWED_ORIGINS`.

---

### Frontend → Vercel

1. In Vercel → New Project → import your repo → set **Root Directory** to `frontend-xr`.
2. No build command or output directory needed (static files).
3. After deploy, open `frontend-xr/config.js` and replace the placeholder:
   ```js
   "https://YOUR-RENDER-APP.onrender.com/api/v1/xr"
   ```
   with your real Render URL, then redeploy.

---

## Pre-demo Wake-up

Render free tier spins down after 15 min of inactivity. Before a demo, wake the server:

```bash
curl https://YOUR-RENDER-APP.onrender.com/health
```

Or just open the health URL in a browser ~30 seconds before your demo.
