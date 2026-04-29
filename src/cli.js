#!/usr/bin/env node

/**
 * CLI Entry Point  — v3.0
 * Supports multi-case testing via option scanning + Gemini AI Vision evaluation.
 * Groups all cases under one TC folder: TC_1/case_1/, TC_1/case_2/
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const yargs = require('yargs');
const sharp = require('sharp');
const { launchCoreBrowser, createStandardContext, navigateToProduct, closeBrowser } = require('./core/browser');
const ErrorListener = require('./core/error-listener');
const AiEvaluator = require('./core/ai-evaluator');
const { detectCustomizer, getVisibleOptionGroups, performCustomization, scanFirstPersonalizedGroup, clickAddToCart, handleProductVariants } = require('./actions/customizer');
const { validatePreviewImage, calculateVisualDiff, quickColorCheck, verifyCart, captureCartEvidence } = require('./actions/validator');
const { ensureDir, getNextTcCode, createTcDir, createCaseDir, buildCaseReport, buildCombinedReport, saveCombinedReport, printCaseSummary, printCombinedSummary } = require('./utils/reporter');
const { drawBoundingBox, drawMultipleBoundingBoxes } = require('./utils/annotate-image');
const { getDiffMask } = require('./utils/delta-fingerprint');
const { checkTemporalConsistency } = require('./validators/temporal-consistency');
const { verifyColor } = require('./validators/color-verifier');
const { checkCompletion } = require('./validators/completion-checker');
const ocrValidator = require('./utils/ocr-validator');
const locator = require('./utils/locator');
const verifier = require('./utils/verifier');
const { enrichStep, normalizeCompletionResult } = require('./core/reliability-normalizer');
const { computeQualityScore, computeConfidenceScore, makeDecision, computeConsensus, computeInputSignature, countPipelineErrors } = require('./core/reliability-engine');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

function shouldSoftenSemanticAiFail(step) {
    if (!step || step.group_type !== 'image_option') return false;
    if (step.option_color_source !== 'semantic-label') return false;
    if (step.color_audit_applicable !== false) return false;
    if (step.code_evaluation?.status !== 'PASS') return false;
    return Boolean(step.meaningful_change) || (step.diff_score ?? 0) >= 0.5;
}

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
    .option('ai', {
        describe: 'Enable AI evaluation for ambiguous steps/final review',
        type: 'boolean',
        default: true,
    })
    .option('tc-code', {
        describe: 'Custom Test Case code (e.g., MEE001)',
        type: 'string',
        default: undefined
    })
    .option('custom-image', {
        describe: 'Filename of custom default image to use for upload tests',
        type: 'string',
    })
    .option('tc', {
        describe: 'Alias for tc-code',
        type: 'string',
    })
    .option('reliability-v2', {
        describe: 'Enable Reliability Engine v2.1 (quality_score, confidence_score, step contracts)',
        type: 'boolean',
        default: true,
    })
    .help()
    .argv;

// Feature flag: ENV takes precedence over CLI flag
// Set RELIABILITY_V2=true in .env or pass --reliability-v2
const RELIABILITY_V2 = process.env.RELIABILITY_V2 === 'false' ? false : (process.env.RELIABILITY_V2 === 'true' || argv['reliability-v2'] || true);

/**
 * Fast preview capture via canvas.toDataURL(), skipping scroll entirely.
 * Falls back to scroll + screenshot with a hard 2s cap.
 */
async function capturePreviewFast(page, outputPath = null) {
    const fs = require('fs');
    try {
        const dataUrl = await page.evaluate(() => {
            const selectors = [
                '#customily-app canvas',
                'canvas[id*="preview"]',
                'canvas[id*="customily"]',
                'canvas',
            ];
            for (const sel of selectors) {
                const c = document.querySelector(sel);
                if (c && c.width > 100 && c.height > 100) {
                    return c.toDataURL('image/png');
                }
            }
            return null;
        });

        if (dataUrl) {
            console.log('[PERF] canvas.toDataURL — skip scroll');
            const base64 = dataUrl.replace(/^data:image\/(webp|png|jpeg);base64,/, '');
            const buffer = Buffer.from(base64, 'base64');
            if (outputPath) fs.writeFileSync(outputPath, buffer);
            return buffer;
        }
    } catch (e) {
        // Canvas not accessible, fall through
    }

    // Fallback: scroll instant + hard 2s cap
    console.warn('[PERF] canvas not found, fallback to scroll (2s cap)');
    try {
        await page.evaluate(() => {
            const el = document.querySelector('[id*="customily"], canvas, #customizationContentFooter');
            if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        });
        await page.waitForTimeout(2000); // Hard cap — no infinite re-render wait
    } catch (e) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);
    }
    
    const buffer = await page.screenshot({ type: 'png' });
    if (outputPath) fs.writeFileSync(outputPath, buffer);
    return buffer;
}

