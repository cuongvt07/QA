const fs = require('fs');
const path = require('path');
const RULES = require('./rules');

/**
 * Utility for reporting and artifact management
 */

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getNextTcCode(baseDir) {
    if (!fs.existsSync(baseDir)) return 'TC_1';
    const dirs = fs.readdirSync(baseDir).filter((d) => d.startsWith('TC_'));
    const nextNum = dirs.length + 1;
    return `TC_${nextNum}`;
}

function createTcDir(baseDir, tcCode) {
    const tcDir = path.join(baseDir, tcCode);
    ensureDir(tcDir);
    return tcDir;
}

function createCaseDir(tcDir, caseIndex) {
    const caseDir = path.join(tcDir, `case_${caseIndex + 1}`);
    ensureDir(caseDir);
    return caseDir;
}

function getExpectedTextTokenLength(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .length;
}

function hasStrongAiTextRescue(step) {
    if (!step || step.group_type !== 'text_input') return false;
    const aiRes = step.ai_evaluation;
    if (!aiRes || aiRes.ai_verdict !== 'PASS') return false;
    if ((aiRes.confidence ?? 0) < 0.9) return false;
    if (aiRes.bbox_correct === false) return false;
    return Boolean(step.meaningful_change) || (step.diff_score ?? 0) > 0.01;
}

function shouldIgnoreSemanticAiFail(step) {
    if (!step || step.group_type !== 'image_option') return false;
    if (step.ai_semantic_untrusted) return true;
    if (step.option_color_source !== 'semantic-label') return false;
    if (step.color_audit_applicable !== false) return false;
    if (step.code_evaluation?.status !== 'PASS') return false;
    return Boolean(step.meaningful_change) || (step.diff_score ?? 0) >= 0.5;
}

function getOcrCredit(ocrRes, expectedText, step) {
    if (!ocrRes?.found) {
        return hasStrongAiTextRescue(step) ? 0.88 : 0;
    }

    const confP = Math.max(0, Math.min(100, ocrRes.confidence || 0)) / 100;
    let credit = 0.5 + (0.5 * confP);
    const detail = String(ocrRes.matchDetail || '');
    const tokenLength = getExpectedTextTokenLength(expectedText);

    if (/exact match found/i.test(detail)) {
        credit = Math.max(credit, 0.9);
    } else if (/fuzzy match found/i.test(detail) && tokenLength > 0 && tokenLength <= 8) {
        credit = Math.max(credit, 0.8);
    }

    return Math.min(1, credit);
}

/**
 * Build report JSON for a single case within a test
 */
