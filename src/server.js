const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8090;

const WEB_DIR = path.resolve(__dirname, '../../web');
const REPORTS_DIR = path.join(WEB_DIR, 'reports');

app.use(cors());
app.use(express.json());

// Serve static files from web directory
app.use(express.static(WEB_DIR));

// Track active runs
const activeRuns = new Map();

// API: Get all generated reports
app.get('/api/reports', (req, res) => {
    try {
        if (!fs.existsSync(REPORTS_DIR)) {
            return res.json([]);
        }

        const folders = fs.readdirSync(REPORTS_DIR).filter(f => /^QA\d+$/.test(f));
        const reports = [];

        for (const folder of folders) {
            const reportPath = path.join(REPORTS_DIR, folder, 'report.json');
            if (fs.existsSync(reportPath)) {
                try {
                    const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                    // Add source info
                    data.source = 'auto_import';
                    reports.push(data);
                } catch (e) {
                    console.error(`Error parsing ${reportPath}:`, e.message);
                }
            }
        }

        // Sort descending by test_time
        reports.sort((a, b) => new Date(b.test_time) - new Date(a.test_time));
        res.json(reports);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Trigger engine run
app.post('/api/run', (req, res) => {
    const { url, optionIndex, useAi } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'Missing product URL' });
    }

    const runId = 'RUN_' + Date.now();
    const cliArgs = ['src/cli.js', '--url=' + url];
    
    // Add specific index if provided
    if (typeof optionIndex === 'number') {
        cliArgs.push(`--option-index=${optionIndex}`);
    } else {
        // Just run default flat
    }
    
    if (req.body.headless === false) {
        cliArgs.push('--no-headless');
    }

    if (useAi === false) {
        cliArgs.push('--no-ai');
    }

    console.log(`[SERVER] Spawning Engine for ${runId}: node ${cliArgs.join(' ')}`);

    const child = spawn('node', cliArgs, {
        cwd: path.resolve(__dirname, '..'), // Run from engine/
        stdio: 'pipe'
    });

    activeRuns.set(runId, {
        status: 'RUNNING',
        url,
        startTime: new Date(),
        output: ''
    });

    child.stdout.on('data', (data) => {
        const str = data.toString();
        process.stdout.write(str); // echo to terminal
        const run = activeRuns.get(runId);
        if (run) run.output += str;
    });

    child.stderr.on('data', (data) => {
        const str = data.toString();
        process.stderr.write(str); // echo to terminal
        const run = activeRuns.get(runId);
        if (run) run.output += str;
    });

    child.on('close', (code) => {
        console.log(`[SERVER] Engine ${runId} exited with code ${code}`);
        const run = activeRuns.get(runId);
        if (run) {
            run.status = code === 0 ? 'COMPLETED' : 'FAILED';
            run.exitCode = code;
        }
    });

    res.json({ message: 'Test queued', runId, status: 'RUNNING' });
});

// API: Poll run status
app.get('/api/run-status/:runId', (req, res) => {
    const run = activeRuns.get(req.params.runId);
    if (!run) {
        return res.status(404).json({ error: 'Run not found' });
    }
    res.json({
        runId: req.params.runId,
        status: run.status,
        exitCode: run.exitCode,
    });
});

// API: Delete a report folder (QAx) and all its files
app.delete('/api/reports/:qaCode', (req, res) => {
    const qaCode = req.params.qaCode;

    // Validate qaCode format to prevent path traversal
    if (!/^QA\d+$/i.test(qaCode)) {
        return res.status(400).json({ error: 'Invalid QA code format' });
    }

    const reportDir = path.join(REPORTS_DIR, qaCode);
    if (!fs.existsSync(reportDir)) {
        return res.status(404).json({ error: 'Report not found' });
    }

    try {
        fs.rmSync(reportDir, { recursive: true, force: true });
        console.log(`[SERVER] Deleted report folder: ${reportDir}`);
        res.json({ message: `Deleted ${qaCode}`, qaCode });
    } catch (e) {
        console.error(`[SERVER] Failed to delete ${reportDir}:`, e.message);
        res.status(500).json({ error: 'Failed to delete report: ' + e.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 QA Dashboard & API Server running on port ${PORT}`);
    console.log(`👉 Open http://localhost:${PORT} in your browser`);
    console.log(`======================================================\n`);
});
