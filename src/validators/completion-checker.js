/**
 * Completion Checker
 * Verifies if all cumulative customizations are visible on the final preview.
 * Returns availability=UNAVAILABLE if diff calculation fails (Spec §5.2.3).
 */

const { calculateVisualDiff } = require('../actions/validator');

async function checkCompletion(steps, baselinePath, finalPath) {
    try {
        if (!baselinePath || !finalPath) {
            return { result: 'ERROR', message: 'Missing baseline or final path', availability: 'UNAVAILABLE' };
        }

        const finalDiff = await calculateVisualDiff(baselinePath, finalPath);
        const totalActualDiff = finalDiff.diffPercent;

        // If diff returned -1, treat as UNAVAILABLE — do NOT score as 0
        if (totalActualDiff === -1 || finalDiff.error) {
            return { result: 'ERROR', message: finalDiff.error || 'Diff failed', availability: 'UNAVAILABLE' };
        }

        const expectedDiffSum = steps
            .filter(s => s.diff_score > 0.01)
            .reduce((sum, s) => sum + s.diff_score, 0);

        const ratio = expectedDiffSum > 0
            ? Math.min(1.2, totalActualDiff / (expectedDiffSum * 0.7))
            : 1.0;

        // Clamp to valid range — never negative
        const clampedRatio = Math.max(0, Math.min(1.2, ratio));

        const appliedActions = steps
            .filter(s => s.diff_score > 0.01)
            .map(s => `- ${s.group_type || s.action}: "${s.value_chosen}"`)
            .join('\n');

        return {
            completionRatio: clampedRatio,
            result: clampedRatio > 0.75 ? 'PASS' : 'WARNING',
            appliedActions,
            totalActualDiff,
            expectedDiffSum,
            availability: 'AVAILABLE',
        };
    } catch (error) {
        return { result: 'ERROR', message: error.message, availability: 'UNAVAILABLE' };
    }
}

module.exports = { checkCompletion };
