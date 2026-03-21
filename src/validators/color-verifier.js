/**
 * Color Verifier
 * Uses colorthief to extract the dominant color from a delta zone and compares it with the expected hex.
 */

const ColorThief = require('colorthief');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Verifies if the color in the diff zone matches the expected hex.
 * 
 * @param {string} imagePath - Path to the 'after' image
 * @param {Object} diffMask - {x, y, w, h} bounding box
 * @param {string} expectedHex - Expected color in #RRGGBB format
 * @returns {Promise<Object>} Verification result
 */
async function verifyColor(imagePath, diffMask, expectedHex) {
    if (!diffMask || !expectedHex) return { result: 'SKIPPED', availability: 'UNAVAILABLE' };
    if (!diffMask.w || !diffMask.h || diffMask.w <= 0 || diffMask.h <= 0) {
        return { result: 'SKIPPED', message: 'Invalid diffMask dimensions.', availability: 'UNAVAILABLE' };
    }

    const randomSuffix = Math.round(Math.random() * 10000);
    const tempCropPath = path.join(process.cwd(), 'tmp', `color_crop_${Date.now()}_${randomSuffix}.png`);
    
    try {
        // Ensure tmp directory exists
        const tmpDir = path.join(process.cwd(), 'tmp');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

        // Crop the delta zone for accurate color extraction
        await sharp(imagePath)
            .extract({
                left: Math.round(diffMask.x),
                top: Math.round(diffMask.y),
                width: Math.round(diffMask.w),
                height: Math.round(diffMask.h)
            })
            .toFile(tempCropPath);

        const color = await ColorThief.getColor(tempCropPath);
        if (!color || !Array.isArray(color) || color.length < 3) {
            throw new Error('Failed to extract dominant color');
        }
        const [r, g, b] = color;
        const actualHex = rgbToHex(r, g, b);
        
        const distance = calculateColorDistance(hexToRgb(expectedHex), { r, g, b });
        const result = distance < 25 ? 'PASS' : (distance < 50 ? 'WARNING' : 'FAIL');

        // Cleanup
        if (fs.existsSync(tempCropPath)) fs.unlinkSync(tempCropPath);

        return {
            expected: expectedHex,
            actual: actualHex,
            distance,
            result,
            confidence: Math.max(0, 1 - distance / 100),
            availability: 'AVAILABLE'
        };
    } catch (error) {
        if (fs.existsSync(tempCropPath)) fs.unlinkSync(tempCropPath);
        return { result: 'ERROR', message: error.message, availability: 'UNAVAILABLE' };
    }
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
}

function calculateColorDistance(c1, c2) {
    // Simple Euclidean distance in RGB space
    return Math.sqrt(
        Math.pow(c1.r - c2.r, 2) +
        Math.pow(c1.g - c2.g, 2) +
        Math.pow(c1.b - c2.b, 2)
    ) / Math.sqrt(3 * Math.pow(255, 2)) * 100;
}

module.exports = {
    verifyColor
};
