/**
 * Reporter Module — v3.0
 * Uses sequential TC codes (TC_1, TC_2...) for grouped testcase folders.
 * Each TC folder contains case subfolders: TC_1/case_1/, TC_1/case_2/
 * Combined report saved at: TC_1/report.json
 */

const fs = require('fs');
const path = require('path');

/**
 * Ensure directory exists (create recursively if not)
 */
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Get next TC code by scanning existing folders.
 * Returns 'TC_1', 'TC_2', etc.
 */
function getNextTcCode(baseReportDir) {
    ensureDir(baseReportDir);
    const existing = fs.readdirSync(baseReportDir)
        .filter((f) => /^TC_\d+$/i.test(f))
        .map((f) => parseInt(f.replace(/^TC_/i, ''), 10))
        .filter((n) => !isNaN(n));

    const maxNum = existing.length > 0 ? Math.max(...existing) : 0;
    return `TC_${maxNum + 1}`;
}

/**
 * Create the parent TC directory: web/reports/TC_1/
 */
function createTcDir(baseReportDir, tcCode) {
    const tcDir = path.join(baseReportDir, tcCode);
    ensureDir(tcDir);
    return tcDir;
}

/**
 * Create a case sub-directory: web/reports/TC_1/case_1/
 */
function createCaseDir(tcDir, caseIndex) {
    const caseDir = path.join(tcDir, `case_${caseIndex + 1}`);
    ensureDir(caseDir);
    return caseDir;
}

/**
 * Build report JSON for a single case within a test
 */
function buildCaseReport({ caseIndex, optionLabel, timeline, errorSummary, cartResult, previewResult, startTime, aiEnabled, is_fatal, fatal_reasons }) {
    const endTime = new Date();
    const totalSteps = timeline.length;
    const passedSteps = timeline.filter((s) => s.status === 'PASS').length;
    const failedSteps = timeline.filter((s) => s.status === 'FAIL').length;

    // Only count visual-impacting failures for score penalty (customization steps only)
    const customizeSteps = timeline.filter((s) => s.group_type !== 'lifecycle');
    const visualFailedSteps = customizeSteps.filter(
        (s) => s.status === 'FAIL' && s.expects_visual_change !== false && !s.requires_ocr
    ).length;

    // Count text input failures separately (diff + OCR)
    const textDiffFailed = customizeSteps.filter(
        (s) => s.requires_ocr && s.code_evaluation?.status === 'FAIL'
    ).length;

    // Lifecycle step penalties
    const lifecycleSteps = timeline.filter((s) => s.group_type === 'lifecycle');
    const openPageFail = lifecycleSteps.find((s) => s.action === 'open_page' && s.status === 'FAIL') ? 1 : 0;
    const loadCustFail = lifecycleSteps.find((s) => s.action === 'load_customizer' && s.status === 'FAIL') ? 1 : 0;
    const previewFail = lifecycleSteps.find((s) => s.action === 'validate_preview' && s.status === 'FAIL') ? 1 : 0;
    const cartFail = lifecycleSteps.find((s) => s.action === 'add_to_cart' && s.status === 'FAIL') ? 1 : 0;

    // Code-based score with differentiated penalties
    const visualPenalty = visualFailedSteps * 15;
    const textDiffPenalty = textDiffFailed * 15;
    const openPagePenalty = openPageFail * 10;
    const loadCustPenalty = loadCustFail * 15;
    const previewPenalty = previewFail * 15;
    const cartPenalty = cartFail * 10;

    let codeScore = 100;
    codeScore -= visualPenalty;
    codeScore -= textDiffPenalty;
    codeScore -= openPagePenalty;
    codeScore -= loadCustPenalty;
    codeScore -= previewPenalty;
    codeScore -= cartPenalty;
    // NOTE: JS/Console/Network errors are logged only — NO score penalty
    codeScore = Math.max(0, Math.min(100, codeScore));

    // AI-based average score (informational only, stored but not blended)
    const aiScores = timeline
        .map((s) => s.ai_evaluation?.ai_score)
        .filter((s) => typeof s === 'number' && s >= 0);
    const avgAiScore = aiScores.length > 0
        ? Math.round(aiScores.reduce((a, b) => a + b, 0) / aiScores.length)
        : -1;

    // Final score = code score only (AI is advisory)
    let finalScore = codeScore;

    // Status based on code score and visual failures only
    const totalCriticalFails = visualFailedSteps + textDiffFailed;
    let status = finalScore >= 70 && totalCriticalFails === 0 ? 'PASS' : 'FAIL';

    // Fatal override — only for severe issues (preview crash or API fatal errors)
    if (is_fatal) {
        status = 'FATAL';
        finalScore = 0;
        codeScore = 0;
    }

    // Score breakdown for transparency
    const scoreBreakdown = {
        base_score: 100,
        visual_fail_count: visualFailedSteps,
        visual_fail_penalty: -visualPenalty,
        text_diff_fail_count: textDiffFailed,
        text_diff_penalty: -textDiffPenalty,
        open_page_penalty: -openPagePenalty,
        load_customizer_penalty: -loadCustPenalty,
        preview_validation_penalty: -previewPenalty,
        add_to_cart_penalty: -cartPenalty,
        final_score: finalScore,
        note: 'JS/Console/Network errors are logged only, not penalized in score',
    };

    return {
        case_index: caseIndex,
        case_label: optionLabel || `Case ${caseIndex + 1}`,
        status,
        is_fatal: is_fatal || false,
        fatal_reasons: fatal_reasons || [],
        score: finalScore,
        score_breakdown: scoreBreakdown,
        code_score: codeScore,
        ai_score: avgAiScore,
        duration_ms: endTime - startTime,
        total_steps: totalSteps,
        passed_steps: passedSteps,
        failed_steps: failedSteps,
        timeline,
        final_evaluation: {
            js_errors: errorSummary.totalJsErrors || 0,
            console_errors: errorSummary.totalConsoleErrors || 0,
            network_errors: errorSummary.totalNetworkErrors || 0,
            js_errors_list: errorSummary.jsErrors || [],
            network_errors_list: errorSummary.networkErrors || [],
            console_errors_list: errorSummary.consoleErrors || [],
            ui_interaction_score: `${Math.round((passedSteps / Math.max(totalSteps, 1)) * 100)}%`,
            preview_valid: previewResult?.valid || false,
            cart_result: cartResult?.success ? 'PASS' : 'FAIL',
        },
    };
}

