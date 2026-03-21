/**
 * Temporal Consistency Validator (QA-Centric v3.4)
 * Checks if previous customizations are still present in subsequent steps.
 */
const { calculateVisualDiff } = require('../actions/validator');

const HIGH_THRESHOLD = parseFloat(process.env.TEMPORAL_HIGH_THRESHOLD) || 2.0; // 2%
const FATAL_THRESHOLD = parseFloat(process.env.TEMPORAL_FATAL_THRESHOLD) || 8.0; // 8%

const EXCLUDED_GROUPS = ['dropdown', 'menu_opener', 'navigation', 'layout_toggle', 'lifecycle'];

function getSlot(name = '') {
    const match = String(name).match(/#(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

function hasComparableState(step) {
    return Boolean(step && step.state_before && step.state_after);
}

function looksRenderAffectingControl(step) {
    const label = String(step?.name || '').toLowerCase();
    return [
        'number of',
        'number',
        'qty',
        'quantity',
        'kid',
        'kids',
        'child',
        'children',
        'people',
        'person',
        'family',
        'member',
        'pet',
        'pets',
    ].some((hint) => label.includes(hint));
}

function isTemporalCandidate(step) {
    if (!step) return false;
    if (step.skip_diff_check) return false;
    if (step.context_transition) return false;
    if (EXCLUDED_GROUPS.includes(step.group_type)) return false;
    return hasComparableState(step);
}

function isHiddenTransitionStep(step) {
    if (!step) return false;
    const observedChange = Number(step.observed_preview_change_score) || 0;
    const changesPreview = Boolean(step.changes_preview) || observedChange > 0.01;
    if (step.is_menu_opener) return true;
    if (step.context_transition) return true;
    if (step.selection_changes_structure) return true;
    if (step.render_affecting_control) return true;
    if (step.group_type === 'dropdown' && looksRenderAffectingControl(step)) return true;
    if (step.skip_diff_check && changesPreview) return true;
    return false;
}

async function checkTemporalConsistency(timeline) {
    const violations = [];

    const candidateIndexes = [];
    for (let i = 0; i < timeline.length; i++) {
        if (isTemporalCandidate(timeline[i])) {
            candidateIndexes.push(i);
        }
    }

    if (candidateIndexes.length < 2) return [];

    for (let i = 0; i < candidateIndexes.length - 1; i++) {
        const currentIndex = candidateIndexes[i];
        const nextIndex = candidateIndexes[i + 1];
        const current = timeline[currentIndex];
        const next = timeline[nextIndex];

        if (!current?.state_after || !next?.state_before) continue;

        const interveningSteps = timeline.slice(currentIndex + 1, nextIndex);
        const hiddenTransition = interveningSteps.find(isHiddenTransitionStep);
        if (hiddenTransition) {
            continue;
        }

        const currentSlot = getSlot(current.name);
        const nextSlot = getSlot(next.name);
        if (currentSlot !== 0 && nextSlot !== 0 && currentSlot !== nextSlot) {
            continue;
        }

        const diff = await calculateVisualDiff(current.state_after, next.state_before);

        if (diff.diffPercent >= HIGH_THRESHOLD) {
            violations.push({
                affectedStep: current.step_id || currentIndex,
                pair_step_from: current.step_id || currentIndex,
                pair_step_to: next.step_id || nextIndex,
                name: current.name,
                diffPercent: diff.diffPercent,
                severity: diff.diffPercent >= FATAL_THRESHOLD ? 'FATAL' : 'HIGH',
                metadata: {
                    thresholds: { high: HIGH_THRESHOLD, fatal: FATAL_THRESHOLD },
                    group_type: current.group_type,
                    compared_to: next.name,
                    message: `Unexpected visual shift (${diff.diffPercent.toFixed(2)}%) between ${current.name} and ${next.name}`
                }
            });
        }
    }

    return violations;
}

module.exports = { checkTemporalConsistency };
