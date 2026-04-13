/**
 * Verifier Utility
 * Performs deterministic checks (DeltaE color + OCR) on a specific bounding box.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ocrValidator = require('./ocr-validator');
const { computeDeltaE2000, extractRepresentativeColor, rgbToHex, hexToRgb } = require('../validators/color-verifier');

async function verifyZone(previewPath, bbox, step) {
    if (!bbox || bbox.w <= 0 || bbox.h <= 0) {
        return { results: {}, croppedPath: null };
    }

    let tmpDir = path.join(process.cwd(), 'tmp');
    try {
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        fs.accessSync(tmpDir, fs.constants.W_OK);
    } catch (e) {
        const os = require('os');
        tmpDir = path.join(os.tmpdir(), 'customily-qa-tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    }

    const randomSuffix = Math.round(Math.random() * 1000000);
    const croppedPath = path.join(tmpDir, `verify-${Date.now()}-${randomSuffix}.png`);
    const results = {};

    try {
        await sharp(previewPath)
            .extract({
                left: Math.max(0, Math.round(bbox.x)),
                top: Math.max(0, Math.round(bbox.y)),
                width: Math.max(1, Math.round(bbox.w)),
                height: Math.max(1, Math.round(bbox.h)),
            })
            .png()
            .toFile(croppedPath);

        if (step.option_color_hex && step.option_color_hex !== '#FFFFFF' && step.option_color_hex !== 'TINYINT(1)') {
            try {
                const { color: actual, method } = await extractRepresentativeColor(croppedPath, {
                    x: 0,
                    y: 0,
                    w: Math.max(1, Math.round(bbox.w)),
                    h: Math.max(1, Math.round(bbox.h)),
                });
                const actualHex = rgbToHex(actual.r, actual.g, actual.b);
                const deltaE = computeDeltaE2000(hexToRgb(step.option_color_hex), actual);

                let result = 'FAIL';
                if (deltaE < 2) result = 'PASS';
                else if (deltaE < 6) result = 'WARNING';

                results.color = {
                    expected: step.option_color_hex,
                    actual: actualHex,
                    deltaE: parseFloat(deltaE.toFixed(2)),
                    distance: parseFloat(deltaE.toFixed(2)),
                    result,
                    pass: result === 'PASS',
                    method,
                };
            } catch (ce) {
                console.warn(`    [VERIFIER] Color check failed: ${ce.message}`);
            }
        }

        if (step.group_type === 'text_input' && step.value_chosen) {
            try {
                const ocrResult = await ocrValidator.verifyTextOnPreview(croppedPath, step.value_chosen, {
                    includeRawFallback: true,
                });
                results.ocr = {
                    expected: step.value_chosen,
                    actual: ocrResult.extractedText,
                    confidence: ocrResult.confidence,
                    pass: ocrResult.found,
                    matchDetail: ocrResult.matchDetail,
                    preprocess: ocrResult.preprocess,
                };
            } catch (oe) {
                console.warn(`    [VERIFIER] OCR check failed: ${oe.message}`);
            }
        }

        return { croppedPath, results };
    } catch (err) {
        console.error(`    [VERIFIER] Verification failed: ${err.message}`);
        return { results: {}, croppedPath: null };
    }
}

module.exports = {
    verifyZone,
};
