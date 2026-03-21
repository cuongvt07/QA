/**
 * Phase 2: Calibration Harness
 * Computes confusion matrix and metrics (Precision, Recall) for Auto Test Decider.
 */

const fs = require('fs');
const path = require('path');

function runEvaluation(labeledDataPath) {
    if (!fs.existsSync(labeledDataPath)) {
        console.error('Benchmark set not found at:', labeledDataPath);
        return;
    }

    const report = JSON.parse(fs.readFileSync(labeledDataPath, 'utf8'));
    const cases = report.cases || [];

    const matrix = {
        PASS_PASS: 0, PASS_FAIL: 0, PASS_REVIEW: 0,
        FAIL_PASS: 0, FAIL_FAIL: 0, FAIL_REVIEW: 0,
    };

    cases.forEach(c => {
        const actual = c.ground_truth; // Manually labeled by human
        const predicted = c.status;    // System decision

        if (!actual) return;

        const key = `${actual}_${predicted}`;
        if (matrix[key] !== undefined) matrix[key]++;
        else matrix[key] = (matrix[key] || 0) + 1;
    });

    console.log('--- Confusion Matrix ---');
    console.table([
        { Actual: 'PASS', 'Pred PASS': matrix.PASS_PASS, 'Pred FAIL': matrix.PASS_FAIL, 'Pred REVIEW': matrix.PASS_REVIEW },
        { Actual: 'FAIL', 'Pred PASS': matrix.FAIL_PASS, 'Pred FAIL': matrix.FAIL_FAIL, 'Pred REVIEW': matrix.FAIL_REVIEW },
    ]);

    const precision = matrix.PASS_PASS / (matrix.PASS_PASS + matrix.FAIL_PASS) || 0;
    const recall = matrix.PASS_PASS / (matrix.PASS_PASS + matrix.PASS_FAIL + matrix.PASS_REVIEW) || 0;

    console.log(`Precision: ${(precision * 100).toFixed(2)}%`);
    console.log(`Recall:    ${(recall * 100).toFixed(2)}%`);
}

// Usage: node scripts/eval/confusion-matrix.js path/to/labeled-report.json
const target = process.argv[2];
if (target) runEvaluation(target);

module.exports = { runEvaluation };
