/**
 * SSD Matcher Utility
 * Pure JS implementation of Template Matching using Sum of Squared Differences (SSD).
 * Optimized with step sampling and row skipping for performance.
 */

const sharp = require('sharp');

async function ssdMatch(previewPath, templateBuffer, diffMask) {
    if (!diffMask || diffMask.w <= 0 || diffMask.h <= 0) return null;

    try {
        // 1. Get Search Area raw pixels (limited to diffMask)
        const searchBuffer = await sharp(previewPath)
            .extract({
                left: Math.round(diffMask.x),
                top: Math.round(diffMask.y),
                width: Math.round(diffMask.w),
                height: Math.round(diffMask.h)
            })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const searchPixels = searchBuffer.data;
        const { width: sw, height: sh } = searchBuffer.info;

        // 2. Adaptive Scale Range
        const templateMeta = await sharp(templateBuffer).metadata();
        const scales = [0.4, 0.6, 0.8, 1.0, 1.2]; // Base scales
        
        let best = null;

        for (const scale of scales) {
            const tw = Math.round(templateMeta.width * scale);
            const th = Math.round(templateMeta.height * scale);

            if (tw > sw || th > sh || tw < 10 || th < 10) continue;

            const templateResized = await sharp(templateBuffer)
                .resize(tw, th)
                .greyscale()
                .raw()
                .toBuffer();

            const result = slidingWindowSSD(
                searchPixels, { width: sw, height: sh },
                templateResized, { width: tw, height: th }
            );

            if (!best || result.normalizedScore > best.confidence) {
                best = { 
                    x: result.x + diffMask.x, 
                    y: result.y + diffMask.y, 
                    w: tw, 
                    h: th, 
                    confidence: result.normalizedScore 
                };
            }
        }

        if (!best || best.confidence < 0.45) return null;

        return {
            ...best,
            source: 'js-ssd'
        };
    } catch (err) {
        console.warn(`    [SSD] Matcher error: ${err.message}`);
        return null;
    }
}

function slidingWindowSSD(searchPixels, searchInfo, templatePixels, templateInfo) {
    const { width: sw, height: sh } = searchInfo;
    const { width: tw, height: th } = templateInfo;

    let minSSD = Infinity;
    let bestX = 0, bestY = 0;

    // Optimized step and sampling
    const step = 4;
    const sampleStep = 2;

    for (let y = 0; y <= sh - th; y += step) {
        for (let x = 0; x <= sw - tw; x += step) {
            let ssd = 0;
            // Iterate over template pixels with sampling
            for (let ty = 0; ty < th; ty += sampleStep) {
                for (let tx = 0; tx < tw; tx += sampleStep) {
                    const sIdx = (y + ty) * sw + (x + tx);
                    const tIdx = ty * tw + tx;
                    const diff = searchPixels[sIdx] - templatePixels[tIdx];
                    ssd += diff * diff;
                }
            }
            if (ssd < minSSD) {
                minSSD = ssd;
                bestX = x;
                bestY = y;
            }
        }
    }

    // Normalize score (1.0 = perfect match)
    // /4 because of sampleStep=2 in both axes
    const totalSamples = (tw / sampleStep) * (th / sampleStep);
    const maxPossibleSSD = totalSamples * 255 * 255;
    const normalizedScore = 1 - (minSSD / maxPossibleSSD);

    return { x: bestX, y: bestY, minSSD, normalizedScore };
}

module.exports = {
    ssdMatch
};
