# FLUX Image Generator FastAPI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local FastAPI image-generation website matching the referenced Modal FLUX app, with a real NVIDIA FLUX provider path and a no-key demo fallback.

**Architecture:** FastAPI serves a static single-page UI and exposes `/generate`. The image service validates prompt/model/size, maps UI sizes to NVIDIA-supported dimensions, calls NVIDIA NIM when `NVIDIA_API_KEY` is present, and otherwise returns a deterministic PNG data URL demo image.

**Tech Stack:** Python 3.11, FastAPI, Uvicorn, HTTPX, Pillow, stdlib unittest/pytest-compatible tests.

---

### Task 1: Backend service contract

**Files:**
- Create: `tests/test_image_service.py`
- Create: `app/image_service.py`
- Create: `app/demo_image.py`
- Create: `app/settings.py`

- [ ] Write tests for size mapping, empty prompt rejection, demo fallback data URL, and rate-limit error mapping.
- [ ] Run tests and confirm they fail because modules do not exist yet.
- [ ] Implement minimal production modules to satisfy tests.
- [ ] Re-run tests and keep output clean.

### Task 2: FastAPI routes

**Files:**
- Create: `tests/test_app.py`
- Create: `app/main.py`

- [ ] Test `/health`, `/`, and `/generate` JSON shape.
- [ ] Implement FastAPI app, static file mounting, and `/generate` route.
- [ ] Re-run route tests.

### Task 3: Frontend

**Files:**
- Create: `app/static/index.html`
- Create: `app/static/styles.css`
- Create: `app/static/app.js`

- [ ] Build UI matching the reference: prompt textarea, model/size selectors, idea cards, generate/download buttons, status line, stage area.
- [ ] Wire `fetch('/generate')` and cooldown handling.
- [ ] Keep static assets framework-free.

### Task 4: Project docs and run scripts

**Files:**
- Create: `README.md`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `requirements.txt`

- [ ] Document setup, run, test, and NVIDIA key configuration.
- [ ] Include endpoint references and supported env vars.

### Task 5: Verification

**Commands:**
- `python -m pip install -r requirements.txt`
- `python -m pytest -q`
- `python -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
- HTTP smoke test: `GET /health`, `POST /generate`.