function buildCaseReport({ 
    caseIndex, 
    optionLabel, 
    timeline, 
    errorSummary, 
    cartResult, 
    previewResult, 
    startTime, 
    aiEnabled, 
    is_fatal, 
    fatal_reasons,
    temporal_violations = [],
    completion_result = {},
    phase_durations = {},
    reliability = null,   // Optional: Reliability Engine v2.1 data
    results = null,
}) {
    const endTime = new Date();
    const totalSteps = timeline.length;
    const passedSteps = timeline.filter((s) => s.status === 'PASS').length;
    
    const score_deduction_reasons = [];
    let status_reason = null;
    
    // Layer 5: Weighted Scoring System (as per optimize.md)
    // Goal: More deterministic than pure AI, more robust than pure Pixel.
    
    let pixelWeight = 15;
    let colorWeight = 15;
    let ocrWeight = 20;
    let aiWeight = 25; // Reduced from 35 to make room for cart
    let completionWeight = 15;
    let cartWeight = 10; // New dimension

    const validCustomizationTypes = ['image_option', 'text_input', 'file_upload', 'dropdown'];

    // 1. Pixel Check (Layer 2A/1)
    const visualFailedSteps = timeline.filter(s => validCustomizationTypes.includes(s.group_type) && s.status === 'FAIL' && s.expects_visual_change);
    const visualFailedCount = visualFailedSteps.length;
    let pixelScore = Math.max(0, pixelWeight - visualFailedCount * 5);
    if (visualFailedCount > 0) {
        score_deduction_reasons.push({
            dimension: 'Pixel',
            deducted_points: Math.min(pixelWeight, visualFailedCount * 5),
            reason: `${visualFailedCount} steps failed visual check`,
            evidence: visualFailedSteps.map(s => s.name).join(', ')
        });
    }

    // 2. Color Check (Layer 3B)
    const colorSteps = timeline.filter(s => s.color_evaluation);
    let colorCounted = 0;
    let colorPassed = 0;
    colorSteps.forEach(s => {
        const res = s.color_evaluation.result;
        // Spec: Treat ERROR/UNAVAILABLE differently. Do not force quality down to 0.
        if (res !== 'ERROR' && res !== 'UNAVAILABLE' && res !== 'SKIPPED') {
            colorCounted++;
            if (res === 'PASS' || s.is_audit_pass) {
                colorPassed++;
            }
        }
    });
    let colorScore = colorCounted > 0 ? (colorPassed / colorCounted) * colorWeight : colorWeight;
    if (colorPassed < colorCounted) {
        const deducted = colorWeight - colorScore;
        score_deduction_reasons.push({
            dimension: 'Color',
            deducted_points: Math.round(deducted),
            reason: `${colorCounted - colorPassed} steps failed color harmony audit`,
            evidence: colorSteps.filter(s => s.color_evaluation?.result === 'FAIL').map(s => s.name).join(', ')
        });
    }

    // 3. OCR (Layer 3A)
    const ocrSummary = timeline.filter(s => s.group_type === 'text_input');
    let ocrScore = 0;
    if (ocrSummary.length > 0) {
        let ocrRawTotal = 0;
        let ocrCounted = 0;
        ocrSummary.forEach(s => {
            const ocrRes = s.ocr_evaluation;
            const aiRes = s.ai_evaluation;
            const cropSource = s.bbox?.source || 'pixel';

            if (ocrRes?.error || !ocrRes) {
                // Tesseract crash -> use AI confidence as proxy (Architecture v4.1)
                if (aiRes?.ai_verdict === 'PASS') {
                    ocrRawTotal += (aiRes.confidence || 0.8) * 0.7; // Conservative estimate
                    ocrCounted++;
                    console.warn(`    [SCORE] OCR error for ${s.name}, using AI proxy score.`);
                }
            } else {
                if (cropSource === 'full-canvas' || (s.diffMask?.w >= s.diffMask?.canvasW * 0.75)) {
                    // Full canvas crop means OCR results are likely random noise
                    console.warn(`    [SCORE] OCR ignored for ${s.name} (Full-canvas crop).`);
                } else {
                    // Normal OCR calc using found + confidence instead of similarity
                    // Base 50% for finding it, up to 50% based on confidence 0-100
                    ocrCounted++;
                    ocrRawTotal += getOcrCredit(ocrRes, s.value_chosen, s);
                }
            }
        });
        ocrScore = ocrCounted > 0 ? (ocrRawTotal / ocrCounted) * ocrWeight : ocrWeight;
        if (ocrScore < ocrWeight) {
            const missingOcrSteps = ocrSummary
                .filter(s => !s.ocr_evaluation?.found && !hasStrongAiTextRescue(s))
                .map(s => s.name);
            const lowConfidenceHits = ocrSummary.filter((s) => {
                const ocrRes = s.ocr_evaluation;
                return (ocrRes?.found || hasStrongAiTextRescue(s)) && getOcrCredit(ocrRes, s.value_chosen, s) < 0.99;
            }).map(s => s.name);
            score_deduction_reasons.push({
                dimension: 'OCR',
                deducted_points: Math.round(ocrWeight - ocrScore),
                reason: missingOcrSteps.length > 0
                    ? 'Text input verification failed or has low confidence'
                    : 'Text recognized, but OCR confidence remains conservative',
                evidence: (missingOcrSteps.length > 0 ? missingOcrSteps : lowConfidenceHits).join(', ')
            });
        }
    } else {
        ocrScore = ocrWeight; // No text inputs = full points
    }

    // 4. AI Vision (Layer 4)
    // PURE AI PERFORMANCE: Based only on AI verdict, regardless of code fails.
    const customizationSteps = timeline.filter(s => validCustomizationTypes.includes(s.group_type) && !s.context_transition);
    let aiScoreValue = 0;
    if (customizationSteps.length > 0) {
        const aiScoredSteps = customizationSteps.filter((s) => {
            if (shouldIgnoreSemanticAiFail(s)) return false;
            const verdict = s.ai_evaluation?.ai_verdict;
            return verdict === 'PASS' || verdict === 'FAIL' || s.is_audit_pass;
        });
        if (aiScoredSteps.length === 0) {
            aiScoreValue = aiWeight;
        } else {
            const aiFailedSteps = aiScoredSteps.filter(s => s.ai_evaluation?.ai_verdict === 'FAIL' && !s.is_audit_pass);
            const aiPassed = aiScoredSteps.length - aiFailedSteps.length;
            aiScoreValue = (aiPassed / aiScoredSteps.length) * aiWeight;
            if (aiFailedSteps.length > 0) {
                score_deduction_reasons.push({
                    dimension: 'AI Vision',
                    deducted_points: Math.round(aiWeight - aiScoreValue),
                    reason: `${aiFailedSteps.length} steps failed AI visual judgment`,
                    evidence: aiFailedSteps.map(s => s.name).join(', ')
                });
            }
        }
    } else {
        aiScoreValue = aiWeight;
    }

    // 5. Completion (Layer 3C)
    let completionScoreValue = completionWeight;
    if (completion_result && completion_result.completionRatio !== undefined) {
        completionScoreValue = Math.min(1.0, completion_result.completionRatio) * completionWeight;
        if (completionScoreValue < completionWeight) {
            score_deduction_reasons.push({
                dimension: 'Completion',
                deducted_points: Math.round(completionWeight - completionScoreValue),
                reason: `Customization flow completion ratio: ${Math.round(completion_result.completionRatio * 100)}%`,
                evidence: completion_result.missingSteps ? completion_result.missingSteps.join(', ') : ''
            });
        }
    } else if (completion_result && completion_result.availability === 'UNAVAILABLE') {
        // Bỏ qua không tính nhầm thành 0 — rơi vào fallback full point default để tránh trừ điểm sai ở schema cũ.
        completionScoreValue = completionWeight;
    }

    // 6. Cart Result (Layer 1)
    let cartScoreValue = 0;
    if (cartResult?.success) {
        cartScoreValue = cartWeight;
    } else if (cartResult) {
        // Exclude penalty if website bug is detected (Architecture v4.1)
        // errorSummary is an object { jsErrors: [], consoleErrors: [], networkErrors: [], ... }
        const allErrorMessages = [
            ...((errorSummary?.jsErrors || []).map(e => e.message || '')),
            ...((errorSummary?.consoleErrors || []).map(e => e.message || '')),
            ...((errorSummary?.networkErrors || []).map(e => e.url || '')),
        ];
        const cartRelatedErrors = allErrorMessages.filter(e => 
            e.toLowerCase().includes('cart') || 
            e.toLowerCase().includes('checkout') || 
            e.toLowerCase().includes('add')
        );
        if (cartRelatedErrors.length > 0) {
            console.warn(`    [SCORE] Cart FAIL ignored due to website errors: ${cartRelatedErrors[0]}`);
            cartScoreValue = cartWeight; // Give benefit of doubt for website bugs
        } else {
            score_deduction_reasons.push({
                dimension: 'Cart',
                deducted_points: cartWeight,
                reason: 'Add to Cart failed',
                evidence: cartResult.error || 'Button clicked but cart didn\'t update'
            });
        }
    }
    // Hard gate requested: if Add to Cart is not successful, testcase must FAIL
    // regardless of high score. (Unless it is already FATAL by higher-priority rules.)
    const hasCartHardFail = !cartResult?.success;

    const rawScore = Math.round(pixelScore + colorScore + ocrScore + aiScoreValue + completionScoreValue + cartScoreValue);
    let finalScore = rawScore;
    let decision = rawScore >= 75 ? 'PASS_AUTO' : 'FAIL_AUTO';
    const decision_reason_codes = [];

    if (rawScore < 75) decision_reason_codes.push('LOW_SCORE');
    if (hasCartHardFail) decision_reason_codes.push('CART_FAIL');
    
    // Temporal & Critical Overrides (Layer 2B Upgrade)
    const hasFatalTemporal = temporal_violations.some(v => v.severity === 'FATAL');
    const hasNavFail = timeline.some(s => s.action === 'navigation' && s.status === 'FAIL');
    
    // Consensus Gating Logic: Avoid auto-killing test on single-signal temporal failure
    if (hasNavFail) {
        decision = RULES.DECISION.FATAL;
        status_reason = RULES.REASONS.NAV_FAIL;
        decision_reason_codes.push(RULES.REASONS.NAV_FAIL);
        finalScore = 0;
    } else if (is_fatal) {
        decision = RULES.DECISION.FATAL;
        status_reason = RULES.REASONS.INTERNAL_ERROR;
        decision_reason_codes.push(RULES.REASONS.INTERNAL_ERROR);
        finalScore = 0;
    } else if (hasFatalTemporal) {
        decision_reason_codes.push(RULES.REASONS.TEMPORAL_SEVERE);
        
        // Rule: Only FATAL if multiple critical signals agree (Cart Fail or Low Score or AI Fail)
        const aiVerdict = results?.final_evaluation?.ai_review?.ai_verdict || 
                          timeline.find(s => s.ai_evaluation && s.ai_evaluation.ai_verdict !== 'PENDING')?.ai_evaluation?.ai_verdict;
        const isAiPass = aiVerdict === 'PASS';
        const isLowScore = rawScore < 60;
        
        if (hasCartHardFail || isLowScore || !isAiPass) {
            decision = RULES.DECISION.FATAL;
            status_reason = RULES.REASONS.CONSENSUS_FATAL;
            finalScore = 0;
        } else {
            // High conflict: Temporal says FATAL, but AI/Cart/Score says OK
            decision = RULES.DECISION.REVIEW;
            status_reason = RULES.REASONS.TEMPORAL_CONFLICT;
            // Do NOT set score to 0, keep it for analysis
        }
    } else if (hasCartHardFail) {
        decision = RULES.DECISION.FAIL_AUTO;
        status_reason = RULES.REASONS.CART_FAIL;
        decision_reason_codes.push(RULES.REASONS.CART_FAIL);
    }

    // Mapping decision back to legacy status for UI compatibility
    let status = 'PASS';
    if (decision === RULES.DECISION.FATAL) status = 'FATAL';
    else if (decision === RULES.DECISION.REVIEW) status = 'REVIEW';
    else if (decision === RULES.DECISION.FAIL_AUTO || rawScore < 75 || hasCartHardFail) status = 'FAIL';

    const scoreBreakdown = {
        pixel: Math.round(pixelScore),
        color: Math.round(colorScore),
        ocr: Math.round(ocrScore),
        ai: Math.round(aiScoreValue),
        completion: Math.round(completionScoreValue),
        cart: Math.round(cartScoreValue),
        raw_total: rawScore,
        total: finalScore
    };

    const result = {
        case_index: caseIndex,
        case_label: optionLabel || `Case ${caseIndex + 1}`,
        status,
        decision,
        reason_codes: decision_reason_codes, // Standardized
        status_reason,
        raw_score: rawScore,
        score: finalScore,
        quality_score: rawScore, // Standardized fallback
        confidence_score: 1.0,    // Standardized fallback (decimal for UI)
        score_breakdown: scoreBreakdown,
        score_deduction_reasons,
        duration_ms: endTime - startTime,
        total_steps: totalSteps,
        passed_steps: passedSteps,
        timeline,
        temporal_violations,
        completion_result,
        phase_durations,
        final_evaluation: {
            js_errors: errorSummary.totalJsErrors || 0,
            console_errors: errorSummary.totalConsoleErrors || 0,
            preview_valid: previewResult?.valid || false,
            cart_result: cartResult?.success ? 'PASS' : 'FAIL',
        },
    };

    // Reliability Engine integration updates
    if (reliability) {
        result.decision = reliability.decision || result.decision;
        result.reason_codes = reliability.reason_codes || reliability.decision_reason_codes || result.reason_codes;
        result.quality_score = reliability.quality_score;
        result.confidence_score = reliability.confidence_score;
        result.score = reliability.quality_score; // Engine V2 score is the truth
        
        result.reliability_v2 = {
            quality_score: reliability.quality_score,
            confidence_score: reliability.confidence_score,
            decision: reliability.decision,
            reason_codes: result.reason_codes,
            signal_detail: reliability.signal_detail
        };
        
        // Mirror back to legacy status
        if (result.decision === RULES.DECISION.PASS_AUTO) result.status = 'PASS';
        else if (result.decision === RULES.DECISION.FAIL_AUTO) result.status = 'FAIL';
        else if (result.decision === RULES.DECISION.REVIEW) result.status = 'REVIEW';
        else if (result.decision === RULES.DECISION.FATAL) result.status = 'FATAL';
    }

    return result;
}

