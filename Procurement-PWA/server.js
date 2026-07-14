const cron = require('node-cron');
const nodemailer = require('nodemailer');
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const auth = require('./auth'); // Imports JWT auth helpers
const db = require('./db');         // Imports PostgreSQL connection pool from db.js
const { sendMail } = require('./utils/mailer');
const cron = require('node-cron');
const { runDigest } = require('./utils/digest');
const app = express();
// Configure the Mail Transporter for Notification Digest
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false, // Use true if port is 465
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});
const PORT = process.env.PORT || 3000;

// --- 1. MIDDLEWARE CONFIGURATION ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static web interface assets from the public directory
app.use(express.static(path.join(__dirname, 'public')));


// --- 2. SELF-CORRECTING MULTER STORAGE PATH ---
const uploadDir = path.join(__dirname, 'uploads');

// Automatically build directory path if missing to prevent ENOENT errors
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Created missing uploads folder structure at:', uploadDir);
}

// Helper to format date as YYYY-MM-DD HHhMMm
function getFormattedTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    // Using h and m is safer for filenames than colons
    return `${year}-${month}-${day} ${hours}h${minutes}m`;
}

// Storage engine configuration keeping original names safely timestamps
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const timestamp = getFormattedTimestamp();
        const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9. _-]/g, '');
        cb(null, `(${timestamp}) ${safeOriginalName}`);
    }
});
const upload = multer({ storage: storage });

// --- 3. AUTHENTICATION ROUTES & MIDDLEWARE ---

// New endpoint for client-side Google Sign-In.
// The client sends the Google ID token, the server verifies it and returns a JWT.
app.post('/auth/google/login', async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({ message: 'idToken is required' });
        }
        const result = await auth.handleGoogleLogin(idToken);
        res.json(result);
    } catch (error) {
        console.error('Google login error:', error);
        res.status(401).json({ message: 'Authentication failed', details: error.message });
    }
});

// Middleware to protect routes by verifying the JWT.
const ensureAuthenticated = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Not authenticated: No token provided' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = auth.verifyToken(token);
        // Attach user info from token to the request object
        req.user = { id: decoded.userId, email: decoded.email, role: decoded.role, department_id: decoded.departmentId, display_name: decoded.displayName };
        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Not authenticated: Invalid token' });
    }
};

// Middleware to ensure user is an admin
const ensureAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'Executive') {
        return next();
    }
    res.status(403).json({ message: 'Forbidden: Requires admin privileges' });
};

// --- 4. DATA SELECT DROPDOWN ENDPOINTS ---

