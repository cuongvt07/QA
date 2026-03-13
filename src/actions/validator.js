/**
 * Validator Module
 * Validates preview images, visual diffs, and cart state.
 */

const fs = require('fs');
const path = require('path');

/**
 * Check if preview image is loaded correctly on the page
 */
async function validatePreviewImage(page) {
    const imgSelectors = [
        '.customily-preview img',
        '#customily-main-image',
        'img[class*="preview"]',
        '.preview-image img',
        '#product-image img',
        '.product-image-main img',
    ];

    for (const selector of imgSelectors) {
        const imgs = await page.$$(selector);
        for (const img of imgs) {
            const isVisible = await img.isVisible();
            if (!isVisible) continue;

            const naturalWidth = await img.evaluate((el) => el.naturalWidth);
            if (naturalWidth === 0) {
                return {
                    valid: false,
                    error: 'BROKEN_IMAGE_LINK',
                    message: `Image has naturalWidth=0: ${selector}`,
                };
            }
            return { valid: true, error: null, message: 'Preview image loaded.' };
        }
    }

    // Check for canvas
    const canvas = await page.$('canvas');
    if (canvas && await canvas.isVisible()) {
        const isBlank = await canvas.evaluate((el) => {
            const ctx = el.getContext('2d');
            if (!ctx) return true;
            const data = ctx.getImageData(0, 0, el.width, el.height).data;
            const firstPixel = [data[0], data[1], data[2]];
            let allSame = true;
            for (let i = 4; i < data.length; i += 4) {
                if (data[i] !== firstPixel[0] || data[i + 1] !== firstPixel[1] || data[i + 2] !== firstPixel[2]) {
                    allSame = false;
                    break;
                }
            }
            return allSame;
        });

        if (isBlank) {
            return {
                valid: false,
                error: 'CANVAS_CRASH',
                message: 'Canvas rendered a blank/single-color image.',
            };
        }
        return { valid: true, error: null, message: 'Canvas preview rendered.' };
    }

    return {
        valid: false,
        error: 'PREVIEW_RENDER_FAIL',
        message: 'No preview image or canvas found on page.',
    };
}

/**
 * Calculate pixel diff between two PNG screenshots
 * Returns diff percentage (0 = identical, 100 = completely different)
 */
async function calculateVisualDiff(beforePath, afterPath) {
    try {
        const { PNG } = require('pngjs');
        const pixelmatch = require('pixelmatch');

        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return { diffPercent: -1, error: 'Screenshot file not found' };
        }

        const img1 = PNG.sync.read(fs.readFileSync(beforePath));
        const img2 = PNG.sync.read(fs.readFileSync(afterPath));

        const width = Math.min(img1.width, img2.width);
        const height = Math.min(img1.height, img2.height);

        // Resize if needed (crop to smallest)
        const resizedImg1 = cropPng(img1, width, height);
        const resizedImg2 = cropPng(img2, width, height);

        const diff = new PNG({ width, height });
        const numDiffPixels = pixelmatch(
            resizedImg1.data,
            resizedImg2.data,
            diff.data,
            width,
            height,
            { threshold: 0.1 }
        );

        const totalPixels = width * height;
        const diffPercent = ((numDiffPixels / totalPixels) * 100).toFixed(2);

        return { diffPercent: parseFloat(diffPercent), error: null };
    } catch (error) {
        return { diffPercent: -1, error: error.message };
    }
}

/**
 * Crop a PNG to specific dimensions
 */
function cropPng(png, width, height) {
    const { PNG } = require('pngjs');
    const cropped = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const srcIdx = (png.width * y + x) << 2;
            const dstIdx = (width * y + x) << 2;
            cropped.data[dstIdx] = png.data[srcIdx];
            cropped.data[dstIdx + 1] = png.data[srcIdx + 1];
            cropped.data[dstIdx + 2] = png.data[srcIdx + 2];
            cropped.data[dstIdx + 3] = png.data[srcIdx + 3];
        }
    }
    return cropped;
}

/**
 * Verify cart was updated after Add to Cart click
 */
async function verifyCart(page) {
    await page.waitForTimeout(3000);

    // Check URL redirect
    const url = page.url();
    if (url.includes('/cart') || url.includes('/checkout')) {
        return { success: true, method: 'redirect', message: `Redirected to: ${url}` };
    }

    // Check cart badge count
    const cartBadgeSelectors = [
        '.cart-count',
        '.cart-item-count',
        '#cart-count',
        '[class*="cart-count"]',
        '[class*="cart-badge"]',
        '.header-cart .count',
    ];

    for (const selector of cartBadgeSelectors) {
        const badge = await page.$(selector);
        if (badge) {
            const text = await badge.textContent();
            const count = parseInt(text, 10);
            if (count > 0) {
                return { success: true, method: 'badge', message: `Cart count: ${count}` };
            }
        }
    }

    // Check for success notification
    const successSelectors = [
        '.alert-success',
        '.notification-success',
        '[class*="success"]',
        '.toast-success',
    ];

    for (const selector of successSelectors) {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
            return { success: true, method: 'notification', message: 'Success notification detected.' };
        }
    }

    return { success: false, method: null, message: 'ADD_TO_CART_FAIL: Could not verify cart update.' };
}

module.exports = {
    validatePreviewImage,
    calculateVisualDiff,
    verifyCart,
};
