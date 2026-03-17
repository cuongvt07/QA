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
        const fsPromises = require('fs').promises;

        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return { diffPercent: -1, error: 'Screenshot file not found' };
        }

        // Read files asynchronously
        const [beforeBuf, afterBuf] = await Promise.all([
            fsPromises.readFile(beforePath),
            fsPromises.readFile(afterPath)
        ]);

        // Parse PNGs asynchronously
        const parsePng = (buffer) => new Promise((resolve, reject) => {
            new PNG().parse(buffer, (err, data) => err ? reject(err) : resolve(data));
        });

        const [img1, img2] = await Promise.all([
            parsePng(beforeBuf),
            parsePng(afterBuf)
        ]);

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
    await page.waitForTimeout(2000);

    // 1. Check for "Added!" confirmation text on the button itself
    try {
        const addedText = await page.$('.added-to-cart-content');
        if (addedText && await addedText.isVisible()) {
            return { success: true, method: 'button_text', message: 'Button shows "Added!" confirmation.' };
        }
    } catch (e) { /* continue */ }

    // 2. Check right mini-cart drawer structure (Meear style)
    try {
        const drawer = await page.$('[from="right"].mini-cart-drawer, .mini-cart-drawer');
        if (drawer && await drawer.isVisible()) {
            const drawerText = ((await drawer.textContent()) || '').replace(/\s+/g, ' ').trim();
            const hasInCartTitle = /it'?s in the cart|in the cart/i.test(drawerText);
            const hasItem = await drawer.$('.item-summary-product, .item-summary, .list-add-item');
            const hasViewCartBtn = await drawer.$('a.checkout-button[href*="/cart"], a:has-text("View cart"), a:has-text("View Cart")');

            if ((hasInCartTitle && hasItem) || hasViewCartBtn || hasItem) {
                return { success: true, method: 'mini_cart_drawer', message: 'Mini-cart drawer detected with added item summary.' };
            }
        }
    } catch (e) { /* continue */ }

    // 3. Check for the right-side cart summary popup structure
    const itemSummarySelectors = [
        '.item-summary .item-summary-product',
        '.item-summary-product',
        '.list-add-item',
        '.item-summary',
    ];

    for (const selector of itemSummarySelectors) {
        try {
            const el = await page.$(selector);
            if (el && await el.isVisible()) {
                const text = ((await el.textContent()) || '').replace(/\s+/g, ' ').trim();
                const hasCartSignal =
                    /cart|view cart|buy more|price|\$|it'?s in the cart/i.test(text) ||
                    text.length >= 20;

                if (hasCartSignal) {
                    return { success: true, method: 'item_summary_popup', message: `Cart item summary detected: ${selector}` };
                }
            }
        } catch (e) { /* continue */ }
    }

    // 4. Check for cart popup/drawer with "It's in the cart!" or similar
    const cartPopupSelectors = [
        '[class*="cart-popup"]',
        '[class*="cart-drawer"]',
        '[class*="cart-notification"]',
        '[class*="cart-sidebar"]',
        '[class*="mini-cart"]',
        '[class*="ajaxcart"]',
        '[class*="side-cart"]',
    ];

    for (const selector of cartPopupSelectors) {
        try {
            const el = await page.$(selector);
            if (el && await el.isVisible()) {
                const text = (await el.textContent()) || '';
                if (text.includes('cart') || text.includes('Cart') || text.includes('Added')) {
                    return { success: true, method: 'cart_popup', message: `Cart popup detected: ${selector}` };
                }
            }
        } catch (e) { /* continue */ }
    }

    // 5. Check for "View Cart" link/button visible on page
    try {
        const viewCartBtn = await page.$('a:has-text("View Cart"), button:has-text("View Cart"), a:has-text("View cart")');
        if (viewCartBtn && await viewCartBtn.isVisible()) {
            return { success: true, method: 'view_cart_btn', message: 'View Cart button is visible.' };
        }
    } catch (e) { /* continue */ }

    // 6. Check URL redirect to /cart or /checkout
    const url = page.url();
    if (url.includes('/cart') || url.includes('/checkout')) {
        return { success: true, method: 'redirect', message: `Redirected to: ${url}` };
    }

    // 7. Check cart badge count
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

    // 8. Check for generic success notification
    const successSelectors = [
        '.alert-success',
        '.notification-success',
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

/**
 * Capture visual evidence right after Add to Cart.
 * Prioritize right-side popup/item summary area; fallback to viewport screenshot.
 */
async function captureCartEvidence(page, outputDir, filenamePrefix = 'add_to_cart') {
    try {
        if (!outputDir) {
            return { captured: false, viewportPath: '', elementPath: '', selector: null, message: 'No output directory provided.' };
        }

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const popupSelectors = [
            '[from="right"].mini-cart-drawer',
            '.mini-cart-drawer',
            '.mini-cart-padding',
            '.mini-cart-top',
            '.mini-cart-action',
            '.item-summary',
            '.item-box.list-add-item',
            '.item-summary-product',
            '[class*="cart-popup"]',
            '[class*="cart-drawer"]',
            '[class*="cart-notification"]',
            '[class*="side-cart"]',
            '[class*="mini-cart"]',
            '.added-to-cart-content',
        ];

        const elementPath = path.join(outputDir, `${filenamePrefix}_element.png`);
        const viewportPath = path.join(outputDir, `${filenamePrefix}_viewport.png`);

        // Always capture viewport first as primary context
        await page.screenshot({ path: viewportPath, fullPage: false });

        let capturedElement = false;
        let finalSelector = null;

        for (const selector of popupSelectors) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    const box = await el.boundingBox().catch(() => null);
                    if (box && box.width >= 50 && box.height >= 50) {
                        // Use page.screenshot with clip to capture the element PLUS its background
                        // This prevents "transparent" PNGs when the element has no solid background
                        await page.screenshot({ 
                            path: elementPath,
                            clip: {
                                x: Math.max(0, box.x),
                                y: Math.max(0, box.y),
                                width: box.width,
                                height: box.height
                            }
                        });
                        capturedElement = true;
                        finalSelector = selector;
                        break;
                    }
                }
            } catch (e) {
                continue;
            }
        }

        return {
            captured: true,
            viewportPath,
            elementPath: capturedElement ? elementPath : '',
            selector: finalSelector,
            message: capturedElement 
                ? `Captured viewport and element (${finalSelector})` 
                : 'Captured viewport (no specific element found)'
        };
    } catch (error) {
        return {
            captured: false,
            viewportPath: '',
            elementPath: '',
            selector: null,
            message: `Failed to capture cart evidence: ${error.message}`,
        };
    }
}

module.exports = {
    validatePreviewImage,
    calculateVisualDiff,
    verifyCart,
    captureCartEvidence,
};
