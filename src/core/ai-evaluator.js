/**
 * AI Evaluator Module — v2.0 (Prompt Engineering Overhaul)
 *
 * CHANGES vs v1:
 *  [P1] Prompt Engineering — tất cả prompt viết lại thành clear natural language,
 *       bỏ JSON.stringify(systemPrompt), thêm POD-specific style-mismatch warning.
 *
 *  [P2] Multi-signal Voting — code signal (OCR/color) + AI signal kết hợp,
 *       FAIL chỉ xác nhận khi có ≥2 tín hiệu đồng thuận.
 *
 *  [P3] Tiered Model Strategy — gpt-4o-mini cho simple steps,
 *       gpt-4o cho image_option conflict & final review.
 *
 *  [P4] Budget Exhausted Fix — không auto-PASS khi hết budget,
 *       trả SKIP + fallback code signal thay thế.
 *
 *  [P5] text_input Image Prep — upscale + sharpen thay vì downscale,
 *       giữ readability cho chữ nhỏ.
 *
 *  [P6] suspiciousCrop — thêm minSize guard, không loại bỏ crop hợp lệ.
 *
 *  [P7] Final Review — prompt rõ ràng hơn, system prompt tách khỏi JSON.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Model tiers ────────────────────────────────────────────────────────────
const MODEL_FAST  = 'gpt-4o-mini';          // Đơn giản, budget thấp
const MODEL_SMART = process.env.FINAL_REVIEW_MODEL || 'gpt-4o';  // Phức tạp, final
const TIER2_ESCALATE_CONFIDENCE = parseFloat(process.env.TRIAGE_TIER2_ESCALATE_CONFIDENCE || '0.75');
const TIER2_FAIL_CONFIDENCE = parseFloat(process.env.TRIAGE_TIER2_FAIL_CONFIDENCE || '0.85');

// ─── Prompt templates (POD-tuned) ───────────────────────────────────────────

/**
 * System prompt dùng chung cho step evaluation.
 * Key insight: nói rõ style-mismatch là EXPECTED để tránh false-negative.
 */
const SYSTEM_STEP_EVAL = `You are a Visual QA Inspector for Print-on-Demand (POD) product previews.

YOUR ROLE:
Verify that a customer's customization was correctly applied to a product mockup.

CRITICAL POD CONTEXT — READ BEFORE JUDGING:
- Product previews use cartoon/illustration art style.
- Option thumbnails use flat icon/graphic art style.
- These TWO different art styles represent the SAME concept.
- Style difference between thumbnail and preview is EXPECTED and is NOT a defect.
- Do NOT compare shapes pixel-for-pixel. Compare CONCEPTS and INTENT.

VERDICT RULES:
- PASS  → Change is visible and consistent with the expected customization.
- FAIL  → Change is clearly and obviously ABSENT. Confidence must be ≥ 0.85 to FAIL.
- WARNING → Change appears partially applied or ambiguous. Confidence < 0.85.

RESPONSE FORMAT:
Return ONLY a valid JSON object. No markdown. No explanation outside JSON.
{
  "verdict": "PASS" | "FAIL" | "WARNING",
  "confidence": <float 0.0–1.0>,
  "reason": "<concise explanation, max 2 sentences>",
  "bbox_correct": <boolean>,
  "code_results_confirmed": <boolean>
}`;

/**
 * System prompt cho final preview review.
 */
const SYSTEM_FINAL_REVIEW = `You are a Senior Visual QA Reviewer for Print-on-Demand products.

YOUR ROLE:
Evaluate the final product preview as a human customer would — checking that all
requested customizations are present, correctly rendered, and visually acceptable.

JUDGMENT STANDARD:
- Act as a quality-conscious customer, not a pixel-perfect machine.
- Minor artistic/style differences between mockup styles are acceptable.
- FAIL only on clear, obvious errors: missing text, wrong color area, broken canvas,
  completely wrong graphic, or unreadable personalization.

RESPONSE FORMAT:
Return ONLY a valid JSON object. No markdown fences. No extra keys.
{
  "summary": "<1–2 sentence overall assessment>",
  "strengths": ["<item>"],
  "issues": ["<item>"],
  "layout_notes": ["<item>"],
  "color_notes": ["<item>"],
  "content_notes": ["<item>"],
  "ai_verdict": "PASS" | "FAIL",
  "confidence": <float 0.0–1.0>
}`;

const SYSTEM_FINAL_REVIEW_LIGHT = `You are a lightweight POD preview triage validator.
You must answer with strict JSON only, no markdown.
Judge only what is visible in provided cropped zones.
If uncertain, set confidence low and add "NEED_DEEP_REVIEW" in flags.
{
  "pass": <boolean>,
  "textVisible": <boolean>,
  "textCorrect": <boolean>,
  "colorMatch": <boolean>,
  "confidence": <float 0.0-1.0>,
  "issues": ["<short issue>"],
  "flags": ["<flag>"]
}`;

const SYSTEM_FINAL_REVIEW_DEEP = `You are a senior POD QA reviewer.
Return strict JSON only. No markdown and no extra explanation.
Focus on missing/incorrect customizations, placement defects, unreadable text, and rendering artifacts.
{
  "summary": "<short summary>",
  "pass": <boolean>,
  "confidence": <float 0.0-1.0>,
  "issues": ["<short issue>"],
  "flags": ["<flag>"]
}`;

/**
 * System prompt cho cart verification.
 */
const SYSTEM_CART = `You are a QA validator for e-commerce cart confirmation flows.
Determine if "Add to Cart" succeeded based on the provided screenshot evidence.
Return ONLY valid JSON: { "ai_score": <0–100>, "ai_verdict": "PASS"|"FAIL", "ai_reason": "<reason>" }`;

/**
 * System prompt cho interaction verification.
 */
const SYSTEM_INTERACTION = `You are a UI QA validator for POD customization interfaces.
Determine if the UI interaction produced the expected result.
Return ONLY valid JSON: { "ai_score": <0–100>, "ai_verdict": "PASS"|"FAIL", "ai_reason": "<reason>" }`;

// ─── Main class ──────────────────────────────────────────────────────────────

class AiEvaluator {
    constructor(apiKey, generalAiEnabled = true) {
        this.apiKey           = apiKey;
        this.generalAiEnabled = generalAiEnabled && !!apiKey;
        this.enabled          = this.generalAiEnabled;
        this.client           = null;
        this.usage            = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };

