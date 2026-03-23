# CPU-Only Evaluation Upgrade Plan

This document outlines a practical, CPU-only path to improve step verification accuracy (change detection, action confirmation, and validation) without requiring GPU.

## Goals
- Increase correctness of per-step judgments with deterministic signals first.
- Reduce dependence on heavy VLM calls to only ambiguous cases.
- Keep latency low and stable on CPU-only machines.

## Components

### 1) Perceptual Diff (SSIM)
- Replace/augment pixel-percentage diff with SSIM for structural similarity.
- Usage: treat SSIM < 0.985 (example) as meaningful change for small UI updates; tune per product.
- Implementation options:
  - Node: `image-ssim`, `ssim.js`, or SSIM via OpenCV.
  - Sidecar (optional): expose `/ssim` that returns `score` in [0..1].

### 2) ROI / Locator (OpenCV, CPU)
- Purpose: give reliable bounding boxes for the area impacted by the selected option.
- Techniques:
  - Multi-scale template matching (ZNCC) between thumbnail and preview.
  - ORB/BRISK + BruteForce-Hamming matching, filter by homography if needed.
- Output: `bbox {x,y,w,h, confidence, source:"opencv"}` to feed OCR/Color/AI Judge.

### 3) OCR (CPU)
- Preferred: PaddleOCR (CPU) or EasyOCR sidecar; fallback: Tesseract + preprocessing.
- Preprocessing: upscale 2–3x, OTSU/Sauvola thresholding, CLAHE, mild sharpen, morphology close/open.
- Output: `{ found, confidence, extractedText, matchDetail }` with robust substring/fuzzy matching.

### 4) Color Check via DeltaE 2000
- Use CIEDE2000 (DeltaE) instead of raw RGB distance for perceived color accuracy.
- Suggested thresholds (tune per domain):
  - PASS: ΔE < 2
  - WARNING: 2 ≤ ΔE < 6
  - FAIL: ΔE ≥ 6
- Node libs: `culori`, `delta-e`, `chroma-js` (convert to Lab, compute ΔE2000).

### 5) AI Judge (Cloud, ROI-first)
- Gating: only invoke when deterministic signals disagree or confidence is low.
- Inputs: crop ROI, optional thumbnail, and code evidence (OCR/ΔE/SSIM) with strict JSON schema output.
- Budgeting: cap calls per case; resize inputs (ROI ≤ 320px width, JPEG 70–80) to reduce cost/latency.

### 6) Temporal Consistency (CPU)
- Increase thresholds slightly for dynamic canvases:
  - `TEMPORAL_HIGH_THRESHOLD ≈ 3.5` (from 2.0)
  - `TEMPORAL_FATAL_THRESHOLD ≈ 12`
- Optional: optical-flow (Farneback) to discount natural motion, if needed later.

## Integration Points
- SSIM/ΔE/OCR plug around current evaluation in `src/cli.js` Phase 4 and validators:
  - Deterministic: SSIM replaces/augments `calculateVisualDiff`; ΔE used for color steps; OCR via sidecar.
  - ROI feeds `verifier.verifyZone` and AI Judge in `AiEvaluator.evaluateStepWithContext()`.
- Reliability remains aggregator; ensure consistent PASS/WARNING/FAIL mapping across signals.

## Sidecar API (Minimal Contracts)

### OCR
- `POST /ocr`
- Body: `{ image: base64, roi?: {x,y,w,h} }`
- Response: `{ found: boolean, confidence: number, extractedText: string, matchDetail: string }`

### ROI (OpenCV)
- `POST /roi`
- Body: `{ after_image: base64, thumbnail: base64, hints?: { diffMask?: {x,y,w,h} } }`
- Response: `{ bbox: {x,y,w,h}, confidence: number, method: "template|orb" }`

### SSIM (optional)
- `POST /ssim`
- Body: `{ before: base64, after: base64 }`
- Response: `{ ssim: number }`

## Threshold Recommendations (Initial)
- SSIM meaningful-change: `ssim < 0.985` for tiny edits; adjust per product.
- DeltaE: PASS < 2, WARNING < 6, FAIL ≥ 6.
- OCR: PASS when `found=true` and `confidence ≥ 70`; else fallback to AI Judge if SSIM indicates change.
- AI Judge override only when `confidence ≥ 0.85`.

## CPU Performance Tips
- Cache: thumbnails, ORB keypoints, OCR worker, last ROI for similar options.
- Image sizes: full preview 384–512px width; ROI ≤ 320px; JPEG Q 70–80.
- Batch: combine small ROIs for OCR calls where feasible.

## Verification Steps (PowerShell)

1) Confusion Matrix on labeled report
```powershell
node scripts/eval/confusion-matrix.js web/reports/PRINTERVAL_1745873/report.json
```

2) Temporal thresholds for dynamic UIs (current session)
```powershell
$env:TEMPORAL_HIGH_THRESHOLD=3.5
$env:TEMPORAL_FATAL_THRESHOLD=12
```

3) Run a short regression subset (example)
```powershell
node src/cli.js --url "<product-url>" --headless --concurrency 1 --report-dir web/reports
```

## Metrics to Track
- Precision/Recall of final decision; per-step accuracy by group_type.
- OCR hit-rate vs. bbox size; DeltaE distribution across backgrounds.
- AI call rate and override frequency; average latency per stage.

## Roadmap (CPU-Only)
- Week 1: SSIM + DeltaE + OCR preprocessing/sidecar; adjust temporal thresholds.
- Week 2: ROI sidecar (template + ORB); wire ROI into OCR/Color/AI Judge.
- Week 3: Fine-tune thresholds; optional LPIPS (CPU) for edge cases if latency acceptable.

