const db = require('./db');

class Repository {
    static formatDate(d) {
        if (!d) return null;
        const dt = (d instanceof Date) ? d : new Date(d);
        if (isNaN(dt.getTime())) return d; // Return original if not a valid date
        // Return YYYY-MM-DD HH:MM:SS
        return dt.toISOString().slice(0, 19).replace('T', ' ');
    }

    static normalizeConfidenceScore(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        if (n > 1) return Math.min(1, n / 100);
        if (n < 0) return 0;
        return n;
    }

    static normalizeReasonCodes(value) {
        if (Array.isArray(value)) return value.filter(Boolean);
        if (typeof value === 'string' && value.trim()) {
            return value.split(/[;,]/).map((v) => v.trim()).filter(Boolean);
        }
        return [];
    }

    static decisionToResultStatus(decision) {
        const normalized = String(decision || '').toUpperCase();
        if (normalized === 'PASS_AUTO' || normalized === 'PASS' || normalized === 'COMPLETED') return 'PASS';
        if (normalized === 'FAIL_AUTO' || normalized === 'FAIL' || normalized === 'FAILED') return 'FAIL';
        if (normalized === 'FATAL') return 'FATAL';
        if (normalized === 'REVIEW') return 'REVIEW';
        return '';
    }

    static classifyCaseOutcome(caseReport) {
        const decision = this.decisionToResultStatus(caseReport?.decision);
        if (decision) return decision;

        const status = String(caseReport?.status || '').toUpperCase();
        if (status === 'PASS') return 'PASS';
        if (status === 'REVIEW') return 'REVIEW';
        if (status === 'FAIL' || status === 'FATAL') return 'FAIL';
        return '';
    }

    static extractReportMetadata(reportContent, fallbackRow = {}) {
        const content = typeof reportContent === 'string' ? JSON.parse(reportContent) : reportContent;
        const cases = Array.isArray(content?.cases) ? content.cases : [];
        const counts = cases.reduce((acc, caseReport) => {
            const outcome = this.classifyCaseOutcome(caseReport);
            if (outcome === 'PASS') acc.passed += 1;
            else if (outcome === 'REVIEW') acc.review += 1;
            else if (outcome === 'FAIL') acc.failed += 1;
            return acc;
        }, { passed: 0, failed: 0, review: 0 });

        const decision = content?.decision || '';
        const reportStatus =
            content?.report_status ||
            content?.result_status ||
            content?.status ||
            this.decisionToResultStatus(decision) ||
            '';

        const rawScore = Number.isFinite(Number(content?.raw_score))
            ? Number(content.raw_score)
            : (Number.isFinite(Number(content?.quality_score)) ? Number(content.quality_score) : Number(fallbackRow.score) || 0);

        const qualityScore = Number.isFinite(Number(content?.quality_score))
            ? Number(content.quality_score)
            : rawScore;

        const finalScore = Number.isFinite(Number(content?.score))
            ? Number(content.score)
            : (Number.isFinite(Number(fallbackRow.score)) ? Number(fallbackRow.score) : qualityScore);

        return {
            report_status: reportStatus,
            result_status: reportStatus || this.decisionToResultStatus(decision),
            decision,
            reason_codes: this.normalizeReasonCodes(content?.reason_codes || content?.decision_reason_codes),
            raw_score: rawScore,
            quality_score: qualityScore,
            confidence_score: this.normalizeConfidenceScore(content?.confidence_score) ?? 1.0,
            score: finalScore,
            passed_cases: Number.isFinite(Number(content?.passed_cases)) ? Number(content.passed_cases) : counts.passed,
            failed_cases: Number.isFinite(Number(content?.failed_cases)) ? Number(content.failed_cases) : counts.failed,
            review_cases: Number.isFinite(Number(content?.review_cases)) ? Number(content.review_cases) : counts.review,
            total_cases: Number.isFinite(Number(content?.total_cases)) ? Number(content.total_cases) : cases.length,
            content
        };
    }

