/**
 * Customizer Module — v3.1
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
    '.customily-preview img',
    '#customily-main-image',
    'img.preview',
    'img[class*="preview"]',
    '.preview-image img',
    'canvas',
    '#product-image img',
    '.product-image-main img',
];

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

async function extractOptionColor(optionElement) {
    try {
        const rawColor = await optionElement.evaluate((node) => {
            const transparentSet = new Set(['transparent', 'rgba(0, 0, 0, 0)']);
            const candidates = [];
            const addCandidate = (value) => {
                if (!value || typeof value !== 'string') return;
                const cleaned = value.trim();
                if (!cleaned) return;
                candidates.push(cleaned);
            };

            addCandidate(node.getAttribute('data-color'));
            addCandidate(node.getAttribute('data-value'));

            const inlineStyle = node.getAttribute('style') || '';
            const bgMatch = inlineStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
            if (bgMatch && bgMatch[1]) addCandidate(bgMatch[1]);

            const preferred = node.querySelectorAll('[class*="swatch"], [class*="color"], [style*="background"]');
            const fallback = node.querySelectorAll('span, div');
            const inspectList = [node, ...Array.from(preferred).slice(0, 20), ...Array.from(fallback).slice(0, 20)];

            for (const el of inspectList) {
                const style = window.getComputedStyle(el);
                const bg = style.backgroundColor;
                if (bg && !transparentSet.has(bg)) {
                    addCandidate(bg);
                }
            }

            return candidates[0] || '';
        });

        const colorHex = toColorHex(rawColor);
        return {
            raw: rawColor || '',
            hex: colorHex || '',
        };
    } catch {
        return { raw: '', hex: '' };
    }
}

/**
 * Smart wait for post-interaction loading.
 */
