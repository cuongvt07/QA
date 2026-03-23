/**
 * Reliability Normalizer — Spec v2.1, Section 3–4
 *
 * Maps raw step data → structured signals object with UNAVAILABLE normalization.
 * Rule: NEVER map a technical failure to 0-score; use UNAVAILABLE instead.
 */

'use strict';

const AVAIL = 'AVAILABLE';
const UNAVAIL = 'UNAVAILABLE';

// ─── Signal builders ─────────────────────────────────────────────────────────

/**
 * Build the normalized `signals` object for one step.
 * Source: step data emitted by cli.js evaluation phase.
 */
function buildSignals(step) {
    return {
        diff: buildDiffSignal(step),
        ocr: buildOcrSignal(step),
        color: buildColorSignal(step),
        ai: buildAiSignal(step),
        temporal_impact: buildTemporalSignal(step),
    };
}

function buildDiffSignal(step) {
    const score = step.diff_score;
    if (score === -1 || score === undefined || score === null) {
        return { score: null, mask_quality: 0, availability: UNAVAIL };
    }
    const mask = step.diffMask;
    const maskQuality = (mask && mask.w > 0 && mask.h > 0) ? 0.85 : 0;
    return { score, mask_quality: maskQuality, availability: AVAIL };
}

function buildOcrSignal(step) {
    const ocr = step.ocr_evaluation;
    if (!ocr || ocr.error) {
        return { found: false, confidence: null, text: '', matchDetail: '', preprocess: '', availability: UNAVAIL };
    }
    return {
        found: !!(ocr.found),
        confidence: ocr.confidence ?? null,
        text: ocr.extractedText || ocr.actual || '',
        matchDetail: ocr.matchDetail || '',
        preprocess: ocr.preprocess || '',
        availability: AVAIL,
    };
}

function buildColorSignal(step) {
    const color = step.color_evaluation;
    if (!color) {
        return { result: 'UNAVAILABLE', fallback_used: false, fallback_source: null, availability: UNAVAIL };
    }
    if (color.result === 'SKIPPED' || color.result === 'UNAVAILABLE' || color.availability === UNAVAIL) {
        return { result: 'UNAVAILABLE', fallback_used: false, fallback_source: null, availability: UNAVAIL };
    }
    if (color.result === 'ERROR') {
        // Try AI/diff fallback
        const aiPass = step.ai_evaluation?.ai_verdict === 'PASS';
        const diffPass = (step.diff_score ?? -1) > 0.01;
        if (aiPass && diffPass) {
            return { result: 'ERROR', fallback_used: true, fallback_source: 'ai_semantic', availability: AVAIL };
        }
        return { result: 'ERROR', fallback_used: false, fallback_source: null, availability: UNAVAIL };
    }
    return { result: color.result, fallback_used: false, fallback_source: null, availability: AVAIL };
}

function buildAiSignal(step) {
    const ai = step.ai_evaluation;
    if (step.ai_semantic_untrusted) {
        return {
            verdict: ai?.ai_verdict || 'UNAVAILABLE',
            confidence: ai?.confidence ?? null,
            reason: ai?.ai_reason || '',
            availability: UNAVAIL,
        };
    }
    if (!ai || ai.ai_verdict === 'ERROR' || ai.ai_verdict === 'DISABLED' || ai.ai_verdict === 'SKIPPED' || ai.ai_verdict === 'PENDING') {
        return {
            verdict: ai?.ai_verdict || 'UNAVAILABLE',
            confidence: null,
            reason: ai?.ai_reason || '',
            availability: UNAVAIL,
        };
    }
    return {
        verdict: ai.ai_verdict,
        confidence: ai.confidence ?? null,
        reason: ai.ai_reason || '',
        availability: AVAIL,
    };
}

function buildTemporalSignal(step, temporalViolations = []) {
    const violation = temporalViolations.find((v) =>
        v.affectedStep === step.step_id ||
        v.pair_step_from === step.step_id ||
        v.pair_step_to === step.step_id ||
        (v.name && step.name && v.name === step.name)
    );
    const affected = Boolean(violation);
    const severity = violation?.severity || 'NONE';
    const penalty = severity === 'HIGH' ? 5 : severity === 'FATAL' ? 999 : 0;
    return {
        affected,
        severity,
        penalty,
        diffPercent: violation?.diffPercent ?? null,
        pair_step_to: violation?.pair_step_to ?? null,
    };
}

// ─── Step contract builder ────────────────────────────────────────────────────

/**
 * Build step_key from step data.
 * Format: "group_type|name|step_id|value_chosen"
 */
function buildStepKey(step) {
    const parts = [
        step.group_type || 'unknown',
        step.name || '',
        step.step_id ?? 0,
        step.value_chosen || '',
    ];
    return parts.join('|');
}

/**
 * Derive interaction_status: did the mechanical action succeed?
 */
function deriveInteractionStatus(step) {
    if (step.group_type === 'lifecycle') return 'PASS';
    if (step.status === 'ERROR' || (step.message && step.message.startsWith('ERROR:'))) return 'FAIL';
    if (step.is_menu_opener || step.is_label_confirmed) return 'PASS';
    return 'PASS'; // default if no exception
}