        // Budget constraints
        this.MAX_TOKENS_PER_SESSION = 150_000;
        this.MAX_CALLS_PER_SESSION  = 6;
        this.budgetExhausted        = false;
    }

    // ── Init ────────────────────────────────────────────────────────────────

    async init() {
        if (!this.generalAiEnabled) return;
        try {
            const { OpenAI } = require('openai');
            this.client = new OpenAI({ apiKey: this.apiKey });
        } catch (err) {
            console.warn('[WARN] AiEvaluator: Failed to init openai:', err.message);
            this.enabled = this.generalAiEnabled = false;
        }
    }

    // ── Budget tracking ─────────────────────────────────────────────────────

    _trackUsage(usage) {
        if (!usage) return;
        this.usage.prompt_tokens     += usage.prompt_tokens     || 0;
        this.usage.completion_tokens += usage.completion_tokens || 0;
        this.usage.total_tokens      += usage.total_tokens      || 0;
        this.usage.calls++;

        const over = this.usage.total_tokens > this.MAX_TOKENS_PER_SESSION
                  || this.usage.calls        > this.MAX_CALLS_PER_SESSION;

        if (over && !this.budgetExhausted) {
            console.warn(`      [AI BUDGET] 🚨 Budget exceeded (${this.usage.total_tokens} tokens, ${this.usage.calls} calls). Switching to code-signal fallback.`);
            this.budgetExhausted = true;
        }

        console.log(`      [AI USAGE] #${this.usage.calls}: ${usage.total_tokens} tokens (Total: ${this.usage.total_tokens}${this.budgetExhausted ? ' !!BUDGET EXCEEDED!!' : ''})`);
    }

    // ── [P2] Code signal derivation ─────────────────────────────────────────

    /**
     * Lấy verdict từ OCR / color check — không cần AI call.
     * @param {object} verifyResults
     * @returns {'PASS'|'FAIL'|'UNKNOWN'}
     */
    _deriveCodeSignal(verifyResults) {
        const res = verifyResults?.results || {};

        if (res.ocr) {
            if (!res.ocr.pass) return 'FAIL';   // OCR đọc được chữ sai
        }
        if (res.color) {
            // Distance > 30 mới tính là fail thực sự (tránh minor color shift)
            if (!res.color.pass && res.color.distance > 30) return 'FAIL';
        }
        // Nếu cả hai đều pass hoặc không có dữ liệu
        if (res.ocr?.pass || res.color?.pass) return 'PASS';
        return 'UNKNOWN';
    }

    /**
     * [P2] Multi-signal voting: kết hợp code signal + AI signal.
     * FAIL chỉ confirm khi tổng weight FAIL ≥ 2.
     */
    _resolveVoting(codeSignal, aiVerdict, aiConfidence) {
        const weighted = { PASS: 0, FAIL: 0, WARNING: 0, UNKNOWN: 0 };

        // Code signal weight = 2 (deterministic, tin cậy cao)
        if (codeSignal !== 'UNKNOWN') {
            weighted[codeSignal] = (weighted[codeSignal] || 0) + 2;
        }

        // AI signal: downgrade FAIL→WARNING nếu confidence thấp
        let effectiveAiVerdict = aiVerdict;
        if (aiVerdict === 'FAIL' && aiConfidence < 0.85) {
            effectiveAiVerdict = 'WARNING';
            console.log(`      [VOTING] AI FAIL downgraded to WARNING (confidence=${aiConfidence} < 0.85)`);
        }
        weighted[effectiveAiVerdict] = (weighted[effectiveAiVerdict] || 0) + 1;

        console.log(`      [VOTING] code=${codeSignal}(w=2) ai=${effectiveAiVerdict}(w=1) → weights:`, weighted);

        if (weighted.FAIL >= 2)    return 'FAIL';
        if (weighted.WARNING >= 1 && weighted.PASS === 0) return 'WARNING';
        return 'PASS';
    }

    // ── [P3] Model selection ────────────────────────────────────────────────

    /**
     * Chọn model dựa trên độ phức tạp của step và tình trạng conflict.
     */
    _selectModel(step, verifyResults) {
        const hasConflict = verifyResults?.results?.ocr?.pass   === false
                         || verifyResults?.results?.color?.pass === false;

        // image_option luôn cần model tốt hơn (thumbnail comparison phức tạp)
        if (step?.group_type === 'image_option' || hasConflict) {
            return MODEL_SMART;
        }
        return MODEL_FAST;
    }

    // ── Image prep helpers ──────────────────────────────────────────────────

    async _prepareImage(sharp, filePath, options = {}) {
        const {
            width      = 512,
            quality    = 80,
            upscale    = false,
            sharpenIt  = false,
            removeAlpha= true,
        } = options;

        let pipeline = sharp(filePath).resize({ width, withoutEnlargement: !upscale });
        if (removeAlpha) pipeline = pipeline.removeAlpha();
        if (sharpenIt)   pipeline = pipeline.sharpen();
        pipeline = pipeline.jpeg({ quality });

        return pipeline.toBuffer();
    }

    async _prepareBuffer(sharp, buf, options = {}) {
        const { width = 256, quality = 85 } = options;
        return sharp(buf)
            .resize({ width, withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();
    }

    _clamp01(value, fallback = 0) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(1, n));
    }

    _isPassStatus(status) {
        return String(status || '').toUpperCase() === 'PASS';
    }

    _getUsageSnapshot() {
        return { ...this.usage };
    }

    _getUsageDelta(before) {
        return {
            prompt_tokens: Math.max(0, (this.usage.prompt_tokens || 0) - (before?.prompt_tokens || 0)),
            completion_tokens: Math.max(0, (this.usage.completion_tokens || 0) - (before?.completion_tokens || 0)),
            total_tokens: Math.max(0, (this.usage.total_tokens || 0) - (before?.total_tokens || 0)),
            calls: Math.max(0, (this.usage.calls || 0) - (before?.calls || 0)),
        };
    }

    _collectFinalCustomizationSteps(caseReport = {}) {
        const validTypes = new Set(['image_option', 'text_input', 'file_upload', 'dropdown', 'color_option']);
        return (caseReport.timeline || []).filter((s) => validTypes.has(String(s.group_type || '')) && !s.context_transition);
    }

    _buildFinalTriageSignals(caseReport = {}, triageContext = {}) {
        const steps = this._collectFinalCustomizationSteps(caseReport);
        const errorSummary = triageContext.errorSummary || {};
        const previewResult = triageContext.previewResult || {};
        const cartResult = triageContext.cartResult || {};
        const cartEvidence = triageContext.cartEvidence || {};

        const jsErrors = Number(errorSummary.totalJsErrors ?? caseReport.final_evaluation?.js_errors ?? 0) || 0;
        const networkErrors = Array.isArray(errorSummary.networkErrors) ? errorSummary.networkErrors : [];
        const http5xx = networkErrors.filter((e) => Number(e?.status) >= 500).length;
        const canvasBlank = previewResult.error === 'CANVAS_CRASH';
        const previewInvalid = previewResult.valid === false;
        const cartImageMissing = cartEvidence && cartEvidence.captured === false;
        const cartFailed = cartResult && cartResult.success === false;
        const hasFatalTemporal = Array.isArray(triageContext.temporalViolations)
            && triageContext.temporalViolations.some((v) => String(v?.severity || '').toUpperCase() === 'FATAL');

        const ssimValues = steps
            .map((s) => Number(s.ssim_score))
            .filter((v) => Number.isFinite(v));
        const minSsim = ssimValues.length ? Math.min(...ssimValues) : null;

        const ocrSteps = steps.filter((s) => s.group_type === 'text_input' && s.ocr_evaluation);
        const ocrMatch = ocrSteps.length > 0 ? ocrSteps.every((s) => Boolean(s.ocr_evaluation?.found)) : null;

        const colorSteps = steps.filter((s) => {
            const result = String(s.color_evaluation?.result || '').toUpperCase();
            return result && !['SKIPPED', 'UNAVAILABLE', 'ERROR'].includes(result);
        });
        const colorMatch = colorSteps.length > 0
            ? colorSteps.every((s) => String(s.color_evaluation?.result || '').toUpperCase() === 'PASS')
            : null;

        const completionRatio = Number(
            triageContext.completionResult?.completionRatio
            ?? caseReport.completion_result?.completionRatio
        );
        const reliabilityScore = Number(
            triageContext.reliabilityData?.quality_score
            ?? caseReport.quality_score
        );
        const allStepsPass = steps.length > 0 && steps.every((s) => this._isPassStatus(s.status) || this._isPassStatus(s.validation_status));
        const decorativeFontRisk = steps.some((s) => s.group_type === 'text_input' && s.ocr_evaluation && !s.ocr_evaluation.found);

        return {
            stepsCount: steps.length,
            jsErrors,
            http5xx,
            canvasBlank,
            previewInvalid,
            cartImageMissing,
            cartFailed,
            hasFatalTemporal,
            minSsim,
            ocrMatch,
            colorMatch,
            completionRatio: Number.isFinite(completionRatio) ? completionRatio : null,
            reliabilityScore: Number.isFinite(reliabilityScore) ? reliabilityScore : null,
            allStepsPass,
            decorativeFontRisk,
        };
    }

    _runDeterministicTier(signals = {}) {
        const failReasons = [];
        if (signals.canvasBlank) failReasons.push('CANVAS_CRASH');
        if (signals.previewInvalid) failReasons.push('PREVIEW_INVALID');
        if ((signals.http5xx || 0) > 0) failReasons.push('HTTP_5XX');
        if ((signals.jsErrors || 0) > 0) failReasons.push('JS_ERROR');
        if (signals.cartImageMissing) failReasons.push('CART_EVIDENCE_MISSING');
        if (signals.cartFailed) failReasons.push('ADD_TO_CART_FAIL');
        if (signals.hasFatalTemporal) failReasons.push('TEMPORAL_FATAL');
        if (Number.isFinite(signals.minSsim) && signals.minSsim < 0.5) failReasons.push('SSIM_BELOW_0_5');

        if (failReasons.length > 0) {
            return {
                resolved: true,
                verdict: 'FAIL',
                confidence: 1,
                summary: `Deterministic gate failed: ${failReasons.join(', ')}`,
                issues: failReasons.map((code) => `Deterministic failure: ${code}`),
                flags: failReasons,
                triage_path: ['T1_DETERMINISTIC_FAIL'],
            };
        }

        const strictSsimPass = Number.isFinite(signals.minSsim) && signals.minSsim > 0.995;
        const textColorPass = signals.ocrMatch === true && (signals.colorMatch === true || signals.colorMatch === null);
        const highQualityPass = Number.isFinite(signals.reliabilityScore) && signals.reliabilityScore >= 95;
        const completionPass = signals.completionRatio === null || signals.completionRatio >= 0.95;
        const noInfraRisk = (signals.jsErrors || 0) === 0 && (signals.http5xx || 0) === 0 && !signals.previewInvalid;

        if (signals.allStepsPass && completionPass && noInfraRisk && (strictSsimPass || textColorPass || highQualityPass)) {
            return {
                resolved: true,
                verdict: 'PASS',
                confidence: 1,
                summary: 'Deterministic checks confirm the preview is valid without AI escalation.',
                issues: [],
                flags: ['T1_AUTO_PASS'],
                triage_path: ['T1_DETERMINISTIC_PASS'],
            };
        }

        return {
            resolved: false,
            verdict: 'REVIEW',
            confidence: 0,
            summary: 'Deterministic checks are inconclusive.',
            issues: [],
            flags: ['T1_INCONCLUSIVE'],
            triage_path: ['T1_INCONCLUSIVE'],
        };
    }

    _collectReviewZones(caseReport = {}, maxZones = 4) {
        const steps = this._collectFinalCustomizationSteps(caseReport);
        const zones = [];

        for (const step of steps) {
            const mask = step.diffMask || step.bbox;
            if (!mask) continue;
            const x = Math.max(0, Math.floor(Number(mask.x) || 0));
            const y = Math.max(0, Math.floor(Number(mask.y) || 0));
            const w = Math.max(0, Math.floor(Number(mask.w) || 0));
            const h = Math.max(0, Math.floor(Number(mask.h) || 0));
            if (w < 6 || h < 6) continue;

            zones.push({
                name: String(step.name || step.action || 'Customization'),
                type: String(step.group_type || 'unknown'),
                expected: String(step.value_chosen || ''),
                bbox: { x, y, w, h },
            });
        }

        return zones.slice(-maxZones);
    }

    async _buildZoneImages(previewPath, zones, options = {}) {
        const sharp = require('sharp');
        const {
            maxWidth = 512,
            quality = 75,
            detail = 'low',
        } = options;

        if (!Array.isArray(zones) || zones.length === 0) return [];
        const meta = await sharp(previewPath).metadata();
        const maxW = Number(meta?.width) || 0;
        const maxH = Number(meta?.height) || 0;
        if (maxW <= 0 || maxH <= 0) return [];

        const results = [];
        for (const zone of zones) {
            const x = Math.max(0, Math.min(maxW - 1, Number(zone?.bbox?.x) || 0));
            const y = Math.max(0, Math.min(maxH - 1, Number(zone?.bbox?.y) || 0));
            const w = Math.max(1, Math.min(maxW - x, Number(zone?.bbox?.w) || 1));
            const h = Math.max(1, Math.min(maxH - y, Number(zone?.bbox?.h) || 1));
            if (w < 2 || h < 2) continue;

            const crop = await sharp(previewPath)
                .extract({ left: x, top: y, width: w, height: h })
                .resize({ width: maxWidth, withoutEnlargement: true })
                .jpeg({ quality })
                .toBuffer();

            results.push({
                zone,
                detail,
                base64: crop.toString('base64'),
            });
        }
        return results;
    }

    _buildActionLines(caseReport = {}) {
        return (caseReport.timeline || [])
            .filter((s) => !s.is_menu_opener && s.group_type !== 'lifecycle' && s.value_chosen)
            .map((s) => {
                if (s.group_type === 'image_option') return `- [Graphic] "${s.name}" => "${s.value_chosen}"`;
                if (s.group_type === 'text_input') return `- [Text] "${s.name}" => "${s.value_chosen}"`;
                if (s.group_type === 'color_option') return `- [Color] "${s.name}" => "${s.value_chosen}"`;
                return `- [${s.group_type || s.action}] "${s.name}" => "${s.value_chosen}"`;
            })
            .join('\n');
    }

    _toFinalReviewPayload({
        verdict = 'ERROR',
        summary = '',
        issues = [],
        confidence = 0,
        tier = null,
        triagePath = [],
        flags = [],
        tokensUsed = null,
    } = {}) {
        return {
            summary: summary || '',
            strengths: verdict === 'PASS' ? ['Customization validation passed.'] : [],
            issues: Array.isArray(issues) ? issues : [],
            layout_notes: [],
            color_notes: [],
            content_notes: [],
            recommendations: [],
            ai_verdict: verdict,
            confidence: this._clamp01(confidence, 0),
            ai_reason: summary || (Array.isArray(issues) ? issues[0] : '') || 'No summary',
            triage_tier: tier,
            triage_path: triagePath,
            flags: Array.isArray(flags) ? flags : [],
            tokens_used: tokensUsed || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 },
        };
    }

    // ── evaluateStep ────────────────────────────────────────────────────────

    async evaluateStep(beforePath, afterPath, optionName, valueChosen, diffMask = null, groupType = null, optionThumbnail = null) {
        if (!this.generalAiEnabled || !this.client) return this.getDisabledResult();
        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return { ai_score: -1, ai_verdict: 'SKIP', ai_reason: 'Screenshot files not found.' };
        }

        try {
            const sharp = require('sharp');
            let beforeBuffer, afterBuffer;

            // Crop khi có diffMask hợp lệ
            if (diffMask && diffMask.w > 0 && diffMask.h > 0) {
                try {
                    const meta  = await sharp(beforePath).metadata();
                    const left  = Math.max(0, Math.floor(diffMask.x));
                    const top   = Math.max(0, Math.floor(diffMask.y));
                    const width = Math.min(meta.width  - left, Math.ceil(diffMask.w));
                    const height= Math.min(meta.height - top,  Math.ceil(diffMask.h));

                    if (width > 0 && height > 0) {
                        const extract = { left, top, width, height };
                        beforeBuffer = await sharp(beforePath).extract(extract).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
                        afterBuffer  = await sharp(afterPath) .extract(extract).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
                    }
                } catch (e) {
                    console.warn(`    ⚠️ AI Step Isolation failed: ${e.message}`);
                }
            }

            // Fallback: full screenshot nhỏ hơn
            if (!beforeBuffer || !afterBuffer) {
                beforeBuffer = await this._prepareImage(sharp, beforePath, { width: 512, quality: 80 });
                afterBuffer  = await this._prepareImage(sharp, afterPath,  { width: 512, quality: 80 });
            }

            const isGenericValue = (valueChosen || '').startsWith('Value ');
            const displayValue   = isGenericValue ? `"${optionName}" graphic` : `"${valueChosen}"`;
            const hasCrop        = !!(diffMask && diffMask.w > 0);

            // ── User prompt: rõ ràng, POD-specific ──
            const userText = groupType === 'image_option'
                ? `CUSTOMIZATION: Option "${optionName}" → ${displayValue}

${hasCrop ? 'You are viewing a CROPPED ZONE where the change should appear.' : 'You are viewing FULL screenshots. Scan for evidence of the change anywhere in the image.'}

TASK: Does the AFTER image show a visual change consistent with applying "${displayValue}"?
Remember: cartoon preview vs flat icon thumbnail — style difference is EXPECTED.
Judge by concept match, not art style match.`
                : `CUSTOMIZATION: Selected "${optionName}" = ${displayValue}

${hasCrop ? 'You are viewing a CROPPED ZONE.' : 'You are viewing FULL screenshots.'}

TASK: Is "${displayValue}" visible and correctly applied in the AFTER image?`;

            const imageContent = [
                { type: 'text',      text: 'IMAGE 1 — BEFORE:' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${beforeBuffer.toString('base64')}`, detail: 'low' } },
                { type: 'text',      text: 'IMAGE 2 — AFTER:' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${afterBuffer.toString('base64')}`,  detail: 'low' } },
            ];

            if (groupType === 'image_option' && optionThumbnail) {
                imageContent.push({ type: 'text',      text: 'REFERENCE THUMBNAIL (flat icon style — concept reference only, do NOT compare art style):' });
                imageContent.push({ type: 'image_url', image_url: { url: optionThumbnail, detail: 'low' } });
            }

            const response = await this.client.chat.completions.create({
                model:           MODEL_FAST,
                response_format: { type: 'json_object' },
                temperature:     0.1,
                messages: [
                    { role: 'system', content: SYSTEM_STEP_EVAL },
                    { role: 'user',   content: [{ type: 'text', text: userText }, ...imageContent] },
                ],
            });

            return this.parseAiResponse(response.choices[0].message.content);

        } catch (err) {
            return { ai_score: -1, ai_verdict: 'ERROR', ai_reason: `API call failed: ${err.message}` };
        }
    }

    // ── evaluateStepWithContext ─────────────────────────────────────────────

    /**
     * [P4] Budget fix: SKIP + code fallback thay vì auto-PASS.
     * [P1] Prompt engineering: clear, structured, POD-aware.
     * [P2] Voting: code signal + AI signal.
     * [P3] Tiered model.
     * [P5] text_input: upscale + sharpen.
     * [P6] suspiciousCrop: thêm minSize guard.
     */
    async evaluateStepWithContext(step, previewPath, bbox, verifyResults) {
        if (!this.generalAiEnabled || !this.client) {
            return { verdict: 'DISABLED', reason: 'AI evaluation disabled', confidence: 0 };
        }

        // [P4] Budget fix — SKIP thay vì auto-PASS
        if (this.budgetExhausted) {
            const fallback = this._deriveCodeSignal(verifyResults);
            return {
                verdict:          fallback === 'UNKNOWN' ? 'SKIP' : fallback,
                reason:           `AI budget exhausted — code signal fallback: ${fallback}`,
                confidence:       fallback === 'UNKNOWN' ? 0 : 0.7,
                skipped_budget:   true,
                fallback_verdict: fallback,
            };
        }

        try {
            const sharp  = require('sharp');
            const axios  = require('axios');

            // ── [P6] suspiciousCrop: thêm minSize guard ──
            const bboxArea     = Math.max(0, (bbox?.w || 0) * (bbox?.h || 0));
            const diffMaskArea = Math.max(0, (step?.diffMask?.w || 0) * (step?.diffMask?.h || 0));
            const cropTooSmall = bboxArea < 400; // < ~20×20px — quá nhỏ để có ý nghĩa
            const suspiciousCrop = step.group_type === 'image_option'
                && bboxArea > 0
                && diffMaskArea > 0
                && (bboxArea / diffMaskArea) < 0.08
                && !cropTooSmall;  // guard: nếu bbox nhỏ nhưng hợp lệ thì không đánh suspicious

            const hasCrop = verifyResults.croppedPath
                         && fs.existsSync(verifyResults.croppedPath)
                         && !suspiciousCrop;

            // ── Full preview ──
            const fullPreviewBuffer = await sharp(previewPath)
                .resize({ width: 400, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            // ── Cropped zone ──
            let croppedZoneBuffer = null;
            if (hasCrop) {
                try {
                    // [P5] text_input: upscale + sharpen
                    if (step.group_type === 'text_input') {
                        croppedZoneBuffer = await sharp(verifyResults.croppedPath)
                            .resize({ width: 512, withoutEnlargement: false })
                            .sharpen()
                            .jpeg({ quality: 95 })
                            .toBuffer();
                    } else {
                        croppedZoneBuffer = await sharp(verifyResults.croppedPath)
                            .resize({ width: 256, withoutEnlargement: true })
                            .jpeg({ quality: 85 })
                            .toBuffer();
                    }
                } catch (e) {
                    console.warn(`    [AI] Failed to process cropped zone: ${e.message}`);
                }
            }

            // ── Thumbnail ──
            let thumbnailBuffer = null;
            if (step.option_thumbnail && step.group_type === 'image_option') {
                try {
                    const res = await axios.get(step.option_thumbnail, { responseType: 'arraybuffer' });
                    thumbnailBuffer = await sharp(Buffer.from(res.data))
                        .resize({ width: 128, withoutEnlargement: true })
                        .jpeg({ quality: 85 })
                        .toBuffer();
                } catch (e) {
                    console.warn(`    [AI] Failed to fetch thumbnail: ${e.message}`);
                }
            }

            // ── Code context ──
            const codeContext = this.buildCodeContext(verifyResults, bbox);

            // ── [P1] User prompt: structured, POD-aware, per group_type ──
            const noCropNote = !hasCrop
                ? `\nNO CROP AVAILABLE — you are seeing the FULL product preview.
Scan the FULL image for evidence that "${step.value_chosen}" was applied.
Only FAIL if the change is clearly and obviously absent (confidence ≥ 0.85 required to FAIL).`
                : '';

            let taskInstruction = '';
            if (step.group_type === 'image_option') {
                taskInstruction = hasCrop
                    ? `Does the CROPPED ZONE show a graphic/icon/symbol that represents "${step.value_chosen}"?
Remember: cartoon preview style vs flat thumbnail style — concept match is sufficient, NOT art style match.`
                    : `Look at the FULL PREVIEW for evidence that "${step.value_chosen}" was applied
(e.g. beard added, hair color changed, specific graphic appeared on product).
Use context clues — compare semantic meaning, not exact shapes.`;
            } else if (step.group_type === 'text_input') {
                taskInstruction = `Is the text "${step.value_chosen}" clearly visible and legible on the product preview?
Check the ${hasCrop ? 'CROPPED ZONE' : 'FULL PREVIEW'} carefully for this exact text.`;
            } else if (step.group_type === 'color_option') {
                taskInstruction = `Has the color changed to match "${step.value_chosen}" as expected?
Focus on the ${hasCrop ? 'CROPPED COLOR AREA' : 'color-relevant regions in the FULL PREVIEW'}.`;
            } else {
                taskInstruction = `Has the customization "${step.name}" = "${step.value_chosen}" been applied correctly?`;
            }

            const userText = `=== STEP INFORMATION ===
Step Name: "${step.name}"
Type: ${step.group_type}
Expected Value: "${step.value_chosen}"
Suspicious crop fallback: ${suspiciousCrop ? 'yes (crop area disproportionately small)' : 'no'}
${noCropNote}

=== CODE VERIFICATION RESULTS ===
${codeContext}

=== YOUR TASK ===
1. ${taskInstruction}
2. Confirm or dispute the code verification results based on visual evidence.
3. If visuals clearly show the customization is present → PASS, even if code tools failed.
4. Only FAIL if visuals clearly contradict the expected value.${!hasCrop ? '\n   (Requires confidence ≥ 0.85 to FAIL when no crop is available.)' : ''}`;

            // ── Build message content ──
            const contentParts = [
                { type: 'text',      text: userText },
                { type: 'text',      text: 'IMAGE 1 — FULL PRODUCT PREVIEW:' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fullPreviewBuffer.toString('base64')}`, detail: 'low' } },
            ];

            if (croppedZoneBuffer) {
                contentParts.push({ type: 'text',      text: 'IMAGE 2 — CROPPED ZONE (area where change should appear):' });
                contentParts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${croppedZoneBuffer.toString('base64')}`, detail: step.group_type === 'text_input' ? 'high' : 'low' } });
            }

            if (thumbnailBuffer) {
                const thumbLabel = hasCrop
                    ? 'IMAGE 3 — REFERENCE THUMBNAIL (what was selected — concept reference, NOT art style reference):'
                    : 'IMAGE 2 — REFERENCE THUMBNAIL (concept reference only — do NOT compare art styles directly):';
                contentParts.push({ type: 'text',      text: thumbLabel });
                contentParts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`, detail: 'low' } });
            }

            // ── [P3] Select model ──
            const model = this._selectModel(step, verifyResults);

            const response = await this.client.chat.completions.create({
                model,
                response_format: { type: 'json_object' },
                temperature:     0,
                max_tokens:      200,
                messages: [
                    { role: 'system', content: SYSTEM_STEP_EVAL },
                    { role: 'user',   content: contentParts },
                ],
            });

            this._trackUsage(response.usage);

            const aiResult = JSON.parse(response.choices[0].message.content);

            // ── [P2] Multi-signal voting ──
            const codeSignal = this._deriveCodeSignal(verifyResults);
            const finalVerdict = this._resolveVoting(codeSignal, aiResult.verdict, aiResult.confidence);

            return {
                ...aiResult,
                verdict:       finalVerdict,
                ai_raw_verdict: aiResult.verdict,
                code_signal:   codeSignal,
                model_used:    model,
            };

        } catch (err) {
            console.error(`    ❌ AI Judge Error: ${err.message}`);
            return { verdict: 'ERROR', reason: err.message, confidence: 0 };
        }
    }

    // ── buildCodeContext ────────────────────────────────────────────────────

    buildCodeContext(verifyResults, bbox) {
        const lines = [];
        if (bbox) {
            lines.push(`- Object located: YES (${bbox.source}, confidence: ${(bbox.confidence * 100).toFixed(0)}%)`);
            lines.push(`- Bounding box: x=${Math.round(bbox.x)}, y=${Math.round(bbox.y)}, w=${Math.round(bbox.w)}, h=${Math.round(bbox.h)}`);
        } else {
            lines.push(`- Object located: NO`);
        }
        const res = verifyResults?.results || {};
        if (res.color) lines.push(`- Color check: ${res.color.pass ? 'PASS ✓' : 'FAIL ✗'} (Expected ${res.color.expected}, Got ${res.color.actual}, Distance=${res.color.distance.toFixed(1)})`);
        if (res.ocr)   lines.push(`- OCR check:   ${res.ocr.pass   ? 'PASS ✓' : 'FAIL ✗'} (Expected "${res.ocr.expected}", Read "${res.ocr.actual}", Confidence=${res.ocr.confidence}%)`);
        return lines.join('\n') || '- No code verification data available.';
    }

    // ── evaluateCartResult ──────────────────────────────────────────────────

    async evaluateCartResult(images, context = {}) {
        if (!this.enabled || !this.client) return this.getDisabledResult();

        const { viewportPath, elementPath } = images || {};
        const hasViewport = viewportPath && fs.existsSync(viewportPath);
        const hasElement  = elementPath  && fs.existsSync(elementPath);
        if (!hasViewport && !hasElement) {
            return { ai_score: -1, ai_verdict: 'SKIP', ai_reason: 'No cart evidence screenshots found.' };
        }

        try {
            const sharp = require('sharp');
            const prepareFile = async (p, w, detail = 'low') => {
                const buf = await this._prepareImage(sharp, p, { width: w, quality: 80 });
                return { b64: buf.toString('base64'), detail };
            };

            const imageContent = [];
            if (hasViewport) {
                const img = await prepareFile(viewportPath, 1024, 'low');
                imageContent.push({ type: 'text', text: 'VIEWPORT SCREENSHOT:' });
                imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img.b64}`, detail: img.detail } });
            }
            if (hasElement) {
                const img = await prepareFile(elementPath, 640, 'high');
                imageContent.push({ type: 'text', text: 'CART ELEMENT CLOSE-UP:' });
                imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img.b64}`, detail: img.detail } });
            }

            const userText = `Code context: method=${context.method}, message="${context.message}".
