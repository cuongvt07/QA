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

        // âœ… Track cÃ¡c test Ä‘ang cháº¡y
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
        const runIdStr = String(runId || '');
        const testCaseKey = String(testCaseId || '');

        if (testCaseId) {
            const tc = state.testCases.find(t => String(t.id) === testCaseKey);
            if (tc) {
                tc.execution_status = 'QUEUED';
                tc.result_status = '';
                tc.status = 'QUEUED';
            }
        }

        const existingRun = state.testRuns.find(r => String(r.id) === runIdStr);
        if (existingRun) {
            existingRun.execution_status = 'QUEUED';
            existingRun.result_status = '';
            existingRun.status = 'QUEUED';
            if (!existingRun._startTimestamp) existingRun._startTimestamp = Date.now();
        } else {
            upsertRun({
                id: runId,
                test_case_id: testCaseId,
                name: testName,
                status: 'QUEUED',
                execution_status: 'QUEUED',
                result_status: '',
                started_at: null,
                _startTimestamp: Date.now()
            });
        }

        saveToStorage('qa_test_runs', state.testRuns);
        saveToStorage('qa_test_cases', state.testCases);

        if (state.currentPage === 'dashboard') renderDashboard();
        if (state.currentPage === 'test-cases') renderTestCases();
    }

    function handleSSETestStarted(data) {
        const { runId, testCaseId, testName } = data;
        const runIdStr = String(runId || '');
        const testCaseKey = String(testCaseId || '');

        // Cáº­p nháº­t state náº¿u cáº§n
        if (testCaseId) {
            const tc = state.testCases.find(t => String(t.id) === testCaseKey);
            if (tc) {
                tc.execution_status = 'RUNNING';
                tc.result_status = '';
                tc.status = 'RUNNING';
            }
        }

        // Cáº­p nháº­t hoáº·c táº¡o run
        const existingRun = state.testRuns.find(r => String(r.id) === runIdStr);
        if (existingRun) {
            existingRun.status = 'RUNNING';
            existingRun.execution_status = 'RUNNING';
            existingRun.result_status = '';
            if (!existingRun.started_at) existingRun.started_at = new Date().toISOString();
            if (!existingRun._startTimestamp) existingRun._startTimestamp = Date.now();
        } else {
            upsertRun({
                id: runId,
                test_case_id: testCaseId,
                name: testName,
                status: 'RUNNING',
                execution_status: 'RUNNING',
                result_status: '',
                started_at: new Date().toISOString(),
                _startTimestamp: Date.now()
            });
        }

        state.runningTests.set(testCaseKey || runIdStr, { runId: runIdStr || runId, startTime: Date.now() });

        saveToStorage('qa_test_runs', state.testRuns);
        saveToStorage('qa_test_cases', state.testCases);

        // Render láº¡i UI
        if (state.currentPage === 'dashboard') renderDashboard();
        if (state.currentPage === 'test-cases') renderTestCases();
    }

    async function handleSSETestFinished(data) {
        const { runId, testCaseId, status } = data;
        const runIdStr = String(runId || '');
        const testCaseKey = String(testCaseId || '');
        const stateKey = testCaseKey || runIdStr;
        const terminalStatus = normalizeRunStatus(status);
        const isBusinessStatus = ['PASS', 'FAIL', 'FATAL', 'REVIEW'].includes(terminalStatus);

        state.runningTests.delete(stateKey);
        if (runIdStr) state.runningTests.delete(runIdStr);

        // Dá»n dáº¹p UI náº¿u cÃ³ lÆ°u trong Map
        const elements = state.activeElements.get(stateKey) || state.activeElements.get(runIdStr);
        if (elements) {
            if (elements.progressEl) elements.progressEl.remove();
            if (elements.buttonEl) {
                elements.buttonEl.innerHTML = elements.originalText;
                elements.buttonEl.disabled = false;
            }
            state.activeElements.delete(stateKey);
            if (runIdStr) state.activeElements.delete(runIdStr);
        }

        const existingRun = state.testRuns.find((r) => String(r.id) === runIdStr);
        if (existingRun) {
            existingRun.status = terminalStatus || 'FINISHED';
            existingRun.execution_status = ['FAILED', 'RUNNING', 'QUEUED'].includes(terminalStatus)
                ? terminalStatus
                : 'FINISHED';
            if (isBusinessStatus) {
                existingRun.result_status = terminalStatus;
                existingRun.report_status = terminalStatus;
            } else if (terminalStatus === 'COMPLETED' && !existingRun.result_status) {
                existingRun.result_status = 'PASS';
            } else if (terminalStatus === 'FAILED' && !existingRun.result_status) {
                existingRun.result_status = 'FAIL';
            }
            existingRun.finished_at = new Date().toISOString();
            delete existingRun._startTimestamp;
        }

        // Cáº­p nháº­t tráº¡ng thÃ¡i test case
        if (testCaseId) {
            const tc = state.testCases.find(t => String(t.id) === testCaseKey);
            if (tc) {
                tc.execution_status = 'FINISHED';
                tc.result_status = isBusinessStatus ? terminalStatus : (terminalStatus === 'COMPLETED' ? 'PASS' : 'FAIL');
                tc.status = tc.result_status;
                delete tc._startTimestamp;
            }
        }

        saveToStorage('qa_test_runs', state.testRuns);
        saveToStorage('qa_test_cases', state.testCases);

        // Fetch detail cá»§a run nÃ y Ä‘á»ƒ láº¥y Ä‘áº§y Ä‘á»§ info
        await fetchRunDetailById(runId);

        // Render láº¡i UI
        if (state.currentPage === 'dashboard') renderDashboard();
        if (state.currentPage === 'test-cases') renderTestCases();
        if (state.currentPage === 'history') renderHistory();
    }

    // ============================================================
    // DOM REFERENCES
    // ============================================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const pageTitle = $('#page-title');
    const navItems = $$('.nav-item');
    const pages = $$('.page');

    function initFilters() {
        const statusFilter = $('#filter-status');
        const dateFilter = $('#filter-date');

        if (statusFilter) {
            statusFilter.addEventListener('change', (e) => {
                state.filters.status = e.target.value;
                refreshCurrentPage();
            });
        }

        if (dateFilter) {
            dateFilter.addEventListener('change', (e) => {
                state.filters.date = e.target.value;
                refreshCurrentPage();
            });
        }

        const searchInput = $('#search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                state.searchQuery = e.target.value.toLowerCase();
                refreshCurrentPage();
            });
        }
    }
    initFilters();

    function refreshCurrentPage() {
        if (state.currentPage === 'dashboard') renderDashboard();
        if (state.currentPage === 'test-cases') renderTestCases();
        if (state.currentPage === 'history') renderHistory();
        if (state.currentPage === 'products') renderProducts();
    }

    function getFilteredRuns(runs) {
        return runs.filter(run => {
            // 1. Search Query
            const query = state.searchQuery;
            if (query) {
                const searchStr = `${run.name || ''} ${run.report_code || ''} ${run.tc_code || ''} ${run.product_url || ''} ${run.url || ''}`.toLowerCase();
                if (!searchStr.includes(query)) return false;
            }

            // 2. Status Filter
            const filterStatus = state.filters.status;
            if (filterStatus !== 'ALL') {
                const normStatus = normalizeRunStatus(run.status);
                if (normStatus !== filterStatus) return false;
            }

            // 3. Date Filter
            const filterDate = state.filters.date;
            if (filterDate !== 'ALL') {
                const runDate = new Date(getRunTimeIso(run));
                const now = new Date();
                const diffTime = now - runDate;
                const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

                if (filterDate === 'TODAY') {
                    if (now.toDateString() !== runDate.toDateString()) return false;
                } else if (filterDate === 'YESTERDAY') {
                    const yesterday = new Date();
                    yesterday.setDate(now.getDate() - 1);
                    if (yesterday.toDateString() !== runDate.toDateString()) return false;
                } else if (filterDate === 'WEEK') {
                    if (diffDays > 7) return false;
                }
            }

            return true;
        });
    }

    const modalNewTest = $('#modal-new-test');
    const modalDetail = $('#modal-detail');

    // ============================================================
    // NAVIGATION
    // ============================================================
    navItems.forEach((item) => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const pageName = item.dataset.page;
            switchPage(pageName);
        });
    });

    function switchPage(pageName) {
        state.currentPage = pageName;

        navItems.forEach((n) => n.classList.remove('active'));
        const activeNav = $(`[data-page="${pageName}"]`);
        if (activeNav) activeNav.classList.add('active');

        pages.forEach((p) => p.classList.remove('active'));
        const activePage = $(`#page-${pageName}`);
        if (activePage) activePage.classList.add('active');

        const titles = {
            'dashboard': 'Dashboard',
            'test-cases': 'Test Cases',
            'history': 'History',
            'products': 'Product Crawler',
            'settings': 'Settings',
        };
        pageTitle.textContent = titles[pageName] || 'Dashboard';

        // âœ… CHá»ˆ sync khi chuyá»ƒn Ä‘áº¿n trang cáº§n dá»¯ liá»‡u Má»šI
        // KHÃ”NG sync khi ngÆ°á»i dÃ¹ng Ä‘ang á»Ÿ trang Ä‘Ã³ vÃ  test Ä‘ang cháº¡y
        const needsSync = (pageName === 'dashboard' || pageName === 'test-cases' || pageName === 'history');
        const hasRunningTests = state.runningTests.size > 0;

        if (needsSync && !hasRunningTests) {
            // Chá»‰ sync náº¿u KHÃ”NG cÃ³ test nÃ o Ä‘ang cháº¡y
            syncAllFromApi({ render: true });
        } else if (needsSync) {
            // Náº¿u cÃ³ test Ä‘ang cháº¡y, chá»‰ render láº¡i vá»›i data hiá»‡n cÃ³
            if (pageName === 'dashboard') renderDashboard();
            else if (pageName === 'test-cases') renderTestCases();
            else if (pageName === 'history') renderHistory();
        } else if (pageName === 'products') {
            fetchProducts(true);
        }
    }

    // ============================================================
    // NEW TEST MODAL
    // ============================================================
    $('#btn-new-test').addEventListener('click', () => {
        modalNewTest.style.display = 'flex';
        const inputProductUrl = $('#input-product-url');
        if (inputProductUrl) {
            inputProductUrl.value = '';
            inputProductUrl.focus();
        }
    });

    $('#btn-close-modal').addEventListener('click', closeNewTestModal);
    $('#btn-cancel-modal').addEventListener('click', closeNewTestModal);

    modalNewTest.addEventListener('click', (e) => {
        if (e.target === modalNewTest) closeNewTestModal();
    });

    function closeNewTestModal() {
        modalNewTest.style.display = 'none';
    }

    $('#btn-submit-test').addEventListener('click', async () => {
        const url = $('#input-product-url').value.trim();

        if (!url) {
            await showPopup({
                title: 'Invalid Input',
                message: 'Please enter a Product URL.',
                okText: 'Understood'
            });
            return;
        }

        try {
            const res = await Auth.fetch('/api/test-cases', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to create test case');
            }

            await syncAllFromApi({ render: true });
            closeNewTestModal();
            switchPage('test-cases');
        } catch (error) {
            await showPopup({
                title: 'Creation Failed',
                message: 'Create test case failed: ' + error.message,
                okText: 'Dismiss'
            });
        }
    });

    // ============================================================
    // RESET ALL DATA
    // ============================================================
    async function callResetAllApi() {
        const endpointCandidates = [
            { path: '/api/reset-all', method: 'POST' },
            { path: '/api/reset-all', method: 'DELETE' },
            { path: '/api/reports-all', method: 'DELETE' }, // legacy dashboard/backend
            { path: '/api/reports-all', method: 'POST' },   // fallback when DELETE is blocked
        ];

        // Always try relative first, then fall back to absolute loopback if hosted on different port
        const baseCandidates = ['', 'http://localhost:8090', 'http://127.0.0.1:8090'];

        const errors = [];

        for (const baseUrl of baseCandidates) {
            for (const candidate of endpointCandidates) {
                const url = `${baseUrl}${candidate.path}`;
                try {
                    const res = await Auth.fetch(url, { method: candidate.method });
                    if (res.ok) {
                        return;
                    }

                    let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
                    try {
                        const text = await res.text();
                        try {
                            const payload = JSON.parse(text);
                            if (payload && payload.error) errorMsg = payload.error;
                        } catch (err) {
                            if (text && text.includes('<html')) {
                                errorMsg += ` (Returned HTML unexpectedly. Are you on the right port?)`;
                            } else {
                                errorMsg += ` (${text.slice(0, 50)})`;
                            }
                        }
                    } catch (_) {
                        // Ignore body reading errors
                    }
                    errors.push(`${candidate.method} ${url} -> ${errorMsg}`);
                } catch (error) {
                    errors.push(`${candidate.method} ${url} -> ${error.message}`);
                }
            }
        }

        const firstError = errors[0] || 'Unable to reach reset API';
        const err = new Error(firstError);
        err.details = errors;
        throw err;
    }

    $('#btn-reset-all').addEventListener('click', async () => {
        const confirmed = await showPopup({
            title: 'System Reset',
            message: 'Warning: Are you sure you want to reset the ENTIRE system?<br><br>This will permanently delete:<br>- All test cases<br>- All test runs<br>- All report files on the server<br><br>This action <b>CANNOT</b> be undone.',
            okText: 'RESET EVERYTHING',
            cancelText: 'Cancel',
            isConfirm: true
        });

        if (!confirmed) return;

        try {
            await callResetAllApi();
        } catch (e) {
            console.error('Error calling reset API:', e);
            if (Array.isArray(e.details)) {
                console.error('Reset API attempts:', e.details);
            }
            await showPopup({
                title: 'Reset Failed',
                message: 'Reset failed: ' + e.message,
                okText: 'OK'
            });
            return;
        }

        // Clear all local storage data
        localStorage.removeItem('qa_test_cases');
        localStorage.removeItem('qa_test_runs');

        // Success notification and reload
        await showPopup({
            title: 'System Reset',
            message: 'System has been reset successfully.',
            okText: 'Reload Now'
        });
        location.reload();
    });

    // ============================================================
    // SEARCH FILTER
    // ============================================================
    const searchInput = $('#search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.searchQuery = e.target.value.toLowerCase().trim();
            if (state.currentPage === 'dashboard') renderDashboard();
            else if (state.currentPage === 'test-cases') renderTestCases();
            else if (state.currentPage === 'history') renderHistory();
        });
    }

    // ============================================================
    // IMPORT REPORT FROM FILE
    // ============================================================
    $('#btn-import-report').addEventListener('click', () => {
        $('#import-report-input').click();
    });

    $('#import-report-input').addEventListener('change', (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        Array.from(files).forEach((file) => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const report = JSON.parse(ev.target.result);
                    importReport(report);
                } catch (err) {
                    showPopup({
                        title: 'Import Error',
                        message: 'Invalid JSON file: ' + err.message
                    });
                }
            };
            reader.readAsText(file);
        });

        // Reset input so same file can be re-imported
        e.target.value = '';
    });

    function importReport(report) {
        const run = {
            id: report.test_case_index !== undefined
                ? `imported_${report.test_case_index}_${Date.now()}`
                : generateId(),
            name: report.test_case_label || extractProductName(report.product_url || ''),
            url: report.product_url || '',
            test_time: report.test_time || new Date().toISOString(),
            status: report.status || 'FAIL',
            score: report.score || 0,
            code_score: report.code_score || 0,
            ai_score: report.ai_score || -1,
            duration_ms: report.duration_ms || 0,
            total_steps: report.total_steps || 0,
            passed_steps: report.passed_steps || 0,
            failed_steps: report.failed_steps || 0,
            timeline: report.timeline || [],
            cases: report.cases || [],
            total_cases: report.total_cases || 0,
            passed_cases: report.passed_cases || 0,
            tc_code: report.tc_code || report.qa_code || '',
            final_evaluation: report.final_evaluation || {},
            source: 'imported',
        };

        state.testRuns.push(run);
        saveToStorage('qa_test_runs', state.testRuns);
        renderDashboard();
        showPopup({
            title: 'Import Success',
            message: `<b>Imported:</b> ${escapeHtml(run.name)} (${run.total_steps} steps)`
        });
    }

    // ============================================================
    // DETAIL MODAL
    // ============================================================
    $('#btn-close-detail').addEventListener('click', closeDetailModal);
    modalDetail.addEventListener('click', (e) => {
        if (e.target === modalDetail) closeDetailModal();
    });

    function closeDetailModal() {
        modalDetail.style.display = 'none';
    }

    async function openDetailModal(run) {
        $('#detail-title').textContent = run.name || 'Test Run Detail';
        const body = $('#detail-body');
        body.innerHTML = '<div class="empty-state glass-panel"><p>Loading run detail...</p></div>';
        modalDetail.style.display = 'flex';

        let displayRun = run;
        const runId = run && run.id ? String(run.id) : '';

        if (runId && !runId.startsWith('imported_')) {
            const hydrated = await fetchRunDetailById(runId);
            if (hydrated) {
                displayRun = hydrated;
            }
        }

        $('#detail-title').textContent = displayRun.name || 'Test Run Detail';
        body.innerHTML = renderRunDetail(displayRun);

        // Attach case tab click handlers
        body.querySelectorAll('.case-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                const idx = tab.dataset.caseIdx;
                // Toggle panels
                body.querySelectorAll('.case-panel').forEach((p) => {
                    p.style.display = p.dataset.caseIdx === idx ? 'block' : 'none';
                });
                // Toggle tab active styles
                body.querySelectorAll('.case-tab').forEach((t) => {
                    const isActive = t.dataset.caseIdx === idx;
                    t.style.background = isActive ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.05)';
                    t.style.color = isActive ? 'var(--accent-primary)' : 'var(--text-secondary)';
                    t.style.borderBottom = isActive ? '2px solid var(--accent-primary)' : '2px solid transparent';
                    t.classList.toggle('active', isActive);
                });
            });
        });
    }

    // ============================================================
    // RENDERING: Dashboard
    // ============================================================
    function bindRecentRunCardEvents(listEl) {
        listEl.querySelectorAll('.run-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.btn-delete-run') || e.target.closest('.btn-run-from-history')) return;
                const runId = card.dataset.runId;
                const run = state.testRuns.find((r) => r.id === runId);
                if (run) openDetailModal(run);
            });
        });

        listEl.querySelectorAll('.btn-run-from-history').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tcId = btn.dataset.tcId;
                let tc = state.testCases.find(t => String(t.id) === String(tcId));

                if (!tc && btn.closest('.run-card')) {
                    const runId = btn.closest('.run-card').dataset.runId;
                    const run = state.testRuns.find(r => r.id === runId);
                    if (run) {
                        if (run.tc_code) tc = state.testCases.find(t => t.tc_code === run.tc_code);
                        if (!tc && run.name && (run.url || run.product_url)) tc = state.testCases.find(t => t.name === run.name && t.url === (run.url || run.product_url));
                    }
                }

                if (tc) {
                    const isHeadless = $('#checkbox-headless') ? $('#checkbox-headless').checked : true;
                    const useAi = $('#checkbox-use-ai') ? $('#checkbox-use-ai').checked : true;
                    // Note: triggerTestRun should be available globally
                    triggerTestRun(tc, btn, isHeadless, useAi, {
                        tcCodeOverride: btn.dataset.reportCode || tc.tc_code || tc.name,
                        concurrency: 2,
                    });
                } else {
                    showPopup({ title: 'Not Found', message: 'Original test case not found.', okText: 'OK' });
                }
            });
        });

        listEl.querySelectorAll('.btn-delete-run').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const runId = btn.dataset.runId;
                if (typeof deleteTestRun === 'function') {
                    deleteTestRun(runId);
                } else {
                    console.warn('deleteTestRun function not found.');
                }
            });
        });
    }

    function renderRunCard(run) {
        const statusMeta = getUiStatusMeta(run.status || 'FAIL');
        const tcLabel = escapeHtml(run.name || run.tc_code || 'Unknown Test');
        const urlLabel = escapeHtml(run.product_url || run.url || '');
        const timeStr = formatTime(getRunTimeIso(run));
        const scoreValue = Number(run.score);

        return `
        <div class="run-card glass-panel" data-run-id="${run.id}" style="margin-bottom:8px; cursor:pointer; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; gap:16px; transition: all 0.2s ease;">
            <!-- Khá»‘i trÃ¡i (Left block) - ThÃ´ng tin -->
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:4px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <h3 style="margin:0; font-size:1rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${tcLabel}">${tcLabel}</h3>
                    <span class="badge badge-${statusMeta.className}" style="flex-shrink:0;">${statusMeta.label}</span>
                </div>
                ${urlLabel ? `<div style="font-size:0.8rem; color:var(--accent-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${urlLabel}">${urlLabel}</div>` : ''}
            </div>

            <!-- Khá»‘i pháº£i (Right block) - ThÃ´ng sá»‘ & HÃ nh Ä‘á»™ng -->
            <div style="display:flex; align-items:center; gap:16px; flex-shrink:0;">
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; font-size:0.8rem; color:var(--text-secondary);">
                    <div><strong style="color:var(--text-primary)">${Number.isFinite(scoreValue) ? scoreValue : '-'}</strong> pts &bull; <strong>${run.total_steps || 0}</strong> stp</div>
                    <div style="font-family:'Fira Code', monospace; font-size:0.75rem; color:var(--text-muted);">${timeStr}</div>
                </div>
                <div class="card-actions" style="display:flex; align-items:center; gap:6px; border-left:1px solid rgba(255,255,255,0.1); padding-left:16px;">
                    ${(run.test_case_id && normalizeRunStatus(run.status) !== 'RUNNING') ? `
                            <button class="btn-primary btn-xs btn-run-from-history" data-tc-id="${run.test_case_id}" data-report-code="${escapeHtml(run.report_code || run.tc_code || '')}" title="Run again">Run</button>
                    ` : ''}
                    <button class="btn-ghost btn-xs btn-delete-run" data-run-id="${run.id}" title="Delete" style="color:var(--accent-danger);">Del</button>
                </div>
            </div>
        </div>
        `;
    }

    function renderDashboard() {
        if (state.currentPage !== 'dashboard') return;

        const listEl = $('#recent-runs-list');
        if (!listEl) return;

        // Filter and sort runs
        const sortedLatestRuns = [...state.testRuns].sort((a, b) => getRunTimeValue(b) - getRunTimeValue(a));
        const totalItems = sortedLatestRuns.length;

        if (totalItems === 0) {
            listEl.innerHTML = '<div class="empty-state">No recent test runs. Start a new test to see it here.</div>';
            return;
        }

        const { page, pageSize } = state.pagination.dashboard;
        const totalPages = Math.ceil(totalItems / pageSize);
        const paginatedRuns = sortedLatestRuns.slice((page - 1) * pageSize, page * pageSize);

        listEl.innerHTML = paginatedRuns.map((run) => renderRunCard(run)).join('');
        renderPagination('pagination-dashboard', 'dashboard', totalItems);

        bindRecentRunCardEvents(listEl);
    }

    // ============================================================
    // RENDERING: Test Cases
    // ============================================================
    function renderTestCases() {
        const listEl = $('#test-cases-list');
        const query = state.searchQuery || '';

        const filteredCases = state.testCases.filter(tc => {
            if (!query) return true;
            return (tc.name || '').toLowerCase().includes(query);
        });

        // Pagination for Test Cases
        const totalItems = filteredCases.length;
        const { page, pageSize } = state.pagination.testCases;
        const paginatedCases = filteredCases.slice((page - 1) * pageSize, page * pageSize);

        if (paginatedCases.length === 0) {
            listEl.innerHTML = '<div class="empty-state">No test cases found.</div>';
            return;
        }

        let tableHtml = `
        <table class="tc-table">
            <thead>
                <tr>
                    <th style="width: 40px;"><input type="checkbox" id="tc-select-all" style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent-primary);" ${state.selectedTestCases.size > 0 && paginatedCases.every(tc => state.selectedTestCases.has(tc.id)) ? 'checked' : ''} ${paginatedCases.length === 0 ? 'disabled' : ''}></th>
                    <th>Name</th>
                    <th>Product URL</th>
                    <th>Status</th>
                    <th>Result / Decision</th>
                    <th>Reasons</th>
                    <th>Last Run</th>
                    <th style="width: 180px;">Actions</th>
                </tr>
            </thead>
            <tbody>
        `;

        const rowsHtml = paginatedCases.map((tc) => {
            const lastRun = state.testRuns
                .filter((r) => {
                    const rId = String(r.test_case_id || '');
                    const tcId = String(tc.id || '');
                    if (tcId && rId === tcId) return true;
                    const tcCode = tc.tc_code || tc.name;
                    return tcCode && (r.tc_code === tcCode || r.report_code === tcCode);
                })
                .sort((a, b) => getRunTimeValue(b) - getRunTimeValue(a))[0] || {};

            const isBusinessStatus = (s) => ['PASS', 'FAIL', 'FATAL', 'REVIEW'].includes(String(s || '').toUpperCase());

            let execStatus = tc.execution_status || 'READY';
            let resStatus = isBusinessStatus(tc.status) ? tc.status : (tc.result_status || '');

            if (lastRun && lastRun.id) {
                execStatus = lastRun.execution_status || (normalizeRunStatus(lastRun.status) === 'RUNNING' ? 'RUNNING' : 'FINISHED');
                resStatus = lastRun.result_status || (isBusinessStatus(lastRun.status) ? lastRun.status : resStatus);
            }

            const execClass = String(execStatus).toLowerCase();
            const resClass = String(resStatus).toLowerCase();

            let execBadge = '';
            let resBadge = '';
            let reasonsHtml = '';

            if (execClass === 'running') {
                const runningRun = state.testRuns.find(r => (r.test_case_id === tc.id || r.tc_code === tc.tc_code) && normalizeRunStatus(r.status) === 'RUNNING');
                const startTs = (runningRun && runningRun._startTimestamp);
                execBadge = `<span class="badge badge-running"><span class="loading-spinner"></span><span ${startTs ? `data-timer-start="${startTs}"` : ''}>${startTs ? '0s' : '--'}</span></span>`;
                resBadge = '-';
            } else {
                execBadge = `<span class="badge badge-${execClass}">${execStatus || 'READY'}</span>`;

                if (resStatus && isBusinessStatus(resStatus)) {
                    let resContent = resStatus;

                    // Add score with Raw Score if available
                    if (typeof lastRun.score === 'number') {
                        const rawScore = lastRun.raw_score || lastRun.score;
                        const hasOverride = rawScore !== lastRun.score;

                        resContent += ` <span class="score-container">
                            ${hasOverride ? `<span class="score-raw" title="Raw Score before override">${rawScore}</span>` : ''}
                            <span style="opacity:0.8; font-weight:700;">${lastRun.score}</span>
                        </span>`;
                    }

                    // Add passed/total
                    if (typeof lastRun.total_cases === 'number' && lastRun.total_cases > 0) {
                        resContent += ` <span style="opacity:0.6; font-size:0.75rem;">(${lastRun.passed_cases}/${lastRun.total_cases})</span>`;
                    }

                    resBadge = `
                        <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
                            <span class="badge badge-${resClass}">${resContent}</span>
                            ${lastRun.decision ? `<span class="badge-decision">${lastRun.decision}</span>` : ''}
                            ${lastRun.confidence_score ? `<span class="badge-decision-sub" style="font-size: 10px; opacity: 0.7;">Confidence: ${Math.round(lastRun.confidence_score * 100)}%</span>` : ''}
                        </div>`;

                    // Render Reasons
                    const codes = lastRun.reason_codes || lastRun.decision_reason_codes || [];
                    if (codes.length > 0) {
                        reasonsHtml = `<div class="reason-tags">${codes.map(c => `<span class="reason-tag" title="${c}">${c}</span>`).join('')}</div>`;
                    }
                } else {
                    resBadge = '-';
                }
            }

            const isSelected = state.selectedTestCases.has(tc.id);

            return `
            <tr data-tc-id="${tc.id}">
                <td><input type="checkbox" class="tc-checkbox" data-tc-id="${tc.id}" style="width: 18px; height: 18px; cursor: pointer;" ${isSelected ? 'checked' : ''}></td>
                <td style="font-weight: 500;">${escapeHtml(tc.name || 'Unnamed Case')}</td>
                <td class="td-url"><a href="${tc.url || '#'}" target="_blank">${escapeHtml(tc.url || 'No URL')}</a></td>
                <td>${execBadge}</td>
                <td>${resBadge}</td>
                <td>${reasonsHtml || '-'}</td>
                <td style="font-size: 0.85rem; white-space: nowrap;">${(lastRun && lastRun.id) ? formatTime(lastRun.test_time || lastRun.started_at) : '-'}</td>
                <td>
                    <div class="table-actions">
                        ${(lastRun && lastRun.id)
                    ? `<button class="btn-primary btn-xs btn-view" data-run-id="${lastRun.id}">Report</button>
                               <button class="btn-ghost btn-xs btn-rerun" data-tc-id="${tc.id}" data-report-code="${escapeHtml(lastRun.report_code || lastRun.tc_code || tc.tc_code || '')}">Run</button>`
                    : `<button class="btn-primary btn-xs btn-rerun" data-tc-id="${tc.id}" data-report-code="${escapeHtml(tc.tc_code || tc.name || '')}">Run</button>`}
                        <button class="btn-ghost btn-xs btn-delete" data-tc-id="${tc.id}" style="color: var(--accent-danger);">Delete</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        tableHtml += rowsHtml + '</tbody></table>';
        listEl.innerHTML = tableHtml;

        renderPagination('pagination-test-cases', 'testCases', totalItems);

        // Attach individual handlers
        listEl.querySelectorAll('.btn-view').forEach((btn) => {
            btn.addEventListener('click', () => {
                const runId = btn.dataset.runId;
                const run = state.testRuns.find((r) => r.id === runId);
                if (run) openDetailModal(run);
            });
        });

        listEl.querySelectorAll('.btn-rerun').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tc = state.testCases.find((t) => t.id === btn.dataset.tcId);
                if (tc) {
                    const isHeadless = $('#checkbox-headless') ? $('#checkbox-headless').checked : true;
                    const useAi = $('#checkbox-use-ai') ? $('#checkbox-use-ai').checked : true;
                    triggerTestRun(tc, btn, isHeadless, useAi, {
                        tcCodeOverride: btn.dataset.reportCode || tc.tc_code || tc.name,
                        concurrency: 2,
                    });
                }
            });
        });

        listEl.querySelectorAll('.btn-delete').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const tcId = btn.dataset.tcId;
                const confirmed = await showPopup({
                    title: 'Delete Test Case',
                    message: 'Delete this test case and all related runs/reports?',
                    okText: 'Delete',
                    cancelText: 'Keep it',
                    isConfirm: true
                });

                if (!confirmed) return;

                try {
                    const res = await Auth.fetch(`/api/test-cases/${tcId}`, { method: 'DELETE' });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.error || 'Delete test case failed');
                    }

                    // Sync from server after successful delete
                    await syncAllFromApi({ render: true });
                } catch (err) {
                    await showPopup({
                        title: 'Error',
                        message: 'Delete test case failed: ' + err.message
                    });
                }
            });
        });
    }

    // ============================================================
    // RENDERING: History Timeline
    // ============================================================
    function renderHistory() {
        const el = $('#history-timeline');
        const filteredRuns = getFilteredRuns(state.testRuns);

        if (filteredRuns.length === 0) {
            const query = state.searchQuery;
            const emptyText = query
                ? `<p>No history matches "${escapeHtml(query)}".</p>`
                : `<p>No history available.</p>`;
            el.innerHTML = `<div class="empty-state glass-panel">${emptyText}</div>`;
            return;
        }

        // Group runs by Test Case Name for History view
        const sortedRuns = [...filteredRuns].sort((a, b) => getRunTimeValue(b) - getRunTimeValue(a));
        const historyMap = new Map();
        const testCaseNames = new Map(state.testCases.map((tc) => [tc.id, tc.name]));

        sortedRuns.forEach((run) => {
            const key = run.test_case_id || run.name || 'Unknown';
            if (!historyMap.has(key)) historyMap.set(key, []);
            historyMap.get(key).push(run);
        });

        let html = '';
        historyMap.forEach((runsForCase, caseName) => {
            const caseLabel = testCaseNames.get(caseName) || caseName;
            html += `<h3 style="margin: 20px 0 10px; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); padding-bottom: 5px;">Test Case: ${escapeHtml(caseLabel)}</h3>`;
            html += runsForCase.map((run) => {
                const statusMeta = getUiStatusMeta(run.status);
                const scoreValue = Number(run.score);
                return `
                <div class="timeline-item ${statusMeta.className}" data-run-id="${run.id}" style="cursor: pointer; position: relative;">
                    <div class="timeline-content">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div>
                                <h3>${formatTime(getRunTimeIso(run))} <span class="badge badge-${statusMeta.className}" style="margin-left:8px">${statusMeta.label}</span></h3>
                                <p>Score: ${Number.isFinite(scoreValue) ? scoreValue + '/100' : '-'} - ${run.total_steps || 0} steps</p>
                            </div>
                            ${(run.test_case_id && normalizeRunStatus(run.status) !== 'RUNNING') ? `
                                <button class="btn-ghost btn-xs btn-run-from-history" data-tc-id="${run.test_case_id}" data-report-code="${escapeHtml(run.report_code || run.tc_code || '')}" title="Run this test case again" style="padding: 4px 12px;">Run</button>
                            ` : ''}
                        </div>
                    </div>
                </div>`;
            }).join('');
        });

        el.innerHTML = html;

        el.querySelectorAll('.timeline-item').forEach((item) => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.btn-run-from-history')) return;
                const run = state.testRuns.find((r) => r.id === item.dataset.runId);
                if (run) openDetailModal(run);
            });
        });

        // Attach run from history handlers for history page
        el.querySelectorAll('.btn-run-from-history').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tcId = btn.dataset.tcId;
                const tc = state.testCases.find(t => String(t.id) === String(tcId));
                if (tc) {
                    const isHeadless = $('#checkbox-headless') ? $('#checkbox-headless').checked : true;
                    const useAi = $('#checkbox-use-ai') ? $('#checkbox-use-ai').checked : true;
                    triggerTestRun(tc, btn, isHeadless, useAi, {
                        tcCodeOverride: btn.dataset.reportCode || tc.tc_code || tc.name,
                        concurrency: 2,
                    });
                }
            });
        });
    }

    // ============================================================
    // RENDERING: Run Detail (Step-by-Step Timeline)
    // ============================================================
    function renderRunDetail(run) {
        let html = '';

        // Header and Scores
        // Dual-mode logic: if reliability data is present, use it, else fallback to legacy
        const isV2 = run.decision && typeof run.quality_score !== 'undefined';
        const uiTitle = isV2 ? run.decision : run.status;
        const statusMeta = getUiStatusMeta(uiTitle);

        // Main score display (Quality Score for V2, Legacy Score for V1)
        const mainScoreValue = isV2 ? run.quality_score : Number(run.score);
        const mainScoreLabel = isV2 ? 'Quality Score' : 'Score';

        // Confidence Score Display (V2 only)
        let confidenceHtml = '';
        if (isV2) {
            const cScore = (run.confidence_score * 100).toFixed(0);
            const cClass = run.confidence_score >= 0.85 ? 'var(--accent-success)' : (run.confidence_score >= 0.6 ? 'var(--accent-warning)' : 'var(--accent-danger)');

            // Build tooltip for signal detail breakdown
            let signalTooltip = 'Confidence Details:\n';
            if (run.signal_detail) {
                signalTooltip += `- Coverage: ${(run.signal_detail.coverage * 100).toFixed(0)}%\n`;
                signalTooltip += `- Agreement: ${(run.signal_detail.agreement * 100).toFixed(0)}%\n`;
                signalTooltip += `- Stability: ${(run.signal_detail.stability * 100).toFixed(0)}%\n`;
                signalTooltip += `- Pipeline: ${(run.signal_detail.pipeline_health * 100).toFixed(0)}%`;
            }

            confidenceHtml = `<span style="font-size:1rem;font-weight:600;color:${cClass};" title="${signalTooltip}">Confidence: ${cScore}%</span>`;
        }

        html += `
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;flex-wrap:wrap;">
            <span class="badge badge-${statusMeta.className}" style="font-size:1rem;padding:8px 16px;">${statusMeta.label}</span>
            <div style="display:flex;flex-direction:column;align-items:flex-start;">
                <span style="font-size:1.5rem;font-weight:700;">${Number.isFinite(mainScoreValue) ? mainScoreValue + '/100' : '-'}</span>
                <span style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;">${mainScoreLabel}</span>
            </div>
            ${confidenceHtml}
            <div style="width:1px;height:30px;background:rgba(255,255,255,0.1);margin:0 8px;"></div>
            <span style="color:var(--text-muted);font-size:0.85rem;">${formatTime(getRunTimeIso(run))}</span>
            ${run.total_cases ? `<span style="color:var(--text-muted);font-size:0.85rem;">| ${run.passed_cases}/${run.total_cases} cases passed</span>` : ''}
        </div>`;

        // URL
        html += `<p style="font-family:'Fira Code',monospace;font-size:0.8rem;color:var(--text-muted);margin-bottom:12px;word-break:break-all;">${escapeHtml(run.product_url || run.url || '')}</p>`;

        // Variant Selections (Phase 12)
        if (run.variants_selected && run.variants_selected.length > 0) {
            html += `
            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); padding:12px 16px; border-radius:8px; margin-bottom:24px;">
                <label style="display:block; font-size:0.75rem; font-weight:700; color:var(--accent-primary); text-transform:uppercase; margin-bottom:8px; letter-spacing:0.05em;">Variant Selections (Style/Size)</label>
                <div style="display:flex; flex-wrap:wrap; gap:8px;">
                    ${run.variants_selected.map(v => `
                        <span style="background:rgba(99,102,241,0.15); color:var(--accent-primary); border:1px solid rgba(99,102,241,0.2); padding:4px 10px; border-radius:100px; font-size:0.8rem; font-weight:500;">
                            ${escapeHtml(typeof v === 'string' ? v : (v.text || v.label || '-'))}
                        </span>
                    `).join('')}
                </div>
            </div>`;
        } else {
            html += '<div style="margin-bottom:24px;"></div>';
        }

        // Multi-case: show tabs + per-case content
        if (run.cases && run.cases.length > 0) {
            html += renderCaseTabs(run);
        } else if (run.timeline && run.timeline.length > 0) {
            // Backward compatibility: flat timeline (old QA* reports)
            html += renderStepTimeline(run.timeline);
            html += renderFinalEvaluation(run);
        }

        return html;
    }

    function renderCaseTabs(run) {
        let html = '';
        // Tab bar
        html += '<div class="case-tab-bar" style="display:flex;gap:8px;margin-bottom:20px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:12px;flex-wrap:wrap;">';
        run.cases.forEach((c, idx) => {
            const cStatus = c.status === 'PASS' ? 'pass' : c.status === 'FATAL' ? 'fatal' : 'fail';
            html += `<button class="case-tab ${idx === 0 ? 'active' : ''}" data-case-idx="${idx}" style="
                padding:8px 16px;border:none;border-radius:8px 8px 0 0;cursor:pointer;font-size:0.85rem;font-weight:600;
                transition:all 0.2s;
                background:${idx === 0 ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.05)'};
                color:${idx === 0 ? 'var(--accent-primary)' : 'var(--text-secondary)'};
                border-bottom:${idx === 0 ? '2px solid var(--accent-primary)' : '2px solid transparent'};
            ">
                Case ${idx + 1}: ${escapeHtml(c.case_label || '')}
                <span class="badge badge-${cStatus}" style="font-size:0.7rem;padding:2px 6px;margin-left:6px;">${c.score}/100</span>
            </button>`;
        });
        html += '</div>';

        // Case content panels
        run.cases.forEach((c, idx) => {
            html += `<div class="case-panel" data-case-idx="${idx}" style="display:${idx === 0 ? 'block' : 'none'};">`;

            // 1. Step Timeline (Default Expanded)
            html += `
            <div class="collapsible-header active" onclick="this.nextElementSibling.classList.toggle('collapsed'); this.classList.toggle('active');">
                <span class="collapsible-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-primary)"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                    Step Timeline   
                </span>
                <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
            </div>
            <div class="collapsible-content">
                ${renderStepTimeline(c.timeline || [])}
            </div>`;

            // 2. Case Evaluation (Default Collapsed if PASS, Expanded if FAIL)
            const evaluationHtml = c.final_evaluation ? renderCaseEvaluation(c) : '';
            if (evaluationHtml) {
                const isFail = c.status !== 'PASS';
                html += `
                <div class="collapsible-header ${isFail ? 'active' : ''}" onclick="this.nextElementSibling.classList.toggle('collapsed'); this.classList.toggle('active');">
                    <span class="collapsible-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-warning)"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
                        Case Evaluation & Score Breakdown
                    </span>
                    <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                </div>
                <div class="collapsible-content ${isFail ? '' : 'collapsed'}">
                    ${evaluationHtml}
                </div>`;
            }

            // 3. AI Final QA Review (Default Expanded if present)
            if (c.final_evaluation?.ai_review) {
                html += `
                <div class="collapsible-header active" onclick="this.nextElementSibling.classList.toggle('collapsed'); this.classList.toggle('active');">
                    <span class="collapsible-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-primary)"><path d="M12 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10 10 10 0 0 1-10-10 10 10 0 0 1 10-10z"></path><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>
                        AI Final QA Review
                    </span>
                    <svg class="toggle-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                </div>
                <div class="collapsible-content">
                    ${renderAiReview(c.final_evaluation.ai_review)}
                </div>`;
            }

            html += '</div>';
        });

        return html;
    }

    function renderStepTimeline(timeline) {
        if (!timeline || timeline.length === 0) return '';
        let html = '<div class="step-timeline">';

        // Map lifecycle action names to readable labels
        const lifecycleLabels = {
            'open_page': 'Open Page',
            'load_customizer': 'Load Customizer',
            'validate_preview': 'Preview Validation',
            'add_to_cart': 'Add to Cart',
        };

        timeline.forEach((step) => {
            const isV2 = !!step.step_verdict;
            const isLifecycle = step.group_type === 'lifecycle';
            const uiStatus = isLifecycle ? step.status : (isV2 ? step.step_verdict : step.status);

            let stepClass = 'fail';
            if (uiStatus === 'PASS') stepClass = 'pass';
            else if (uiStatus === 'SKIPPED') stepClass = 'skip';
            else if (uiStatus === 'WARNING') stepClass = 'warning';
            else if (uiStatus === 'UNAVAILABLE') stepClass = 'warning';

            // Lifecycle steps: uniform boxed style
            if (isLifecycle) {
                const label = lifecycleLabels[step.action] || step.name;
                const aiReason = step.ai_evaluation?.ai_reason || '';

                html += `
                <div class="step-item ${stepClass} lifecycle-step">
                    <div class="step-marker" style="width:30px; height:30px; line-height:30px; text-align:center; font-weight:700; font-size:0.9rem; background:var(--bg-elevated); border:2px solid var(--border-subtle); border-radius:50%;">${step.step_id}</div>
                    <div class="step-content">
                        <div class="step-header">
                            <div class="step-title-area">
                                <span class="step-label">HÃ€NH Äá»˜NG ${step.step_id}</span>
                                <h4 class="step-action-title">${escapeHtml(label)}</h4>
                            </div>
                            <span class="badge badge-${stepClass}">${uiStatus}</span>
                        </div>
                        
                        ${step.message ? `<div class="step-message" style="margin-top:4px;">${escapeHtml(step.message)}</div>` : ''}
                        
                        ${aiReason ? `
                        <div class="ai-insight-box">
                            <div class="ai-reason-text">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:text-top; margin-right:6px; color:var(--accent-primary);"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-10.6 8.5 8.5 0 0 1 7.6 10.6 Z"></path></svg>
                                <strong>AI Analysis:</strong> ${escapeHtml(aiReason)}
                            </div>
                        </div>` : ''}

                        ${step.action === 'add_to_cart' && step.cart_evidence
                        ? `<div class="step-images" style="margin-top:10px; display:flex; gap:12px; align-items:flex-start;">
                            ${step.cart_evidence.panel ? `
                            <div class="step-img-container" style="max-width:320px; flex:0 0 auto;">
                                <img src="${escapeHtml(step.cart_evidence.panel)}" alt="Cart Panel">
                                <div class="step-img-label">GIá»Ž HÃ€NG (PANEL)</div>
                            </div>` : ''}
                            <div class="step-img-container" style="max-width:320px; flex:0 0 auto;">
                                <img src="${escapeHtml(step.cart_evidence.viewport)}" alt="Viewport Context">
                                <div class="step-img-label">Bá»I Cáº¢NH (VIEWPORT)</div>
                            </div>
                        </div>`
                        : (step.state_after
                            ? `<div class="step-images" style="margin-top:10px;">
                                <div class="step-img-container" style="max-width:400px;">
                                    <img src="${escapeHtml(step.state_after)}" alt="Evidence">
                                    <div class="step-img-label">Káº¾T QUáº¢</div>
                                </div>
                            </div>`
                            : '')}
                    </div>
                </div>`;
                return;
            }

            // Customization step (Step-by-step biography style)
            const thumbHtml = step.option_thumbnail
                ? `<img src="${escapeHtml(step.option_thumbnail)}" style="width:32px;height:32px;border-radius:4px;object-fit:cover;" alt="thumb">`
                : '';
            const rawColorHex = typeof step.option_color_hex === 'string' ? step.option_color_hex.trim() : '';
            const safeColorHex = /^#[0-9A-Fa-f]{6}$/.test(rawColorHex) ? rawColorHex.toUpperCase() : '';
            const rawColorText = typeof step.option_color === 'string' ? step.option_color.trim() : '';
            const colorMetaHtml = safeColorHex
                ? `<span class="step-diff" title="Selected color" style="display:inline-flex;align-items:center;gap:6px;">
                        <span style="width:12px;height:12px;border-radius:999px;border:1px solid rgba(255,255,255,0.45);background:${safeColorHex};display:inline-block;"></span>
                        ${escapeHtml(safeColorHex)}
                   </span>`
                : (rawColorText
                    ? `<span class="step-diff" title="Selected color">${escapeHtml(rawColorText)}</span>`
                    : '');

            // AI Reasoning Extraction
            const aiReason = step.ai_evaluation?.ai_reason || '';
            const aiAnnotatedImg = step.ai_annotated_image || '';

            html += `
                <div class="step-item ${stepClass}">
                    <div class="step-marker" style="width:30px; height:30px; line-height:30px; text-align:center; font-weight:700; font-size:0.9rem; background:var(--bg-elevated); border:2px solid var(--border-subtle); border-radius:50%;">${step.step_id}</div>
                    <div class="step-content">
                        <div class="step-header">
                            <div class="step-title-area">
                                <span class="step-label">HÃ€NH Äá»˜NG ${step.step_id}</span>
                                <h4 class="step-action-title">${escapeHtml(step.action)}: <span class="step-name">${escapeHtml(step.name)}</span></h4>
                            </div>
                            <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
                                ${step.interaction_status ? `<span class="badge badge-${step.interaction_status.toLowerCase() === 'pass' ? 'pass' : 'fail'}" title="Interaction Status">ACT: ${step.interaction_status}</span>` : ''}
                                ${step.validation_status ? `<span class="badge badge-${['PASS', 'FAIL', 'WARNING'].includes(step.validation_status) ? step.validation_status.toLowerCase() : 'warning'}" title="Validation Status">VAL: ${step.validation_status}</span>` : ''}
                                <span class="badge badge-${stepClass}" title="Final Step Status">${uiStatus}</span>
                            </div>
                        </div>
                        
                        <div class="step-selection-row">
                            ${thumbHtml}
                            <span class="step-val-label">Lá»±a chá»n: <span class="step-val-badge">${escapeHtml(step.value_chosen || '')}</span></span>
                            ${colorMetaHtml}
                            
                            ${isV2 ? (
                    `<div style="display:inline-flex;gap:8px;margin-left:auto;">
                                    ${step.signals?.diff?.availability === 'AVAILABLE' ? `<span class="step-diff" title="Visual Diff">Diff: ${step.signals.diff.score}%</span>` : `<span class="step-diff" style="color:var(--text-muted);border-color:rgba(255,255,255,0.1)">Diff: N/A</span>`}
                                    ${step.signals?.color?.availability === 'AVAILABLE' ? `<span class="step-diff" title="Color Verification">Color: ${step.signals.color.result}</span>` : ''}
                                    ${step.signals?.temporal_impact?.severity && step.signals.temporal_impact.severity !== 'NONE' ? `<span class="step-diff" style="color:var(--accent-danger);border-color:var(--accent-danger)" title="Temporal Shift">Temp: ${step.signals.temporal_impact.severity}</span>` : `<span class="step-diff" style="color:var(--accent-success);opacity:0.6" title="Temporal Shift">Stable</span>`}
                                 </div>`
                ) : (
                    // Legacy fallback
                    `${step.code_evaluation && step.code_evaluation.diff_score >= 0
                        ? `<span class="step-diff" title="Pixelmatch">Audit Code: ${step.code_evaluation.diff_score}%</span>`
                        : (step.diff_score >= 0 ? `<span class="step-diff">Äá»™ lá»‡ch: ${step.diff_score}%</span>` : '')}`
                )}
                        </div>

                        ${step.state_before || step.state_after
                    ? `<div class="step-images">
                                <div class="step-img-container">
                                    ${step.state_before ? `<img src="${escapeHtml(step.state_before)}" alt="Before">` : '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">N/A</div>'}
                                    <div class="step-img-label">TRÆ¯á»šC KHI</div>
                                </div>
                                <div class="step-arrow-section">
                                    ${step.option_thumbnail
                        ? `<div class="step-option-preview">
                                            <img src="${escapeHtml(step.option_thumbnail)}" alt="Option" style="width:48px;height:48px;border-radius:6px;object-fit:cover;border:2px solid var(--accent-primary);">
                                        </div>`
                        : (safeColorHex
                            ? `<div class="step-option-preview">
                                                <div style="width:40px;height:40px;border-radius:50%;border:2px solid var(--accent-primary);background:${safeColorHex};margin:0 auto;"></div>
                                            </div>`
                            : '<div class="step-arrow">â†’</div>')}
                                </div>
                                <div class="step-img-container">
                                    ${step.state_after ? `<img src="${escapeHtml(step.state_after)}" alt="After">` : '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">N/A</div>'}
                                    <div class="step-img-label">SAU KHI</div>
                                </div>
                            </div>`
                    : ''}

                        ${aiReason ? `
                        <div class="ai-insight-box">
                            <div class="ai-reason-text">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:text-top; margin-right:6px; color:var(--accent-primary);"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-10.6 8.5 8.5 0 0 1 7.6 10.6 Z"></path></svg>
                                <strong>AI Analysis:</strong> ${escapeHtml(aiReason)}
                            </div>
                        </div>` : ''}

                        ${aiAnnotatedImg ? `
                        <div class="ai-vision-view">
                            <div class="ai-vision-header">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-primary);"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                <span class="ai-vision-title">AI Vision: Detected Areas</span>
                            </div>
                            <img src="${aiAnnotatedImg}" alt="AI Vision" class="ai-annotated-img" style="cursor:zoom-in" onclick="window.open(this.src)">
                        </div>` : ''}

                        ${step.message ? `<div class="step-message" style="margin-top:10px;">${escapeHtml(step.message)}</div>` : ''}
                        
                        <div class="step-meta-grid" style="margin-top:15px; display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px;">
                            <div class="meta-item" style="padding:8px 12px; background:rgba(0,0,0,0.15); border-radius:8px; border:1px solid rgba(255,255,255,0.03);">
                                <span class="meta-label" style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px; text-transform:uppercase;">AI Kiá»ƒm Äá»‹nh</span>
                                <span class="meta-value" style="font-size:0.85rem; font-weight:600; color:${step.ai_evaluation?.ai_verdict === 'PASS' ? 'var(--accent-success)' : 'var(--text-muted)'}">
                                    ${step.ai_evaluation?.ai_verdict || 'N/A'}
                                </span>
                            </div>
                            <div class="meta-item" style="padding:8px 12px; background:rgba(0,0,0,0.15); border-radius:8px; border:1px solid rgba(255,255,255,0.03);">
                                <span class="meta-label" style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px; text-transform:uppercase;">MÃ£ Audit</span>
                                <span class="meta-value" style="font-size:0.85rem; font-weight:600;">${step.code_evaluation?.status || 'N/A'}</span>
                            </div>
                        </div>
                    </div>
                </div>`;
        });
        html += '</div>';
        return html;
    }

    function renderCaseEvaluation(caseReport) {
        const ev = caseReport.final_evaluation;
        if (!ev) return '';

        let fatalHtml = '';
        if (caseReport.is_fatal && caseReport.fatal_reasons?.length > 0) {
            fatalHtml = `
            <div style="background:rgba(185,28,28,0.15); border:1px solid rgba(185,28,28,0.5); border-radius:8px; padding:16px; margin-bottom:20px;">
                <h4 style="color:#f87171; margin-top:0; margin-bottom:8px; font-size:1rem; display:flex; align-items:center; gap:8px;">FATAL ERROR</h4>
                <ul style="color:#fca5a5; font-size:0.85rem; margin:0; padding-left:24px; font-family:'Fira Code', monospace; line-height:1.6;">
                    ${caseReport.fatal_reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
                </ul>
            </div>`;
        }

        // Score breakdown section
        let breakdownHtml = '';
        const sb = caseReport.score_breakdown;
        if (sb) {
            let rows = [];
            let finalScoreDisplay = '-';

            // Check if using the new schema (has pixel/color/ocr/ai etc or total)
            if (typeof sb.total !== 'undefined' || typeof sb.pixel !== 'undefined') {
                rows = [
                    { label: 'Pixel Match', value: sb.pixel, color: 'var(--text-primary)', isScore: true },
                    { label: 'Color Verification', value: sb.color, color: 'var(--text-primary)', isScore: true },
                    { label: 'Text/OCR Match', value: sb.ocr, color: 'var(--text-primary)', isScore: true },
                    { label: 'AI Review', value: sb.ai, color: 'var(--text-primary)', isScore: true },
                    { label: 'Flow Completion', value: sb.completion, color: 'var(--text-primary)', isScore: true },
                    { label: 'Add to Cart', value: sb.cart, color: 'var(--text-primary)', isScore: true }
                ];
                finalScoreDisplay = sb.total ?? sb.final_score ?? caseReport.score ?? '-';
            } else {
                // Legacy schema
                rows = [
                    { label: 'Base Score', value: sb.base_score, color: 'var(--text-primary)', isBase: true },
                    { label: `Visual Option Fails (x${sb.visual_fail_count || 0})`, value: sb.visual_fail_penalty, color: 'var(--accent-danger)', isPenalty: true },
                    { label: `Text Diff Fails (x${sb.text_diff_fail_count || 0})`, value: sb.text_diff_penalty, color: 'var(--accent-danger)', isPenalty: true },
                    { label: 'Open Page', value: sb.open_page_penalty, color: 'var(--accent-warning)', isPenalty: true },
                    { label: 'Load Customizer', value: sb.load_customizer_penalty, color: 'var(--accent-warning)', isPenalty: true },
                    { label: 'Preview Validation', value: sb.preview_validation_penalty, color: 'var(--accent-warning)', isPenalty: true },
                    { label: 'Add to Cart', value: sb.add_to_cart_penalty, color: 'var(--accent-warning)', isPenalty: true },
                ];
                finalScoreDisplay = sb.final_score ?? caseReport.score ?? '-';
            }

            let rowsHtml = '';
            rows.forEach(r => {
                const rawVal = r.value;
                const isUndef = typeof rawVal === 'undefined' || rawVal === null;
                const display = isUndef ? '-' : (r.isBase || r.isScore ? rawVal : (rawVal === 0 ? '0' : String(rawVal)));

                let statusIcon = '';
                let valColor = 'var(--text-primary)';

                if (r.isScore) {
                    statusIcon = '';
                    valColor = isUndef ? 'var(--text-muted)' : r.color;
                } else {
                    statusIcon = r.isBase ? '' : (isUndef ? '-' : (rawVal === 0 ? 'OK' : 'X'));
                    valColor = r.isBase ? r.color : (isUndef ? 'var(--text-muted)' : (rawVal === 0 ? 'var(--accent-success)' : r.color));
                }

                rowsHtml += `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:6px 12px; font-size:0.85rem; color:var(--text-secondary);">${statusIcon ? statusIcon + ' ' : ''}${r.label}</td>
                    <td style="padding:6px 12px; font-size:0.85rem; font-weight:600; text-align:right; color:${valColor}; font-family:'Fira Code',monospace;">${display}</td>
                </tr>`;
            });

            breakdownHtml = `
            <div style="background:rgba(99,102,241,0.05); border:1px solid rgba(99,102,241,0.2); border-radius:10px; padding:16px; margin-top:16px;">
                <h4 style="margin:0 0 12px 0; font-size:0.95rem; color:var(--accent-primary); display:flex; align-items:center; gap:8px;">Score Breakdown</h4>
                <table style="width:100%; border-collapse:collapse;">
                    <tbody>
                        ${rowsHtml}
                        <tr style="border-top:2px solid rgba(99,102,241,0.3);">
                            <td style="padding:8px 12px; font-size:0.95rem; font-weight:700; color:var(--text-primary);">Final Score</td>
                            <td style="padding:8px 12px; font-size:1.1rem; font-weight:700; text-align:right; color:var(--accent-primary); font-family:'Fira Code',monospace;">${finalScoreDisplay}/100</td>
                        </tr>
                    </tbody>
                </table>
                ${sb.note ? `<p style="margin:10px 0 0 0; font-size:0.75rem; color:var(--text-muted); font-style:italic;">Note: ${escapeHtml(sb.note)}</p>` : ''}
            </div>`;
        }

        // Render detailed error lists if present
        let errorListHtml = '';
        if (ev.js_errors_list?.length > 0) {
            errorListHtml += `
            <div style="margin-top:16px;">
                <h4 style="color:var(--accent-danger); margin:0 0 8px 0; font-size:0.9rem;">JS Errors (log only - not penalized)</h4>
                <ul style="margin:0; padding-left:20px; font-size:0.8rem; color:var(--text-secondary); max-height:100px; overflow-y:auto;">
                    ${ev.js_errors_list.map(err => `<li>${escapeHtml(err.message)}</li>`).join('')}
                </ul>
            </div>`;
        }
        if (ev.console_errors_list?.length > 0) {
            errorListHtml += `
            <div style="margin-top:16px;">
                <h4 style="color:var(--accent-warning); margin:0 0 8px 0; font-size:0.9rem;">Console Errors (log only - not penalized)</h4>
                <ul style="margin:0; padding-left:20px; font-size:0.8rem; color:var(--text-secondary); max-height:100px; overflow-y:auto;">
                    ${ev.console_errors_list.map(err => `<li>${escapeHtml(err.message)}</li>`).join('')}
                </ul>
            </div>`;
        }
        if (ev.network_errors_list?.length > 0) {
            // Group by URL to avoid spamming the same URL 10 times
            const groupedNetwork = {};
            ev.network_errors_list.forEach(err => {
                const key = err.url;
                if (!groupedNetwork[key]) groupedNetwork[key] = { ...err, count: 0 };
                groupedNetwork[key].count++;
            });
            const uniqueNetwork = Object.values(groupedNetwork);

            errorListHtml += `
            <div style="margin-top:16px;">
                <h4 style="color:var(--accent-warning); margin:0 0 8px 0; font-size:0.9rem;">Network Errors (log only - not penalized)</h4>
                <ul style="margin:0; padding-left:20px; font-size:0.8rem; color:var(--text-secondary); max-height:150px; overflow-y:auto; word-break: break-all;">
                    ${uniqueNetwork.map(err => `<li>${err.count > 1 ? `<b>[${err.count}x]</b> ` : ''}${err.status ? `[${err.status}] ` : ''}${escapeHtml(err.url)}</li>`).join('')}
                </ul>
            </div>`;
        }

        // Deduction reasons section (New Layer)
        let deductionHtml = '';
        const dr = caseReport.score_deduction_reasons;
        if (dr && Array.isArray(dr) && dr.length > 0) {
            const reasonsHtml = dr.map(r => `
                <div style="margin-bottom:8px; display:flex; gap:10px; align-items:flex-start;">
                    <span style="background:rgba(239,68,68,0.1); color:#f87171; font-size:0.7rem; font-weight:700; padding:2px 6px; border-radius:4px; border:1px solid rgba(239,68,68,0.2); text-transform:uppercase; min-width:80px; text-align:center;">${escapeHtml(r.dimension)}</span>
                    <div style="flex:1;">
                        <div style="font-size:0.85rem; color:var(--text-primary); font-weight:500;">-${r.deducted_points} pts: ${escapeHtml(r.reason)}</div>
                        ${r.evidence ? `<div style="font-size:0.75rem; color:var(--text-muted); font-family:'Fira Code', monospace; background:rgba(255,255,255,0.02); padding:4px 8px; border-radius:4px; margin-top:4px;">${escapeHtml(r.evidence)}</div>` : ''}
                    </div>
                </div>
            `).join('');

            deductionHtml = `
            <div style="background:rgba(239,68,68,0.03); border:1px dashed rgba(239,68,68,0.25); border-radius:10px; padding:16px; margin-top:16px;">
                <h4 style="margin:0 0 12px 0; font-size:0.95rem; color:#f87171; display:flex; align-items:center; gap:8px;">Why Score Reduced?</h4>
                ${reasonsHtml}
            </div>`;
        } else if (caseReport.score < 100 && caseReport.status !== 'FATAL') {
            deductionHtml = `
            <div style="background:rgba(156,163,175,0.05); border:1px dashed rgba(156,163,175,0.2); border-radius:8px; padding:12px; margin-top:16px;">
                <p style="margin:0; font-size:0.8rem; color:var(--text-muted); font-style:italic; text-align:center;">No specific deduction reasons found in this report version.</p>
            </div>`;
        }

        return `
        ${fatalHtml}
        <div class="eval-card" style="margin-top:0;">
            <h3>Case Evaluation - Score: ${caseReport.score}/100</h3>
            <div class="eval-stats" style="grid-template-columns:repeat(4,1fr)">
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--text-muted)">${ev.js_errors || 0}</div>
                    <div class="eval-stat-label">JS Errors (log)</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--text-muted)">${ev.network_errors || 0}</div>
                    <div class="eval-stat-label">Network (log)</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:${ev.preview_valid ? 'var(--accent-success)' : 'var(--accent-danger)'}">${ev.preview_valid ? 'PASS' : 'FAIL'}</div>
                    <div class="eval-stat-label">Preview</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:${ev.cart_result === 'PASS' ? 'var(--accent-success)' : 'var(--accent-danger)'}">${ev.cart_result || 'N/A'}</div>
                    <div class="eval-stat-label">Cart</div>
                </div>
            </div>
            ${breakdownHtml}
            ${deductionHtml}
            ${errorListHtml}
        </div>`;
    }

    function renderAiReview(aiReview) {
        if (!aiReview) return '';

        const verdict = aiReview.ai_verdict || 'N/A';
        const vClass = verdict === 'PASS' ? 'badge-pass' : 'badge-fail';
        const confidence = typeof aiReview.confidence === 'number' ? (aiReview.confidence * 100).toFixed(0) : '-';

        // Check for new structured format
        const isStructured = !!(aiReview.summary || aiReview.strengths || aiReview.issues);

        if (isStructured) {
            return `
            <div class="eval-card" style="margin-top:0; border-left: 4px solid ${verdict === 'PASS' ? 'var(--accent-success)' : 'var(--accent-danger)'}; background: rgba(255,255,255,0.02);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:12px;">
                    <div style="display:flex; align-items:center; gap:12px;">
                        <h3 style="margin:0; color:var(--text-primary); font-size:1.1rem;">AI Final QA Review</h3>
                        <span class="badge ${vClass}" style="font-size:0.85rem; padding:4px 12px;">${verdict}</span>
                    </div>
                    <div style="font-size:0.85rem; color:var(--text-secondary);">
                        Confidence: <strong style="color:var(--accent-primary)">${confidence}%</strong>
                    </div>
                </div>

                <div style="margin-bottom:20px;">
                    <p style="font-size:0.95rem; line-height:1.6; color:var(--text-primary); margin:0;">${escapeHtml(aiReview.summary || '')}</p>
                </div>

                ${aiReview.raw_image_description ? `
                <div style="background:rgba(255,255,255,0.03); border-radius:8px; padding:12px; border:1px dashed rgba(255,255,255,0.1); margin-bottom:20px;">
                    <h4 style="color:var(--text-muted); font-size:0.65rem; text-transform:uppercase; margin:0 0 8px 0; letter-spacing:0.05em;">AI Visual Perception (Raw)</h4>
                    <p style="font-size:0.85rem; color:var(--text-secondary); margin:0; line-height:1.5; font-style:italic;">"${escapeHtml(aiReview.raw_image_description)}"</p>
                </div>` : ''}

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:20px;">
                    <!-- Good Points -->
                    <div style="background:rgba(16,185,129,0.05); border-radius:8px; padding:12px; border:1px solid rgba(16,185,129,0.1);">
                        <h4 style="color:var(--accent-success); font-size:0.75rem; text-transform:uppercase; margin:0 0 10px 0; letter-spacing:0.05em; display:flex; align-items:center; gap:6px;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
                            Strengths
                        </h4>
                        <ul style="margin:0; padding-left:18px; font-size:0.85rem; color:var(--text-secondary); line-height:1.5;">
                            ${(aiReview.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}
                        </ul>
                    </div>
                    <!-- Issues -->
                    <div style="background:rgba(239,68,68,0.05); border-radius:8px; padding:12px; border:1px solid rgba(239,68,68,0.1);">
                        <h4 style="color:var(--accent-danger); font-size:0.75rem; text-transform:uppercase; margin:0 0 10px 0; letter-spacing:0.05em; display:flex; align-items:center; gap:6px;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            Detected Issues
                        </h4>
                        <ul style="margin:0; padding-left:18px; font-size:0.85rem; color:var(--text-secondary); line-height:1.5;">
                            ${(aiReview.issues || []).length > 0
                    ? (aiReview.issues || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')
                    : '<li style="list-style:none; margin-left:-18px; color:var(--text-muted); font-style:italic;">No issues found.</li>'}
                        </ul>
                    </div>
                </div>

                <!-- Detailed Notes -->
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:12px; margin-bottom:20px; font-size:0.8rem;">
                    <div style="padding:10px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05);">
                        <div style="color:var(--text-muted); font-size:0.65rem; text-transform:uppercase; margin-bottom:8px; font-weight:700;">Layout</div>
                        <ul style="margin:0; padding-left:14px; color:var(--text-secondary); line-height:1.4;">
                            ${(aiReview.layout_notes || []).length > 0
                    ? aiReview.layout_notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')
                    : '<li style="list-style:none; margin-left:-14px; color:var(--text-muted); font-style:italic;">No notes</li>'}
                        </ul>
                    </div>
                    <div style="padding:10px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05);">
                        <div style="color:var(--text-muted); font-size:0.65rem; text-transform:uppercase; margin-bottom:8px; font-weight:700;">Colors</div>
                        <ul style="margin:0; padding-left:14px; color:var(--text-secondary); line-height:1.4;">
                            ${(aiReview.color_notes || []).length > 0
                    ? aiReview.color_notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')
                    : '<li style="list-style:none; margin-left:-14px; color:var(--text-muted); font-style:italic;">No notes</li>'}
                        </ul>
                    </div>
                    <div style="padding:10px; border-radius:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05);">
                        <div style="color:var(--text-muted); font-size:0.65rem; text-transform:uppercase; margin-bottom:8px; font-weight:700;">Content</div>
                        <ul style="margin:0; padding-left:14px; color:var(--text-secondary); line-height:1.4;">
                            ${(aiReview.content_notes || []).length > 0
                    ? aiReview.content_notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')
                    : '<li style="list-style:none; margin-left:-14px; color:var(--text-muted); font-style:italic;">No notes</li>'}
                        </ul>
                    </div>
                </div>

                <!-- Recommendations -->
                ${(aiReview.recommendations || []).length > 0 ? `
                <div style="background:rgba(99,102,241,0.05); border-radius:8px; padding:12px; border:1px solid rgba(99,102,241,0.1);">
                    <h4 style="color:var(--accent-primary); font-size:0.75rem; text-transform:uppercase; margin:0 0 8px 0; letter-spacing:0.05em;">Recommendations</h4>
                    <ul style="margin:0; padding-left:18px; font-size:0.85rem; color:var(--text-secondary); line-height:1.5;">
                        ${aiReview.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
                    </ul>
                </div>` : ''}
            </div>`;
        }

        // Legacy rendering for old reports
        return `
        <div class="eval-card" style="margin-top:0; background:rgba(99,102,241,0.05); border-color:rgba(99,102,241,0.3);">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
                <div>
                    <h3 style="color:var(--accent-primary); display:flex; align-items:center; gap:8px; margin: 0 0 8px 0;">
                        AI Final QA Review
                        <span class="badge ${vClass}">${verdict}</span>
                    </h3>
                    <p style="font-size:0.9rem; color:var(--text-primary); margin:0;">
                        <span style="color:var(--text-muted); font-size: 0.8rem; text-transform:uppercase;">Reason:</span><br>
                        ${escapeHtml(aiReview.ai_reason || 'N/A')}
                    </p>
                </div>
            </div>

            ${aiReview.detected_elements && aiReview.detected_elements.length > 0 ? `
            <div style="margin-top:20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 16px;">
                <h4 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 12px; letter-spacing: 0.05em;">
                    AI Detected Customizations (${aiReview.detected_elements.length})
                </h4>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px;">
                    ${aiReview.detected_elements.map(el => {
            const statusColor = el.match ? 'var(--accent-success)' : 'var(--accent-danger)';
            return `
                            <div style="background: rgba(0,0,0,0.15); padding:10px; border-radius:8px; border-top: 3px solid ${statusColor}; display:flex; flex-direction:column; gap:6px;">
                                <div style="font-size:0.7rem; color:var(--text-muted); font-weight:700; line-height:1.2; text-transform:uppercase;">
                                    ${escapeHtml(el.field || 'Field')}
                                </div>
                                <div style="font-size:0.8rem; font-weight:600;">Exp: ${escapeHtml(String(el.expected || 'N/A'))}</div>
                                <div style="font-size:0.8rem; font-weight:600; color:${statusColor}">Det: ${escapeHtml(String(el.detected || 'N/A'))}</div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>` : ''}

            ${aiReview.reviewed_image ? `
            <div style="margin-top:20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 16px;">
                <h4 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 12px; letter-spacing: 0.05em; display:flex; align-items:center; gap:8px;">
                    AI Final Review Evidence
                </h4>
                <img src="${aiReview.reviewed_image}" style="width:100%; border-radius:8px; border:1px solid rgba(255,255,255,0.1); cursor:zoom-in" onclick="window.open(this.src)">
            </div>` : ''}
        </div>`;
    }

    function renderFinalEvaluation(run) {
        if (!run.final_evaluation) return '';
        const ev = run.final_evaluation;
        return `
        <div class="eval-card">
            <h3>Final Evaluation</h3>
            <div class="eval-stats" style="grid-template-columns:repeat(5,1fr)">
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--accent-danger)">${ev.js_errors || 0}</div>
                    <div class="eval-stat-label">JS Errors</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--accent-warning)">${ev.network_errors || 0}</div>
                    <div class="eval-stat-label">Network Errors</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:${ev.preview_valid ? 'var(--accent-success)' : 'var(--accent-danger)'}">${ev.preview_valid ? 'PASS' : 'FAIL'}</div>
                    <div class="eval-stat-label">Preview</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:${ev.cart_result === 'PASS' ? 'var(--accent-success)' : 'var(--accent-danger)'}">${ev.cart_result || 'N/A'}</div>
                    <div class="eval-stat-label">Cart</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--text-primary)">${ev.ui_interaction_score || '-'}</div>
                    <div class="eval-stat-label">Steps Done</div>
                </div>
            </div>
            ${typeof run.ai_score === 'number' && run.ai_score >= 0
                ? `<div style="text-align:center;margin:12px 0 8px;font-size:0.85rem;color:var(--text-secondary)">AI Score: <strong style="color:var(--accent-primary)">${run.ai_score}/100</strong></div>`
                : ''}
            <div class="eval-summary">${escapeHtml(ev.summary || '')}</div>
        </div>`;
    }
    // ============================================================
    // SETTINGS
    // ============================================================
    // Load settings on init
    async function loadSettings() {
        const local = loadFromStorage('qa_settings') || {};

        // Try to fetch from server as primary source
        try {
            const res = await Auth.fetch('/api/settings');
            if (res.ok) {
                const s = await res.json();
                if (s.timeout) $('#setting-timeout').value = s.timeout;
                else if (local.timeout) $('#setting-timeout').value = local.timeout;

                if (s.headless) $('#setting-headless').value = s.headless;
                else if (local.headless) $('#setting-headless').value = local.headless;

                if (s.DAILY_NEW_TC_LIMIT !== undefined) {
                    $('#setting-daily-new-limit').value = s.DAILY_NEW_TC_LIMIT;
                } else if (local.DAILY_NEW_TC_LIMIT) {
                    $('#setting-daily-new-limit').value = local.DAILY_NEW_TC_LIMIT;
                }

                // New Auto-Pass settings
                if (s.DIFF_AUTO_PASS_ZERO !== undefined) {
                    $('#setting-auto-pass-zero').checked = s.DIFF_AUTO_PASS_ZERO === 'true';
                }
                if (s.DIFF_AUTO_PASS_HIGH !== undefined) {
                    $('#setting-auto-pass-high').value = s.DIFF_AUTO_PASS_HIGH;
                }

                if (s.customImageFilename || local.customImageFilename) {
                    const fname = s.customImageFilename || local.customImageFilename;
                    $('#setting-custom-image-preview').style.display = 'block';
                    $('#setting-custom-image-preview').querySelector('img').src = `/images/${fname}?t=${Date.now()}`;
                }

                if (s.DAILY_REPORT_TIME !== undefined) $('#setting-daily-report-time').value = s.DAILY_REPORT_TIME;
                if (s.DAILY_REPORT_TO !== undefined) $('#setting-daily-report-to').value = s.DAILY_REPORT_TO;
                if (s.DAILY_REPORT_CC !== undefined) $('#setting-daily-report-cc').value = s.DAILY_REPORT_CC;

                return;
            }
        } catch (e) {
            console.warn('Unable to fetch settings from server, using local fallback:', e);
        }

        // Fallback to local storage
        if (local.timeout) $('#setting-timeout').value = local.timeout;
        if (local.headless) $('#setting-headless').value = local.headless;
        if (local.DAILY_NEW_TC_LIMIT) $('#setting-daily-new-limit').value = local.DAILY_NEW_TC_LIMIT;
        
        if (local.DAILY_REPORT_TIME !== undefined) $('#setting-daily-report-time').value = local.DAILY_REPORT_TIME;
        if (local.DAILY_REPORT_TO !== undefined) $('#setting-daily-report-to').value = local.DAILY_REPORT_TO;
        if (local.DAILY_REPORT_CC !== undefined) $('#setting-daily-report-cc').value = local.DAILY_REPORT_CC;

        if (local.customImageFilename) {
            $('#setting-custom-image-preview').style.display = 'block';
            $('#setting-custom-image-preview').querySelector('img').src = `/images/${local.customImageFilename}?t=${Date.now()}`;
        }
    }
    loadSettings();

    // Image preview when selected
    $('#setting-custom-image').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                $('#setting-custom-image-preview').style.display = 'block';
                $('#setting-custom-image-preview').querySelector('img').src = e.target.result;
            };
            reader.readAsDataURL(file);
        }
    });

    $('#btn-save-settings').addEventListener('click', async () => {
        const timeout = $('#setting-timeout').value;
        const headless = $('#setting-headless').value;
        const dailyNewLimit = $('#setting-daily-new-limit').value;
        const autoPassZero = $('#setting-auto-pass-zero').checked;
        const autoPassHigh = $('#setting-auto-pass-high').value;

        const btn = $('#btn-save-settings');
        const ogText = btn.innerHTML;

        const settingsToSave = {
            timeout,
            headless,
            DAILY_NEW_TC_LIMIT: String(dailyNewLimit),
            DIFF_AUTO_PASS_ZERO: String(autoPassZero),
            DIFF_AUTO_PASS_HIGH: String(autoPassHigh),
            DAILY_REPORT_TIME: $('#setting-daily-report-time').value,
            DAILY_REPORT_TO: $('#setting-daily-report-to').value,
            DAILY_REPORT_CC: $('#setting-daily-report-cc').value
        };

        // Handle custom image upload
        const fileInput = $('#setting-custom-image');
        if (fileInput.files.length > 0) {
            btn.innerHTML = '<span class="loading-spinner"></span> Uploading...';
            btn.disabled = true;

            try {
                const file = fileInput.files[0];
                const reader = new FileReader();

                const base64Data = await new Promise((resolve) => {
                    reader.onload = () => resolve(reader.result);
                    reader.readAsDataURL(file);
                });

                const res = await Auth.fetch('/api/upload-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imageBase64: base64Data, filename: file.name })
                });

                if (res.ok) {
                    const data = await res.json();
                    settingsToSave.customImageFilename = data.filename;
                } else {
                    await showPopup({ title: 'Error', message: 'Error uploading image' });
                }
            } catch (e) {
                console.error(e);
                await showPopup({ title: 'Upload Failed', message: 'Upload failed: ' + e.message });
            }
        } else {
            // retain old valid filename if we didn't upload a new one
            const local = loadFromStorage('qa_settings') || {};
            if (local.customImageFilename) {
                settingsToSave.customImageFilename = local.customImageFilename;
            }
        }

        // Save to server
        btn.innerHTML = '<span class="loading-spinner"></span> Syncing...';
        btn.disabled = true;
        try {
            const res = await Auth.fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settingsToSave)
            });
            if (!res.ok) throw new Error('Failed to sync settings to server');
        } catch (e) {
            console.error(e);
            await showPopup({ title: 'Sync Error', message: 'Could not save to .env: ' + e.message });
        }

        saveToStorage('qa_settings', settingsToSave);
        btn.innerHTML = ogText;
        btn.disabled = false;
        await showPopup({ title: 'Success', message: 'Settings saved and synced!' });

        // Clear file input so it doesn't re-upload on next save
        fileInput.value = '';
    });

    const btnRunDailyNew = $('#btn-run-daily-new');
    if (btnRunDailyNew) {
        btnRunDailyNew.addEventListener('click', async () => {
            const limit = Number.parseInt($('#setting-daily-new-limit')?.value || '20', 10) || 20;
            const headless = $('#setting-headless') ? $('#setting-headless').value !== 'false' : true;
            const useAi = $('#checkbox-use-ai') ? $('#checkbox-use-ai').checked : true;
            const currentSettings = loadFromStorage('qa_settings') || {};
            const customImageFilename = currentSettings.customImageFilename || undefined;

            const confirmed = await showPopup({
                title: 'Queue Daily New Run',
                message: `Queue toi da <b>${limit}</b> test case moi chua tung chay?<br><br>Server queue hien tai se xu ly theo hang doi, mac dinh 5 TC chay cung luc.`,
                okText: 'Queue Now',
                cancelText: 'Cancel',
                isConfirm: true
            });
            if (!confirmed) return;

            const originalHtml = btnRunDailyNew.innerHTML;
            btnRunDailyNew.disabled = true;
            btnRunDailyNew.innerHTML = '<span class="loading-spinner"></span> Queueing...';

            try {
                const res = await Auth.fetch('/api/batches/daily-new', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        limit,
                        headless,
                        useAi,
                        customImageFilename
                    })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

                await syncAllFromApi({ render: true, includeReports: false });
                await showPopup({
                    title: 'Daily Batch Queued',
                    message: `Da queue <b>${data.queuedCount || 0}</b>/<b>${data.selectedCount || 0}</b> TC moi.<br>Batch ID: <code>${escapeHtml(data.batchId || '-')}</code><br>Queue concurrency: <b>${data.queueConcurrency || 5}</b>`
                });
            } catch (err) {
                console.error('Daily new batch failed:', err);
                await showPopup({ title: 'Batch Failed', message: 'Khong the queue daily batch: ' + err.message });
            } finally {
                btnRunDailyNew.disabled = false;
                btnRunDailyNew.innerHTML = originalHtml;
            }
        });
    }

    // ============================================================
    // API INTEGRATION: Trigger Backend Engine
    // ============================================================
    async function triggerTestRun(testCase, buttonEl, isHeadless, useAi = true, options = {}) {
        if (!testCase || !testCase.url) return;

        const testCaseId = String(testCase.id || testCase.url);

        // âœ… 1. NgÄƒn cháº·n cháº¡y trÃ¹ng
        if (state.runningTests.has(testCaseId)) {
            await showPopup({
                title: 'Busy',
                message: 'Test case nÃ y Ä‘ang cháº¡y! Vui lÃ²ng Ä‘á»£i hoÃ n thÃ nh.'
            });
            return;
        }

        const originalText = buttonEl.innerHTML;
        buttonEl.innerHTML = '<span class="loading-spinner"></span> Running...';
        buttonEl.disabled = true;

        // âœ… 2. Cáº­p nháº­t tráº¡ng thÃ¡i LOCAL - KHÃ”NG sync toÃ n bá»™
        testCase.status = 'RUNNING';
        testCase._startTimestamp = Date.now();
        saveToStorage('qa_test_cases', state.testCases);

        // âœ… 3. Chá»‰ re-render Test Cases page (nhanh hÆ¡n nhiá»u)
        if (state.currentPage === 'test-cases') {
            renderTestCases();
        }

        const tcCard = buttonEl.closest('.test-case-card');
        let progressEl = createProgressElement(tcCard, isHeadless, useAi);

        try {
            const currentSettings = loadFromStorage('qa_settings') || {};
            const effectiveTcCode = String(options.tcCodeOverride || testCase.tc_code || testCase.name || '').trim();
            const effectiveConcurrency = Number.parseInt(options.concurrency || currentSettings.concurrency || 2, 10) || 2;
            const endpoint = testCase.id
                ? `/api/test-cases/${encodeURIComponent(testCase.id)}/run`
                : '/api/run';
            const requestBody = testCase.id
                ? { headless: isHeadless !== false, useAi, customImageFilename: currentSettings.customImageFilename, tcCode: effectiveTcCode, concurrency: effectiveConcurrency }
                : { headless: isHeadless !== false, useAi, customImageFilename: currentSettings.customImageFilename, url: testCase.url, tcCode: effectiveTcCode, concurrency: effectiveConcurrency };

            const res = await Auth.fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to trigger test');
            }

            const { runId } = await res.json();

            // âœ… 4. Táº¡o run object cá»¥c bá»™ ngay láº­p tá»©c
            const newRun = {
                id: runId,
                test_case_id: testCase.id,
                name: testCase.name,
                tc_code: effectiveTcCode || testCase.tc_code || testCase.name,
                report_code: effectiveTcCode || testCase.tc_code || testCase.name,
                url: testCase.url,
                product_url: testCase.url,
                status: 'RUNNING',
                execution_status: 'RUNNING',
                result_status: '',
                _startTimestamp: Date.now(),
                started_at: new Date().toISOString(),
            };
            upsertRun(newRun);
            saveToStorage('qa_test_runs', state.testRuns);

            // Re-render nhanh
            if (state.currentPage === 'dashboard') renderDashboard();

            // âœ… 5. LÆ°u element Ä‘á»ƒ SSE dá»n dáº¹p sau nÃ y
            state.activeElements.set(testCaseId, {
                buttonEl,
                progressEl,
                originalText
            });

        } catch (error) {
            handleTestRunError(testCase, testCaseId, buttonEl, progressEl, originalText, error);
        }
    }

    // âœ… HÃ m táº¡o progress element
    function createProgressElement(tcCard, isHeadless, useAi) {
        if (!tcCard) return null;

        const header = tcCard.querySelector('.card-header');
        if (header) {
            const badge = header.querySelector('.badge');
            if (badge) {
                badge.className = 'badge badge-running';
                badge.innerHTML = '<span class="loading-spinner" style="width:10px;height:10px;border-width:2px;"></span> Running...';
            }
        }

        const progressEl = document.createElement('div');
        progressEl.className = 'run-progress glass-panel';
        progressEl.style.cssText = 'margin-top:12px;padding:12px;background:rgba(56,189,248,0.05);border-left:3px solid var(--accent-primary);display:flex;align-items:center;gap:10px;font-size:0.9rem;';

        const modeText = (isHeadless !== false) ? 'Background' : 'Foreground';
        const aiText = useAi ? '(+ AI) ' : '';
        progressEl.innerHTML = `<span class="loading-spinner" style="width:16px;height:16px;border-width:2px;"></span>
                                <span style="color:var(--text-primary)">Test is running in ${modeText} mode ${aiText}...</span>`;

        const actionsDiv = tcCard.querySelector('.card-actions');
        if (actionsDiv) {
            actionsDiv.insertAdjacentElement('beforebegin', progressEl);
        }

        return progressEl;
    }

    // ============================================================
    // EXPORT DATA (CSV)
    // ============================================================
    const btnExportCsv = $('#btn-export-csv');
    if (btnExportCsv) {
        btnExportCsv.addEventListener('click', () => {
            exportToExcel();
        });
    }

    function exportToExcel() {
        try {
            const selectedIds = new Set(Array.from(state.selectedTestCases).map(String));
            if (selectedIds.size === 0) {
                showPopup({ title: 'No Selection', message: 'Hay tick TC o All Test Cases truoc khi export.' });
                return;
            }

            const selectedCases = state.testCases.filter((tc) => selectedIds.has(String(tc.id)));
            const plainText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const joinList = (value, separator = '; ') => {
                if (Array.isArray(value)) return value.filter(Boolean).map(plainText).filter(Boolean).join(separator);
                return plainText(value);
            };
            const joinMultiline = (value) => {
                if (Array.isArray(value)) return value.filter(Boolean).map(plainText).filter(Boolean).join('\n');
                return plainText(value);
            };
            const formatPercent = (value) => {
                const num = Number(value);
                return Number.isFinite(num) ? `${Math.round(num * 100)}%` : '-';
            };
            const formatScore = (value) => {
                const num = Number(value);
                if (!Number.isFinite(num)) return '-';
                return `${Math.round(num * 10) / 10}`;
            };
            const toYesNo = (value) => value === true ? 'Co' : value === false ? 'Khong' : '-';
            const extractAiReview = (caseReport) => caseReport?.final_evaluation?.ai_review || {};
            const getLatestRunForTc = (tc) => state.testRuns
                .filter((run) => String(run.test_case_id) === String(tc.id) || (tc.tc_code && run.tc_code === tc.tc_code))
                .sort((a, b) => getRunTimeValue(b) - getRunTimeValue(a))[0] || null;
            const normalizeExecutionStatus = (tc, run) =>
                plainText(run?.execution_status || tc.execution_status || ((tc.status === 'QUEUED' || tc.status === 'RUNNING') ? tc.status : 'FINISHED')) || '-';
            const normalizeBusinessStatus = (tc, run) =>
                plainText(run?.report_status || run?.result_status || tc.result_status || ((tc.status !== 'QUEUED' && tc.status !== 'RUNNING') ? tc.status : '')) || '-';
            const normalizeDecision = (run) =>
                plainText(run?.decision || run?.result_status || run?.report_status || run?.status) || '-';
            const aggregateCaseCount = (run, expectedDecision) => (run?.cases || []).filter((caseReport) => {
                const decision = plainText(caseReport.decision || caseReport.status);
                return decision === expectedDecision || (expectedDecision === 'FAIL' && decision === 'FATAL');
            }).length;
            const aggregateStepProgress = (run) => {
                const totals = (run?.cases || []).reduce((acc, caseReport) => {
                    acc.passed += Number(caseReport.passed_steps) || 0;
                    acc.total += Number(caseReport.total_steps) || 0;
                    return acc;
                }, { passed: 0, total: 0 });
                return totals.total ? `${totals.passed}/${totals.total}` : '-';
            };
            const collectDeductions = (run) => {
                const deductions = [];
                (run?.cases || []).forEach((caseReport, caseIndex) => {
                    (caseReport?.score_deduction_reasons || []).forEach((item) => {
                        deductions.push({
                            caseLabel: plainText(caseReport.case_label || caseReport.label || `Case ${caseIndex + 1}`),
                            dimension: plainText(item.dimension || '-'),
                            deductedPoints: Number(item.deducted_points) || 0,
                            reason: plainText(item.reason || '-')
                        });
                    });
                });
                return deductions.sort((a, b) => b.deductedPoints - a.deductedPoints);
            };
            const summarizeTopDeductions = (run, limit = 3) => {
                const items = collectDeductions(run).slice(0, limit);
                if (items.length === 0) return '-';
                return items.map((item) => `${item.caseLabel}: ${item.dimension} (-${item.deductedPoints}) - ${item.reason}`).join('\n');
            };
            const joinCases = (run, picker) => (run?.cases || []).map((caseReport, index) => {
                const aiReview = extractAiReview(caseReport);
                const value = picker(caseReport, aiReview);
                return value ? `${plainText(caseReport.case_label || caseReport.label || `Case ${index + 1}`)}: ${value}` : null;
            }).filter(Boolean).join('\n');
            const summarizeCaseOutcome = (caseReport) => {
                const parts = [];
                const decision = plainText(caseReport?.decision || caseReport?.status);
                if (decision) parts.push(`Case ${decision}`);
                if (Number.isFinite(Number(caseReport?.score))) parts.push(`diem ${formatScore(caseReport.score)}`);
                if (Number.isFinite(Number(caseReport?.confidence_score))) parts.push(`do tin cay ${formatPercent(caseReport.confidence_score)}`);
                if (Number.isFinite(Number(caseReport?.passed_steps)) && Number.isFinite(Number(caseReport?.total_steps))) {
                    parts.push(`step ${caseReport.passed_steps}/${caseReport.total_steps}`);
                }
                const preview = caseReport?.final_evaluation?.preview_valid;
                if (preview === true) parts.push('preview hop le');
                const cart = plainText(caseReport?.final_evaluation?.cart_result);
                if (cart) parts.push(`cart ${cart}`);
                return parts.join(', ') || '-';
            };
            const buildRunReadableSummary = (tc, run) => {
                if (!run) return 'Chua co lan chay de tong hop.';
                const parts = [];
                const decision = normalizeDecision(run);
                parts.push(`Ket luan ${decision}`);
                const passCases = Number(run.passed_cases) || aggregateCaseCount(run, 'PASS_AUTO');
                const reviewCases = Number(run.review_cases) || aggregateCaseCount(run, 'REVIEW');
                const failCases = Number(run.failed_cases) || aggregateCaseCount(run, 'FAIL');
                const totalCases = Number(run.total_cases) || (run.cases || []).length;
                if (totalCases) parts.push(`${passCases}/${totalCases} case PASS, ${reviewCases} REVIEW, ${failCases} FAIL`);
                const steps = aggregateStepProgress(run);
                if (steps !== '-') parts.push(`Tien do step ${steps}`);
                if (Number.isFinite(Number(run.confidence_score))) parts.push(`Do tin cay ${formatPercent(run.confidence_score)}`);
                const reasons = joinList(run.reason_codes);
                if (reasons) parts.push(`Ly do giu ket qua: ${reasons}`);
                const topDeduction = summarizeTopDeductions(run, 1);
                if (topDeduction !== '-') parts.push(`Can xem: ${topDeduction}`);
                return parts.join('. ');
            };
            const buildStepReadableSummary = (step) => {
                const parts = [];
                const finalStatus = plainText(step.step_verdict || step.status);
                if (finalStatus) parts.push(`Buoc ${finalStatus}`);
                if (plainText(step.value_chosen)) parts.push(`Gia tri "${plainText(step.value_chosen)}"`);
                const ocrEval = step.ocr_evaluation || {};
                if (ocrEval.found === true) {
                    parts.push(`OCR thay text${ocrEval.matchDetail ? ` (${plainText(ocrEval.matchDetail)})` : ''}`);
                } else if (ocrEval.found === false && plainText(ocrEval.text)) {
                    parts.push('OCR doc duoc nhung chua xac nhan text');
                }
                const colorEval = step.color_evaluation || {};
                if (plainText(colorEval.result)) parts.push(`Color ${plainText(colorEval.result)}`);
                const temporal = step.temporal_impact || {};
                if (plainText(temporal.severity)) parts.push(`Temporal ${plainText(temporal.severity)}`);
                const aiEval = step.ai_evaluation || {};
                if (plainText(aiEval.ai_verdict || aiEval.verdict)) parts.push(`AI ${plainText(aiEval.ai_verdict || aiEval.verdict)}`);
                return parts.join('. ') || '-';
            };

            const selectedContexts = selectedCases.map((tc) => ({ tc, run: getLatestRunForTc(tc) }));

            const summaryHeaders = [
                'TC ID', 'Ten TC', 'Ma bao cao', 'URL san pham', 'Trang thai chay', 'Ket qua',
                'Decision', 'Reason Codes', 'Diem', 'Diem tho', 'Do tin cay (%)',
                'Case PASS', 'Case REVIEW', 'Case FAIL', 'Step PASS/Tong', 'Thoi gian',
                'AI cuoi', 'AI tom tat (raw)', 'Strengths (raw)', 'Layout (raw)',
                'Colors (raw)', 'Content (raw)', 'Ly do tru diem chinh', 'Tong ket de doc'
            ];
            const summaryRows = selectedContexts.map(({ tc, run }) => [
                tc.id,
                tc.name || '',
                plainText(run?.report_code || run?.tc_code || tc.tc_code) || '-',
                tc.url || '',
                normalizeExecutionStatus(tc, run),
                normalizeBusinessStatus(tc, run),
                normalizeDecision(run),
                joinList(run?.reason_codes) || '-',
                formatScore(run?.score),
                formatScore(run?.raw_score),
                formatPercent(run?.confidence_score),
                Number(run?.passed_cases) || aggregateCaseCount(run, 'PASS_AUTO'),
                Number(run?.review_cases) || aggregateCaseCount(run, 'REVIEW'),
                Number(run?.failed_cases) || aggregateCaseCount(run, 'FAIL'),
                aggregateStepProgress(run),
                run ? formatDurationMs(run.duration_ms || 0) : '-',
                joinCases(run, (caseReport, aiReview) => {
                    const verdict = plainText(aiReview.ai_verdict || aiReview.verdict);
                    if (!verdict) return null;
                    return `${verdict}${Number.isFinite(Number(aiReview.confidence)) ? ` (${formatPercent(aiReview.confidence)})` : ''}`;
                }) || '-',
                joinCases(run, (caseReport, aiReview) => plainText(aiReview.summary || aiReview.ai_reason || aiReview.raw_image_description)) || '-',
                joinCases(run, (caseReport, aiReview) => joinList(aiReview.strengths)) || '-',
                joinCases(run, (caseReport, aiReview) => joinList(aiReview.layout_notes)) || '-',
                joinCases(run, (caseReport, aiReview) => joinList(aiReview.color_notes)) || '-',
                joinCases(run, (caseReport, aiReview) => joinList(aiReview.content_notes)) || '-',
                summarizeTopDeductions(run),
                buildRunReadableSummary(tc, run)
            ]);

            const detailHeaders = [
                'TC ID', 'Ten TC', 'Ma bao cao', 'Run ID', 'Case',
                'Trang thai', 'Decision', 'Reason Codes', 'Diem', 'Diem tho', 'Do tin cay (%)',
                'Step PASS', 'Tong step', 'Thoi gian', 'Preview hop le', 'Cart',
                'AI cuoi', 'AI tu tin (%)', 'AI tom tat (raw)', 'Strengths (raw)',
                'Layout (raw)', 'Colors (raw)', 'Content (raw)', 'Ly do ky thuat',
                'Ly do tru diem', 'Tong ket de doc'
            ];
            const detailRows = [];
            selectedContexts.forEach(({ tc, run }) => {
                (run?.cases || []).forEach((caseReport, caseIndex) => {
                    const aiReview = extractAiReview(caseReport);
                    detailRows.push([
                        tc.id,
                        tc.name || '',
                        plainText(run.report_code || run.tc_code || tc.tc_code) || '-',
                        run.id || '',
                        plainText(caseReport.case_label || caseReport.label || `Case ${caseIndex + 1}`),
                        plainText(caseReport.status) || '-',
                        plainText(caseReport.decision || caseReport.status) || '-',
                        joinList(caseReport.reason_codes) || '-',
                        formatScore(caseReport.score),
                        formatScore(caseReport.raw_score),
                        formatPercent(caseReport.confidence_score),
                        Number(caseReport.passed_steps) || 0,
                        Number(caseReport.total_steps) || 0,
                        formatDurationMs(caseReport.duration_ms || 0),
                        toYesNo(caseReport?.final_evaluation?.preview_valid),
                        plainText(caseReport?.final_evaluation?.cart_result) || '-',
                        plainText(aiReview.ai_verdict || aiReview.verdict) || '-',
                        formatPercent(aiReview.confidence),
                        plainText(aiReview.summary || aiReview.ai_reason || aiReview.raw_image_description) || '-',
                        joinMultiline(aiReview.strengths) || '-',
                        joinMultiline(aiReview.layout_notes) || '-',
                        joinMultiline(aiReview.color_notes) || '-',
                        joinMultiline(aiReview.content_notes) || '-',
                        plainText(caseReport.status_reason) || '-',
                        (caseReport.score_deduction_reasons || []).map((item) =>
                            `${plainText(item.dimension || '-')}: -${Number(item.deducted_points) || 0} - ${plainText(item.reason || '-')}`
                        ).join('\n') || '-',
                        summarizeCaseOutcome(caseReport)
                    ]);
                });
            });

            const stepHeaders = [
                'TC ID', 'Ten TC', 'Ma bao cao', 'Run ID', 'Case', 'Buoc #', 'Ten buoc',
                'Action', 'Nhom', 'Gia tri da chon', 'Ket qua buoc', 'Interaction',
                'Validation', 'Diff', 'SSIM', 'Meaningful Change', 'OCR', 'OCR tin cay (%)',
                'OCR Match', 'Color', 'Temporal', 'AI Verdict', 'AI tin cay (%)',
                'AI Reason (raw)', 'Nhan xet de doc'
            ];
            const stepRows = [];
            selectedContexts.forEach(({ tc, run }) => {
                (run?.cases || []).forEach((caseReport, caseIndex) => {
                    (caseReport.timeline || []).forEach((step, stepIndex) => {
                        const ocrEval = step.ocr_evaluation || {};
                        const colorEval = step.color_evaluation || {};
                        const temporal = step.temporal_impact || {};
                        const aiEval = step.ai_evaluation || {};
                        stepRows.push([
                            tc.id,
                            tc.name || '',
                            plainText(run.report_code || run.tc_code || tc.tc_code) || '-',
                            run.id || '',
                            plainText(caseReport.case_label || caseReport.label || `Case ${caseIndex + 1}`),
                            stepIndex + 1,
                            plainText(step.name) || '-',
                            plainText(step.action) || '-',
                            plainText(step.group_type) || '-',
                            plainText(step.value_chosen) || '-',
                            plainText(step.step_verdict || step.status) || '-',
                            plainText(step.interaction_status) || '-',
                            plainText(step.validation_status) || '-',
                            formatScore(step.diff_score),
                            formatScore(step.ssim_score),
                            typeof step.meaningful_change === 'boolean' ? (step.meaningful_change ? 'Co' : 'Khong') : '-',
                            ocrEval.found === true ? 'Thay text' : (ocrEval.found === false ? 'Khong thay text' : '-'),
                            formatPercent(Number(ocrEval.confidence) / 100),
                            plainText(ocrEval.matchDetail) || '-',
                            plainText(colorEval.result) || '-',
                            plainText(temporal.severity) || '-',
                            plainText(aiEval.ai_verdict || aiEval.verdict) || '-',
                            formatPercent(aiEval.confidence),
                            plainText(aiEval.ai_reason || aiEval.reason) || '-',
                            buildStepReadableSummary(step)
                        ]);
                    });
                });
            });

            const dictionaryHeaders = ['Muc', 'Dien giai'];
            const dictionaryRows = [
                ['THONG TIN CHUNG', 'File Excel nay duoc toi uu de doc nhanh khi review report.'],
                ['Ngon ngu export', 'Tieu de cot va dien giai dung tieng Viet de doc nhanh. Noi dung AI raw duoc giu nguyen ngon ngu goc de tranh sai nghia.'],
                ['Thoi gian export', new Date().toLocaleString()],
                ['So TC duoc chon', selectedIds.size],
                ['TC ID da chon', Array.from(selectedIds).join(', ')],
                ['', ''],
                ['Tong_Quan', 'Moi dong la 1 TC va lay lan chay moi nhat de tong hop.'],
                ['Chi_Tiet_Case', 'Moi dong la 1 case. Day du diem, confidence, AI cuoi va ly do tru diem.'],
                ['Chi_Tiet_Buoc', 'Moi dong la 1 step. Dung khi can truy vet buoc nao gay xung dot hoac bi tru diem.'],
                ['', ''],
                ['Trang thai chay', 'Trang thai tien trinh chay: QUEUED / RUNNING / FINISHED ...'],
                ['Ket qua', 'Ket qua nghiep vu sau khi co report: PASS / REVIEW / FAIL / FATAL.'],
                ['Decision', 'Phan loai cuoi cung cua engine: PASS_AUTO / REVIEW / FAIL_AUTO ...'],
                ['Diem', 'Diem hien thi cuoi cung sau khi da tinh theo reliability.'],
                ['Diem tho', 'Diem truoc khi he thong dieu chinh theo confidence / decision policy.'],
                ['Do tin cay (%)', 'Muc do he thong tu tin vao ket luan cuoi cung.'],
                ['Reason Codes', 'Ma ly do tong quan giu case o PASS / REVIEW / FAIL.'],
                ['Ly do tru diem', 'Tong hop cac ly do bi tru diem co trong report.'],
                ['AI tom tat (raw)', 'Text goc AI duoc giu nguyen de doi chieu khi can.'],
                ['OCR Match', 'Match detail cua OCR: Exact match / Fuzzy match / khong xac nhan.'],
                ['Temporal', 'Muc anh huong temporal neu co: HIGH / FATAL / ...'],
                ['Nhan xet de doc', 'Cot he thong dien giai gon de reviewer doc nhanh ma khong can mo JSON.']
            ];

            if (typeof XLSX === 'undefined') {
                throw new Error('XLSX library not loaded. Please check your internet connection and reload.');
            }

            const wb = XLSX.utils.book_new();

            XLSX.utils.book_append_sheet(
                wb,
                XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]),
                'Tong_Quan'
            );

            XLSX.utils.book_append_sheet(
                wb,
                XLSX.utils.aoa_to_sheet([detailHeaders, ...detailRows]),
                'Chi_Tiet_Case'
            );

            XLSX.utils.book_append_sheet(
                wb,
                XLSX.utils.aoa_to_sheet([stepHeaders, ...stepRows]),
                'Chi_Tiet_Buoc'
            );

            XLSX.utils.book_append_sheet(
                wb,
                XLSX.utils.aoa_to_sheet([dictionaryHeaders, ...dictionaryRows]),
                'Giai_Thich'
            );

            const timestamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
            XLSX.writeFile(wb, `bao_cao_qa_${timestamp}.xlsx`);

        } catch (err) {
            console.error('Export failed:', err);
            showPopup({ title: 'Export Failed', message: err.message });
        }
    }
    async function handleTestRunError(testCase, testCaseId, buttonEl, progressEl, originalText, error) {
        await showPopup({ title: 'Test Failed', message: 'Error: ' + error.message });
        testCase.status = 'PENDING';
        saveToStorage('qa_test_cases', state.testCases);

        if (progressEl) progressEl.remove();
        buttonEl.innerHTML = originalText;
        buttonEl.disabled = false;

        state.runningTests.delete(String(testCaseId));

        if (state.currentPage === 'test-cases') renderTestCases();
    }

    // DELETE TEST RUN (server + local sync)
    // ============================================================
    async function deleteTestRun(runId) {
        const confirmed = await showPopup({
            title: 'Delete History',
            message: 'Delete this test run and its report files?',
            okText: 'Delete',
            cancelText: 'Cancel',
            isConfirm: true
        });
        if (!confirmed) return;

        const isImportedOnly = String(runId || '').startsWith('imported_');
        if (isImportedOnly) {
            state.testRuns = state.testRuns.filter((r) => r.id !== runId);
            saveToStorage('qa_test_runs', state.testRuns);
            renderDashboard();
            renderTestCases();
            renderHistory();
            return;
        }

        try {
            const res = await Auth.fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Delete run failed');
            }
            await syncAllFromApi({ render: true });
        } catch (err) {
            await showPopup({ title: 'Error', message: 'Delete run failed: ' + err.message });
        }
    }

    // ============================================================
    // UTILITIES
    // ============================================================
    function generateId() {
        return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    }

    // --- Pagination Helper ---
    function renderPagination(containerId, sectionKey, totalItems) {
        const container = document.getElementById(containerId);
        if (!container) return;

        const { page, pageSize } = state.pagination[sectionKey];
        const totalPages = Math.ceil(totalItems / pageSize);

        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = `
            <button class="pagination-btn" ${page <= 1 ? 'disabled' : ''} data-dir="prev" data-section="${sectionKey}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
                Trang trước
            </button>
            <div class="pagination-info">Trang ${page} / ${totalPages}</div>
            <button class="pagination-btn" ${page >= totalPages ? 'disabled' : ''} data-dir="next" data-section="${sectionKey}">
                Trang sau
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
        `;

        // Attach listeners
        container.querySelectorAll('.pagination-btn').forEach(btn => {
            btn.onclick = () => {
                const dir = btn.dataset.dir;
                if (dir === 'prev' && page > 1) state.pagination[sectionKey].page--;
                else if (dir === 'next' && page < totalPages) state.pagination[sectionKey].page++;

                // Re-render only relevant section
                if (sectionKey === 'dashboard') renderDashboard();
                else if (sectionKey === 'testCases') renderTestCases();
                else if (sectionKey === 'products') renderProducts();
            };
        });
    }

    function extractProductName(url) {
        try {
            const parts = new URL(url).pathname.split('/').filter(Boolean);
            const slug = parts[parts.length - 1] || 'Untitled';
            return slug.replace(/-/g, ' ').replace(/p\d+$/, '').trim().substring(0, 60);
        } catch {
            return 'Untitled Test';
        }
    }

    function formatTime(isoString) {
        if (!isoString) return '-';
        const d = new Date(isoString);
        return d.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function formatElapsedSeconds(totalSeconds) {
        const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (hours > 0) {
            return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
        }
        if (minutes > 0) {
            return `${minutes}m ${String(secs).padStart(2, '0')}s`;
        }
        return `${secs}s`;
    }

    function formatDurationMs(durationMs) {
        const ms = Number(durationMs);
        if (!Number.isFinite(ms) || ms < 0) return '-';
        return formatElapsedSeconds(ms / 1000);
    }

    function normalizeRunStatus(status) {
        const s = String(status || '').toUpperCase();
        if (!s) return 'UNKNOWN';
        if (s === 'SUCCESS') return 'PASS';
        if (s === 'ERROR') return 'FAILED';
        if (s === 'DONE') return 'COMPLETED';
        return s;
    }

    function getUiStatusMeta(status) {
        const normalized = normalizeRunStatus(status);
        switch (normalized) {
            case 'PASS':
                return { className: 'pass', label: 'PASS' };
            case 'FAIL':
                return { className: 'fail', label: 'FAIL' };
            case 'FATAL':
                return { className: 'fatal', label: 'FATAL' };
            case 'REVIEW':
                return { className: 'review', label: 'REVIEW' };
            case 'RUNNING':
                return { className: 'running', label: 'RUNNING' };
            case 'QUEUED':
                return { className: 'queued', label: 'QUEUED' };
            case 'READY':
                return { className: 'ready', label: 'READY' };
            case 'FINISHED':
                return { className: 'finished', label: 'FINISHED' };
            case 'COMPLETED':
                return { className: 'finished', label: 'COMPLETED' };
            case 'FAILED':
                return { className: 'fail', label: 'FAILED' };
            case 'PENDING':
                return { className: 'skip', label: 'PENDING' };
            case 'SKIPPED':
                return { className: 'skip', label: 'SKIPPED' };
            default:
                return { className: 'fail', label: normalized || 'UNKNOWN' };
        }
    }

    function getRunTimeIso(run) {
        if (!run || typeof run !== 'object') return '';
        return run.test_time || run.finished_at || run.started_at || run.created_at || '';
    }

    function getRunTimeValue(run) {
        const iso = getRunTimeIso(run);
        const t = iso ? new Date(iso).getTime() : 0;
        return Number.isFinite(t) ? t : 0;
    }

    function normalizeConfidenceScore(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return null;
        return n > 1 ? Math.min(1, n / 100) : Math.min(1, n);
    }

    function normalizeReasonCodes(value) {
        if (Array.isArray(value)) return value.filter(Boolean);
        if (typeof value === 'string' && value.trim()) return value.split(/[;,]/).map(v => v.trim()).filter(Boolean);
        return [];
    }

    function normalizeApiRun(apiRun, existing = null) {
        const merged = { ...(existing || {}), ...(apiRun || {}) };
        const normalizedStatus = normalizeRunStatus(merged.status || merged.execution_status);
        const normalized = {
            ...merged,
            id: merged.id || (existing && existing.id) || generateId(),
            status: normalizedStatus,
            execution_status: merged.execution_status || (['RUNNING', 'QUEUED'].includes(normalizedStatus) ? normalizedStatus : (existing && existing.execution_status) || ''),
            result_status: merged.result_status || merged.report_status || (['PASS', 'FAIL', 'FATAL', 'REVIEW'].includes(normalizedStatus) ? normalizedStatus : (existing && existing.result_status) || ''),
            report_status: merged.report_status || (['PASS', 'FAIL', 'FATAL', 'REVIEW'].includes(normalizedStatus) ? normalizedStatus : (existing && existing.report_status) || ''),
            decision: merged.decision || (existing && existing.decision) || '',
            reason_codes: normalizeReasonCodes(merged.reason_codes || merged.decision_reason_codes || (existing && existing.reason_codes)),
            raw_score: Number.isFinite(Number(merged.raw_score)) ? Number(merged.raw_score) : (Number.isFinite(Number(existing && existing.raw_score)) ? Number(existing.raw_score) : Number(merged.score)),
            quality_score: Number.isFinite(Number(merged.quality_score)) ? Number(merged.quality_score) : (Number.isFinite(Number(existing && existing.quality_score)) ? Number(existing.quality_score) : Number(merged.score)),
            confidence_score: normalizeConfidenceScore(merged.confidence_score) ?? normalizeConfidenceScore(existing && existing.confidence_score),
            name: merged.name || (existing && existing.name) || merged.tc_code || merged.report_code || 'Untitled',
            product_url: merged.product_url || merged.url || (existing && existing.product_url) || '',
            url: merged.url || merged.product_url || (existing && existing.url) || '',
            test_time: merged.test_time || merged.finished_at || merged.started_at || merged.created_at || (existing && existing.test_time) || '',
        };

        if (normalized.status === 'RUNNING') {
            const startIso = normalized.started_at || normalized.created_at || normalized.test_time;
            const parsedTime = startIso ? new Date(startIso).getTime() : 0;
            normalized._startTimestamp = (existing && existing._startTimestamp)
                || (Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : Date.now());
        }

        return normalized;
    }

    function mergeRunWithReport(run, report) {
        const reportCode = report.tc_code || report.qa_code || run.report_code || run.tc_code || null;
        const businessStatusCandidates = [report.result_status, report.report_status, report.status]
            .map((s) => String(s || '').toUpperCase())
            .filter(Boolean);
        const businessStatus = businessStatusCandidates.find((s) => ['PASS', 'FAIL', 'FATAL', 'REVIEW'].includes(s)) || '';
        const merged = {
            ...run,
            ...report,
            id: run.id,
            test_case_id: run.test_case_id || report.test_case_id || null,
            tc_code: report.tc_code || run.tc_code || report.qa_code || null,
            qa_code: report.qa_code || run.qa_code || null,
            report_code: reportCode,
            name: run.name || report.name || report.test_case_label || reportCode || 'Untitled',
            product_url: report.product_url || run.product_url || run.url || '',
            url: run.url || report.product_url || '',
            test_time: report.test_time || run.test_time || run.finished_at || run.started_at || run.created_at || '',
            status: normalizeRunStatus(businessStatus || run.status || report.execution_status),
            execution_status: report.execution_status || run.execution_status || (businessStatus ? 'FINISHED' : normalizeRunStatus(run.status)),
            result_status: businessStatus || run.result_status || '',
            report_status: report.report_status || businessStatus || run.report_status || '',
            decision: report.decision || run.decision || '',
            reason_codes: normalizeReasonCodes(report.reason_codes || report.decision_reason_codes || run.reason_codes),
            raw_score: Number.isFinite(Number(report.raw_score)) ? Number(report.raw_score) : (Number.isFinite(Number(run.raw_score)) ? Number(run.raw_score) : Number(report.score ?? run.score)),
            quality_score: Number.isFinite(Number(report.quality_score)) ? Number(report.quality_score) : (Number.isFinite(Number(run.quality_score)) ? Number(run.quality_score) : Number(report.score ?? run.score)),
            confidence_score: normalizeConfidenceScore(report.confidence_score) ?? normalizeConfidenceScore(run.confidence_score),
            score: Number.isFinite(Number(report.score)) ? Number(report.score) : run.score,
            total_cases: Number.isFinite(Number(report.total_cases)) ? Number(report.total_cases) : run.total_cases,
            passed_cases: Number.isFinite(Number(report.passed_cases)) ? Number(report.passed_cases) : run.passed_cases,
            failed_cases: Number.isFinite(Number(report.failed_cases)) ? Number(report.failed_cases) : run.failed_cases,
            total_steps: Number.isFinite(Number(report.total_steps)) ? Number(report.total_steps) : run.total_steps,
            passed_steps: Number.isFinite(Number(report.passed_steps)) ? Number(report.passed_steps) : run.passed_steps,
            failed_steps: Number.isFinite(Number(report.failed_steps)) ? Number(report.failed_steps) : run.failed_steps,
        };

        if (merged.status === 'RUNNING') {
            const startIso = merged.started_at || merged.test_time;
            const parsedTime = startIso ? new Date(startIso).getTime() : 0;
            merged._startTimestamp = run._startTimestamp
                || (Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : Date.now());
        }

        return merged;
    }

    function normalizeReportAsRun(report) {
        const code = report.tc_code || report.qa_code || null;
        const status = normalizeRunStatus(report.result_status || report.report_status || report.status || 'COMPLETED');
        return {
            id: report.id || `report_${code || Date.now()}`,
            name: report.name || report.test_case_label || code || 'Untitled',
            product_url: report.product_url || '',
            url: report.product_url || '',
            test_time: report.test_time || '',
            status,
            execution_status: report.execution_status || (['RUNNING', 'QUEUED'].includes(status) ? status : 'FINISHED'),
            result_status: report.result_status || report.report_status || (['PASS', 'FAIL', 'FATAL', 'REVIEW'].includes(status) ? status : ''),
            report_status: report.report_status || report.result_status || '',
            decision: report.decision || '',
            reason_codes: normalizeReasonCodes(report.reason_codes || report.decision_reason_codes),
            raw_score: Number.isFinite(Number(report.raw_score)) ? Number(report.raw_score) : Number(report.score),
            quality_score: Number.isFinite(Number(report.quality_score)) ? Number(report.quality_score) : Number(report.score),
            confidence_score: normalizeConfidenceScore(report.confidence_score),
            score: report.score,
            total_steps: report.total_steps || 0,
            passed_steps: report.passed_steps || 0,
            failed_steps: report.failed_steps || 0,
            total_cases: report.total_cases || 0,
            passed_cases: report.passed_cases || 0,
            failed_cases: report.failed_cases || 0,
            cases: report.cases || [],
            timeline: report.timeline || [],
            final_evaluation: report.final_evaluation || {},
            tc_code: report.tc_code || report.qa_code || null,
            qa_code: report.qa_code || null,
            report_code: code,
            source: report.source || 'report-only',
        };
    }

    function upsertRun(nextRun) {
        const nextId = String(nextRun && nextRun.id || '');
        if (!nextId) {
            state.testRuns.push(nextRun);
            return;
        }

        let inserted = false;
        const deduped = [];
        for (const run of state.testRuns) {
            if (String(run.id) === nextId) {
                if (!inserted) {
                    deduped.push({ ...run, ...nextRun });
                    inserted = true;
                }
                continue;
            }
            deduped.push(run);
        }

        if (!inserted) deduped.push(nextRun);
        state.testRuns = deduped;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = String(str ?? '');
        return div.innerHTML;
    }

    function showPopup({ title = 'Notification', message = '', okText = 'OK', cancelText = 'Cancel', isConfirm = false, confirm = false } = {}) {
        return new Promise((resolve) => {
            const modal = $('#modal-popup');
            const titleEl = $('#popup-title');
            const messageEl = $('#popup-message');
            const okBtn = $('#btn-popup-ok');
            const cancelBtn = $('#btn-popup-cancel');
            const closeBtn = $('#btn-close-popup');
            const isConfirmMode = Boolean(isConfirm || confirm);

            if (!modal || !titleEl || !messageEl || !okBtn || !cancelBtn || !closeBtn) {
                if (isConfirmMode) {
                    resolve(window.confirm(String(message).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')));
                } else {
                    window.alert(String(message).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
                    resolve(true);
                }
                return;
            }

            titleEl.textContent = title;
            messageEl.innerHTML = message;
            okBtn.textContent = okText;
            cancelBtn.textContent = cancelText;
            cancelBtn.style.display = isConfirmMode ? 'inline-flex' : 'none';

            function cleanup() {
                modal.style.display = 'none';
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                closeBtn.removeEventListener('click', onCancel);
            }

            function onOk() {
                cleanup();
                resolve(true);
            }

            function onCancel() {
                cleanup();
                resolve(false);
            }

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            closeBtn.addEventListener('click', onCancel);
            modal.style.display = 'flex';
        });
    }

    function saveToStorage(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));
        } catch (e) {
            console.warn('localStorage save failed:', e);
        }
    }

    function loadFromStorage(key) {
        try {
            const data = localStorage.getItem(key);
            return data ? JSON.parse(data) : null;
        } catch (e) {
            return null;
        }
    }

    // ============================================================
    // INIT & DATA FETCHING
    // ============================================================
    async function fetchTestCases() {
        try {
            const res = await Auth.fetch('/api/test-cases');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const apiTestCases = await res.json();
            state.testCases = (Array.isArray(apiTestCases) ? apiTestCases : []).map((tc) => ({
                ...tc,
                status: tc.status || 'PENDING',
            }));
            saveToStorage('qa_test_cases', state.testCases);
        } catch (err) {
            console.error('Failed to fetch test cases:', err);
        }
    }

    // ============================================================
    // BATCH ACTIONS
    // ============================================================
    function updateBatchUI() {
        const runSelectedBtn = $('#btn-run-selected');
        const countSpan = $('#selected-count');
        const total = state.selectedTestCases.size;
        if (runSelectedBtn) {
            runSelectedBtn.style.display = total > 0 ? 'inline-flex' : 'none';
            if (countSpan) countSpan.textContent = total;
        }
    }

    async function triggerBatchRun(ids) {
        const runSelectedBtn = $('#btn-run-selected');
        if (!runSelectedBtn) return;

        runSelectedBtn.disabled = true;
        const originalHtml = runSelectedBtn.innerHTML;
        runSelectedBtn.innerHTML = '<span class="loading-spinner" style="width:12px;height:12px;border-width:2px;margin-right:8px;"></span>Queuing...';

        const isHeadless = $('#checkbox-headless') ? $('#checkbox-headless').checked : true;
        const useAi = $('#checkbox-use-ai') ? $('#checkbox-use-ai').checked : true;
        const batchId = 'BATCH_' + Date.now();

        for (const id of ids) {
            try {
                // Small delay to prevent network congestion
                await new Promise(r => setTimeout(r, 80));
                await Auth.fetch(`/api/test-cases/${id}/run`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        headless: isHeadless,
                        useAi: useAi,
                        batchId: batchId,
                        source: 'dashboard-batch'
                    })
                });
            } catch (err) {
                console.error(`Failed to queue test case ${id}:`, err);
            }
        }

        // Uncheck all after starting
        state.selectedTestCases.clear();
        updateBatchUI();
        if (state.currentPage === 'test-cases') renderTestCases();

        runSelectedBtn.disabled = false;
        runSelectedBtn.innerHTML = originalHtml;

        // Final sync and render
        await syncAllFromApi({ render: true, includeReports: false });
    }

    // Event listeners attached ONCE
    document.addEventListener('click', async (e) => {
        if (e.target.id === 'tc-select-all' || e.target.id === 'btn-select-all') {
            const listEl = $('#test-cases-list');
            if (!listEl) return;

            const visibleCheckboxes = listEl.querySelectorAll('.tc-checkbox');
            const allVisibleSelected = Array.from(visibleCheckboxes).every(cb => state.selectedTestCases.has(cb.dataset.tcId));

            visibleCheckboxes.forEach(cb => {
                const id = cb.dataset.tcId;
                if (allVisibleSelected) {
                    state.selectedTestCases.delete(id);
                } else {
                    state.selectedTestCases.add(id);
                }
            });

            renderTestCases();
            updateBatchUI();
            return;
        }

        if (e.target.closest('#btn-run-selected')) {
            const selectedIds = Array.from(state.selectedTestCases);
            if (selectedIds.length === 0) return;

            const confirmed = await showPopup({
                title: 'Batch Run',
                message: `Run <b>${selectedIds.length}</b> test cases?`,
                okText: 'Run Now',
                cancelText: 'Cancel',
                isConfirm: true
            });

            if (confirmed) {
                triggerBatchRun(selectedIds);
            }
        }
    });

    document.addEventListener('change', (e) => {
        if (e.target.classList.contains('tc-checkbox')) {
            const id = e.target.dataset.tcId;
            if (e.target.checked) state.selectedTestCases.add(id);
            else state.selectedTestCases.delete(id);
            updateBatchUI();

            // Cáº­p nháº­t checkbox Select All náº¿u cáº§n
            const selectAllCb = $('#tc-select-all');
            if (selectAllCb) {
                const visibleIds = Array.from($$('.tc-checkbox')).map(cb => cb.dataset.tcId);
                selectAllCb.checked = visibleIds.every(id => state.selectedTestCases.has(id));
            }
        }
    });

    async function fetchRuns() {
        try {
            const res = await Auth.fetch('/api/runs');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const apiRuns = await res.json();
            const existingById = new Map((state.testRuns || []).map((r) => [r.id, r]));
            const importedOnly = (state.testRuns || []).filter((r) => r.source === 'imported');

            state.testRuns = (Array.isArray(apiRuns) ? apiRuns : []).map((apiRun) => {
                const existing = existingById.get(apiRun.id);
                return normalizeApiRun(apiRun, existing);
            });

            importedOnly.forEach((run) => {
                if (!state.testRuns.find((r) => r.id === run.id)) {
                    state.testRuns.push(run);
                }
            });

            saveToStorage('qa_test_runs', state.testRuns);
        } catch (err) {
            console.error('Failed to fetch runs:', err);
        }
    }

    async function fetchReports() {
        try {
            const res = await Auth.fetch('/api/reports');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const apiReports = await res.json();
            const reports = Array.isArray(apiReports) ? apiReports : [];
            const runsByCode = new Map();

            state.testRuns.forEach((run) => {
                const code = String(run.report_code || run.tc_code || run.qa_code || '').trim();
                if (!code) return;
                if (!runsByCode.has(code)) runsByCode.set(code, []);
                runsByCode.get(code).push(run);
            });

            runsByCode.forEach((list) => {
                list.sort((a, b) => getRunTimeValue(b) - getRunTimeValue(a));
            });

            reports.forEach((report) => {
                if (!report || typeof report !== 'object') return;
                const code = String(report.tc_code || report.qa_code || '').trim();
                let targetRun = null;

                if (code && runsByCode.has(code)) {
                    const candidates = runsByCode.get(code);
                    targetRun = candidates.length > 0 ? candidates.shift() : null;
                }

                if (!targetRun && report.id) {
                    targetRun = state.testRuns.find((r) => r.id === report.id) || null;
                }

                if (targetRun) {
                    upsertRun(mergeRunWithReport(targetRun, report));
                } else {
                    upsertRun(normalizeReportAsRun(report));
                }
            });

            saveToStorage('qa_test_runs', state.testRuns);
        } catch (err) {
            console.error('Failed to fetch reports:', err);
        }
    }

    async function fetchRunDetailById(runId) {
        if (!runId) return null;

        try {
            const res = await Auth.fetch(`/api/runs/${encodeURIComponent(runId)}`);
            if (!res.ok) return null;

            const payload = await res.json();
            const { report, ...runMeta } = payload || {};
            const existing = state.testRuns.find((r) => r.id === runId) || null;

            let hydrated = normalizeApiRun(runMeta, existing);
            if (report) {
                hydrated = mergeRunWithReport(hydrated, report);
            }

            upsertRun(hydrated);
            saveToStorage('qa_test_runs', state.testRuns);
            return hydrated;
        } catch (err) {
            console.error('Failed to fetch run detail:', err);
            return null;
        }
    }

    // ============================================================
    // MANUAL SYNC
    // ============================================================
    const btnSyncDataAction = $('#btn-sync-data');
    if (btnSyncDataAction) {
        btnSyncDataAction.addEventListener('click', async () => {
            const icon = $('#icon-sync');
            const btnText = btnSyncDataAction.querySelector('span');
            const originalText = btnText ? btnText.textContent : 'Sync Data';

            // Loading state
            btnSyncDataAction.disabled = true;
            if (btnText) btnText.textContent = 'Syncing...';
            if (icon) icon.classList.add('loading-spin');

            try {
                await syncAllFromApi({ render: true });
            } catch (err) {
                console.error('Manual sync failed:', err);
                await showPopup({ title: 'Sync Failed', message: 'Sync failed: ' + err.message });
            } finally {
                btnSyncDataAction.disabled = false;
                if (btnText) btnText.textContent = originalText;
                if (icon) icon.classList.remove('loading-spin');
            }
        });
    }

    let syncPromise = null;
    async function syncAllFromApi({ render = true, includeReports = true } = {}) {
        if (syncPromise) return syncPromise;

        syncPromise = (async () => {
            await Promise.all([fetchTestCases(), fetchRuns()]);
            if (includeReports) {
                await fetchReports();
            }
            if (render) {
                renderDashboard();
                renderTestCases();
                renderHistory();
                renderProducts();
            }
        })();

        try {
            await syncPromise;
        } finally {
            syncPromise = null;
        }
    }


    // ============================================================
    // PRODUCT CRAWLER PAGE
    // ============================================================
    const sectionProducts = document.getElementById('page-products');
    const navProducts = document.getElementById('nav-products');
    const productsTbody = document.getElementById('products-tbody');
    const productsEmpty = document.getElementById('products-empty');
    const productsCount = document.getElementById('product-list-count');
    const btnStartCrawl = document.getElementById('btn-start-crawl');
    const btnSyncProducts = document.getElementById('btn-sync-products');
    const crawlerIdsInput = document.getElementById('crawler-ids');
    const crawlerProgressDiv = document.getElementById('crawler-progress');
    const crawlerProgressBar = document.getElementById('crawler-progress-bar');
    const crawlerProgressLabel = document.getElementById('crawler-progress-label');
    const crawlerProgressCount = document.getElementById('crawler-progress-count');

    const checkAllProducts = document.getElementById('check-all-products');
    const btnDeleteSelectedProducts = document.getElementById('btn-delete-selected-products');
    const selectedProductsCount = document.getElementById('selected-products-count');

    async function fetchProducts(render = true) {
        try {
            const res = await Auth.fetch('/api/products');
            if (!res.ok) throw new Error('Failed to fetch products');
            state.products = await res.json();
            if (render) renderProducts();
        } catch (err) {
            console.error('Error fetching products:', err);
        }
    }

    function renderProducts() {
        if (!productsTbody) return;

        productsTbody.innerHTML = '';
        const totalItems = state.products.length;
        const { page, pageSize } = state.pagination.products;
        const paginatedProducts = state.products.slice((page - 1) * pageSize, page * pageSize);

        const existingUrls = new Set(state.testCases.map(tc => tc.url));

        productsEmpty.style.display = 'none';
        productsCount.textContent = `${totalItems} products found`;

        paginatedProducts.forEach(p => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid var(--border-subtle)';
            tr.style.transition = 'background 0.2s ease';

            const key = `${p.product_id}|${p.platform}`;
            const isChecked = state.selectedProducts.has(key);

            tr.innerHTML = `
                <td style="padding: 12px 16px;">
                    <input type="checkbox" class="product-checkbox" data-key="${key}" ${isChecked ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;">
                </td>
                <td style="padding: 12px 16px; font-weight: 500;">${p.product_id}</td>
                <td style="padding: 12px 16px;"><span class="badge" style="background: rgba(255,255,255,0.05);">${p.platform}</span></td>
                <td style="padding: 12px 16px; font-size: 0.8rem; font-family: 'Fira Code', monospace; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <a href="${p.final_url || p.redirect_url}" target="_blank" style="color: var(--accent-primary);">${p.final_url || p.redirect_url}</a>
                </td>
                <td style="padding: 12px 16px;">
                    <span class="badge ${p.customizable ? 'badge-pass' : 'badge-skip'}">${p.customizable ? 'CUSTOM' : 'NORMAL'}</span>
                </td>
                <td style="padding: 12px 16px; font-size: 0.75rem; color: var(--text-muted);">${new Date(p.checked_at).toLocaleString()}</td>
                <td style="padding: 12px 16px; display: flex; gap: 4px;">
                    ${existingUrls.has(p.final_url || p.redirect_url)
                    ? `<button class="btn-ghost btn-sm" style="color: var(--text-muted); cursor: not-allowed;" title="Test case already exists" disabled>TC Exists</button>`
                    : `<button class="btn-ghost btn-sm btn-create-tc" style="color: var(--accent-success);" data-pid="${p.product_id}" data-platform="${p.platform}" data-key="${key}">Create TC</button>`
                }
                    <button class="btn-ghost btn-sm btn-delete-product" data-pid="${p.product_id}" data-platform="${p.platform}">Delete</button>
                </td>
            `;

            tr.addEventListener('mouseenter', () => tr.style.background = 'rgba(255,255,255,0.02)');
            tr.addEventListener('mouseleave', () => tr.style.background = 'transparent');

            productsTbody.appendChild(tr);
        });

        renderPagination('pagination-products', 'products', totalItems);
        updateProductBatchUI();
    }

    function updateProductBatchUI() {
        const selectedCount = state.selectedProducts.size;
        const btnConvert = document.getElementById('btn-convert-to-test-cases');
        const convertCount = document.getElementById('convert-products-count');

        if (selectedCount > 0) {
            btnDeleteSelectedProducts.style.display = 'flex';
            if (btnConvert) btnConvert.style.display = 'flex';

            selectedProductsCount.textContent = selectedCount;
            if (convertCount) convertCount.textContent = selectedCount;
        } else {
            btnDeleteSelectedProducts.style.display = 'none';
            if (btnConvert) btnConvert.style.display = 'none';
        }
    }

    if (btnStartCrawl) {
        btnStartCrawl.addEventListener('click', async () => {
            const idsText = crawlerIdsInput.value.trim();
            if (!idsText) return showPopup({ title: 'Error', message: 'Please enter at least one Product ID.' });

            const ids = idsText.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            const platformRadio = document.querySelector('input[name="crawler-platform"]:checked');
            const platform = platformRadio ? platformRadio.value : 'printerval.com';

            btnStartCrawl.disabled = true;
            crawlerProgressDiv.style.display = 'block';
            crawlerProgressBar.style.width = '0%';
            crawlerProgressLabel.textContent = 'Starting crawler...';
            crawlerProgressCount.textContent = `0/${ids.length}`;

            try {
                const res = await Auth.fetch('/api/products/crawl', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids, platform })
                });

                if (!res.ok) throw new Error('Failed to start crawler');
            } catch (err) {
                console.error('Crawler start error:', err);
                showPopup({ title: 'Error', message: err.message });
                btnStartCrawl.disabled = false;
            }
        });
    }

    if (btnSyncProducts) {
        btnSyncProducts.addEventListener('click', () => fetchProducts(true));
    }

    if (checkAllProducts) {
        checkAllProducts.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            if (isChecked) {
                state.products.forEach(p => state.selectedProducts.add(`${p.product_id}|${p.platform}`));
            } else {
                state.selectedProducts.clear();
            }
            renderProducts();
        });
    }

    if (productsTbody) {
        productsTbody.addEventListener('change', (e) => {
            if (e.target.classList.contains('product-checkbox')) {
                const key = e.target.dataset.key;
                if (e.target.checked) state.selectedProducts.add(key);
                else state.selectedProducts.delete(key);
                updateProductBatchUI();
            }
        });

        productsTbody.addEventListener('click', async (e) => {
            if (e.target.classList.contains('btn-create-tc')) {
                const key = e.target.dataset.key;
                const pid = e.target.dataset.pid;

                try {
                    const res = await Auth.fetch('/api/products/convert-to-test-cases', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ keys: [key] })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        showPopup({ title: 'Success', message: `Test case for ${pid} created.` });
                        syncAllFromApi({ render: true });
                    } else {
                        throw new Error(data.error || 'Failed to create test case');
                    }
                } catch (err) {
                    showPopup({ title: 'Error', message: err.message });
                }
                return;
            }

            if (e.target.classList.contains('btn-delete-product')) {
                const pid = e.target.dataset.pid;
                const platform = e.target.dataset.platform;

                if (await showPopup({
                    title: 'Delete Product',
                    message: `Are you sure you want to delete product ${pid} (${platform})?`,
                    confirm: true
                })) {
                    try {
                        const res = await Auth.fetch('/api/products/batch-delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ids: [`${pid}|${platform}`] })
                        });
                        if (res.ok) fetchProducts(true);
                    } catch (err) {
                        console.error('Delete error:', err);
                    }
                }
            }
        });
    }

    const btnConvertToTestCases = document.getElementById('btn-convert-to-test-cases');
    if (btnConvertToTestCases) {
        btnConvertToTestCases.addEventListener('click', async () => {
            const count = state.selectedProducts.size;
            if (await showPopup({
                title: 'Create Test Cases',
                message: `Create test cases for ${count} selected products?`,
                confirm: true
            })) {
                try {
                    const res = await Auth.fetch('/api/products/convert-to-test-cases', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ keys: Array.from(state.selectedProducts) })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        showPopup({ title: 'Success', message: data.message });
                        state.selectedProducts.clear();
                        if (checkAllProducts) checkAllProducts.checked = false;
                        updateProductBatchUI();
                        syncAllFromApi({ render: true });
                    } else {
                        throw new Error(data.error || 'Failed to create test cases');
                    }
                } catch (err) {
                    showPopup({ title: 'Error', message: err.message });
                }
            }
        });
    }

    if (btnDeleteSelectedProducts) {
        btnDeleteSelectedProducts.addEventListener('click', async () => {
            const count = state.selectedProducts.size;
            if (await showPopup({
                title: 'Delete Selected',
                message: `Are you sure you want to delete ${count} selected products?`,
                confirm: true
            })) {
                try {
                    const res = await Auth.fetch('/api/products/batch-delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids: Array.from(state.selectedProducts) })
                    });
                    if (res.ok) {
                        state.selectedProducts.clear();
                        if (checkAllProducts) checkAllProducts.checked = false;
                        fetchProducts(true);
                    }
                } catch (err) {
                    console.error('Batch delete error:', err);
                }
            }
        });
    }

    function handleSSECrawlerProgress(data) {
        if (!crawlerProgressDiv) return;

        const { count, total, id, result, success } = data;
        const percent = Math.floor((count / total) * 100);

        crawlerProgressBar.style.width = `${percent}%`;
        crawlerProgressLabel.textContent = `Processing ${id}... (${success ? 'Success' : 'Failed'})`;
        crawlerProgressCount.textContent = `${count}/${total}`;

        const existingIdx = state.products.findIndex(p => p.product_id === result.product_id && p.platform === result.platform);
        if (existingIdx >= 0) {
            state.products[existingIdx] = result;
        } else {
            state.products.unshift(result);
        }

        // Use debounced render to avoid UI lag during parallel updates
        if (state.currentPage === 'products') {
            debouncedRenderProducts();
        }
    }

    let renderProductsTimeout = null;
    function debouncedRenderProducts() {
        if (renderProductsTimeout) clearTimeout(renderProductsTimeout);
        renderProductsTimeout = setTimeout(() => {
            renderProducts();
            renderProductsTimeout = null;
        }, 100);
    }

    function handleSSECrawlerFinished(data) {
        if (!crawlerProgressDiv) return;

        crawlerProgressBar.style.width = '100%';
        crawlerProgressLabel.textContent = 'Crawling completed!';
        btnStartCrawl.disabled = false;

        setTimeout(() => {
            crawlerProgressDiv.style.display = 'none';
            fetchProducts(true);
        }, 3000);
    }

    // âœ… Cleanup polling intervals khi Ä‘Ã³ng trang
    window.addEventListener('beforeunload', () => {
        state.runningTests.forEach(({ pollInterval }) => {
            if (pollInterval) clearInterval(pollInterval);
        });
    });


    // ============================================================
    // INITIAL LOAD
    // ============================================================
    // Ensure this runs after all variables and DOM references are declared
    renderDashboard();
    renderTestCases();
    renderHistory();
    syncAllFromApi({ render: true });
    fetchProducts(false); // Background initial load
    initSSE();
})();