/**
 * Build combined report from multiple case reports
 */
function buildCombinedReport({ productUrl, tcCode, cases, startTime, aiEnabled, variants_selected = [] }) {
    const totalCases = cases.length;
    const passedCases = cases.filter((c) => c.status === 'PASS').length;
    const reviewCases = cases.filter((c) => c.decision === RULES.DECISION.REVIEW).length;
    const failedCases = totalCases - passedCases - reviewCases;
    
    const scores = cases.map((c) => c.score);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1));

    const rawScores = cases.map((c) => c.raw_score || c.score);
    const avgRawScore = Math.round(rawScores.reduce((a, b) => a + b, 0) / Math.max(rawScores.length, 1));

    // Aggregate errors and screenshots
    const errors = [];
    const screenshots = [];
    cases.forEach((c) => {
        const ev = c.final_evaluation || {};
        (ev.js_errors_list || []).forEach((e) => errors.push({ type: 'js', case_index: c.case_index, ...e }));
        (ev.console_errors_list || []).forEach((e) => errors.push({ type: 'console', case_index: c.case_index, ...e }));
        (ev.network_errors_list || []).forEach((e) => errors.push({ type: 'network', case_index: c.case_index, ...e }));
        
        (c.timeline || []).forEach((step) => {
            if (step.state_before) screenshots.push({ case_index: c.case_index, step_id: step.step_id, type: 'before', path: step.state_before });
            if (step.state_after) screenshots.push({ case_index: c.case_index, step_id: step.step_id, type: 'after', path: step.state_after });
        });
        if (c.html_snapshot) screenshots.push({ case_index: c.case_index, type: 'html_snapshot', path: c.html_snapshot });
    });

    // Decision aggregation
    const hasFatal = cases.some(c => c.decision === RULES.DECISION.FATAL || c.status === 'FATAL');
    const hasReview = cases.some(c => c.decision === RULES.DECISION.REVIEW || c.status === 'REVIEW');
    const hasFail = cases.some(c => c.decision === RULES.DECISION.FAIL_AUTO || c.status === 'FAIL');
    
    let reportDecision = RULES.DECISION.PASS_AUTO;
    if (hasFatal) reportDecision = RULES.DECISION.FATAL;
    else if (hasReview) reportDecision = RULES.DECISION.REVIEW;
    else if (hasFail) reportDecision = RULES.DECISION.FAIL_AUTO;

    let reportStatus = 'PASS';
    if (reportDecision === RULES.DECISION.FATAL) reportStatus = 'FATAL';
    else if (reportDecision === RULES.DECISION.REVIEW) reportStatus = 'REVIEW';
    else if (reportDecision === RULES.DECISION.FAIL_AUTO) reportStatus = 'FAIL';

    return {
        tc_code: tcCode,
        qa_code: tcCode,
        product_url: productUrl,
        test_case_label: `${tcCode} (${totalCases} cases)`,
        status: reportStatus,
        result_status: reportStatus,
        report_status: reportStatus,
        decision: reportDecision,
        reason_codes: [...new Set(cases.flatMap(c => c.reason_codes || []))],
        score: avgScore,
        raw_score: avgRawScore,
        quality_score: avgScore,
        confidence_score: Math.min(...cases.map(c => c.confidence_score || 1.0)),
        test_time: startTime.toISOString(),
        variants_selected,
        duration_ms: new Date() - startTime,
        total_cases: totalCases,
        passed_cases: passedCases,
        failed_cases: failedCases,
        review_cases: reviewCases,
        errors,
        screenshots,
        cases,
        total_steps: cases.reduce((s, c) => s + c.total_steps, 0),
        passed_steps: cases.reduce((s, c) => s + c.passed_steps, 0),
        failed_steps: cases.reduce((s, c) => s + ((c.total_steps || 0) - (c.passed_steps || 0)), 0),
        name: `${tcCode} (${totalCases} cases)`,
    };
}

