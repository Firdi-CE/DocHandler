const nodemailer = require('nodemailer');

// Configure the transporter using environment variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT == 465, // true for 465 (SSL), false for other ports (e.g. 587/STARTTLS)
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

/**
 * Sends a standard system notification email
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject line
 * @param {string} text - Plain text body
 * @param {string} html - HTML formatted body (optional)
 */
async function sendMail(to, subject, text, html) {
    try {
        const info = await transporter.sendMail({
            from: `"DocHandler Alerts" <${process.env.SMTP_USER}>`,
            to,
            subject,
            text,
            html: html || `<p>${text}</p>`
        });
        console.log(`✉️ Email sent to ${to}: [${info.messageId}]`);
        return true;
    } catch (error) {
        console.error(`❌ Mail Error targeting ${to}:`, error.message);
        return false;
    }
}

module.exports = { sendMail };