/**
 * Rule Registry (POD Auto Test v3.5)
 * Centralized constants for decision making and reason codes.
 */

const RULES = {
    // Decision Labels
    DECISION: {
        PASS_AUTO: 'PASS_AUTO',
        FAIL_AUTO: 'FAIL_AUTO',
        REVIEW: 'REVIEW',
        FATAL: 'FATAL',
    },

    // Reason Codes (Standardized)
    REASONS: {
        // Critical / Infrastructure
        NAV_FAIL: 'NAV_FAIL',
        INTERNAL_ERROR: 'INTERNAL_ERROR',
        CONSENSUS_FATAL: 'CONSENSUS_FATAL',
        
        // Customization Consistency
        TEMPORAL_SEVERE: 'TEMPORAL_SEVERE',
        TEMPORAL_CONFLICT: 'TEMPORAL_CONFLICT',
        
        // Business Fulfillment
        CART_FAIL: 'CART_FAIL',
        CART_WEB_BUG: 'CART_WEB_BUG',
        COMPLETION_LOW: 'COMPLETION_LOW',
        
        // Quality / Visual
        LOW_SCORE: 'LOW_SCORE',
        AI_REJECT: 'AI_REJECT',
        COLOR_VIOLATION: 'COLOR_VIOLATION',
        TEXT_MISMATCH: 'TEXT_MISMATCH',
        PIXEL_DIVERGENCE: 'PIXEL_DIVERGENCE'
    }
};

module.exports = RULES;
