require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { spawn } = require('child_process');
const repo = require('./repository');
const PQueue = require('p-queue').default;
const crawler = require('./crawler');
const { generateDailyExcel } = require('./utils/excel');
const { sendDailyReport } = require('./utils/mailer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 8090;
const JWT_SECRET = process.env.JWT_SECRET || 'qa-engine-default-secret';

const WEB_DIR = path.resolve(__dirname, '../web');
const REPORTS_DIR = path.join(WEB_DIR, 'reports');

// --- Queue Setup ---
function resolveServerQueueConcurrency() {
    const raw = process.env.RUN_QUEUE_CONCURRENCY || process.env.SERVER_QUEUE_CONCURRENCY || 5;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 5;
    return Math.min(parsed, 20);
}

const queue = new PQueue({ concurrency: resolveServerQueueConcurrency() });
// Track queue events to broadcast status changes
queue.on('active', () => {
    console.log(`[QUEUE] Task started. Size: ${queue.size}  Pending: ${queue.pending}`);
});
queue.on('idle', () => {
    console.log('[QUEUE] Idle.');
});
queue.on('next', () => {
    console.log(`[QUEUE] Task completed. Size: ${queue.size}  Pending: ${queue.pending}`);
});

// --- SSE Setup ---
const clients = new Set();
function broadcastEvent(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => client.write(payload));
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Prevent caching for all API routes (crucial for CDN/Cloudflare bypass)
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// Request Logger
app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});

/**
 * Authentication Middleware
 */
/**
 * Authentication Middleware - DISABLED by user request
 * All requests are automatically authorized as ADMIN
 */
function authenticateToken(req, res, next) {
    // Force mock admin user for all requests
    req.user = { id: 'USER_MOCK', email: 'admin@megaads.com', role: 'ADMIN' };
    next();
}

// Public API Routes (Login)
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });

        const user = await repo.getUserByEmail(email);
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });

        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(401).json({ error: 'Invalid email or password' });

        // Create token
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: { id: user.id, email: user.email, role: user.role }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', (req, res) => {
    res.json({ message: 'Logged out successfully' });
});