Did the Add to Cart action succeed? Look for success indicators: cart icon update, confirmation message, toast notification, URL change to /cart.`;

            const response = await this.client.chat.completions.create({
                model:           MODEL_FAST,
                response_format: { type: 'json_object' },
                temperature:     0.1,
                messages: [
                    { role: 'system', content: SYSTEM_CART },
                    { role: 'user',   content: [{ type: 'text', text: userText }, ...imageContent] },
                ],
            });

            return this.parseAiResponse(response.choices[0].message.content);

        } catch (err) {
            return { ai_score: -1, ai_verdict: 'ERROR', ai_reason: `Cart AI evaluation failed: ${err.message}` };
        }
    }

    // ── evaluateInteraction ─────────────────────────────────────────────────

    async evaluateInteraction(beforePath, afterPath, actionName, valueChosen = '', isLabelConfirmed = false) {
        if (!this.generalAiEnabled || !this.client) return this.getDisabledResult();
        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return { ai_score: -1, ai_verdict: 'SKIP', ai_reason: 'Screenshots not found.' };
        }

        try {
            const sharp = require('sharp');
            const toB64 = async (p) => (await this._prepareImage(sharp, p, { width: 640 })).toString('base64');

            // Structural evidence note — nếu DOM đã confirm, coi đó là strong signal
            const evidenceNote = isLabelConfirmed && valueChosen
                ? `STRONG EVIDENCE: DOM scanner confirmed "${valueChosen}" appeared in the customization area. Treat this as near-conclusive PASS evidence unless the screenshot shows a clearly broken state.`
                : '';

            const userText = `Action performed: "${actionName}"
