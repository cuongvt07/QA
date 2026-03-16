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
    };

    // ============================================================
    // DOM REFERENCES
    // ============================================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const pageTitle = $('#page-title');
    const navItems = $$('.nav-item');
    const pages = $$('.page');

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
            'settings': 'Settings',
        };
        pageTitle.textContent = titles[pageName] || 'Dashboard';

        // Refresh content
        if (pageName === 'dashboard') renderDashboard();
        if (pageName === 'test-cases') renderTestCases();
        if (pageName === 'history') renderHistory();
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

    $('#btn-submit-test').addEventListener('click', () => {
        const url = $('#input-product-url').value.trim();

        if (!url) {
            alert('Please enter a Product URL.');
            return;
        }

        // Auto-generate next code: 3 letters + 3 numbers (e.g. MEE001)
        let maxNum = 0;
        state.testCases.forEach(tc => {
            const match = tc.name.match(/[A-Z]{3}(\d{3})/i);
            if (match) {
                maxNum = Math.max(maxNum, parseInt(match[1], 10));
            }
        });
        const name = `MEE${String(maxNum + 1).padStart(3, '0')}`;

        const testCase = {
            id: generateId(),
            name: name,
            url: url,
            created_at: new Date().toISOString(),
            status: 'pending',
        };

        state.testCases.push(testCase);
        saveToStorage('qa_test_cases', state.testCases);

        closeNewTestModal();
        switchPage('test-cases');
        renderTestCases();
    });

    // ============================================================
    // RESET ALL DATA
    // ============================================================
    $('#btn-reset-all').addEventListener('click', async () => {
        if (!confirm('⚠️ Are you sure you want to reset the ENTIRE system?\n\nThis will permanently delete:\n• All test cases\n• All test runs\n• All report files on the server\n\nThis action CANNOT be undone.')) return;

        try {
            // Delete all report folders on the server
            const res = await fetch('/api/reports-all', { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json();
                console.error('Failed to delete server reports:', err);
            }
        } catch (e) {
            console.error('Error calling reset API:', e);
        }

        // Clear all local storage data
        localStorage.removeItem('qa_test_cases');
        localStorage.removeItem('qa_test_runs');
        location.reload();
    });

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
                    alert('Invalid JSON file: ' + err.message);
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
        alert(`✅ Imported: ${run.name} (${run.total_steps} steps)`);
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

    function openDetailModal(run) {
        $('#detail-title').textContent = run.name || 'Test Run Detail';
        const body = $('#detail-body');
        body.innerHTML = renderRunDetail(run);

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

        modalDetail.style.display = 'flex';
    }

    // ============================================================
    // RENDERING: Dashboard
    // ============================================================
    function renderDashboard() {
        const runs = state.testRuns;
        const total = runs.length;
        const passed = runs.filter((r) => r.status === 'PASS').length;
        const failed = runs.filter((r) => r.status === 'FAIL').length;
        const scores = runs.filter((r) => r.score !== undefined).map((r) => parseInt(r.score));
        const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

        $('#stat-total .stat-value').textContent = total;
        $('#stat-passed .stat-value').textContent = passed;
        $('#stat-failed .stat-value').textContent = failed;
        $('#stat-avgScore .stat-value').textContent = avgScore !== null ? `${avgScore}%` : '—';

        const listEl = $('#recent-runs-list');
        if (runs.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state glass-panel">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <p>No test runs yet. Click <strong>"New Test"</strong> to start.</p>
                </div>`;
            return;
        }

        // Group runs by Test Case ID or Name to show only the latest run per test case
        const latestRunsMap = new Map();
        [...runs]
            .sort((a, b) => new Date(a.test_time) - new Date(b.test_time)) // oldest to newest so newest overwrites
            .forEach(run => {
                const key = run.test_case_id || run.name || 'Unknown';
                latestRunsMap.set(key, run);
            });
            
        const sortedLatestRuns = Array.from(latestRunsMap.values())
            .sort((a, b) => new Date(b.test_time) - new Date(a.test_time));

        listEl.innerHTML = sortedLatestRuns.slice(0, 20).map((run) => renderRunCard(run)).join('');

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
                const code = btn.dataset.reportCode;
                deleteTestRun(runId, code);
            });
        });
    }

    function renderRunCard(run) {
        const statusClass = run.status === 'PASS' ? 'pass' : run.status === 'FATAL' ? 'fatal' : run.status === 'RUNNING' ? 'running' : 'fail';
        const badgeClass = `badge-${statusClass}`;
        const time = formatTime(run.test_time);
        const score = run.score !== undefined ? `${run.score}/100` : '—';

        return `
        <div class="run-card" data-run-id="${run.id}">
            <div class="run-status-dot ${statusClass}"></div>
            <div class="run-info">
                <div class="run-name">${escapeHtml(run.name)}</div>
                <div class="run-url">${escapeHtml(run.product_url || '')}</div>
            </div>
            <div class="run-meta">
                <span class="run-score">${score}</span>
                <span class="badge ${badgeClass}">${run.status}</span>
                <span class="run-time">${time}</span>
                <button class="btn-delete-run" data-run-id="${run.id}" data-report-code="${run.tc_code || run.qa_code || ''}" title="Delete this run" style="background:none;border:none;cursor:pointer;padding:4px;color:var(--text-muted);font-size:1rem;opacity:0.6;transition:opacity 0.2s;" onmouseover="this.style.opacity=1;this.style.color='var(--accent-danger)'" onmouseout="this.style.opacity=0.6;this.style.color='var(--text-muted)'">🗑</button>
            </div>
        </div>`;
    }

    // ============================================================
    // RENDERING: Test Cases
    // ============================================================
    function renderTestCases() {
        const listEl = $('#test-cases-list');
        if (state.testCases.length === 0) {
            listEl.innerHTML = `<div class="empty-state glass-panel"><p>No test cases configured yet.</p></div>`;
            return;
        }

        listEl.innerHTML = state.testCases.map((tc) => {
            const lastRun = state.testRuns.filter((r) => r.test_case_id === tc.id).sort((a, b) => new Date(b.test_time) - new Date(a.test_time))[0];
            let statusBadge;
            if (tc.status === 'running') {
                statusBadge = '<span class="badge badge-running"><span class="loading-spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px;"></span>Running</span>';
            } else if (lastRun) {
                statusBadge = `<span class="badge badge-${lastRun.status === 'PASS' ? 'pass' : 'fail'}">${lastRun.status}</span>`;
            } else {
                statusBadge = '<span class="badge badge-running">Pending</span>';
            }

            return `
            <div class="test-case-card glass-panel">
                <div class="card-header">
                    <span class="card-title">${escapeHtml(tc.name)}</span>
                    ${statusBadge}
                </div>
                <div class="card-url">${escapeHtml(tc.url)}</div>
                <div class="card-actions">
                    ${lastRun 
                        ? `<button class="btn-primary btn-sm btn-view" data-run-id="${lastRun.id}">👁 View Report</button>
                           <button class="btn-ghost btn-sm btn-rerun" data-tc-id="${tc.id}" style="color:var(--text-secondary)">▶ Run Again</button>` 
                        : `<button class="btn-primary btn-sm btn-rerun" data-tc-id="${tc.id}">▶ Run</button>`}
                    <button class="btn-ghost btn-sm btn-delete" data-tc-id="${tc.id}">🗑 Delete</button>
                </div>
            </div>`;
        }).join('');

        // Attach handlers
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
                if (!confirm('Delete this test case and all related runs/reports?')) return;

                // Find and delete all related test runs from server
                const relatedRuns = state.testRuns.filter((r) => r.test_case_id === tcId);
                for (const run of relatedRuns) {
                    if (run.qa_code) {
                        try {
                            await fetch(`/api/reports/${run.qa_code}`, { method: 'DELETE' });
                        } catch (err) {
                            console.warn('Failed to delete server files:', err);
                        }
                    }
                }

                // Remove from state
                state.testRuns = state.testRuns.filter((r) => r.test_case_id !== tcId);
                state.testCases = state.testCases.filter((t) => t.id !== tcId);
                saveToStorage('qa_test_cases', state.testCases);
                saveToStorage('qa_test_runs', state.testRuns);
                renderTestCases();
                renderDashboard();
                renderHistory();
            });
        });
    }

    // ============================================================
    // RENDERING: History Timeline
    // ============================================================
    function renderHistory() {
        const el = $('#history-timeline');
        if (state.testRuns.length === 0) {
            el.innerHTML = `<div class="empty-state glass-panel"><p>No history available.</p></div>`;
            return;
        }

        // Group runs by Test Case Name for History view
        const sortedRuns = [...state.testRuns].sort((a, b) => new Date(b.test_time) - new Date(a.test_time));
        const historyMap = new Map();
        sortedRuns.forEach(run => {
            const key = run.test_case_id || run.name || 'Unknown';
            if (!historyMap.has(key)) historyMap.set(key, []);
            historyMap.get(key).push(run);
        });

        let html = '';
        historyMap.forEach((runsForCase, caseName) => {
            html += `<h3 style="margin: 20px 0 10px; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); padding-bottom: 5px;">Test Case: ${escapeHtml(caseName)}</h3>`;
            html += runsForCase.map((run) => {
                const statusClass = run.status === 'PASS' ? 'pass' : 'fail';
                return `
                <div class="timeline-item ${statusClass}" data-run-id="${run.id}" style="cursor: pointer;">
                    <div class="timeline-content">
                        <h3>${formatTime(run.test_time)} <span class="badge badge-${statusClass}" style="margin-left:8px">${run.status}</span></h3>
                        <p>Score: ${run.score !== undefined ? run.score + '/100' : '—'} · ${run.total_steps || 0} steps</p>
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
        const statusClass = run.status === 'PASS' ? 'pass' : run.status === 'FATAL' ? 'fatal' : 'fail';
        html += `
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">
            <span class="badge badge-${statusClass}" style="font-size:1rem;padding:8px 16px;">${run.status}</span>
            <span style="font-size:1.5rem;font-weight:700;">${run.score !== undefined ? run.score + '/100' : '—'}</span>
            <span style="color:var(--text-muted);font-size:0.85rem;">${formatTime(run.test_time)}</span>
            ${run.total_cases ? `<span style="color:var(--text-muted);font-size:0.85rem;">| ${run.passed_cases}/${run.total_cases} cases passed</span>` : ''}
        </div>`;

        // URL
        html += `<p style="font-family:'Fira Code',monospace;font-size:0.8rem;color:var(--text-muted);margin-bottom:24px;word-break:break-all;">${escapeHtml(run.product_url || '')}</p>`;

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
            html += renderStepTimeline(c.timeline || []);
            if (c.final_evaluation) {
                html += renderCaseEvaluation(c);
            }
            html += '</div>';
        });

        return html;
    }

    function renderStepTimeline(timeline) {
        if (!timeline || timeline.length === 0) return '';
        let html = '<div class="step-timeline">';
        timeline.forEach((step) => {
            let stepClass = 'fail';
            if (step.status === 'PASS') stepClass = 'pass';
            else if (step.status === 'SKIPPED') stepClass = 'skip';

            const thumbHtml = step.option_thumbnail
                ? `<img src="${escapeHtml(step.option_thumbnail)}" style="width:32px;height:32px;border-radius:4px;object-fit:cover;" alt="thumb">`
                : '';

            html += `
                <div class="step-card">
                    <div class="step-header">
                        <div style="display:flex;align-items:center;">
                            <span class="step-number ${stepClass}">${step.step_id}</span>
                            <span class="step-action">${escapeHtml(step.action)}: ${escapeHtml(step.name)}</span>
                        </div>
                        <span class="badge badge-${stepClass}">${step.status}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                        ${thumbHtml}
                        <span style="font-size:0.85rem;color:var(--text-primary);">→ <strong>${escapeHtml(step.value_chosen || '')}</strong></span>
                        ${step.code_evaluation && step.code_evaluation.status === 'SKIPPED'
                            ? `<span class="step-diff" style="background:rgba(255,255,255,0.05);color:var(--text-muted);" title="Skipped visual check">📐 Code: SKIP</span>`
                            : (step.code_evaluation && step.code_evaluation.diff_score >= 0
                                ? `<span class="step-diff" title="Pixelmatch">📐 Code: ${step.code_evaluation.diff_score}%</span>`
                                : (step.diff_score >= 0 ? `<span class="step-diff">Diff: ${step.diff_score}%</span>` : ''))}
                        ${step.ai_evaluation && step.ai_evaluation.ai_verdict && step.ai_evaluation.ai_verdict !== 'PENDING' && step.ai_evaluation.ai_verdict !== 'DISABLED'
                            ? `<span class="step-diff" style="background:${
                                step.ai_evaluation.ai_verdict === 'PASS' ? 'rgba(16,185,129,0.15);color:var(--accent-success)' :
                                step.ai_evaluation.ai_verdict === 'SKIPPED' ? 'rgba(255,255,255,0.05);color:var(--text-muted)' :
                                'rgba(239,68,68,0.15);color:var(--accent-danger)'
                            }" title="${escapeHtml(step.ai_evaluation.ai_reason || '')}">🤖 AI: ${typeof step.ai_evaluation.ai_score === 'number' && step.ai_evaluation.ai_score >= 0 ? step.ai_evaluation.ai_score + '/100' : step.ai_evaluation.ai_verdict}</span>`
                            : ''}
                        ${step.ocr_evaluation
                            ? `<span class="step-diff" style="background:${
                                step.ocr_evaluation.status === 'PASS' ? 'rgba(16,185,129,0.15);color:var(--accent-success)' :
                                'rgba(239,68,68,0.15);color:var(--accent-danger)'
                            }" title="${escapeHtml(step.ocr_evaluation.match_detail || '')}">🔤 OCR: ${step.ocr_evaluation.status}</span>`
                            : ''}
                    </div>
                    ${step.state_before || step.state_after
                        ? `<div class="step-images">
                            <div class="step-img-container">
                                ${step.state_before ? `<img src="${escapeHtml(step.state_before)}" alt="Before">` : '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">N/A</div>'}
                                <div class="step-img-label">BEFORE</div>
                            </div>
                            <div class="step-arrow-section">
                                ${step.option_thumbnail
                                    ? `<div class="step-option-preview">
                                        <img src="${escapeHtml(step.option_thumbnail)}" alt="Option" style="width:48px;height:48px;border-radius:6px;object-fit:cover;border:2px solid var(--accent-primary);">
                                        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;text-align:center;">Selected</div>
                                    </div>`
                                    : (step.action === 'Input Text' && step.value_chosen
                                        ? `<div class="step-option-preview">
                                            <div style="background:rgba(99,102,241,0.15);border:1px solid var(--accent-primary);border-radius:6px;padding:6px 10px;font-family:'Fira Code',monospace;font-size:0.8rem;color:var(--accent-primary);max-width:100px;word-break:break-all;text-align:center;">"${escapeHtml(step.value_chosen)}"</div>
                                            <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;text-align:center;">Typed</div>
                                        </div>`
                                        : '<div class="step-arrow">→</div>')}
                            </div>
                            <div class="step-img-container">
                                ${step.state_after ? `<img src="${escapeHtml(step.state_after)}" alt="After">` : '<div style="height:80px;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">N/A</div>'}
                                <div class="step-img-label">AFTER</div>
                            </div>
                        </div>`
                        : ''}
                    ${step.message
                        ? `<div class="step-message">${escapeHtml(step.message)}${step.ai_evaluation && step.ai_evaluation.ai_reason && step.ai_evaluation.ai_verdict !== 'PENDING' && step.ai_evaluation.ai_verdict !== 'DISABLED'
                            ? '<br><span style="color:var(--accent-primary)">🤖 AI: ' + escapeHtml(step.ai_evaluation.ai_reason) + '</span>'
                            : ''}</div>`
                        : ''}
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
                <h4 style="color:#f87171; margin-top:0; margin-bottom:8px; font-size:1rem; display:flex; align-items:center; gap:8px;">
                    <span>🚨</span> FATAL ERROR
                </h4>
                <ul style="color:#fca5a5; font-size:0.85rem; margin:0; padding-left:24px; font-family:'Fira Code', monospace; line-height:1.6;">
                    ${caseReport.fatal_reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
                </ul>
            </div>`;
        }

        // Render detailed error lists if present
        let errorListHtml = '';
        if (ev.js_errors_list?.length > 0) {
            errorListHtml += `
            <div style="margin-top:16px;">
                <h4 style="color:var(--accent-danger); margin:0 0 8px 0; font-size:0.9rem;">🚫 JS Errors</h4>
                <ul style="margin:0; padding-left:20px; font-size:0.8rem; color:var(--text-secondary); max-height:100px; overflow-y:auto;">
                    ${ev.js_errors_list.map(err => `<li>${escapeHtml(err.message)}</li>`).join('')}
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
                <h4 style="color:var(--accent-warning); margin:0 0 8px 0; font-size:0.9rem;">📡 Network Errors</h4>
                <ul style="margin:0; padding-left:20px; font-size:0.8rem; color:var(--text-secondary); max-height:150px; overflow-y:auto; word-break: break-all;">
                    ${uniqueNetwork.map(err => `<li>${err.count > 1 ? `<b>[${err.count}x]</b> ` : ''}${err.status ? `[${err.status}] ` : ''}${escapeHtml(err.url)}</li>`).join('')}
                </ul>
            </div>`;
        }

        return `
        ${fatalHtml}
        <div class="eval-card" style="margin-top:16px;">
            <h3>📊 Case Evaluation — Score: ${caseReport.score}/100</h3>
            <div class="eval-stats" style="grid-template-columns:repeat(4,1fr)">
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--accent-danger)">${ev.js_errors || 0}</div>
                    <div class="eval-stat-label">JS Errors</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--accent-warning)">${ev.network_errors || 0}</div>
                    <div class="eval-stat-label">Network Errors</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(${ev.preview_valid ? '--accent-success' : '--accent-danger'})">${ev.preview_valid ? '✅' : '❌'}</div>
                    <div class="eval-stat-label">Preview</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(${ev.cart_result === 'PASS' ? '--accent-success' : '--accent-danger'})">${ev.cart_result || 'N/A'}</div>
                    <div class="eval-stat-label">Cart</div>
                </div>
            </div>
            ${errorListHtml}
        </div>
        ${ev.ai_review ? `
        <div class="eval-card" style="margin-top:16px; background:rgba(99,102,241,0.05); border-color:rgba(99,102,241,0.3);">
            <h3 style="color:var(--accent-primary); display:flex; align-items:center; gap:8px;">
                🤖 AI Final QA Review 
                <span class="badge ${ev.ai_review.ai_verdict === 'PASS' ? 'badge-pass' : 'badge-fail'}">${ev.ai_review.ai_verdict}</span>
            </h3>
            <p style="font-size:0.9rem; color:var(--text-primary); margin-bottom:16px; font-weight: 500;">
                <span style="color:var(--text-muted); font-size: 0.8rem; text-transform:uppercase;">Lý do chặn:</span><br>
                ${escapeHtml(ev.ai_review.ai_reason)}
            </p>
            ${ev.ai_review.reviewed_image ? `<img src="${escapeHtml(ev.ai_review.reviewed_image)}" style="max-width:300px; border-radius:8px; border:1px solid var(--border-subtle); box-shadow: 0 4px 12px rgba(0,0,0,0.1);">` : ''}
        </div>
        ` : ''}`;
    }

    function renderFinalEvaluation(run) {
        if (!run.final_evaluation) return '';
        const ev = run.final_evaluation;
        return `
        <div class="eval-card">
            <h3>📊 Final Evaluation</h3>
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
                    <div class="eval-stat-value" style="color:var(${ev.preview_valid ? '--accent-success' : '--accent-danger'})">${ev.preview_valid ? '✅' : '❌'}</div>
                    <div class="eval-stat-label">Preview</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(${ev.cart_result === 'PASS' ? '--accent-success' : '--accent-danger'})">${ev.cart_result || 'N/A'}</div>
                    <div class="eval-stat-label">Cart</div>
                </div>
                <div class="eval-stat">
                    <div class="eval-stat-value" style="color:var(--text-primary)">${ev.ui_interaction_score || '—'}</div>
                    <div class="eval-stat-label">Steps Done</div>
                </div>
            </div>
            ${typeof run.ai_score === 'number' && run.ai_score >= 0
                ? `<div style="text-align:center;margin:12px 0 8px;font-size:0.85rem;color:var(--text-secondary)">🤖 AI Score: <strong style="color:var(--accent-primary)">${run.ai_score}/100</strong></div>`
                : ''}
            <div class="eval-summary">${escapeHtml(ev.summary || '')}</div>
        </div>`;
    }

    // ============================================================
    // SETTINGS
    // ============================================================
    $('#btn-save-settings').addEventListener('click', () => {
        const timeout = $('#setting-timeout').value;
        const headless = $('#setting-headless').value;
        saveToStorage('qa_settings', { timeout, headless });
        alert('Settings saved!');
    });

    // ============================================================
    // API INTEGRATION: Trigger Backend Engine
    // ============================================================
    async function triggerTestRun(testCase, buttonEl, isHeadless, useAi = true) {
        if (!testCase || !testCase.url) return;

        const originalText = buttonEl.innerHTML;
        buttonEl.innerHTML = '<span class="loading-spinner"></span> Running...';
        buttonEl.disabled = true;

        // Update test case status to running
        testCase.status = 'running';
        saveToStorage('qa_test_cases', state.testCases);

        const tcCard = buttonEl.closest('.test-case-card');
        let progressEl = null;

        if (tcCard) {
            // Update the badge
            const header = tcCard.querySelector('.card-header');
            if (header) {
                const badge = header.querySelector('.badge');
                if (badge) {
                    badge.className = 'badge badge-running';
                    badge.textContent = 'Running...';
                }
            }
            
            // Inject inline progress bar
            progressEl = document.createElement('div');
            progressEl.className = 'run-progress glass-panel';
            progressEl.style.marginTop = '12px';
            progressEl.style.padding = '12px';
            progressEl.style.background = 'rgba(56, 189, 248, 0.05)';
            progressEl.style.borderLeft = '3px solid var(--accent-primary)';
            progressEl.style.display = 'flex';
            progressEl.style.alignItems = 'center';
            progressEl.style.gap = '10px';
            progressEl.style.fontSize = '0.9rem';
            
            const modeText = (isHeadless !== false) ? 'Background' : 'Foreground';
            const aiText = useAi ? '(+ AI Evaluation) ' : '';
            progressEl.innerHTML = `<span class="loading-spinner" style="width:16px;height:16px;border-width:2px;border-color:var(--accent-primary) transparent var(--accent-primary) transparent;"></span> 
                                    <span style="color:var(--text-primary)">Initiating ${aiText}Test [${modeText}]...</span>`;
            
            const actionsDiv = tcCard.querySelector('.card-actions');
            if (actionsDiv) {
                actionsDiv.insertAdjacentElement('beforebegin', progressEl);
            }
        }

        try {
            const res = await fetch('/api/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: testCase.url,
                    tcCode: testCase.name,
                    headless: isHeadless !== false,
                    useAi: useAi,
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to trigger test');
            }

            const { runId } = await res.json();
            let elapsed = 0;

            // Poll run status every 3 seconds
            const pollInterval = setInterval(async () => {
                elapsed += 3;

                // Update progress UI
                if (progressEl) {
                    progressEl.innerHTML = `
                        <span class="loading-spinner" style="width:16px;height:16px;border-width:2px;border-color:var(--accent-primary) transparent var(--accent-primary) transparent;"></span> 
                        <span style="color:var(--text-primary); flex: 1;">Test is running... <strong style="color:var(--accent-primary)">${elapsed}s</strong> elapsed</span>
                        <div style="width: 150px; height: 6px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin-left: auto;">
                            <div style="height: 100%; width: ${Math.min(100, (elapsed / 90) * 100)}%; background: var(--accent-primary); transition: width 1s linear;"></div>
                        </div>
                    `;
                }

                try {
                    const statusRes = await fetch(`/api/run-status/${runId}`);
                    if (!statusRes.ok) return;
                    const statusData = await statusRes.json();

                    if (statusData.status === 'COMPLETED' || statusData.status === 'FAILED') {
                        clearInterval(pollInterval);
                        if (progressEl) progressEl.remove();

                        // Fetch fresh reports from server
                        await fetchReports();

                        // Find the newly generated run matching the name to link to test case
                        const newestRun = [...state.testRuns]
                            .find(r => r.tc_code === testCase.name);

                        if (newestRun) {
                            // Link run to test case
                            newestRun.test_case_id = testCase.id;

                            // Update test case status based on report pass/fail
                            testCase.status = newestRun.status === 'PASS' ? 'pass' : 'fail';
                            saveToStorage('qa_test_cases', state.testCases);
                            saveToStorage('qa_test_runs', state.testRuns);

                            // Report file exists → redirect to Dashboard to show result
                            renderDashboard();
                            switchPage('dashboard');
                        } else {
                            testCase.status = 'fail';
                            saveToStorage('qa_test_cases', state.testCases);
                            renderTestCases();
                        }
                    }
                } catch (pollErr) {
                    // Silently retry on next interval
                }

                // Safety timeout: 3 minutes max
                if (elapsed >= 180) {
                    clearInterval(pollInterval);
                    if (progressEl) progressEl.remove();
                    await fetchReports();
                    switchPage('dashboard');
                    buttonEl.innerHTML = originalText;
                    buttonEl.disabled = false;
                }
            }, 3000);

        } catch (error) {
            alert('❌ Error: ' + error.message);
            testCase.status = 'pending';
            saveToStorage('qa_test_cases', state.testCases);
            if (progressEl) progressEl.remove();
            buttonEl.innerHTML = originalText;
            buttonEl.disabled = false;
        }
    }

    // ============================================================
    // DELETE TEST RUN (local + server files)
    // ============================================================
    async function deleteTestRun(runId, code) {
        if (!confirm('Delete this test run and its report files?')) return;

        // Remove from state
        state.testRuns = state.testRuns.filter((r) => r.id !== runId);
        saveToStorage('qa_test_runs', state.testRuns);

        // Delete server files if code exists (supports TC_* and QA* format)
        if (code) {
            try {
                await fetch(`/api/reports/${code}`, { method: 'DELETE' });
            } catch (err) {
                console.warn('Failed to delete server files:', err);
            }
        }

        // Re-render
        renderDashboard();
        renderTestCases();
        renderHistory();
    }

    // ============================================================
    // UTILITIES
    // ============================================================
    function generateId() {
        return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
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
        if (!isoString) return '—';
        const d = new Date(isoString);
        return d.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
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
            (r.product_url || '').toLowerCase().includes(query)
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
    async function fetchReports() {
        try {
            const res = await fetch('/api/reports');
            if (res.ok) {
                const apiReports = await res.json();
                
                // Merge with local state to update status
                apiReports.forEach(apiReport => {
                    // Ensure the API report has a name property for the UI
                    if (!apiReport.name && apiReport.test_case_label) {
                        apiReport.name = apiReport.test_case_label;
                    }

                    const existingIndex = state.testRuns.findIndex(r => 
                        // Match either by same ID, or same testcase + timestamp (within 1 min)
                        r.id === apiReport.id || 
                        (apiReport.tc_code && r.tc_code === apiReport.tc_code && Math.abs(new Date(r.test_time) - new Date(apiReport.test_time)) < 60000)
                    );
                    
                    if (existingIndex >= 0) {
                        state.testRuns[existingIndex] = { ...state.testRuns[existingIndex], ...apiReport };
                    } else {
                        // It's a brand new run generated by CLI
                        apiReport.id = apiReport.id || generateId();
                        state.testRuns.push(apiReport);
                    }
                });
                
                // Save and render
                saveToStorage('qa_test_runs', state.testRuns);
                renderDashboard();
                renderTestCases();
                renderHistory();
            }
        } catch (err) {
            console.error('Failed to fetch reports:', err);
        }
    }

    // Initial load
    renderDashboard();
    renderTestCases();
    fetchReports(); // get the latest status from backend

})();
