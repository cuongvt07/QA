/**
 * AI Evaluator Module
 * Uses Google Gemini Vision API to evaluate preview screenshots.
 * Runs in parallel with Pixelmatch code-based checks.
 */

const fs = require('fs');

const GEMINI_MODEL = 'gemini-2.0-flash';

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
