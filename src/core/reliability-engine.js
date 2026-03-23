/**
 * Reliability Engine — Spec v2.1, Sections 5–8
 *
 * Implements:
 *   - quality_score   (Section 5)
 *   - confidence_score (Section 6)
 *   - consensus aggregation (Section 7)
 *   - force-review from history (Section 8)
 */

'use strict';

const crypto = require('crypto');

// ─── Signal weight table (Spec §5.1) ─────────────────────────────────────────

const SIGNAL_WEIGHTS = {
    deterministic_visual: 0.30,
    ai_semantic:          0.25,
    ocr_text:             0.15,
    color_match:          0.10,
    completion:           0.10,
    cart:                 0.10,
};

const TOTAL_WEIGHT = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);

// ─── Individual signal scorers ────────────────────────────────────────────────

/**
 * Deterministic visual score: per-step diff pass/fail ratio → 0-100.
 */
function scoreDeterministicVisual(timeline) {
    const scorable = timeline.filter(s => s.group_type !== 'lifecycle' && !s.is_menu_opener && !s.skip_diff_check && !s.context_transition);
    if (scorable.length === 0) return { score: 100, availability: 'AVAILABLE' };

    const passed = scorable.filter(s => {
        const vs = s.visual_status || (s.status === 'PASS' ? 'PASS' : 'FAIL');
        return vs === 'PASS';
    }).length;

    const unavail = scorable.filter(s => (s.visual_status || '') === 'UNAVAILABLE').length;
    if (unavail === scorable.length) return { score: null, availability: 'UNAVAILABLE' };

    return { score: (passed / scorable.length) * 100, availability: 'AVAILABLE' };
}

/**
 * AI semantic score: pass ratio of available AI verdicts → 0-100.
 */
function shouldIgnoreSemanticAiFail(step) {
    if (!step || step.group_type !== 'image_option') return false;
    if (step.ai_semantic_untrusted) return true;
    if (step.option_color_source !== 'semantic-label') return false;
    if (step.color_audit_applicable !== false) return false;
    if (step.code_evaluation?.status !== 'PASS') return false;
    return Boolean(step.meaningful_change) || (step.diff_score ?? 0) >= 0.5;
}

function scoreAiSemantic(timeline) {
    const aiSteps = timeline.filter(s =>
        !shouldIgnoreSemanticAiFail(s) && (
            s.signals?.ai?.availability === 'AVAILABLE' ||
            (s.ai_evaluation && !['ERROR', 'DISABLED', 'SKIPPED', 'PENDING'].includes(s.ai_evaluation.ai_verdict))
        )
    );
    if (aiSteps.length === 0) return { score: null, availability: 'UNAVAILABLE' };

    const passed = aiSteps.filter(s => {
        const verdict = s.signals?.ai?.verdict || s.ai_evaluation?.ai_verdict;
        return verdict === 'PASS';
    }).length;

    return { score: (passed / aiSteps.length) * 100, availability: 'AVAILABLE' };
}

function getExpectedTextTokenLength(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .length;
}

function hasStrongAiTextRescue(step) {
    if (!step || step.group_type !== 'text_input') return false;
    const ai = step.signals?.ai || step.ai_evaluation;
    if (!ai) return false;

    const verdict = ai.verdict || ai.ai_verdict;
    const confidence = ai.confidence ?? 0;
    if (verdict !== 'PASS' || confidence < 0.9) return false;
    if (ai.bbox_correct === false) return false;

    return Boolean(step.meaningful_change) || (step.diff_score ?? 0) > 0.01;
}

function getOcrStepScore(ocr, step) {
    if (!ocr?.found) {
        return hasStrongAiTextRescue(step) ? 88 : 0;
    }

    const detail = String(ocr.matchDetail || '');
    const tokenLength = getExpectedTextTokenLength(step.value_chosen);

    if (/exact match found/i.test(detail)) return 90;
    if (/fuzzy match found/i.test(detail) && tokenLength > 0 && tokenLength <= 8) return 80;

    const conf = ocr.confidence ?? 0;
    if (conf >= 70) return 100;
    if (conf >= 50) return 75;

    const aiPass = step.signals?.ai?.verdict === 'PASS' || step.ai_evaluation?.ai_verdict === 'PASS';
    const diffOk = (step.diff_score ?? -1) > 0.01;
    return (aiPass && diffOk) ? 72 : 40;
}

/**
 * OCR text score per Spec §5.2.1.
 */
