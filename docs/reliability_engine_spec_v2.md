# Reliability Engine 2.1 (Implementable Spec)
Version: 2.1
Date: 2026-03-19
Scope: POD automated QA engine in this repository

---

## 1) Goal and Reliability Target

Build a reliability layer that is:
- Explainable for QA and dev (no "all steps pass but case fails" confusion)
- Stable for scale testing across many products
- Conservative when evidence is weak

Operational target:
- Auto decision trust level in practice: 0.80 - 0.90
- Prefer `REVIEW` over risky auto PASS/FAIL when evidence is weak

Core principle:
- No single signal is absolute truth.
- Decision quality comes from weighted multi-signal evidence + confidence gating.

---

## 2) Current Gaps (From Existing System)

Observed in current code/report pipeline:
- Step has one `status` only; interaction and visual correctness are mixed.
- `-1` and technical errors can silently collapse into scoring noise.
- Completion can be penalized unfairly when diff is unavailable.
- OCR and color signals are not consistently mapped into scoring.
- Product-level consensus logic is not formally separated from "2 cases with different options."

This spec fixes those gaps with deterministic formulas and explicit fallback paths.

---

## 3) Step Output Contract (Mandatory)

Each step must emit these fields:

```json
{
  "step_id": 5,
  "step_key": "image_option|Choose Man Hair|0|Value_57",
  "group_type": "image_option",
  "interaction_status": "PASS",
  "visual_status": "PASS",
  "business_status": "N/A",
  "step_verdict": "PASS",
  "signals": {
    "diff": { "score": 0.49, "mask_quality": 0.82, "availability": "AVAILABLE" },
    "ocr": { "found": false, "confidence": "UNAVAILABLE", "text": "", "availability": "UNAVAILABLE" },
    "color": { "result": "ERROR", "fallback_used": true, "fallback_source": "ai_semantic", "availability": "AVAILABLE" },
    "ai": { "verdict": "PASS", "confidence": 0.91, "reason": "hair change detected", "availability": "AVAILABLE" },
    "temporal_impact": { "affected": false, "severity": "NONE", "penalty": 0 }
  },
  "status": "PASS"
}
```

Notes:
- Keep legacy `status` for backward compatibility in dashboard.
- New source of truth is `step_verdict`.

### 3.1 Valid Enums

- `interaction_status`: `PASS | WARNING | FAIL`
- `visual_status`: `PASS | WARNING | FAIL | UNAVAILABLE`
- `business_status`: `PASS | WARNING | FAIL | N/A`
- `step_verdict`: `PASS | WARNING | FAIL | UNAVAILABLE`
- `availability`: `AVAILABLE | UNAVAILABLE`

### 3.2 Step Verdict Truth Table (Deterministic)

Order matters:
1. If `interaction_status = FAIL` -> `step_verdict = FAIL`
2. Else if `business_status = FAIL` -> `step_verdict = FAIL`
3. Else if `visual_status = FAIL` -> `step_verdict = FAIL`
4. Else if `visual_status = UNAVAILABLE` -> `step_verdict = UNAVAILABLE`
5. Else if any of (`interaction_status`, `visual_status`, `business_status`) is `WARNING` -> `step_verdict = WARNING`
6. Else -> `step_verdict = PASS`

---

## 4) Signal Normalization Rules

Any sentinel or technical failure must be normalized before scoring.

Mandatory normalization:
- Any `-1` value -> `UNAVAILABLE`
- Parser/extractor errors -> `UNAVAILABLE`
- Empty signal payload (where required) -> `UNAVAILABLE`

Do not map technical failure to `0 score`.

### 4.1 Current-to-New Mapping

- `diff_score = -1` -> `signals.diff.availability = UNAVAILABLE`
- `color_evaluation.result = ERROR` -> fallback to AI/diff; if fallback not possible -> `UNAVAILABLE`
- Completion based on diff error -> completion signal `UNAVAILABLE`
- AI API error -> AI signal `UNAVAILABLE` and add reason code `AI_CALL_ERROR`

---

## 5) Run-Level Scoring

Each run outputs:
- `quality_score` (0..100)
- `confidence_score` (0..1)

### 5.1 Signal Weights (Default)

- `deterministic_visual`: 0.30
- `ai_semantic`: 0.25
- `ocr_text`: 0.15
- `color_match`: 0.10
- `completion`: 0.10
- `cart`: 0.10

If a signal is `UNAVAILABLE`, remove it from denominator and renormalize.

### 5.2 quality_score

Formula:

```text
quality_score = weighted_mean(available_signal_scores) - temporal_penalty
```

Clamp `quality_score` into [0, 100].

#### 5.2.1 OCR Scoring

- `found=true and confidence>=70` -> 100
- `found=true and 50<=confidence<70` -> 65
- `found=true and confidence<50`:
  - if AI PASS and diff PASS/WARNING -> 40
  - else -> 0
- `found=false` -> 0
- unavailable -> remove OCR from denominator

#### 5.2.2 Color Scoring

- direct PASS -> 100
- direct FAIL -> 0
- direct ERROR:
  - fallback PASS (AI/diff corroborated) -> 70
  - fallback FAIL -> 0
  - no fallback -> UNAVAILABLE