    static enrichRunRow(row) {
        const fallbackExecutionStatus = row.execution_status || row.status || '';
        let metadata = {
            report_status: '',
            result_status: '',
            decision: '',
            reason_codes: [],
            raw_score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
            quality_score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
            confidence_score: this.normalizeConfidenceScore(row.confidence_score) ?? 1.0,
            score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
            passed_cases: 0,
            failed_cases: 0,
            review_cases: 0,
            total_cases: 0
        };

        try {
            const reportContent = row.report_content ?? row.content;
            if (reportContent) {
                metadata = {
                    ...metadata,
                    ...this.extractReportMetadata(reportContent, row)
                };
            }
        } catch (e) {
            console.error('[Repo] Error parsing report content:', e.message);
        }

        const { report_content, content, ...rest } = row;
        const businessStatus = metadata.report_status || metadata.result_status || this.decisionToResultStatus(metadata.decision);

        return {
            ...rest,
            execution_status: fallbackExecutionStatus,
            report_status: metadata.report_status,
            result_status: businessStatus,
            decision: metadata.decision,
            reason_codes: metadata.reason_codes,
            raw_score: metadata.raw_score,
            quality_score: metadata.quality_score,
            confidence_score: metadata.confidence_score,
            score: metadata.score,
            passed_cases: metadata.passed_cases,
            failed_cases: metadata.failed_cases,
            review_cases: metadata.review_cases,
            total_cases: metadata.total_cases,
            status: rest.status || fallbackExecutionStatus
        };
    }

    // --- Test Cases ---
    static async getAllTestCases() {
        return await db.query('SELECT * FROM test_case ORDER BY created_at DESC');
    }

    static async getTestCaseById(id) {
        const results = await db.query('SELECT * FROM test_case WHERE id = ?', [id]);
        return results[0] || null;
    }

    static async getNewTestCasesForDaily(limit = 200) {
        const parsedLimit = Number.parseInt(limit, 10);
        const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 200;
        const sql = `
            SELECT tc.*
            FROM test_case tc
            WHERE tc.status NOT IN ('QUEUED', 'RUNNING')
              AND tc.last_run_id IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM test_run tr
                  WHERE tr.test_case_id = tc.id
              )
            ORDER BY tc.created_at DESC
            LIMIT ${safeLimit}
        `;
        return await db.query(sql);
    }

    /**
     * Get test cases that need to be retried:
     * 1. Status is FAIL or FATAL (failed previously)
     * 2. Has last_run_id but no report in test_report (incomplete/crashed/blocked)
     */
    static async getRetryCandidatesForDaily(limit = 200) {
        const parsedLimit = Number.parseInt(limit, 10);
        const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 200;
        const sql = `
            SELECT tc.*
            FROM test_case tc
            WHERE tc.status NOT IN ('QUEUED', 'RUNNING')
              AND tc.last_run_id IS NOT NULL
              AND (
                  tc.status IN ('FAIL', 'FATAL')
                  OR NOT EXISTS (
                      SELECT 1
                      FROM test_report tr
                      WHERE tr.test_run_id = tc.last_run_id
                  )
              )
            ORDER BY tc.updated_at ASC
            LIMIT ${safeLimit}
        `;
        return await db.query(sql);
    }

    static async createTestCase(data) {
        const { id, name, url, status, created_at, updated_at } = data;
        await db.query(
            'INSERT INTO test_case (id, name, url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [id, name, url, status, this.formatDate(created_at), this.formatDate(updated_at)]
        );
        return data;
    }

    static async updateTestCase(id, data) {
        const fields = [];
        const params = [];
        for (const [key, value] of Object.entries(data)) {
            if (key === 'id') continue;
            fields.push(`${key} = ?`);
            const isDateCol = ['created_at', 'updated_at', 'started_at', 'finished_at'].includes(key);
            params.push(isDateCol ? this.formatDate(value) : value);
        }
        params.push(id);
        await db.query(`UPDATE test_case SET ${fields.join(', ')} WHERE id = ?`, params);
    }

    static async deleteTestCase(id) {
        await db.query('DELETE FROM test_case WHERE id = ?', [id]);
    }

