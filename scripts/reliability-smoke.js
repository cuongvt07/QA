#!/usr/bin/env node
/**
 * Reliability Smoke Test — Spec v2.1, §13 Implementation Checklist
 *
 * Runs assertions against an existing report.json to verify the engine
 * invariants before rolling out wider.
 *
 * Usage:
 *   node scripts/reliability-smoke.js <path-to-report.json>
 *   npm run smoke <path-to-report.json>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { computeQualityScore, computeConfidenceScore, makeDecision } = require('../src/core/reliability-engine');
const { enrichStep, normalizeCompletionResult } = require('../src/core/reliability-normalizer');

const reportPath = process.argv[2];
if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(`Usage: node scripts/reliability-smoke.js <path-to-report.json>`);
    process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
const cases = report.cases || [report];

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
        failed++;
    }
}

console.log(`\n🔍 Reliability Smoke Test — ${path.basename(reportPath)}\n`);

for (const [ci, caseReport] of cases.entries()) {
    const label = `Case ${ci + 1} (${caseReport.case_label || 'unknown'})`;
    console.log(`\n── ${label} ─────────────────────────────`);

    const timeline = caseReport.timeline || [];
    const nonLifecycle = timeline.filter(s => s.group_type !== 'lifecycle');

    // Enrich steps (simulating what cli.js does)
    for (const step of timeline) {
        enrichStep(step, { temporalViolations: caseReport.temporal_violations || [] });
    }

    const normCompletion = normalizeCompletionResult(caseReport.completion_result);
    const qr = computeQualityScore(timeline, {
        completionResult: normCompletion,
        cartResult: null,
        temporalViolations: caseReport.temporal_violations || [],
    });
    const cr = computeConfidenceScore(timeline, { qualityResult: qr });
    const dr = makeDecision(qr, cr, { isFatal: caseReport.status === 'FATAL' });

    // ── Invariant 1: quality_score in valid range ──────────────────────────
    assert(
        'quality_score in [0, 100]',
        qr.quality_score >= 0 && qr.quality_score <= 100,
        `Got ${qr.quality_score}`
    );

    // ── Invariant 2: confidence_score in [0, 1] ────────────────────────────
    assert(
        'confidence_score in [0, 1]',
        cr.confidence_score >= 0 && cr.confidence_score <= 1,
        `Got ${cr.confidence_score}`
    );

    // ── Invariant 3: No completion UNAVAILABLE → 0 score (must be removed) ─
    assert(
        'Completion UNAVAILABLE not penalized as 0',
        !(normCompletion.availability === 'UNAVAILABLE' && qr.signal_scores.completion?.score === 0),
        'UNAVAILABLE completion scored as 0 — violates spec §4'
    );

    // ── Invariant 4: decision is one of valid values ───────────────────────
    assert(
        `decision is valid enum: "${dr.decision}"`,
        ['PASS_AUTO', 'FAIL_AUTO', 'REVIEW'].includes(dr.decision)
    );

    // ── Invariant 5: PASS_AUTO requires quality >= 85 AND confidence >= 0.85
    if (dr.decision === 'PASS_AUTO') {
        assert(
            'PASS_AUTO has quality >= 85',
            qr.quality_score >= 85,
            `quality=${qr.quality_score}`
        );
        assert(
            'PASS_AUTO has confidence >= 0.85',
            cr.confidence_score >= 0.85,
            `confidence=${cr.confidence_score}`
        );
    }

    // ── Invariant 6: No diff=-1 should silently map to 0 score ─────────────
    for (const step of nonLifecycle) {
        if (step.diff_score === -1) {
            assert(
                `Step "${step.name}": diff=-1 → signals.diff.availability=UNAVAILABLE`,
                step.signals?.diff?.availability === 'UNAVAILABLE',
                `Got ${step.signals?.diff?.availability}`
            );
        }
    }

    // ── Invariant 7: step_verdict is deterministic from sub-statuses ────────
    for (const step of timeline) {
        if (!step.interaction_status) continue; // not enriched yet = skip
        const { applyVerdictTruthTable } = require('../src/core/reliability-normalizer');
        const expected = applyVerdictTruthTable(
            step.interaction_status,
            step.visual_status,
            step.business_status
        );
        assert(
            `Step "${step.name}": step_verdict deterministic`,
            step.step_verdict === expected,
            `Expected ${expected}, got ${step.step_verdict}`
        );
    }

    // ── Invariant 8: unavailable_weight_ratio > 0.5 caps confidence ─────────
    if (cr.unavailable_weight_ratio > 0.50) {
        assert(
            'UNAVAILABLE dominance caps confidence to <= 0.79',
            cr.confidence_score <= 0.79,
            `Got ${cr.confidence_score}`
        );
    }

    console.log(`  quality=${qr.quality_score}  confidence=${cr.confidence_score}  decision=${dr.decision}`);
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('\n⛔ Reliability smoke test FAILED — do not enable --reliability-v2 in production.\n');
    process.exit(1);
} else {
    console.log('\n✅ All invariants passed — engine is safe to enable.\n');
}
