/**
 * Browser Module — v2.2
 * Initializes Playwright browser, context, and page with optimal settings.
 * Blocks ads/tracking and hides ad popups via JS injection (no clicking).
 */

const { chromium } = require('playwright');

const BLOCKED_RESOURCE_TYPES = ['media', 'font'];
const BLOCKED_DOMAINS = [
    'google-analytics.com',
    'googletagmanager.com',
    'facebook.net',
    'doubleclick.net',
    'analytics.',
    'hotjar.com',
    'tiktok.com',
    'snapchat.com',
    'klaviyo.com',
    'omnisend.com',
    'privy.com',
];

/**
 * Launch the base browser instance
 */
async function launchCoreBrowser(options = {}) {
    return await chromium.launch({
        headless: options.headless !== false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    });
}

/**
 * Create an isolated context with optimal settings
 */
async function createStandardContext(browser) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // 1. Route config
    await context.route('**/*', (route) => {
        const url = route.request().url();
        const resourceType = route.request().resourceType();

        if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) {
            return route.abort();
        }

        if (BLOCKED_DOMAINS.some((domain) => url.includes(domain))) {
            return route.abort();
        }

        return route.continue();
    });

    return context;
}

/**
 * Launch a headless Chromium browser and return { browser, context, page }
 * (Legacy support)
 */
async function launchBrowser(options = {}) {
    const browser = await launchCoreBrowser(options);
    const context = await createStandardContext(browser);
    const page = await context.newPage();

    return { browser, context, page };
}

/**
 * Continuously hides ads and checks for blocking overlays.
 * Only returns when no blocker is found for 2 consecutive polls, or if timeout is reached.
 */
async function waitNoBlockingOverlay(page, { timeoutMs = 5000, pollMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let stableCount = 0;

    while (Date.now() < deadline) {
        await hideAdPopups(page);

        const hasBlocker = await page.evaluate(() => {
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const centerX = viewportWidth / 2;
            const centerY = viewportHeight / 2;

            const isInterceptingCenter = (rect) => {
                return (
                    rect.left < centerX + 50 &&
                    rect.right > centerX - 50 &&
                    rect.top < centerY + 50 &&
                    rect.bottom > centerY - 50
                );
            };

            const blockers = Array.from(document.querySelectorAll('[role="dialog"], .modal, .popup, .overlay, [class*="popup"], [class*="modal"]'));
            for (const el of blockers) {
                if (el.closest('#formCustomization, .customily-app, .customily-form-content')) continue;
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && style.pointerEvents !== 'none') {
                    const rect = el.getBoundingClientRect();
                    // Catch large overlays or those intercepting the center
                    if ((rect.width > 100 && rect.height > 100 && parseInt(style.zIndex || '0', 10) > 100) || isInterceptingCenter(rect)) {
                        return true;
                    }
                }
            }
            const allElements = document.querySelectorAll('div, section, aside');
            for (const el of allElements) {
                 const style = window.getComputedStyle(el);
                 if (style.position === 'fixed' && style.display !== 'none' && style.pointerEvents !== 'none') {
                     const zIndex = parseInt(style.zIndex || '0', 10);
                     const rect = el.getBoundingClientRect();
                     if ((zIndex > 9000 && rect.width > 200 && rect.height > 200) || (zIndex > 500 && isInterceptingCenter(rect))) {
                         if (!el.closest('#formCustomization, .customily-app')) return true;
                     }
                 }
            }
            return false;
        });

        if (hasBlocker) {
            stableCount = 0;
            await page.waitForTimeout(pollMs);
        } else {
            stableCount++;
            if (stableCount >= 2) return true; // Stable
            await page.waitForTimeout(pollMs);
        }
    }
    return false; // Timed out with blockers still present
}

/**
 * Wait for Customizer to be loaded in the DOM, plus hide popups.
 */
async function waitForCustomizerReady(page, { maxMs = 15000, minMs = 2000, graceMs = 1500 } = {}) {
    console.log(`    ⏳ Waiting for Customizer Ready (min: ${minMs}ms, max: ${maxMs}ms)...`);
    const deadline = Date.now() + maxMs;
    let isReady = false;

    // Wait at least minMs to allow basic JS parsing
    await page.waitForTimeout(minMs);

    while (Date.now() < deadline) {
        await hideAdPopups(page); // keep clearing ads

        const readyStatus = await page.evaluate(() => {
            const hasApp = !!document.querySelector('canvas, .customily-gr, #customily-app, #formCustomization');
            const hasLoading = !!document.querySelector('#loadingElement, .customily-loading, .loading-spinner, .loading-overlay');
            if (!hasApp) return false;

            if (hasLoading) {
                const loadingEls = document.querySelectorAll('#loadingElement, .customily-loading, .loading-spinner, .loading-overlay');
                let isLoadingVisible = false;
                for (const el of loadingEls) {
                    const style = window.getComputedStyle(el);
                    if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                        isLoadingVisible = true; break;
                    }
                }
                return !isLoadingVisible;
            }
            return true; 
        });

        if (readyStatus) {
            isReady = true;
            break;
        }

        await page.waitForTimeout(500);
    }

    if (!isReady) {
        console.warn(`    ⚠️ Customizer element not fully ready after ${maxMs}ms. Proceeding anyway.`);
    } else {
        console.log(`    ✅ Customizer loaded. Running popup grace window (${graceMs}ms)...`);
        await waitNoBlockingOverlay(page, { timeoutMs: graceMs, pollMs: 500 });
    }
}

