/**
 * AI Evaluator Module
 * Uses OpenAI GPT-4o Vision API to evaluate preview screenshots.
 */

const fs = require('fs');

const OPENAI_MODEL_FINAL = 'gpt-4o';       // Full model for final review (bounding boxes, detailed analysis)
const OPENAI_MODEL_STEP  = 'gpt-4o-mini';  // Lightweight model for step-level before/after comparison

class AiEvaluator {
    constructor(apiKey, generalAiEnabled = true) {
        this.apiKey = apiKey;
        this.enabled = !!apiKey;
        this.generalAiEnabled = generalAiEnabled && !!apiKey;
        this.client = null;
    }

    /**
     * Initialize the OpenAI client (lazy load)
     */
    async init() {
        if (!this.enabled) return;
        try {
            const { OpenAI } = require('openai');
            this.client = new OpenAI({ apiKey: this.apiKey });
        } catch (error) {
            console.warn('[WARN] AI Evaluator: Failed to initialize openai:', error.message);
            this.enabled = false;
        }
    }

    /**
     * Optional: Evaluate a single step change if needed (legacy behavior)
     */
    async evaluateStep(beforePath, afterPath, optionName, valueChosen) {
        if (!this.generalAiEnabled || !this.client) {
            return this.getDisabledResult();
        }

        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return {
                ai_score: -1,
                ai_verdict: 'SKIP',
                ai_reason: 'Screenshot files not found.',
            };
        }