/**
 * Convert absolute paths in timeline to relative URLs for web dashboard
 */
function convertTimeline(timeline, reportsBase) {
    if (!reportsBase || !timeline) return;
    timeline.forEach((step) => {
        if (step.state_before) step.state_before = toRelativeUrl(step.state_before, reportsBase);
        if (step.state_after) step.state_after = toRelativeUrl(step.state_after, reportsBase);
        if (step.ai_annotated_image) step.ai_annotated_image = toRelativeUrl(step.ai_annotated_image, reportsBase);
        
        if (step.cart_evidence) {
            if (step.cart_evidence.panel) step.cart_evidence.panel = toRelativeUrl(step.cart_evidence.panel, reportsBase);
            if (step.cart_evidence.viewport) step.cart_evidence.viewport = toRelativeUrl(step.cart_evidence.viewport, reportsBase);
        }
    });
}

function saveCombinedReport(report, tcDir) {
    const webReport = JSON.parse(JSON.stringify(report));
    const reportsBase = findReportsBase(tcDir);

    if (reportsBase && webReport.cases) {
        webReport.cases.forEach((c) => {
            convertTimeline(c.timeline, reportsBase);
            if (c.final_evaluation?.ai_review?.reviewed_image) {
                c.final_evaluation.ai_review.reviewed_image = toRelativeUrl(c.final_evaluation.ai_review.reviewed_image, reportsBase);
            }
            if (c.html_snapshot) c.html_snapshot = toRelativeUrl(c.html_snapshot, reportsBase);
        });
        webReport.screenshots?.forEach((s) => s.path = toRelativeUrl(s.path, reportsBase));
    }

    const filePath = path.join(tcDir, 'report.json');
    fs.writeFileSync(filePath, JSON.stringify(webReport, null, 2), 'utf-8');
    return filePath;
}

