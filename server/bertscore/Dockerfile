FROM python:3.11-slim-bookworm@sha256:ef56ae98435cc40d8a27020b0b32a9941515acd5840f0fba34858bb34dd362d1
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/cache/huggingface HF_HUB_DOWNLOAD_TIMEOUT=60 HF_HUB_DISABLE_XET=1 BERTSCORE_HOST=0.0.0.0
WORKDIR /app
COPY server/bertscore/requirements.txt .
RUN pip install --no-cache-dir --timeout 60 --retries 5 -r requirements.txt
COPY server/bertscore/service.py .
RUN useradd --uid 10001 --create-home scorer && mkdir -p /cache/huggingface && chown -R scorer /cache
USER scorer
EXPOSE 8090
CMD ["python", "service.py"]