Expected result: UI reveals new options or confirms selection of "${valueChosen}".
${evidenceNote}

Compare BEFORE vs AFTER. Did the interaction produce the expected UI change?`;

            const response = await this.client.chat.completions.create({
                model:           MODEL_FAST,
                response_format: { type: 'json_object' },
                temperature:     0.1,
                messages: [
                    { role: 'system', content: SYSTEM_INTERACTION },
                    {
                        role: 'user',
                        content: [
                            { type: 'text',      text: userText },
                            { type: 'text',      text: 'BEFORE:' },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await toB64(beforePath)}`, detail: 'low' } },
                            { type: 'text',      text: 'AFTER:' },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await toB64(afterPath)}`,  detail: 'low' } },
                        ],
                    },
                ],
            });

            return this.parseAiResponse(response.choices[0].message.content);

        } catch (err) {
            return { ai_score: -1, ai_verdict: 'ERROR', ai_reason: err.message };
        }
    }

    // ── evaluateFinalPreview ────────────────────────────────────────────────

    async evaluateFinalPreview(imagePath, caseReport = {}, options = {}) {
        if (!this.generalAiEnabled || !this.client) {
            return this._toFinalReviewPayload({
                verdict: 'DISABLED',
                summary: 'AI evaluation disabled.',
                tier: 0,
                triagePath: ['AI_DISABLED'],
            });
        }
        if (!fs.existsSync(imagePath)) {
            return this._toFinalReviewPayload({
                verdict: 'ERROR',
                summary: 'Final screenshot file not found.',
                tier: 0,
                triagePath: ['MISSING_FINAL_IMAGE'],
                flags: ['FINAL_IMAGE_MISSING'],
            });
        }

        try {
            const triageContext = options?.triageContext || {};
            const actionLines = this._buildActionLines(caseReport);
            const signals = this._buildFinalTriageSignals(caseReport, triageContext);
            const deterministic = this._runDeterministicTier(signals);

            if (deterministic.resolved) {
                return this._toFinalReviewPayload({
                    verdict: deterministic.verdict,
                    summary: deterministic.summary,
                    issues: deterministic.issues,
                    confidence: deterministic.confidence,
                    tier: 1,
                    triagePath: deterministic.triage_path,
                    flags: deterministic.flags,
                    tokensUsed: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 },
                });
            }

            const zones = this._collectReviewZones(caseReport, 4);
            const sharp = require('sharp');
            const tier2UsageBefore = this._getUsageSnapshot();
            let tier2Pass = false;
            let tier2Confidence = 0;
            let tier2Issues = [];
            let tier2Flags = [];
            let tier2EscalateReason = 'LOW_CONFIDENCE';

            try {
                let zoneImages = await this._buildZoneImages(imagePath, zones, { maxWidth: 512, quality: 75, detail: 'low' });
                if (zoneImages.length === 0) {
                    const fallback = await sharp(imagePath)
                        .resize({ width: 512, withoutEnlargement: true })
                        .jpeg({ quality: 75 })
                        .toBuffer();
                    zoneImages = [{
                        zone: { name: 'full_preview_fallback', type: 'full_preview', expected: '' },
                        detail: 'low',
                        base64: fallback.toString('base64'),
                    }];
                    tier2Flags.push('NO_ZONE_FALLBACK_TO_PREVIEW');
                }

                const zoneSummary = zoneImages.map((z, idx) => {
                    const expected = z.zone.expected ? ` expected="${z.zone.expected}"` : '';
                    return `${idx + 1}. ${z.zone.name} (${z.zone.type})${expected}`;
                }).join('\n');

                const lightPrompt = `You are validating POD customization zones.