function scoreOcr(timeline) {
    const ocrSteps = timeline.filter(s => s.group_type === 'text_input');
    if (ocrSteps.length === 0) return { score: null, availability: 'UNAVAILABLE' };

    let total = 0;
    let counted = 0;

    for (const step of ocrSteps) {
        const ocr = step.signals?.ocr || step.ocr_evaluation;
        if (!ocr || ocr.availability === 'UNAVAILABLE') continue; // exclude from denominator
        counted++;
        total += getOcrStepScore(ocr, step);
    }

    if (counted === 0) return { score: null, availability: 'UNAVAILABLE' };
    return { score: total / counted, availability: 'AVAILABLE' };
}

/**
 * Color match score per Spec §5.2.2.
 */
function scoreColor(timeline) {
    const colorSteps = timeline.filter(s => s.color_evaluation || s.signals?.color);
    if (colorSteps.length === 0) return { score: null, availability: 'UNAVAILABLE' };

    let total = 0;
    let counted = 0;

    for (const step of colorSteps) {
        const color = step.signals?.color || step.color_evaluation;
        if (!color || color.availability === 'UNAVAILABLE') continue;
        if (color.result === 'SKIPPED' || color.result === 'UNAVAILABLE') continue;
        counted++;

        if (color.result === 'PASS') {
            total += 100;
        } else if (color.result === 'FAIL') {
            total += 0;
        } else if (color.result === 'ERROR') {
            if (color.fallback_used) {
                total += 70; // fallback PASS (AI/diff corroborated) → 70
            } else {
                // no fallback → UNAVAILABLE (exclude)
                counted--;
            }
        }
    }

    if (counted === 0) return { score: null, availability: 'UNAVAILABLE' };
    return { score: total / counted, availability: 'AVAILABLE' };
}

/**
 * Completion score per Spec §5.2.3.
 */
function scoreCompletion(completionResult) {
    if (!completionResult || completionResult.availability === 'UNAVAILABLE' || completionResult.result === 'ERROR') {
        return { score: null, availability: 'UNAVAILABLE' };
    }
    const r = completionResult.completionRatio;
    if (typeof r !== 'number') return { score: null, availability: 'UNAVAILABLE' };
    return { score: Math.max(0, Math.min(100, r * 100)), availability: 'AVAILABLE' };
}

/**
 * Cart score per Spec §5.2.4.
 */
function scoreCart(cartResult) {
    if (!cartResult) return { score: null, availability: 'UNAVAILABLE', hardFail: false };
    if (cartResult.success) return { score: 100, availability: 'AVAILABLE', hardFail: false };
    return { score: 0, availability: 'AVAILABLE', hardFail: true };
}

// ─── Temporal penalty (Spec §5.3) ─────────────────────────────────────────────

function computeTemporalPenalty(temporalViolations = []) {
    const hasFatal = temporalViolations.some(v => v.severity === 'FATAL');
    if (hasFatal) return { penalty: 0, hardFail: true };

    const highSteps = new Set(
        temporalViolations.filter(v => v.severity === 'HIGH').map(v => v.affectedStep)
    );
    return { penalty: Math.min(highSteps.size * 5, 15), hardFail: false };
}

// ─── quality_score (Spec §5.2) ────────────────────────────────────────────────

function computeQualityScore(timeline, { completionResult, cartResult, temporalViolations = [] } = {}) {
    const signals = {
        deterministic_visual: scoreDeterministicVisual(timeline),
        ai_semantic:          scoreAiSemantic(timeline),
        ocr_text:             scoreOcr(timeline),
        color_match:          scoreColor(timeline),
        completion:           scoreCompletion(completionResult),
        cart:                 scoreCart(cartResult),
    };

    const { penalty, hardFail: temporalHardFail } = computeTemporalPenalty(temporalViolations);
    const cartHardFail = signals.cart.hardFail && cartResult && !cartResult.success;

    // Renormalize: only AVAILABLE signals
    let weightedSum = 0;
    let totalAvailWeight = 0;

    for (const [key, sig] of Object.entries(signals)) {
        if (sig.availability !== 'AVAILABLE') continue;
        const w = SIGNAL_WEIGHTS[key] || 0;
        weightedSum += sig.score * w;
        totalAvailWeight += w;
    }

    let qualityScore = totalAvailWeight > 0
        ? (weightedSum / totalAvailWeight)
        : 0;

    qualityScore = Math.max(0, Math.min(100, qualityScore - penalty));

    return {
        quality_score: Math.round(qualityScore * 10) / 10,
        signal_scores: signals,
        temporal_penalty: penalty,
        hard_fail: temporalHardFail || cartHardFail,
        cart_hard_fail: cartHardFail,
        temporal_hard_fail: temporalHardFail,
    };
}