/**
 * Derive visual_status from diff/AI signals.
 */
function deriveVisualStatus(step, signals) {
    if (step.is_menu_opener) return 'PASS'; // opener: visual change not expected
    if (step.skip_diff_check) return 'PASS';

    const diff = signals.diff;
    const ai = signals.ai;

    // Diff unavailable AND AI unavailable → truly cannot evaluate
    if (diff.availability === UNAVAIL && ai.availability === UNAVAIL) return UNAVAIL;

    // Explicit code-level FAIL
    if (step.code_evaluation?.status === 'FAIL') return 'FAIL';

    // AI FAIL with high confidence
    if (ai.availability === AVAIL && ai.verdict === 'FAIL' && (ai.confidence ?? 0) >= 0.85) return 'FAIL';

    // Diff is available and zero (not unavailable) → FAIL
    if (diff.availability === AVAIL && diff.score === 0 && !step.skip_diff_check) return 'FAIL';

    // Diff error only → WARNING
    if (diff.availability === UNAVAIL && ai.availability === AVAIL) return ai.verdict === 'PASS' ? 'PASS' : 'WARNING';

    return 'PASS';
}

/**
 * Derive business_status (only relevant for cart step).
 */
function deriveBusinessStatus(step, cartResult) {
    if (step.group_type === 'lifecycle' && (step.action === 'cart' || step.action === 'add_to_cart')) {
        return cartResult?.success ? 'PASS' : 'FAIL';
    }
    return 'N/A';
}

/**
 * Apply the deterministic truth table (Spec Section 3.2).
 */
function applyVerdictTruthTable(interactionStatus, visualStatus, businessStatus) {
    if (interactionStatus === 'FAIL') return 'FAIL';
    if (businessStatus === 'FAIL') return 'FAIL';
    if (visualStatus === 'FAIL') return 'FAIL';
    if (visualStatus === 'UNAVAILABLE') return 'UNAVAILABLE';
    if (interactionStatus === 'WARNING' || visualStatus === 'WARNING' || businessStatus === 'WARNING') return 'WARNING';
    return 'PASS';
}

/**
 * Attach new contract fields to a step object.
 * Call this AFTER the evaluation phase in cli.js.
 */
function enrichStep(step, { temporalViolations = [], cartResult = null } = {}) {
    const signals = buildSignals(step, temporalViolations);
    signals.temporal_impact = buildTemporalSignal(step, temporalViolations);

    let interaction_status, visual_status, business_status, step_verdict;

    if (step.group_type === 'lifecycle') {
        // Special branch for lifecycle steps to avoid visual signal noise
        interaction_status = step.status === 'FAIL' ? 'FAIL' : 'PASS';
        visual_status = 'N/A';
        business_status = 'N/A';

        if (step.action === 'validate_preview') {
            // Priority: explicit step.preview_valid > step.status
            const isValid = typeof step.preview_valid !== 'undefined' ? step.preview_valid : (step.status === 'PASS');
            step_verdict = isValid ? 'PASS' : 'FAIL';
        } else if (step.action === 'add_to_cart') {
            // Priority: explicit step.cart_result > external cartResult > step.status
            const success = typeof step.cart_result !== 'undefined' ? step.cart_result : (cartResult?.success ?? (step.status === 'PASS'));
            step_verdict = success ? 'PASS' : 'FAIL';
            business_status = success ? 'PASS' : 'FAIL';
        } else {
            step_verdict = step.status || 'PASS';
        }
    } else {
        interaction_status = deriveInteractionStatus(step);
        visual_status = deriveVisualStatus(step, signals);
        business_status = deriveBusinessStatus(step, cartResult);
        step_verdict = applyVerdictTruthTable(interaction_status, visual_status, business_status);
    }

    step.step_key = buildStepKey(step);
    step.interaction_status = interaction_status;
    step.visual_status = visual_status;
    step.business_status = business_status;
    step.step_verdict = step_verdict;
    step.signals = signals;

    // Backward compatibility: keep legacy status
    if (!['FATAL', 'ERROR'].includes(step.status)) {
        step.status = step_verdict === 'UNAVAILABLE' ? 'WARNING' : step_verdict;
    }

    return step;
}

/**
 * Normalize completion_result:
 * If calculation had error → return UNAVAILABLE signal, not -1 or 0.
 */
function normalizeCompletionResult(completionResult) {
    if (!completionResult || completionResult.result === 'ERROR') {
        return { availability: UNAVAIL, completionRatio: null, result: 'ERROR' };
    }
    if (typeof completionResult.completionRatio !== 'number' || isNaN(completionResult.completionRatio)) {
        return { availability: UNAVAIL, completionRatio: null, result: 'ERROR' };
    }
    return { ...completionResult, availability: AVAIL };
}

module.exports = {
    buildSignals,
    buildStepKey,
    enrichStep,
    normalizeCompletionResult,
    deriveInteractionStatus,
    deriveVisualStatus,
    deriveBusinessStatus,
    applyVerdictTruthTable,
    AVAIL,
    UNAVAIL,
};