// API Endpoint to fetch existing company projects to build frontend selections dynamically
app.get('/projects', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.query('SELECT id, name FROM projects ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// API endpoint to fetch all departments
app.get('/departments', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.query('SELECT id, name FROM departments ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// API Endpoint to fetch users grouped by selected department for chained dependent options
app.get('/users/by-department/:deptId', ensureAuthenticated, async (req, res) => {
    try {
        const { deptId } = req.params;
        const result = await db.query(
            'SELECT id, email, display_name FROM users WHERE department_id = $1 ORDER BY display_name ASC',
            [deptId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});


// --- 5. DOCUMENT TRANSACTION MANAGEMENT ---
// Secure PDF Streamer (Data-Level Scoped)
app.get('/documents/:id/stream', ensureAuthenticated, async (req, res) => {
    try {
        const docId = req.params.id;
        const userId = req.user.id;
        const userRole = req.user.role;
        const deptId = req.user.department_id;

        // 1. Verify Document Exists & Fetch Metadata
        const docRes = await db.query(`SELECT * FROM documents WHERE id = $1`, [docId]);
        if (docRes.rows.length === 0) return res.status(404).json({ message: 'Document not found.' });
        
        const doc = docRes.rows[0];

        // 2. Enforce Role-Based Scoping
        let hasAccess = false;
        if (userRole === 'Executive') {
            hasAccess = true;
        } else if (userRole === 'Supervisor') {
            const projCheck = await db.query(`SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2`, [userId, doc.project_id]);
            if (doc.department_id === deptId || projCheck.rows.length > 0) hasAccess = true;
        } else { // Staff
            const projCheck = await db.query(`SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2`, [userId, doc.project_id]);
            if (doc.sender_id === userId || doc.recipient_id === userId || projCheck.rows.length > 0) hasAccess = true;
        }

        if (!hasAccess) {
            return res.status(403).json({ message: 'Access denied to this document.' });
        }

        // 3. Stream File
        const filePath = path.join(__dirname, 'uploads', doc.filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'Physical file missing from server.' });
        }

        // Serve file as a stream so the browser can render it in an iframe
        const fileStream = fs.createReadStream(filePath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
        fileStream.pipe(res);

    } catch (err) {
        console.error('Streaming Error:', err);
        res.status(500).json({ message: 'Server error while streaming document.' });
    }
});
// Endpoint handling physical multi-part upload write transactions and relational database linking
app.post('/upload', ensureAuthenticated, upload.single('document'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }

        // 1. Capture file metadata from Multer
        const filename = req.file.filename;
        const filePath = req.file.path; // CRITICAL: Required for retrieval
        
        // 2. Capture user identity
        const uploadedBy = req.user.id; 

        // 3. Capture & Sanitize Form Data (Convert empty strings to null for PG Int columns)
        const recipientId = req.body.recipientId || null;
        const projectId = req.body.projectId || null;
        const departmentId = req.body.departmentId || null;
        // Checkboxes are omitted from multipart form data entirely when unchecked,
        // and arrive as the string 'true'/'on' when checked -- never a real boolean.
        const isUrgent = req.body.isUrgent === 'true' || req.body.isUrgent === 'on';

        // Perform strict table transaction mapping elements cleanly to table relations
        const query = `
            INSERT INTO public.documents (filename, sender_id, recipient_id, project_id, department_id, is_urgent)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id;
        `;
        const values = [filename, uploadedBy, recipientId, projectId, departmentId, isUrgent];
        const insertRes = await db.query(query, values);
        const newDocId = insertRes.rows[0].id;

        console.log(`Document transaction completed successfully: ${filename}`);

        // --- NOTIFY RECIPIENT: urgent bypasses the digest and emails immediately;
        //     everything else queues for the next digest run. ---
        if (recipientId) {
            if (isUrgent) {
                const userRes = await db.query('SELECT email, display_name FROM users WHERE id = $1', [recipientId]);
                if (userRes.rows.length > 0) {
                    const targetEmail = userRes.rows[0].email;
                    const targetName = userRes.rows[0].display_name;
                    const subject = `🔴 URGENT Document: ${filename}`;
                    const text = `Hello ${targetName},\n\nAn URGENT document "${filename}" has been uploaded and routed to your inbox by ${req.user.display_name}. Please log into DocHandler to review it immediately.`;
                    const html = `
                        <h3 style="color:#b91c1c;">🔴 Urgent Document</h3>
                        <p>Hello ${targetName},</p>
                        <p>An <strong style="color:#b91c1c;">URGENT</strong> document <strong>${filename}</strong> has been routed to your inbox by ${req.user.display_name}.</p>
                        <p>Please log in to review it immediately.</p>
                    `;
                    // Fire and forget
                    sendMail(targetEmail, subject, text, html);
                }
            } else {
                await db.query(
                    `INSERT INTO public.notification_queue (document_id, recipient_id) VALUES ($1, $2)`,
                    [newDocId, recipientId]
                );
            }
        }
        // ---------------------------------------------

        res.status(200).send('Document sent!');
    } catch (err) {
        console.error('Database Upload Route Error:', err);
        res.status(500).send('Error saving document metadata relation fields.');
    }
});

// Endpoint to capture inbox layout listings targeting single identity profile logs
app.get('/documents/my-inbox', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;
        const deptId = req.user.department_id; // Securely extracted from JWT payload

        let baseQuery = `
            SELECT d.*, p.name as project_name, u_sender.email as sender_email,
                   u_sender.display_name as sender_name, dept.name as department_name
            FROM documents d
            LEFT JOIN projects p ON d.project_id = p.id
            LEFT JOIN users u_sender ON d.sender_id = u_sender.id
            LEFT JOIN departments dept ON d.department_id = dept.id
        `;

        let queryParams = [];

        if (userRole === 'Executive') {
            // God Mode: View all documents across the entire company
            baseQuery += ` ORDER BY d.created_at DESC`;
        } else if (userRole === 'Supervisor') {
            // Department Level: View all dept documents OR explicitly assigned projects
            baseQuery += `
                WHERE d.department_id = $1 
                   OR d.project_id IN (SELECT project_id FROM project_assignments WHERE user_id = $2)
                ORDER BY d.created_at DESC
            `;
            queryParams = [deptId, userId];
        } else {
            // Staff Level: View personal (sender/recipient) OR explicitly assigned projects
            baseQuery += `
                WHERE d.recipient_id = $1 
                   OR d.sender_id = $1 
                   OR d.project_id IN (SELECT project_id FROM project_assignments WHERE user_id = $1)
                ORDER BY d.created_at DESC
            `;
            queryParams = [userId];
        }

        const result = await db.query(baseQuery, queryParams);
        res.json(result.rows);
    } catch (err) {
        console.error('Inbox Scoping Error:', err);
        res.status(500).json({ message: err.message });
    }
});

// Endpoint to rename a document
app.patch('/documents/:id/rename', ensureAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const { filename: newBaseName } = req.body;
        if (!newBaseName) return res.status(400).json({ message: 'New filename is required.' });

        const docRes = await db.query('SELECT filename FROM documents WHERE id = $1', [id]);
        if (docRes.rows.length === 0) return res.status(404).json({ message: 'Document not found' });
        
        const ext = path.extname(docRes.rows[0].filename);
        const newFilename = `${newBaseName}${ext}`;

        await db.query('UPDATE documents SET filename = $1 WHERE id = $2', [newFilename, id]);
        res.json({ message: 'Rename successful', newFilename });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});


// --- 5. ADMIN ROUTES ---

// Assign a user to a specific project (Role-based data scoping mapping)
app.post('/admin/assign-project', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        // Defensive DB rule: convert empty strings "" to null
        const userId = req.body.user_id || null;
        const projectId = req.body.project_id || null;

        if (!userId || !projectId) {
            return res.status(400).json({ message: 'Both user_id and project_id are required.' });
        }

        const query = `
            INSERT INTO public.project_assignments (user_id, project_id) 
            VALUES ($1, $2)
        `;
        
        await db.query(query, [userId, projectId]);
        res.status(200).json({ message: 'User successfully assigned to project.' });
        
    } catch (err) {
        console.error('Database Project Assignment Error:', err);
        // Specifically catch unique constraint violations if a user is already assigned
        if (err.code === '23505') {
            return res.status(409).json({ message: 'User is already assigned to this project.' });
        }
        res.status(500).json({ message: 'Error mapping user to project.' });
    }
});
// --- PROJECT MANAGEMENT (ADMIN) ---

