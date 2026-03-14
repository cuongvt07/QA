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
const { launchBrowser, navigateToProduct, closeBrowser } = require('./core/browser');
const ErrorListener = require('./core/error-listener');
const AiEvaluator = require('./core/ai-evaluator');
const { detectCustomizer, performCustomization, scanFirstPersonalizedGroup, clickAddToCart } = require('./actions/customizer');
const { validatePreviewImage, calculateVisualDiff, verifyCart } = require('./actions/validator');
const { ensureDir, getNextTcCode, createTcDir, createCaseDir, buildCaseReport, buildCombinedReport, saveCombinedReport, printCaseSummary, printCombinedSummary } = require('./utils/reporter');
const { initOcrWorker, terminateOcrWorker, verifyTextOnPreview } = require('./utils/ocr-validator');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

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
        default: path.resolve(__dirname, '../../web/reports'),
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

    // Initialize AI Evaluator
    const aiEvaluator = new AiEvaluator(argv['no-ai'] ? null : GEMINI_API_KEY);
    await aiEvaluator.init();

    console.log('🚀 Custom Product QA Tool v3.0');
    console.log(`   URL: ${productUrl}`);
    console.log(`   AI Evaluation: ${aiEvaluator.enabled ? '✅ Enabled' : '⚫ Disabled'}`);
    console.log('   OCR Text Check: ✅ Enabled\n');

    // Initialize OCR worker
    await initOcrWorker();

    let browser = null;

    try {
        // Launch browser
        const result = await launchBrowser({ headless: argv.headless });
        browser = result.browser;
        const page = result.page;

        // Navigate
        console.log('[1] Navigating to product page...');
        await navigateToProduct(page, productUrl);
        console.log('    ✅ Page loaded');

        // Detect customizer
        console.log('[2] Detecting customizer widget...');
        let custResult = await detectCustomizer(page);
        if (!custResult.found) {
            await page.waitForTimeout(5000);
            custResult = await detectCustomizer(page);
            if (!custResult.found) throw new Error('UI_NOT_FOUND: Customizer widget not detected.');
        }
        console.log(`    ✅ Found: ${custResult.selector}`);

        // Scan first personalized group
        console.log('[3] Scanning first personalized option group...');
        const scanResult = await scanFirstPersonalizedGroup(page);

        if (!scanResult.found) {
            console.log('    ⚠️  No personalized image option group found. Running single test case.');
        } else {
            console.log(`    ✅ Group: "${scanResult.groupName}" — ${scanResult.options.length} options found:`);
            scanResult.options.forEach((opt) => {
                console.log(`       [${opt.index}] ${opt.title}`);
            });
        }

        // Scan-only mode: just print and exit
        if (isScanOnly) {
            console.log('\n📋 Scan result (JSON):');
            console.log(JSON.stringify(scanResult, null, 2));
            await closeBrowser(browser);
            return;
        }

        // Determine which cases to run
        let caseIndices = [];
        if (specificIndex !== undefined) {
            caseIndices = [specificIndex];
        } else if (scanResult.found) {
            caseIndices = scanResult.options.map((o) => o.index);
        } else {
            caseIndices = [null]; // Single random test case
        }

        // Create one TC folder for all cases
        const globalStartTime = new Date();
        
        let tcCode = argv['tc-code'] || argv.tc;
        if (!tcCode) {
             tcCode = getNextTcCode(baseReportDir);
        } else {
             // Sanitize filename
             tcCode = tcCode.replace(/[^a-z0-9_-]/gi, '_');
        }

        const tcDir = createTcDir(baseReportDir, tcCode);

        console.log(`\n🧪 ${tcCode}: Running ${caseIndices.length} case(s)...\n`);

        const caseReports = [];

        // Run each case sequentially
        for (let caseIdx = 0; caseIdx < caseIndices.length; caseIdx++) {
            const optionIndex = caseIndices[caseIdx];
            const optionLabel = optionIndex !== null && scanResult.found
                ? scanResult.options[optionIndex]?.title || `Option ${optionIndex}`
                : 'Random';

            console.log(`${'═'.repeat(50)}`);
            console.log(`  ${tcCode} — CASE ${caseIdx + 1}/${caseIndices.length}: ${optionLabel}`);
            console.log(`${'═'.repeat(50)}`);

            const caseStartTime = new Date();
            const errorListener = new ErrorListener();
            errorListener.attachToPage(page);

            // Create case sub-directory: TC_1/case_1/
            const caseDir = createCaseDir(tcDir, caseIdx);

            // Reload page for each case to reset state
            if (caseIdx > 0 || (caseIdx === 0 && scanResult.didMutate)) {
                console.log('  [↻] Reloading page to reset state...');
                await navigateToProduct(page, productUrl);
                await page.waitForTimeout(3000);

                // Re-detect customizer after reload
                let reDetect = await detectCustomizer(page);
                if (!reDetect.found) {
                    await page.waitForTimeout(5000);
                    reDetect = await detectCustomizer(page);
                }
            }

            // Perform customization — screenshots saved into case folder
            console.log('  [5] Performing customization (top to bottom)...');
            const timeline = await performCustomization(page, caseDir, optionIndex);
            console.log(`      ✅ ${timeline.length} steps completed`);

            // Calculate visual diffs + AI evaluation for each step
            console.log('  [6] Evaluating steps (Code + AI)...');
            for (const step of timeline) {
                if (step.skip_diff_check) {
                    step.status = 'PASS';
                    step.diff_score = 0;
                    step.code_evaluation = { diff_score: 0, status: 'SKIPPED' };
                    step.ai_evaluation = {
                        ai_score: 100,
                        ai_verdict: 'SKIPPED',
                        ai_reason: step.expects_visual_change === false
                            ? `Non-visual element (${step.group_type}): does not affect preview`
                            : 'Dropdown placeholder or non-visual step',
                    };
                    console.log(`      Step ${step.step_id}: ${step.action} [NON-VISUAL → AUTO PASS]`);
                    continue;
                }

                // Code-based evaluation (Pixelmatch) — only for visual steps
                if (step.state_before && step.state_after) {
                    const { diffPercent } = await calculateVisualDiff(step.state_before, step.state_after);
                    step.diff_score = diffPercent;

                    // Stricter threshold (> 0.05%) for all visual changes to prevent false positives from sub-pixel rendering stutters
                    const diffThreshold = 0.05;
                    step.code_evaluation = {
                        diff_score: diffPercent,
                        status: diffPercent > diffThreshold ? 'PASS' : 'FAIL',
                    };

                    if (diffPercent <= diffThreshold && step.status === 'PASS') {
                        step.status = 'FAIL';
                        step.message = 'VISUAL_NOT_CHANGED: Preview did not update after action.';
                    }
                }

                // OCR verification for text input steps
                if (step.requires_ocr && step.state_after && step.value_chosen) {
                    const ocrResult = await verifyTextOnPreview(step.state_after, step.value_chosen);
                    step.ocr_evaluation = {
                        found: ocrResult.found,
                        confidence: ocrResult.confidence,
                        extracted_text: ocrResult.extractedText.substring(0, 200),
                        match_detail: ocrResult.matchDetail,
                        status: ocrResult.found ? 'PASS' : 'FAIL',
                    };

                    if (!ocrResult.found) {
                        // OCR is informational only — do not override step status
                        step.message += ` ⚠️ OCR hint: "${step.value_chosen}" not detected on preview (may be stylized text).`;
                    }
                }

                const codeTag = step.code_evaluation?.status || '?';
                const ocrTag = step.ocr_evaluation ? (step.ocr_evaluation.status || '?') : '—';
                console.log(`      Step ${step.step_id}: Code=${codeTag}${step.requires_ocr ? ' | OCR=' + ocrTag : ''}`);
            }

            // Validate preview
            console.log('  [7] Validating preview...');
            const previewResult = await validatePreviewImage(page);

            // AI Final Review
            const testContext = { expected_texts: [] };
            timeline.forEach(step => {
                if (step.requires_ocr && step.value_chosen) {
                    testContext.expected_texts.push(step.value_chosen);
                }
            });

            // Use last step's "after" screenshot for AI final review (avoids preview locator timeout)
            const lastStepWithAfter = [...timeline].reverse().find(s => s.state_after);
            const finalImagePath = lastStepWithAfter ? lastStepWithAfter.state_after : null;

            let aiFinalEval = null;
            if (aiEvaluator.enabled && previewResult.valid && finalImagePath) {
                console.log(`  [AI] Sử dụng ảnh after cuối cùng (Step ${lastStepWithAfter.step_id}) cho AI Review...`);
                try {
                    aiFinalEval = await aiEvaluator.evaluateFinalPreview(finalImagePath, testContext);
                    console.log(`      🤖 AI Verdict: ${aiFinalEval.ai_verdict}`);
                    console.log(`      🤖 AI Reason: ${aiFinalEval.ai_reason}`);
                } catch (e) {
                    console.error('      ⚠️ Failed AI final review:', e.message);
                }
            } else if (aiEvaluator.enabled && !finalImagePath) {
                console.log('  [AI] Không tìm thấy ảnh after nào trong timeline, bỏ qua AI Review.');
            }

            // Add to cart
            console.log('  [8] Add to Cart...');
            const addCartResult = await clickAddToCart(page);

            // Verify cart
            const cartResult = await verifyCart(page);
            console.log(`      ${cartResult.success ? '✅' : '❌'} ${cartResult.message}`);

            // Build case report
            const errorSummary = errorListener.getSummary();
            const apiStatus = errorListener.getFatalApiStatus();

            // Collect fatal reasons (only severe infrastructure failures)
            const fatalReasons = [];
            if (!previewResult.valid) fatalReasons.push(`Preview Crash: ${previewResult.error}`);
            if (apiStatus.isFatal) fatalReasons.push(...apiStatus.reasons);

            // Non-fatal warnings (recorded but don't force score to 0)
            const warnings = [];
            if (!cartResult.success) warnings.push(`Add to Cart: ${cartResult.message}`);
            if (aiFinalEval && (aiFinalEval.ai_verdict === 'FAIL' || aiFinalEval.ai_verdict === 'ERROR')) {
                warnings.push(`AI Review: ${aiFinalEval.ai_reason}`);
            }

            const caseReport = buildCaseReport({
                caseIndex: caseIdx,
                optionLabel,
                timeline,
                errorSummary,
                cartResult,
                previewResult,
                startTime: caseStartTime,
                aiEnabled: aiEvaluator.enabled,
                is_fatal: fatalReasons.length > 0,
                fatal_reasons: fatalReasons,
            });

            if (aiFinalEval) {
                caseReport.final_evaluation.ai_review = {
                    ai_verdict: aiFinalEval.ai_verdict,
                    ai_reason: aiFinalEval.ai_reason,
                    reviewed_image: finalImagePath,
                };
            }

            printCaseSummary(caseReport, caseIdx);
            caseReports.push(caseReport);
            errorListener.reset();
        }

        // Build and save combined report
        const combinedReport = buildCombinedReport({
            productUrl,
            tcCode,
            cases: caseReports,
            startTime: globalStartTime,
            aiEnabled: aiEvaluator.enabled,
        });

        const reportPath = saveCombinedReport(combinedReport, tcDir);
        console.log(`\n📄 Combined Report: ${reportPath}`);
        printCombinedSummary(combinedReport);

    } catch (error) {
        console.error(`\n❌ Fatal error: ${error.message}\n`);
        process.exit(2);
    } finally {
        await terminateOcrWorker();
        await closeBrowser(browser);
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(2);
});