#### 5.2.3 Completion Scoring

- valid ratio r -> score = clamp(r * 100, 0, 100)
- unavailable ratio (from technical error) -> UNAVAILABLE

#### 5.2.4 Cart Scoring

- PASS -> 100
- FAIL -> hard-fail condition
- N/A -> UNAVAILABLE (remove from denominator)

### 5.3 Temporal Penalty

Group violations by `affectedStep`, penalty once per unique step:
- each unique HIGH -> -5
- cap total at -15
- any FATAL -> hard-fail (skip penalty path)

Formula:

```text
temporal_penalty = min(unique_high_affected_steps * 5, 15)
```

---

## 6) confidence_score

Formula:

```text
confidence_score = 0.35*coverage + 0.30*agreement + 0.25*stability + 0.10*pipeline_health
```

### 6.1 coverage

```text
coverage = sum(weight_i for AVAILABLE signals) / sum(all signal weights)
```

### 6.2 agreement

Compute pairwise agreement between available semantic outcomes.

Use pair score matrix:
- PASS vs PASS = 1.0
- FAIL vs FAIL = 1.0
- WARNING vs PASS = 0.5
- WARNING vs FAIL = 0.5
- WARNING vs WARNING = 0.6
- PASS vs FAIL = 0.0
- any pair with UNAVAILABLE = ignore pair

Then:

```text
agreement = sum(pair_scores) / max(number_of_pairs, 1)
```

If only one signal available:
- `agreement = 0.6`

### 6.3 stability

First run:

```text
stability_proxy = clamp(1 - (warning_steps + unavailable_steps) / max(total_steps_scored, 1), 0, 1)
```

Where:
- `total_steps_scored = count(step.group_type != "lifecycle")`
- `warning_steps = count(step.visual_status == "WARNING")`
- `unavailable_steps = count(step.visual_status == "UNAVAILABLE")`

Rerun (same input signature):

```text
observed_stability = 1 - changed_step_count / max(comparable_step_count, 1)
```

Use `observed_stability` if available, otherwise `stability_proxy`.

### 6.4 pipeline_health

Count deduplicated technical issues:
- `critical_errors` (diff parser fail, crop fail, blocking JS fail)
- `noncritical_errors` (recoverable extractor fail, transient API fail with fallback)

Formula:

```text
pipeline_health = 1 - min(critical_errors*0.12 + noncritical_errors*0.05, 1.0)
```

### 6.5 UNAVAILABLE Confidence Cap

If unavailable dominates evidence:

```text
if unavailable_weight_ratio > 0.50:
  confidence_score = min(confidence_score, 0.79)
```

This forces non-auto decision path.

---

## 7) Product-Level Consensus

Consensus applies across reruns of the SAME testcase input.

### 7.1 Test Input Signature (Required)

Use:

```text
test_input_signature = product_url + option_index + seed + data_profile_version
```

Only runs with same signature can be used in one consensus set.

### 7.2 Protocol

1. Run 1 and Run 2
2. If same decision candidate and both confidence >= 0.85 -> accept
3. Else run Run 3 (tie-breaker)
4. If Run 3 still low-confidence or no majority confidence -> `REVIEW`
5. Never rerun beyond 3

Hard stop rule:
- `max_runs_per_product = 3`
- if unresolved after run 3:
  - `decision = REVIEW`
  - `needs_human_review = true`
  - `reason_code = PERSISTENT_LOW_CONFIDENCE`

### 7.3 Consensus Aggregation

```text
consensus_quality = sum(q_i * c_i) / sum(c_i)
```

Decision vote weights:
- each run vote weight = `confidence_score`

```text
consensus_confidence = max(weight_by_decision) / sum(all_decision_weights)
```

### 7.4 Final Decision

- `PASS_AUTO` if:
  - `consensus_quality >= 85`
  - `consensus_confidence >= 0.85`
  - no hard-fail
  - no temporal FATAL
- `FAIL_AUTO` if:
  - `consensus_quality < 70 and consensus_confidence >= 0.85`
  - OR hard-fail exists
- otherwise `REVIEW`

Hard-fail conditions:
- add to cart failed
- preview load failed
- temporal FATAL
- blocking JS error breaks cart/preview flow

---

## 8) Force REVIEW from History

Window:
- 5 latest runs for same product/testcase signature
- evaluate only auto decisions (`PASS_AUTO`, `FAIL_AUTO`)

Formula:

```text
disagreement_rate = min(pass_auto_count, fail_auto_count) / max(pass_auto_count + fail_auto_count, 1)
```

Trigger:
- `auto_count >= 4` and `disagreement_rate > 0.30`
- then next run forced to `REVIEW`

Reset:
- after 2 consecutive human confirmations with same final conclusion

---

## 9) KPI (No External Ground Truth Required)

Primary KPIs:
- `auto_decision_stability >= 90%`
- `review_rate in [20%, 35%]`
- `unavailable_signal_rate <= 10%`
- `cross_run_consistency >= 90%` (24h window)

