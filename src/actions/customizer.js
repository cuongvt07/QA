/**
 * Customizer Module — v2.1
 * Handles dynamic option groups that appear after selections.
 * Re-scans after each interaction to discover new groups.
 */

const path = require('path');
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
    '.customily-preview img',
    '#customily-main-image',
    'img.preview',
    'img[class*="preview"]',
    '.preview-image img',
    'canvas',
    '#product-image img',
    '.product-image-main img',
];

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

/**
 * Get currently visible customily-gr groups.
 * Returns fresh list each call (handles dynamically appeared groups).
 */
async function getVisibleOptionGroups(page) {
    const groups = [];
    const elements = await page.$$(OPTION_GROUP_SELECTOR);

    for (const el of elements) {
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;

        // Get group name
        const nameEl = await el.$('.customization-info-name, .option-title, .customily-label-asb');
        let name = '';
        if (nameEl) {
            name = (await nameEl.textContent()).trim();
            // Clean up whitespace / newlines
            name = name.replace(/\s+/g, ' ').trim();
        }

        // Get a unique identifier for this group to avoid duplicates
        const groupId = await el.evaluate((node) => {
            return node.getAttribute('data-group-id')
                || node.getAttribute('id')
                || node.className
                || '';
        });

        // Identify type
        const optionItems = await el.$$(OPTION_ITEM_SELECTORS.join(', '));
        const textInputs = await el.$$(TEXT_INPUT_SELECTORS.join(', '));
        const selectDropdowns = await el.$$('select.customily-input, select.variant-select');

        let type = 'unknown';
        if (textInputs.length > 0) type = 'text_input';
        else if (selectDropdowns.length > 0) type = 'dropdown';
        else if (optionItems.length > 0) type = 'image_option';

        if (type === 'unknown') continue;

        groups.push({
            element: el,
            name,
            type,
            groupId,
            optionItems,
            textInputs,
            selectDropdowns,
        });
    }

    return groups;
}

/**
 * Capture screenshot of preview area
 */
async function capturePreviewScreenshot(page, filepath) {
    for (const selector of PREVIEW_IMAGE_SELECTORS) {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
            await el.screenshot({ path: filepath });
            return filepath;
        }
    }
    // Fallback: viewport screenshot
    await page.screenshot({ path: filepath, fullPage: false });
    return filepath;
}

/**
 * Scan the first customily-gr image_option group
 * after interacting with all prior groups.
 * This ensures dynamic sub-groups are loaded.
 */
async function scanFirstPersonalizedGroup(page) {
    const groups = await getVisibleOptionGroups(page);
    const firstImageGroup = groups.find((g) => g.type === 'image_option');

    if (!firstImageGroup) {
        return { found: false, groupName: null, options: [] };
    }

    const options = [];
    for (let i = 0; i < firstImageGroup.optionItems.length; i++) {
        const item = firstImageGroup.optionItems[i];
        const title = (await item.getAttribute('title')) || `Option ${i + 1}`;
        let thumbnail = '';
        const thumbImg = await item.$('img');
        if (thumbImg) {
            thumbnail = (await thumbImg.getAttribute('src'))
                || (await thumbImg.getAttribute('data-src')) || '';
        }
        options.push({ index: i, title, thumbnail });
    }

    return {
        found: true,
        groupName: firstImageGroup.name,
        options,
    };
}

/**
 * Perform customization by iterating through ALL customily-gr groups.
 * Re-scans after each step to catch newly appeared groups.
 *
 * @param {Page} page - Playwright page
 * @param {string} screenshotDir - Directory for this testcase's screenshots
 * @param {number|null} fixedOptionIndex - Fixed option for first image group (null = random)
 * @returns {Array} timeline of step objects
 */
