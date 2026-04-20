/**
 * Customizer Module â€” v3.1
 * Handles dynamic option groups that appear after selections.
 * Re-scans after each interaction to discover new groups.
 */

const path = require('path');
const fs = require('fs');
const mockData = require('../utils/mock-data');
const { ensureCleanPage } = require('../core/browser');

/**
 * Common selectors used in custom product pages
 */
const CUSTOMIZER_SELECTORS = [
    '#formCustomization',
    '#customizationOptions',
    '.customily-form-content',
    '.customization-content-info',
    '[id*="customiz"]',
    '[class*="customiz"]',
    '[class*="personaliz"]',
];

const OPTION_GROUP_SELECTOR = '.customily-gr';

const OPTION_ITEM_SELECTORS = [
    '.customization-option-item',
    '.swatch-option-item.js-choose-variant',
    '[class*="option-item"]',
];

const TEXT_INPUT_SELECTORS = [
    'input.customily-input[type="text"]',
    'input.form-control.customily-input',
    'input[id*="custom-input-text"]',
    'input[placeholder*="Ex:"]',
];

const ADD_TO_CART_SELECTORS = [
    '.customization-add-to-cart',
    'button.add-to-cart-btn',
    'button.product-addtocart',
    '#js-btn-add-to-cart',
    'button[id*="add-to-cart"]',
    '.btn-add-to-cart',
    'button.add-to-cart',
    '[class*="add-to-cart"]',
    'button:has-text("Add to Cart")',
    'button:has-text("Add to cart")',
    'button:has-text("Buy Now")',
];

const PREVIEW_IMAGE_SELECTORS = [
    '.customily-preview canvas',
    '.customily-canvas-container canvas',
    '#formCustomization canvas',
    '.customily-preview img',
    '#customily-main-image',
    '.preview-image img',
    'canvas.lower-canvas',
    'canvas',
    'img.preview',
    'img[class*="preview"]',
    '#product-image img',
    '.product-image-main img',
];

const pagePreviewCaptureState = new WeakMap();
const CANVAS_FALLBACK_COOLDOWN_MS = 15000;

function getPreviewCaptureState(page) {
    if (!pagePreviewCaptureState.has(page)) {
        pagePreviewCaptureState.set(page, {
            domOnlyUntil: 0,
            lastPreviewSelector: null,
            lastCanvasWarningAt: 0,
            lastCanvasErrorAt: 0,
            canvasUnavailableMode: false,
        });
    }
    return pagePreviewCaptureState.get(page);
}

async function isElementActionable(element) {
    if (!element) return false;

    const isVisible = await element.isVisible().catch(() => false);
    if (!isVisible) return false;

    const box = await element.boundingBox().catch(() => null);
    if (!box || box.width < 8 || box.height < 8) return false;

    const blocked = await element.evaluate((node) => {
        const style = window.getComputedStyle(node);
        return Boolean(
            node.disabled ||
            node.getAttribute('aria-disabled') === 'true' ||
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.pointerEvents === 'none'
        );
    }).catch(() => true);

    return !blocked;
}

async function clickActionableElement(element, { timeoutMs = 2500 } = {}) {
    if (!await isElementActionable(element)) return false;

    await element.scrollIntoViewIfNeeded({ timeout: Math.min(timeoutMs, 1500) }).catch(() => {});

    try {
        await element.click({ timeout: timeoutMs });
        return true;
    } catch {
        try {
            if (!await isElementActionable(element)) return false;
            await element.click({ timeout: Math.min(timeoutMs, 1500), force: true });
            return true;
        } catch {
            return false;
        }
    }
}

function parseInputMaxLength(raw) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function randomDigits(length) {
    if (!length || length <= 0) return '';
    let out = '';
    for (let i = 0; i < length; i++) {
        out += String(Math.floor(Math.random() * 10));
    }
    return out;
}

function generateTextValue(groupName, placeholder, maxLength) {
    const groupLower = (groupName || '').toLowerCase();
    const placeholderLower = (placeholder || '').toLowerCase();
    const isYear = placeholderLower.includes('year') || groupLower.includes('year');
    const isPet = /pet|cat|dog/i.test(groupName || '');

    if (isYear) {
        if (maxLength && maxLength < 4) {
            return randomDigits(maxLength);
        }
        const year = mockData.getRandomYear();
        return maxLength ? year.slice(0, maxLength) : year;
    }

    const source = isPet ? mockData.PET_NAMES : mockData.NAMES;
    const normalized = (source || [])
        .map((v) => String(v || '').trim())
        .filter((v) => v.length > 0)
        .map((v) => maxLength ? v.slice(0, maxLength) : v)
        .filter((v) => !maxLength || v.length <= maxLength);

    if (normalized.length > 0) {
        return normalized[Math.floor(Math.random() * normalized.length)];
    }

    const fallbackLength = maxLength ? Math.max(1, Math.min(maxLength, 8)) : 8;
    return mockData.getRandomString(fallbackLength);
}

function isRenderAffectingDropdown(group) {
    if (!group || group.type !== 'dropdown') return false;
    const label = String(group.name || '').toLowerCase();
    const renderHints = [
        'number of',
        'number',
        'qty',
        'quantity',
        'kid',
        'kids',
        'child',
        'children',
        'people',
        'person',
        'family',
        'member',
        'pet',
        'pets',
    ];
    return renderHints.some((hint) => label.includes(hint));
}