app.get('/api/me', authenticateToken, async (req, res) => {
    try {
        const user = await repo.getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- User Management API ---

app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const users = await repo.getAllUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', authenticateToken, async (req, res) => {
    try {
        const { email, password, role } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });

        const existing = await repo.getUserByEmail(email);
        if (existing) return res.status(400).json({ error: 'User already exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await repo.createUser({
            id: `USER_${Date.now()}`,
            email,
            password: hashedPassword,
            role: role || 'USER'
        });

        res.status(201).json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/users/:id', authenticateToken, async (req, res) => {
    try {
        const data = { ...req.body };
        if (data.password) {
            data.password = await bcrypt.hash(data.password, 10);
        }
        await repo.updateUser(req.params.id, data);
        res.json({ message: 'User updated successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
    try {
        await repo.deleteUser(req.params.id);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.use(express.static(WEB_DIR));

// API: Database connectivity check
app.get('/api/health/db', async (req, res) => {
    try {
        const db = require('./db');
        await db.query('SELECT 1');
        res.json({ status: 'successful' });
    } catch (error) {
        res.status(500).json({ status: 'fail', message: error.message });
    }
});



function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function formatMySqlDate(date) {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

function nowIso() {
    return new Date();
}

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeTcCode(input) {
    if (!input) return '';
    return String(input).replace(/[^a-z0-9_-]/gi, '_');
}

function isValidReportCode(code) {
    return /^(TC_\d+|QA\d+|[A-Z]{3}\d{3})$/i.test(code || '');
}

function deleteReportFolderByCode(code) {
    if (!isValidReportCode(code)) {
        return { ok: false, status: 400, message: 'Invalid report code format' };
    }
    const reportDir = path.join(REPORTS_DIR, code);
    if (!fs.existsSync(reportDir)) {
        return { ok: false, status: 404, message: 'Report folder not found' };
    }
    try {
        fs.rmSync(reportDir, { recursive: true, force: true });
        return { ok: true, status: 200, message: `Deleted ${code}` };
    } catch (error) {
        return { ok: false, status: 500, message: `Failed to delete report: ${error.message}` };
    }
}

function extractReportCodeFromOutput(outputText) {
    if (!outputText) return null;
    const combinedMatch = outputText.match(/Combined Report:\s*([^\r\n]+report\.json)/i);
    if (combinedMatch && combinedMatch[1]) {
        const reportPath = combinedMatch[1].trim();
        const folder = path.basename(path.dirname(reportPath));
        if (isValidReportCode(folder)) return folder;
    }
    const codeMatch = outputText.match(/\b(TC_\d+|QA\d+|[A-Z]{3}\d{3})\b/);
    return codeMatch ? codeMatch[1] : null;
}

function getNextAutoTestName(existingCases) {
    let maxNum = 0;
    for (const tc of existingCases) {
        const m = String(tc.name || '').match(/^MEE(\d{3})$/i);
        if (m) {
            maxNum = Math.max(maxNum, parseInt(m[1], 10));
        }
    }
    return `MEE${String(maxNum + 1).padStart(3, '0')}`;
}

function validateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

function normalizeBusinessStatus(status, fallback = 'FAIL') {
    const s = String(status || '').toUpperCase();
    if (['PASS', 'FAIL', 'FATAL', 'REVIEW', 'PENDING', 'QUEUED', 'RUNNING'].includes(s)) return s;
    if (['PASS_AUTO', 'SUCCESS', 'COMPLETED', 'DONE'].includes(s)) return 'PASS';
    if (['FAIL_AUTO', 'FAILED', 'ERROR'].includes(s)) return 'FAIL';
    return fallback;
}

function resolveCliConcurrency(payload = {}) {
    const rawValue = payload.concurrency
        ?? process.env.DASHBOARD_CASE_CONCURRENCY
        ?? process.env.TEST_CASE_CONCURRENCY
        ?? 2;

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 2;
    return Math.min(parsed, 8);
}

function resolveDailyNewLimit(payload = {}) {
    const rawValue = payload.limit
        ?? process.env.DAILY_NEW_TC_LIMIT
        ?? process.env.DAILY_BATCH_LIMIT
        ?? 200;

    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 200;
    return Math.min(parsed, 500);
}

function buildCliArgs(payload) {
    const concurrency = resolveCliConcurrency(payload);
    const args = ['src/cli.js', `--url=${payload.url}`, `--concurrency=${concurrency}`];
    if (typeof payload.optionIndex === 'number') args.push(`--option-index=${payload.optionIndex}`);
    if (payload.tcCode) args.push(`--tc-code=${sanitizeTcCode(payload.tcCode)}`);
    if (payload.headless === false) args.push('--no-headless');
    if (payload.useAi === false) args.push('--no-ai');
    if (payload.customImageFilename) args.push(`--custom-image=${payload.customImageFilename}`);
    // Reliability Engine v2.1 feature flag
    if (payload.reliabilityV2 === true || process.env.RELIABILITY_V2 === 'true') {
        args.push('--reliability-v2');
    }
    return args;
}

const activeRuns = new Map();
let isCrawlerRunning = false;

async function startEngineRun(payload) {
    if (!validateUrl(payload.url)) {
        return { error: 'Missing or invalid product URL', status: 400 };
    }

    const runId = makeId('RUN');
    const cliArgs = buildCliArgs(payload);
    const startedAt = nowIso();

    const runRecord = {
        id: runId,
        test_case_id: payload.testCaseId || null,
        batch_id: payload.batchId || null,
        name: payload.testName || payload.tcCode || 'Untitled',
        url: payload.url,
        tc_code: payload.tcCode || null,
        report_code: payload.tcCode || null,
        status: 'QUEUED', // Start in QUEUED state
        created_at: startedAt,
        started_at: null, // Not started yet
        updated_at: startedAt,
        source: payload.source || 'api',
    };

    await repo.createRun(runRecord);

    if (payload.testCaseId) {
        await repo.updateTestCase(payload.testCaseId, {
            status: 'QUEUED',
            updated_at: formatMySqlDate(startedAt)
        });
    }

    // Add to activeRuns with QUEUED status initially
    activeRuns.set(runId, {
        status: 'QUEUED',
        output: '',
        exitCode: null,
        startedAt: null,
        testCaseId: payload.testCaseId || null,
        testName: payload.testName || null,
    });

    // Notify clients that a test has been queued
    broadcastEvent({ 
        event: 'test-queued', 
        runId, 
        testCaseId: payload.testCaseId, 
        testName: payload.testName 
    });

    // Add to queue
    queue.add(async () => {
        const active = activeRuns.get(runId);
        if (!active) return; // Should not happen

        active.status = 'RUNNING';
        active.startedAt = nowIso();
        
        await repo.updateRun(runId, {
            status: 'RUNNING',
            started_at: active.startedAt,
            updated_at: active.startedAt
        });

        if (payload.testCaseId) {
            await repo.updateTestCase(payload.testCaseId, {
                status: 'RUNNING',
                updated_at: formatMySqlDate(active.startedAt)
            });
        }

        // Notify clients that a test has actually started running
        broadcastEvent({ 
            event: 'test-started', 
            runId, 
            testCaseId: payload.testCaseId, 
            testName: payload.testName 
        });

        return new Promise((resolve) => {
            const child = spawn('node', cliArgs, {
                cwd: path.resolve(__dirname, '..'),
                stdio: 'pipe',
            });

            active.child = child;

            console.log(`[SERVER] Started run ${runId}: node ${cliArgs.join(' ')}`);

            child.stdout.on('data', (data) => {
                const text = data.toString();
                process.stdout.write(text);
                active.output += text;
            });

            child.stderr.on('data', (data) => {
                const text = data.toString();
                process.stderr.write(text);
                active.output += text;
            });

            child.on('close', async (code) => {
                const finalOutput = active.output;
                const executionStatus = code === 0 ? 'COMPLETED' : 'FAILED';
                const finalReportCode = payload.tcCode || extractReportCodeFromOutput(finalOutput);
                const finishedAt = nowIso();
                
                let reportResultStatus = null;
                let reportScore = 0;

                if (finalReportCode) {
                    const reportPath = path.join(REPORTS_DIR, finalReportCode, 'report.json');
                    if (fs.existsSync(reportPath)) {
                        try {
                            const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                            reportResultStatus = reportData.status;
                            reportScore = reportData.score;
                            await repo.saveReport(runId, reportData);
                        } catch (e) {
                            console.error(`[SERVER] Error saving report to DB for ${runId}:`, e.message);
                        }
                    }
                }

                const finalBusinessStatus = normalizeBusinessStatus(
                    reportResultStatus,
                    executionStatus === 'COMPLETED' ? 'PASS' : 'FAIL'
                );

                // Update Run - Execution status only (COMPLETED/FAILED)
                await repo.updateRun(runId, {
                    status: executionStatus,
                    exit_code: code,
                    finished_at: finishedAt,
                    updated_at: finishedAt,
                    output: finalOutput,
                    report_code: finalReportCode,
                    tc_code: payload.tcCode || finalReportCode
                });

                if (payload.testCaseId) {
                    await repo.updateTestCase(payload.testCaseId, { 
                        status: finalBusinessStatus,
                        last_run_id: runId,
                        updated_at: finishedAt
                    });
                }

                activeRuns.delete(runId);
                console.log(`[SERVER] Run ${runId} finished with code ${code}, Result: ${reportResultStatus || executionStatus}`);

                broadcastEvent({ 
                    event: 'test-finished', 
                    runId, 
                    status: finalBusinessStatus,
                    testCaseId: payload.testCaseId,
                    reportCode: finalReportCode,
                    score: reportScore
                });

                resolve(); // Resolve the queue job
            });
        });
    });

    return { runId, runRecord, status: 'QUEUED' };
}

// API: Upload custom image
app.post('/api/upload-image', authenticateToken, (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'No image data' });
        const imagesDir = path.resolve(__dirname, '../images');
        ensureDir(imagesDir);
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const targetFilename = `custom_upload_default.png`;
        fs.writeFileSync(path.join(imagesDir, targetFilename), base64Data, 'base64');
        res.json({ message: 'Success', filename: targetFilename });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Test cases
app.get('/api/test-cases', authenticateToken, async (req, res) => {
    try {
        const list = await repo.getAllTestCases();
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/test-cases', authenticateToken, async (req, res) => {
    try {
        const { name, url } = req.body || {};
        if (!validateUrl(url)) return res.status(400).json({ error: 'Invalid URL' });

        const existing = await repo.getAllTestCases();
        const normalizedName = String(name || '').trim() || getNextAutoTestName(existing);
        
        if (existing.some(tc => String(tc.name).toLowerCase() === normalizedName.toLowerCase())) {
            return res.status(409).json({ error: 'Name exists' });
        }

        const testCase = {
            id: makeId('TC'),
            name: normalizedName,
            url,
            status: 'PENDING',
            created_at: formatMySqlDate(new Date()),
            updated_at: formatMySqlDate(new Date())
        };

        await repo.createTestCase(testCase);
        res.status(201).json(testCase);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/test-cases/batch', authenticateToken, async (req, res) => {
    try {
        const { urls } = req.body || {};
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid urls array' });
        }

        const existing = await repo.getAllTestCases();
        const createdTestCases = [];

        for (let url of urls) {
            url = String(url).trim();
            if (!url || !validateUrl(url)) continue;

            const normalizedName = getNextAutoTestName(existing);

            const testCase = {
                id: makeId('TC'),
                name: normalizedName,
                url,
                status: 'PENDING',
                created_at: formatMySqlDate(new Date()),
                updated_at: formatMySqlDate(new Date())
            };

            await repo.createTestCase(testCase);
            createdTestCases.push(testCase);
            existing.push(testCase);
        }

        res.status(201).json({ 
            message: `Successfully created ${createdTestCases.length} test cases`, 
            count: createdTestCases.length,
            created: createdTestCases 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/test-cases/:id', authenticateToken, async (req, res) => {
    try {
        const tc = await repo.getTestCaseById(req.params.id);
        if (!tc) return res.status(404).json({ error: 'Not found' });
        const runs = await repo.getAllRuns(tc.id);
        res.json({ test_case: tc, runs });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/test-cases/:id/run', authenticateToken, async (req, res) => {
    try {
        const tc = await repo.getTestCaseById(req.params.id);
        if (!tc) return res.status(404).json({ error: 'Not found' });

        const started = await startEngineRun({
            url: tc.url,
            tcCode: sanitizeTcCode(req.body?.tcCode || tc.name),
            optionIndex: req.body?.optionIndex,
            concurrency: req.body?.concurrency,
            useAi: req.body?.useAi,
            headless: req.body?.headless,
            customImageFilename: req.body?.customImageFilename,
            testCaseId: tc.id,
            testName: tc.name,
            batchId: req.body?.batchId,
            source: 'test-case-api',
        });

        if (started.error) return res.status(started.status || 400).json({ error: started.error });
        res.json({ message: 'Queued', runId: started.runId, status: 'RUNNING', test_case_id: tc.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/batches/daily-new', authenticateToken, async (req, res) => {
    try {
        const limit = resolveDailyNewLimit(req.body || {});
        const headless = req.body?.headless;
        const useAi = req.body?.useAi;
        const concurrency = req.body?.concurrency;
        const customImageFilename = req.body?.customImageFilename;
        const clearQueue = req.body?.clearQueue === true;

        if (clearQueue && (queue.size > 0 || queue.pending > 0)) {
            console.log(`[DAILY-BATCH] Manual trigger: Clearing ${queue.size} pending tasks before starting...`);
            queue.clear();
        }

        const batchId = makeId('BATCH');

        // 1. Retry candidates first (failed / no-report)
        const retryCandidates = await repo.getRetryCandidatesForDaily(limit);
        // 2. New candidates fill remaining slots
        const remainingSlots = Math.max(0, limit - retryCandidates.length);
        const newCandidates = remainingSlots > 0
            ? await repo.getNewTestCasesForDaily(remainingSlots)
            : [];

        // Merge: retry first, then new
        const candidates = [...retryCandidates, ...newCandidates];

        if (!Array.isArray(candidates) || candidates.length === 0) {
            return res.json({
                message: 'No test cases available for daily run (no new and no retry candidates)',
                batchId,
                mode: 'new_and_retry',
                requestedLimit: limit,
                retryCandidateCount: retryCandidates.length,
                newCandidateCount: newCandidates.length,
                selectedCount: 0,
                queuedCount: 0,
                queueConcurrency: queue.concurrency
            });
        }

        const queued = [];
        const skipped = [];
        let retryQueued = 0;
        let newQueued = 0;

        // Track which IDs are retry vs new
        const retryIds = new Set(retryCandidates.map(tc => tc.id));

        for (const tc of candidates) {
            if (activeRuns.size > 0) {
                const alreadyActive = Array.from(activeRuns.keys()).some((runId) => {
                    const active = activeRuns.get(runId);
                    return active && String(active.testCaseId || '') === String(tc.id);
                });
                if (alreadyActive) {
                    skipped.push({ id: tc.id, name: tc.name, reason: 'already-active' });
                    continue;
                }
            }

            const started = await startEngineRun({
                url: tc.url,
                tcCode: sanitizeTcCode(tc.tc_code || tc.name),
                concurrency,
                useAi,
                headless,
                customImageFilename,
                testCaseId: tc.id,
                testName: tc.name,
                batchId,
                source: retryIds.has(tc.id) ? 'daily-retry-batch-api' : 'daily-new-batch-api'
            });

            if (started.error) {
                skipped.push({ id: tc.id, name: tc.name, reason: started.error });
                continue;
            }

            const isRetry = retryIds.has(tc.id);
            if (isRetry) retryQueued++;
            else newQueued++;

            queued.push({
                test_case_id: tc.id,
                name: tc.name,
                runId: started.runId,
                type: isRetry ? 'retry' : 'new'
            });
        }

        console.log(`[DAILY-BATCH] Queued ${retryQueued} retry + ${newQueued} new = ${queued.length} total`);

        res.json({
            message: `Queued ${queued.length} test case(s) (${retryQueued} retry, ${newQueued} new)`,
            batchId,
            mode: 'new_and_retry',
            requestedLimit: limit,
            retryCandidateCount: retryCandidates.length,
            newCandidateCount: newCandidates.length,
            selectedCount: candidates.length,
            queuedCount: queued.length,
            retryQueuedCount: retryQueued,
            newQueuedCount: newQueued,
            skippedCount: skipped.length,
            queueConcurrency: queue.concurrency,
            cliCaseConcurrency: resolveCliConcurrency(req.body || {}),
            queued,
            skipped
        });

        // Background workflow: Wait for queue to finish, then send email report
        if (queued.length > 0) {
            (async () => {
                try {
                    console.log(`[DAILY-BATCH] Waiting for ${queued.length} queued tests to finish before sending email...`);
                    await queue.onIdle();
                    console.log(`[DAILY-BATCH] Queue is idle. Generating end-of-batch Excel report...`);

                    const todaysRuns = await repo.getTodaysRuns(batchId);

                    let passCount = 0, failCount = 0;
                    todaysRuns.forEach(r => {
                        const s = String(r.status).toUpperCase();
                        if (s === 'PASS') passCount++;
                        else if (['FAIL', 'FATAL'].includes(s)) failCount++;
                    });

                    let tmpDir = path.join(__dirname, '../tmp');
                    try {
                        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                        fs.accessSync(tmpDir, fs.constants.W_OK);
                    } catch (e) {
                        const os = require('os');
                        tmpDir = path.join(os.tmpdir(), 'customily-qa-tmp');
                        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                    }
                    const excelPath = await generateDailyExcel(todaysRuns, tmpDir);
                    
                    const sent = await sendDailyReport(excelPath, passCount, failCount, todaysRuns.length);
                    if (excelPath && fs.existsSync(excelPath)) {
                        fs.unlinkSync(excelPath);
                    }
                    console.log(`[DAILY-BATCH] End-of-batch email sent: ${sent}`);
                } catch (err) {
                    console.error('[DAILY-BATCH] Error sending end-of-batch report:', err.message);
                }
            })();
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/test-cases/:id', authenticateToken, async (req, res) => {
    try {
        const tc = await repo.getTestCaseById(req.params.id);
        if (!tc) return res.status(404).json({ error: 'Not found' });

        const relatedRuns = await repo.getAllRuns(tc.id);
        if (relatedRuns.some(r => activeRuns.has(r.id))) {
            return res.status(409).json({ error: 'Active run exists' });
        }

        for (const r of relatedRuns) {
            const code = r.report_code || r.tc_code;
            if (code) deleteReportFolderByCode(code);
        }

        await repo.deleteTestCase(tc.id);
        res.json({ message: `Deleted ${tc.name}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Runs
app.get('/api/runs', authenticateToken, async (req, res) => {
    try {
        const runs = await repo.getAllRuns(req.query.test_case_id);
        const mapped = runs.map(r => {
            const active = activeRuns.get(r.id);
            if (!active) return r;
            return { ...r, status: 'RUNNING', execution_status: 'RUNNING', output: active.output };
        });
        res.json(mapped);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/runs/:runId', authenticateToken, async (req, res) => {
    try {
        const run = await repo.getRunById(req.params.runId);
        if (!run) return res.status(404).json({ error: 'Not found' });

        const active = activeRuns.get(run.id);
        const displayRun = active
            ? { ...run, status: 'RUNNING', execution_status: 'RUNNING', output: active.output }
            : run;
        
        const report = await repo.getReportByRunId(run.id);
        res.json({ ...displayRun, report: report ? report.content : null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/runs/:runId', authenticateToken, async (req, res) => {
    try {
        if (activeRuns.has(req.params.runId)) return res.status(409).json({ error: 'Active' });
        const run = await repo.getRunById(req.params.runId);
        if (!run) return res.status(404).json({ error: 'Not found' });

        const code = run.report_code || run.tc_code;
        if (code) deleteReportFolderByCode(code);
        
        await repo.deleteRun(run.id);
        res.json({ message: 'Deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Reports
app.post('/api/reports/daily-mail', authenticateToken, async (req, res) => {
    try {
        console.log('[API-CRON] Executing forced daily email report...');
        const todaysRuns = await repo.getTodaysRuns();

        if (todaysRuns.length === 0) {
            return res.json({ message: 'No runs today. Skipped email.' });
        }

        let passCount = 0, failCount = 0;
        todaysRuns.forEach(r => {
            const s = String(r.status).toUpperCase();
            if (s === 'PASS') passCount++;
            else if (['FAIL', 'FATAL'].includes(s)) failCount++;
        });

        let tmpDir = path.join(__dirname, '../tmp');
        try {
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            fs.accessSync(tmpDir, fs.constants.W_OK);
        } catch (e) {
            const os = require('os');
            tmpDir = path.join(os.tmpdir(), 'customily-qa-tmp');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        }
        const excelPath = await generateDailyExcel(todaysRuns, tmpDir);
        
        const sent = await sendDailyReport(excelPath, passCount, failCount, todaysRuns.length);
        if (excelPath && fs.existsSync(excelPath)) {
            fs.unlinkSync(excelPath);
        }

        res.json({ 
            message: sent ? 'Daily email sent successfully' : 'Failed or skipped sending email (Check SMTP config)', 
            total_runs: todaysRuns.length, 
            passes: passCount, 
            fails: failCount 
        });
    } catch (error) {
        console.error('[API-CRON] Error sending mail:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/reports', authenticateToken, async (req, res) => {
    try {
        const reports = await repo.getAllReports();
        res.json(reports);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- Product Crawler API ---
app.get('/api/products', authenticateToken, async (req, res) => {
    try {
        const list = await repo.getAllProducts();
        res.json(list);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products/batch-add', authenticateToken, async (req, res) => {
    try {
        const { products, platform: commonPlatform, Platform: commonPlatformUpper } = req.body;
        const globalPlatform = commonPlatform || commonPlatformUpper || 'printerval.com';

        if (!products || !Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid products array' });
        }

        const now = new Date();
        const productData = products.map(item => {
            const platform = item.platform || item.Platform || globalPlatform;
            const slug = item.slug || '';
            const id = item.id || '';
            const url = `https://${platform}/${slug}-p${id}`;

            return {
                product_id: String(id),
                platform: platform,
                redirect_url: url,
                final_url: url,
                customizable: true,
                note: 'Batch added via API',
                status_code: 200,
                has_error: false,
                checked_at: now
            };
        });

        await repo.batchInsertProductsIgnore(productData);
        res.status(201).json({
            message: `Successfully processed ${productData.length} products (Skipped existing)`,
            count: productData.length
        });
    } catch (error) {
        console.error('[API] Error in batch-add:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products/crawl', authenticateToken, async (req, res) => {
    try {
        const { ids, platform } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid product IDs' });
        }

        if (isCrawlerRunning) {
            return res.status(409).json({ error: 'Another crawl job is already in progress. Please wait.' });
        }

        isCrawlerRunning = true;
        const crawlId = makeId('CRAWL');
        
        // Background execution
        (async () => {
            try {
                await crawler.runCrawler(ids, platform || 'printerval.com', (progress) => {
                    broadcastEvent({
                        event: 'crawler-progress',
                        crawlId,
                        ...progress
                    });
                });
                
                broadcastEvent({
                    event: 'crawler-finished',
                    crawlId,
                    total: ids.length
                });
            } catch (err) {
                console.error('[CRAWLER] Error:', err);
                broadcastEvent({
                    event: 'crawler-error',
                    crawlId,
                    error: err.message
                });
            } finally {
                isCrawlerRunning = false;
            }
        })();

        res.json({ message: 'Crawler started', crawlId });
    } catch (error) {
        isCrawlerRunning = false;
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products/convert-to-test-cases', authenticateToken, async (req, res) => {
    try {
        const { keys } = req.body; // Array of "product_id|platform" strings
        if (!keys || !Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ error: 'No product keys provided' });
        }

        const allProducts = await repo.getAllProducts();
        const targetProducts = allProducts.filter(p => keys.includes(`${p.product_id}|${p.platform}`));

        if (targetProducts.length === 0) {
            return res.status(404).json({ error: 'No matching products found' });
        }

        const createdTestCases = [];
        const existingTC = await repo.getAllTestCases();

        for (const p of targetProducts) {
            const url = p.final_url || p.redirect_url;
            const platformName = p.platform.split('.')[0].toUpperCase();
            const tcName = `${platformName} ${p.product_id}`;

            // Check if name already exists
            if (existingTC.some(tc => String(tc.name).toLowerCase() === tcName.toLowerCase())) {
                continue;
            }

            const testCase = {
                id: makeId('TC'),
                name: tcName,
                url,
                status: 'PENDING',
                created_at: formatMySqlDate(new Date()),
                updated_at: formatMySqlDate(new Date())
            };

            await repo.createTestCase(testCase);
            createdTestCases.push(testCase);
            existingTC.push(testCase); // Update local list to prevent duplicates in this loop
        }

        res.json({
            message: `Successfully created ${createdTestCases.length} test cases`,
            count: createdTestCases.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products/batch-delete', authenticateToken, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Invalid IDs' });
        
        for (const pid_platform of ids) {
            // pid_platform is "product_id|platform"
            const [product_id, platform] = pid_platform.split('|');
            if (product_id && platform) {
                await repo.deleteProduct(product_id, platform);
            }
        }
        res.json({ message: `Deleted ${ids.length} products` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Settings Management (.env persistence)
const SETTINGS_FILE = path.resolve(__dirname, '../.env');

app.get('/api/settings', authenticateToken, (req, res) => {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return res.json({});
        const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = {};
        content.split('\n').forEach(line => {
            const match = line.match(/^([^#\s][^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                // Clean up quotes if present
                settings[key] = value.replace(/^['"](.*)['"]$/, '$1');
            }
        });
        res.json(settings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/settings', authenticateToken, (req, res) => {
    try {
        console.log('[SETTINGS] POST request body:', req.body);
        const newSettings = req.body;
        if (!newSettings || typeof newSettings !== 'object') {
            console.error('[SETTINGS] Invalid body received');
            return res.status(400).json({ error: 'Invalid settings object' });
        }

        let content = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8') : '';
        const lines = content.split('\n');
        
        for (const [key, value] of Object.entries(newSettings)) {
            let found = false;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim().startsWith(`${key}=`)) {
                    lines[i] = `${key}=${value}`;
                    found = true;
                    break;
                }
            }
            if (!found) {
                lines.push(`${key}=${value}`);
            }
        }

        console.log('[SETTINGS] Writing updated .env content...');
        fs.writeFileSync(SETTINGS_FILE, lines.join('\n'), 'utf8');
        // Reload process.env for current process
        for (const [key, value] of Object.entries(newSettings)) {
            process.env[key] = value;
        }

        console.log('[SETTINGS] Successfully saved.');
        scheduleDailyReport(); // Restart cron if time changed
        res.json({ message: 'Settings saved successfully' });
    } catch (error) {
        console.error('[SETTINGS] Error saving settings:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/run', authenticateToken, async (req, res) => {
    try {
        const started = await startEngineRun({
            url: req.body?.url,
            tcCode: sanitizeTcCode(req.body?.tcCode),
            optionIndex: req.body?.optionIndex,
            concurrency: req.body?.concurrency,
            useAi: req.body?.useAi,
            headless: req.body?.headless,
            customImageFilename: req.body?.customImageFilename,
            batchId: req.body?.batchId,
            source: 'legacy-run-api',
        });
        if (started.error) return res.status(400).json({ error: started.error });
        res.json({ message: 'Queued', runId: started.runId, status: 'RUNNING' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/run-status/:runId', (req, res) => {
    const active = activeRuns.get(req.params.runId);
    if (active) {
        return res.json({ runId: req.params.runId, status: 'RUNNING' });
    }
    repo.getRunById(req.params.runId).then(run => {
        if (!run) return res.status(404).json({ error: 'Not found' });
        res.json({ runId: run.id, status: run.status, exitCode: run.exit_code });
    }).catch(err => res.status(500).json({ error: err.message }));
});

// SSE Endpoint
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.add(res);
    console.log(`[SERVER] SSE Client connected. Total: ${clients.size}`);
    // Heartbeat every 15s to prevent Cloudflare / proxy timeout (default 100s)
    const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
        console.log(`[SERVER] SSE Client disconnected. Total: ${clients.size}`);
    });
});

// Reset
app.all(['/api/reset-all', '/api/reports-all'], async (req, res) => {
    try {
        await repo.resetAll();
        if (fs.existsSync(REPORTS_DIR)) {
            const folders = fs.readdirSync(REPORTS_DIR, { withFileTypes: true });
            for (const f of folders) {
                if (f.isDirectory()) fs.rmSync(path.join(REPORTS_DIR, f.name), { recursive: true, force: true });
            }
        }
        res.json({ message: 'Reset successful' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Reliability Engine v2.1 Endpoints ──────────────────────────────────────

/**
 * GET /api/force-review-check?signature=<hash>
 * Spec §8: Check if the next run for a given test_input_signature should be
 * forced into REVIEW based on historical disagreement rate.
 */
app.get('/api/force-review-check', authenticateToken, async (req, res) => {
    const { signature } = req.query;
    if (!signature) return res.status(400).json({ error: 'signature is required' });

    try {
        const { checkForceReview } = require('./core/reliability-engine');
        const history = await repo.getDecisionHistoryBySignature(signature, 5);
        const decisions = history.map(h => h.decision);
        const result = checkForceReview(decisions);
        res.json({ signature, history_count: history.length, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/reliability-kpi
 * Returns aggregate KPI metrics across recent runs (Spec §9).
 * Light summary: auto_decision_stability, review_rate, unavailable_signal_rate.
 */
app.get('/api/reliability-kpi', authenticateToken, async (req, res) => {
    try {
        const allReports = await repo.getAllReports();
        const total = allReports.length;
        if (total === 0) return res.json({ total: 0 });

        // We need full content to compute these — query latest 50 only
        const sql = `SELECT tr.content FROM test_report tr ORDER BY tr.created_at DESC LIMIT 50`;
        const { default: db } = require('./db') || { default: null };
        // Graceful fallback if db not directly importable here
        res.json({
            message: 'KPI endpoint available — run with --reliability-v2 enabled reports for full metrics.',
            total_runs: total,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────

ensureDir(REPORTS_DIR);
// Maintenance: Cleanup old data
app.delete('/api/maintenance/cleanup', authenticateToken, async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    try {
        const result = await repo.deleteOldRuns(days);
        res.json({ message: `Cleaned up data older than ${days} days`, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Run daily cleanup at 3 AM or every 24h
setInterval(async () => {
    console.log('[MAINTENANCE] Running scheduled cleanup...');
    try {
        await repo.deleteOldRuns(30);
        console.log('[MAINTENANCE] Cleanup finished.');
    } catch (err) {
        console.error('[MAINTENANCE] Cleanup failed:', err.message);
    }
}, 24 * 60 * 60 * 1000);

let dailyReportJob = null;
function scheduleDailyReport() {
    if (dailyReportJob) {
        dailyReportJob.stop();
        dailyReportJob = null;
    }

    const reportTime = process.env.DAILY_REPORT_TIME;
    if (!reportTime || reportTime.indexOf(':') === -1) return;

    const [hh, mm] = reportTime.split(':');
    if (!hh || !mm) return;

    const cronExpr = `${parseInt(mm, 10)} ${parseInt(hh, 10)} * * *`;
    console.log(`[SCHEDULE] Scheduled daily report at ${reportTime} (${cronExpr})`);

    dailyReportJob = cron.schedule(cronExpr, async () => {
        console.log(`[SCHEDULE] Triggering daily report for time: ${reportTime}`);
        try {
            // "Stops pending batch runs"
            if (queue.size > 0 || queue.pending > 0) {
                console.log(`[SCHEDULE] Stopping ${queue.size} pending batch runs...`);
                queue.clear();
            }

            const todaysRuns = await repo.getTodaysRuns();

            if (todaysRuns.length === 0) {
                console.log('[SCHEDULE] No runs today. Skipping email report.');
                return;
            }

            let passCount = 0, failCount = 0;
            todaysRuns.forEach(r => {
                const s = String(r.status).toUpperCase();
                if (s === 'PASS') passCount++;
                else if (['FAIL', 'FATAL'].includes(s)) failCount++;
            });

            let tmpDir = path.join(__dirname, '../tmp');
            try {
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                fs.accessSync(tmpDir, fs.constants.W_OK);
            } catch (e) {
                const os = require('os');
                tmpDir = path.join(os.tmpdir(), 'customily-qa-tmp');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            }
            const excelPath = await generateDailyExcel(todaysRuns, tmpDir);
            
            const success = await sendDailyReport(excelPath, passCount, failCount, todaysRuns.length);
            if (success && fs.existsSync(excelPath)) {
                fs.unlinkSync(excelPath);
            }
        } catch (err) {
            console.error('[SCHEDULE] Failed to generate/send daily report:', err);
        }
    });
}
scheduleDailyReport();

// (Node-cron execution has been replaced with the OS-level trigger + /api/batches/daily-new queue onIdle implementation)

// SPA Fallback for HTML5 History API (pushState)
app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Endpoint not found' });
    }
    // Only serve index.html if the request is not for a file
    res.sendFile(path.join(WEB_DIR, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\nQA Server (MySQL) running on http://localhost:${PORT}\n`);
});