Expected customizations:
${actionLines || '- (No customizations recorded)'}

Provided zones:
${zoneSummary}

Return JSON only with pass/textVisible/textCorrect/colorMatch/confidence/issues/flags.`;

                const content = [{ type: 'text', text: lightPrompt }];
                zoneImages.forEach((item, idx) => {
                    content.push({ type: 'text', text: `ZONE ${idx + 1}: ${item.zone.name} (${item.zone.type})` });
                    content.push({
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${item.base64}`, detail: item.detail || 'low' },
                    });
                });

                const response = await this.client.chat.completions.create({
                    model: MODEL_FAST,
                    response_format: { type: 'json_object' },
                    temperature: 0,
                    max_tokens: 180,
                    messages: [
                        { role: 'system', content: SYSTEM_FINAL_REVIEW_LIGHT },
                        { role: 'user', content },
                    ],
                });

                this._trackUsage(response.usage);
                const parsed = this.safeParseFinalReview(response.choices?.[0]?.message?.content || '') || {};
                tier2Pass = Boolean(parsed.pass ?? (String(parsed.ai_verdict || '').toUpperCase() === 'PASS'));
                tier2Confidence = this._clamp01(parsed.confidence, 0);
                tier2Issues = Array.isArray(parsed.issues) ? parsed.issues.map((v) => String(v)) : [];
                tier2Flags = tier2Flags.concat(Array.isArray(parsed.flags) ? parsed.flags.map((v) => String(v).toUpperCase()) : []);

                if (tier2Confidence < TIER2_ESCALATE_CONFIDENCE) {
                    tier2EscalateReason = `TIER2_CONFIDENCE_LT_${TIER2_ESCALATE_CONFIDENCE}`;
                } else if (tier2Flags.includes('NEED_DEEP_REVIEW')) {
                    tier2EscalateReason = 'FLAG_NEED_DEEP_REVIEW';
                }
            } catch (tier2Err) {
                tier2Flags.push('TIER2_ERROR');
                tier2Issues.push(`Tier-2 review error: ${tier2Err.message}`);
                tier2EscalateReason = 'TIER2_ERROR';
            }

            const tier2Tokens = this._getUsageDelta(tier2UsageBefore);
            const mustEscalate =
                tier2Flags.includes('TIER2_ERROR')
                || tier2Flags.includes('NEED_DEEP_REVIEW')
                || tier2Confidence < TIER2_ESCALATE_CONFIDENCE
                || signals.decorativeFontRisk
                || zones.length > 1;

            if (!mustEscalate) {
                const tier2Verdict = tier2Pass
                    ? 'PASS'
                    : (tier2Confidence >= TIER2_FAIL_CONFIDENCE ? 'FAIL' : 'REVIEW');
                const summary = tier2Verdict === 'PASS'
                    ? 'Tier-2 lightweight review confirms expected customization.'
                    : (tier2Issues[0] || 'Tier-2 lightweight review found issues.');

                return this._toFinalReviewPayload({
                    verdict: tier2Verdict,
                    summary,
                    issues: tier2Issues,
                    confidence: tier2Confidence,
                    tier: 2,
                    triagePath: ['T1_INCONCLUSIVE', 'T2_LIGHTWEIGHT_RESOLVED'],
                    flags: tier2Flags,
                    tokensUsed: tier2Tokens,
                });
            }

            const tier3UsageBefore = this._getUsageSnapshot();
            const deepZones = await this._buildZoneImages(imagePath, zones, { maxWidth: 768, quality: 82, detail: 'high' });
            const deepPrompt = `Review POD preview zones and provide a concise final QA decision.
Escalation reason: ${tier2EscalateReason}
Expected customizations:
${actionLines || '- (No customizations recorded)'}

For each zone, validate:
1) content matches expected
2) placement looks correct
3) no visual artifacts`;

            const deepContent = [{ type: 'text', text: deepPrompt }];
            if (deepZones.length > 0) {
                deepZones.forEach((item, idx) => {
                    deepContent.push({ type: 'text', text: `DEEP ZONE ${idx + 1}: ${item.zone.name} (${item.zone.type}) expected="${item.zone.expected}"` });
                    deepContent.push({
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${item.base64}`, detail: 'high' },
                    });
                });
            } else {
                const fallbackBuffer = await sharp(imagePath)
                    .resize({ width: 768, withoutEnlargement: true })
                    .jpeg({ quality: 82 })
                    .toBuffer();
                deepContent.push({ type: 'text', text: 'DEEP FALLBACK IMAGE: full preview (zones unavailable).' });
                deepContent.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${fallbackBuffer.toString('base64')}`, detail: 'high' },
                });
            }

            const deepRes = await this.client.chat.completions.create({
                model: MODEL_SMART,
                response_format: { type: 'json_object' },
                temperature: 0.1,
                max_tokens: 220,
                messages: [
                    { role: 'system', content: SYSTEM_FINAL_REVIEW_DEEP },
                    { role: 'user', content: deepContent },
                ],
            });

            this._trackUsage(deepRes.usage);
            const tier3Tokens = this._getUsageDelta(tier3UsageBefore);
            const deepParsed = this.safeParseFinalReview(deepRes.choices?.[0]?.message?.content || '') || {};
            const deepPass = Boolean(deepParsed.pass ?? (String(deepParsed.ai_verdict || '').toUpperCase() === 'PASS'));
            const deepConfidence = this._clamp01(deepParsed.confidence, 0);
            const deepIssues = Array.isArray(deepParsed.issues)
                ? deepParsed.issues.map((v) => String(v))
                : (tier2Issues.length ? tier2Issues : []);
            const deepFlags = []
                .concat(Array.isArray(deepParsed.flags) ? deepParsed.flags.map((v) => String(v).toUpperCase()) : [])
                .concat(tier2Flags);
            const deepSummary = String(deepParsed.summary || '').trim()
                || deepIssues[0]
                || (deepPass ? 'Tier-3 deep review passed.' : 'Tier-3 deep review found issues.');

            return this._toFinalReviewPayload({
                verdict: deepPass ? 'PASS' : 'FAIL',
                summary: deepSummary,
                issues: deepIssues,
                confidence: deepConfidence || Math.max(deepConfidence, tier2Confidence),
                tier: 3,
                triagePath: ['T1_INCONCLUSIVE', 'T2_ESCALATED', 'T3_DEEP_REVIEW'],
                flags: deepFlags,
                tokensUsed: {
                    prompt_tokens: (tier2Tokens.prompt_tokens || 0) + (tier3Tokens.prompt_tokens || 0),
                    completion_tokens: (tier2Tokens.completion_tokens || 0) + (tier3Tokens.completion_tokens || 0),
                    total_tokens: (tier2Tokens.total_tokens || 0) + (tier3Tokens.total_tokens || 0),
                    calls: (tier2Tokens.calls || 0) + (tier3Tokens.calls || 0),
                },
            });
        } catch (err) {
            console.error('[ERR] AI Final Review error:', err.message);
            return this._toFinalReviewPayload({
                verdict: 'ERROR',
                summary: `API call failed: ${err.message}`,
                tier: 3,
                triagePath: ['T1_INCONCLUSIVE', 'T2_OR_T3_ERROR'],
                flags: ['FINAL_REVIEW_ERROR'],
            });
        }
    }

    // ── parseAiResponse ─────────────────────────────────────────────────────

    parseAiResponse(text) {
        try {
            const cleaned = text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
            const parsed  = JSON.parse(cleaned);

            const verdictRaw = String(parsed.ai_verdict || parsed.verdict || 'UNKNOWN').toUpperCase();
            const VALID_VERDICTS = new Set(['PASS', 'FAIL', 'SKIP', 'SKIPPED', 'ERROR', 'PARSE_ERROR', 'UNKNOWN', 'DISABLED', 'WARNING']);
            const normalizedVerdict = VALID_VERDICTS.has(verdictRaw)
                ? (verdictRaw === 'SKIP' ? 'SKIPPED' : verdictRaw)
                : 'UNKNOWN';

            return {
                ai_score:          typeof parsed.ai_score === 'number' ? parsed.ai_score : -1,
                ai_verdict:        normalizedVerdict,
                ai_reason:         parsed.ai_reason || parsed.reason || 'No reason provided.',
                detected_elements: parsed.detected_elements || [],
            };
        } catch {
            return { ai_score: -1, ai_verdict: 'PARSE_ERROR', ai_reason: `Could not parse: ${text.substring(0, 200)}` };
        }
    }

    // ── safeParseFinalReview ────────────────────────────────────────────────

    safeParseFinalReview(content) {
        // Stage 1: clean parse
        try {
            const cleaned = content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
            return JSON.parse(cleaned);
        } catch {
            console.warn('  [AI] Standard parse failed, attempting repair...');
        }

        // Stage 2: repair truncated JSON
        try {
            let r = content.trim();
            if (r.endsWith(',')) r = r.slice(0, -1);

            const qCount = (r.match(/"/g) || []).length;
            if (qCount % 2 !== 0) r += '"';

            const ob = (r.match(/{/g) || []).length;
            let   cb = (r.match(/}/g) || []).length;
            while (cb < ob) { r += '}'; cb++; }

            const oq = (r.match(/\[/g) || []).length;
            let   cq = (r.match(/]/g)  || []).length;
            while (cq < oq) { r += ']'; cq++; }

            return JSON.parse(r);
        } catch (e2) {
            console.error('  [AI] JSON repair failed:', e2.message);
            return null;
        }
    }

    // ── normalizeFinalReview ────────────────────────────────────────────────

    normalizeFinalReview(parsed) {
        if (!parsed) return null;
        const toArr = (v) => Array.isArray(v) ? v : (v ? [String(v)] : []);
        return {
            summary:       parsed.summary           || '',
            strengths:     toArr(parsed.strengths),
            issues:        toArr(parsed.issues),
            layout_notes:  toArr(parsed.layout_notes),
            color_notes:   toArr(parsed.color_notes),
            content_notes: toArr(parsed.content_notes),
            recommendations: toArr(parsed.recommendations),
            ai_verdict:    parsed.ai_verdict        || 'UNKNOWN',
            confidence:    parsed.confidence        || 0,
            ai_reason:     parsed.summary           || '',
        };
    }

    // ── annotatePreviewImage ────────────────────────────────────────────────

    /**
     * FIX 2 (giữ lại): Annotate bằng sharp + SVG, tránh lỗi pngjs đọc JPEG.
     */
    async annotatePreviewImage(imagePath, outputPath, detectedElements) {
        try {
            const sharp = require('sharp');
            const meta  = await sharp(imagePath).metadata();
            const W = meta.width;
            const H = meta.height;

            const rects = (detectedElements || []).map(el => {
                if (!el.bbox || el.bbox.length < 4) return '';
                const x = Math.round((el.bbox[0] / 1000) * W);
                const y = Math.round((el.bbox[1] / 1000) * H);
                const w = Math.round(((el.bbox[2] - el.bbox[0]) / 1000) * W);
                const h = Math.round(((el.bbox[3] - el.bbox[1]) / 1000) * H);
                if (w <= 0 || h <= 0) return '';

                const c   = el.color || { r: 255, g: 0, b: 0 };
                const hex = `#${c.r.toString(16).padStart(2,'0')}${c.g.toString(16).padStart(2,'0')}${c.b.toString(16).padStart(2,'0')}`;
                const lbl = (el.field || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                const fs  = 12;
                const tp  = 3;
                const th  = fs + tp * 2;
                const ty  = y - th > 0 ? y - th : y + h;
                const tw  = lbl.length * (fs * 0.6) + tp * 2;

                return `
<rect x="${x+1}" y="${y+1}" width="${w-2}" height="${h-2}" fill="none" stroke="${hex}" stroke-width="2" opacity="0.9"/>
${lbl ? `<rect x="${x}" y="${ty}" width="${tw}" height="${th}" fill="${hex}" opacity="0.85" rx="2"/>
<text x="${x+tp}" y="${ty+th-tp}" font-family="monospace" font-size="${fs}" fill="white" font-weight="bold">${lbl}</text>` : ''}`;
            }).join('');

            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`;

            await sharp(imagePath)
                .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
                .jpeg({ quality: 90 })
                .toFile(outputPath);

        } catch (err) {
            console.error(`    ❌ annotatePreviewImage failed: ${err.message}`);
            try {
                const sharp = require('sharp');
                await sharp(imagePath).jpeg({ quality: 90 }).toFile(outputPath);
            } catch {
                fs.copyFileSync(imagePath, outputPath);
            }
        }
    }

    // ── Utils ───────────────────────────────────────────────────────────────

    getDisabledResult() {
        return { ai_score: -1, ai_verdict: 'DISABLED', ai_reason: 'AI evaluation is disabled.' };
    }

    getUsageStats() { return { ...this.usage, budgetExhausted: this.budgetExhausted }; }
}

module.exports = AiEvaluator;