function normalizeHexColor(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const v = raw.trim();
    const m3 = v.match(/^#([0-9a-fA-F]{3})$/);
    if (m3) {
        const [r, g, b] = m3[1].split('');
        return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
    }
    const m6 = v.match(/^#([0-9a-fA-F]{6})$/);
    if (m6) {
        return `#${m6[1].toUpperCase()}`;
    }
    return '';
}

function rgbStringToHex(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const values = raw.match(/\d+(\.\d+)?/g);
    if (!values || values.length < 3) return '';
    const toByte = (n) => Math.max(0, Math.min(255, Math.round(Number(n))));
    const r = toByte(values[0]).toString(16).padStart(2, '0');
    const g = toByte(values[1]).toString(16).padStart(2, '0');
    const b = toByte(values[2]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`.toUpperCase();
}

function toColorHex(raw) {
    return normalizeHexColor(raw) || rgbStringToHex(raw);
}

function getLuminance(hex) {
    if (!hex || hex.length < 7) return 0;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // Relative luminance formula
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const SEMANTIC_COLOR_KEYWORDS = [
    { token: 'charcoal', hex: '#36454F' },
    { token: 'light blue', hex: '#7EC8E3' },
    { token: 'dark blue', hex: '#1F3A5F' },
    { token: 'navy', hex: '#1F3A5F' },
    { token: 'silver', hex: '#C0C0C0' },
    { token: 'grey', hex: '#808080' },
    { token: 'gray', hex: '#808080' },
    { token: 'brown', hex: '#8B4513' },
    { token: 'blonde', hex: '#D9B46B' },
    { token: 'gold', hex: '#D4AF37' },
    { token: 'beige', hex: '#E8D8C8' },
    { token: 'cream', hex: '#F3E5C8' },
    { token: 'white', hex: '#FFFFFF' },
    { token: 'black', hex: '#000000' },
    { token: 'red', hex: '#C93A3A' },
    { token: 'maroon', hex: '#800000' },
    { token: 'pink', hex: '#E88AAE' },
    { token: 'purple', hex: '#7E57C2' },
    { token: 'violet', hex: '#7E57C2' },
    { token: 'blue', hex: '#2F6DB5' },
    { token: 'green', hex: '#2E8B57' },
    { token: 'orange', hex: '#E67E22' },
    { token: 'yellow', hex: '#F1C40F' },
    { token: 'teal', hex: '#008080' },
    { token: 'tan', hex: '#D2B48C' },
];

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSemanticColor(...values) {
    const combined = values
        .filter(Boolean)
        .map((value) => String(value).toLowerCase())
        .join(' ');

    for (const entry of SEMANTIC_COLOR_KEYWORDS) {
        const pattern = new RegExp(`\\b${escapeRegex(entry.token)}\\b`, 'i');
        if (pattern.test(combined)) {
            return {
                raw: entry.token,
                hex: entry.hex,
                source: 'semantic-label',
            };
        }
    }

    return { raw: '', hex: '', source: '' };
}

function looksLikeLiteralColor(value) {
    const text = String(value || '').trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)
        || /^rgba?\(/i.test(text)
        || /^hsla?\(/i.test(text);
}

function isNeutralLikeHex(hex) {
    if (!hex || hex.length < 7) return true;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    const luminance = getLuminance(hex);
    return spread < 18 || luminance > 235;
}

function isTrustedColorCandidate(source, value, hex) {
    if (!hex) return false;

    if (source === 'data-color' || source === 'variant-color-code') {
        return true;
    }

    if (source === 'inline-style') {
        return !isNeutralLikeHex(hex);
    }

    if (source === 'title' || source === 'aria-label' || source === 'text' || source === 'data-value' || source === 'data-variant-option-slug') {
        return looksLikeLiteralColor(value);
    }

    if (String(source || '').startsWith('computed-background')) {
        return !isNeutralLikeHex(hex);
    }

    return false;
}

async function extractOptionColor(optionElement, context = {}) {
    try {
        const result = await optionElement.evaluate((node) => {
            const transparentSet = new Set(['transparent', 'rgba(0, 0, 0, 0)']);
            const candidates = [];
            const addCandidate = (value, source) => {
                if (!value || typeof value !== 'string') return;
                const cleaned = value.trim();
                if (!cleaned) return;
                candidates.push({ value: cleaned, source });
            };

            // 1. Check data attributes commonly used by Printerval/Meear
            addCandidate(node.getAttribute('data-color'), 'data-color');
            addCandidate(node.getAttribute('data-value'), 'data-value');
            addCandidate(node.getAttribute('data-variant-option-slug'), 'data-variant-option-slug');
            addCandidate(node.getAttribute('variant-color-code'), 'variant-color-code');
            addCandidate(node.getAttribute('title'), 'title');
            addCandidate(node.getAttribute('aria-label'), 'aria-label');

            // 2. Check inline styles
            const inlineStyle = node.getAttribute('style') || '';
            const bgMatch = inlineStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
            if (bgMatch && bgMatch[1]) addCandidate(bgMatch[1], 'inline-style');

            // 3. Inspect children (swatches often have internal spans for color)
            const preferred = node.querySelectorAll('[class*="swatch"], [class*="color"], [style*="background"]');
            const fallback = node.querySelectorAll('span, div');
            const inspectList = [node, ...Array.from(preferred).slice(0, 5), ...Array.from(fallback).slice(0, 5)];

            for (const el of inspectList) {
                const style = window.getComputedStyle(el);
                const bg = style.backgroundColor;
                if (bg && !transparentSet.has(bg)) {
                    addCandidate(bg, el === node ? 'computed-background:self' : 'computed-background:child');
                }
            }

            // 4. Also check text content if it's a simple color name
            const text = node.innerText.trim().toLowerCase();
            if (text.length > 0 && text.length < 20) {
                addCandidate(text, 'text');
            }

            return {
                candidates,
                semanticHints: [
                    node.getAttribute('title') || '',
                    node.getAttribute('aria-label') || '',
                    text,
                ],
            };
        });

        let trustedChoice = null;

        for (const candidate of result.candidates || []) {
            const hex = toColorHex(candidate.value);
            if (!hex) continue;
            if (isTrustedColorCandidate(candidate.source, candidate.value, hex)) {
                trustedChoice = {
                    raw: candidate.value,
                    hex,
                    source: candidate.source,
                };
                break;
            }
        }

        const semantic = extractSemanticColor(
            ...(result.semanticHints || []),
            context.groupName,
            context.optionLabel,
        );

        return {
            raw: trustedChoice?.raw || semantic.raw || '',
            hex: trustedChoice?.hex || '',
            luminance: trustedChoice?.hex ? getLuminance(trustedChoice.hex) : null,
            source: trustedChoice?.source || semantic.source || '',
            trusted: Boolean(trustedChoice?.hex),
            semanticRaw: semantic.raw || '',
            semanticHex: semantic.hex || '',
        };
    } catch {
        return { raw: '', hex: '', source: '', trusted: false, semanticRaw: '', semanticHex: '' };
    }
}

/**
 * Smart wait for post-interaction loading.
 * Hard cap: 8s max to prevent infinite waits on stuck Customily loading states.
 */
async function smartWait(page, groupType = null) {
    let apiDetected = false;
    let timedOut = false;
    const start = Date.now();

    const requestListener = (request) => {
        const type = request.resourceType();
        const url = request.url();
        
        // Exclude common tracking/analytics/font domains that shouldn't block the wait
        const isTracking = /google-analytics|hotjar|facebook\.net|tiktok\.com|snapchat|klaviyo|omnisend|privy|doubleclick|fonts\.googleapis|static\.canva/.test(url);
        
        if (!isTracking && (type === 'xhr' || type === 'fetch')) {
            apiDetected = true;
        }
    };
    page.on('request', requestListener);
    
    // Adaptive listen time tuned to reduce idle wait without skipping genuine async work.
    const listenTime = groupType === 'image_option'
        ? 250
        : groupType === 'text_input'
            ? 220
            : groupType === 'dropdown'
                ? 260
                : 400;
    await page.waitForTimeout(listenTime);
    page.off('request', requestListener);

    if (apiDetected) {
        console.log('      [WAIT] API request detected, waiting for loading to finish...');
        try {
            await Promise.race([
                page.waitForSelector('#loadingElement, .customily-loading, .loading-spinner, .loading-overlay, .spinner', {
                    state: 'hidden',
                    timeout: 8000 // Hard cap: 8s max
                }),
                new Promise(r => setTimeout(r, 8000)) // Absolute hard cap
            ]);
            // Adaptive settle time
            const settleTime = groupType === 'image_option'
                ? 180
                : groupType === 'text_input'
                    ? 160
                    : 280;
            await page.waitForTimeout(settleTime);
        } catch (e) {
            console.warn('      [WARN] SmartWait: Loading timer exceeded 8s hard cap.');
            timedOut = true;
        }
    } else {
        console.log('      [SKIP] No API request (cached), proceeding immediately.');
        await page.waitForTimeout(60);
    }

    return { apiDetected, waitedMs: Date.now() - start, timedOut };
}

/**
 * Poll the preview canvas/img hash until it has been stable for N frames.
 * Designed for image_option steps where Customily takes time to re-render.
 *
 * @param {Page} page - Playwright page
 * @param {number} stableFrames - How many consecutive identical hashes to require (default 2)
 * @param {number} pollMs - Poll interval in ms (default 300)
 * @param {number} timeoutMs - Maximum wait in ms (default 4000)
 */
async function waitForPreviewSettle(page, stableFrames = 2, pollMs = 300, timeoutMs = 4000, labelConfirmed = false) {
    const deadline = Date.now() + timeoutMs;
    let consecutiveStable = 0;
    let lastHash = null;
    let sawMutation = false;

    const getPreviewHash = async () => {
        try {
            return await page.evaluate(() => {
                // Prefer canvas over img for accuracy
                const canvas = document.querySelector('canvas');
                if (canvas) {
                    try {
                        return canvas.toDataURL('image/webp', 0.1).slice(-64); // Last 64 chars = quick hash
                    } catch (e) { /* tainted */ }
                }
                // Fallback: use img src + naturalWidth as a proxy
                const img = document.querySelector('.customily-preview img, #customily-main-image, img[class*="preview"]');
                if (img) return `${img.src}|${img.naturalWidth}|${img.naturalHeight}`;
                return null;
            });
        } catch (e) { return null; }
    };

    while (Date.now() < deadline) {
        await page.waitForTimeout(pollMs);
        const hash = await getPreviewHash();
        if (hash === null) { consecutiveStable = 0; continue; }

        if (hash !== lastHash) {
            if (lastHash !== null) sawMutation = true; // First actual change seen
            lastHash = hash;
            consecutiveStable = 0;

            if (labelConfirmed && sawMutation) {
                console.log('      [SETTLE] Label confirmed and canvas mutated. Exiting early.');
                break;
            }
        } else {
            if (sawMutation) consecutiveStable++;
            if (consecutiveStable >= stableFrames) break; // Stable after mutation
        }
    }

    const reason = consecutiveStable >= stableFrames ? 'settled' : 'timed-out';
    console.log(`      [SETTLE] Preview settle: ${reason} after ${Date.now() - (deadline - timeoutMs)}ms`);
}

/**
 * Detect if the customizer widget exists on the page
 */
async function detectCustomizer(page) {
    for (const selector of CUSTOMIZER_SELECTORS) {
        const el = await page.$(selector);
        if (el) {
            return { found: true, selector };
        }
    }
    return { found: false, selector: null };
}

async function waitForGroupCountStable(page, { pollMs = 180, stableRounds = 2, timeoutMs = 700 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    let lastCount = -1;
    while (Date.now() < deadline) {
        const groupsAfter = await getVisibleOptionGroups(page);
        const count = groupsAfter.length;
        if (count === lastCount) {
            stable++;
            if (stable >= stableRounds) break;
        } else {
            stable = 0;
            lastCount = count;
        }
        await page.waitForTimeout(pollMs);
    }
}

/**
 * Returns an array of visible option groups,
 * each containing the main structure and any child inputs.
 */
async function getVisibleOptionGroups(page) {
    const groups = [];
    const elements = await page.$$(OPTION_GROUP_SELECTOR);
    const nameCounters = {};

    for (let idx = 0; idx < elements.length; idx++) {
        const el = elements[idx];
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;

        const nameEl = await el.$('.customization-info-name, .option-title, .customily-label-asb');
        let name = 'Unnamed Group';
        if (nameEl) {
            name = (await nameEl.textContent()).trim();
            name = name.replace(/\s+/g, ' ').trim();
            name = name.replace(/\s*\(\d+(\/\d+)?\)\s*$/, '').trim();
        }

        if (!nameCounters[name]) nameCounters[name] = 0;
        const nameIndex = nameCounters[name];
        nameCounters[name]++;

        const groupId = await el.evaluate((node) => {
            return node.getAttribute('data-group-id')
                || node.getAttribute('id')
                || node.className
                || '';
        });

        const optionItems = await el.$$(OPTION_ITEM_SELECTORS.join(', '));
        const textInputs = await el.$$(TEXT_INPUT_SELECTORS.join(', '));
        const selectDropdowns = await el.$$('select.customily-input, select.variant-select');
        const fileInputs = await el.$$('input[type="file"]');

        let type = 'unknown';
        if (fileInputs.length > 0) type = 'file_upload';
        else if (textInputs.length > 0) type = 'text_input';
        else if (selectDropdowns.length > 0) type = 'dropdown';
        else if (optionItems.length > 0) type = 'image_option';

        if (type === 'unknown') continue;

        groups.push({
            element: el,
            name,
            type,
            groupId,
            nameIndex,
            domIndex: idx, 
            optionItems,
            textInputs,
            selectDropdowns,
        });
    }
    return groups;
}

async function capturePreviewScreenshot(page, filepath) {
    const fs = require('fs');
    const captureState = getPreviewCaptureState(page);
    const now = Date.now();

    if (captureState.canvasUnavailableMode && now >= captureState.domOnlyUntil) {
        captureState.canvasUnavailableMode = false;
        captureState.domOnlyUntil = 0;
    }
    
    // 1. Try canvas extraction first (fastest, perfectly ignores DOM popups and delays)
    if (!captureState.canvasUnavailableMode && now >= captureState.domOnlyUntil) {
        try {
            const canvasData = await page.evaluate(() => {
                const findBestCanvas = () => {
                    const canvases = Array.from(document.querySelectorAll('canvas'));
                    if (canvases.length === 0) return null;

                    // Priority 1: Visible canvases inside customizer containers
                    const customizerSelectors = ['.customily-preview', '.customily-app', '#formCustomization', '.customily-canvas-container'];
                    for (const sel of customizerSelectors) {
                        const container = document.querySelector(sel);
                        if (container) {
                            const internal = container.querySelector('canvas');
                            if (internal && internal.offsetWidth > 50) return internal;
                        }
                    }

                    // Priority 2: Largest visible canvas
                    const visible = canvases
                        .filter(c => c.offsetWidth > 100 && c.offsetHeight > 100)
                        .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
                    
                    return visible[0] || null;
                };

                const canvas = findBestCanvas();
                if (!canvas) return null;

                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                    const samplePoints = [
                        [Math.floor(canvas.width / 2), Math.floor(canvas.height / 2)],
                        [10, 10],
                        [Math.max(0, Math.floor(canvas.width * 0.75)), Math.max(0, Math.floor(canvas.height * 0.25))]
                    ];
                    const allTransparent = samplePoints.every(([x, y]) => {
                        const safeX = Math.max(0, Math.min(canvas.width - 1, x));
                        const safeY = Math.max(0, Math.min(canvas.height - 1, y));
                        const pix = ctx.getImageData(safeX, safeY, 1, 1).data;
                        return pix[3] === 0;
                    });
                    if (allTransparent) return 'BLANK_DETECTED';
                }

                return canvas.toDataURL('image/webp', 0.8);
            });

            if (canvasData && canvasData !== 'BLANK_DETECTED') {
                const base64Data = canvasData.replace(/^data:image\/webp;base64,/, '');
                fs.writeFileSync(filepath, base64Data, 'base64');
                captureState.domOnlyUntil = 0;
                captureState.canvasUnavailableMode = false;
                return filepath;
            } else if (canvasData === 'BLANK_DETECTED') {
                captureState.domOnlyUntil = Date.now() + CANVAS_FALLBACK_COOLDOWN_MS;
                captureState.canvasUnavailableMode = true;
                if (!captureState.lastCanvasWarningAt || (now - captureState.lastCanvasWarningAt) >= CANVAS_FALLBACK_COOLDOWN_MS) {
                    console.log('    [INFO] Canvas preview is blank right now; using DOM screenshot fallback temporarily.');
                    captureState.lastCanvasWarningAt = now;
                }
            }
        } catch (e) {
            captureState.domOnlyUntil = Date.now() + Math.floor(CANVAS_FALLBACK_COOLDOWN_MS / 2);
            captureState.canvasUnavailableMode = true;
            if (!captureState.lastCanvasErrorAt || (now - captureState.lastCanvasErrorAt) >= Math.floor(CANVAS_FALLBACK_COOLDOWN_MS / 2)) {
                console.log(`    [INFO] Direct canvas capture unavailable; using DOM screenshot fallback. (${e.message})`);
                captureState.lastCanvasErrorAt = now;
            }
        }
    }

    // 2. Fallback to DOM element screenshot
    const orderedSelectors = captureState.lastPreviewSelector
        ? [captureState.lastPreviewSelector, ...PREVIEW_IMAGE_SELECTORS.filter((sel) => sel !== captureState.lastPreviewSelector)]
        : PREVIEW_IMAGE_SELECTORS;

    for (const selector of orderedSelectors) {
        try {
            const el = await page.$(selector);
            if (el) {
                const isVisible = await el.isVisible().catch(() => false);
                if (isVisible) {
                    const box = await el.boundingBox();
                    if (box && box.width > 50 && box.height > 50) {
                        await el.screenshot({ path: filepath, type: 'webp', quality: 80 });
                        captureState.lastPreviewSelector = selector;
                        return filepath;
                    }
                }
            }
        } catch (err) { /* ignore individual selector failures */ }
    }
    
    // Final desperate fallback
    await page.screenshot({ path: filepath, fullPage: false, type: 'webp', quality: 80 });
    return filepath;
}

async function scanFirstPersonalizedGroup(page) {
    let maxWaitIterations = 10;
    let interactedIndexes = new Set();
    let firstImageGroup = null;

    while (maxWaitIterations-- > 0) {
        const groups = await getVisibleOptionGroups(page);
        firstImageGroup = groups.find((g) => g.type === 'image_option');
        if (firstImageGroup) break;

        const nextDropdown = groups.find(g => g.type === 'dropdown' && !interactedIndexes.has(g.domIndex));
        if (nextDropdown) {
            interactedIndexes.add(nextDropdown.domIndex);
            try {
                const selectElement = nextDropdown.selectDropdowns[0];
                const optionsList = await selectElement.$$eval('option:not([disabled])', opts => Math.max(0, opts.length - 1));
                if (optionsList > 0) {
                    const rndIdx = Math.floor(Math.random() * optionsList);
                    await selectElement.selectOption({ index: rndIdx > 0 ? rndIdx : 1 });
                    await smartWait(page);
                }
            } catch (e) {
                console.warn(`    [WARN] Scan drop-down failed: ${e.message}`);
            }
        } else break;
    }

    if (!firstImageGroup) {
        return { found: false, groupName: null, options: [], didMutate: interactedIndexes.size > 0 };
    }

    const options = [];
    for (let i = 0; i < firstImageGroup.optionItems.length; i++) {
        const item = firstImageGroup.optionItems[i];
        const colorMeta = await extractOptionColor(item, { groupName: firstImageGroup.name });
        const rawTitle = (await item.getAttribute('title')) || '';
        const title = rawTitle || colorMeta.semanticRaw || (colorMeta.hex ? `Color ${colorMeta.hex}` : `Option ${i + 1}`);
        let thumbnail = '';
        const thumbImg = await item.$('img');
        if (thumbImg) {
            thumbnail = (await thumbImg.getAttribute('src'))
                || (await thumbImg.getAttribute('data-src')) || '';
        }
        options.push({
            index: i,
            title,
            thumbnail,
            color_raw: colorMeta.raw || '',
            color_hex: colorMeta.hex || '',
        });
    }

    return {
        found: true,
        groupName: firstImageGroup.name,
        options,
        didMutate: interactedIndexes.size > 0
    };
}

async function performCustomization(page, screenshotDir, fixedOptionIndex, customImageFilename, previouslySelectedValues = {}, aiEvaluator = null) {
    const fs = require('fs');
    const path = require('path');
    const timeline = [];
    let stepIndex = 0;
    let isFirstImageGroup = true;
    const processedGroups = new Set();
    let maxIterations = 150;
    // let previousAfterPath = null; // Reverted as per user request for full before/after parity

    while (maxIterations-- > 0) {
        // Periodically remove popups/Klaviyo elements that might have appeared
        await ensureCleanPage(page);
        await page.waitForTimeout(100);

        const groups = await getVisibleOptionGroups(page);
        let foundNewGroup = false;

        for (const group of groups) {
            const signature = `${group.name}|${group.type}|${group.groupId}|${group.nameIndex}`;
            if (processedGroups.has(signature)) continue;

            processedGroups.add(signature);
            foundNewGroup = true;
            stepIndex++;
            console.log(`    [STEP] Processing Group ${stepIndex}: "${group.name}" (${group.type}) [Iter: ${150 - maxIterations}]`);

            const expectsVisualChange = group.type === 'image_option' || group.type === 'text_input' || group.type === 'file_upload';
            const renderAffectingControl = isRenderAffectingDropdown(group);
            const skipDiffCheck = group.type === 'dropdown';
            const capturePreviewState = group.type !== 'dropdown' || renderAffectingControl;

            const stepData = {
                step_id: stepIndex,
                action: '',
                name: group.name,
                group_type: group.type,
                expects_visual_change: expectsVisualChange,
                skip_diff_check: skipDiffCheck,
                capture_preview_state: capturePreviewState,
                render_affecting_control: renderAffectingControl,
                context_transition: renderAffectingControl,
                selection_changes_structure: false,
                changes_preview: expectsVisualChange || renderAffectingControl,
                observed_preview_change_score: null,
                requires_ocr: group.type === 'text_input',
                value_chosen: '',
                option_thumbnail: '',
                option_color: '',
                option_color_hex: '',
                option_color_source: '',
                option_color_semantic: '',
                option_color_semantic_hex: '',
                color_audit_applicable: false,
                state_before: '',
                state_after: '',
                diff_score: -1,
                status: 'PASS',
                interaction_status: 'PASS', // Did the mechanical action succeed?
                validation_status: 'PENDING', // Will be populated in Phase 4
                message: '',
                code_evaluation: { diff_score: -1, status: 'PENDING' },
                ai_evaluation: { ai_score: -1, ai_verdict: 'PENDING', ai_reason: '' },
            };

            try {
                let beforePath = path.join(screenshotDir, `step_${stepIndex}_before.webp`);
                
                // Wait for the specific group type to ensure the page is ready
                const waitTime = group.type === 'image_option' ? 150 : 110;
                await page.waitForTimeout(waitTime);
                
                // Ensure page is clean and stabilized before 'before' capture
                await ensureCleanPage(page);

                if (stepData.capture_preview_state) {
                    await capturePreviewScreenshot(page, beforePath);
                    stepData.state_before = beforePath;
                }

                // Capture structural state before
                const groupsBefore = await getVisibleOptionGroups(page);
                const countBefore = groupsBefore.length;
                
                // Track labels before to see what's new
                const labelsBefore = await page.$$eval('.customization-info-name, .customily-personalization-info', els => els.map(el => el.innerText.toLowerCase()));

                if (group.type === 'text_input') {
                    // ... (existing text_input logic)
                    stepData.action = 'Input Text';
                    const input = group.textInputs[0];
                    const placeholder = (await input.getAttribute('placeholder')) || '';
                    const maxLength = parseInputMaxLength(await input.getAttribute('maxlength'));
                    let value = '';
                    let attempts = 0;
                    if (!previouslySelectedValues[group.name]) previouslySelectedValues[group.name] = new Set();
                    const prevSet = previouslySelectedValues[group.name];

                    while (attempts < 10) {
                        value = generateTextValue(group.name, placeholder, maxLength);
                        if (maxLength && value.length > maxLength) value = value.slice(0, maxLength);
                        if (!value || value.trim().length === 0) value = mockData.getRandomString(maxLength ? Math.max(1, Math.min(maxLength, 8)) : 8);
                        if (!prevSet.has(value)) break;
                        attempts++;
                    }

                    await input.focus();
                    await input.fill('');
                    await input.fill(value);
                    await input.evaluate((node) => {
                        node.dispatchEvent(new Event('input', { bubbles: true }));
                        node.dispatchEvent(new Event('change', { bubbles: true }));
                    });
                    await page.keyboard.press('Enter');
                    await input.evaluate((node) => node.blur());
                    await page.waitForTimeout(250);
                    stepData.value_chosen = value;
                    if (maxLength) stepData.message = `Text input respects maxlength=${maxLength}.`;
                    prevSet.add(value);

                } else if (group.type === 'dropdown') {
                    // ... (existing dropdown logic)
                    stepData.action = 'Select Dropdown';
                    const select = group.selectDropdowns[0];
                    const options = await select.$$('option:not([disabled])');
                    const validOptions = [];
                    for (const opt of options) {
                        const val = await opt.getAttribute('value');
                        if (val && val.trim() !== '') {
                            const text = (await opt.textContent()).trim();
                            validOptions.push({ element: opt, value: val, text });
                        }
                    }
                    if (validOptions.length > 0) {
                        if (!previouslySelectedValues[group.name]) previouslySelectedValues[group.name] = new Set();
                        const prevSet = previouslySelectedValues[group.name];
                        let pool = validOptions.filter(o => !prevSet.has(o.text));
                        if (pool.length === 0) pool = validOptions;
                        const selectedOpt = pool[Math.floor(Math.random() * pool.length)];
                        await select.selectOption(selectedOpt.value);
                        stepData.value_chosen = selectedOpt.text;
                        prevSet.add(selectedOpt.text);
                    }
                    // Redundant smartWait removed (uses global one at end of block)

                } else if (group.type === 'image_option') {
                    stepData.action = 'Select Option';
                    const items = group.optionItems;
                    if (items.length > 0) {
                        let targetItem;
                        let skipClick = false;
                        if (isFirstImageGroup && fixedOptionIndex !== null) {
                            targetItem = items[Math.min(fixedOptionIndex, items.length - 1)];
                            isFirstImageGroup = false;
                            const cls = (await targetItem.getAttribute('class')) || '';
                            if (cls.includes('active')) skipClick = true;
                        } else {
                            if (!previouslySelectedValues[group.name]) previouslySelectedValues[group.name] = new Set();
                            const prevSet = previouslySelectedValues[group.name];
                            const nonActiveItems = [];
                            const allNonActiveItems = [];
                            
                            // Color prioritization rule: avoid black/dark
                            const prioritizedItems = [];
                            const deprioritizedItems = [];

                            for (const item of items) {
                                const cls = (await item.getAttribute('class')) || '';
                                if (!cls.includes('active')) {
                                    const rawTitle = (await item.getAttribute('title')) || '';
                                    const colorMeta = await extractOptionColor(item, { groupName: group.name, optionLabel: rawTitle });
                                    const optionKey = rawTitle || colorMeta.semanticRaw || colorMeta.hex || colorMeta.raw || '';
                                    
                                    const itemData = { element: item, key: optionKey, color: colorMeta, title: rawTitle };
                                    allNonActiveItems.push(itemData);
                                    
                                    if (!prevSet.has(optionKey)) {
                                        const isDark = (colorMeta.hex === '#000000' || colorMeta.hex === '#111111' || 
                                                       optionKey.toLowerCase().includes('black') || 
                                                       optionKey.toLowerCase().includes('dark'));
                                        
                                        if (isDark) deprioritizedItems.push(itemData);
                                        else prioritizedItems.push(itemData);
                                        
                                        nonActiveItems.push(item);
                                    }
                                }
                            }
                            
                            if (allNonActiveItems.length === 0) {
                                skipClick = true;
                                targetItem = items[0];
                                stepData.selection_reason = 'All items active, picking first.';
                            } else {
                                let chosen;
                                if (prioritizedItems.length > 0) {
                                    chosen = prioritizedItems[Math.floor(Math.random() * prioritizedItems.length)];
                                    stepData.selection_reason = 'Preferred bright/contrast color.';
                                } else if (deprioritizedItems.length > 0) {
                                    chosen = deprioritizedItems[Math.floor(Math.random() * deprioritizedItems.length)];
                                    stepData.selection_reason = 'Only dark colors available.';
                                    // Optional: user requested more settle time for dark colors
                                    stepData.requires_extra_settle = true;
                                } else {
                                    const pool = nonActiveItems.length > 0 ? nonActiveItems : allNonActiveItems.map(i => i.element);
                                    targetItem = pool[Math.floor(Math.random() * pool.length)];
                                    stepData.selection_reason = 'Fall-back random selection.';
                                }
                                
                                if (chosen) {
                                    targetItem = chosen.element;
                                }
                            }
                            if (isFirstImageGroup) isFirstImageGroup = false;
                        }
                        const rawTitle = (await targetItem.getAttribute('title')) || '';
                        const colorMeta = await extractOptionColor(targetItem, { groupName: group.name, optionLabel: rawTitle });
                        stepData.value_chosen = rawTitle || colorMeta.semanticRaw || (colorMeta.hex ? `Color ${colorMeta.hex}` : 'Selected option');
                        stepData.option_color = colorMeta.raw || '';
                        stepData.option_color_hex = colorMeta.trusted ? (colorMeta.hex || '') : '';
                        stepData.option_color_source = colorMeta.trusted ? (colorMeta.source || '') : (colorMeta.semanticHex ? 'semantic-label' : '');
                        stepData.option_color_semantic = colorMeta.semanticRaw || '';
                        stepData.option_color_semantic_hex = colorMeta.semanticHex || '';
                        stepData.color_audit_applicable = Boolean(colorMeta.trusted && colorMeta.hex);
                        if (!previouslySelectedValues[group.name]) previouslySelectedValues[group.name] = new Set();
                        previouslySelectedValues[group.name].add(stepData.value_chosen);
                        const thumbImg = await targetItem.$('img');
                        if (thumbImg) stepData.option_thumbnail = (await thumbImg.getAttribute('src')) || (await thumbImg.getAttribute('data-src')) || '';
                        if (skipClick) {
                            stepData.message = 'Option already active, skipped click.';
                            stepData.skip_diff_check = true;
                        } else {
                            await targetItem.click({ force: true });
                            stepData.message = 'Option selected successfully.';
                        }
                    }
                } else if (group.type === 'file_upload') {
                    // ... (existing file_upload logic)
                    stepData.action = 'Upload File';
                    const fileInput = await group.element.$('input[type="file"]');
                    if (fileInput) {
                        try {
                            const defaultImagePath = path.resolve(__dirname, '../../images/test-dog.png');
                            let uploadImagePath = defaultImagePath;
                            if (customImageFilename) {
                                const customPath = path.resolve(__dirname, '../../images', customImageFilename);
                                if (fs.existsSync(customPath)) uploadImagePath = customPath;
                            }
                            await fileInput.setInputFiles(uploadImagePath);
                            stepData.value_chosen = path.basename(uploadImagePath);
                            stepData.message = 'File uploaded successfully.';
                            await page.waitForTimeout(5000);
                        } catch (err) {
                            stepData.status = 'FAIL';
                            stepData.message = 'Failed to upload photo: ' + err.message;
                        }
                    }
                }
                
                const tWait = Date.now();
                const waitResult = await smartWait(page, group.type);
                console.log(`      [PERF] smartWait (${group.type}): ${waitResult.waitedMs}ms`);

                // LABEL MATCHING: Check if chosen value appears in customization labels
                // MOVED UP to allow early settle escape
                if (stepData.value_chosen) {
                    const chosenLower = stepData.value_chosen.toLowerCase();
                    const labelsAfter = await page.$$eval('.customization-info-name, .customily-personalization-info', els => els.map(el => el.innerText.toLowerCase()));
                    
                    const foundMatch = labelsAfter.some(l => l.includes(chosenLower));
                    if (foundMatch) {
                        console.log(`      [INFO] Label confirmation: Choice "${stepData.value_chosen}" found in DOM labels.`);
                        stepData.is_label_confirmed = true;
                        stepData.skip_diff_check = true; // High confidence Pass
                    }
                }

                // For image_option steps, wait for canvas to fully settle before capturing
                // This prevents capturing the 'after' before Customily renders the change
                // Note: we still wait if skip_diff_check is true (e.g. from label confirm) but we can exit early. 
                // We only skip if skipClick was true (which means we didn't even click)
                if ((group.type === 'image_option' || stepData.render_affecting_control) &&
                    stepData.action !== 'Menu Opener' &&
                    !stepData.message.includes('skipped click')) {
                    const tSettle = Date.now();
                    
                    // Risk-based adaptive execution
                    let adaptiveTimeout = stepData.render_affecting_control ? 1800 : 1400;
                    if (waitResult.apiDetected) adaptiveTimeout = 2500;
                    else if (stepData.is_label_confirmed) adaptiveTimeout = 900;
                    
                    // Extra settle if dark color was chosen
                    if (stepData.requires_extra_settle) {
                        console.log('      [SETTLE] Extra wait for dark color (low contrast)...');
                        adaptiveTimeout += 700;
                    }

                    await waitForPreviewSettle(page, 2, 250, adaptiveTimeout, stepData.is_label_confirmed);
                    console.log(`      [PERF] waitForPreviewSettle (${group.type}): ${Date.now() - tSettle}ms`);
                }

                // Capture structural state after
                const tGroups = Date.now();
                const groupsAfter = await getVisibleOptionGroups(page);
                const countAfter = groupsAfter.length;
                if (countAfter > countBefore) {
                    console.log(`      [INFO] Menu Opener detected: groups increased ${countBefore} -> ${countAfter} (took ${Date.now() - tGroups}ms)`);
                    stepData.is_menu_opener = true;
                    stepData.selection_changes_structure = true;
                    stepData.context_transition = true;
                    stepData.expects_visual_change = false; 
                    stepData.skip_diff_check = true;
                    stepData.message = stepData.message ? `${stepData.message} Structure changed after selection.` : 'Structure changed after selection.';
                    // Extra wait for sub-menu animations/rendering
                    await waitForGroupCountStable(page);
                }

                const afterPath = path.join(screenshotDir, `step_${stepIndex}_after.webp`);
                if (stepData.capture_preview_state) {
                    const tSnap = Date.now();
                    await capturePreviewScreenshot(page, afterPath);
                    console.log(`      [PERF] screenshot (after): ${Date.now() - tSnap}ms`);
                    stepData.state_after = afterPath;
                }
                // previousAfterPath = afterPath; // This line was commented out in the original, keeping it that way.

                // Capture preview-change evidence even for skipped scoring steps so temporal attribution stays accurate.
                if (stepData.capture_preview_state && stepData.state_before && stepData.state_after && fs.existsSync(stepData.state_before)) {
                    try {
                        const { calculateVisualDiff } = require('../actions/validator');
                        let { diffPercent } = await calculateVisualDiff(stepData.state_before, afterPath);
                        if (group.type === 'image_option' && diffPercent === 0) {
                            console.log(`      [RETRY] image_option after=0% diff - canvas may not be settled. Retaking in 600ms...`);
                            await page.waitForTimeout(600);
                            await capturePreviewScreenshot(page, afterPath);
                            console.log(`      [RETRY] After screenshot retaken.`);
                            diffPercent = (await calculateVisualDiff(stepData.state_before, afterPath)).diffPercent;
                        }
                        stepData.observed_preview_change_score = diffPercent;
                        if (diffPercent > 0.01) {
                            stepData.changes_preview = true;
                        }
                    } catch (retryCheckErr) {
                        console.warn(`      [RETRY] Quick diff check failed: ${retryCheckErr.message}`);
                    }
                }

            } catch (error) {
                console.error(`    [ERROR] Customization failed: ${error.message}`);
                stepData.status = 'FAIL';
                stepData.interaction_status = 'FAIL';
                stepData.validation_status = 'FAIL';
                stepData.message = `ERROR: ${error.message}`;
            }
            timeline.push(stepData);
            break;
        }
        if (!foundNewGroup) break;
    }
    return timeline;
}

/**
 * Handles product variants (Style, Size, etc.) that are outside the main customizer.
 * Usually found in standard product pages.
 */
async function handleProductVariants(page, logPrefix = '', options = {}) {
    const { variants_selected } = options;
    const variantSelector = '.js-select-variant, .variant-select, select[name*="variant"], select[id*="variant"]';
    
    // ==========================================
    // REPLAY MODE: Fast Path
    // ==========================================
    if (variants_selected && Array.isArray(variants_selected) && variants_selected.length > 0) {
        console.log(`${logPrefix} [VARIANT] Replaying ${variants_selected.length} cached selections...`);
        const elements = await page.$$(variantSelector);
        
        for (const entry of variants_selected) {
            try {
                const el = elements[entry.groupIndex];
                if (!el) {
                    console.warn(`${logPrefix} [VARIANT] Group ${entry.groupIndex} not found during replay.`);
                    continue;
                }

                if (entry.type === 'select') {
                    const currentValue = await el.inputValue().catch(() => null);
                    if (currentValue !== entry.value) {
                        await el.selectOption(entry.value);
                    }
                    console.log(`${logPrefix}      [VARIANT] Replayed select: ${entry.text}`);
                } else if (entry.type === 'click') {
                    const items = await el.$$('.js-choose-variant, .product-size-item:not(.close-choose-size), li[ng-click*="selectVariant"], .swatch-option, .variant-item');
                    const target = items[entry.itemIndex];
                    if (target && await clickActionableElement(target)) {
                        console.log(`${logPrefix}      [VARIANT] Replayed click: ${entry.text}`);
                        await page.waitForTimeout(300);
                    } else {
                        console.log(`${logPrefix}      [VARIANT] Skipped replay for non-actionable item ${entry.itemIndex} in group ${entry.groupIndex}`);
                    }
                }
            } catch (replayErr) {
                console.log(`${logPrefix} [VARIANT] Replay skipped: ${replayErr.message}`);
            }
        }
        return variants_selected;
    }

    // ==========================================
    // SCAN MODE: Heuristic Path
    // ==========================================
    const elements = await page.$$(variantSelector);
    const results = [];

    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        try {
            const isVisible = await el.isVisible();
            if (!isVisible) continue;

            const tagName = await el.evaluate(node => node.tagName.toLowerCase());
            
            if (tagName === 'select') {
                const name = await el.evaluate(node => {
                    const label = node.querySelector('label') || document.querySelector(`label[for="${node.id}"]`);
                    return (label ? label.innerText : (node.getAttribute('arial-label') || 'Variant')).trim();
                });

                const options = await el.$$eval('option', opts => {
                    return opts
                        .map((o, idx) => ({ 
                            index: idx, 
                            value: o.value, 
                            text: o.innerText.trim(), 
                            disabled: o.disabled 
                        }))
                        .filter(o => !o.disabled && o.value && !o.value.toLowerCase().includes('select') && o.text.toLowerCase().indexOf('select') === -1);
                });

                if (options.length > 0) {
                    let chosen = options[0];
                    let reason = 'First available';

                    const darkKeywords = ['black', 'dark', 'charcoal', 'navy', 'night'];
                    const nonDark = options.find(o => !darkKeywords.some(k => o.text.toLowerCase().includes(k)));
                    
                    if (nonDark && darkKeywords.some(k => options[0].text.toLowerCase().includes(k))) {
                        chosen = nonDark;
                        reason = `Avoided dark color (${options[0].text}) for ${nonDark.text}`;
                    }

                    await el.selectOption(chosen.value);
                    const labelStr = `${name}: ${chosen.text}`;
                    results.push({ type: 'select', groupIndex: i, value: chosen.value, text: labelStr });
                    console.log(`      [VARIANT] Selected ${labelStr} (${reason})`);
                }
            } else {
                const name = await el.evaluate(node => {
                    const label = node.querySelector('label') || document.querySelector(`label[for="${node.id}"]`);
                    return (label ? label.innerText : (node.getAttribute('arial-label') || 'Variant')).trim();
                });

                // Expand logic
                const expanders = await el.$$('.more-color, .expand-colors, .show-more, [class*="more"]');
                for(const exp of expanders) {
                    if (await isElementActionable(exp)) {
                        await clickActionableElement(exp, { timeoutMs: 1500 });
                        await page.waitForTimeout(300);
                    }
                }

                const items = await el.$$('.js-choose-variant, .product-size-item:not(.close-choose-size), li[ng-click*="selectVariant"], .swatch-option, .variant-item');
                
                if (items.length > 0) {
                    const itemData = [];
                    for (let j = 0; j < items.length; j++) {
                        const item = items[j];
                        if (!await isElementActionable(item)) continue;
                        const colorInfo = await extractOptionColor(item);
                        const text = await item.innerText().catch(() => '');
                        itemData.push({ element: item, index: j, text: text.trim(), color: colorInfo });
                    }

                    if (itemData.length === 0) {
                        continue;
                    }

                    let chosenItem = itemData[0];
                    let reason = 'First available';

                    const goodContrast = itemData.find(d => d.color.luminance !== null && d.color.luminance > 40);
                    if (goodContrast && (itemData[0].color.luminance === null || itemData[0].color.luminance <= 40)) {
                        chosenItem = goodContrast;
                        reason = `High contrast color (lum:${Math.round(goodContrast.color.luminance)})`;
                    }

                    const clicked = await clickActionableElement(chosenItem.element, { timeoutMs: 2500 });
                    if (clicked) {
                        const labelStr = `${name}: ${chosenItem.text}`;
                        results.push({ type: 'click', groupIndex: i, itemIndex: chosenItem.index, text: labelStr });
                        console.log(`      [VARIANT] Clicked ${labelStr} (${reason})`);
                        await page.waitForTimeout(500);
                    } else {
                        console.log(`      [VARIANT] Skipped non-actionable variant group "${name}"`);
                    }
                }
            }
        } catch (e) {
            const message = String(e?.message || '');
            if (/not visible|not attached|timeout|element is outside/i.test(message)) {
                console.log(`      [VARIANT] Skipped unstable variant group: ${message}`);
            } else {
                console.warn(`      [WARN] Failed to handle variant: ${message}`);
            }
        }
    }
    return results;
}

async function clickAddToCart(page) {
    // 1. Try to scroll to the footer container first for better visibility
    try {
        const footer = await page.$('#customizationContentFooter, .customization-content-footer, .product-actions');
        if (footer) {
            console.log('      [ACTION] Scrolling footer container into view...');
            await footer.scrollIntoViewIfNeeded({ timeout: 2000 });
            await page.waitForTimeout(500);
        }
    } catch (e) { /* ignore */ }

    await ensureCleanPage(page);
    for (const selector of ADD_TO_CART_SELECTORS) {
        try {
            const btn = await page.$(selector);
            if (btn && await btn.isVisible()) {
                const isDisabled = await btn.evaluate(node => node.disabled || node.getAttribute('aria-disabled') === 'true');
                if (isDisabled) console.log(`      [WARN] Add to Cart button is disabled: ${selector}`);

                const isStillLoading = async () => {
                    return await btn.evaluate(node => {
                        const cls = node.className || '';
                        return cls.includes('loading') || cls.includes('is-loading');
                    });
                };

                let loadingWait = 0;
                while (await isStillLoading() && loadingWait < 15) {
                    console.log(`      [WAIT] Add to Cart button is loading, waiting... (${loadingWait + 1}s)`);
                    await page.waitForTimeout(1000);
                    loadingWait++;
                }

                // Scroll the button itself to center
                await btn.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }));
                await page.waitForTimeout(500);
                
                await btn.hover();
                await page.waitForTimeout(500);
                await ensureCleanPage(page);
                
                console.log(`      [ACTION] Clicking Add to Cart: ${selector}`);
                try {
                    // Check clickable state
                    const props = await btn.evaluate(node => {
                        const style = window.getComputedStyle(node);
                        return {
                            pointerEvents: style.pointerEvents,
                            display: style.display,
                            visibility: style.visibility,
                            zIndex: style.zIndex
                        };
                    });
                    
                    if (props.pointerEvents === 'none') {
                        console.warn('      [WARN] pointer-events is none, forcing to auto...');
                        await btn.evaluate(node => node.style.setProperty('pointer-events', 'auto', 'important'));
                    }

                    // Try normal click first
                    await btn.click({ timeout: 5000 });
                } catch (clickErr) {
                    console.warn(`      [WARN] Normal click failed, trying fallback methods. Error: ${clickErr.message}`);
                    await btn.click({ force: true }).catch(() => {});
                    await btn.evaluate(node => {
                        node.click();
                        node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                        node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                        node.dispatchEvent(new Event('click', { bubbles: true }));
                    }).catch(() => {});
                }

                // 2-3s wait for popup as requested by user
                console.log('      [WAIT] Waiting 3s for cart popup/drawer...');
                await page.waitForTimeout(3000); 

                try {
                    // Detect if popup appeared
                    await page.waitForSelector('.mini-cart-drawer, [from="right"].mini-cart-drawer, .added-to-cart-content, .item-summary, .item-summary-product, .list-add-item, [class*="cart-popup"], [class*="cart-drawer"], [class*="cart-notification"], .added-modal, #cart-notification', {
                        state: 'visible',
                        timeout: 7000
                    });
                    console.log('      [OK] Cart confirmation/popup detected.');
                } catch (e) {
                    console.log('      [INFO] No cart popup selector detected via waitForSelector, proceeding to evidence capture.');
                }

                return { success: true, selector };
            }
        } catch (e) { continue; }
    }
    return { success: false, selector: null };
}

module.exports = {
    detectCustomizer,
    getVisibleOptionGroups,
    capturePreviewScreenshot,
    performCustomization,
    scanFirstPersonalizedGroup,
    handleProductVariants,
    clickAddToCart,
};
