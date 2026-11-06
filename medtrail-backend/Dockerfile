FROM python:3.12-slim

# Tesseract for OCR on photos, poppler for scanned PDFs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY scripts ./scripts

ENV PORT=8000
EXPOSE 8000
# 2 worker processes; each runs its own load protection. Scale instances for more.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 2 --proxy-headers"]
