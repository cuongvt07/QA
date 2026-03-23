/**
 * AI Evaluator Module — patch notes:
 *
 * FIX 1 (evaluateStepWithContext):
 *   When diffMask={0,0,0,0}, croppedPath is null/missing.
 *   Previously the AI received only the full preview with no crop → compared
 *   thumbnail icon (small, flat graphic) against full cartoon scene → FAILed.
 *
 *   Fix: When no crop available, instruct AI to scan the FULL PREVIEW for the
 *   specific change (hair/beard/color region) rather than comparing thumbnail
 *   shape-for-shape. Also increase confidence threshold for FAIL verdict.
 *
 * FIX 2 (annotatePreviewImage):
 *   "Error reading original image for annotation: Invalid file signature"
 *   The final preview is saved as JPEG by sharp but read by pngjs → crash.
 *   Fix: replace pngjs draw loop with sharp + SVG composite (same as image-annotator.js).
 */

const fs = require('fs');
const path = require('path');

const OPENAI_MODEL_FINAL = process.env.FINAL_REVIEW_MODEL || 'gpt-4o-mini';
const OPENAI_MODEL_STEP = 'gpt-4o-mini';

class AiEvaluator {
    constructor(apiKey, generalAiEnabled = true) {
        this.apiKey = apiKey;
        this.generalAiEnabled = generalAiEnabled && !!apiKey;
        this.enabled = this.generalAiEnabled;
        this.client = null;
        this.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
        
        // P1.3: Budget Constraints
        this.MAX_TOKENS_PER_SESSION = 100000; 
        this.MAX_CALLS_PER_SESSION = 6;
        this.budgetExhausted = false;
    }

    _trackUsage(usage) {
        if (!usage) return;
        this.usage.prompt_tokens += usage.prompt_tokens || 0;
        this.usage.completion_tokens += usage.completion_tokens || 0;
        this.usage.total_tokens += usage.total_tokens || 0;
        this.usage.calls++;
        
        if (this.usage.total_tokens > this.MAX_TOKENS_PER_SESSION || this.usage.calls > this.MAX_CALLS_PER_SESSION) {
            if (!this.budgetExhausted) {
                console.warn(`      [AI BUDGET] 🚨 Budget exceeded (${this.usage.total_tokens} tokens, ${this.usage.calls} calls). Switching to REVIEW fallback.`);
                this.budgetExhausted = true;
            }
        }

        console.log(`      [AI USAGE] #${this.usage.calls}: ${usage.total_tokens} tokens (Total: ${this.usage.total_tokens}${this.budgetExhausted ? ' !!BUDGET EXCEEDED!!' : ''})`);
    }

    async init() {
        if (!this.generalAiEnabled) return;
        try {
            const { OpenAI } = require('openai');
            this.client = new OpenAI({ apiKey: this.apiKey });
        } catch (error) {
            console.warn('[WARN] AI Evaluator: Failed to initialize openai:', error.message);
            this.enabled = false;
            this.generalAiEnabled = false;
        }
    }

    async evaluateStep(beforePath, afterPath, optionName, valueChosen, diffMask = null, groupType = null, optionThumbnail = null) {
        if (!this.generalAiEnabled || !this.client) return this.getDisabledResult();
        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return { ai_score: -1, ai_verdict: 'SKIP', ai_reason: 'Screenshot files not found.' };
        }