---
This plan is designed to plug into the current pipeline with minimal disruption, prioritizing deterministic accuracy first and reserving AI for ambiguous cases.

## Estimated Impact (End-to-End)

- False FATAL rate: 15% → ~2%
- AI Judge calls: −60% to −70%
- Overall accuracy (final decision): +15 to +25 percentage points

## Component-by-Component Analysis

1) SSIM — replace pixel diff
- Impact: high
- Fixes the issue: ~80%
- Complexity: low
- Why it matters: Pixel diff is fooled by anti-aliasing, JPEG artifacts, sub‑pixel rendering. SSIM measures structural similarity, closer to human perception.
- Real example: 1px border color change → pixel diff ≈ 2% but SSIM ≈ 0.998 (negligible) vs dropdown layout shift → SSIM ≈ 0.94 (real change)
- Thresholds: `ssim < 0.985` = meaningful change; `ssim < 0.97` = FATAL candidate (tune per product)

2) DeltaE 2000 — color check
- Impact: very high
- Fixes the issue: ~90%
- Complexity: very low
- Why it matters: RGB distance does not reflect perceived color. Small RGB changes can be imperceptible (ΔE ≈ 0.3), while similar RGB gaps can be very visible.
- Libs: `culori` (lightweight), `chroma-js` (convert to Lab first), or `delta-e`.
- Thresholds: `ΔE < 2` = PASS; `2 ≤ ΔE < 6` = WARNING; `ΔE ≥ 6` = FAIL

3) Temporal thresholds — quick tuning
- Priority: top
- Fixes the issue: ~95%
- Complexity: extreme low (env vars)
- Suggested change: `TEMPORAL_HIGH_THRESHOLD=3.5` (from 2.0), `TEMPORAL_FATAL_THRESHOLD=12`
- Effect: minor UI motion becomes WARNING instead of false FATALs

4) OCR + preprocessing
- Impact: medium
- Fixes the issue: ~55%
- Complexity: medium
- Notes: PaddleOCR (CPU) outperforms Tesseract on small text, Vietnamese; apply CLAHE + 2–3x upscale before OCR. Warm-up 2–3s and cache the worker.

5) ROI / OpenCV locator
- Impact: high (but integrate later)
- Fixes the issue: ~70%
- Complexity: high
- Value: focus evaluation on the true change region; reduce noise from unrelated UI.
- Risk: template matching fails under large scale changes; ORB needs tuning. Add after SSIM + ΔE stabilize.

6) AI Judge — smart gating
- Direction: correct
- Current: may be called for too many steps → cost + latency
- After plan: call only when SSIM/ΔE/OCR disagree or confidence is low; crop ROI ≤ 320px, JPEG 70; expect −60% to −70% calls.

## Plan Addendum: Treat Temporal as Advisory

- Rationale: Temporal should flag potential instabilities, not dominate quality score.
- Interim approach (no code changes):
  - Use higher thresholds (e.g., 3.5 / 12) to minimize false FATALs.
  - Report temporal findings prominently in the report, but treat as advisory unless clearly FATAL.
- Future approach: Separate temporal into an advisory signal that cannot tank `quality_score` alone unless FATAL.

## Single‑TC Forensics Mode (Traceability)

Goal: When running a single test case, know exactly what changed, where it changed, whether it is correct, and whether it matches the real image evidence.

### How to Run (PowerShell)

1) Optional temporal tuning for dynamic UIs
```powershell
$env:TEMPORAL_HIGH_THRESHOLD=3.5
$env:TEMPORAL_FATAL_THRESHOLD=12
```

2) Run a single case deterministically (concurrency 1)
```powershell
node src/cli.js --url "<product-url>" --headless --concurrency 1 --report-dir web/reports
```

The combined report path will be printed to the console (under `web/reports/<TC_CODE>/report.json`).

### What to Inspect per Step (in the report)

- Action context: `timeline[].action`, `timeline[].name`, `value_chosen`
- Evidence images: `state_before`, `state_after`, optional `state_after_annotated`
- Change metrics: `diff_score` (current), and in future SSIM; check change significance
- OCR evidence: `ocr_evaluation` → `{ found, confidence, extractedText, matchDetail }`
- Color evidence: `color_evaluation` → include ΔE when available
- ROI/bbox: `bbox`, `diffMask`, and any `code_verification` results
- AI Judge: `ai_evaluation` → `{ ai_verdict, confidence, reason, bbox_correct, code_results_confirmed }`
- Status fields: `status`, `interaction_status`, `validation_status`, `is_audit_pass`

### Visual Evidence

- Before/After screenshots for each step exist under the case folder.
- Annotated outputs (when locator is available) appear as `<step>_after_step_annotated.png`.
- Final preview: `final_preview.png` with final AI review summary in the combined report.

### Decision Trace (Narrative)

For each step, reconstruct a concise trace:
1. What was selected/typed (action + value)
2. Where the change appeared (bbox/diffMask, annotated image)
3. What changed (SSIM/diff, OCR text, ΔE color)
4. Deterministic verdict (and why)
5. Whether AI Judge was invoked; if yes, its verdict + confidence + reason
6. Final step status and any temporal notes

### Traceability Matrix Template (Markdown)

| Step | Action/Value | Region | Change Evidence | Deterministic | AI Judge | Final |
|------|---------------|--------|------------------|--------------|----------|-------|
| 4    | text_input "Max" | x=409,y=241,w=35,h=28 | OCR: found, 92%; SSIM: 0.981 | PASS (OCR strong) | — | PASS |

Use the fields above to fill the matrix per step. This provides an at‑a‑glance audit trail for a single TC.