/**
 * Navigate to a product URL and wait for page load.
 * Now uses DYNAMIC waiting for the customizer instead of fixed timeouts.
 */
async function navigateToProduct(page, url, skipLongWait = false) {
    try {
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
    } catch (err) {
        console.warn('    ⚠️  First navigation attempt failed, retrying...');
        await page.goto(url, {
            waitUntil: 'commit',
            timeout: 60000,
        });
    }

    if (!skipLongWait) {
        await waitForCustomizerReady(page, { maxMs: 15000, minMs: 1500, graceMs: 1200 });
    } else {
        // Reduced from 1500 to 1000 for efficiency, while still giving Customily time to hydrate
        await waitForCustomizerReady(page, { maxMs: 8000, minMs: 1000, graceMs: 900 });
    }
    
    // Final cleanup before returning to start the test steps
    console.log('    🧹 Running final pre-test cleanup...');
    await hideAdPopups(page);
}

/**
 * Ensure clean page before any interaction.
 * Called before each test step to remove popup overlays that may have appeared.
 * Uses ONLY JavaScript injection — no clicking anywhere.
 */
async function ensureCleanPage(page) {
    await hideAdPopups(page);
}

/**
 * Hide all ad popups/overlays by injecting JavaScript.
 * This is SAFE — it never clicks anything, only sets display:none on known ad elements.
 *
 * Targeted patterns:
 *  - Klaviyo email popups (.kl-private-reset-css-*)
 *  - Promolayer countdown/coupon bars (.ply-widget)
 *  - Generic role="dialog" with POPUP/newsletter labels
 *  - Fixed elements with z-index > 9000 (except product/customizer)
 */
async function hideAdPopups(page) {
    await page.evaluate(() => {
        // 1. Klaviyo & Email popups
        document.querySelectorAll('.needsclick, [class*="kl-private"], [class*="klaviyo"], div[data-testid="klaviyo-form"]').forEach((el) => {
            el.remove();
        });

        // 2. Generic Popups/Modals/Overlays
        document.querySelectorAll('.modal, .popup, .overlay, [id*="popup"], [id*="modal"], [class*="popup"], [class*="modal"]').forEach((el) => {
            const text = (el.innerText || '').toLowerCase();
            const isAd = text.includes('off') || text.includes('discount') || text.includes('newsletter') || text.includes('subscribe') || text.includes('email') || text.includes('sign up');
            const isInsideCustomizer = el.closest('#formCustomization, .customily-app, .customily-form-content');
            
            if (isAd && !isInsideCustomizer) {
                el.remove();
            }
        });

        // 3. Promolayer & Bars
        document.querySelectorAll('.ply-widget, [id^="plyWidget"], .promo-bar, [class*="promo-bar"]').forEach((el) => {
            el.remove();
        });

        // 4. Fixed Close Buttons that might be floating
        document.querySelectorAll('[class*="close-popup"], [class*="modal__close"], [class*="popup__close"]').forEach(el => {
            el.remove();
        });

        // 5. Fixed-position overlays with very high z-index
        const safeParents = [
            '#formCustomization', '.customily-app', '.customily-form-content',
            '.product-info', '.product-form', '#product-form'
        ];

        document.querySelectorAll('div, section, aside').forEach((el) => {
            const style = window.getComputedStyle(el);
            const zIndex = parseInt(style.zIndex) || 0;
            if (style.position === 'fixed' && zIndex > 500) {
                const isSafe = safeParents.some((sel) => el.matches(sel) || el.closest(sel));
                if (!isSafe) {
                    el.remove();
                }
            }
        });

        // 6. Remove backdrops
        document.querySelectorAll('.modal-backdrop, [class*="backdrop"], .overlay-bg').forEach((el) => {
            el.remove();
        });
    });
}

/**
 * Close browser safely
 */
async function closeBrowser(browser) {
    if (browser) {
        await browser.close();
    }
}

module.exports = {
    launchCoreBrowser,
    createStandardContext,
    launchBrowser,
    navigateToProduct,
    closeBrowser,
    ensureCleanPage,
    waitNoBlockingOverlay,
    waitForCustomizerReady
};
