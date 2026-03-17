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

    // Use 15s wait for first case, shorter 3s for subsequent cases
    if (!skipLongWait) {
        console.log('    ⏳ Waiting 15s for page and popups to settle...');
        await page.waitForTimeout(15000);
    } else {
        console.log('    ⏳ Quick wait 3s (subsequent case)...');
        await page.waitForTimeout(3000);
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
};