        try {
            // Optimize images before sending to API (resize + JPEG for smaller payload)
            let beforeBuffer = fs.readFileSync(beforePath);
            let afterBuffer = fs.readFileSync(afterPath);

            try {
                const sharp = require('sharp');
                beforeBuffer = await sharp(beforeBuffer)
                    .resize({ width: 512, withoutEnlargement: true })
                    .removeAlpha()
                    .jpeg({ quality: 80 })
                    .toBuffer();
                afterBuffer = await sharp(afterBuffer)
                    .resize({ width: 512, withoutEnlargement: true })
                    .removeAlpha()
                    .jpeg({ quality: 80 })
                    .toBuffer();
            } catch (sharpError) {
                // Fallback to original files if sharp fails
            }

            const beforeBase64 = beforeBuffer.toString('base64');
            const afterBase64 = afterBuffer.toString('base64');

            const extBefore = 'image/jpeg';
            const extAfter = 'image/jpeg';

            const systemPrompt = {
                "rules": [
                    "You are an AI Visual Quality Assurance Validator.",
                    "Your job is to compare two product preview images (Before and After) and verify if the latest customization step correctly altered the preview.",
                    "If the option shouldn't logically change the preview (like picking a gift box material that is shown elsewhere), mark it PASS but explain why.",
                    "Look specifically for the difference between Image 1 and Image 2.",
                    "Ignore minor pixel shifts or OCR errors if the visual intent is clearly correct.",
                    "Return ONLY valid JSON."
                ],
                "content": {
                    "role": "Step-by-Step QA Validator",
                    "objective": "Determine if the visual change from Before to After accurately reflects the user's action."
                }
            };

            const userPromptText = `Action taken: Selected Option "${optionName}" with Value "${valueChosen}".

Analyze the difference between the Before and After views.
1. Did the preview image change visually?
2. Is the change consistent with the selected option?
3. Are there any rendering errors (like missing images or overlapping text) in the new elements appearing in the After image?

Respond strictly in JSON format:
{
  "ai_score": 100, // 0 for fail, 100 for pass
  "ai_verdict": "PASS" or "FAIL",
  "ai_reason": "<short explanation analyzing the flow: initial state -> action -> result>"
}`;

            const response = await this.client.chat.completions.create({
                model: OPENAI_MODEL_STEP,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: JSON.stringify(systemPrompt, null, 2) },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: userPromptText },
                            { type: 'image_url', image_url: { url: `data:${extBefore};base64,${beforeBase64}` } },
                            { type: 'image_url', image_url: { url: `data:${extAfter};base64,${afterBase64}` } }
                        ]
                    }
                ],
                temperature: 0.1
            });

            return this.parseAiResponse(response.choices[0].message.content);

        } catch (error) {
            console.warn(`[WARN] AI Evaluator error: ${error.message}`);
            return {
                ai_score: -1,
                ai_verdict: 'ERROR',
                ai_reason: `API call failed: ${error.message}`,
            };
        }
    }

    /**
     * Evaluate Add-to-Cart confirmation evidence images.
     * Focuses on both full viewport and specific cart popup area.
     *
     * @param {object} images - { viewportPath, elementPath }
     * @param {object} context - Optional context from code-based verification
     */
    async evaluateCartResult(images, context = {}) {
        if (!this.enabled || !this.client) {
            return this.getDisabledResult();
        }

        const { viewportPath, elementPath } = images || {};
        const hasViewport = viewportPath && fs.existsSync(viewportPath);
        const hasElement = elementPath && fs.existsSync(elementPath);

        if (!hasViewport && !hasElement) {
            return {
                ai_score: -1,
                ai_verdict: 'SKIP',
                ai_reason: 'No cart evidence screenshots found.',
            };
        }

        try {
            const sharp = require('sharp');
            const prepareImage = async (p, w) => {
                let buf = fs.readFileSync(p);
                try {
                    buf = await sharp(buf)
                        .resize({ width: w, withoutEnlargement: true })
                        .removeAlpha()
                        .jpeg({ quality: 80 })
                        .toBuffer();
                } catch (e) { /* fallback */ }
                return buf.toString('base64');
            };

            const imageContent = [];
            
            if (hasViewport) {
                const b64 = await prepareImage(viewportPath, 1024);
                imageContent.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' }
                });
            }
            
            if (hasElement) {
                const b64 = await prepareImage(elementPath, 640);
                imageContent.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' }
                });
            }

            const systemPrompt = {
                rules: [
                    'You are an AI QA validator for e-commerce cart confirmation UI.',
                    'Decision Rule: decides whether Add to Cart appears successful.',
                    'Image 1 (if present): Full viewport for spatial context.',
                    'Image 2 (if present): Zoomed-in element for detail.',
                    'Strong signals: "Items in cart" drawer, popup summary, success checkmark, badge increment, "View Cart" button.',
                    'Ignore: Background page content unless it overlaps with confirmation.',
                    'Return ONLY valid JSON.'
                ],
                output_schema: {
                    ai_score: 'number 0..100',
                    ai_verdict: '"PASS" | "FAIL"',
                    ai_reason: 'short reason'
                }
            };

            const userPromptText = `Code-side context:
- method: ${context.method || 'unknown'}
- message: ${context.message || 'n/a'}

Analyze the provided image(s) and decide if the Add to Cart action was successful.
Respond strictly in JSON:
{
  "ai_score": 100,
  "ai_verdict": "PASS",
  "ai_reason": "..."
}`;

            const response = await this.client.chat.completions.create({
                model: OPENAI_MODEL_STEP,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: JSON.stringify(systemPrompt, null, 2) },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: userPromptText },
                            ...imageContent
                        ]
                    }
                ],
                temperature: 0.1
            });

            return this.parseAiResponse(response.choices[0].message.content);
        } catch (error) {
            return {
                ai_score: -1,
                ai_verdict: 'ERROR',
                ai_reason: `Cart AI evaluation failed: ${error.message}`,
            };
        }
    }

    /**
     * Evaluate if an interaction (like opening a menu) was successful.
     * Focuses on visual cues like popups, lists, or new overlays appearing.
     */
    async evaluateInteraction(beforePath, afterPath, actionName, valueChosen = '', isLabelConfirmed = false) {
        if (!this.generalAiEnabled || !this.client) {
            return this.getDisabledResult();
        }

        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return { ai_score: -1, ai_verdict: 'SKIP', ai_reason: 'Screenshots not found.' };
        }

        try {
            const sharp = require('sharp');
            const prepare = async (p) => {
                let buf = fs.readFileSync(p);
                try {
                    buf = await sharp(buf).resize({ width: 640 }).removeAlpha().jpeg().toBuffer();
                } catch (e) {}
                return buf.toString('base64');
            };

            const b64Before = await prepare(beforePath);
            const b64After = await prepare(afterPath);

            let structuralNotice = '';
            if (isLabelConfirmed && valueChosen) {
                structuralNotice = `\n[CRITICAL EVIDENCE]: The system's DOM scanner has ALREADY confirmed that the choice "${valueChosen}" correctly appeared in the product's customization area. 
                Your task is to find visual confirmation in the After image that supports this fact (e.g., look for the menu that just opened or the text that appeared). 
                If the DOM scan says it's there, you should almost certainly mark this as PASS unless the image is clearly broken or blank.`;
            }

            const systemPrompt = {
                rules: [
                    "You are an AI QA validator for e-commerce interactions.",
                    "The user performed an action: " + actionName,
                    "Determine if the interaction successfully opened a menu, dropdown, modal, or list of choices.",
                    "The product preview image itself might NOT change yet, and that is okay.",
                    "Look for new UI elements (overlays, lists, expanded areas) in the After image.",
                    "Ignore transient popups or discount overlays that are not related to the product customization.",
                    structuralNotice
                ].filter(r => r)
            };

            const userPromptText = `Action: ${actionName}. ${valueChosen ? `Value chosen: ${valueChosen}.` : ''}
            Compare Before and After images. Did the interaction successfully reveal new options or a sub-menu?
            ${structuralNotice}
            Respond in JSON: { "ai_score": 100, "ai_verdict": "PASS" | "FAIL", "ai_reason": "..." }`;

            const response = await this.client.chat.completions.create({
                model: OPENAI_MODEL_STEP,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: JSON.stringify(systemPrompt) },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: userPromptText },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64Before}` } },
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64After}` } }
                        ]
                    }
                ],
                temperature: 0.1
            });

            return this.parseAiResponse(response.choices[0].message.content);
        } catch (error) {
            return { ai_score: -1, ai_verdict: 'ERROR', ai_reason: error.message };
        }
    }

    /**
     * Parse the AI JSON response
     */
    parseAiResponse(text) {
        try {
            let cleaned = text.trim();
            cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
            const parsed = JSON.parse(cleaned);
            const verdictRaw = String(parsed.ai_verdict || 'UNKNOWN').toUpperCase();
            const normalizedVerdict = ['PASS', 'FAIL', 'SKIP', 'SKIPPED', 'ERROR', 'PARSE_ERROR', 'UNKNOWN', 'DISABLED']
                .includes(verdictRaw)
                ? (verdictRaw === 'SKIP' ? 'SKIPPED' : verdictRaw)
                : 'UNKNOWN';
            return {
                ai_score: typeof parsed.ai_score === 'number' ? parsed.ai_score : -1,
                ai_verdict: normalizedVerdict,
                ai_reason: parsed.ai_reason || 'No reason provided.',
                detected_elements: parsed.detected_elements || [],
            };
        } catch {
            return {
                ai_score: -1,
                ai_verdict: 'PARSE_ERROR',
                ai_reason: `Could not parse AI response: ${text.substring(0, 200)}`,
            };
        }
    }

    /**
     * Evaluate the final preview image to detect if it matches expected behavior
     * @param {string} imagePath - Path to the final preview screenshot
     * @param {object} caseReport - The generated case report to use as context
     */
    async evaluateFinalPreview(imagePath, caseReport = {}) {
        if (!this.generalAiEnabled || !this.client) {
            return { ai_verdict: 'DISABLED', ai_reason: 'AI evaluation disabled' };
        }

        if (!fs.existsSync(imagePath)) {
            return { ai_verdict: 'ERROR', ai_reason: 'Final screenshot file not found.' };
        }

        try {
            console.log('  [AI] Processing and sending final preview to AI QA Review (OpenAI)...');

            let imageBuffer = fs.readFileSync(imagePath);
            try {
                const sharp = require('sharp');
                imageBuffer = await sharp(imageBuffer)
                    .resize({ width: 640, withoutEnlargement: true })
                    .removeAlpha()
                    .withMetadata(false)
                    .jpeg()
                    .toBuffer();
            } catch (sharpError) {
                console.warn('  [AI] [WARN] Sharp optimization failed, falling back to original image:', sharpError.message);
            }

            const imageBase64 = imageBuffer.toString('base64');
            const ext = 'image/jpeg';

            // Extract context: timeline steps that show what was customized
            const actionContext = (caseReport.timeline || [])
                .filter(step => step.group_type !== 'lifecycle' && step.value_chosen)
                .map(step => `- Option: "${step.name}", selected value: "${step.value_chosen}"`)
                .join('\n');

            console.log("  [AI DEBUG] actionContext generated:\n" + actionContext);

            const systemPrompt = {
                "rules": [
                    "The preview image is the primary source of truth.",
                    "The automation test report provides context about the intended customization steps but may contain false failures.",
                    "Ignore automation issues that do not affect visual rendering. Examples of ignorable issues include OCR detection failures, font loading failures, analytics or tracking script errors, unrelated network failures, and console warnings.",
                    "Only mark a test as FAIL when there is clear visual evidence that the customization result is incorrect (e.g. uploaded photo missing, custom text missing, incorrect text content, wrong design option applied, layout broken or misaligned, text clipped or unreadable, masking errors hiding the image, or the entire preview is completely blank/white)."
                ],
                "content": {
                    "role": "AI Visual Quality Assurance Validator",
                    "description": "Your job is to analyze a product preview image and verify whether the visual result correctly reflects the customization steps provided in a structured test report. You must act as a neutral QA reviewer and base your conclusions primarily on what is visually observable in the image."
                },
                "construction": {
                    "detection_method": [
                        { "step": 1, "action": "Check if the image is completely blank or white. If so, immediately mark as FAIL and stop further detection." },
                        { "step": 2, "action": "Mentally divide the image into a 10x10 grid." },
                        { "step": 3, "action": "Identify where each element appears within this grid." },
                        { "step": 4, "action": "Estimate a tight bounding box around the element. Avoid including large background areas. Boxes must stay inside the image." },
                        { "step": 5, "action": "Convert that estimation into percentage coordinates relative to the full image: x_pct, y_pct, w_pct, h_pct. Return only integers between 0 and 100." }
                    ],
                    "bounding_box_format": {
                        "x_pct": "horizontal position of top-left corner (0-100)",
                        "y_pct": "vertical position of top-left corner (0-100)",
                        "w_pct": "width of the element (percentage)",
                        "h_pct": "height of the element (percentage)"
                    }
                }
            };

            const userPromptText = `Below are the customization actions detected in the test report:

${actionContext}

Verify whether these customizations appear correctly in the final preview image.

For each customization:
1. Locate it visually in the image.
2. Estimate its bounding box.
3. Compare detected content with expected value.

Return the structured QA result in JSON.
{
  "detected_elements": [
    {
      "field": "<Customization Option Name>",
      "expected": "<Expected value from report>",
      "detected": "<What is visible in the image>",
      "x_pct": number,
      "y_pct": number,
      "w_pct": number,
      "h_pct": number,
      "match": true or false
    }
  ],
  "layout_assessment": {
    "overall_layout_correct": true or false
  },
  "ai_verdict": "PASS" or "FAIL",
  "confidence": number,
  "ai_reason": "<short explanation>"
}`;

            let response;
            try {
                response = await this.client.chat.completions.create({
                    model: OPENAI_MODEL_FINAL,
                    response_format: { type: 'json_object' },
                    messages: [
                        { role: 'system', content: JSON.stringify(systemPrompt, null, 2) },
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: userPromptText },
                                {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:${ext};base64,${imageBase64}`,
                                        detail: 'high'
                                    }
                                }
                            ]
                        }
                    ],
                    temperature: 0.1
                });
            } catch (firstError) {
                if (firstError.status === 429) {
                    console.log(`      [WAIT] Rate limited (429). Waiting 30s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    try {
                        response = await this.client.chat.completions.create({
                            model: OPENAI_MODEL_FINAL,
                            response_format: { type: 'json_object' },
                            messages: [
                                { role: 'system', content: JSON.stringify(systemPrompt, null, 2) },
                                {
                                    role: 'user',
                                    content: [
                                        { type: 'text', text: userPromptText },
                                        {
                                            type: 'image_url',
                                            image_url: {
                                                url: `data:${ext};base64,${imageBase64}`,
                                                detail: 'high'
                                            }
                                        }
                                    ]
                                }
                            ],
                            temperature: 0.1
                        });
                    } catch (retryError) {
                        return { ai_verdict: 'ERROR', ai_reason: 'Rate limited after retry.' };
                    }
                } else {
                    throw firstError;
                }
            }

            const text = response.choices[0].message.content || '';
            const parsed = this.parseAiResponse(text);

            // Assign distinct colors to each detected element for the bounding boxes
            const colors = [
                { r: 239, g: 68, b: 68 },   // Red
                { r: 244, g: 63, b: 94 },   // Rose
                { r: 249, g: 115, b: 22 },  // Orange
                { r: 245, g: 158, b: 11 },  // Amber
                { r: 234, g: 179, b: 8 },   // Yellow
                { r: 132, g: 204, b: 22 },  // Lime
                { r: 34, g: 197, b: 94 },   // Green
                { r: 16, g: 185, b: 129 },  // Emerald
                { r: 20, g: 184, b: 166 },  // Teal
                { r: 6, g: 182, b: 212 },   // Cyan
                { r: 14, g: 165, b: 233 },  // Sky
                { r: 59, g: 130, b: 246 },  // Blue
                { r: 99, g: 102, b: 241 },  // Indigo
                { r: 139, g: 92, b: 246 },  // Violet
                { r: 168, g: 85, b: 247 },  // Purple
                { r: 217, g: 70, b: 239 },  // Fuchsia
                { r: 236, g: 72, b: 153 },  // Pink
                { r: 100, g: 116, b: 139 }, // Slate
                { r: 107, g: 114, b: 128 }, // Gray
                { r: 161, g: 98, b: 7 },    // Bronze
            ];

            const detected_elements = Array.isArray(parsed.detected_elements) ? parsed.detected_elements : [];
            detected_elements.forEach((element, idx) => {
                element.color = colors[idx % colors.length];
                // Convert percentage bounding box back into [0-1000] normalized system
                if (typeof element.x_pct === 'number' && typeof element.y_pct === 'number' && typeof element.w_pct === 'number' && typeof element.h_pct === 'number') {
                    const x1 = Math.max(0, Math.min(1000, Math.round(element.x_pct * 10)));
                    const y1 = Math.max(0, Math.min(1000, Math.round(element.y_pct * 10)));
                    const w = Math.max(0, Math.min(1000, Math.round(element.w_pct * 10)));
                    const h = Math.max(0, Math.min(1000, Math.round(element.h_pct * 10)));
                    element.bbox = [x1, y1, Math.min(1000, x1 + w), Math.min(1000, y1 + h)];
                } else if (!element.bbox) {
                    element.bbox = [0, 0, 0, 0];
                }
            });

            return {
                ai_verdict: parsed.ai_verdict,
                ai_reason: parsed.ai_reason || (parsed.layout_assessment ? `Layout: ${parsed.layout_assessment.overall_layout_correct ? 'Correct' : 'Broken'}. ` : ''),
                detected_elements: detected_elements
            };

        } catch (error) {
            console.error('[ERR] AI Final Review error:', error.message);
            return { ai_verdict: 'ERROR', ai_reason: `API call failed: ${error.message}` };
        }
    }

    getDisabledResult() {
        return {
            ai_score: -1,
            ai_verdict: 'DISABLED',
            ai_reason: 'AI evaluation is disabled (no API key provided).',
        };
    }

}

module.exports = AiEvaluator;