// ─── confidence_score (Spec §6) ───────────────────────────────────────────────

function computeConfidenceScore(timeline, { qualityResult, pipelineErrors = {} } = {}) {
    const signals = qualityResult?.signal_scores || {};

    // 6.1 coverage
    let availableWeight = 0;
    let unavailableWeight = 0;
    for (const [key, sig] of Object.entries(signals)) {
        const w = SIGNAL_WEIGHTS[key] || 0;
        if (sig.availability === 'AVAILABLE') availableWeight += w;
        else unavailableWeight += w;
    }
    const coverage = TOTAL_WEIGHT > 0 ? availableWeight / TOTAL_WEIGHT : 0;
    const unavailableWeightRatio = TOTAL_WEIGHT > 0 ? unavailableWeight / TOTAL_WEIGHT : 1;

    // 6.2 agreement — pairwise matrix between available verdict outcomes
    const verdicts = [];
    if (signals.deterministic_visual?.availability === 'AVAILABLE') {
        verdicts.push(signals.deterministic_visual.score >= 70 ? 'PASS' : 'FAIL');
    }
    if (signals.ai_semantic?.availability === 'AVAILABLE') {
        verdicts.push(signals.ai_semantic.score >= 70 ? 'PASS' : 'FAIL');
    }
    if (signals.ocr_text?.availability === 'AVAILABLE') {
        verdicts.push(signals.ocr_text.score >= 65 ? 'PASS' : 'FAIL');
    }
    if (signals.color_match?.availability === 'AVAILABLE') {
        verdicts.push(signals.color_match.score >= 70 ? 'PASS' : 'FAIL');
    }

    const agreement = computeAgreement(verdicts);

    // 6.3 stability proxy
    const nonLifecycle = timeline.filter(s => s.group_type !== 'lifecycle');
    const totalScored = nonLifecycle.length;
    const warningSteps = nonLifecycle.filter(s => s.visual_status === 'WARNING').length;
    const unavailSteps = nonLifecycle.filter(s => s.visual_status === 'UNAVAILABLE').length;
    const stabilityProxy = totalScored > 0
        ? Math.max(0, Math.min(1, 1 - (warningSteps + unavailSteps) / totalScored))
        : 1;

    // 6.4 pipeline_health
    const critical = pipelineErrors.critical || 0;
    const noncritical = pipelineErrors.noncritical || 0;
    const pipelineHealth = 1 - Math.min(critical * 0.12 + noncritical * 0.05, 1.0);

    // Composite
    let confidenceScore = 0.35 * coverage + 0.30 * agreement + 0.25 * stabilityProxy + 0.10 * pipelineHealth;

    const allNonLifecyclePass = nonLifecycle.length > 0 && nonLifecycle.every((s) => s.status === 'PASS');
    const deterministicStrong = signals.deterministic_visual?.availability === 'AVAILABLE' && (signals.deterministic_visual.score ?? 0) >= 95;
    const aiSupportStrong = signals.ai_semantic?.availability !== 'AVAILABLE' || (signals.ai_semantic.score ?? 0) >= 80;
    const ocrSupportStrong = signals.ocr_text?.availability !== 'AVAILABLE' || (signals.ocr_text.score ?? 0) >= 80;
    const colorSupportStrong = signals.color_match?.availability !== 'AVAILABLE' || (signals.color_match.score ?? 0) >= 70;
    const completionStrong = signals.completion?.availability !== 'AVAILABLE' || (signals.completion.score ?? 0) >= 95;
    const cartStrong = signals.cart?.availability === 'AVAILABLE' && (signals.cart.score ?? 0) >= 100 && !signals.cart.hardFail;
    const noTemporalPenalty = (qualityResult?.temporal_penalty ?? 0) === 0 && !qualityResult?.temporal_hard_fail;
    const cleanRunPromotionEligible = Boolean(
        allNonLifecyclePass
        && deterministicStrong
        && aiSupportStrong
        && ocrSupportStrong
        && colorSupportStrong
        && completionStrong
        && cartStrong
        && noTemporalPenalty
        && pipelineHealth >= 0.9
        && coverage >= 0.55
    );
    let cleanRunPromotionApplied = false;
    if (cleanRunPromotionEligible && confidenceScore < 0.85) {
        confidenceScore = Math.min(0.89, Math.max(confidenceScore + 0.05, 0.86));
        cleanRunPromotionApplied = true;
    }

    // 6.5 UNAVAILABLE cap
    if (unavailableWeightRatio > 0.50) {
        confidenceScore = Math.min(confidenceScore, 0.79);
    }

    return {
        confidence_score: Math.round(confidenceScore * 1000) / 1000,
        coverage,
        agreement,
        stability_proxy: stabilityProxy,
        pipeline_health: pipelineHealth,
        unavailable_weight_ratio: unavailableWeightRatio,
        clean_run_promotion_eligible: cleanRunPromotionEligible,
        clean_run_promotion_applied: cleanRunPromotionApplied,
    };
}

