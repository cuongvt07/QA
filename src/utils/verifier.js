/**
 * Verifier Utility
 * Performs deterministic checks (Color, OCR) on a specific bounding box.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ColorThief = require('colorthief');
const ocrValidator = require('./ocr-validator');

async function verifyZone(previewPath, bbox, step) {
    if (!bbox || bbox.w <= 0 || bbox.h <= 0) {
        return { results: {}, croppedPath: null };
    }

    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    
    const randomSuffix = Math.round(Math.random() * 1000000);
    const croppedPath = path.join(tmpDir, `verify-${Date.now()}-${randomSuffix}.jpg`);
    const results = {};

    try {
        // Crop exactly the bbox area
        await sharp(previewPath)
            .extract({ 
                left: Math.round(bbox.x), 
                top: Math.round(bbox.y), 
                width: Math.round(bbox.w), 
                height: Math.round(bbox.h) 
            })
            .jpeg({ quality: 90 })
            .toFile(croppedPath);

        // 1. Color Verification
        if (step.option_color_hex && step.option_color_hex !== '#FFFFFF' && step.option_color_hex !== 'TINYINT(1)') {
            try {
                const color = await ColorThief.getColor(croppedPath);
                if (color && Array.isArray(color) && color.length >= 3) {
                    const actualHex = rgbToHex(color[0], color[1], color[2]);
                    const distance = colorDistance(hexToRgb(step.option_color_hex), { r: color[0], g: color[1], b: color[2] });
                    
                    results.color = {
                        expected: step.option_color_hex,
                        actual: actualHex,
                        distance,
                        pass: distance < 50 // Threshold for color match
                    };
                }
            } catch (ce) {
                console.warn(`    [VERIFIER] Color check failed: ${ce.message}`);
            }
        }

        // 2. OCR Verification
        if (step.group_type === 'text_input' && step.value_chosen) {
            try {
                const ocrResult = await ocrValidator.verifyTextOnPreview(croppedPath, step.value_chosen);
                results.ocr = {
                    expected: step.value_chosen,
                    actual: ocrResult.extractedText,
                    confidence: ocrResult.confidence,
                    pass: ocrResult.found
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

// Helpers
function rgbToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
}

function colorDistance(c1, c2) {
    return Math.sqrt(
        Math.pow(c1.r - c2.r, 2) +
        Math.pow(c1.g - c2.g, 2) +
        Math.pow(c1.b - c2.b, 2)
    );
}

module.exports = {
    verifyZone
};
