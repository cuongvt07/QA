#!/usr/bin/env node

/**
 * CLI Entry Point  — v3.0
 * Supports multi-case testing via option scanning + Gemini AI Vision evaluation.
 * Groups all cases under one TC folder: TC_1/case_1/, TC_1/case_2/
 *
 * Usage:
 *   node src/cli.js --url="https://..."                      # Run ALL option test cases
 *   node src/cli.js --url="https://..." --option-index=0     # Run specific option
 *   node src/cli.js --url="https://..." --scan               # Scan options only (no test)
 */

const path = require('path');
require('dotenv').config();
const yargs = require('yargs');
const { launchCoreBrowser, createStandardContext, navigateToProduct, closeBrowser } = require('./core/browser');
const ErrorListener = require('./core/error-listener');
const AiEvaluator = require('./core/ai-evaluator');
const { detectCustomizer, getVisibleOptionGroups, performCustomization, scanFirstPersonalizedGroup, clickAddToCart, handleProductVariants } = require('./actions/customizer');
const { validatePreviewImage, calculateVisualDiff, verifyCart, captureCartEvidence } = require('./actions/validator');
const { ensureDir, getNextTcCode, createTcDir, createCaseDir, buildCaseReport, buildCombinedReport, saveCombinedReport, printCaseSummary, printCombinedSummary } = require('./utils/reporter');
const { drawBoundingBox, drawMultipleBoundingBoxes } = require('./utils/annotate-image');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DIFF_AUTO_PASS_ZERO = process.env.DIFF_AUTO_PASS_ZERO === 'true';
const DIFF_AUTO_PASS_HIGH = parseFloat(process.env.DIFF_AUTO_PASS_HIGH || '50');

const argv = yargs
    .option('url', {
        alias: 'u',
        describe: 'Product URL to test',
        type: 'string',
        demandOption: true,
    })
    .option('headless', {
        describe: 'Run browser in headless mode',
        type: 'boolean',
        default: true,
    })
    .option('concurrency', {
        alias: 'c',
        describe: 'Number of parallel test cases',
        type: 'number',
        default: 2,
    })
    .option('scan', {
        describe: 'Scan product options only (no test run)',
        type: 'boolean',
        default: false,
    })
    .option('option-index', {
        describe: 'Run a specific option index only (0-based)',
        type: 'number',
        default: undefined,
    })
    .option('report-dir', {
        alias: 'r',
        describe: 'Base directory for reports',
        type: 'string',
        default: path.resolve(__dirname, '../web/reports'),
    })
    .option('no-ai', {
        describe: 'Disable AI evaluation',
        type: 'boolean',
        default: false,
    })
    .option('tc-code', {
        describe: 'Custom Test Case code (e.g., MEE001)',
        type: 'string',
    })
    .option('custom-image', {
        describe: 'Filename of custom default image to use for upload tests',
        type: 'string',
    })
    .option('tc', {
        describe: 'Alias for tc-code',
        type: 'string',
    })
    .help()
    .argv;