/**
 * Build combined report from multiple case reports
 */
function buildCombinedReport({ productUrl, tcCode, cases, startTime, aiEnabled, variants_selected = [] }) {
    const totalCases = cases.length;
    const passedCases = cases.filter((c) => c.status === 'PASS').length;
    const scores = cases.map((c) => c.score);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1));

    const overallStatus = passedCases === totalCases ? 'PASS' : 'FAIL';

    // Aggregate errors from all cases at root level
    const errors = [];
    const screenshots = [];
    cases.forEach((c) => {
        const ev = c.final_evaluation || {};
        // JS errors
        (ev.js_errors_list || []).forEach((e) => {
            errors.push({ type: 'js', case_index: c.case_index, ...e });
        });
        // Console errors
        (ev.console_errors_list || []).forEach((e) => {
            errors.push({ type: 'console', case_index: c.case_index, ...e });
        });
        // Network errors
        (ev.network_errors_list || []).forEach((e) => {
            errors.push({ type: 'network', case_index: c.case_index, ...e });
        });
        // Collect screenshots from timeline
        (c.timeline || []).forEach((step) => {
            if (step.state_before) screenshots.push({ case_index: c.case_index, step_id: step.step_id, type: 'before', path: step.state_before });
            if (step.state_after) screenshots.push({ case_index: c.case_index, step_id: step.step_id, type: 'after', path: step.state_after });
        });
        // HTML snapshots
        if (c.html_snapshot) {
            screenshots.push({ case_index: c.case_index, type: 'html_snapshot', path: c.html_snapshot });
        }
    });

    return {
        tc_code: tcCode,
        // Keep qa_code for backward compatibility with dashboard
        qa_code: tcCode,
        product_url: productUrl,
        test_case_label: `${tcCode} (${totalCases} cases)`,
        status: overallStatus,
        score: avgScore,
        test_time: startTime.toISOString(),
        variants_selected,
        duration_ms: new Date() - startTime,
        total_cases: totalCases,
        passed_cases: passedCases,
        failed_cases: totalCases - passedCases,
        errors,
        screenshots,
        cases,
        // Flat summary for backward-compatible dashboard cards
        total_steps: cases.reduce((s, c) => s + c.total_steps, 0),
        passed_steps: cases.reduce((s, c) => s + c.passed_steps, 0),
        failed_steps: cases.reduce((s, c) => s + c.failed_steps, 0),
        name: `${tcCode} (${totalCases} cases)`,
    };
}

