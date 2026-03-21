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
        const fsPromises = require('fs').promises;
        if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
            return { diffPercent: -1, error: 'Screenshot file not found' };
        }
        const [beforeBuf, afterBuf] = await Promise.all([
            fsPromises.readFile(beforePath),
            fsPromises.readFile(afterPath)
        ]);
        return await calculateVisualDiffBuffers(beforeBuf, afterBuf);
    } catch (error) {
        return { diffPercent: -1, error: error.message };
    }
}

/**
 * Calculate pixel diff between two image buffers.
 * Normalizes both images to a common canvas first to avoid size-mismatch -1.
 */
async function calculateVisualDiffBuffers(beforeBuf, afterBuf) {
    try {
        const sharp = require('sharp');
        const { PNG } = require('pngjs');
        const pixelmatch = require('pixelmatch');

        // Get dimensions of both images
        const [metaBefore, metaAfter] = await Promise.all([
            sharp(beforeBuf).metadata(),
            sharp(afterBuf).metadata()
        ]);

        // Use the minimum common canvas to avoid distortion
        const width  = Math.min(metaBefore.width  || 648, metaAfter.width  || 648);
        const height = Math.min(metaBefore.height || 653, metaAfter.height || 653);

        // Normalize: extract common canvas from top-left (no stretching)
        const normalize = (buf) => sharp(buf)
            .extract({ left: 0, top: 0, width, height })
            .ensureAlpha()
            .raw()
            .toBuffer();

        const [raw1, raw2] = await Promise.all([normalize(beforeBuf), normalize(afterBuf)]);

        const diff = Buffer.alloc(width * height * 4);
        const numDiffPixels = pixelmatch(raw1, raw2, diff, width, height, { threshold: 0.1, includeAA: false });

        const totalPixels = width * height;
        const diffPercent = parseFloat(((numDiffPixels / totalPixels) * 100).toFixed(2));
        return { diffPercent, error: null };
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
    // Redundant 2s wait removed as per user request (Wait is already handled in clickAddToCart)

    // 1. Check for "Added!" confirmation text on the button itself
    try {
        const addedText = await page.$('.added-to-cart-content');
        if (addedText && await addedText.isVisible()) {
            return { success: true, method: 'button_text', message: 'Button shows "Added!" confirmation.' };
        }
    } catch (e) { /* continue */ }

    // 1b. Printerval button state change pattern (button disabled or class change after click)
    try {
        const addToCartBtn = await page.$('.customization-add-to-cart, .add-to-cart-btn, button[class*="add-to-cart"]');
        if (addToCartBtn) {
            const btnState = await addToCartBtn.evaluate(node => ({
                isDisabled: node.disabled || node.getAttribute('aria-disabled') === 'true',
                hasAddedClass: node.classList.contains('added') || node.classList.contains('is-added'),
                addedContentVisible: (() => {
                    const addedEl = node.querySelector('.added-to-cart-content');
                    return addedEl ? addedEl.offsetParent !== null : false;
                })(),
                text: node.textContent?.trim().toLowerCase() || '',
            }));
            if (btnState.isDisabled || btnState.hasAddedClass || btnState.addedContentVisible ||
                btnState.text.includes('added') || btnState.text.includes('in cart')) {
                return { success: true, method: 'button_state_change', message: `Button state indicates success: disabled=${btnState.isDisabled}, added=${btnState.hasAddedClass}` };
            }
        }
    } catch (e) { /* continue */ }

    // 1c. WooCommerce patterns
    try {
        const woo = await page.$('.woocommerce-message, .added_to_cart, .wc-block-components-notice');
        if (woo && await woo.isVisible()) {
            return { success: true, method: 'woocommerce', message: 'WooCommerce cart confirmation detected.' };
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

    // 7. Check cart badge count (expanded selectors)
    const cartBadgeSelectors = [
        '.cart-count',
        '.cart-item-count',
        '#cart-count',
        '[class*="cart-count"]',
        '[class*="cart-badge"]',
        '[class*="cart-qty"]',
        '.header-cart .count',
        '.cart-items-count',
        '[data-cart-count]',
    ];

    for (const selector of cartBadgeSelectors) {
        try {
            const badge = await page.$(selector);
            if (badge) {
                const text = await badge.textContent();
                const count = parseInt(text, 10);
                if (count > 0) {
                    return { success: true, method: 'badge', message: `Cart count: ${count}` };
                }
                // Also check data attribute
                const dataCount = await badge.getAttribute('data-cart-count').catch(() => null);
                if (dataCount && parseInt(dataCount, 10) > 0) {
                    return { success: true, method: 'badge_data', message: `Cart data-count: ${dataCount}` };
                }
            }
        } catch (e) { /* continue */ }
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
async function captureCartEvidence(page, outputDir, filenamePrefix = 'step_cart') {
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
            '.minicart-title',
            '.all-item-in-cart',
            '#sub-total-sidebar',
            '.viewcart-button',
            '.checkout-button',
            '.mini-cart-padding',
            '.item-summary',
            '.item-summary-product',
            '[class*="cart-popup"]',
            '[class*="cart-drawer"]',
            '[class*="cart-notification"]',
            '.added-to-cart-content',
        ];

        const panelPath = path.join(outputDir, `${filenamePrefix}_panel.png`);
        const viewportPath = path.join(outputDir, `${filenamePrefix}_viewport.png`);

        // Capture viewport context
        await page.screenshot({ path: viewportPath, fullPage: false });

        let capturedPanel = false;
        let finalSelector = null;

        for (const selector of popupSelectors) {
            try {
                const el = await page.$(selector);
                if (el && await el.isVisible()) {
                    const box = await el.boundingBox().catch(() => null);
                    if (box && box.width >= 50 && box.height >= 50) {
                        await page.screenshot({ 
                            path: panelPath,
                            clip: {
                                x: Math.max(0, box.x),
                                y: Math.max(0, box.y),
                                width: box.width,
                                height: box.height
                            }
                        });
                        capturedPanel = true;
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
            viewport: viewportPath,
            panel: capturedPanel ? panelPath : null,
            selector: finalSelector,
            message: capturedPanel 
                ? `Captured viewport and panel (${finalSelector})` 
                : 'Captured viewport context only.'
        };
    } catch (error) {
        return {
            captured: false,
            viewport: '',
            panel: null,
            selector: null,
            message: `Failed to capture cart evidence: ${error.message}`,
        };
    }
}

/**
 * Quick color similarity check between a cropped area and a reference thumbnail.
 * Returns a score from 0 to 1.
 */
async function quickColorCheck(imagePath, diffMask, thumbUrl) {
    if (!imagePath || !diffMask || diffMask.w <= 0 || diffMask.h <= 0 || !thumbUrl) return 0;
    
    try {
        const sharp = require('sharp');
        const axios = require('axios');

        // Capture area of change from AFTER image
        const cropBuffer = await sharp(imagePath)
            .extract({
                left: Math.max(0, Math.floor(diffMask.x)),
                top: Math.max(0, Math.floor(diffMask.y)),
                width: Math.max(1, Math.floor(diffMask.w)),
                height: Math.max(1, Math.floor(diffMask.h))
            })
            .resize(10, 10, { fit: 'fill' }) // Normalize to small grid
            .raw()
            .toBuffer();

        // Get thumbnail color
        const thumbResponse = await axios.get(thumbUrl, { responseType: 'arraybuffer' });
        const thumbBuffer = await sharp(thumbResponse.data)
            .resize(10, 10, { fit: 'fill' })
            .raw()
            .toBuffer();

        // Simple Euclidean distance between the two normalized 10x10 grids
        let totalDiff = 0;
        for (let i = 0; i < cropBuffer.length; i++) {
            totalDiff += Math.abs(cropBuffer[i] - thumbBuffer[i]);
        }
        
        const maxDiff = 10 * 10 * 3 * 255;
        const similarity = 1 - (totalDiff / maxDiff);
        
        console.log(`      [COLOR] Similarity check: ${(similarity * 100).toFixed(1)}% match.`);
        return similarity;
    } catch (error) {
        console.warn(`      [WARN] Color similarity check failed: ${error.message}`);
        return 0;
    }
}


module.exports = {
    validatePreviewImage,
    calculateVisualDiff,
    calculateVisualDiffBuffers,
    quickColorCheck,
    verifyCart,
    captureCartEvidence,
};
