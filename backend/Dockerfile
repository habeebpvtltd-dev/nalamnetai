FROM python:3.12-slim

# Install system deps: Tesseract + OpenCV shared libs
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-tam \
        libglib2.0-0 \
        libgl1 \
        libsm6 \
        libxext6 \
        libxrender1 \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ app/

# Use PORT env var provided by Render; default 8000 for local docker runs
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
