/**
 * OCR Validator — Uses Tesseract.js to verify typed text on preview images.
 * Singleton worker for efficient reuse across steps.
 */

const Tesseract = require('tesseract.js');
const path = require('path');

let worker = null;

/**
 * Initialize the Tesseract worker (call once, reuse across steps)
 */
async function initOcrWorker() {
    if (worker) return;
    worker = await Tesseract.createWorker('eng');
    console.log('    🔍 OCR Worker initialized (Tesseract.js)');
}

/**
 * Shut down the worker to free resources
 */
async function terminateOcrWorker() {
    if (worker) {
        await worker.terminate();
        worker = null;
    }
}

/**
 * Verify that expected text appears on the preview image.
 *
 * @param {string} imagePath - Absolute path to the screenshot PNG
 * @param {string} expectedText - The text that was typed into the input
 * @returns {{ found: boolean, confidence: number, extractedText: string, matchDetail: string }}
 */
async function verifyTextOnPreview(imagePath, expectedText) {
    if (!worker) {
        await initOcrWorker();
    }

    if (!expectedText || expectedText.trim().length === 0) {
        return {
            found: false,
            confidence: 0,
            extractedText: '',
            matchDetail: 'No expected text provided',
        };
    }

    try {
        const { data } = await worker.recognize(imagePath);
        const extractedText = data.text || '';
        const confidence = data.confidence || 0;

        // Normalize for comparison: lowercase, trim whitespace
        const normalizedExpected = expectedText.toLowerCase().trim();
        const normalizedExtracted = extractedText.toLowerCase().trim();

        // Strategy 1: Exact substring match
        if (normalizedExtracted.includes(normalizedExpected)) {
            return {
                found: true,
                confidence,
                extractedText: extractedText.trim(),
                matchDetail: `Exact match found for "${expectedText}"`,
            };
        }

        // Strategy 2: Fuzzy match — allow OCR errors (1-2 chars difference)
        const found = fuzzyContains(normalizedExtracted, normalizedExpected);
        return {
            found,
            confidence,
            extractedText: extractedText.trim(),
            matchDetail: found
                ? `Fuzzy match found for "${expectedText}"`
                : `Text "${expectedText}" not found in OCR output`,
        };

    } catch (error) {
        return {
            found: false,
            confidence: 0,
            extractedText: '',
            matchDetail: `OCR error: ${error.message}`,
        };
    }
}

/**
 * Fuzzy substring match: check if needle appears in haystack
 * with at most `maxErrors` character differences.
 * Uses a simple sliding window + Levenshtein distance approach.
 */
function fuzzyContains(haystack, needle, maxErrors = 2) {
    if (needle.length === 0) return true;
    if (haystack.length === 0) return false;

    // For very short text (1-3 chars), require exact match
    if (needle.length <= 3) {
        maxErrors = 0;
    }

    const windowSize = needle.length;

    for (let i = 0; i <= haystack.length - windowSize + maxErrors; i++) {
        const end = Math.min(i + windowSize + maxErrors, haystack.length);
        const window = haystack.substring(i, end);

        if (levenshteinDistance(window, needle) <= maxErrors) {
            return true;
        }
    }

    return false;
}

/**
 * Simple Levenshtein distance implementation
 */
function levenshteinDistance(a, b) {
    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b[i - 1] === a[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

module.exports = {
    initOcrWorker,
    terminateOcrWorker,
    verifyTextOnPreview,
};
