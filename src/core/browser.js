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
];

/**
 * Launch a headless Chromium browser and return { browser, context, page }
 */
async function launchBrowser(options = {}) {
    const browser = await chromium.launch({
        headless: options.headless !== false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
    });

    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });

    // Route config
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

    const page = await context.newPage();

    return { browser, context, page };
}

/**
 * Navigate to a product URL and wait for page load.
 * Uses multi-phase popup cleanup: initial + delayed.
 */
async function navigateToProduct(page, url) {
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

    // Phase 1: Wait 8s for all popups to appear (Klaviyo, Promolayer, etc.)
    await page.waitForTimeout(8000);
    await hideAdPopups(page);

    // Phase 2: Wait 3s more for any late popups
    await page.waitForTimeout(3000);
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
        // 1. Klaviyo popup — "TAKE 10% OFF" email form
        //    Exact class: .needsclick.kl-private-reset-css-Xuajs1
        document.querySelectorAll('.needsclick.kl-private-reset-css-Xuajs1, [class*="kl-private-reset-css"]').forEach((el) => {
            el.style.setProperty('display', 'none', 'important');
            // Also hide the parent wrapper div
            if (el.parentElement) {
                el.parentElement.style.setProperty('display', 'none', 'important');
            }
        });
        document.querySelectorAll('div[data-testid="klaviyo-form"]').forEach((el) => {
            el.style.setProperty('display', 'none', 'important');
        });
        // Hide Klaviyo fixed backdrop
        document.querySelectorAll('[class*="klaviyo"]').forEach((el) => {
            if (window.getComputedStyle(el).position === 'fixed') {
                el.style.setProperty('display', 'none', 'important');
            }
        });

        // 2. Promolayer countdown widget — "Grab your deal" bar
        document.querySelectorAll('.ply-widget, [id^="plyWidget"]').forEach((el) => {
            el.style.setProperty('display', 'none', 'important');
        });

        // 3. Generic popup dialogs (but NOT the product customizer)
        document.querySelectorAll('[role="dialog"]').forEach((el) => {
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            const isAdPopup = label.includes('popup')
                || label.includes('newsletter')
                || label.includes('discount')
                || label.includes('subscribe')
                || label.includes('email');
            if (isAdPopup) {
                el.style.setProperty('display', 'none', 'important');
            }
        });

        // 4. Fixed-position overlays with very high z-index (>9000)
        //    Skip anything inside the product customizer area
        const safeParents = [
            '#formCustomization', '.customily-app', '.customily-form-content',
            '.product-info', '.product-form', '#product-form',
            '[class*="customiz"]', '[class*="personaliz"]',
        ];

        document.querySelectorAll('body > div, body > section').forEach((el) => {
            const style = window.getComputedStyle(el);
            const zIndex = parseInt(style.zIndex) || 0;
            if (style.position === 'fixed' && zIndex > 9000) {
                const isSafe = safeParents.some((sel) => el.matches(sel) || el.querySelector(sel));
                if (!isSafe) {
                    el.style.setProperty('display', 'none', 'important');
                }
            }
        });

        // 5. Remove modal backdrops
        document.querySelectorAll('.modal-backdrop, [class*="backdrop"]').forEach((el) => {
            const style = window.getComputedStyle(el);
            if (style.position === 'fixed') {
                el.style.setProperty('display', 'none', 'important');
            }
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
    launchBrowser,
    navigateToProduct,
    closeBrowser,
    ensureCleanPage,
};
