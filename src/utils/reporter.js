/**
 * Reporter Module — v2.1
 * Uses sequential QA codes (QA1, QA2...) for testcase folders.
 * Screenshots go directly into the QA folder: web/reports/QA1/step_1_before.png
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
 * Get next QA code by scanning existing folders.
 * Returns 'QA1', 'QA2', etc.
 */
function getNextQaCode(baseReportDir) {
    ensureDir(baseReportDir);
    const existing = fs.readdirSync(baseReportDir)
        .filter((f) => /^QA\d+$/i.test(f))
        .map((f) => parseInt(f.replace(/^QA/i, ''), 10))
        .filter((n) => !isNaN(n));

    const maxNum = existing.length > 0 ? Math.max(...existing) : 0;
    return `QA${maxNum + 1}`;
}

/**
 * Create a testcase directory: web/reports/QA1/
 * Screenshots go directly in this folder (no screenshots/ subfolder).
 */
function createTestCaseDir(baseReportDir, qaCode) {
    const tcDir = path.join(baseReportDir, qaCode);
    ensureDir(tcDir);
    return tcDir;
}

/**
 * Build final report JSON for a single test case
 */
function buildReport({ productUrl, qaCode, testCaseLabel, timeline, errorSummary, cartResult, previewResult, startTime, aiEnabled }) {
    const endTime = new Date();
    const totalSteps = timeline.length;
    const passedSteps = timeline.filter((s) => s.status === 'PASS').length;
    const failedSteps = timeline.filter((s) => s.status === 'FAIL').length;

    // Only count visual-impacting failures for score penalty
    const visualFailedSteps = timeline.filter(
        (s) => s.status === 'FAIL' && s.expects_visual_change !== false
    ).length;

    // Code-based score (only penalize visual failures)
    let codeScore = 100;
    codeScore -= visualFailedSteps * 10;
    codeScore -= (errorSummary.totalJsErrors || 0) * 15;
    codeScore -= (errorSummary.totalNetworkErrors || 0) * 10;
    if (!previewResult?.valid) codeScore -= 20;
    if (!cartResult?.success) codeScore -= 15;
    codeScore = Math.max(0, Math.min(100, codeScore));

    // AI-based average score
    const aiScores = timeline
        .map((s) => s.ai_evaluation?.ai_score)
        .filter((s) => typeof s === 'number' && s >= 0);
    const avgAiScore = aiScores.length > 0
        ? Math.round(aiScores.reduce((a, b) => a + b, 0) / aiScores.length)
        : -1;

    // Combined final score
    let finalScore;
    if (avgAiScore >= 0 && aiEnabled) {
        finalScore = Math.round(codeScore * 0.5 + avgAiScore * 0.5);
    } else {
        finalScore = codeScore;
    }

    const status = finalScore >= 70 && visualFailedSteps === 0 ? 'PASS' : 'FAIL';

    return {
        qa_code: qaCode,
        product_url: productUrl,
        test_case_label: testCaseLabel || qaCode,
        status: status,
        score: finalScore,
        code_score: codeScore,
        ai_score: avgAiScore,
        test_time: startTime.toISOString(),
        duration_ms: endTime - startTime,
        total_steps: totalSteps,
        passed_steps: passedSteps,
        failed_steps: failedSteps,
        timeline: timeline,
        final_evaluation: {
            js_errors: errorSummary.totalJsErrors || 0,
            console_errors: errorSummary.totalConsoleErrors || 0,
            network_errors: errorSummary.totalNetworkErrors || 0,
            ui_interaction_score: `${Math.round((passedSteps / Math.max(totalSteps, 1)) * 100)}%`,
            preview_valid: previewResult?.valid || false,
            cart_result: cartResult?.success ? 'PASS' : 'FAIL',
            summary: generateSummary(status, finalScore, codeScore, avgAiScore, failedSteps, errorSummary, previewResult, cartResult),
        },
    };
}

/**
 * Generate human-readable summary
 */
function generateSummary(status, finalScore, codeScore, aiScore, failedSteps, errorSummary, previewResult, cartResult) {
    const parts = [];
    parts.push(`${status} — Final: ${finalScore}/100 (Code: ${codeScore}, AI: ${aiScore >= 0 ? aiScore : 'N/A'}).`);

    if (failedSteps > 0) {
        parts.push(`${failedSteps} step(s) failed.`);
    }
    if ((errorSummary.totalJsErrors || 0) > 0) {
        parts.push(`${errorSummary.totalJsErrors} JS error(s).`);
    }
    if ((errorSummary.totalNetworkErrors || 0) > 0) {
        parts.push(`${errorSummary.totalNetworkErrors} network error(s).`);
    }
    if (!previewResult?.valid) {
        parts.push(`Preview: ${previewResult?.error || 'FAIL'}.`);
    }
    if (!cartResult?.success) {
        parts.push('Add-to-cart failed.');
    }
    return parts.join(' ');
}

/**
 * Save single testcase report.
 * Converts absolute paths to relative URLs for web dashboard.
 */
function saveReport(report, testCaseDir) {
    const webReport = JSON.parse(JSON.stringify(report));
    const reportsBase = findReportsBase(testCaseDir);

    if (reportsBase && webReport.timeline) {
        webReport.timeline.forEach((step) => {
            if (step.state_before) {
                step.state_before = toRelativeUrl(step.state_before, reportsBase);
            }
            if (step.state_after) {
                step.state_after = toRelativeUrl(step.state_after, reportsBase);
            }
        });
    }

    const filePath = path.join(testCaseDir, 'report.json');
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
 * Convert absolute path to relative URL path (e.g. /reports/QA1/step_1_before.png)
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
 * Print summary to console
 */
function printSummary(report) {
    const label = report.qa_code || report.test_case_label;
    console.log(`\n  ${'─'.repeat(46)}`);
    console.log(`  ${label} │ ${report.status} │ Score: ${report.score}/100`);
    console.log(`  Code: ${report.code_score} │ AI: ${report.ai_score >= 0 ? report.ai_score : 'N/A'} │ Steps: ${report.passed_steps}/${report.total_steps}`);
    console.log(`  ${'─'.repeat(46)}\n`);
}

module.exports = {
    ensureDir,
    getNextQaCode,
    createTestCaseDir,
    buildReport,
    saveReport,
    printSummary,
};
