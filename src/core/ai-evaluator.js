/**
 * AI Evaluator Module
 * Uses Google Gemini Vision API to evaluate preview screenshots.
 * Runs in parallel with Pixelmatch code-based checks.
 */

const fs = require('fs');

const GEMINI_MODEL = 'gemini-2.0-flash-lite';

class AiEvaluator {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.enabled = !!apiKey;
        this.client = null;
    }

    /**
     * Initialize the Gemini client (lazy load)
     */
    async init() {
        if (!this.enabled) return;
        try {
            const { GoogleGenAI } = require('@google/genai');
            this.client = new GoogleGenAI({ apiKey: this.apiKey });
        } catch (error) {
            console.warn('⚠️  AI Evaluator: Failed to initialize @google/genai:', error.message);
            this.enabled = false;
        }
    }

    /**
     * Evaluate a single step by comparing Before/After preview images
     * @param {string} beforePath - Path to before screenshot
     * @param {string} afterPath  - Path to after screenshot
     * @param {string} optionName - Name of the option group (e.g. "Color")
     * @param {string} valueChosen - Value selected (e.g. "Red")
     * @returns {{ ai_score: number, ai_verdict: string, ai_reason: string }}
     */
    async evaluateStep(beforePath, afterPath, optionName, valueChosen) {
        if (!this.enabled || !this.client) {
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
            const beforeBase64 = fs.readFileSync(beforePath, { encoding: 'base64' });
            const afterBase64 = fs.readFileSync(afterPath, { encoding: 'base64' });

            const prompt = this.buildPrompt(optionName, valueChosen);

            const response = await this.client.models.generateContent({
                model: GEMINI_MODEL,
                contents: [
                    {
                        inlineData: {
                            mimeType: 'image/png',
                            data: beforeBase64,
                        },
                    },
                    {
                        inlineData: {
                            mimeType: 'image/png',
                            data: afterBase64,
                        },
                    },
                    { text: prompt },
                ],
            });

            const text = response.text || '';
            return this.parseAiResponse(text);

        } catch (error) {
            console.warn(`⚠️  AI Evaluator error: ${error.message}`);
            return {
                ai_score: -1,
                ai_verdict: 'ERROR',
                ai_reason: `API call failed: ${error.message}`,
            };
        }
    }

    /**
     * Build the evaluation prompt for Gemini
     */
    buildPrompt(optionName, valueChosen) {
        return `You are a QA tester for a custom product website.

Compare these 2 preview images:
- Image 1 (BEFORE): Preview before selecting an option
- Image 2 (AFTER): Preview after selecting "${optionName}" = "${valueChosen}"

Evaluate:
1. Did the preview image change visually?
2. Is the change consistent with the selected option?
3. Are there any rendering errors (blank areas, broken images, missing elements)?

Respond ONLY with valid JSON (no markdown, no backticks):
{"ai_score": <0-100>, "ai_verdict": "PASS" or "FAIL", "ai_reason": "<one line explanation>"}`;
    }

    /**
     * Parse the AI text response into structured data
     */
    parseAiResponse(text) {
        try {
            // Clean markdown code blocks if present
            let cleaned = text.trim();
            cleaned = cleaned.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

            const parsed = JSON.parse(cleaned);
            return {
                ai_score: typeof parsed.ai_score === 'number' ? parsed.ai_score : -1,
                ai_verdict: parsed.ai_verdict || 'UNKNOWN',
                ai_reason: parsed.ai_reason || 'No reason provided.',
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
     * Evaluate the final preview image to detect fatal rendering issues
     * @param {string} imagePath - Path to the final preview screenshot
     * @param {object} context - Expected texts dictionary
     * @returns {object} { ai_verdict: 'PASS' | 'FAIL', ai_reason: string }
     */
    async evaluateFinalPreview(imagePath, context = {}) {
        if (!this.enabled || !this.client) {
            return { ai_verdict: 'DISABLED', ai_reason: 'AI evaluation disabled' };
        }

        if (!fs.existsSync(imagePath)) {
            return { ai_verdict: 'ERROR', ai_reason: 'Final screenshot file not found.' };
        }

        try {
            console.log('  [AI] Sending final preview to AI QA Review...');
            const imageBase64 = fs.readFileSync(imagePath, { encoding: 'base64' });

            const promptText = `
Bạn là một nhân viên kiểm thử hệ thống in ấn Print-on-Demand.
Nhiệm vụ của bạn là check tổng quan ảnh Preview này xem có LỖI CHỨC NĂNG NGHIÊM TRỌNG nào không.

CHỈ ĐÁNH RỚT (FAIL) nếu gặp 1 trong các lỗi chí mạng sau:
1. Chữ bị cắt lẹm hẳn ra ngoài, tràn khung thiết kế.
2. Hiện mã code thô (ví dụ: [Object object], undefined, null).
3. Lỗi font chữ nặng (hiển thị toàn ô vuông [], ký tự rác).
4. WebGL/Canvas bị crash (ảnh trắng bóc, đen xì, hoặc hiện icon rỗng).
5. Đồ họa (người/vật) bị đè lên nhau che khuất mặt một cách phi lý.

Thông tin Text khách đã nhập (nếu có trong thiết kế, hãy xem nó có hiện lên không): 
${JSON.stringify(context)}

LƯU Ý: Đây chỉ là hệ thống check luồng thao tác. HÃY BỎ QUA các lỗi nhỏ về thẩm mỹ, răng cưa, tỷ lệ không hoàn hảo hoặc màu sắc lệch tone. Nếu nhìn tổng thể ổn, hãy trả về PASS.

Respond ONLY with valid JSON (no markdown, no backticks):
{"ai_verdict": "PASS" or "FAIL", "ai_reason": "<one line explanation>"}
`;

            const ext = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

            const requestPayload = {
                model: GEMINI_MODEL,
                contents: [
                    { text: promptText },
                    { inlineData: { mimeType: ext, data: imageBase64 } }
                ],
                config: {
                    temperature: 0.1,
                    responseMimeType: 'application/json',
                }
            };

            // Try with retry on 429
            let response;
            try {
                response = await this.client.models.generateContent(requestPayload);
            } catch (firstError) {
                if (firstError.message && firstError.message.includes('429')) {
                    // Parse retry delay from error message
                    const delayMatch = firstError.message.match(/retry in (\d+)/i);
                    const waitSec = delayMatch ? parseInt(delayMatch[1], 10) + 5 : 45;
                    console.log(`      ⏳ Rate limited (429). Waiting ${waitSec}s before retry...`);
                    await new Promise(resolve => setTimeout(resolve, waitSec * 1000));

                    try {
                        response = await this.client.models.generateContent(requestPayload);
                    } catch (retryError) {
                        console.error('      ❌ AI retry also failed:', retryError.message);
                        return { ai_verdict: 'ERROR', ai_reason: 'Rate limited after retry.' };
                    }
                } else {
                    throw firstError;
                }
            }

            const text = response.text || '';
            const parsed = this.parseAiResponse(text);
            return {
                ai_verdict: parsed.ai_verdict,
                ai_reason: parsed.ai_reason,
            };

        } catch (error) {
            console.error('❌ AI Final Review error:', error.message);
            return { ai_verdict: 'ERROR', ai_reason: `API call failed: ${error.message}` };
        }
    }

    /**
     * Return a placeholder result when AI is disabled
     */
    getDisabledResult() {
        return {
            ai_score: -1,
            ai_verdict: 'DISABLED',
            ai_reason: 'AI evaluation is disabled (no API key provided).',
        };
    }
}

module.exports = AiEvaluator;