/**
 * Convert absolute paths in timeline to relative URLs for web dashboard
 */
function convertTimeline(timeline, reportsBase) {
    if (!reportsBase || !timeline) return;
    timeline.forEach((step) => {
        if (step.state_before) {
            step.state_before = toRelativeUrl(step.state_before, reportsBase);
        }
        if (step.state_after) {
            step.state_after = toRelativeUrl(step.state_after, reportsBase);
        }
        if (step.ai_annotated_image) {
            step.ai_annotated_image = toRelativeUrl(step.ai_annotated_image, reportsBase);
        }
    });
}

/**
 * Save combined report.
 * Converts absolute paths to relative URLs for web dashboard.
 */
function saveCombinedReport(report, tcDir) {
    const webReport = JSON.parse(JSON.stringify(report));
    const reportsBase = findReportsBase(tcDir);

    if (reportsBase && webReport.cases) {
        webReport.cases.forEach((c) => {
            convertTimeline(c.timeline, reportsBase);
            if (c.final_evaluation?.ai_review?.reviewed_image) {
                c.final_evaluation.ai_review.reviewed_image = toRelativeUrl(c.final_evaluation.ai_review.reviewed_image, reportsBase);
            }
            if (c.html_snapshot) {
                c.html_snapshot = toRelativeUrl(c.html_snapshot, reportsBase);
            }
        });
    }

    if (reportsBase && webReport.screenshots) {
        webReport.screenshots.forEach((s) => {
            s.path = toRelativeUrl(s.path, reportsBase);
        });
    }

    const filePath = path.join(tcDir, 'report.json');
    fs.writeFileSync(filePath, JSON.stringify(webReport, null, 2), 'utf-8');
    return filePath;
}

/**
 * Find the parent directory that contains 'reports/' to calculate relative paths
 */
function findReportsBase(dirPath) {
    const normalized = dirPath.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/reports/');
    if (idx >= 0) {
        return normalized.substring(0, idx);
    }
    return null;
}

/**
 * Convert absolute path to relative URL path
 */
function toRelativeUrl(absPath, basePath) {
    if (!absPath || !basePath) return absPath;
    const normalized = absPath.replace(/\\/g, '/');
    const base = basePath.replace(/\\/g, '/');
    if (normalized.startsWith(base)) {
        return normalized.substring(base.length);
    }
    return absPath;
}

/**
 * Print summary for a single case to console
 */
function printCaseSummary(caseReport, caseIndex) {
    console.log(`    Case ${caseIndex + 1}: ${caseReport.case_label} │ ${caseReport.status} │ Score: ${caseReport.score}/100 │ Steps: ${caseReport.passed_steps}/${caseReport.total_steps}`);
}

/**
 * Print combined summary to console
 */
function printCombinedSummary(report) {
    console.log(`\n  ${'─'.repeat(50)}`);
    console.log(`  ${report.tc_code} │ ${report.status} │ Avg Score: ${report.score}/100`);
    console.log(`  Cases: ${report.passed_cases}/${report.total_cases} passed │ Total Steps: ${report.passed_steps}/${report.total_steps}`);
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
