/**
 * QA Dashboard - JavaScript Controller
 * Handles navigation, data management, rendering, and modal interactions.
 */

(function () {
    'use strict';

    // ============================================================
    // STATE
    // ============================================================
    const state = {
        testCases: loadFromStorage('qa_test_cases') || [],
        testRuns: loadFromStorage('qa_test_runs') || [],
        currentPage: 'dashboard',
        searchQuery: '',
        
        // Filters
        filters: {
            status: 'ALL',
            date: 'ALL'
        },

        products: [], // Crawled products
        selectedProducts: new Set(), // product_id|platform
        selectedTestCases: new Set(), // testCaseId

        // Pagination
        pagination: {
            dashboard: { page: 1, pageSize: 10 },
            testCases: { page: 1, pageSize: 12 },
            products: { page: 1, pageSize: 15 }
        },

        // ✅ Track các test đang chạy
        runningTests: new Map(), // testCaseId -> { runId, startTime }
        activeElements: new Map(), // testCaseId -> { buttonEl, progressEl, originalText }
    };

    // --- Centralized Timer Manager ---
    let timerInterval = null;
    function startGlobalTimer() {
        if (timerInterval) return;
        timerInterval = setInterval(() => {
            const now = Date.now();
            document.querySelectorAll('[data-timer-start]').forEach(el => {
                const startTs = parseInt(el.dataset.timerStart, 10);
                if (startTs) {
                    const normalizedStartTs = startTs < 1e12 ? startTs * 1000 : startTs;
                    const diff = Math.max(0, Math.floor((now - normalizedStartTs) / 1000));
                    el.textContent = formatElapsedSeconds(diff);
                }
            });
        }, 1000);
    }
    startGlobalTimer();

    // ============================================================
    //SSE - Real-time updates
    // ============================================================
    function initSSE() {
        const source = new EventSource('/api/events');

        source.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('[SSE] Received event:', data);

                if (data.event === 'test-started') {
                    handleSSETestStarted(data);
                } else if (data.event === 'test-queued') {
                    handleSSETestQueued(data);
                } else if (data.event === 'test-finished') {
                    handleSSETestFinished(data);
                } else if (data.event === 'crawler-progress') {
                    handleSSECrawlerProgress(data);
                } else if (data.event === 'crawler-finished') {
                    handleSSECrawlerFinished(data);
                }
            } catch (e) {
                console.error('[SSE] Error parsing event data:', e);
            }
        };

        source.onerror = (err) => {
            console.warn('[SSE] connection error, retrying...', err);
        };
    }

    function handleSSETestQueued(data) {
        const { runId, testCaseId, testName } = data;
        
        if (testCaseId) {
            const tc = state.testCases.find(t => t.id === testCaseId);
            if (tc) {
                tc.execution_status = 'QUEUED';
                tc.result_status = '';
                tc.status = 'QUEUED';
            }
        }
})();