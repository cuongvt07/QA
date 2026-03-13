#!/usr/bin/env node

/**
 * CLI Entry Point  — v2.0
 * Supports multi-testcase via option scanning + Gemini AI Vision evaluation.
 *
 * Usage:
 *   node src/cli.js --url="https://..."                      # Run ALL option test cases
 *   node src/cli.js --url="https://..." --option-index=0     # Run specific option
 *   node src/cli.js --url="https://..." --scan               # Scan options only (no test)
 */

const path = require('path');
const yargs = require('yargs');
const { launchBrowser, navigateToProduct, closeBrowser } = require('./core/browser');
const ErrorListener = require('./core/error-listener');
const AiEvaluator = require('./core/ai-evaluator');
const { detectCustomizer, performCustomization, scanFirstPersonalizedGroup, clickAddToCart } = require('./actions/customizer');
const { validatePreviewImage, calculateVisualDiff, verifyCart } = require('./actions/validator');
const { ensureDir, getNextQaCode, createTestCaseDir, buildReport, saveReport, printSummary } = require('./utils/reporter');

const GEMINI_API_KEY = 'AIzaSyBRWJCyC9KMk4VK-bZlpiVEZOww87WB4nM';

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

    console.log('🚀 Custom Product QA Tool v2.1');
    console.log(`   URL: ${productUrl}`);
    console.log(`   AI Evaluation: ${aiEvaluator.enabled ? '✅ Enabled' : '⚫ Disabled'}\n`);

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

        // Determine which test cases to run
        let testCaseIndices = [];
        if (specificIndex !== undefined) {
            testCaseIndices = [specificIndex];
        } else if (scanResult.found) {
            testCaseIndices = scanResult.options.map((o) => o.index);
        } else {
            testCaseIndices = [null]; // Single random test case
        }

        console.log(`\n🧪 Running ${testCaseIndices.length} test case(s)...\n`);

        const allReports = [];

        // Run each test case
        for (let tcIdx = 0; tcIdx < testCaseIndices.length; tcIdx++) {
            const optionIndex = testCaseIndices[tcIdx];
            const optionLabel = optionIndex !== null && scanResult.found
                ? scanResult.options[optionIndex]?.title || `Option ${optionIndex}`
                : 'Random';

            // Generate QA code for this testcase
            const qaCode = getNextQaCode(baseReportDir);

            console.log(`${'═'.repeat(50)}`);
            console.log(`  ${qaCode} — TEST CASE ${tcIdx + 1}/${testCaseIndices.length}: ${optionLabel}`);
            console.log(`${'═'.repeat(50)}`);

            const startTime = new Date();
            const errorListener = new ErrorListener();
            errorListener.attachToPage(page);

            // Create QA directory: web/reports/QA1/
            const tcDir = createTestCaseDir(baseReportDir, qaCode);

            // Reload page for each test case to reset state
            if (tcIdx > 0) {
                console.log('  [↻] Reloading page...');
                await navigateToProduct(page, productUrl);
                await page.waitForTimeout(2000);
            }

            // Perform customization with fixed option
            // Screenshots saved directly into QA folder: QA1/step_1_before.png
            console.log('  [5] Performing customization...');
            const timeline = await performCustomization(page, tcDir, optionIndex);
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
                    step.code_evaluation = {
                        diff_score: diffPercent,
                        status: diffPercent > 0 ? 'PASS' : 'FAIL',
                    };

                    if (diffPercent === 0 && step.status === 'PASS') {
                        step.status = 'FAIL';
                        step.message = 'VISUAL_NOT_CHANGED: Preview did not update after action.';
                    }
                }

                // AI-based evaluation (Gemini Vision)
                if (step.state_before && step.state_after && aiEvaluator.enabled) {
                    const aiResult = await aiEvaluator.evaluateStep(
                        step.state_before,
                        step.state_after,
                        step.name,
                        step.value_chosen
                    );
                    step.ai_evaluation = aiResult;

                    // If AI says FAIL but code says PASS, flag it
                    if (aiResult.ai_verdict === 'FAIL' && step.status === 'PASS') {
                        step.message += ' [AI WARNING: ' + aiResult.ai_reason + ']';
                    }
                }

                const codeTag = step.code_evaluation?.status || '?';
                const aiTag = step.ai_evaluation?.ai_verdict || '?';
                console.log(`      Step ${step.step_id}: Code=${codeTag} | AI=${aiTag}`);
            }

            // Validate preview
            console.log('  [7] Validating preview...');
            const previewResult = await validatePreviewImage(page);

            // Add to cart
            console.log('  [8] Add to Cart...');
            const addCartResult = await clickAddToCart(page);

            // Verify cart
            const cartResult = await verifyCart(page);
            console.log(`      ${cartResult.success ? '✅' : '❌'} ${cartResult.message}`);

            // Build report
            const errorSummary = errorListener.getSummary();
            const report = buildReport({
                productUrl,
                qaCode,
                testCaseLabel: optionLabel,
                timeline,
                errorSummary,
                cartResult,
                previewResult,
                startTime,
                aiEnabled: aiEvaluator.enabled,
            });

            const reportPath = saveReport(report, tcDir);
            console.log(`  📄 Report: ${reportPath}`);
            printSummary(report);

            allReports.push(report);
            errorListener.reset();
        }

        // Print final summary
        console.log(`\n📁 Reports saved in: ${baseReportDir}`);
        allReports.forEach((r) => {
            console.log(`   ${r.qa_code} │ ${r.status} │ ${r.score}/100`);
        });
        console.log('');

    } catch (error) {
        console.error(`\n❌ Fatal error: ${error.message}\n`);
        process.exit(2);
    } finally {
        await closeBrowser(browser);
    }
}

main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(2);
});