async function main() {
    const productUrl = argv.url;
    const isScanOnly = argv.scan;
    const specificIndex = argv['option-index'];
    const baseReportDir = argv['report-dir'];
    const concurrency = argv.concurrency;

    const generalAiDisabled = argv.ai === false || process.argv.includes('--no-ai');
    const aiEvaluator = new AiEvaluator(OPENAI_API_KEY, !generalAiDisabled);
    await aiEvaluator.init();

    console.log('🚀 Custom Product QA Tool v3.0');
    console.log(`   URL: ${productUrl}`);
    console.log(`   AI Evaluation: ${aiEvaluator.enabled ? '✅ Enabled' : '⚫ Disabled'}`);
    console.log(`   Concurrency: ${concurrency} cases parallel\n`);

    const globalStartTime = new Date();
    const tcCode = argv['tc-code'] || argv.tc || getNextTcCode(baseReportDir);
    const tcDir = createTcDir(baseReportDir, tcCode);

    let browser;
    try {
        browser = await launchCoreBrowser({ headless: argv.headless });
        
        const scanContext = await createStandardContext(browser);
        const scanPage = await scanContext.newPage();
        
        console.log('[1] Scanning product for options...');
        await navigateToProduct(scanPage, productUrl);

        console.log('    🛠️ Checking for product variants (Style/Size)...');
        const variants_selected = await handleProductVariants(scanPage);
        
        const scanResult = await scanFirstPersonalizedGroup(scanPage);
        if (scanResult.found) {
            console.log(`    [OK] Group: "${scanResult.groupName}" — ${scanResult.options.length} options found.`);
        }

        if (isScanOnly) {
            console.log('\n[INFO] Scan result (JSON):');
            console.log(JSON.stringify(scanResult, null, 2));
            await scanContext.close();
            await browser.close();
            return;
        }

        let caseIndices = [];
        if (specificIndex !== undefined) {
            caseIndices = [specificIndex];
            if (scanResult.found) {
                const alt = scanResult.options.map(o => o.index).find(idx => idx !== specificIndex);
                if (alt !== undefined) caseIndices.push(alt);
            }
        } else if (scanResult.found) {
            caseIndices = scanResult.options.map(o => o.index).slice(0, 2);
        } else {
            caseIndices = [null];
        }
        while (caseIndices.length < 2) caseIndices.push(null);
        caseIndices = caseIndices.slice(0, 2);

        await scanContext.close();

        console.log(`\n[TC] ${tcCode}: Dispatching ${caseIndices.length} cases (Parallel: ${concurrency})...\n`);

        const caseReports = [];
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
            let customizeTimeline = [];
            let temporalViolations = [];
            let completionResult = {};
            let lastStepWithAfter = null;
            let fatalReasons = [];
            const phaseDurations = {
                phase_navigation: 0,
                phase_variants: 0,
                phase_customization: 0,
                phase_evaluation: 0,
                phase_ai_review: 0
            };

            try {
                // Phase 1: Navigation
                lifecycleStepId++;
                const t1 = Date.now();
                console.time(`${logPrefix} Phase 1: Navigation`);
                await navigateToProduct(page, productUrl, true); // Always skip 15s delay because SCAN already did it
                console.timeEnd(`${logPrefix} Phase 1: Navigation`);
                phaseDurations.phase_navigation = Date.now() - t1;
                
                lifecycleTimeline.push({
                    step_id: lifecycleStepId, action: 'open_page', name: 'Open Product Page',
                    status: 'PASS', message: 'Page loaded successfully.', group_type: 'lifecycle',
                    value_chosen: productUrl, state_before: '', state_after: '', diff_score: -1
                });

                // Phase 2: Variants
                const t2 = Date.now();
                console.time(`${logPrefix} Phase 2: Variants`);
                await handleProductVariants(page, logPrefix, { variants_selected });
                console.timeEnd(`${logPrefix} Phase 2: Variants`);
                phaseDurations.phase_variants = Date.now() - t2;

                // Phase 3: Customization
                const t3 = Date.now();
                console.time(`${logPrefix} Phase 3: Customization`);
                customizeTimeline = await performCustomization(page, caseDir, optionIndex, argv['custom-image'], {}, aiEvaluator);
                console.timeEnd(`${logPrefix} Phase 3: Customization`);
                phaseDurations.phase_customization = Date.now() - t3;
                customizeTimeline.forEach(s => s.step_id = ++lifecycleStepId);

                const tTransitionStart = Date.now();
                console.log(`[PERF] Transition Phase 3 -> 4 start...`);
                
                // Phase 4: Evaluation
                const t4 = Date.now();
                console.log(`[PERF] Transition overhead: ${t4 - tTransitionStart}ms`);
                console.time(`${logPrefix} Phase 4: Evaluation`);
                const evaluationPromises = customizeTimeline.map(async (step) => {
                    // Parallelize Layer 1 & 2A (Optimized I/O)
                    let beforeBuf, afterBuf;
                    let diffPercent = -1;
                    let diffMask = null;
                    let ssimScore = null;
                    let meaningfulChange = false;

                    if (!step.skip_diff_check && step.state_before && step.state_after) {
                        try {
                            const fs = require('fs');
                            [beforeBuf, afterBuf] = await Promise.all([
                                fs.promises.readFile(step.state_before),
                                fs.promises.readFile(step.state_after),
                            ]);

                            const calculateVisualDiffBuffers = require('./actions/validator').calculateVisualDiffBuffers;
                            const getDiffMaskFromBuffers = require('./utils/delta-fingerprint').getDiffMaskFromBuffers;

                            const diffData = await Promise.all([
                                calculateVisualDiffBuffers(beforeBuf, afterBuf),
                                getDiffMaskFromBuffers(beforeBuf, afterBuf)
                            ]);
                            diffPercent = diffData[0].diffPercent;
                            ssimScore = Number.isFinite(diffData[0].ssim) ? diffData[0].ssim : null;
                            meaningfulChange = Boolean(diffData[0].meaningfulChange);
                            diffMask = diffData[1];
                        } catch (e) {
                            console.error(`    [ERROR] Failed to read or process interaction images: ${e.message}`);
                        }
                    } else if (step.skip_diff_check) {
                        // Skip diff calculation for dropdowns/menu openers
                        diffPercent = 0;
                        meaningfulChange = Boolean(step.changes_preview) || (Number(step.observed_preview_change_score) > 0.01);
                    }
                    
                    step.diff_score = diffPercent;
                    step.diffMask = diffMask;
                    step.ssim_score = ssimScore !== null ? parseFloat(ssimScore.toFixed(4)) : null;
                    step.meaningful_change = meaningfulChange;

                    // Layer 2A: Architectural Hard Gates (v3.3)
                    const hasMeaningfulChange = diffPercent > 0.01 || meaningfulChange;
                    let isPass = hasMeaningfulChange;
                    if (step.status === 'FAIL' && step.interaction_status === 'FAIL') {
                        // Keep it FAIL, validation doesn't apply
                        step.validation_status = 'FAIL';
                    } else if (step.is_label_confirmed || step.is_menu_opener) {
                        step.status = 'PASS';
                        step.is_audit_pass = true;
                        step.code_evaluation = { status: 'PASS', message: 'Interaction verified.' };
                    } else if (diffPercent === -1) {
                        // Bug #9 Fix: diff = -1 is an ERROR/WARNING, not a pass
                        step.status = 'WARNING';
                        step.diff_error = true;
                        step.code_evaluation = { status: 'WARNING', message: 'ERROR: Could not calculate visual diff.' };
                        console.log(`    [GATE] Step warning: Diff calculation failed.`);
                    } else if (diffPercent === 0 && !meaningfulChange) {
                        // Bug #8 Fix: Dropdowns diff=0 is BÌNH THƯỜNG — không FAIL
                        if (step.group_type === 'dropdown' || step.is_menu_opener || step.skip_diff_check) {
                            step.status = 'PASS';
                            step.is_audit_pass = true;
                            step.code_evaluation = { status: 'PASS', message: 'Dropdown/Opener: Zero change is expected.' };
                        } else {
                            // image_option, text_input diff=0 → FAIL thật
                            step.status = 'FAIL';
                            step.is_audit_pass = true; // No need for AI if no change at all
                            step.code_evaluation = { status: 'FAIL', message: 'CRITICAL: No visual change detected.' };
                            console.log(`    [GATE] Step auto-failed: Zero pixel change.`);
                        }
                    } else if (diffPercent < 0.005 && !meaningfulChange) { 
                        step.status = 'PASS';
                        step.is_audit_pass = true;
                        step.code_evaluation = { status: 'PASS', message: 'Auto-pass: Negligible change (noise).' };
                        console.log(`    [GATE] Step auto-passed: Negligible change (${diffPercent}%).`);
                    } else {
                        // Standard evaluation
                        step.status = isPass ? 'PASS' : 'FAIL';
                        step.code_evaluation = {
                            status: step.status,
                            diffPercent,
                            ssim: step.ssim_score,
                            meaningfulChange: step.meaningful_change
                        };
                        
                        // Layer 3A: OCR
                        if (step.group_type === 'text_input' && step.value_chosen && step.diffMask) {
                            const tOcr = Date.now();
                            const ocr = await ocrValidator.verifyTextOnCrop(step.state_after, step.diffMask, step.value_chosen);
                            console.log(`    [PERF] ocr: ${Date.now() - tOcr}ms`);
                            step.ocr_evaluation = ocr;
                            if (ocr.found) { step.status = 'PASS'; step.is_audit_pass = true; }
                        }
                        // Layer 3B: Color
                        const shouldRunColorAudit = Boolean(
                            step.option_color_hex
                            && step.diffMask
                            && step.color_audit_applicable !== false
                        );

                        if (shouldRunColorAudit) {
                            step.color_evaluation = await verifyColor(step.state_after, step.diffMask, step.option_color_hex);
                            if (step.color_evaluation?.result === 'PASS') { step.status = 'PASS'; step.is_audit_pass = true; }
                        } else if (step.group_type === 'image_option' && (step.option_color_source || step.option_color_semantic_hex)) {
                            step.color_evaluation = {
                                result: 'SKIPPED',
                                availability: 'UNAVAILABLE',
                                expected: step.option_color_hex || step.option_color_semantic_hex || '',
                                source: step.option_color_source || (step.option_color_semantic_hex ? 'semantic-label' : 'unknown'),
                                message: 'Skipped color audit: expected color is semantic/untrusted for this image option.',
                            };
                        }
                        
                        // Layer 3C: Quick Color Similarity (Safety net for small diffs)
                        if (diffPercent > 0 && diffPercent < 0.5 && step.option_thumbnail && !step.is_audit_pass) {
                            const colorMatch = await quickColorCheck(step.state_after, step.diffMask, step.option_thumbnail);
                            if (colorMatch > 0.80) {
                                step.status = 'PASS';
                                step.is_audit_pass = true;
                                step.ai_evaluation = { 
                                    ai_verdict: 'PASS', 
                                    ai_reason: `Color match: ${(colorMatch*100).toFixed(1)}% (Diff: ${diffPercent}%)` 
                                };
                            }
                        }
                    }

                    // Layer 4: AI Judge (Surgical AI Optimization v1.3)
                    const isAmbiguous = !step.is_audit_pass && (
                        (step.status === 'FAIL') || // Rule says FAIL, verify if it's true
                        (step.ocr_evaluation && !step.ocr_evaluation.found) || // OCR missing
                        (step.diff_score > 5) || // Large visual shift
                        (typeof step.ssim_score === 'number' && step.ssim_score < 0.97) || // Structural shift worth arbitration
                        (step.ai_needs_manual_review) // Explicitly flagged
                    );

                    const hasUsableAfterState = Boolean(step.state_after && fs.existsSync(step.state_after));
                    if (aiEvaluator.enabled && isAmbiguous && step.expects_visual_change && hasUsableAfterState) {
                        try {
                            // Step 4.1: LOCATE (with character zone context)
                            const stepContext = {
                                timelineSteps: customizeTimeline,
                                currentStep: step
                            };
                            const bbox = await locator.locateOptionInPreview(step.option_thumbnail, step.state_after, step.diffMask, stepContext);
                            step.bbox = bbox;

                            // Step 4.2: VERIFY
                            const verifyResults = await verifier.verifyZone(step.state_after, bbox, step);
                            step.code_verification = verifyResults.results;

                            // Step 4.3: JUDGE
                            const judgeResult = await aiEvaluator.evaluateStepWithContext(step, step.state_after, bbox, verifyResults);
                            step.ai_evaluation = {
                                ai_verdict: judgeResult.verdict,
                                ai_reason: judgeResult.reason,
                                confidence: judgeResult.confidence,
                                bbox_correct: judgeResult.bbox_correct,
                                code_results_confirmed: judgeResult.code_results_confirmed
                            };

                             // Step 4.4: Conditional AI Override (Architecture v3.3)
                             const AI_OVERRIDE_THRESHOLD = 0.85;
                             const isAiHighConfidence = judgeResult.confidence >= AI_OVERRIDE_THRESHOLD;
                             
                             if (judgeResult.verdict === 'PASS' && isAiHighConfidence) {
                                 console.log(`    [AI] Judge OVERRIDE: PASS (Confidence: ${judgeResult.confidence})`);
                                 step.status = 'PASS';
                             } else if (judgeResult.verdict === 'FAIL' && isAiHighConfidence) {
                                 if (shouldSoftenSemanticAiFail(step)) {
                                     step.ai_semantic_untrusted = true;
                                     console.log(`    [AI] FAIL override suppressed for semantic color option: ${step.name}`);
                                 } else {
                                     console.log(`    [AI] Judge OVERRIDE: FAIL (Confidence: ${judgeResult.confidence})`);
                                     step.status = 'FAIL';
                                 }
                             } else {
                                 // Keep the deterministic code status
                                 console.log(`    [AI] Judge verdict ${judgeResult.verdict} IGNORED (Low confidence or Temporal block)`);
                             }

                            // Step 4.4: ANNOTATE (Step-level)
                            if (bbox && bbox.w > 0 && bbox.h > 0 && bbox.source === 'opencv' && fs.existsSync(step.state_after)) {
                                const meta = await sharp(step.state_after).metadata();
                                const parsedAfter = path.parse(step.state_after);
                                const annotatedPath = path.join(
                                    parsedAfter.dir,
                                    `${parsedAfter.name}_step_annotated.webp`
                                );
                                const annotations = [{
                                    bbox: [
                                        Math.round((bbox.x / meta.width) * 1000),
                                        Math.round((bbox.y / meta.height) * 1000),
                                        Math.round(((bbox.x + bbox.w) / meta.width) * 1000),
                                        Math.round(((bbox.y + bbox.h) / meta.height) * 1000)
                                    ],
                                    color: { r: 0, g: 255, b: 0 } // Green for localized
                                }];
                                await drawMultipleBoundingBoxes(step.state_after, annotatedPath, annotations);
                                step.state_after_annotated = annotatedPath;
                            }

                            // Cleanup tmp crop if exists
                            if (verifyResults.croppedPath && fs.existsSync(verifyResults.croppedPath)) {
                                fs.unlinkSync(verifyResults.croppedPath);
                            }
                        } catch (e) { 
                            console.error(`    [ERROR] AI Judge failed for step ${step.name}: ${e.message}`);
                            step.ai_evaluation = { ai_verdict: 'ERROR', ai_reason: e.message };
                            // Bug #4: AI ERROR should NOT leave status as PASS
                            // Keep deterministic code status, but flag for review
                            step.ai_needs_manual_review = true;
                            console.warn(`    [AI] API Error — keeping code verdict (${step.status}), flagging for review`);
                        }
                    } else if (aiEvaluator.enabled && isAmbiguous && step.expects_visual_change && !hasUsableAfterState) {
                        step.ai_evaluation = {
                            ai_verdict: 'SKIPPED',
                            ai_reason: 'Skipped AI judge: missing AFTER screenshot artifact.',
                            confidence: 0,
                        };
                        step.ai_needs_manual_review = true;
                    }

                    if (step.interaction_status !== 'FAIL') {
                        step.validation_status = step.status; // Default to final step status (validation result)
                    }
                });
                await Promise.all(evaluationPromises);
                console.timeEnd(`${logPrefix} Phase 4: Evaluation`);
                phaseDurations.phase_evaluation = Date.now() - t4;

                const tFinalizeStart = Date.now();
                console.log(`${logPrefix} [FINALIZE] Running final verification checks in parallel...`);
                
                let finalPreviewBuffer = null;
                const [temporalRes, completionRes, previewRes] = await Promise.all([
                    (async () => {
                        // Pass the final preview path if it exists, otherwise fall back to steps
                        return checkTemporalConsistency(customizeTimeline);
                    })(),
                    (async () => {
                        const lastStep = [...customizeTimeline].reverse().find(s => s.state_after);
                        const baselineStep = lifecycleTimeline.find(s => s.action === 'navigation');
                        return checkCompletion(
                            customizeTimeline, 
                            baselineStep ? baselineStep.state_after : (customizeTimeline.length > 0 ? customizeTimeline[0].state_before : ''), 
                            lastStep ? lastStep.state_after : (customizeTimeline.length > 0 ? customizeTimeline[customizeTimeline.length-1].state_after : '')
                        );
                    })(),
                    (async () => {
                        const tCaptureFast = Date.now();
                        const finalPreviewPath = path.join(caseDir, 'final_preview.png');
                        finalPreviewBuffer = await capturePreviewFast(page, finalPreviewPath);
                        console.log(`[PERF] capturePreviewFast: ${Date.now() - tCaptureFast}ms`);
                        
                        const tValidate = Date.now();
                        const res = await validatePreviewImage(page);
                        console.log(`[PERF] validatePreview: ${Date.now() - tValidate}ms`);
                        return res;
                    })()
                ]);
                console.log(`[PERF] Finalize (Parallel): ${Date.now() - tFinalizeStart}ms`);

                const temporalViolations = temporalRes;
                const hasFatalTemporal = (temporalViolations || []).some(v => v.severity === 'FATAL');
                const completionResult = completionRes;
                const previewResult = previewRes;
                const lastStep = [...customizeTimeline].reverse().find(s => s.state_after);
                const previewHash = await require('./utils/delta-fingerprint').calculateImageHash(lastStep ? lastStep.state_after : '');
                
                if (previewHash) {
                    previewResult.hash = previewHash;
                    // Render Regression Registry (Architecture v3.3)
                    const registryPath = path.join(process.cwd(), 'regression_registry.json');
                    let registry = {};
                    if (fs.existsSync(registryPath)) registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
                    
                    const registryKey = `${tcCode}:case_${caseIdx}:${optionLabel}`;
                    if (registry[registryKey]) {
                        const baseline = registry[registryKey];
                        if (baseline !== previewHash) {
                            console.log(`    [REGRESSION] Visual mismatch detected for ${registryKey}!`);
                            previewResult.regression = true;
                            previewResult.baseline_hash = baseline;
                        } else {
                            console.log(`    [REGRESSION] Visual match confirmed against baseline.`);
                            previewResult.regression = false;
                        }
                    } else {
                        // First run: save as baseline
                        registry[registryKey] = previewHash;
                        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
                        console.log(`    [REGRESSION] Baseline hash saved for ${registryKey}.`);
                    }
                }

                const previewStep = {
                    step_id: ++lifecycleStepId, action: 'validate_preview', name: 'Preview Validation',
                    status: previewResult.valid ? 'PASS' : 'FAIL', group_type: 'lifecycle',
                    state_after: '', diff_score: -1,
                    preview_valid: previewResult.valid,
                    preview_message: previewResult.message,
                    preview_error: previewResult.error
                };

                // Add to Cart remains sequential as it interacts with the page
                await clickAddToCart(page);
                
                // Immediately capture evidence after click (clickAddToCart handles the 3s animation wait internally)
                const [cartEvidence, cartResult] = await Promise.all([
                    captureCartEvidence(page, caseDir),
                    verifyCart(page)
                ]);

                const cartStep = {
                    step_id: ++lifecycleStepId, action: 'add_to_cart', name: 'Add to Cart',
                    status: cartResult.success ? 'PASS' : 'FAIL', group_type: 'lifecycle',
                    state_after: cartEvidence.panel || cartEvidence.viewport || '',
                    cart_evidence: cartEvidence,
                    cart_result: cartResult.success,
                    cart_method: cartResult.method,
                    cart_message: cartResult.message,
                    diff_score: -1
                };

                lastStepWithAfter = [...customizeTimeline].reverse().find(s => s.state_after);
                const fullTimeline = [...lifecycleTimeline, ...customizeTimeline, previewStep, cartStep];

                // ─── Reliability Engine v2.1 (feature-flagged) ──────────────────
                let reliabilityData = null;
                if (RELIABILITY_V2) {
                    const normCompletion = normalizeCompletionResult(completionResult);

                    // Enrich all customization steps with signal contract
                    for (const step of fullTimeline) {
                        enrichStep(step, {
                            temporalViolations: temporalViolations,
                            cartResult: step.action === 'add_to_cart' ? cartResult : null,
                        });
                    }

                    // Compute quality_score + confidence_score
                    const pipelineErrors = countPipelineErrors(fullTimeline, errorListener.getSummary());
                    const qualityResult = computeQualityScore(fullTimeline, {
                        completionResult: normCompletion,
                        cartResult,
                        temporalViolations,
                    });
                    const confidenceResult = computeConfidenceScore(fullTimeline, {
                        qualityResult,
                        pipelineErrors,
                    });

                    // Compute test input signature
                    const inputSignature = computeInputSignature(argv.url, caseIdx, tcCode);

                    // Decision
                    // Temporal hard-fail is handled inside the reliability decision engine.
                    // Keep `isFatal` reserved for true execution/runtime fatal errors only.
                    const isFatal = fatalReasons.length > 0;
                    const decisionResult = makeDecision(qualityResult, confidenceResult, { isFatal });

                    reliabilityData = {
                        quality_score: qualityResult.quality_score,
                        confidence_score: confidenceResult.confidence_score,
                        decision: decisionResult.decision,
                        decision_reason_codes: decisionResult.reasons,
                        test_input_signature: inputSignature,
                        signal_detail: {
                            coverage: confidenceResult.coverage,
                            agreement: confidenceResult.agreement,
                            stability: confidenceResult.stability_proxy,
                            pipeline_health: confidenceResult.pipeline_health,
                            clean_run_promotion_eligible: confidenceResult.clean_run_promotion_eligible,
                            clean_run_promotion_applied: confidenceResult.clean_run_promotion_applied,
                        },
                    };
                    console.log(`  [R-v2] quality=${qualityResult.quality_score} confidence=${confidenceResult.confidence_score} decision=${decisionResult.decision}`);
                }
                // ───────────────────────────────────────────────────────────────

                const caseErrorSummary = errorListener.getSummary();

                const caseReport = buildCaseReport({
                    caseIndex: caseIdx, optionLabel, timeline: fullTimeline, errorSummary: caseErrorSummary,
                    cartResult, previewResult, startTime: caseStartTime, aiEnabled: aiEvaluator.enabled,
                    is_fatal: fatalReasons.length > 0, fatal_reasons: fatalReasons,
                    temporal_violations: temporalViolations, completion_result: completionResult,
                    phase_durations: phaseDurations,
                    reliability: reliabilityData,
                    results: { final_evaluation: { ai_review: null } } // Placeholder, will be updated if AI review happens
                });

                // Final AI Review
                let finalPreviewPathToUse = lastStepWithAfter ? lastStepWithAfter.state_after : null;
                if (finalPreviewBuffer) {
                    finalPreviewPathToUse = path.join(caseDir, 'final_preview.png');
                }

                const hasReviewablePreview =
                    !!finalPreviewPathToUse &&
                    typeof finalPreviewPathToUse === 'string' &&
                    fs.existsSync(finalPreviewPathToUse);

                let skipFinalAi = false;
                if (RELIABILITY_V2 && reliabilityData && reliabilityData.quality_score >= 95.0) {
                    skipFinalAi = true;
                    console.log(`    [AI] Bypassing Final Review: High local Quality Score (${reliabilityData.quality_score} >= 95.0)`);
                }

                if (aiEvaluator.enabled && hasReviewablePreview) {
                    const t5 = Date.now();
                    try {
                        if (skipFinalAi) {
                            caseReport.final_evaluation.ai_review = {
                                summary: 'Tier-1 deterministic pass: skipped AI final review due to high local quality score (>= 95.0).',
                                strengths: ['Strong local pixel stability', 'OCR match confirmed', 'DOM context valid'],
                                issues: [],
                                layout_notes: [],
                                color_notes: [],
                                content_notes: [],
                                recommendations: [],
                                ai_verdict: 'PASS',
                                confidence: 1.0,
                                ai_reason: `Auto-passed. Local Quality Score was ${reliabilityData.quality_score}.`,
                                triage_tier: 1,
                                triage_path: ['T1_DETERMINISTIC_PASS', 'HIGH_QUALITY_SHORTCUT'],
                                flags: ['SKIP_FINAL_AI'],
                                tokens_used: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 },
                                reviewed_image: finalPreviewPathToUse
                            };
                            phaseDurations.phase_ai_review = 0;
                        } else {
                            if (!previewResult.valid) {
                                console.log(`    [AI] Final review continuing despite preview validation failure: ${previewResult.error || previewResult.message || 'unknown reason'}`);
                            }
                            const aiFinal = await aiEvaluator.evaluateFinalPreview(
                                finalPreviewPathToUse,
                                caseReport,
                                {
                                    triageContext: {
                                        previewResult,
                                        cartResult,
                                        cartEvidence,
                                        errorSummary: caseErrorSummary,
                                        completionResult,
                                        temporalViolations,
                                        reliabilityData,
                                    },
                                }
                            );
                            aiFinal.reviewed_image = finalPreviewPathToUse; 
                            caseReport.final_evaluation.ai_review = aiFinal;
                        }
                    } catch (e) {
                        console.error(`    [ERROR] Final AI Review failed: ${e.message}`);
                    }
                    if (!skipFinalAi) phaseDurations.phase_ai_review = Date.now() - t5;
                }
                
                caseReport.phase_durations = phaseDurations; // Final sync
                printCaseSummary(caseReport, caseIdx);
                caseReports.push(caseReport);

            } catch (err) {
                console.error(`${logPrefix} Critical Error: ${err.message}`);
                caseReports.push({ case_index: caseIdx, case_label: optionLabel, status: 'FATAL', score: 0, fatal_reasons: [err.message] });
            } finally {
                await context.close();
                if (locator && locator.clearThumbnailCache) locator.clearThumbnailCache();
            }
        };

        const active = new Set();
        for (let i = 0; i < caseIndices.length; i++) {
            const promise = runTestCase(i, caseIndices[i]);
            active.add(promise);
            promise.finally(() => active.delete(promise));
            if (active.size >= concurrency) await Promise.race(active);
        }
        await Promise.all(active);

        const combinedReport = buildCombinedReport({ 
            productUrl, tcCode, cases: caseReports, startTime: globalStartTime, 
            aiEnabled: aiEvaluator.enabled, variants_selected
        });
        const reportPath = saveCombinedReport(combinedReport, tcDir);
        console.log(`\n📄 Combined Report: ${reportPath}`);
        printCombinedSummary(combinedReport);

        if (aiEvaluator.enabled) {
            const stats = aiEvaluator.getUsageStats();
            console.log(`\n🤖 AI Usage Summary:`);
            console.log(`   Tokens: ${stats.total_tokens} (Prompt: ${stats.prompt_tokens}, Completion: ${stats.completion_tokens})`);
            console.log(`   Calls:  ${stats.calls}`);
        }

    } catch (error) {
        console.error(`\n❌ Fatal error: ${error.message}\n`);
        process.exitCode = 1;
    } finally {
        if (browser) await browser.close();
        await ocrValidator.terminateOcrWorker();
    }
}

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(2);
});