Confidence medians:
- `median_confidence(PASS_AUTO) >= 0.87`
- `median_confidence(FAIL_AUTO) >= 0.85`
- no threshold for `REVIEW`

---

## 10) Integration Plan for This Repository

### 10.1 Phase A: Data Contract and Compatibility

Files:
- `src/cli.js`
- `src/actions/customizer.js`
- `src/utils/reporter.js`
- `web/js/dashboard.js`

Tasks:
- Add new step fields (`interaction_status`, `visual_status`, `business_status`, `step_verdict`, `signals`).
- Keep legacy `status` populated from `step_verdict` for old UI compatibility.
- Add `decision_reason_codes` array at run/case level.

### 10.2 Phase B: Scoring Engine

Files:
- `src/utils/reporter.js`
- `src/validators/completion-checker.js`

Tasks:
- Implement `UNAVAILABLE`-aware weighted scoring.
- Add deterministic formulas from Section 5 and 6.
- Ensure completion UNAVAILABLE does not become negative penalty.

### 10.3 Phase C: Consensus and Rerun Orchestrator

Files:
- `src/cli.js`
- `src/server.js` (if orchestrated via API)

Tasks:
- Add run signature and consensus grouping.
- Implement max 3 runs and tie-break stop rule.
- Persist consensus output in report JSON and DB report content.

### 10.4 Phase D: History and Force REVIEW

Files:
- `src/repository.js`
- `src/server.js`

Tasks:
- Query previous runs by signature.
- Compute disagreement_rate and enforce force-review rule.

---

## 11) Report Schema Additions (Case Level)

```json
{
  "quality_score": 87.3,
  "confidence_score": 0.89,
  "decision": "PASS_AUTO",
  "decision_reason_codes": ["HIGH_COVERAGE", "HIGH_AGREEMENT"],
  "consensus": {
    "runs_used": 2,
    "consensus_quality": 86.4,
    "consensus_confidence": 0.91
  }
}
```

---

## 12) Non-Negotiable Safeguards

- Never auto-pass when confidence is capped by unavailable dominance.
- Never rerun beyond 3 attempts.
- Never hide unavailable/error as zero-score.
- Every PASS_AUTO and FAIL_AUTO must include reason codes.

---

## 13) Implementation Checklist

- [ ] Step contract fields added and emitted
- [ ] Legacy `status` compatibility maintained
- [ ] UNAVAILABLE normalization implemented
- [ ] quality_score and confidence_score formulas implemented
- [ ] consensus protocol (2 + tie-break 3) implemented
- [ ] persistent low-confidence stop rule implemented
- [ ] disagreement-based force-review implemented
- [ ] dashboard supports new fields without breaking old reports
- [ ] KPI metrics materialized per product and globally
- [ ] integration tests for PASS_AUTO / FAIL_AUTO / REVIEW paths

---

## 14) Color Selection Policy (Dark Color Avoidance)

To improve visual difference signals and avoid false negatives on black backgrounds/products, the engine follows an "anti-black" selection policy.

### 14.1 Preference Logic

1.  **Prioritize Bright Colors**: Options with light/vibrant colors (Red, Blue, White, Silver, etc.) are chosen first.
2.  **Deprioritize Dark Colors**: Options are considered "Dark" if:
    -   The `option_color_hex` is black (`#000000`) or near-black (`#111111`, `#222222`).
    -   The title contains "Black", "Dark", "Navy", or "Deep".
3.  **Last Resort**: Dark colors are only selected if no other valid options remain.
4.  **Logging**: Every selection must include a `selection_reason` field documented in the step details.

### 14.2 Adaptive Settle Time

Because dark-on-dark changes are harder to detect, when a dark option is selected, the engine MUST add an additional `settle_timeout` (typically +1000ms) to ensure the render is fully stable before capture.

---

## 15) AI Final Review - Structured Commentaries

Starting from Version 2.2, AI Final Review moves away from "Bounding Box" detection to "Human-like Reviewer commentary."

### 15.1 Prompt Focus

The AI acts as a **Senior Visual QA Reviewer**, assessing the final product preview against cumulative user choices.

### 15.2 Output Schema (JSON)

```json
{
  "summary": "High level assessment of the final result.",
  "strengths": ["List of things that are correct and visually pleasing."],
  "issues": ["List of detected visual bugs, misalignment, or color mismatches."],
  "raw_image_description": "Objective, literal description of the image content for debugging.",
  "layout_notes": ["Specific commentary on positioning and overlap."],
  "color_notes": ["Specific commentary on color accuracy and contrast."],
  "content_notes": ["Commentary on text/graphic content accuracy."],
  "recommendations": ["Improvement suggestions for the merchant/customer."],
  "ai_verdict": "PASS | FAIL",
  "confidence": 0.0..1.0
}
```

### 15.3 Elimination of Annotated Images

- No more `_final_annotated.png`.
- Final review evidence uses the clean, full-resolution final preview capture.
- Dashboard renders the structured JSON text instead of overlaying boxes.

---

This spec is designed to be code-ready for this repository, with conservative auto decisions and explicit review gating to keep practical trust near 80-90%.
