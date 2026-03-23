/**
 * Delta Fingerprinting Utility
 * Uses pixelmatch to find the exact coordinates of visual changes between two images.
 *
 * CRITICAL FIX (v3):
 *   The bounding-box loop was checking `r!==0 || g!==0 || b!==0`.
 *   pixelmatch writes SAME pixels as grayscale (non-zero RGB), so the loop
 *   always counted every pixel → count = full-canvas → hard-gate triggered → {0,0,0,0}.
 *
 *   Fix: only count pixels where r===255 && g===0 && b===0
 *   (pixelmatch's hardcoded diff color — no custom diffColor was set).
 */

const fs = require('fs');
const pixelmatch = require('pixelmatch');

async function getDiffMask(beforePath, afterPath, options = {}) {
    try {
        const beforeBuf = await fs.promises.readFile(beforePath);
        const afterBuf = await fs.promises.readFile(afterPath);
        return await getDiffMaskFromBuffers(beforeBuf, afterBuf, options);
    } catch (e) {
        console.error(`    ❌ Error reading files for diff mask: ${e.message}`);
        return null;
    }
}

async function getDiffMaskFromBuffers(beforeBuf, afterBuf, options = {}) {
    const padding = options.padding ?? 10;
    try {
        const sharp = require('sharp');

        const beforeMeta = await sharp(beforeBuf).metadata();
        const afterMeta = await sharp(afterBuf).metadata();

        console.log(`    [DIFF] Before: ${beforeMeta.width}x${beforeMeta.height}`);
        console.log(`    [DIFF] After: ${afterMeta.width}x${afterMeta.height}`);

        const width = Math.min(beforeMeta.width || 648, afterMeta.width || 648);
        const height = Math.min(beforeMeta.height || 653, afterMeta.height || 653);

        // ── Load both images as raw RGBA using sharp (accepts PNG/JPEG/WebP) ──
        const getPixels = async (buf) => {
            const { data } = await sharp(buf)
                .extract({ left: 0, top: 0, width, height })
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            // Force alpha=255 to suppress transparency noise
            for (let i = 3; i < data.length; i += 4) data[i] = 255;
            return data;
        };

        const [rawBefore, rawAfter] = await Promise.all([
            getPixels(beforeBuf),
            getPixels(afterBuf),
        ]);

        // ── pixelmatch ────────────────────────────────────────────────────────
        // threshold: 0.1 matches calculateVisualDiff — MUST be consistent.
        // diffData is initialised to 0; pixelmatch writes:
        //   diff pixel  → (255, 0, 0, 255)   ← pure red
        //   same pixel  → (r, g, b, 128)     ← grayscale, non-zero RGB  ← BUG SOURCE
        const diffData = Buffer.alloc(width * height * 4, 0);
        const numDiffPixels = pixelmatch(rawBefore, rawAfter, diffData, width, height, {
            threshold: 0.1,
            includeAA: false,
        });

        console.log(`    [DIFF] numDiffPixels=${numDiffPixels} (${((numDiffPixels / (width * height)) * 100).toFixed(3)}%)`);

        if (numDiffPixels === 0) return { x: 0, y: 0, w: 0, h: 0 };

        // ── Bounding box — count ONLY pure-red diff pixels ───────────────────
        let minX = width, minY = height, maxX = 0, maxY = 0;
        let count = 0;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (width * y + x) * 4;
                // pixelmatch diff color = (255, 0, 0). Grayscale same-pixels have r===g===b.
                if (diffData[i] === 255 && diffData[i + 1] === 0 && diffData[i + 2] === 0) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    count++;
                }
            }
        }

        console.log(`    [DIFF] True diff pixels: ${count}`);
        if (count === 0) return { x: 0, y: 0, w: 0, h: 0 };

        // +1: single-pixel diff → w=1/h=1 instead of 0
        const diffW = (maxX - minX) + 1;
        const diffH = (maxY - minY) + 1;

        console.log(`    [DIFF] Bounding box raw: x=${minX} y=${minY} w=${diffW} h=${diffH}`);

        // Hard-gate: BOTH axes > 90% = full-canvas noise, not a real region
        if (diffW > width * 0.90 && diffH > height * 0.90) {
            console.log(`    [DIFF] Mask too large (${diffW}x${diffH}) — Triggering Fallback.`);
            return { x: 0, y: 0, w: 0, h: 0 };
        }

        const x0 = Math.max(0, minX - padding);
        const y0 = Math.max(0, minY - padding);
        return {
            x: x0,
            y: y0,
            w: Math.min(width - x0, diffW + padding * 2),
            h: Math.min(height - y0, diffH + padding * 2),
        };

    } catch (error) {
        console.error(`    ❌ Error calculating diff mask: ${error.message}`);
        return { x: 0, y: 0, w: 0, h: 0 };
    }
}

async function calculateImageHash(imagePath) {
    try {
        const sharp = require('sharp');
        const buf = await sharp(imagePath)
            .grayscale()
            .resize(8, 8, { fit: 'fill' })
            .raw()
            .toBuffer();

        let avg = 0;
        for (let i = 0; i < 64; i++) avg += buf[i];
        avg /= 64;

        let hash = '';
        for (let i = 0; i < 64; i++) hash += buf[i] >= avg ? '1' : '0';
        return hash;
    } catch (e) {
        return null;
    }
}

module.exports = { getDiffMask, getDiffMaskFromBuffers, calculateImageHash };