async function performCustomization(page, screenshotDir, fixedOptionIndex) {
    const timeline = [];
    let stepIndex = 0;
    let isFirstImageGroup = true;
    const processedGroups = new Set();

    // Iterative loop: keep scanning for new groups after each interaction
    let maxIterations = 30; // Safety limit
    while (maxIterations-- > 0) {
        // Re-scan groups each iteration
        const groups = await getVisibleOptionGroups(page);
        let foundNewGroup = false;

        for (const group of groups) {
            // Generate a signature to track processed groups
            const signature = group.name + '|' + group.type + '|' + group.groupId;
            if (processedGroups.has(signature)) continue;

            processedGroups.add(signature);
            foundNewGroup = true;
            stepIndex++;

            // Determine if this group type affects the preview image
            // dropdown (select.customily-input) & text_input (form-control.customily-input) → non-visual
            // image_option (customization-option-item) → visual
            const expectsVisualChange = group.type === 'image_option';

            const stepData = {
                step_id: stepIndex,
                action: '',
                name: group.name,
                group_type: group.type,
                expects_visual_change: expectsVisualChange,
                skip_diff_check: !expectsVisualChange,
                value_chosen: '',
                option_thumbnail: '',
                state_before: '',
                state_after: '',
                diff_score: -1,
                status: 'PASS',
                message: '',
                code_evaluation: { diff_score: -1, status: 'PENDING' },
                ai_evaluation: { ai_score: -1, ai_verdict: 'PENDING', ai_reason: '' },
            };

            try {
                // Dismiss any popups before interacting
                await ensureCleanPage(page);

                // Delay 1s to let preview finish rendering before switching option
                await page.waitForTimeout(1000);

                // Capture state BEFORE action
                const beforePath = path.join(screenshotDir, `step_${stepIndex}_before.png`);
                await capturePreviewScreenshot(page, beforePath);
                stepData.state_before = beforePath;

                if (group.type === 'text_input') {
                    stepData.action = 'Input Text';
                    const input = group.textInputs[0];
                    const placeholder = (await input.getAttribute('placeholder')) || '';

                    let value = mockData.getRandomName();
                    if (placeholder.toLowerCase().includes('year') || group.name.toLowerCase().includes('year')) {
                        value = mockData.getRandomYear();
                    } else if (/pet|cat|dog/i.test(group.name)) {
                        value = mockData.getRandomPetName();
                    }

                    // Try a combination of fill + native typing + events to ensure Customily catches it
                    await input.focus();
                    await input.fill(''); // Clear first
                    await input.fill(value);
                    
                    // Dispatch events just in case
                    await input.evaluate((node) => {
                        node.dispatchEvent(new Event('input', { bubbles: true }));
                        node.dispatchEvent(new Event('change', { bubbles: true }));
                    });

                    await page.keyboard.press('Enter');
                    await input.evaluate((node) => node.blur());
                    
                    await page.waitForTimeout(800); // Give it time to render text
                    
                    stepData.value_chosen = value;

                } else if (group.type === 'dropdown') {
                    stepData.action = 'Select Dropdown';
                    const select = group.selectDropdowns[0];
                    const options = await select.$$('option:not([disabled])');

                    if (options.length > 0) {
                        const randomIndex = Math.floor(Math.random() * options.length);
                        const optionValue = await options[randomIndex].getAttribute('value');
                        const optionText = (await options[randomIndex].textContent()).trim();

                        await ensureCleanPage(page);
                        await select.selectOption(optionValue);
                        stepData.value_chosen = optionText;
                    }

                } else if (group.type === 'image_option') {
                    stepData.action = 'Select Option';
                    const items = group.optionItems;

                    if (items.length > 0) {
                        let targetItem;

                        if (isFirstImageGroup && fixedOptionIndex !== null && fixedOptionIndex !== undefined) {
                            const idx = Math.min(fixedOptionIndex, items.length - 1);
                            targetItem = items[idx];
                            isFirstImageGroup = false;
                        } else {
                            const nonActiveItems = [];
                            for (const item of items) {
                                const cls = (await item.getAttribute('class')) || '';
                                if (!cls.includes('active')) {
                                    nonActiveItems.push(item);
                                }
                            }
                            const pool = nonActiveItems.length > 0 ? nonActiveItems : items;
                            targetItem = pool[Math.floor(Math.random() * pool.length)];
                            if (isFirstImageGroup) isFirstImageGroup = false;
                        }

                        const title = (await targetItem.getAttribute('title')) || '';
                        stepData.value_chosen = title;

                        const thumbImg = await targetItem.$('img');
                        if (thumbImg) {
                            stepData.option_thumbnail = (await thumbImg.getAttribute('src'))
                                || (await thumbImg.getAttribute('data-src')) || '';
                        }

                        await ensureCleanPage(page);
                        await targetItem.click({ force: true });
                        stepData.message = 'Option selected successfully.';
                    }
                }

                // Wait for loading / preview render / new groups to appear
                await page.waitForTimeout(3000);

                // Dismiss popups that may have appeared during wait
                await ensureCleanPage(page);

                // Capture state AFTER action
                const afterPath = path.join(screenshotDir, `step_${stepIndex}_after.png`);
                await capturePreviewScreenshot(page, afterPath);
                stepData.state_after = afterPath;

            } catch (error) {
                stepData.status = 'FAIL';
                stepData.message = `ERROR: ${error.message}`;
            }

            timeline.push(stepData);

            // Break inner loop after each step to re-scan from top
            break;
        }

        // If no new groups were found, we're done
        if (!foundNewGroup) break;
    }

    return timeline;
}

/**
 * Click Add To Cart button
 */
async function clickAddToCart(page) {
    await ensureCleanPage(page);
    for (const selector of ADD_TO_CART_SELECTORS) {
        try {
            const btn = await page.$(selector);
            if (btn && await btn.isVisible()) {
                await btn.click({ force: true });
                return { success: true, selector };
            }
        } catch (e) {
            continue;
        }
    }
    return { success: false, selector: null };
}

module.exports = {
    detectCustomizer,
    getVisibleOptionGroups,
    capturePreviewScreenshot,
    performCustomization,
    scanFirstPersonalizedGroup,
    clickAddToCart,
};
