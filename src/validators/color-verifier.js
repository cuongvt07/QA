/**
 * Color Verifier
 * CPU-only color verification using perceptual DeltaE 2000 instead of raw RGB distance.
 */

const ColorThief = require('colorthief');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const DELTA_E_PASS = parseFloat(process.env.COLOR_DELTAE_PASS || '2');
const DELTA_E_WARNING = parseFloat(process.env.COLOR_DELTAE_WARNING || '6');

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
    } : { r: 0, g: 0, b: 0 };
}

function srgbToLinear(value) {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function rgbToXyz({ r, g, b }) {
    const rl = srgbToLinear(r);
    const gl = srgbToLinear(g);
    const bl = srgbToLinear(b);
    return {
        x: (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) * 100,
        y: (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) * 100,
        z: (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) * 100,
    };
}

function pivotXyz(value) {
    const delta = 6 / 29;
    return value > Math.pow(delta, 3)
        ? Math.cbrt(value)
        : (value / (3 * delta * delta)) + 4 / 29;
}

function xyzToLab({ x, y, z }) {
    const xr = x / 95.047;
    const yr = y / 100.0;
    const zr = z / 108.883;

    const fx = pivotXyz(xr);
    const fy = pivotXyz(yr);
    const fz = pivotXyz(zr);

    return {
        L: (116 * fy) - 16,
        a: 500 * (fx - fy),
        b: 200 * (fy - fz),
    };
}

function rgbToLab(rgb) {
    return xyzToLab(rgbToXyz(rgb));
}

function computeDeltaE2000(rgb1, rgb2) {
    const lab1 = rgbToLab(rgb1);
    const lab2 = rgbToLab(rgb2);

    const avgLp = (lab1.L + lab2.L) / 2;
    const c1 = Math.sqrt((lab1.a ** 2) + (lab1.b ** 2));
    const c2 = Math.sqrt((lab2.a ** 2) + (lab2.b ** 2));
    const avgC = (c1 + c2) / 2;

    const g = 0.5 * (1 - Math.sqrt((avgC ** 7) / ((avgC ** 7) + (25 ** 7))));
    const a1p = (1 + g) * lab1.a;
    const a2p = (1 + g) * lab2.a;
    const c1p = Math.sqrt((a1p ** 2) + (lab1.b ** 2));
    const c2p = Math.sqrt((a2p ** 2) + (lab2.b ** 2));
    const avgCp = (c1p + c2p) / 2;

    const h1p = Math.atan2(lab1.b, a1p) >= 0 ? Math.atan2(lab1.b, a1p) : Math.atan2(lab1.b, a1p) + 2 * Math.PI;
    const h2p = Math.atan2(lab2.b, a2p) >= 0 ? Math.atan2(lab2.b, a2p) : Math.atan2(lab2.b, a2p) + 2 * Math.PI;

    let deltaHp = h2p - h1p;
    if (Math.abs(deltaHp) > Math.PI) {
        deltaHp -= Math.sign(deltaHp) * 2 * Math.PI;
    }

    const deltaLp = lab2.L - lab1.L;
    const deltaCp = c2p - c1p;
    const deltaBigHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(deltaHp / 2);

    const avgHp = (() => {
        if (Math.abs(h1p - h2p) > Math.PI) {
            return (h1p + h2p + 2 * Math.PI) / 2;
        }
        return (h1p + h2p) / 2;
    })();

    const t = 1
        - 0.17 * Math.cos(avgHp - (Math.PI / 6))
        + 0.24 * Math.cos(2 * avgHp)
        + 0.32 * Math.cos((3 * avgHp) + (Math.PI / 30))
        - 0.20 * Math.cos((4 * avgHp) - ((63 * Math.PI) / 180));

    const deltaTheta = ((30 * Math.PI) / 180) * Math.exp(-1 * ((((avgHp * 180 / Math.PI) - 275) / 25) ** 2));
    const rc = 2 * Math.sqrt((avgCp ** 7) / ((avgCp ** 7) + (25 ** 7)));
    const sl = 1 + ((0.015 * ((avgLp - 50) ** 2)) / Math.sqrt(20 + ((avgLp - 50) ** 2)));
    const sc = 1 + 0.045 * avgCp;
    const sh = 1 + 0.015 * avgCp * t;
    const rt = -Math.sin(2 * deltaTheta) * rc;

    return Math.sqrt(
        (deltaLp / sl) ** 2 +
        (deltaCp / sc) ** 2 +
        (deltaBigHp / sh) ** 2 +
        rt * (deltaCp / sc) * (deltaBigHp / sh)
    );
}

async function extractRepresentativeColor(imagePath, diffMask) {
    const image = sharp(imagePath);
    const metadata = await image.metadata();

    const left = Math.max(0, Math.floor(diffMask.x));
    const top = Math.max(0, Math.floor(diffMask.y));
    const width = Math.max(1, Math.min(Math.floor(diffMask.w), (metadata.width || 1) - left));
    const height = Math.max(1, Math.min(Math.floor(diffMask.h), (metadata.height || 1) - top));

    const cropBuffer = await image
        .extract({ left, top, width, height })
        .resize({ width: Math.min(width, 128), height: Math.min(height, 128), fit: 'inside' })
        .png()
        .toBuffer();

    try {
        const stats = await sharp(cropBuffer).stats();
        if (stats && stats.dominant && Number.isFinite(stats.dominant.r)) {
            return {
                color: {
                    r: Math.round(stats.dominant.r),
                    g: Math.round(stats.dominant.g),
                    b: Math.round(stats.dominant.b),
                },
                method: 'sharp-dominant',
            };
        }
    } catch (statsError) {
        // Fallback to ColorThief below.
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
    const tempCropPath = path.join(tmpDir, `color_crop_${Date.now()}_${Math.round(Math.random() * 10000)}.png`);

    try {
        await fs.promises.writeFile(tempCropPath, cropBuffer);
        const color = await ColorThief.getColor(tempCropPath);
        if (!color || !Array.isArray(color) || color.length < 3) {
            throw new Error('Failed to extract dominant color');
        }
        return {
            color: { r: color[0], g: color[1], b: color[2] },
            method: 'colorthief',
        };
    } finally {
        if (fs.existsSync(tempCropPath)) fs.unlinkSync(tempCropPath);
    }
}

async function verifyColor(imagePath, diffMask, expectedHex) {
    if (!diffMask || !expectedHex) return { result: 'SKIPPED', availability: 'UNAVAILABLE' };
    if (!diffMask.w || !diffMask.h || diffMask.w <= 0 || diffMask.h <= 0) {
        return { result: 'SKIPPED', message: 'Invalid diffMask dimensions.', availability: 'UNAVAILABLE' };
    }

    try {
        const expected = hexToRgb(expectedHex);
        const { color: actual, method } = await extractRepresentativeColor(imagePath, diffMask);
        const actualHex = rgbToHex(actual.r, actual.g, actual.b);
        const deltaE = computeDeltaE2000(expected, actual);

        let result = 'FAIL';
        if (deltaE < DELTA_E_PASS) result = 'PASS';
        else if (deltaE < DELTA_E_WARNING) result = 'WARNING';

        return {
            expected: expectedHex,
            actual: actualHex,
            deltaE: parseFloat(deltaE.toFixed(2)),
            distance: parseFloat(deltaE.toFixed(2)),
            result,
            confidence: Math.max(0, 1 - Math.min(deltaE, 12) / 12),
            method,
            availability: 'AVAILABLE',
        };
    } catch (error) {
        return { result: 'ERROR', message: error.message, availability: 'UNAVAILABLE' };
    }
}

module.exports = {
    verifyColor,
    rgbToHex,
    hexToRgb,
    rgbToLab,
    computeDeltaE2000,
    extractRepresentativeColor,
};
