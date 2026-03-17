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
                    const diff = Math.floor((now - startTs) / 1000);
                    el.textContent = diff + 's';
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
            if (tc) tc.status = 'QUEUED';
        }

        const existingRun = state.testRuns.find(r => r.id === runId);
        if (existingRun) {
            existingRun.status = 'QUEUED';
        } else {
            state.testRuns.push({
                id: runId,
                test_case_id: testCaseId,
                name: testName,
                status: 'QUEUED',
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
        
        // Cập nhật state nếu cần
        if (testCaseId) {
            const tc = state.testCases.find(t => t.id === testCaseId);
            if (tc) tc.status = 'RUNNING';
        }

        // Cập nhật hoặc tạo run
        const existingRun = state.testRuns.find(r => r.id === runId);
        if (existingRun) {
            existingRun.status = 'RUNNING';
            existingRun.started_at = new Date().toISOString();
            existingRun._startTimestamp = Date.now();
        } else {
            state.testRuns.push({
                id: runId,
                test_case_id: testCaseId,
                name: testName,
                status: 'RUNNING',
                started_at: new Date().toISOString(),
                _startTimestamp: Date.now()
            });
        }

        state.runningTests.set(testCaseId || runId, { runId, startTime: Date.now() });
        
        saveToStorage('qa_test_runs', state.testRuns);
        saveToStorage('qa_test_cases', state.testCases);

        // Render lại UI
        if (state.currentPage === 'dashboard') renderDashboard();
        if (state.currentPage === 'test-cases') renderTestCases();
    }

    async function handleSSETestFinished(data) {
        const { runId, testCaseId, status } = data;
        
        state.runningTests.delete(testCaseId || runId);

        // Dọn dẹp UI nếu có lưu trong Map
        const elements = state.activeElements.get(testCaseId || runId);
        if (elements) {
            if (elements.progressEl) elements.progressEl.remove();
            if (elements.buttonEl) {
                elements.buttonEl.innerHTML = elements.originalText;
                elements.buttonEl.disabled = false;
            }
            state.activeElements.delete(testCaseId || runId);
        }

        // Cập nhật trạng thái test case
        if (testCaseId) {
            const tc = state.testCases.find(t => t.id === testCaseId);
            if (tc) tc.status = status === 'COMPLETED' ? 'PASS' : 'FAIL';
        }

        // Fetch detail của run này để lấy đầy đủ info
        await fetchRunDetailById(runId);

        // Render lại UI
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

        // ✅ CHỈ sync khi chuyển đến trang cần dữ liệu MỚI
        // KHÔNG sync khi người dùng đang ở trang đó và test đang chạy
        const needsSync = (pageName === 'dashboard' || pageName === 'test-cases' || pageName === 'history');
        const hasRunningTests = state.runningTests.size > 0;

        if (needsSync && !hasRunningTests) {
            // Chỉ sync nếu KHÔNG có test nào đang chạy
            syncAllFromApi({ render: true });
        } else if (needsSync) {
            // Nếu có test đang chạy, chỉ render lại với data hiện có
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
        $('#input-test-name').value = '';
        $('#input-product-url').value = '';
        $('#input-test-name').focus();
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
            const res = await fetch('/api/test-cases', {
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

        // If the dashboard is opened as a raw file:// page, relative API URLs won't work.
        const baseCandidates = window.location.protocol === 'file:'
            ? ['http://localhost:8090', '']
            : [''];

        const errors = [];

        for (const baseUrl of baseCandidates) {
            for (const candidate of endpointCandidates) {
                const url = `${baseUrl}${candidate.path}`;
                try {
                    const res = await fetch(url, { method: candidate.method });
                    if (res.ok) {
                        return;
                    }

                    let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
                    try {
                        const payload = await res.json();
                        if (payload && payload.error) errorMsg = payload.error;
                    } catch (_) {
                        // Ignore non-JSON response bodies.
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
    function renderDashboard() {
        // Apply filters to runs
        const runs = getFilteredRuns(state.testRuns);
        
        // Update match count
        const countEl = $('#filter-match-count');
        if (countEl) countEl.textContent = runs.length;

        // Stats should still reflect ALL runs, not just filtered ones
        const allRuns = state.testRuns;
        const total = allRuns.length;
        const passed = allRuns.filter((r) => normalizeRunStatus(r.status) === 'PASS').length;
        const failed = allRuns.filter((r) => ['FAIL', 'FATAL', 'FAILED'].includes(normalizeRunStatus(r.status))).length;
        const scores = allRuns
            .map((r) => Number(r.score))
            .filter((s) => Number.isFinite(s));
        const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

        $('#stat-total .stat-value').textContent = total;
        $('#stat-passed .stat-value').textContent = passed;
        $('#stat-failed .stat-value').textContent = failed;
        $('#stat-avgScore .stat-value').textContent = avgScore !== null ? `${avgScore}%` : '-';

        const listEl = $('#recent-runs-list');
        if (runs.length === 0) {
            const query = state.searchQuery;
            const emptyText = query
                ? `No test runs match "${escapeHtml(query)}".`
                : `No test runs yet. Click <strong>"New Test"</strong> to start.`;

            listEl.innerHTML = `
                <div class="empty-state glass-panel">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <p>${emptyText}</p>
                </div>`;
            return;
        }

        // Group runs by Test Case ID or Name to show only the latest run per test case
        const latestRunsMap = new Map();
        [...runs]
            .sort((a, b) => getRunTimeValue(a) - getRunTimeValue(b)) // oldest to newest so newest overwrites
            .forEach(run => {
                const key = run.test_case_id || run.name || 'Unknown';
                latestRunsMap.set(key, run);
            });

        const sortedLatestRuns = Array.from(latestRunsMap.values())
            .sort((a, b) => getRunTimeValue(b) - getRunTimeValue(a));

        // Pagination for Dashboard
        const totalItems = sortedLatestRuns.length;
        const { page, pageSize } = state.pagination.dashboard;
        const totalPages = Math.ceil(totalItems / pageSize);
        const paginatedRuns = sortedLatestRuns.slice((page - 1) * pageSize, page * pageSize);

        listEl.innerHTML = paginatedRuns.map((run) => renderRunCard(run)).join('');
        renderPagination('pagination-dashboard', 'dashboard', totalItems);

        // Attach click handlers
        listEl.querySelectorAll('.run-card').forEach((card) => {
            card.addEventListener('click', (e) => {
                // Don't open detail if delete button was clicked
                if (e.target.closest('.btn-delete-run')) return;
                const runId = card.dataset.runId;
                const run = state.testRuns.find((r) => r.id === runId);
                if (run) openDetailModal(run);
            });
        });

        // Attach delete handlers
        listEl.querySelectorAll('.btn-delete-run').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const runId = btn.dataset.runId;
                deleteTestRun(runId);
            });
        });
    }

    function renderRunCard(run) {
        const statusMeta = getUiStatusMeta(run.status);
        const statusClass = statusMeta.className;
        const badgeClass = `badge-${statusClass}`;
        const time = formatTime(getRunTimeIso(run));
        const scoreValue = Number(run.score);
        const score = Number.isFinite(scoreValue) ? `${scoreValue}/100` : '-';

        // Per-case score badges
        let caseBadgesHtml = '';
        if (run.cases && run.cases.length > 0) {
            caseBadgesHtml = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;">';
            run.cases.forEach((c, i) => {
                const cStatus = c.status === 'PASS' ? 'pass' : c.status === 'FATAL' ? 'fatal' : 'fail';
                const bgColor = cStatus === 'pass' ? 'rgba(16,185,129,0.15)' : cStatus === 'fatal' ? 'rgba(185,28,28,0.15)' : 'rgba(239,68,68,0.15)';
                const textColor = cStatus === 'pass' ? 'var(--accent-success)' : cStatus === 'fatal' ? '#f87171' : 'var(--accent-danger)';
                caseBadgesHtml += `<span style="font-size:0.7rem;padding:2px 8px;border-radius:4px;background:${bgColor};color:${textColor};font-weight:600;">Case ${i + 1}: ${c.score}/100</span>`;
            });
            caseBadgesHtml += '</div>';
        }

        // RUNNING or QUEUED badge
        let badgeHtml = '';
        const normalizedStatus = normalizeRunStatus(run.status);
        if (normalizedStatus === 'RUNNING') {
            const startTs = run._startTimestamp || Date.now();
            badgeHtml = `<span class="badge badge-running" style="display:inline-flex;align-items:center;gap:4px;">
                <span class="loading-spinner" style="width:10px;height:10px;border-width:2px;"></span>
                <span data-timer-start="${startTs}">0s</span>
            </span>`;
        } else if (normalizedStatus === 'QUEUED') {
            badgeHtml = `<span class="badge badge-queued">Queued</span>`;
        } else {
            badgeHtml = `<span class="badge ${badgeClass}">${statusMeta.label}</span>`;
        }

        const scoreHtml = (normalizedStatus === 'RUNNING' || normalizedStatus === 'QUEUED')
            ? '<span class="run-score" style="color:var(--text-muted);">-</span>'
            : `<span class="run-score">${score}</span>`;

        return `
        <div class="run-card" data-run-id="${run.id}">
            <div class="run-status-dot ${statusClass}"></div>
            <div class="run-info">
                <div class="run-name">${escapeHtml(run.name)}</div>
                <div class="run-url">${escapeHtml(run.product_url || run.url || '')}</div>
                ${caseBadgesHtml}
            </div>
            <div class="run-meta">
                ${scoreHtml}
                ${badgeHtml}
                <span class="run-time">${time}</span>
                ${normalizeRunStatus(run.status) !== 'RUNNING' ? `<button class="btn-delete-run" data-run-id="${run.id}" data-report-code="${run.tc_code || run.qa_code || ''}" title="Delete this run" style="background:none;border:none;cursor:pointer;padding:4px;color:var(--text-muted);font-size:1rem;opacity:0.6;transition:opacity 0.2s;" onmouseover="this.style.opacity=1;this.style.color='var(--accent-danger)'" onmouseout="this.style.opacity=0.6;this.style.color='var(--text-muted)'">Delete</button>` : ''}
            </div>
        </div>`;
    }

    // ============================================================
    // RENDERING: Test Cases
    // ============================================================
    function renderTestCases() {
        const listEl = $('#test-cases-list');
        const query = state.searchQuery || '';

        const filteredCases = state.testCases.filter(tc => {
            if (!query) return true;
            return tc.name.toLowerCase().includes(query);
        });

        // Pagination for Test Cases
        const totalItems = filteredCases.length;
        const { page, pageSize } = state.pagination.testCases;
        const paginatedCases = filteredCases.slice((page - 1) * pageSize, page * pageSize);

        listEl.innerHTML = paginatedCases.map((tc) => {
            const lastRun = state.testRuns
                .filter((r) => r.test_case_id === tc.id)
                .sort((a, b) => getRunTimeValue(b) - getRunTimeValue(a))[0];
            let statusBadge;
            const statusLower = String(tc.status || '').toLowerCase();
            if (statusLower === 'running') {
                const runningRun = state.testRuns.find(r => r.test_case_id === tc.id && normalizeRunStatus(r.status) === 'RUNNING');
                const startTs = (runningRun && runningRun._startTimestamp) || Date.now();
                statusBadge = `<span class="badge badge-running" style="display:inline-flex;align-items:center;gap:4px;">
                    <span class="loading-spinner" style="width:10px;height:10px;border-width:2px;"></span>
                    <span data-timer-start="${startTs}">0s</span>
                </span>`;
            } else if (statusLower === 'queued' || statusLower === 'QUEUED') {
                statusBadge = '<span class="badge badge-queued">Queued</span>';
            } else if (lastRun) {
                const lastRunStatus = getUiStatusMeta(lastRun.status);
                statusBadge = `<span class="badge badge-${lastRunStatus.className}">${lastRunStatus.label}</span>`;
            } else {
                statusBadge = '<span class="badge badge-running" style="background:rgba(255,255,255,0.05);color:var(--text-muted);">Ready</span>';
            }

            return `
            <div class="test-case-card glass-panel" data-tc-id="${tc.id}">
                <div class="card-checkbox-container" style="position: absolute; top: 12px; left: 12px; z-index: 2;">
                    <input type="checkbox" class="tc-checkbox" data-tc-id="${tc.id}" style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent-primary);">
                </div>
                <div class="card-header" style="padding-left: 30px;">
                    <span class="card-title">${escapeHtml(tc.name)}</span>
                    ${statusBadge}
                </div>
                <div class="card-url" style="padding-left: 30px;">${escapeHtml(tc.url)}</div>
                <div class="card-actions">
                    ${lastRun
                    ? `<button class="btn-primary btn-sm btn-view" data-run-id="${lastRun.id}">View Report</button>
                           <button class="btn-ghost btn-sm btn-rerun" data-tc-id="${tc.id}" style="color:var(--text-secondary)">Run Again</button>`
                    : `<button class="btn-primary btn-sm btn-rerun" data-tc-id="${tc.id}">Run</button>`}
                    <button class="btn-ghost btn-sm btn-delete" data-tc-id="${tc.id}">Delete</button>
                </div>
            </div>`;
        }).join('');

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
                    triggerTestRun(tc, btn, isHeadless, useAi);
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
                    const res = await fetch(`/api/test-cases/${tcId}`, { method: 'DELETE' });
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
                <div class="timeline-item ${statusMeta.className}" data-run-id="${run.id}" style="cursor: pointer;">
                    <div class="timeline-content">
                        <h3>${formatTime(getRunTimeIso(run))} <span class="badge badge-${statusMeta.className}" style="margin-left:8px">${statusMeta.label}</span></h3>
                        <p>Score: ${Number.isFinite(scoreValue) ? scoreValue + '/100' : '-'} - ${run.total_steps || 0} steps</p>
                    </div>
                </div>`;
            }).join('');
        });

        el.innerHTML = html;

        el.querySelectorAll('.timeline-item').forEach((item) => {
            item.addEventListener('click', () => {
                const run = state.testRuns.find((r) => r.id === item.dataset.runId);
                if (run) openDetailModal(run);
            });
        });
    }

    // ============================================================
    // RENDERING: Run Detail (Step-by-Step Timeline)
    // ============================================================
    function renderRunDetail(run) {
        let html = '';

        // Score header
        const statusMeta = getUiStatusMeta(run.status);
        const scoreValue = Number(run.score);
        html += `
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">
            <span class="badge badge-${statusMeta.className}" style="font-size:1rem;padding:8px 16px;">${statusMeta.label}</span>
            <span style="font-size:1.5rem;font-weight:700;">${Number.isFinite(scoreValue) ? scoreValue + '/100' : '-'}</span>
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
                            ${escapeHtml(v)}
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
            let stepClass = 'fail';
            if (step.status === 'PASS') stepClass = 'pass';
            else if (step.status === 'SKIPPED') stepClass = 'skip';

            const isLifecycle = step.group_type === 'lifecycle';

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
                                <span class="step-label">HÀNH ĐỘNG ${step.step_id}</span>
                                <h4 class="step-action-title">${escapeHtml(label)}</h4>
                            </div>
                            <span class="badge badge-${stepClass}">${step.status}</span>
                        </div>
                        
                        ${step.message ? `<div class="step-message" style="margin-top:4px;">${escapeHtml(step.message)}</div>` : ''}
                        
                        ${aiReason ? `
                        <div class="ai-insight-box">
                            <div class="ai-reason-text">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:text-top; margin-right:6px; color:var(--accent-primary);"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-10.6 8.5 8.5 0 0 1 7.6 10.6 Z"></path></svg>
                                <strong>AI Analysis:</strong> ${escapeHtml(aiReason)}
                            </div>
                        </div>` : ''}

                        ${step.state_after
                        ? `<div class="step-images" style="margin-top:10px;">
                            <div class="step-img-container" style="max-width:400px;">
                                <img src="${escapeHtml(step.state_after)}" alt="Evidence">
                                <div class="step-img-label">KẾT QUẢ</div>
                            </div>
                        </div>`
                        : ''}
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
                                <span class="step-label">HÀNH ĐỘNG ${step.step_id}</span>
                                <h4 class="step-action-title">${escapeHtml(step.action)}: <span class="step-name">${escapeHtml(step.name)}</span></h4>
                            </div>
                            <span class="badge badge-${stepClass}">${step.status}</span>
                        </div>
                        
                        <div class="step-selection-row">
                            ${thumbHtml}
                            <span class="step-val-label">Lựa chọn: <span class="step-val-badge">${escapeHtml(step.value_chosen || '')}</span></span>
                            ${colorMetaHtml}
                            ${step.code_evaluation && step.code_evaluation.diff_score >= 0
                    ? `<span class="step-diff" title="Pixelmatch">Audit Code: ${step.code_evaluation.diff_score}%</span>`
                    : (step.diff_score >= 0 ? `<span class="step-diff">Độ lệch: ${step.diff_score}%</span>` : '')}
                        </div>

                        ${step.state_before || step.state_after
                    ? `<div class="step-images">
                                <div class="step-img-container">
                                    ${step.state_before ? `<img src="${escapeHtml(step.state_before)}" alt="Before">` : '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">N/A</div>'}
                                    <div class="step-img-label">TRƯỚC KHI</div>
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
                            : '<div class="step-arrow">→</div>')}
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
                                <span class="meta-label" style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px; text-transform:uppercase;">AI Kiểm Định</span>
                                <span class="meta-value" style="font-size:0.85rem; font-weight:600; color:${step.ai_evaluation?.ai_verdict === 'PASS' ? 'var(--accent-success)' : 'var(--text-muted)'}">
                                    ${step.ai_evaluation?.ai_verdict || 'N/A'}
                                </span>
                            </div>
                            <div class="meta-item" style="padding:8px 12px; background:rgba(0,0,0,0.15); border-radius:8px; border:1px solid rgba(255,255,255,0.03);">
                                <span class="meta-label" style="font-size:0.7rem; color:var(--text-muted); display:block; margin-bottom:2px; text-transform:uppercase;">Mã Audit</span>
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
            const rows = [
                { label: 'Base Score', value: sb.base_score, color: 'var(--text-primary)', isBase: true },
                { label: `Visual Option Fails (x${sb.visual_fail_count || 0})`, value: sb.visual_fail_penalty, color: 'var(--accent-danger)', isPenalty: true },
                { label: `Text Diff Fails (x${sb.text_diff_fail_count || 0})`, value: sb.text_diff_penalty, color: 'var(--accent-danger)', isPenalty: true },
                { label: 'Open Page', value: sb.open_page_penalty, color: 'var(--accent-warning)', isPenalty: true },
                { label: 'Load Customizer', value: sb.load_customizer_penalty, color: 'var(--accent-warning)', isPenalty: true },
                { label: 'Preview Validation', value: sb.preview_validation_penalty, color: 'var(--accent-warning)', isPenalty: true },
                { label: 'Add to Cart', value: sb.add_to_cart_penalty, color: 'var(--accent-warning)', isPenalty: true },
            ];

            let rowsHtml = '';
            rows.forEach(r => {
                const display = r.isBase ? r.value : (r.value === 0 ? '0' : String(r.value));
                const statusIcon = r.isBase ? '' : (r.value === 0 ? 'OK' : 'X');
                const valColor = r.isBase ? r.color : (r.value === 0 ? 'var(--accent-success)' : r.color);
                rowsHtml += `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:6px 12px; font-size:0.85rem; color:var(--text-secondary);">${statusIcon} ${r.label}</td>
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
                            <td style="padding:8px 12px; font-size:1.1rem; font-weight:700; text-align:right; color:var(--accent-primary); font-family:'Fira Code',monospace;">${sb.final_score}/100</td>
                        </tr>
                    </tbody>
                </table>
                <p style="margin:10px 0 0 0; font-size:0.75rem; color:var(--text-muted); font-style:italic;">Note: ${escapeHtml(sb.note || '')}</p>
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
            ${errorListHtml}
        </div>`;
    }

    function renderAiReview(aiReview) {
        if (!aiReview) return '';

        return `
        <div class="eval-card" style="margin-top:0; background:rgba(99,102,241,0.05); border-color:rgba(99,102,241,0.3);">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
                <div>
                    <h3 style="color:var(--accent-primary); display:flex; align-items:center; gap:8px; margin: 0 0 8px 0;">
                        AI Final QA Review
                        <span class="badge ${aiReview.ai_verdict === 'PASS' ? 'badge-pass' : 'badge-fail'}">${aiReview.ai_verdict}</span>
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
                        const toHex = (n) => {
                            const v = Number(n);
                            if (!Number.isFinite(v)) return '00';
                            const byte = Math.max(0, Math.min(255, Math.round(v)));
                            return byte.toString(16).padStart(2, '0');
                        };
                        const hasColor = el.color && typeof el.color.r === 'number' && typeof el.color.g === 'number' && typeof el.color.b === 'number';
                        const rgb = hasColor ? `rgb(${el.color.r},${el.color.g},${el.color.b})` : '';
                        const colorHex = hasColor ? `#${toHex(el.color.r)}${toHex(el.color.g)}${toHex(el.color.b)}`.toUpperCase() : '';
                        const statusColor = el.match ? 'var(--accent-success)' : 'var(--accent-danger)';
                        const expected = el.expected !== undefined && el.expected !== null ? String(el.expected) : 'N/A';
                        const detected = el.detected !== undefined && el.detected !== null ? String(el.detected) : 'N/A';

                        return `
                            <div style="background: rgba(0,0,0,0.15); padding:10px; border-radius:8px; border-top: 3px solid ${el.match ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}; display:flex; flex-direction:column; gap:6px; position:relative; overflow:hidden;">
                                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:4px;">
                                    <div style="font-size:0.7rem; color:var(--text-muted); font-weight:700; line-height:1.2; text-transform:uppercase; flex:1;">
                                        ${escapeHtml(el.field || 'Field')}
                                    </div>
                                    <div style="width:8px; height:8px; border-radius:50%; background:${statusColor}; flex-shrink:0; margin-top:2px;"></div>
                                </div>
                                
                                <div style="display:flex; align-items:center; gap:8px; background:rgba(255,255,255,0.03); padding:6px 8px; border-radius:6px; justify-content:space-between;">
                                    <div style="display:flex; flex-direction:column;">
                                        <span style="font-size:0.55rem; color:var(--text-muted); text-transform:uppercase; line-height:1;">Exp</span>
                                        <span style="font-size:0.8rem; font-weight:600;">${escapeHtml(expected)}</span>
                                    </div>
                                    <div style="font-size:0.8rem; color:var(--text-muted);">→</div>
                                    <div style="display:flex; flex-direction:column; text-align:right;">
                                        <span style="font-size:0.55rem; color:var(--text-muted); text-transform:uppercase; line-height:1;">Det</span>
                                        <span style="font-size:0.8rem; font-weight:600; color:${statusColor}">${escapeHtml(detected)}</span>
                                    </div>
                                </div>

                                ${rgb ? `
                                <div style="display:flex; align-items:center; gap:6px; margin-top:2px; justify-content:flex-end;">
                                    <span style="font-size:0.6rem; color:var(--text-muted); font-family:monospace;">${colorHex}</span>
                                    <div style="width:14px; height:14px; border-radius:3px; background:${rgb}; border:1px solid rgba(255,255,255,0.2);"></div>
                                </div>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>` : ''}

            ${aiReview.reviewed_image ? `
            <div style="margin-top:20px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 16px;">
                <h4 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 12px; letter-spacing: 0.05em; display:flex; align-items:center; gap:8px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    AI Final Review Evidence
                </h4>
                <div style="position:relative; width:100%; border-radius:10px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);">
                    <img src="${aiReview.reviewed_image}" alt="AI Review Image" 
                         style="width:100%; height:auto; display:block; cursor:zoom-in; transition:transform 0.3s;"
                         onclick="window.open(this.src)">
                    <div style="position:absolute; bottom:10px; right:10px; background:rgba(0,0,0,0.6); color:white; padding:4px 10px; border-radius:20px; font-size:0.7rem; backdrop-filter:blur(4px); border:1px solid rgba(255,255,255,0.1);">
                        Annotated Preview
                    </div>
                </div>
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
            const res = await fetch('/api/settings');
            if (res.ok) {
                const s = await res.json();
                if (s.timeout) $('#setting-timeout').value = s.timeout;
                else if (local.timeout) $('#setting-timeout').value = local.timeout;

                if (s.headless) $('#setting-headless').value = s.headless;
                else if (local.headless) $('#setting-headless').value = local.headless;

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
                return;
            }
        } catch (e) {
            console.warn('Unable to fetch settings from server, using local fallback:', e);
        }

        // Fallback to local storage
        if (local.timeout) $('#setting-timeout').value = local.timeout;
        if (local.headless) $('#setting-headless').value = local.headless;
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
        const autoPassZero = $('#setting-auto-pass-zero').checked;
        const autoPassHigh = $('#setting-auto-pass-high').value;
        
        const btn = $('#btn-save-settings');
        const ogText = btn.innerHTML;

        const settingsToSave = { 
            timeout, 
            headless,
            DIFF_AUTO_PASS_ZERO: String(autoPassZero),
            DIFF_AUTO_PASS_HIGH: String(autoPassHigh)
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

                const res = await fetch('/api/upload-image', {
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
            const res = await fetch('/api/settings', {
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

    // ============================================================
    // API INTEGRATION: Trigger Backend Engine
    // ============================================================
    async function triggerTestRun(testCase, buttonEl, isHeadless, useAi = true) {
        if (!testCase || !testCase.url) return;

        const testCaseId = testCase.id || testCase.url;

        // ✅ 1. Ngăn chặn chạy trùng
        if (state.runningTests.has(testCaseId)) {
            await showPopup({ 
                title: 'Busy', 
                message: 'Test case này đang chạy! Vui lòng đợi hoàn thành.' 
            });
            return;
        }

        const originalText = buttonEl.innerHTML;
        buttonEl.innerHTML = '<span class="loading-spinner"></span> Running...';
        buttonEl.disabled = true;

        // ✅ 2. Cập nhật trạng thái LOCAL - KHÔNG sync toàn bộ
        testCase.status = 'RUNNING';
        testCase._startTimestamp = Date.now();
        saveToStorage('qa_test_cases', state.testCases);

        // ✅ 3. Chỉ re-render Test Cases page (nhanh hơn nhiều)
        if (state.currentPage === 'test-cases') {
            renderTestCases();
        }

        const tcCard = buttonEl.closest('.test-case-card');
        let progressEl = createProgressElement(tcCard, isHeadless, useAi);

        try {
            const currentSettings = loadFromStorage('qa_settings') || {};
            const endpoint = testCase.id
                ? `/api/test-cases/${encodeURIComponent(testCase.id)}/run`
                : '/api/run';
            const requestBody = testCase.id
                ? { headless: isHeadless !== false, useAi, customImageFilename: currentSettings.customImageFilename }
                : { headless: isHeadless !== false, useAi, customImageFilename: currentSettings.customImageFilename, url: testCase.url, tcCode: testCase.name };

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to trigger test');
            }

            const { runId } = await res.json();

            // ✅ 4. Tạo run object cục bộ ngay lập tức
            const newRun = {
                id: runId,
                test_case_id: testCase.id,
                name: testCase.name,
                url: testCase.url,
                product_url: testCase.url,
                status: 'RUNNING',
                _startTimestamp: Date.now(),
                started_at: new Date().toISOString(),
            };
            state.testRuns.push(newRun);
            saveToStorage('qa_test_runs', state.testRuns);

            // Re-render nhanh
            if (state.currentPage === 'dashboard') renderDashboard();

            // ✅ 5. Lưu element để SSE dọn dẹp sau này
            state.activeElements.set(testCaseId, {
                buttonEl,
                progressEl,
                originalText
            });

        } catch (error) {
            handleTestRunError(testCase, testCaseId, buttonEl, progressEl, originalText, error);
        }
    }

    // ✅ Hàm tạo progress element
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

    // ✅ Xử lý lỗi
    async function handleTestRunError(testCase, testCaseId, buttonEl, progressEl, originalText, error) {
        await showPopup({ title: 'Test Failed', message: 'Error: ' + error.message });
        testCase.status = 'PENDING';
        saveToStorage('qa_test_cases', state.testCases);

        if (progressEl) progressEl.remove();
        buttonEl.innerHTML = originalText;
        buttonEl.disabled = false;

        state.runningTests.delete(testCaseId);

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
            const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
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
            case 'RUNNING':
                return { className: 'running', label: 'RUNNING' };
            case 'QUEUED':
                return { className: 'queued', label: 'QUEUED' };
            case 'COMPLETED':
                return { className: 'pass', label: 'COMPLETED' };
            case 'FAILED':
                return { className: 'fail', label: 'FAILED' };
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

    function normalizeApiRun(apiRun, existing = null) {
        const merged = { ...(existing || {}), ...(apiRun || {}) };
        const normalized = {
            ...merged,
            id: merged.id || (existing && existing.id) || generateId(),
            status: normalizeRunStatus(merged.status),
            name: merged.name || (existing && existing.name) || merged.tc_code || merged.report_code || 'Untitled',
            product_url: merged.product_url || merged.url || (existing && existing.product_url) || '',
            url: merged.url || merged.product_url || (existing && existing.url) || '',
            test_time: merged.test_time || merged.finished_at || merged.started_at || merged.created_at || (existing && existing.test_time) || '',
        };

        if (normalized.status === 'RUNNING') {
            const startIso = normalized.started_at || normalized.created_at || normalized.test_time;
            const parsedTime = startIso ? new Date(startIso).getTime() : 0;
            normalized._startTimestamp = Number.isFinite(parsedTime) && parsedTime > 0
                ? parsedTime
                : ((existing && existing._startTimestamp) || Date.now());
        }

        return normalized;
    }

    function mergeRunWithReport(run, report) {
        const reportCode = report.tc_code || report.qa_code || run.report_code || run.tc_code || null;
        return {
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
            status: normalizeRunStatus(report.status || run.status),
        };
        
        // Force recount startTimestamp if it's still running
        if (merged.status === 'RUNNING') {
            const startIso = merged.test_time;
            const parsedTime = startIso ? new Date(startIso).getTime() : 0;
            merged._startTimestamp = Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : (run._startTimestamp || Date.now());
        }

        return merged;
    }

    function normalizeReportAsRun(report) {
        const code = report.tc_code || report.qa_code || null;
        return {
            id: report.id || `report_${code || Date.now()}`,
            name: report.name || report.test_case_label || code || 'Untitled',
            product_url: report.product_url || '',
            url: report.product_url || '',
            test_time: report.test_time || '',
            status: normalizeRunStatus(report.status || 'COMPLETED'),
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
        const idx = state.testRuns.findIndex((r) => r.id === nextRun.id);
        if (idx >= 0) {
            state.testRuns[idx] = nextRun;
        } else {
            state.testRuns.push(nextRun);
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Show a custom popup modal (Alert or Confirm)
     * @param {Object} options { title, message, okText, cancelText, isConfirm }
     * @returns {Promise<boolean>}
     */
    function showPopup({ title = 'Notification', message = '', okText = 'OK', cancelText = 'Cancel', isConfirm = false } = {}) {
        return new Promise((resolve) => {
            const modal = $('#modal-popup');
            const titleEl = $('#popup-title');
            const messageEl = $('#popup-message');
            const okBtn = $('#btn-popup-ok');
            const cancelBtn = $('#btn-popup-cancel');
            const closeBtn = $('#btn-close-popup');

            titleEl.textContent = title;
            messageEl.innerHTML = message;
            okBtn.textContent = okText;
            cancelBtn.textContent = cancelText;

            cancelBtn.style.display = isConfirm ? 'inline-flex' : 'none';

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
    // SEARCH
    // ============================================================
    $('#search-input').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!query) {
            renderDashboard();
            return;
        }

        const filtered = state.testRuns.filter((r) =>
            (r.name || '').toLowerCase().includes(query) ||
            (r.product_url || '').toLowerCase().includes(query) ||
            (r.url || '').toLowerCase().includes(query)
        );

        const listEl = $('#recent-runs-list');
        if (filtered.length === 0) {
            listEl.innerHTML = `<div class="empty-state glass-panel"><p>No results for "${escapeHtml(query)}".</p></div>`;
            return;
        }

        listEl.innerHTML = filtered.map((run) => renderRunCard(run)).join('');
        listEl.querySelectorAll('.run-card').forEach((card) => {
            card.addEventListener('click', () => {
                const run = state.testRuns.find((r) => r.id === card.dataset.runId);
                if (run) openDetailModal(run);
            });
        });
    });

    // ============================================================
    // INIT & DATA FETCHING
    // ============================================================
    async function fetchTestCases() {
        try {
            const res = await fetch('/api/test-cases');
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
        const checked = $$('.tc-checkbox:checked');
        const total = checked.length;
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
                await fetch(`/api/test-cases/${id}/run`, {
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
        $$('.tc-checkbox').forEach(cb => cb.checked = false);
        updateBatchUI();
        runSelectedBtn.disabled = false;
        runSelectedBtn.innerHTML = originalHtml;
        
        // Final sync and render
        await syncAllFromApi({ render: true, includeReports: false });
    }

    // Event listeners attached ONCE
    document.addEventListener('click', async (e) => {
        if (e.target.id === 'btn-select-all') {
            const checkboxes = $$('.tc-checkbox');
            const anyUnchecked = Array.from(checkboxes).some(cb => !cb.checked);
            checkboxes.forEach(cb => cb.checked = anyUnchecked);
            updateBatchUI();
        }

        if (e.target.closest('#btn-run-selected')) {
            const selectedIds = Array.from($$('.tc-checkbox:checked')).map(cb => cb.dataset.tcId);
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
            updateBatchUI();
        }
    });

    async function fetchRuns() {
        try {
            const res = await fetch('/api/runs');
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
            const res = await fetch('/api/reports');
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
            const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
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
            const res = await fetch('/api/products');
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
                const res = await fetch('/api/products/crawl', {
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
                    const res = await fetch('/api/products/convert-to-test-cases', {
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
                        const res = await fetch('/api/products/batch-delete', {
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
                    const res = await fetch('/api/products/convert-to-test-cases', {
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
                    const res = await fetch('/api/products/batch-delete', {
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

    // ✅ Cleanup polling intervals khi đóng trang
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