function findReportsBase(dirPath) {
    const normalized = dirPath.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/reports/');
    return idx >= 0 ? normalized.substring(0, idx) : null;
}

function toRelativeUrl(absPath, basePath) {
    if (!absPath || !basePath) return absPath;
    const normalized = absPath.replace(/\\/g, '/');
    const base = basePath.replace(/\\/g, '/');
    return normalized.startsWith(base) ? normalized.substring(base.length) : absPath;
}

function printCaseSummary(caseReport, caseIndex) {
    console.log(`    Case ${caseIndex + 1}: ${caseReport.case_label} │ ${caseReport.status} │ Score: ${caseReport.score}/100 │ Steps: ${caseReport.passed_steps}/${caseReport.total_steps}`);
}

function printCombinedSummary(report) {
    console.log(`\n  ${'─'.repeat(50)}`);
    console.log(`  ${report.tc_code} │ ${report.status} │ Avg Score: ${report.score}/100`);
    console.log(`  Cases: ${report.passed_cases}/${report.total_cases} passed │ Total Steps: ${report.passed_steps || 0}/${report.total_steps || 0}`);
    console.log(`  ${'─'.repeat(50)}\n`);
}

module.exports = {
    ensureDir,
    getNextTcCode,
    createTcDir,
    createCaseDir,
    buildCaseReport,
    buildCombinedReport,
    saveCombinedReport,
    printCaseSummary,
    printCombinedSummary,
};
