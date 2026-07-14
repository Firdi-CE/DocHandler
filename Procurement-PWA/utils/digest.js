const db = require('../db');
const { sendMail } = require('./mailer');

/**
 * Finds all unsent notification_queue rows, groups them by recipient, sends
 * one digest email per recipient listing every document they've received
 * since their last digest, then marks those rows as sent.
 *
 * Urgent documents never enter this queue -- they're emailed immediately at
 * upload time instead (see the /upload route in server.js).
 *
 * Returns a small summary object so callers (the cron job or the manual
 * trigger endpoint) can log/report what happened.
 */
async function runDigest() {
    const summary = { recipientsNotified: 0, documentsIncluded: 0, errors: [] };

    try {
        const pendingRes = await db.query(`
            SELECT nq.id AS queue_id, nq.document_id, nq.recipient_id,
                   d.filename, d.created_at AS document_created_at,
                   sender.display_name AS sender_name, sender.email AS sender_email,
                   p.name AS project_name,
                   recipient.email AS recipient_email, recipient.display_name AS recipient_name
            FROM public.notification_queue nq
            JOIN public.documents d ON nq.document_id = d.id
            JOIN public.users recipient ON nq.recipient_id = recipient.id
            LEFT JOIN public.users sender ON d.sender_id = sender.id
            LEFT JOIN public.projects p ON d.project_id = p.id
            WHERE nq.sent_at IS NULL
            ORDER BY nq.recipient_id, d.created_at ASC
        `);

        if (pendingRes.rows.length === 0) {
            return summary;
        }

        // Group rows by recipient_id
        const byRecipient = new Map();
        for (const row of pendingRes.rows) {
            if (!byRecipient.has(row.recipient_id)) byRecipient.set(row.recipient_id, []);
            byRecipient.get(row.recipient_id).push(row);
        }

        for (const [recipientId, rows] of byRecipient) {
            const recipientEmail = rows[0].recipient_email;
            const recipientName = rows[0].recipient_name;
            const queueIds = rows.map(r => r.queue_id);

            const listItemsText = rows.map(r =>
                `- ${r.filename} (from ${r.sender_name || r.sender_email || 'Unknown'}${r.project_name ? `, project: ${r.project_name}` : ''})`
            ).join('\n');

            const listItemsHtml = rows.map(r => `
                <li style="margin-bottom:8px;">
                    <strong>${r.filename}</strong><br>
                    <span style="color:#666;font-size:0.9em;">
                        From ${r.sender_name || r.sender_email || 'Unknown'}${r.project_name ? ` &middot; ${r.project_name}` : ''}
                    </span>
                </li>
            `).join('');

            const subject = `DocHandler Digest: ${rows.length} new document${rows.length > 1 ? 's' : ''}`;
            const text = `Hello ${recipientName},\n\nYou have ${rows.length} new document(s) waiting in DocHandler:\n\n${listItemsText}\n\nLog in to review them.`;
            const html = `
                <h3>DocHandler Digest</h3>
                <p>Hello ${recipientName},</p>
                <p>You have <strong>${rows.length}</strong> new document(s) waiting:</p>
                <ul>${listItemsHtml}</ul>
                <p>Log in to your dashboard to review them.</p>
            `;

            const sent = await sendMail(recipientEmail, subject, text, html);

            if (sent) {
                await db.query(
                    `UPDATE public.notification_queue SET sent_at = NOW() WHERE id = ANY($1::int[])`,
                    [queueIds]
                );
                summary.recipientsNotified += 1;
                summary.documentsIncluded += rows.length;
            } else {
                summary.errors.push(`Failed to send digest to ${recipientEmail} (queue rows left unmarked, will retry next run)`);
            }
        }
    } catch (err) {
        console.error('Digest job error:', err);
        summary.errors.push(err.message);
    }

    return summary;
}

module.exports = { runDigest };
