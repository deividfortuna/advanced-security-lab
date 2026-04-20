# Parameterized base image via ARG — scanner cannot statically evaluate the
# image reference, so the FROM is intentionally skipped (no alert).

ARG BASE_IMAGE=cgr.dev/chainguard/python:latest
FROM ${BASE_IMAGE}
WORKDIR /app
COPY . .
CMD ["python", "app.py"]
