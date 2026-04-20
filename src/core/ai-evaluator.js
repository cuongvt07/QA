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

    async evaluateFinalPreview(imagePath, caseReport = {}) {
        if (!this.generalAiEnabled || !this.client) {
            return { ai_verdict: 'DISABLED', ai_reason: 'AI evaluation disabled' };
        }
        if (!fs.existsSync(imagePath)) {
            return { ai_verdict: 'ERROR', ai_reason: 'Final screenshot file not found.' };
        }

        try {
            // Build human-readable action list
            const actionLines = (caseReport.timeline || [])
                .filter(s => !s.is_menu_opener && s.group_type !== 'lifecycle' && s.value_chosen)
                .map(s => {
                    if (s.group_type === 'image_option') return `• [Graphic]  "${s.name}" → variant "${s.value_chosen}"`;
                    if (s.group_type === 'text_input')   return `• [Text]     "${s.name}" → "${s.value_chosen}"`;
                    if (s.group_type === 'color_option')  return `• [Color]    "${s.name}" → "${s.value_chosen}"`;
                    return `• [${s.group_type || s.action}] "${s.name}" → "${s.value_chosen}"`;
                })
                .join('\n');

            console.log('  [AI DEBUG] Final review context:\n' + actionLines);

            // [P5] Prep image — keep reasonable resolution for final review
            const sharp = require('sharp');
            let imageBuffer = fs.readFileSync(imagePath);
            try {
                imageBuffer = await sharp(imageBuffer)
                    .resize({ width: 512, withoutEnlargement: true })
                    .removeAlpha()
                    .withMetadata(false)
                    .jpeg({ quality: 80 })
                    .toBuffer();
            } catch (e) {
                console.warn('  [AI] Sharp optimization failed:', e.message);
            }

            const userText = `The customer requested the following customizations:
${actionLines || '(No customizations recorded)'}

Review the FINAL PRODUCT PREVIEW image and evaluate if all customizations are present and correctly rendered.
Be a quality-conscious customer — accept reasonable artistic variation, reject clear errors or missing content.`;

            const makeCall = async () => this.client.chat.completions.create({
                model:           MODEL_SMART,   // Final review → model tốt nhất
                response_format: { type: 'json_object' },
                temperature:     0.1,
                max_tokens:      300,
                messages: [
                    { role: 'system', content: SYSTEM_FINAL_REVIEW },
                    {
                        role: 'user',
                        content: [
                            { type: 'text',      text: userText },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`, detail: 'low' } },
                        ],
                    },
                ],
            });

            let response;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    response = await makeCall();
                    this._trackUsage(response.usage);
                    const parsed = this.safeParseFinalReview(response.choices[0].message.content);
                    if (parsed) return this.normalizeFinalReview(parsed);
                } catch (err) {
                    console.warn(`  [AI] Final review attempt ${attempt} failed: ${err.message}`);
                    if (attempt === 2) throw err;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            return {
                summary: 'AI Final Review failed after all attempts.',
                strengths: [], issues: [], layout_notes: [], color_notes: [], content_notes: [],
                ai_verdict: 'ERROR', confidence: 0,
                ai_reason: 'AI Final Review failed after all attempts.',
            };

        } catch (err) {
            console.error('[ERR] AI Final Review error:', err.message);
            return { ai_verdict: 'ERROR', ai_reason: `API call failed: ${err.message}` };
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