    // --- Test Runs ---
    static async getAllRuns(testCaseId = null) {
        let sql = `
            SELECT 
                trun.*,
                tr.score,
                tr.total_steps,
                tr.passed_steps,
                tr.failed_steps,
                tr.content as report_content
            FROM test_run trun
            LEFT JOIN test_report tr ON trun.id = tr.test_run_id
        `;
        const params = [];
        if (testCaseId) {
            sql += ' WHERE trun.test_case_id = ?';
            params.push(testCaseId);
        }
        sql += ' ORDER BY trun.created_at DESC';
        const rows = await db.query(sql, params);
        return rows.map((r) => this.enrichRunRow(r));
    }

    static async getTodaysRuns() {
        const sql = `
            SELECT 
                trun.*,
                tr.score,
                tr.total_steps,
                tr.passed_steps,
                tr.failed_steps,
                tr.content as report_content
            FROM test_run trun
            LEFT JOIN test_report tr ON trun.id = tr.test_run_id
            WHERE DATE(trun.created_at) = CURDATE()
            ORDER BY trun.created_at DESC
        `;
        const rows = await db.query(sql);
        return rows.map((r) => this.enrichRunRow(r));
    }

    static async getRunById(id) {
        const sql = `
            SELECT
                trun.*,
                tr.score,
                tr.total_steps,
                tr.passed_steps,
                tr.failed_steps,
                tr.content as report_content
            FROM test_run trun
            LEFT JOIN test_report tr ON trun.id = tr.test_run_id
            WHERE trun.id = ?
            LIMIT 1
        `;
        const results = await db.query(sql, [id]);
        return results[0] ? this.enrichRunRow(results[0]) : null;
    }