// Create a new project
app.post('/admin/projects', ensureAuthenticated, ensureAdmin, async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required.' });

    try {
        const result = await db.query(
            'INSERT INTO projects (name) VALUES ($1) RETURNING *',
            [name]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rename a project
app.patch('/admin/projects/:id', ensureAuthenticated, ensureAdmin, async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'New project name is required.' });

    try {
        const result = await db.query(
            'UPDATE projects SET name = $1 WHERE id = $2 RETURNING *',
            [name, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found.' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete a project
app.delete('/admin/projects/:id', ensureAuthenticated, ensureAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM projects WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found.' });
        res.json({ message: 'Project deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all pending account requests
app.get('/admin/requests', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM account_requests ORDER BY created_at ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Approve an account request
app.post('/admin/requests/:id/approve', ensureAuthenticated, ensureAdmin, async (req, res) => {
    const { id } = req.params;
    const { role, department_id } = req.body;

    if (!role || !department_id) {
        return res.status(400).json({ message: 'Role and department are required.' });
    }

    try {
        // Use a transaction
        await db.query('BEGIN');

        const requestRes = await db.query('SELECT * FROM account_requests WHERE id = $1', [id]);
        if (requestRes.rows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(404).json({ message: 'Request not found.' });
        }
        const request = requestRes.rows[0];

        // Insert into users table
        await db.query(
            'INSERT INTO users (email, google_id, display_name, role, department_id, is_approved) VALUES ($1, $2, $3, $4, $5, TRUE)',
            [request.email, request.google_id, request.display_name, role, department_id]
        );

        // Delete from requests table
        await db.query('DELETE FROM account_requests WHERE id = $1', [id]);

        await db.query('COMMIT');
        res.status(200).json({ message: 'User approved successfully.' });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ message: err.message });
    }
});

// Deny (delete) an account request
app.delete('/admin/requests/:id', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM account_requests WHERE id = $1', [id]);
        res.status(200).json({ message: 'Request denied successfully.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Get all users
app.get('/admin/users', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.email, u.display_name, u.role, u.department_id, d.name as department_name, u.is_approved
            FROM users u
            LEFT JOIN departments d ON u.department_id = d.id
            ORDER BY u.display_name ASC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Update a user's role or department
app.patch('/admin/users/:id', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role, department_id } = req.body;

        if (!role && !department_id) {
            return res.status(400).json({ message: 'Either role or department_id is required.' });
        }

        await db.query('UPDATE users SET role = $1, department_id = $2 WHERE id = $3', [role, department_id, id]);
        res.status(200).json({ message: 'User updated successfully.' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Endpoint for the frontend to verify the user's session and get user data.
app.get('/auth/me', ensureAuthenticated, (req, res) => {
    // If ensureAuthenticated passes, req.user is guaranteed to exist.
    res.json(req.user);
});
// --- 6. EXECUTIVE APPROVAL WORKFLOW ---

// Endpoint to toggle document status (Pending, Approved, Rejected)
// --- EXECUTIVE APPROVAL WORKFLOW ---
app.patch('/documents/:id/status', ensureAuthenticated, async (req, res) => {
    try {
        if (req.user.role !== 'executive') {
            return res.status(403).json({ message: 'Only Executives can approve or reject documents.' });
        }

        const documentId = req.params.id;
        const { status } = req.body; 

        if (!['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status provided.' });
        }

        const result = await db.query(
            'UPDATE documents SET status = $1 WHERE id = $2 RETURNING *',
            [status, documentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Document not found.' });
        }

        const doc = result.rows[0];

        // --- BATCH NOTIFICATION QUEUE INJECTION ---
        await db.query(
            'INSERT INTO notification_queue (document_id, recipient_id, created_at) VALUES ($1, $2, NOW())',
            [doc.id, doc.sender_id] 
        );

        res.json({ 
            message: `Document status updated to ${status}. Notification queued.`, 
            document: doc 
        });
    } catch (err) {
        console.error('Approval Workflow Error:', err);
        res.status(500).json({ message: 'Database error updating document status.' });
    }
});
// --- 7. DIGEST NOTIFICATION SCHEDULING ---

// Manually trigger a digest run on demand -- useful for testing without
// waiting for the cron schedule, and gives an Executive a way to force a
// send if needed.
app.post('/admin/digest/run', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        const summary = await runDigest();
        res.json({ message: 'Digest run complete.', summary });
    } catch (err) {
        console.error('Manual digest trigger error:', err);
        res.status(500).json({ message: 'Failed to run digest.' });
    }
});

// Scheduled digest run. Defaults to every 4 hours; override with
// DIGEST_CRON_SCHEDULE in .env using standard cron syntax (e.g. '0 9,17 * * *'
// for twice daily at 9am/5pm). Urgent documents never wait on this -- they're
// emailed immediately at upload time.
const digestSchedule = process.env.DIGEST_CRON_SCHEDULE || '0 */4 * * *';
cron.schedule(digestSchedule, async () => {
    console.log(`Running scheduled digest (${digestSchedule})...`);
    const summary = await runDigest();
    console.log('Digest run complete:', summary);
});

// --- 8. START SERVER ENGINE ---
app.listen(PORT, () => {
    console.log(`PBE OneForAll active application server streaming live at http://localhost:${PORT}`);
});