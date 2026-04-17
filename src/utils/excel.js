const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

async function generateDailyExcel(runs, reportsDir) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Daily Report');

    sheet.columns = [
        { header: 'Test Name', key: 'name', width: 30 },
        { header: 'URL', key: 'url', width: 40 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Score', key: 'score', width: 10 },
        { header: 'Pass Steps', key: 'passed_steps', width: 15 },
        { header: 'Total Steps', key: 'total_steps', width: 15 },
        { header: 'Duration', key: 'duration', width: 15 },
        { header: 'Confidence', key: 'confidence', width: 12 },
        { header: 'Time', key: 'time', width: 25 },
        { header: 'Reason Codes', key: 'reason_codes', width: 30 }
    ];

    // Filter logic:
    // 1. Status/ResultStatus is REVIEW
    // 2. Confidence < 60% (confidence_score < 0.6)
    // 3. 0/2 steps or 0/2 cases passed
    const filteredRuns = runs.filter(run => {
        const status = String(run.status || '').toUpperCase();
        const resultStatus = String(run.result_status || '').toUpperCase();
        
        // 1. Status or ResultStatus is FAIL, FATAL, or REVIEW
        const isProblematic = ['FAIL', 'FATAL', 'REVIEW'].includes(status) || 
                              ['FAIL', 'FATAL', 'REVIEW'].includes(resultStatus);
        
        // 2. Confidence threshold: 60% (0.6)
        const confidenceScore = run.confidence_score !== undefined ? run.confidence_score : 1.0;
        const lowConfidence = confidenceScore < 0.6;
        
        // 3. 0/2 case check (both steps and cases level)
        const isZeroOfTwoSteps = (run.total_steps === 2 && run.passed_steps === 0);
        const isZeroOfTwoCases = (run.total_cases === 2 && run.passed_cases === 0);
        const isZeroOfTwo = isZeroOfTwoSteps || isZeroOfTwoCases;

        return isProblematic || lowConfidence || isZeroOfTwo;
    });

    filteredRuns.forEach(run => {
        const rc = Array.isArray(run.reason_codes) ? run.reason_codes.join(', ') : (run.reason_codes || '');
        sheet.addRow({
            name: run.name || run.tc_code || 'Untitled',
            url: run.product_url || run.url || '',
            status: run.status || 'UNKNOWN',
            score: run.score || 0,
            passed_steps: run.passed_steps || 0,
            total_steps: run.total_steps || 0,
            duration: `${Math.round((run.duration_ms || 0)/1000)}s`,
            confidence: run.confidence_score !== undefined ? `${Math.round(run.confidence_score * 100)}%` : '100%',
            time: new Date(run.test_time || run.started_at || run.created_at).toLocaleString(),
            reason_codes: rc
        });
    });

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };

    sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
            const statusCell = row.getCell('status');
            const status = String(statusCell.value).toUpperCase();
            if (status === 'PASS') {
                statusCell.font = { color: { argb: 'FF008800' }, bold: true };
            } else if (status === 'FAIL' || status === 'FATAL') {
                statusCell.font = { color: { argb: 'FFCC0000' }, bold: true };
            } else if (status === 'WARNING') {
                statusCell.font = { color: { argb: 'FFE6A23C' }, bold: true };
            }
        }
    });

    const dateStr = new Date().toISOString().split('T')[0];
    const filepath = path.join(reportsDir, `Daily_Report_${dateStr}_${Date.now()}.xlsx`);
    
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    await workbook.xlsx.writeFile(filepath);
    return filepath;
}

module.exports = { generateDailyExcel };