function computeAgreement(verdicts) {
    if (verdicts.length === 0) return 0.6;
    if (verdicts.length === 1) return 0.6;

    const pairScoreMatrix = {
        'PASS:PASS': 1.0,
        'FAIL:FAIL': 1.0,
        'WARNING:PASS': 0.5, 'PASS:WARNING': 0.5,
        'WARNING:FAIL': 0.5, 'FAIL:WARNING': 0.5,
        'WARNING:WARNING': 0.6,
        'PASS:FAIL': 0.0,   'FAIL:PASS': 0.0,
    };

    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < verdicts.length; i++) {
        for (let j = i + 1; j < verdicts.length; j++) {
            const key = `${verdicts[i]}:${verdicts[j]}`;
            const score = pairScoreMatrix[key];
            if (score !== undefined) {
                sum += score;
                pairs++;
            }
        }
    }

    return pairs > 0 ? sum / pairs : 0.6;
}

// ─── Decision (Spec §7.4) ─────────────────────────────────────────────────────

const DECISION_REASON = {
    HIGH_COVERAGE: 'HIGH_COVERAGE',
    HIGH_AGREEMENT: 'HIGH_AGREEMENT',
    HARD_FAIL: 'HARD_FAIL',
    TEMPORAL_FATAL: 'TEMPORAL_FATAL',
    CART_FAIL: 'CART_FAIL',
    PREVIEW_FAIL: 'PREVIEW_FAIL',
    LOW_CONFIDENCE: 'LOW_CONFIDENCE',
    UNAVAILABLE_DOMINANT: 'UNAVAILABLE_DOMINANT',
    PERSISTENT_LOW_CONFIDENCE: 'PERSISTENT_LOW_CONFIDENCE',
    FORCE_REVIEW: 'FORCE_REVIEW',
    CLEAN_RUN_PROMOTION: 'CLEAN_RUN_PROMOTION',
};