// ============================================================
// MAIN
// ============================================================
async function main() {
    const productUrl = argv.url;
    const isScanOnly = argv.scan;
    const specificIndex = argv['option-index'];
    const baseReportDir = argv['report-dir'];
    const concurrency = argv.concurrency;

    // Initialize AI Evaluator
    const generalAiDisabled = argv['no-ai'] === true || argv.ai === false;
    const aiEvaluator = new AiEvaluator(OPENAI_API_KEY, !generalAiDisabled);
    await aiEvaluator.init();

    console.log('🚀 Custom Product QA Tool v3.0');
    console.log(`   URL: ${productUrl}`);
    console.log(`   AI Evaluation: ${aiEvaluator.enabled ? '✅ Enabled' : '⚫ Disabled'}`);
    console.log(`   Concurrency: ${concurrency} cases parallel\n`);

    // Prepare TC Directory
    const globalStartTime = new Date();
    let tcCode = argv['tc-code'] || argv.tc || getNextTcCode(baseReportDir);
    tcCode = tcCode.replace(/[^a-z0-9_-]/gi, '_');
    const tcDir = createTcDir(baseReportDir, tcCode);

    try {
        // Launch single browser instance
        browser = await launchCoreBrowser({ headless: argv.headless });
        
        // Already prepared TC Directory above

        const runData = {
            test_case_label: tcCode,
            product_url: productUrl,
            test_time: globalStartTime.toISOString(),
            variants_selected: [],
            timeline: [],
            cases: []
        };

        // Scan phase (uses its own temporary context)
        const scanContext = await createStandardContext(browser);
        const scanPage = await scanContext.newPage();
        
        console.log('[1] Scanning product for options...');
        await navigateToProduct(scanPage, productUrl);

        // Phase 12: Handle Style/Size variants before customization
        console.log('    🛠️ Checking for product variants (Style/Size)...');
        runData.variants_selected = await handleProductVariants(scanPage);
        if (runData.variants_selected.length > 0) {
            console.log(`    [OK] Variants selected: ${runData.variants_selected.join(', ')}`);
        } else {
            console.log('    [INFO] No product variants detected or selected.');
        }
        
        let custResult = await detectCustomizer(scanPage);
        if (!custResult.found) {
            await scanPage.waitForTimeout(5000);
            custResult = await detectCustomizer(scanPage);
            if (!custResult.found) throw new Error('UI_NOT_FOUND: Customizer widget not detected.');
        }
        console.log(`    [OK] Found: ${custResult.selector}`);

        const scanResult = await scanFirstPersonalizedGroup(scanPage);
        if (!scanResult.found) {
            console.log('    [WARN] No personalized group found. Running single test case.');
        } else {
            console.log(`    [OK] Group: "${scanResult.groupName}" — ${scanResult.options.length} options found.`);
        }

        if (isScanOnly) {
            console.log('\n[INFO] Scan result (JSON):');
            console.log(JSON.stringify(scanResult, null, 2));
            await scanContext.close();
            await browser.close();
            return;
        }

        // Determine which cases to run
        const TARGET_CASE_COUNT = 2;
        let caseIndices = [];
        if (specificIndex !== undefined) {
            caseIndices = [specificIndex];
            if (scanResult.found) {
                const altIndex = scanResult.options.map(o => o.index).find(idx => idx !== specificIndex);
                if (altIndex !== undefined) caseIndices.push(altIndex);
            }
        } else if (scanResult.found) {
            caseIndices = scanResult.options.map(o => o.index).slice(0, TARGET_CASE_COUNT);
        } else {
            caseIndices = [null];
        }

        while (caseIndices.length < TARGET_CASE_COUNT) caseIndices.push(null);
        if (caseIndices.length > TARGET_CASE_COUNT) caseIndices = caseIndices.slice(0, TARGET_CASE_COUNT);

        await scanContext.close();

        // Already prepared TC Directory above
        console.log(`\n[TC] ${tcCode}: Dispatching ${caseIndices.length} cases (Parallel: ${concurrency})...\n`);

        const caseReports = [];
        const previouslySelectedValues = {}; // Limited visibility in parallel mode

        // Helper: Worker pool for parallel execution
        const runTestCase = async (caseIdx, optionIndex) => {
            const context = await createStandardContext(browser);
            const page = await context.newPage();
            const optionLabel = optionIndex !== null && scanResult.found
                ? scanResult.options[optionIndex]?.title || `Option ${optionIndex}`
                : 'Random';

            const logPrefix = `[Case ${caseIdx + 1}]`;
            console.log(`${logPrefix} Starting: ${optionLabel}`);

            const caseStartTime = new Date();
            const errorListener = new ErrorListener();
            errorListener.attachToPage(page);
            const caseDir = createCaseDir(tcDir, caseIdx);

            let lifecycleStepId = 0;
            const lifecycleTimeline = [];

            try {
                // [STEP 1] Open Page
                lifecycleStepId++;
                console.time(`${logPrefix} Phase 1: Navigation`);
                await navigateToProduct(page, productUrl, caseIdx > 0);
                console.timeEnd(`${logPrefix} Phase 1: Navigation`);
                
                lifecycleTimeline.push({
                    step_id: lifecycleStepId, action: 'open_page', name: 'Open Product Page',
                    status: 'PASS', message: 'Page loaded successfully.', group_type: 'lifecycle',
                    value_chosen: productUrl, state_before: '', state_after: '', diff_score: -1,
                    code_evaluation: { status: 'SKIPPED' }, ai_evaluation: { ai_verdict: 'SKIPPED' }
                });

                // [STEP 2] Load Customizer
                lifecycleStepId++;
                const reDetect = await detectCustomizer(page);
                if (!reDetect.found) throw new Error('Customizer widget not found.');
                lifecycleTimeline.push({
                    step_id: lifecycleStepId, action: 'load_customizer', name: 'Load Customizer Widget',
                    status: 'PASS', message: 'Customizer widget detected.', group_type: 'lifecycle',
                    value_chosen: reDetect.selector, state_before: '', state_after: '', diff_score: -1,
                    code_evaluation: { status: 'SKIPPED' }, ai_evaluation: { ai_verdict: 'SKIPPED' }
                });

                // [STEP 2] Handle Variants (Style/Size)
                console.time(`${logPrefix} Phase 2: Variants`);
                await handleProductVariants(page, logPrefix, runData);
                console.timeEnd(`${logPrefix} Phase 2: Variants`);

                // [STEP 3] Customization
                console.time(`${logPrefix} Phase 3: Customization`);
                const customizeTimeline = await performCustomization(page, caseDir, optionIndex, argv['custom-image'], {}, aiEvaluator);
                console.timeEnd(`${logPrefix} Phase 3: Customization`);
                customizeTimeline.forEach(s => s.step_id = ++lifecycleStepId);

                // [STEP 4] Evaluating steps (Parallel Visual Diff + AI)
                console.time(`${logPrefix} Phase 4: Evaluation`);
                const evaluationPromises = customizeTimeline.map(async (step) => {
                    const { diffPercent } = await calculateVisualDiff(step.state_before, step.state_after);
                    step.diff_score = diffPercent;
                    
                    if (step.is_label_confirmed || step.skip_diff_check || step.is_menu_opener) {
                        step.code_evaluation = { 
                            diff_score: diffPercent, 
                            status: 'PASS', 
                            message: step.is_label_confirmed ? 'Label confirmation found.' : 'Structural change detected.' 
                        };
                        step.status = 'PASS';
                        step.is_audit_pass = true;
                    } else if (DIFF_AUTO_PASS_ZERO && diffPercent <= 0.05) {
                        step.code_evaluation = { diff_score: diffPercent, status: 'PASS', message: `Auto-Pass: Negligible visual change (${diffPercent}%) (Audit Mode).` };
                        step.status = 'PASS';
                        step.is_audit_pass = true;
                    } else if (diffPercent >= DIFF_AUTO_PASS_HIGH) {
                        step.code_evaluation = { diff_score: diffPercent, status: 'PASS', message: `Auto-Pass: High visual diff > ${DIFF_AUTO_PASS_HIGH}% (Audit Mode).` };
                        step.status = 'PASS';
                        step.is_audit_pass = true;
                    } else {
                        // If it's at least 0.01%, it's likely a valid change (like short text)
                        const isPass = diffPercent >= 0.01;
                        step.code_evaluation = { diff_score: diffPercent, status: isPass ? 'PASS' : 'FAIL' };
                        step.status = isPass ? 'PASS' : 'FAIL';
                    }

                    if (aiEvaluator.enabled) {
                        // Phase 13: Skip AI if already passed by Audit Mode (auto-pass rules)
                        if (step.is_audit_pass) {
                            step.ai_evaluation = { ai_verdict: 'SKIPPED', ai_reason: 'Audit Mode Auto-Pass' };
                            return;
                        }

                        try {
                            let evalRes;
                            if (step.is_menu_opener || step.is_label_confirmed) {
                                evalRes = await aiEvaluator.evaluateInteraction(
                                    step.state_before, 
                                    step.state_after, 
                                    `${step.action}: ${step.name}`,
                                    step.value_chosen,
                                    step.is_label_confirmed
                                );
                            } else if (step.expects_visual_change) {
                                evalRes = await aiEvaluator.evaluateStep(step.state_before, step.state_after, step.name, step.value_chosen);
                            } else {
                                return;
                            }

                            step.ai_evaluation = { ai_score: evalRes.ai_score, ai_verdict: evalRes.ai_verdict, ai_reason: evalRes.ai_reason };
                            
                            // Only allow AI to change status if it's NOT an audit pass
                            if (!step.is_audit_pass) {
                                if (evalRes.ai_verdict === 'PASS') step.status = 'PASS';
                                else if (evalRes.ai_verdict === 'FAIL') step.status = 'FAIL';
                            } else {
                                console.log(`      [INFO] AI suggested ${evalRes.ai_verdict} but Audit Mode preserved PASS.`);
                            }
                        } catch (e) { 
                            step.ai_evaluation = { ai_verdict: 'ERROR', ai_reason: e.message }; 
                        }
                    }
                });
                await Promise.all(evaluationPromises);
                console.timeEnd(`${logPrefix} Phase 4: Evaluation`);

                // [STEP 5] Validate Preview
                const previewResult = await validatePreviewImage(page);
                lifecycleStepId++;
                const previewStep = {
                    step_id: lifecycleStepId, action: 'validate_preview', name: 'Preview Validation',
                    status: previewResult.valid ? 'PASS' : 'FAIL', message: previewResult.message || '',
                    group_type: 'lifecycle', value_chosen: previewResult.valid ? 'Valid' : 'Failed',
                    state_before: '', state_after: '', diff_score: -1,
                    code_evaluation: { status: 'SKIPPED' }, ai_evaluation: { ai_verdict: 'SKIPPED' }
                };

                // [STEP 6] Add to Cart
                await clickAddToCart(page);
                const cartResult = await verifyCart(page);
                lifecycleStepId++;
                const cartEvidence = await captureCartEvidence(page, caseDir, `step_${lifecycleStepId}_add_to_cart`);
                
                let cartAiEvaluation = { ai_verdict: 'SKIPPED' };
                if (aiEvaluator.enabled && cartEvidence.captured) {
                    try {
                        const cartAi = await aiEvaluator.evaluateCartResult({ viewportPath: cartEvidence.viewportPath, elementPath: cartEvidence.elementPath }, cartResult);
                        cartAiEvaluation = { ai_score: cartAi.ai_score, ai_verdict: cartAi.ai_verdict, ai_reason: cartAi.ai_reason };
                    } catch (e) { cartAiEvaluation = { ai_verdict: 'ERROR' }; }
                }

                const cartStep = {
                    step_id: lifecycleStepId, action: 'add_to_cart', name: 'Add to Cart',
                    status: cartResult.success ? 'PASS' : 'FAIL', message: cartResult.message,
                    group_type: 'lifecycle', value_chosen: cartResult.method,
                    state_before: '', state_after: cartEvidence.viewportPath || '', diff_score: -1,
                    code_evaluation: { status: 'SKIPPED' }, ai_evaluation: cartAiEvaluation
                };

                const fullTimeline = [...lifecycleTimeline, ...customizeTimeline, previewStep, cartStep];
                const errorSummary = errorListener.getSummary();
                const apiStatus = errorListener.getFatalApiStatus();
                const fatalReasons = [];
                if (!previewResult.valid) fatalReasons.push(`Preview Crash: ${previewResult.error}`);
                if (apiStatus.isFatal) fatalReasons.push(...apiStatus.reasons);

                const caseReport = buildCaseReport({
                    caseIndex: caseIdx, optionLabel, timeline: fullTimeline, errorSummary,
                    cartResult, previewResult, startTime: caseStartTime, aiEnabled: aiEvaluator.enabled,
                    is_fatal: fatalReasons.length > 0, fatal_reasons: fatalReasons
                });

                // [STEP 7] Final AI Review
                console.time(`${logPrefix} Phase 5: AI Review`);
                const lastStepWithAfter = [...customizeTimeline].reverse().find(s => s.state_after);
                if (aiEvaluator.enabled && previewResult.valid && lastStepWithAfter) {
                    try {
                        const aiFinal = await aiEvaluator.evaluateFinalPreview(lastStepWithAfter.state_after, caseReport);
                        let reviewedImage = lastStepWithAfter.state_after;
                        if (aiFinal.detected_elements?.length > 0) {
                            const annotPath = reviewedImage.replace('.png', '_annotated_final.png');
                            const boxes = aiFinal.detected_elements.map(el => ({ bbox: el.bbox, color: el.color }));
                            if (await drawMultipleBoundingBoxes(reviewedImage, annotPath, boxes)) reviewedImage = annotPath;
                        }
                        caseReport.final_evaluation.ai_review = {
                            ai_verdict: aiFinal.ai_verdict, ai_reason: aiFinal.ai_reason,
                            reviewed_image: reviewedImage, detected_elements: aiFinal.detected_elements || []
                        };
                    } catch (e) { console.error(`${logPrefix} AI Final Review Error: ${e.message}`); }
                }

                // Snapshots
                if (caseReport.status === 'FAIL' || caseReport.status === 'FATAL') {
                    try {
                        const snapshotPath = path.join(caseDir, 'snapshot.html');
                        require('fs').writeFileSync(snapshotPath, await page.content(), 'utf8');
                        caseReport.html_snapshot = snapshotPath;
                    } catch (e) {}
                }
                console.timeEnd(`${logPrefix} Phase 5: AI Review`);
                
                printCaseSummary(caseReport, caseIdx);
                caseReports.push(caseReport);

            } catch (err) {
                console.error(`${logPrefix} Critical Error: ${err.message}`);
                caseReports.push({ case_index: caseIdx, case_label: optionLabel, status: 'FATAL', score: 0, fatal_reasons: [err.message] });
            } finally {
                await context.close();
                console.log(`${logPrefix} Finished.`);
            }
        };

        // Execute with concurrency limit
        const active = new Set();
        for (let i = 0; i < caseIndices.length; i++) {
            const promise = runTestCase(i, caseIndices[i]);
            active.add(promise);
            promise.finally(() => active.delete(promise));
            
            if (active.size >= concurrency) {
                await Promise.race(active);
            }
        }
        await Promise.all(active);

        // Final Report
        const combinedReport = buildCombinedReport({ 
            productUrl, 
            tcCode, 
            cases: caseReports, 
            startTime: globalStartTime, 
            aiEnabled: aiEvaluator.enabled,
            variants_selected: runData.variants_selected
        });
        const reportPath = saveCombinedReport(combinedReport, tcDir);
        console.log(`\n📄 Combined Report: ${reportPath}`);
        printCombinedSummary(combinedReport);

    } catch (error) {
        console.error(`\n❌ Fatal error: ${error.message}\n`);
        process.exit(2);
    } finally {
        if (browser) await browser.close();
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(2);
});
