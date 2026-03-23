/**
 * OCR Validator
 * CPU-only OCR using Tesseract.js with lightweight Sharp preprocessing.
 */

const Tesseract = require('tesseract.js');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

let worker = null;
let workerInitPromise = null;

async function initOcrWorker() {
    if (worker) return;
    if (workerInitPromise) return workerInitPromise;

    workerInitPromise = (async () => {
        worker = await Tesseract.createWorker('eng');
        if (worker?.setParameters) {
            await worker.setParameters({
                preserve_interword_spaces: '1',
            });
        }
        console.log('    OCR Worker initialized (Tesseract.js)');
        workerInitPromise = null;
    })();
    return workerInitPromise;
}

async function terminateOcrWorker() {
    if (worker) {
        await worker.terminate();
        worker = null;
    }
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function buildNoExpectedResult() {
    return {
        found: false,
        confidence: 0,
        extractedText: '',
        matchDetail: 'No expected text provided',
        preprocess: 'none',
    };
}

function chooseBetterResult(current, candidate) {
    if (!current) return candidate;
    if (!candidate) return current;

    if (candidate.found && !current.found) return candidate;
    if (candidate.found === current.found && candidate.confidence > current.confidence) return candidate;
    if (candidate.found === current.found && candidate.confidence === current.confidence &&
        String(candidate.extractedText || '').length > String(current.extractedText || '').length) {
        return candidate;
    }
    return current;
}

function getNormalizedTokenLength(value) {
    return normalizeText(value).replace(/[^a-z0-9]/g, '').length;
}

function isStrongOcrHit(result, expectedText) {
    if (!result?.found) return false;

    const detail = String(result.matchDetail || '');
    if (/exact match found/i.test(detail)) return true;

    const tokenLength = getNormalizedTokenLength(expectedText);
    if (/fuzzy match found/i.test(detail) && tokenLength > 0 && tokenLength <= 8) {
        return true;
    }

    return Number(result.confidence || 0) >= 75;
}

async function resolveImageBuffer(imageInput) {
    if (Buffer.isBuffer(imageInput)) return imageInput;
    if (typeof imageInput === 'string') {
        return await fs.promises.readFile(imageInput);
    }
    throw new Error('Unsupported OCR image input');
}

async function preprocessForOcr(imageInput, { aggressive = false, scale = 3 } = {}) {
    const inputBuffer = await resolveImageBuffer(imageInput);
    const metadata = await sharp(inputBuffer).metadata();
    const width = Math.max(1, Math.round((metadata.width || 1) * scale));
    const height = Math.max(1, Math.round((metadata.height || 1) * scale));

    let pipeline = sharp(inputBuffer)
        .flatten({ background: '#ffffff' })
        .resize({ width, height, kernel: 'lanczos3' })
        .grayscale()
        .normalize()
        .sharpen();

    if (aggressive) {
        pipeline = pipeline.threshold(170);
    }

    return pipeline.png().toBuffer();
}

function fuzzyContains(haystack, needle, maxErrors = 2) {
    if (needle.length === 0) return true;
    if (haystack.length === 0) return false;

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

function buildMatchResult(data, expectedText, preprocess) {
    const extractedText = data.text || '';
    const confidence = data.confidence || 0;
    const normalizedExpected = normalizeText(expectedText);
    const normalizedExtracted = normalizeText(extractedText);

    if (normalizedExtracted.includes(normalizedExpected)) {
        return {
            found: true,
            confidence,
            extractedText: extractedText.trim(),
            matchDetail: `Exact match found for "${expectedText}"`,
            preprocess,
        };
    }

    const found = fuzzyContains(normalizedExtracted, normalizedExpected);
    return {
        found,
        confidence,
        extractedText: extractedText.trim(),
        matchDetail: found
            ? `Fuzzy match found for "${expectedText}"`
            : `Text "${expectedText}" not found in OCR output`,
        preprocess,
    };
}

async function recognizeCandidate(imageInput, expectedText, preprocess) {
    const buffer = preprocess === 'raw'
        ? await resolveImageBuffer(imageInput)
        : await preprocessForOcr(imageInput, { aggressive: preprocess === 'threshold' });
    const { data } = await worker.recognize(buffer);
    return buildMatchResult(data, expectedText, preprocess);
}

async function verifyTextOnPreview(imageInput, expectedText, options = {}) {
    if (!worker) {
        await initOcrWorker();
    }

    if (!expectedText || expectedText.trim().length === 0) {
        return buildNoExpectedResult();
    }

    try {
        let best = await recognizeCandidate(imageInput, expectedText, 'enhanced');
        if (isStrongOcrHit(best, expectedText)) {
            return best;
        }

        const shouldTryThreshold = !best.found || best.confidence < 70;

        if (shouldTryThreshold) {
            const thresholded = await recognizeCandidate(imageInput, expectedText, 'threshold');
            best = chooseBetterResult(best, thresholded);
            if (isStrongOcrHit(best, expectedText)) {
                return best;
            }
        }

        if (options.includeRawFallback && (!best.found || best.confidence < 60)) {
            const raw = await recognizeCandidate(imageInput, expectedText, 'raw');
            best = chooseBetterResult(best, raw);
        }

        return best;
    } catch (error) {
        return {
            found: false,
            confidence: 0,
            extractedText: '',
            matchDetail: `OCR error: ${error.message}`,
            preprocess: 'error',
        };
    }
}

async function verifyTextOnCrop(imagePath, diffMask, expectedText) {
    if (!worker) await initOcrWorker();
    if (!diffMask || !expectedText) return { found: false, confidence: 0 };
    if (!diffMask.w || !diffMask.h || diffMask.w <= 0 || diffMask.h <= 0) {
        return { found: false, confidence: 0, matchDetail: 'Invalid diffMask dimensions (0 or negative).', preprocess: 'none' };
    }

    try {
        const metadata = await sharp(imagePath).metadata();
        const left = Math.max(0, Math.round(diffMask.x));
        const top = Math.max(0, Math.round(diffMask.y));
        const width = Math.max(1, Math.min(Math.round(diffMask.w), (metadata.width || 1) - left));
        const height = Math.max(1, Math.min(Math.round(diffMask.h), (metadata.height || 1) - top));

        const cropBuffer = await sharp(imagePath)
            .extract({ left, top, width, height })
            .png()
            .toBuffer();

        return await verifyTextOnPreview(cropBuffer, expectedText, { includeRawFallback: true });
    } catch (error) {
        return {
            found: false,
            confidence: 0,
            extractedText: '',
            matchDetail: `OCR crop error: ${error.message}`,
            preprocess: 'error',
        };
    }
}

module.exports = {
    initOcrWorker,
    terminateOcrWorker,
    verifyTextOnPreview,
    verifyTextOnCrop,
    preprocessForOcr,
};
