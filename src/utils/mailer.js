const nodemailer = require('nodemailer');
const fs = require('fs');

async function sendDailyReport(excelFilePath, passCount, failCount, totalCount) {
    const host = process.env.MAIL_HOST;
    const port = process.env.MAIL_PORT;
    const user = process.env.MAIL_USERNAME;
    const pass = process.env.MAIL_PASSWORD;
    const encryption = process.env.MAIL_ENCRYPTION;
    const fromAddress = process.env.MAIL_FROM_ADDRESS || user;
    const fromName = process.env.MAIL_FROM_NAME || 'QA Automation Server';
    const to = process.env.DAILY_REPORT_TO;
    const cc = process.env.DAILY_REPORT_CC;

    if (!host || !user || !pass || !to) {
        console.log('[MAILER] Missing SMTP configuration or recipient. Skipping email.');
        return false;
    }

    const isSecure = encryption === 'ssl' || Number(port) === 465;
    const transporter = nodemailer.createTransport({
        host,
        port: Number(port) || 1025,
        secure: isSecure,
        auth: (user && user !== 'null') ? { user, pass } : undefined
    });

    const dateStr = new Date().toISOString().split('T')[0];
    const subject = `QA Daily Report - ${dateStr}`;
    const html = `
        <h2>Daily QA Automation Report</h2>
        <p>Date: ${dateStr}</p>
        <p><strong>Total Runs:</strong> ${totalCount}</p>
        <p><strong style="color:green">Passed:</strong> ${passCount}</p>
        <p><strong style="color:red">Failed:</strong> ${failCount}</p>
        <br/>
        <p>Please find the attached Excel report for detailed test case results.</p>
    `;

    const mailOptions = {
        from: `"${fromName}" <${fromAddress}>`,
        to,
        cc: cc || undefined,
        subject,
        html,
        attachments: []
    };

    if (excelFilePath && fs.existsSync(excelFilePath)) {
        mailOptions.attachments.push({
            filename: `QA_Report_${dateStr}.xlsx`,
            path: excelFilePath
        });
    }

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('[MAILER] Email sent successfully:', info.messageId);
        return true;
    } catch (err) {
        console.error('[MAILER] Error sending email:', err.message);
        return false;
    }
}

module.exports = { sendDailyReport };