async function smartWait(page) {
    let apiDetected = false;
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
    // Reduced from 2s to 1s to speed up steps
    await page.waitForTimeout(1000);
    page.off('request', requestListener);

    if (apiDetected) {
        console.log('      [WAIT] API request detected, waiting for loading to finish...');
        try {
            await page.waitForSelector('#loadingElement, .customily-loading, .loading-spinner, .loading-overlay, .spinner', {
                state: 'hidden',
                timeout: 20000
            });
            await page.waitForTimeout(500); // Reduced from 800ms
        } catch (e) {
            console.warn('      [WARN] SmartWait: Loading timer exceeded 20s (likely background activity).');
            // Don't throw to prevent crashing the whole test case for minor issues
        }
    } else {
        console.log('      [SKIP] No API request (cached), proceeding immediately.');
        await page.waitForTimeout(100); // Reduced from 200ms
    }
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

/**
 * Get currently visible customily-gr groups.
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
    for (const selector of PREVIEW_IMAGE_SELECTORS) {
        const el = await page.$(selector);
        if (el && await el.isVisible()) {
            await el.screenshot({ path: filepath });
            return filepath;
        }
    }
    await page.screenshot({ path: filepath, fullPage: false });
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
        const colorMeta = await extractOptionColor(item);
        const rawTitle = (await item.getAttribute('title')) || '';
        const title = rawTitle || (colorMeta.hex ? `Color ${colorMeta.hex}` : `Option ${i + 1}`);
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

    while (maxIterations-- > 0) {
        // Periodically remove popups/Klaviyo elements that might have appeared
        await ensureCleanPage(page);
        await page.waitForTimeout(500);

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
            const skipDiffCheck = group.type === 'dropdown';

            const stepData = {
                step_id: stepIndex,
                action: '',
                name: group.name,
                group_type: group.type,
                expects_visual_change: expectsVisualChange,
                skip_diff_check: skipDiffCheck,
                requires_ocr: group.type === 'text_input',
                value_chosen: '',
                option_thumbnail: '',
                option_color: '',
                option_color_hex: '',
                state_before: '',
                state_after: '',
                diff_score: -1,
                status: 'PASS',
                message: '',
                code_evaluation: { diff_score: -1, status: 'PENDING' },
                ai_evaluation: { ai_score: -1, ai_verdict: 'PENDING', ai_reason: '' },
            };

            try {
                // Optimized: Reuse the "After" of the previous step as "Before" of this step
                let beforePath = path.join(screenshotDir, `step_${stepIndex}_before.png`);
                let alreadyCapturedBefore = false;

                if (stepIndex > 1) {
                    const prevAfterPath = path.join(screenshotDir, `step_${stepIndex - 1}_after.png`);
                    if (fs.existsSync(prevAfterPath)) {
                        fs.copyFileSync(prevAfterPath, beforePath);
                        alreadyCapturedBefore = true;
                    }
                }

                if (!alreadyCapturedBefore) {
                    await smartWait(page);
                    await capturePreviewScreenshot(page, beforePath);
                }
                
                stepData.state_before = beforePath;

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
                    await page.waitForTimeout(1000);
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
                    await smartWait(page);

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
                            for (const item of items) {
                                const cls = (await item.getAttribute('class')) || '';
                                if (!cls.includes('active')) {
                                    const colorMeta = await extractOptionColor(item);
                                    const optionKey = (await item.getAttribute('title')) || colorMeta.hex || colorMeta.raw || '';
                                    allNonActiveItems.push(item);
                                    if (!prevSet.has(optionKey)) nonActiveItems.push(item);
                                }
                            }
                            if (allNonActiveItems.length === 0) {
                                skipClick = true;
                                targetItem = items[0];
                            } else {
                                targetItem = (nonActiveItems.length > 0 ? nonActiveItems : allNonActiveItems)[Math.floor(Math.random() * (nonActiveItems.length > 0 ? nonActiveItems.length : allNonActiveItems.length))];
                            }
                            if (isFirstImageGroup) isFirstImageGroup = false;
                        }
                        const colorMeta = await extractOptionColor(targetItem);
                        stepData.value_chosen = (await targetItem.getAttribute('title')) || (colorMeta.hex ? `Color ${colorMeta.hex}` : 'Selected option');
                        stepData.option_color = colorMeta.raw || '';
                        stepData.option_color_hex = colorMeta.hex || '';
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

                await smartWait(page);

                // Capture structural state after
                const groupsAfter = await getVisibleOptionGroups(page);
                const countAfter = groupsAfter.length;
                if (countAfter > countBefore) {
                    console.log(`      [INFO] Menu Opener detected: groups increased ${countBefore} -> ${countAfter}`);
                    stepData.is_menu_opener = true;
                    stepData.expects_visual_change = false; 
                    stepData.skip_diff_check = true;
                    // Extra wait for sub-menu animations/rendering
                    await page.waitForTimeout(2000);
                }

                // LABEL MATCHING: Check if chosen value appears in customization labels
                if (stepData.value_chosen) {
                    const chosenLower = stepData.value_chosen.toLowerCase();
                    const labelsAfter = await page.$$eval('.customization-info-name, .customily-personalization-info', els => els.map(el => el.innerText.toLowerCase()));
                    
                    // If the choice appears in a label that wasn't there before OR any label matches exactly
                    const foundMatch = labelsAfter.some(l => l.includes(chosenLower));
                    if (foundMatch) {
                        console.log(`      [INFO] Label confirmation: Choice "${stepData.value_chosen}" found in DOM labels.`);
                        stepData.is_label_confirmed = true;
                        stepData.skip_diff_check = true; // High confidence Pass
                    }
                }

                const afterPath = path.join(screenshotDir, `step_${stepIndex}_after.png`);
                await capturePreviewScreenshot(page, afterPath);
                stepData.state_after = afterPath;

            } catch (error) {
                stepData.status = 'FAIL';
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
async function handleProductVariants(page) {
    const selector = '.js-select-variant, .variant-select, select[name*="variant"], select[id*="variant"]';
    const elements = await page.$$(selector);
    const results = [];

    for (const el of elements) {
        try {
            const isVisible = await el.isVisible();
            if (!isVisible) continue;

            const tagName = await el.evaluate(node => node.tagName.toLowerCase());
            
            if (tagName === 'select') {
                // Standard SELECT handling
                const name = await el.evaluate(node => {
                    const label = document.querySelector(`label[for="${node.id}"]`);
                    return (label ? label.innerText : (node.name || node.id || 'Variant')).trim();
                });

                const value = await el.inputValue();
                const hasSelection = value && value !== '' && !value.toLowerCase().includes('select');

                if (!hasSelection) {
                    const options = await el.$$eval('option', opts => {
                        return opts
                            .map((o, i) => ({ index: i, value: o.value, text: o.innerText.trim(), disabled: o.disabled }))
                            .filter(o => !o.disabled && o.value && !o.value.toLowerCase().includes('select') && o.text.toLowerCase().indexOf('select') === -1);
                    });

                    if (options.length > 0) {
                        const firstValid = options[0];
                        await el.selectOption(firstValid.value);
                        results.push(`${name}: ${firstValid.text}`);
                        console.log(`      [VARIANT] Selected ${name}: ${firstValid.text}`);
                    }
                } else {
                    const selectedText = await el.evaluate(node => node.options[node.selectedIndex].text.trim());
                    results.push(`${name}: ${selectedText} (Pre-selected)`);
                    console.log(`      [VARIANT] Already selected ${name}: ${selectedText}`);
                }
            } else {
                // Custom UI handling (like the UL/LI Size list)
                const name = await el.evaluate(node => {
                    const label = node.querySelector('label') || document.querySelector(`label[for="${node.id}"]`);
                    return (label ? label.innerText : (node.getAttribute('arial-label') || 'Variant')).trim();
                });

                // Check if already selected (look for text that doesn't say "Choose")
                const currentText = await el.evaluate(node => {
                    const chooseDiv = node.querySelector('.choose-a-size, .current-value, .selected-value');
                    return chooseDiv ? chooseDiv.innerText.trim() : '';
                });

                if (!currentText || currentText.toLowerCase().includes('choose')) {
                    // Need to select
                    const items = await el.$$('.js-choose-variant, .product-size-item:not(.close-choose-size), li[ng-click*="selectVariant"]');
                    if (items.length > 0) {
                        // Sometimes need to click to open the list first
                        const opener = await el.$('.choose-a-size, .choose-option');
                        if (opener) await opener.click();
                        
                        await page.waitForTimeout(300);
                        
                        // Select first valid item
                        const firstItem = items[0];
                        const itemText = await firstItem.innerText();
                        await firstItem.click();
                        results.push(`${name}: ${itemText.trim()}`);
                        console.log(`      [VARIANT] Clicked ${name}: ${itemText.trim()}`);
                        
                        await page.waitForTimeout(500); 
                    }
                } else {
                    results.push(`${name}: ${currentText} (Pre-selected)`);
                    console.log(`      [VARIANT] Already selected ${name}: ${currentText}`);
                }
            }
        } catch (e) {
            console.warn(`      [WARN] Failed to handle variant: ${e.message}`);
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
            await footer.scrollIntoViewIfNeeded();
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