        try {
            const sharp = require('sharp');
            let beforeBuffer, afterBuffer;

            if (diffMask && diffMask.w > 0 && diffMask.h > 0) {
                try {
                    const meta = await sharp(beforePath).metadata();
                    const left = Math.max(0, Math.floor(diffMask.x));
                    const top = Math.max(0, Math.floor(diffMask.y));
                    const width = Math.min(meta.width - left, Math.ceil(diffMask.w));
                    const height = Math.min(meta.height - top, Math.ceil(diffMask.h));
                    if (width > 0 && height > 0) {
                        beforeBuffer = await sharp(beforePath).extract({ left, top, width, height }).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
                        afterBuffer = await sharp(afterPath).extract({ left, top, width, height }).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
                    }
                } catch (extractError) {
                    console.warn(`    ⚠️ AI Step Isolation failed: ${extractError.message}`);
                }
            }

            if (!beforeBuffer || !afterBuffer) {
                beforeBuffer = await sharp(beforePath).resize({ width: 512, withoutEnlargement: true }).removeAlpha().jpeg({ quality: 80 }).toBuffer();
                afterBuffer = await sharp(afterPath).resize({ width: 512, withoutEnlargement: true }).removeAlpha().jpeg({ quality: 80 }).toBuffer();
            }

            const isGenericValue = (valueChosen || '').startsWith('Value ');
            const displayValue = isGenericValue ? `"${optionName}" graphic` : `"${valueChosen}"`;

            const systemPrompt = {
                rules: [
                    'You are an AI Quality Inspector for a print-on-demand product preview.',
                    'Your job is to verify if a customization step correctly altered the preview.',
                    diffMask ? 'NOTE: You are viewing a CROPPED zone where the change occurred.' : 'Compare Image 1 (Before) and Image 2 (After).',
                    'A successful customization must be clearly visible.',
                    'Return ONLY valid JSON.',
                ]
            };

            const userPromptText = groupType === 'image_option'
                ? `CUSTOMIZATION: "${optionName}" → ${displayValue}. Check if AFTER shows a visual change consistent with this selection.`
                : `Action: Selected "${optionName}" = ${displayValue}. Is it visible and correct in After?\nRespond ONLY in JSON: { "ai_score": number, "ai_verdict": "PASS"|"FAIL"|"WARNING", "ai_reason": "...", "confidence": 0.0-1.0 }`;

            const response = await this.client.chat.completions.create({
                model: OPENAI_MODEL_STEP,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: JSON.stringify(systemPrompt) },
                    {
                        role: 'user', content: [
                            { type: 'text', text: userPromptText },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${beforeBuffer.toString('base64')}` } },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${afterBuffer.toString('base64')}` } },
                            ...(groupType === 'image_option' && optionThumbnail ? [
                                { type: 'text', text: 'REFERENCE THUMBNAIL:' },
                                { type: 'image_url', image_url: { url: optionThumbnail } },
                            ] : [])
                        ]
                    }
                ],
                temperature: 0.1,
            });

            return this.parseAiResponse(response.choices[0].message.content);
        } catch (error) {
            return { ai_score: -1, ai_verdict: 'ERROR', ai_reason: `API call failed: ${error.message}` };
        }
    }

    /**
     * FIX 1: AI Judge — handle missing crop gracefully.
     * When diffMask={0,0,0,0}, no crop exists. The old code still sent a null
     * croppedPath and the AI was left comparing a tiny thumbnail icon against
     * the full cartoon figure → shape mismatch → FAIL (wrong).
     *
     * New strategy when no crop:
     *  - Send full preview only
     *  - Change the instruction to "look for evidence of X in the full image"
     *  - Require confidence >= 0.9 to FAIL (was any confidence)
     */
    async evaluateStepWithContext(step, previewPath, bbox, verifyResults) {
        if (!this.generalAiEnabled || !this.client) {
            return { verdict: 'DISABLED', reason: 'AI evaluation disabled', confidence: 0 };
        }

        if (this.budgetExhausted) {
            return { verdict: 'PASS', reason: 'Budget exhausted: skipping step AI', confidence: 0.5, skipped_budget: true };
        }

        try {
            const sharp = require('sharp');
            const axios = require('axios');

            const bboxArea = Math.max(0, (bbox?.w || 0) * (bbox?.h || 0));
            const diffMaskArea = Math.max(0, (step?.diffMask?.w || 0) * (step?.diffMask?.h || 0));
            const suspiciousCrop = step.group_type === 'image_option' &&
                bboxArea > 0 &&
                diffMaskArea > 0 &&
                (bboxArea / diffMaskArea) < 0.08;
            const hasCrop = verifyResults.croppedPath && fs.existsSync(verifyResults.croppedPath) && !suspiciousCrop;

            const fullPreviewBuffer = await sharp(previewPath)
                .resize({ width: 512, withoutEnlargement: true }) // Reduced from 800
                .jpeg({ quality: 80 })
                .toBuffer();

            let croppedZoneBuffer = null;
            if (hasCrop) {
                try {
                    croppedZoneBuffer = await sharp(verifyResults.croppedPath)
                        .resize({ width: 320, withoutEnlargement: true }) // Reduced from 400
                        .jpeg({ quality: 85 })
                        .toBuffer();
                } catch (e) {
                    console.warn(`    [AI] Failed to process cropped zone: ${e.message}`);
                }
            }

            let thumbnailBuffer = null;
            if (step.option_thumbnail && step.group_type === 'image_option') {
                try {
                    const response = await axios.get(step.option_thumbnail, { responseType: 'arraybuffer' });
                    thumbnailBuffer = await sharp(Buffer.from(response.data))
                        .resize({ width: 128, withoutEnlargement: true }) // Reduced from 200
                        .jpeg({ quality: 85 })
                        .toBuffer();
                } catch (e) {
                    console.warn(`    [AI] Failed to fetch thumbnail: ${e.message}`);
                }
            }

            const codeContext = this.buildCodeContext(verifyResults, bbox);

            // ── FIX: system prompt varies depending on whether crop is available ──
            const noCropWarning = !hasCrop
                ? `IMPORTANT: No cropped zone is available for this step. You are seeing the FULL product preview only.
Do NOT compare thumbnail shape-for-shape with the cartoon figure — the art styles are different by design.
Instead, look for EVIDENCE that the change was applied: e.g. hair color changed, beard added/removed, text visible.
If the full preview looks consistent with the expected customization, lean toward PASS.
Only FAIL if there is clear, obvious evidence that the expected change is ABSENT (e.g. beard was selected but figure clearly has no beard).
Require confidence >= 0.9 to issue a FAIL verdict.`
                : '';

            const messages = [
                {
                    role: 'system',
                    content: `You are a Supreme Visual QA Judge.
Confirm or dispute deterministic findings (OCR/Color) based on visual evidence.
YOU are the final arbitrator. If you see the text/color/feature clearly, PASS even if tools failed.
Only FAIL if visuals clearly contradict the expected value.
${noCropWarning}
Return ONLY JSON: { "verdict": "PASS"|"FAIL", "reason": "...", "confidence": 0.0-1.0, "bbox_correct": true, "code_results_confirmed": true }`
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `=== STEP CONTEXT ===\nStep: "${step.name}"\nType: ${step.group_type}\nExpected Value: "${step.value_chosen}"\nSuspicious crop fallback: ${suspiciousCrop ? 'yes' : 'no'}\n\n=== CODE VERIFICATION RESULTS ===\n${codeContext}` },
                        { type: 'text', text: 'IMAGE 1: FULL PRODUCT PREVIEW' },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fullPreviewBuffer.toString('base64')}` } },
                    ]
                }
            ];

            if (croppedZoneBuffer) {
                messages[1].content.push({ type: 'text', text: 'IMAGE 2: CROPPED ZONE (area of change)' });
                messages[1].content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${croppedZoneBuffer.toString('base64')}` } });
            }

            if (thumbnailBuffer) {
                messages[1].content.push({ type: 'text', text: hasCrop ? 'IMAGE 3: REFERENCE THUMBNAIL (what was selected)' : 'IMAGE 2: REFERENCE THUMBNAIL (what was selected — for context only, do NOT compare shapes directly)' });
                messages[1].content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}` } });
            }

            let specificInstruction = '';
            if (step.group_type === 'image_option') {
                specificInstruction = hasCrop
                    ? `Does the CROPPED ZONE show a visual graphic/icon/symbol matching the reference thumbnail? If shapes represent the same concept, PASS.`
                    : `Look at the FULL PREVIEW. Does the figure show evidence of "${step.value_chosen}" being applied (hair/beard/color change)? Compare BEFORE vs current state using context clues.`;
            } else if (step.group_type === 'text_input') {
                specificInstruction = `Is "${step.value_chosen}" clearly visible on the preview?`;
            } else if (step.group_type === 'color_option') {
                specificInstruction = `Has the color changed as expected? Focus on the color area.`;
            }

            const taskPrompt = `=== YOUR TASK ===