function makeDecision(qualityResult, confidenceResult, { isFatal = false, forceReview = false } = {}) {
    const q = qualityResult.quality_score;
    const c = confidenceResult.confidence_score;
    const reasons = [];

    if (forceReview) {
        return { decision: 'REVIEW', reasons: [DECISION_REASON.FORCE_REVIEW] };
    }

    // ─── P0 Consensus Gating Logic ───────────────────────────────────────────
    const hasCartHardFail = qualityResult.cart_hard_fail;
    const hasTemporalHardFail = qualityResult.temporal_hard_fail;
    
    // Core Business Signals (PASS if >= 80)
    const isAiPass = (qualityResult.signal_scores?.ai_semantic?.score ?? 0) >= 80;
    const isDeterministicStrong = (qualityResult.signal_scores?.deterministic_visual?.score ?? 0) >= 80;
    const isCompletionPass = (qualityResult.signal_scores?.completion?.score ?? 0) >= 90;
    const isCartPass = !hasCartHardFail;

    if (isFatal || hasCartHardFail) {
        reasons.push(DECISION_REASON.HARD_FAIL);
        if (hasCartHardFail) reasons.push(DECISION_REASON.CART_FAIL);
        return { decision: 'FAIL_AUTO', reasons };
    }

    if (hasTemporalHardFail) {
        reasons.push(DECISION_REASON.TEMPORAL_FATAL);
        
        // Downgrade to REVIEW if other core signals are strong (Consensus Gating)
        if ((isAiPass || isDeterministicStrong) && isCompletionPass && isCartPass) {
            return { decision: 'REVIEW', reasons: [...reasons, 'TEMPORAL_CONFLICT'] };
        } else {
            return { decision: 'FAIL_AUTO', reasons: [...reasons, 'CONSENSUS_FATAL'] };
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (confidenceResult.unavailable_weight_ratio > 0.50) {
        reasons.push(DECISION_REASON.UNAVAILABLE_DOMINANT);
        return { decision: 'REVIEW', reasons };
    }

    if (q >= 85 && c >= 0.85) {
        if (confidenceResult.clean_run_promotion_applied) reasons.push(DECISION_REASON.CLEAN_RUN_PROMOTION);
        if (confidenceResult.coverage >= 0.70) reasons.push(DECISION_REASON.HIGH_COVERAGE);
        if (confidenceResult.agreement >= 0.80) reasons.push(DECISION_REASON.HIGH_AGREEMENT);
        return { decision: 'PASS_AUTO', reasons };
    }

    if (q < 60 && c >= 0.85) { // Adjusted from 70 to 60 for more conservative FAIL_AUTO
        return { decision: 'FAIL_AUTO', reasons };
    }

    reasons.push(DECISION_REASON.LOW_CONFIDENCE);
    return { decision: 'REVIEW', reasons };
}

// ─── Test input signature (Spec §7.1) ─────────────────────────────────────────

function computeInputSignature(productUrl, optionIndex = 0, seed = '', dataProfileVersion = '1') {
    const raw = `${productUrl}|${optionIndex}|${seed}|${dataProfileVersion}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// ─── Consensus (Spec §7.2–7.3) ────────────────────────────────────────────────

/**
 * Aggregate existing run results into consensus.
 * @param {Array} runs  Array of { quality_score, confidence_score, decision }
 */
function computeConsensus(runs) {
    if (!runs || runs.length === 0) return null;

    // Weighted quality: §7.3
    const sumWeights = runs.reduce((s, r) => s + (r.confidence_score || 0), 0);
    const consensusQuality = sumWeights > 0
        ? runs.reduce((s, r) => s + (r.quality_score || 0) * (r.confidence_score || 0), 0) / sumWeights
        : runs.reduce((s, r) => s + (r.quality_score || 0), 0) / runs.length;

    // Decision vote weights
    const decisionWeights = {};
    for (const run of runs) {
        const d = run.decision || 'REVIEW';
        decisionWeights[d] = (decisionWeights[d] || 0) + (run.confidence_score || 0);
    }
    const totalDecisionWeight = Object.values(decisionWeights).reduce((s, w) => s + w, 0);
    const maxDecision = Object.entries(decisionWeights).sort((a, b) => b[1] - a[1])[0];
    const consensusConfidence = totalDecisionWeight > 0 ? (maxDecision[1] / totalDecisionWeight) : 0;

    const needsReview = runs.length >= 3 && consensusConfidence < 0.85;

    return {
        runs_used: runs.length,
        consensus_quality: Math.round(consensusQuality * 10) / 10,
        consensus_confidence: Math.round(consensusConfidence * 1000) / 1000,
        leading_decision: maxDecision[0],
        needs_review: needsReview,
        reason_code: needsReview ? 'PERSISTENT_LOW_CONFIDENCE' : null,
    };
}

// ─── Force-REVIEW disagreement (Spec §8) ─────────────────────────────────────

/**
 * Compute disagreement rate from last N auto-decisions.
 * Returns force_review=true if rule triggers.
 */
function checkForceReview(recentDecisions) {
    const autoDec = (recentDecisions || []).filter(d => d === 'PASS_AUTO' || d === 'FAIL_AUTO');
    if (autoDec.length < 4) return { force_review: false, disagreement_rate: 0 };

    // Use last 5 only
    const window = autoDec.slice(-5);
    const passCount = window.filter(d => d === 'PASS_AUTO').length;
    const failCount = window.filter(d => d === 'FAIL_AUTO').length;
    const rate = Math.min(passCount, failCount) / Math.max(passCount + failCount, 1);

    return {
        force_review: rate > 0.30,
        disagreement_rate: Math.round(rate * 1000) / 1000,
        pass_count: passCount,
        fail_count: failCount,
    };
}

// ─── Pipeline error counting helpers ─────────────────────────────────────────

/**
 * Count critical and non-critical technical errors from timeline.
 */
function countPipelineErrors(timeline, errorSummary = {}) {
    let critical = 0;
    let noncritical = 0;

    for (const step of timeline) {
        if (step.group_type !== 'lifecycle') {
            if (step.diff_score === -1) critical++;  // diff parser failure
            if (step.diff_error) critical++;
        }
        if (step.ai_evaluation?.ai_verdict === 'ERROR') noncritical++;
        if (step.ocr_evaluation?.error) noncritical++;
    }

    // De-duplicate
    const jsBlocking = (errorSummary.jsErrors || []).filter(e =>
        /cart|checkout|add to cart|customily/i.test(e.message || '')
    ).length;
    critical += jsBlocking;

    return { critical: Math.min(critical, 10), noncritical: Math.min(noncritical, 20) };
}

module.exports = {
    computeQualityScore,
    computeConfidenceScore,
    computeAgreement,
    computeTemporalPenalty,
    makeDecision,
    computeConsensus,
    computeInputSignature,
    checkForceReview,
    countPipelineErrors,
    SIGNAL_WEIGHTS,
    DECISION_REASON,
};