    static async createRun(data) {
        const { id, test_case_id, batch_id, name, url, tc_code, report_code, status, output, source, created_at, updated_at, started_at } = data;
        await db.query(
            `INSERT INTO test_run (id, test_case_id, batch_id, name, url, tc_code, report_code, status, output, source, created_at, updated_at, started_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, test_case_id, batch_id || null, name, url, tc_code, report_code, status, output || '', source, this.formatDate(created_at), this.formatDate(updated_at), this.formatDate(started_at)]
        );
        return data;
    }

    static async updateRun(id, data) {
        const fields = [];
        const params = [];
        for (const [key, value] of Object.entries(data)) {
            if (key === 'id') continue;
            fields.push(`${key} = ?`);
            const isDateCol = ['created_at', 'updated_at', 'started_at', 'finished_at'].includes(key);
            params.push(isDateCol ? this.formatDate(value) : value);
        }
        params.push(id);
        await db.query(`UPDATE test_run SET ${fields.join(', ')} WHERE id = ?`, params);
    }

    static async deleteRun(id) {
        await db.query('DELETE FROM test_run WHERE id = ?', [id]);
    }

    static async getRunsByBatchId(batchId) {
        return await db.query('SELECT * FROM test_run WHERE batch_id = ? ORDER BY created_at ASC', [batchId]);
    }

    // --- Reports ---
    static async getReportByRunId(runId) {
        const results = await db.query('SELECT * FROM test_report WHERE test_run_id = ?', [runId]);
        if (results[0] && results[0].content) {
            try {
                results[0].content = JSON.parse(results[0].content);
            } catch (e) {
                // Keep as string
            }
        }
        return results[0] || null;
    }

    static async getReportByCode(code) {
        const sql = `
            SELECT tr.* FROM test_report tr
            JOIN test_run trun ON tr.test_run_id = trun.id
            WHERE trun.report_code = ? OR trun.tc_code = ?
            ORDER BY tr.created_at DESC LIMIT 1
        `;
        const results = await db.query(sql, [code, code]);
        if (results[0] && results[0].content) {
            try {
                results[0].content = JSON.parse(results[0].content);
            } catch (e) {
                // Keep as string if parsing fails
            }
        }
        return results[0] ? results[0].content : null;
    }

    static async saveReport(runId, reportData) {
        const content = JSON.stringify(reportData);
        const { score, total_steps, passed_steps, failed_steps } = reportData;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // Use REPLACE INTO or similar for upsert
        await db.query(
            `INSERT INTO test_report (test_run_id, content, score, total_steps, passed_steps, failed_steps, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE content = VALUES(content), score = VALUES(score), 
             total_steps = VALUES(total_steps), passed_steps = VALUES(passed_steps), 
             failed_steps = VALUES(failed_steps), updated_at = VALUES(updated_at)`,
            [runId, content, score || 0, total_steps || 0, passed_steps || 0, failed_steps || 0, now, now]
        );
    }

    static async getAllReports() {
        // Trả về metadata của report + parse content để lấy business status
        const sql = `
            SELECT 
                tr.test_run_id as id,
                tr.score,
                tr.total_steps,
                tr.passed_steps,
                tr.failed_steps,
                tr.content,
                trun.name,
                trun.url,
                trun.tc_code,
                trun.status as execution_status,
                trun.created_at as test_time
            FROM test_report tr
            JOIN test_run trun ON tr.test_run_id = trun.id
            ORDER BY trun.created_at DESC
        `;
        const rows = await db.query(sql);
        return rows.map((r) => {
            let metadata = {
                report_status: '',
                result_status: '',
                decision: '',
                reason_codes: [],
                raw_score: Number.isFinite(Number(r.score)) ? Number(r.score) : 0,
                quality_score: Number.isFinite(Number(r.score)) ? Number(r.score) : 0,
                confidence_score: 1.0,
                passed_cases: 0,
                failed_cases: 0,
                review_cases: 0,
                total_cases: 0
            };

            try {
                if (r.content) {
                    metadata = {
                        ...metadata,
                        ...this.extractReportMetadata(r.content, r)
                    };
                }
            } catch (e) {
                console.error('[Repo] Error parsing report content for status:', e.message);
            }

            const { content: _, ...rest } = r;
            return {
                ...rest,
                report_status: metadata.report_status,
                result_status: metadata.result_status,
                decision: metadata.decision,
                reason_codes: metadata.reason_codes,
                raw_score: metadata.raw_score,
                quality_score: metadata.quality_score,
                confidence_score: metadata.confidence_score,
                passed_cases: metadata.passed_cases,
                failed_cases: metadata.failed_cases,
                review_cases: metadata.review_cases,
                total_cases: metadata.total_cases,
                cases_summary: metadata.total_cases > 0 ? `${metadata.passed_cases}/${metadata.total_cases} PASS` : '',
                status: metadata.report_status || r.execution_status
            };
        });
    }

    static async upsertProduct(data) {
        const { product_id, platform, redirect_url, final_url, customizable, note, status_code, has_error, checked_at } = data;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const checkTime = checked_at ? new Date(checked_at).toISOString().slice(0, 19).replace('T', ' ') : now;

        await db.query(`
            INSERT INTO products (
                product_id, platform, redirect_url, final_url, customizable, note, status_code, has_error, checked_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE 
                redirect_url = VALUES(redirect_url),
                final_url = VALUES(final_url),
                customizable = VALUES(customizable),
                note = VALUES(note),
                status_code = VALUES(status_code),
                has_error = VALUES(has_error),
                checked_at = VALUES(checked_at),
                updated_at = VALUES(updated_at)
        `, [
            product_id, platform, redirect_url, final_url,
            customizable ? 1 : 0, note, status_code,
            has_error ? 1 : 0, checkTime, now, now
        ]);
    }

    static async getAllProducts() {
        return await db.query('SELECT * FROM products ORDER BY checked_at DESC');
    }

    static async getProduct(productId, platform) {
        const results = await db.query('SELECT * FROM products WHERE product_id = ? AND platform = ?', [productId, platform]);
        return results[0] || null;
    }

    static async deleteProduct(productId, platform) {
        return await db.query('DELETE FROM products WHERE product_id = ? AND platform = ?', [productId, platform]);
    }

    static async resetAll() {
        await db.query('SET FOREIGN_KEY_CHECKS = 0');
        await db.query('TRUNCATE TABLE test_report');
        await db.query('TRUNCATE TABLE test_run');
        await db.query('TRUNCATE TABLE test_case');
        await db.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    static async deleteOldRuns(days = 30) {
        // Find runs older than X days
        const sql = `
            DELETE FROM test_run 
            WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `;
        // Cascading deletes should handle test_report if FKs are set, 
        // but if not, we do it manually.
        await db.query('SET FOREIGN_KEY_CHECKS = 0');
        await db.query('DELETE FROM test_report WHERE test_run_id NOT IN (SELECT id FROM test_run)');
        const result = await db.query(sql, [days]);
        await db.query('SET FOREIGN_KEY_CHECKS = 1');
        return result;
    }

    /**
     * ✅ Batch insert/update products
     */
    // --- Reliability v2.1 History (Spec §8) ---

    /**
     * Query last N runs for a given test_input_signature.
     * Returns array of { decision, confidence_score, created_at }.
     * Falls back gracefully if the column doesn't exist yet.
     */
    static async getDecisionHistoryBySignature(signature, limit = 5) {
        try {
            const sql = `
                SELECT tr.content
                FROM test_report tr
                JOIN test_run trun ON tr.test_run_id = trun.id
                ORDER BY trun.created_at DESC
                LIMIT ?
            `;
            const rows = await db.query(sql, [limit * 3]); // oversample, then filter
            const matched = [];
            for (const row of rows) {
                try {
                    const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
                    if (!content) continue;
                    // Check each case in the report
                    for (const c of (content.cases || [content])) {
                        if (c.test_input_signature === signature && c.decision) {
                            matched.push({ decision: c.decision, confidence_score: c.confidence_score || 0 });
                            if (matched.length >= limit) break;
                        }
                    }
                    if (matched.length >= limit) break;
                } catch (_) {}
            }
            return matched;
        } catch (e) {
            console.warn('[Repo] getDecisionHistoryBySignature failed:', e.message);
            return [];
        }
    }

    static async batchUpsertProducts(products) {
        if (products.length === 0) return;

        return await db.transaction(async (connection) => {
            const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const sql = `
                INSERT INTO products (
                    product_id, platform, redirect_url, final_url, customizable, note, status_code, has_error, checked_at, created_at, updated_at
                ) VALUES ?
                ON DUPLICATE KEY UPDATE 
                    redirect_url = VALUES(redirect_url),
                    final_url = VALUES(final_url),
                    customizable = VALUES(customizable),
                    note = VALUES(note),
                    status_code = VALUES(status_code),
                    has_error = VALUES(has_error),
                    checked_at = VALUES(checked_at),
                    updated_at = VALUES(updated_at)
            `;

            const values = products.map(p => {
                const checkTime = p.checked_at ? new Date(p.checked_at).toISOString().slice(0, 19).replace('T', ' ') : now;
                return [
                    p.product_id, p.platform, p.redirect_url, p.final_url,
                    p.customizable ? 1 : 0, p.note, p.status_code,
                    p.has_error ? 1 : 0, checkTime, now, now
                ];
            });

            await connection.query(sql, [values]);
        });
    }
    /**
     * ✅ User Management
     */
    static async getAllUsers() {
        return await db.query('SELECT id, email, role, created_at, updated_at FROM users ORDER BY created_at DESC');
    }

    static async getUserById(id) {
        const results = await db.query('SELECT id, email, role, created_at, updated_at FROM users WHERE id = ?', [id]);
        return results[0] || null;
    }

    static async getUserByEmail(email) {
        const results = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        return results[0] || null;
    }

    static async createUser(data) {
        const { id, email, password, role } = data;
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await db.query(
            'INSERT INTO users (id, email, password, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [id, email, password, role || 'USER', now, now]
        );
        return { id, email, role: role || 'USER' };
    }

    static async updateUser(id, data) {
        const fields = [];
        const params = [];
        for (const [key, value] of Object.entries(data)) {
            if (key === 'id' || key === 'email') continue;
            fields.push(`${key} = ?`);
            params.push(value);
        }
        params.push(id);
        await db.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
    }

    static async deleteUser(id) {
        await db.query('DELETE FROM users WHERE id = ?', [id]);
    }
}

module.exports = Repository;