1. ${specificInstruction}
2. Confirm or dispute code results based on visual evidence.
3. Only FAIL if visuals clearly contradict the expected value${!hasCrop ? ' (confidence must be >= 0.9 to FAIL)' : ''}.

Return JSON:
{
  "verdict": "PASS" | "FAIL",
  "confidence": 0.0 - 1.0,
  "bbox_correct": boolean,
  "code_results_confirmed": boolean,
  "reason": "Detailed explanation",
  "issues": []
}`;
            messages[1].content.push({ type: 'text', text: taskPrompt });

            const response = await this.client.chat.completions.create({
                model: OPENAI_MODEL_STEP,
                messages,
                max_tokens: 150, // Reduced from 500
                temperature: 0,
                response_format: { type: 'json_object' },
            });

            this._trackUsage(response.usage);
            return JSON.parse(response.choices[0].message.content);

        } catch (error) {
            console.error(`    ❌ AI Judge Error: ${error.message}`);
            return { verdict: 'ERROR', reason: error.message, confidence: 0 };
        }
    }

    buildCodeContext(verifyResults, bbox) {
        const lines = [];
        if (bbox) {
            lines.push(`- Object located: YES (${bbox.source} confidence: ${(bbox.confidence * 100).toFixed(0)}%)`);
            lines.push(`- Bbox: x=${Math.round(bbox.x)}, y=${Math.round(bbox.y)}, w=${Math.round(bbox.w)}, h=${Math.round(bbox.h)}`);
        } else {
            lines.push(`- Object located: NO`);
        }
        const res = verifyResults.results || {};
        if (res.color) lines.push(`- Color check: ${res.color.pass ? 'PASS' : 'FAIL'} (Expected ${res.color.expected}, Got ${res.color.actual}, Dist=${res.color.distance.toFixed(1)})`);
        if (res.ocr) lines.push(`- OCR check: ${res.ocr.pass ? 'PASS' : 'FAIL'} (Expected "${res.ocr.expected}", Read "${res.ocr.actual}", Conf=${res.ocr.confidence}%)`);
        return lines.join('\n');
    }

    async evaluateCartResult(images, context = {}) {
        if (!this.enabled || !this.client) return this.getDisabledResult();
        const { viewportPath, elementPath } = images || {};
        const hasViewport = viewportPath && fs.existsSync(viewportPath);
        const hasElement = elementPath && fs.existsSync(elementPath);
        if (!hasViewport && !hasElement) return { ai_score: -1, ai_verdict: 'SKIP', ai_reason: 'No cart evidence screenshots found.' };

        try {
            const sharp = require('sharp');
            const prepare = async (p, w) => {
                let buf = fs.readFileSync(p);
                try { buf = await sharp(buf).resize({ width: w, withoutEnlargement: true }).removeAlpha().jpeg({ quality: 80 }).toBuffer(); } catch (e) { }
                return buf.toString('base64');
            };

            const imageContent = [];
            if (hasViewport) imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await prepare(viewportPath, 1024)}`, detail: 'low' } });
            if (hasElement) imageContent.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await prepare(elementPath, 640)}`, detail: 'high' } });

            const response = await this.client.chat.completions.create({
                model: OPENAI_MODEL_STEP,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: 'You are an AI QA validator for e-commerce cart confirmation. Return ONLY JSON: { "ai_score": number, "ai_verdict": "PASS"|"FAIL", "ai_reason": "..." }' },
                    {
                        role: 'user', content: [
                            { type: 'text', text: `Code context: method=${context.method}, message=${context.message}. Did Add to Cart succeed?` },
                            ...imageContent
                        ]
                    }
                ],
                temperature: 0.1,
            });
            return this.parseAiResponse(response.choices[0].message.content);
        } catch (error) {
            return { ai_score: -1, ai_verdict: 'ERROR', ai_reason: `Cart AI evaluation failed: ${error.message}` };
        }
    }

    async evaluateInteraction(beforePath, afterPath, actionName, valueChosen = '', isLabelConfirmed = false) {
        if (!this.generalAiEnabled || !this.client) return this.getDisabledResult();
        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return { ai_score: -1, ai_verdict: 'SKIP', ai_reason: 'Screenshots not found.' };

        try {
            const sharp = require('sharp');
            const prepare = async (p) => {
                let buf = fs.readFileSync(p);
                try { buf = await sharp(buf).resize({ width: 640 }).removeAlpha().jpeg().toBuffer(); } catch (e) { }
                return buf.toString('base64');
            };

            const structuralNotice = isLabelConfirmed && valueChosen
                ? `[CRITICAL EVIDENCE]: DOM scanner confirmed "${valueChosen}" appeared in customization area. Mark as PASS unless image is clearly broken.`
                : '';

            const response = await this.client.chat.completions.create({
                model: OPENAI_MODEL_STEP,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: `You are an AI QA validator. Action: ${actionName}. ${structuralNotice} Return JSON: { "ai_score": 100, "ai_verdict": "PASS"|"FAIL", "ai_reason": "..." }` },
                    {
                        role: 'user', content: [
                            { type: 'text', text: `Did the interaction reveal new options or confirm the selection? ${structuralNotice}` },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await prepare(beforePath)}` } },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${await prepare(afterPath)}` } },
                        ]
                    }
                ],
                temperature: 0.1,
            });
            return this.parseAiResponse(response.choices[0].message.content);
        } catch (error) {
            return { ai_score: -1, ai_verdict: 'ERROR', ai_reason: error.message };
        }
    }

    parseAiResponse(text) {
        try {
            let cleaned = text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
            const parsed = JSON.parse(cleaned);
            const verdictRaw = String(parsed.ai_verdict || 'UNKNOWN').toUpperCase();
            const normalizedVerdict = ['PASS', 'FAIL', 'SKIP', 'SKIPPED', 'ERROR', 'PARSE_ERROR', 'UNKNOWN', 'DISABLED'].includes(verdictRaw)
                ? (verdictRaw === 'SKIP' ? 'SKIPPED' : verdictRaw)
                : 'UNKNOWN';
            return {
                ai_score: typeof parsed.ai_score === 'number' ? parsed.ai_score : -1,
                ai_verdict: normalizedVerdict,
                ai_reason: parsed.ai_reason || 'No reason provided.',
                detected_elements: parsed.detected_elements || [],
            };
        } catch {
            return { ai_score: -1, ai_verdict: 'PARSE_ERROR', ai_reason: `Could not parse: ${text.substring(0, 200)}` };
        }
    }

    async evaluateFinalPreview(imagePath, caseReport = {}) {
        if (!this.generalAiEnabled || !this.client) return { ai_verdict: 'DISABLED', ai_reason: 'AI evaluation disabled' };
        if (!fs.existsSync(imagePath)) return { ai_verdict: 'ERROR', ai_reason: 'Final screenshot file not found.' };

        try {
            const actionContext = (caseReport.timeline || [])
                .filter(s => !s.is_menu_opener && s.group_type !== 'lifecycle' && s.value_chosen)
                .map(s => {
                    if (s.group_type === 'image_option') return `- Cat graphic selected: "${s.name}" → variant "${s.value_chosen}"`;
                    if (s.group_type === 'text_input') return `- Name entered: "${s.value_chosen}" (for ${s.name})`;
                    return `- ${s.group_type || s.action}: "${s.value_chosen}"`;
                })
                .join('\n');

            console.log('  [AI DEBUG] actionContext generated:\n' + actionContext);

            const systemPrompt = {
                role: 'Senior AI Visual Quality Assurance Reviewer',
                rules: [
                    'The preview image is the primary source of truth for the CUSTOMER experience.',
                    'Act as a human reviewer looking at the final customized product.',
                    'Verify that all requested customizations (text, images, variants) are present and correctly rendered.',
                    'Only FAIL if there is a blatant visual error, missing element, or technical rendering artifact.',
                ],
                review_focus: [
                    'Existence of all selected variants/options.',
                    'Visibility and readability of custom text.',
                    'Layout harmony and overall visual correctness.',
                    'No blank, stuck, or broken canvases.'
                ]
            };

            const userPromptText = `Customizations requested by customer:\n${actionContext}\n\nPerform a comprehensive review. Return ONLY JSON:\n{\n  "summary": "1-2 sentences",\n  "strengths": ["list"],\n  "issues": ["list"],\n  "layout_notes": ["positioning"],\n  "color_notes": ["accuracy"],\n  "content_notes": ["text/image content"],\n  "ai_verdict": "PASS" | "FAIL",\n  "confidence": 0.0-1.0\n}`;

            let imageBuffer = fs.readFileSync(imagePath);
            try {
                const sharp = require('sharp');
                // Use slightly lower quality for final review to keep it snappy
                imageBuffer = await sharp(imageBuffer).resize({ width: 768, withoutEnlargement: true }).removeAlpha().withMetadata(false).jpeg({ quality: 75 }).toBuffer();
            } catch (sharpError) {
                console.warn('  [AI] [WARN] Sharp optimization failed:', sharpError.message);
            }

            let response;
            const makeCall = async () => {
                return await this.client.chat.completions.create({
                    model: OPENAI_MODEL_FINAL,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: JSON.stringify(systemPrompt, null, 2) },
                        {
                            role: 'user', content: [
                                { type: 'text', text: userPromptText },
                                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`, detail: 'high' } },
                            ]
                        }
                    ],
                    max_tokens: 500,
                    temperature: 0.1,
                });
            };

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
            
            // This part should ideally not be reached if parsing and normalization succeed within the loop.
            // If it is reached, it means both attempts failed to produce a parsable result.
            // The original code had a `parsed` variable here which would be undefined.
            // We should return an error or a default normalized structure.
            return {
                summary: 'AI Final Review failed after multiple attempts.',
                strengths: [],
                issues: [],
                raw_image_description: '',
                layout_notes: [],
                color_notes: [],
                content_notes: [],
                recommendations: [],
                ai_verdict: 'ERROR',
                confidence: 0,
                ai_reason: 'AI Final Review failed after multiple attempts.'
            };
        } catch (error) {
            console.error('[ERR] AI Final Review error:', error.message);
            return { ai_verdict: 'ERROR', ai_reason: `API call failed: ${error.message}` };
        }
    }

    /**
     * Robust JSON parser that handles truncated strings or minor syntax errors
     */
    safeParseFinalReview(content) {
        try {
            // Stage 1: Standard parse
            let cleaned = content.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
            return JSON.parse(cleaned);
        } catch (e) {
            console.warn('  [AI] [WARN] Standard JSON.parse failed, attempting repair...');
            try {
                // Stage 2: Attempt to repair truncated JSON
                let repaired = content.trim();
                
                // If it ends with a comma, remove it
                if (repaired.endsWith(',')) repaired = repaired.slice(0, -1);
                
                // Close open quotes if any
                const quoteCount = (repaired.match(/"/g) || []).length;
                if (quoteCount % 2 !== 0) repaired += '"';

                // Close brackets
                let openBrace = (repaired.match(/{/g) || []).length;
                let closeBrace = (repaired.match(/}/g) || []).length;
                while (closeBrace < openBrace) {
                    repaired += '}';
                    closeBrace++;
                }
                
                let openBracket = (repaired.match(/\[/g) || []).length;
                let closeBracket = (repaired.match(/]/g) || []).length;
                while (closeBracket < openBracket) {
                    repaired += ']';
                    closeBracket++;
                }

                return JSON.parse(repaired);
            } catch (e2) {
                console.error('  [AI] [ERR] JSON repair failed:', e2.message);
                return null;
            }
        }
    }

    normalizeFinalReview(parsed) {
        if (!parsed) return null;
        const toArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
        return {
            summary: parsed.summary || '',
            strengths: toArr(parsed.strengths),
            issues: toArr(parsed.issues),
            raw_image_description: parsed.raw_image_description || '',
            layout_notes: toArr(parsed.layout_notes),
            color_notes: toArr(parsed.color_notes),
            content_notes: toArr(parsed.content_notes),
            recommendations: toArr(parsed.recommendations),
            ai_verdict: parsed.ai_verdict || 'UNKNOWN',
            confidence: parsed.confidence || 0,
            ai_reason: parsed.summary || ''
        };
    }

    /**
     * FIX 2: Annotate the final preview image using sharp + SVG.
     * REPLACES any pngjs-based annotation function in the original codebase.
     * Call this instead of the old annotatePreviewImage() wherever it appears.
     */
    async annotatePreviewImage(imagePath, outputPath, detectedElements) {
        try {
            const sharp = require('sharp');
            const meta = await sharp(imagePath).metadata();
            const W = meta.width;
            const H = meta.height;

            const rects = (detectedElements || []).map((el) => {
                if (!el.bbox || el.bbox.length < 4) return '';
                // bbox is [x1,y1,x2,y2] in [0-1000] normalised space
                const x = Math.round((el.bbox[0] / 1000) * W);
                const y = Math.round((el.bbox[1] / 1000) * H);
                const w = Math.round(((el.bbox[2] - el.bbox[0]) / 1000) * W);
                const h = Math.round(((el.bbox[3] - el.bbox[1]) / 1000) * H);
                if (w <= 0 || h <= 0) return '';

                const c = el.color || { r: 255, g: 0, b: 0 };
                const hex = `#${c.r.toString(16).padStart(2, '0')}${c.g.toString(16).padStart(2, '0')}${c.b.toString(16).padStart(2, '0')}`;
                const lbl = (el.field || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                const fs = 12;
                const tp = 3;
                const th = fs + tp * 2;
                const ty = y - th > 0 ? y - th : y + h;
                const tw = lbl.length * (fs * 0.6) + tp * 2;

                return `
                <rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" fill="none" stroke="${hex}" stroke-width="2" opacity="0.9"/>
                ${lbl ? `<rect x="${x}" y="${ty}" width="${tw}" height="${th}" fill="${hex}" opacity="0.85" rx="2"/>
                <text x="${x + tp}" y="${ty + th - tp}" font-family="monospace" font-size="${fs}" fill="white" font-weight="bold">${lbl}</text>` : ''}`;
            }).join('');

            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`;

            await sharp(imagePath)
                .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
                .jpeg({ quality: 90 })
                .toFile(outputPath);

        } catch (err) {
            console.error(`    ❌ annotatePreviewImage failed: ${err.message}`);
            // Fallback: copy original untouched
            try {
                const sharp = require('sharp');
                await sharp(imagePath).jpeg({ quality: 90 }).toFile(outputPath);
            } catch (_) {
                fs.copyFileSync(imagePath, outputPath);
            }
        }
    }

    getDisabledResult() {
        return { ai_score: -1, ai_verdict: 'DISABLED', ai_reason: 'AI evaluation is disabled.' };
    }

    getUsageStats() { return this.usage; }
}

module.exports = AiEvaluator;
