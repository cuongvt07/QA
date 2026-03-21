const db = require('./db');

class Repository {
    static formatDate(d) {
        if (!d) return null;
        const dt = (d instanceof Date) ? d : new Date(d);
        if (isNaN(dt.getTime())) return d; // Return original if not a valid date
        // Return YYYY-MM-DD HH:MM:SS
        return dt.toISOString().slice(0, 19).replace('T', ' ');
    }

    // --- Test Cases ---
    static async getAllTestCases() {
        return await db.query('SELECT * FROM test_case ORDER BY created_at DESC');
    }

    static async getTestCaseById(id) {
        const results = await db.query('SELECT * FROM test_case WHERE id = ?', [id]);
        return results[0] || null;
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
        
        return rows.map(r => {
            let reportStatus = '';
            let passedCases = 0;
            let totalCases = 0;
            let decision = '';
            let reasonCodes = [];
            let rawScore = r.score;

            try {
                if (r.report_content) {
                    const content = typeof r.report_content === 'string' ? JSON.parse(r.report_content) : r.report_content;
                    const cases = content.cases || [];
                    passedCases = cases.filter(c => c.status === 'PASS').length;
                    totalCases = cases.length;
                    reportStatus = content.status || '';
                    
                    // P1 Standardized Fields
                    decision = content.decision || '';
                    reasonCodes = content.reason_codes || content.decision_reason_codes || [];
                    rawScore = content.raw_score || content.quality_score || r.score;
                    r.quality_score = content.quality_score || rawScore;
                    r.confidence_score = content.confidence_score || 100;
                }
            } catch (e) {}
            
            const { report_content, ...rest } = r;
            return {
                ...rest,
                report_status: reportStatus,
                passed_cases: passedCases,
                total_cases: totalCases,
                result_status: reportStatus,
                decision,
                reason_codes: reasonCodes,
                raw_score: rawScore,
                quality_score: r.quality_score,
                confidence_score: r.confidence_score
            };
        });
    }

    static async getRunById(id) {
        const results = await db.query('SELECT * FROM test_run WHERE id = ?', [id]);
        return results[0] || null;
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
        return rows.map(r => {
            const { content: _, ...rest } = r;
            let reportStatus = '';
            let passedCases = 0;
            let totalCases = 0;
            let decision = '';
            let reason_codes = [];
            let raw_score = r.score;
            let quality_score = r.score;
            let confidence_score = 100;

            try {
                if (r.content) {
                    const content = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
                    const cases = content.cases || [];
                    passedCases = cases.filter(c => c.status === 'PASS').length;
                    totalCases = cases.length;
                    reportStatus = content.status || '';
                    
                    // P0.2 / P1 New Fields (Standardized)
                    decision = content.decision || '';
                    reason_codes = content.reason_codes || content.decision_reason_codes || [];
                    raw_score = content.raw_score || content.quality_score || r.score;
                    quality_score = content.quality_score || raw_score;
                    confidence_score = content.confidence_score || 1.0;
                }
            } catch (e) {
                console.error('[Repo] Error parsing report content for status:', e.message);
            }
            
            return { 
                ...rest, 
                report_status: reportStatus,
                passed_cases: passedCases,
                total_cases: totalCases,
                // Backward compatibility
                result_status: reportStatus,
                decision,
                reason_codes,
                raw_score,
                quality_score,
                confidence_score,
                cases_summary: totalCases > 0 ? `${passedCases}/${totalCases} PASS` : '',
                status: reportStatus || r.execution_status
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
}

module.exports = Repository;
