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

// Middleware to ensure user is an admin/executive.
// Accepts both 'Executive' and 'Admin' roles (Req 7).
// Re-verifies role against the DB so stale JWTs can't exploit cached role values.
const ensureAdmin = async (req, res, next) => {
    try {
        const dbRes = await db.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
        if (dbRes.rows.length === 0) return res.status(403).json({ message: 'Forbidden: User not found.' });
        const liveRole = dbRes.rows[0].role;
        if (liveRole === 'Executive' || liveRole === 'Admin') {
            req.user.role = liveRole; // keep req.user in sync with DB truth
            return next();
        }
        res.status(403).json({ message: 'Forbidden: Requires Executive or Admin privileges.' });
    } catch (err) {
        res.status(500).json({ message: 'Authorization check failed.' });
    }
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
// --- AUDIT LOG HELPER ---
async function auditLog(userId, actionType, entityId) {
    try {
        await db.query(
            'INSERT INTO public.audit_logs (user_id, action_type, entity_id) VALUES ($1, $2, $3)',
            [userId, actionType, entityId]
        );
    } catch (err) {
        // Never let audit failures crash a real operation
        console.error('Audit log write failed:', err.message);
    }
}

// --- Req 4: OUTBOX ---
app.get('/documents/my-outbox', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id;

        // Req 4: server-side pagination
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
        const offset = (page - 1) * limit;

        const countResult = await db.query(
            `SELECT COUNT(*)::int as total FROM documents d WHERE d.sender_id = $1`,
            [userId]
        );
        const total = countResult.rows[0].total;

        const result = await db.query(`
            SELECT d.*, p.name as project_name,
                   recipient.email as recipient_email, recipient.display_name as recipient_name,
                   dept.name as department_name,
                   (SELECT COUNT(*)::int FROM approval_chain_steps s WHERE s.document_id = d.id) as chain_total_levels,
                   (SELECT u2.display_name FROM approval_chain_steps s2 JOIN users u2 ON u2.id = s2.approver_id
                      WHERE s2.document_id = d.id AND s2.level = d.current_level) as chain_next_approver_name,
                   (SELECT s3.approver_id FROM approval_chain_steps s3
                      WHERE s3.document_id = d.id AND s3.level = d.current_level) as chain_next_approver_id
            FROM documents d
            LEFT JOIN projects p ON d.project_id = p.id
            LEFT JOIN users recipient ON d.recipient_id = recipient.id
            LEFT JOIN departments dept ON d.department_id = dept.id
            WHERE d.sender_id = $1
            ORDER BY d.created_at DESC
            LIMIT $2 OFFSET $3
        `, [userId, limit, offset]);

        res.json({
            documents: result.rows,
            total,
            page,
            limit,
            totalPages: Math.max(Math.ceil(total / limit), 1)
        });
    } catch (err) {
        console.error('Outbox Error:', err);
        res.status(500).json({ message: err.message });
    }
});

// --- Req 4: DOWNLOAD (forces attachment, same access rules as /stream) ---
app.get('/documents/:id/download', async (req, res) => {
    // Accept token from Authorization header OR ?token= query param
    // (download uses an <a> tag which can't set headers, so we need the query param path)
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }
    if (!token) return res.status(401).json({ message: 'Not authenticated.' });

    let user;
    try {
        const decoded = auth.verifyToken(token);
        user = { id: decoded.userId, role: decoded.role, department_id: decoded.departmentId };
    } catch(e) {
        return res.status(401).json({ message: 'Invalid token.' });
    }

    try {
        const docRes = await db.query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
        if (docRes.rows.length === 0) return res.status(404).json({ message: 'Document not found.' });
        const doc = docRes.rows[0];

        let hasAccess = false;
        if (user.role === 'Executive' || user.role === 'Admin') {
            hasAccess = true;
        } else if (user.role === 'Supervisor') {
            const projCheck = await db.query('SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2', [user.id, doc.project_id]);
            if (doc.department_id === user.department_id || projCheck.rows.length > 0) hasAccess = true;
        } else {
            const projCheck = await db.query('SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2', [user.id, doc.project_id]);
            if (doc.sender_id === user.id || doc.recipient_id === user.id || projCheck.rows.length > 0) hasAccess = true;
        }

        if (!hasAccess) return res.status(403).json({ message: 'Access denied.' });

        const filePath = path.join(__dirname, 'uploads', doc.filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'Physical file missing from server.' });

        res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
        fs.createReadStream(filePath).pipe(res);

    } catch (err) {
        console.error('Download Error:', err);
        res.status(500).json({ message: 'Server error during download.' });
    }
});

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
        if (userRole === 'Executive' || userRole === 'Admin') {
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
app.post('/upload', ensureAuthenticated, (req, res) => {
    // Use the Multer callback pattern instead of passing upload.single() as standard
    // middleware. When a client disconnects mid-transfer, Multer emits "Request aborted"
    // before the async route body runs -- that error is invisible to a try/catch inside
    // the handler. The callback form surfaces it as `err` so we can respond cleanly
    // instead of letting it bubble up and crash the server process.
    upload.single('document')(req, res, async (err) => {

        // --- Multer / connection error layer ---
        if (err) {
            // Clean up any partial file Multer managed to write before the abort.
            // req.file is populated even on a partial write if Multer got far enough.
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (unlinkErr) => {
                    if (unlinkErr) console.warn('Could not clean up partial upload:', unlinkErr.message);
                });
            }

            // "Request aborted" covers mid-transfer disconnects; LIMIT_* codes are
            // standard Multer validation errors (file too large, wrong field name, etc.)
            const isAbort = err.message === 'Request aborted' || err.code === 'ECONNRESET';
            const isMulterError = err.name === 'MulterError';

            if (isAbort) {
                console.warn('Upload aborted by client (connection dropped):', req.user?.email);
                return res.status(400).json({ message: 'Upload interrupted. Please check your connection and try again.' });
            }

            if (isMulterError) {
                console.warn('Multer validation error:', err.code, err.message);
                return res.status(400).json({ message: `Upload rejected: ${err.message}` });
            }

            // Unexpected Multer-layer error — log and return 500
            console.error('Unexpected upload middleware error:', err);
            return res.status(500).json({ message: 'Upload failed due to a server error.' });
        }

        // --- Business logic layer (Multer succeeded) ---
        try {
            if (!req.file) {
                return res.status(400).json({ message: 'No file uploaded.' });
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

            // Req 3: Strict project assignment validation.
            // Admin/Executive can upload to any project. Staff/Supervisor must be
            // explicitly assigned to the target project or the upload is rejected.
            const userRole = req.user.role;
            const isBypassRole = userRole === 'Admin' || userRole === 'Executive';
            if (projectId && !isBypassRole) {
                const assignCheck = await db.query(
                    'SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2',
                    [uploadedBy, projectId]
                );
                if (assignCheck.rows.length === 0) {
                    // File already written by Multer — remove it before rejecting
                    fs.unlink(req.file.path, (unlinkErr) => {
                        if (unlinkErr) console.warn('Could not clean up rejected upload:', unlinkErr.message);
                    });
                    return res.status(403).json({ message: 'Unauthorized: You are not assigned to this project.' });
                }
            }

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

            // Req 6: Audit trail
            await auditLog(uploadedBy, 'DOCUMENT_UPLOAD', newDocId);

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

            res.status(200).json({ message: 'Document sent!' });

        } catch (dbErr) {
            // DB/business logic failure after a successful file write -- clean up the
            // orphaned file so uploads/ doesn't accumulate files with no DB record.
            if (req.file && req.file.path) {
                fs.unlink(req.file.path, (unlinkErr) => {
                    if (unlinkErr) console.warn('Could not clean up orphaned upload:', unlinkErr.message);
                });
            }
            console.error('Database Upload Route Error:', dbErr);
            res.status(500).json({ message: 'Error saving document metadata relation fields.' });
        }
    });
});

// Endpoint to capture inbox layout listings targeting single identity profile logs
app.get('/documents/my-inbox', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;
        const deptId = req.user.department_id; // Securely extracted from JWT payload

        // Req 4: server-side pagination
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
        const offset = (page - 1) * limit;

        // Build the WHERE clause + its params once, reused by both the COUNT
        // query and the paginated SELECT so the two always agree on scope.
        let whereClause = '';
        let queryParams = [];

        if (userRole === 'Executive' || userRole === 'Admin') {
            // Executive/Admin: View all documents across the entire company
            whereClause = '';
        } else if (userRole === 'Supervisor') {
            // Department Level: View all dept documents OR explicitly assigned projects
            whereClause = `
                WHERE d.department_id = $1
                   OR d.project_id IN (SELECT project_id FROM project_assignments WHERE user_id = $2)
            `;
            queryParams = [deptId, userId];
        } else {
            // Staff Level: Always show docs where the user is the named recipient
            // (Req 3: bypasses project silo entirely for direct recipients),
            // plus docs they sent or are in their assigned projects.
            whereClause = `
                WHERE d.recipient_id = $1
                   OR d.sender_id = $1
                   OR d.project_id IN (SELECT project_id FROM project_assignments WHERE user_id = $1)
            `;
            queryParams = [userId];
        }

        const countResult = await db.query(
            `SELECT COUNT(*)::int as total FROM documents d ${whereClause}`,
            queryParams
        );
        const total = countResult.rows[0].total;

        const limitIdx = queryParams.length + 1;
        const offsetIdx = queryParams.length + 2;
        const dataQuery = `
            SELECT d.*, p.name as project_name, u_sender.email as sender_email,
                   u_sender.display_name as sender_name, dept.name as department_name,
                   (SELECT COUNT(*)::int FROM approval_chain_steps s WHERE s.document_id = d.id) as chain_total_levels,
                   (SELECT u2.display_name FROM approval_chain_steps s2 JOIN users u2 ON u2.id = s2.approver_id
                      WHERE s2.document_id = d.id AND s2.level = d.current_level) as chain_next_approver_name,
                   (SELECT s3.approver_id FROM approval_chain_steps s3
                      WHERE s3.document_id = d.id AND s3.level = d.current_level) as chain_next_approver_id
            FROM documents d
            LEFT JOIN projects p ON d.project_id = p.id
            LEFT JOIN users u_sender ON d.sender_id = u_sender.id
            LEFT JOIN departments dept ON d.department_id = dept.id
            ${whereClause}
            ORDER BY d.created_at DESC
            LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const result = await db.query(dataQuery, [...queryParams, limit, offset]);
        res.json({
            documents: result.rows,
            total,
            page,
            limit,
            totalPages: Math.max(Math.ceil(total / limit), 1)
        });
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
// Get a user's current project assignments (used to pre-select in the modal)
app.get('/admin/users/:id/projects', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT project_id FROM project_assignments WHERE user_id = $1',
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Replace a user's project assignments atomically (delete all, re-insert selected)
app.post('/admin/assign-project', ensureAuthenticated, ensureAdmin, async (req, res) => {
    const userId = req.body.user_id || null;
    const projectIds = req.body.project_ids; // array from multi-select

    if (!userId) {
        return res.status(400).json({ message: 'user_id is required.' });
    }
    if (!Array.isArray(projectIds)) {
        return res.status(400).json({ message: 'project_ids must be an array.' });
    }

    try {
        await db.query('BEGIN');

        // Wipe existing assignments for this user so we start clean
        await db.query('DELETE FROM public.project_assignments WHERE user_id = $1', [userId]);

        // Re-insert each selected project in a single loop
        for (const projectId of projectIds) {
            await db.query(
                'INSERT INTO public.project_assignments (user_id, project_id) VALUES ($1, $2)',
                [userId, projectId]
            );
        }

        await db.query('COMMIT');
        res.status(200).json({ message: `User assigned to ${projectIds.length} project(s) successfully.` });

    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Project Assignment Error:', err);
        res.status(500).json({ message: 'Error updating project assignments.' });
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
app.get('/auth/me', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, email, display_name, role, department_id,
                    COALESCE(digest_mode, 'interval')           AS digest_mode,
                    COALESCE(digest_interval_hours, 4)          AS digest_interval_hours,
                    COALESCE(digest_daily_hour, 8)              AS digest_daily_hour,
                    COALESCE(digest_daily_minute, 0)            AS digest_daily_minute
             FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
        res.json(result.rows[0]);
    } catch (err) {
        // If digest columns don't exist yet (migration 005 not run), fall back
        // to a minimal query so the rest of the app still works
        try {
            const fallback = await db.query(
                'SELECT id, email, display_name, role, department_id FROM users WHERE id = $1',
                [req.user.id]
            );
            if (fallback.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
            res.json({
                ...fallback.rows[0],
                digest_mode: 'interval',
                digest_interval_hours: 4,
                digest_daily_hour: 8,
                digest_daily_minute: 0,
            });
        } catch (fallbackErr) {
            res.status(500).json({ message: 'Failed to load user profile.' });
        }
    }
});

// --- USER PREFERENCE ROUTES ---

// GET /users/me/preferences — return current digest preference
app.get('/users/me/preferences', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT digest_mode, digest_interval_hours, digest_daily_hour, digest_daily_minute
             FROM users WHERE id = $1`,
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: 'Failed to load preferences.' });
    }
});

// PATCH /users/me/preferences — save digest preference
app.patch('/users/me/preferences', ensureAuthenticated, async (req, res) => {
    const { digest_mode, digest_interval_hours, digest_daily_hour, digest_daily_minute } = req.body;

    if (!['interval', 'daily'].includes(digest_mode)) {
        return res.status(400).json({ message: 'digest_mode must be "interval" or "daily".' });
    }
    if (digest_mode === 'interval') {
        const h = parseInt(digest_interval_hours);
        if (isNaN(h) || h < 1 || h > 168) {
            return res.status(400).json({ message: 'digest_interval_hours must be between 1 and 168.' });
        }
    }
    if (digest_mode === 'daily') {
        const hr = parseInt(digest_daily_hour);
        const min = parseInt(digest_daily_minute);
        if (isNaN(hr) || hr < 0 || hr > 23) return res.status(400).json({ message: 'digest_daily_hour must be 0–23.' });
        if (isNaN(min) || min < 0 || min > 59) return res.status(400).json({ message: 'digest_daily_minute must be 0–59.' });
    }

    try {
        await db.query(
            `UPDATE users
             SET digest_mode = $1, digest_interval_hours = $2,
                 digest_daily_hour = $3, digest_daily_minute = $4
             WHERE id = $5`,
            [
                digest_mode,
                parseInt(digest_interval_hours) || 4,
                parseInt(digest_daily_hour) ?? 8,
                parseInt(digest_daily_minute) ?? 0,
                req.user.id
            ]
        );
        res.json({ message: 'Preferences saved.' });
    } catch (err) {
        res.status(500).json({ message: 'Failed to save preferences.' });
    }
});

// --- 6. EXECUTIVE APPROVAL WORKFLOW ---

// Endpoint to toggle document status (Pending, Approved, Rejected)
// --- 6. EXECUTIVE APPROVAL WORKFLOW ---
// Req 1: fires immediate email to sender on approve/reject
// Req 2: accepts optional notes, saves to documents.notes
// Req 6: writes audit log
// Req 7: accepts Admin role in addition to Executive
app.patch('/documents/:id/status', ensureAuthenticated, async (req, res) => {
    try {
        // Req 7: re-check live role from DB to handle stale JWTs
        const liveRoleRes = await db.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
        if (liveRoleRes.rows.length === 0) return res.status(403).json({ message: 'User not found.' });
        const liveRole = liveRoleRes.rows[0].role;

        if (liveRole !== 'Executive' && liveRole !== 'Admin') {
            return res.status(403).json({ message: 'Only Executives or Admins can approve or reject documents.' });
        }

        const documentId = req.params.id;
        const { status, notes } = req.body;

        if (!['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Must be approved, rejected, or pending.' });
        }

        // If this document has a defined approval chain, decisions must go
        // through PATCH /documents/:id/approval-step instead, so the chain's
        // per-level tracking doesn't get bypassed/overwritten.
        const chainRes = await db.query('SELECT 1 FROM approval_chain_steps WHERE document_id = $1 LIMIT 1', [documentId]);
        if (chainRes.rows.length > 0) {
            return res.status(409).json({ message: 'This document has a multi-level approval chain. Use the approval-step endpoint instead.' });
        }

        // Req 2: persist notes alongside the status update
        const result = await db.query(
            'UPDATE documents SET status = $1, notes = $2 WHERE id = $3 RETURNING *',
            [status, notes || null, documentId]
        );

        if (result.rows.length === 0) return res.status(404).json({ message: 'Document not found.' });
        const doc = result.rows[0];

        // Req 6: audit log
        await auditLog(req.user.id, `STATUS_CHANGE:${status.toUpperCase()}`, doc.id);

        // Req 1: immediate email to the original sender (not digest queued)
        if (doc.sender_id && status !== 'pending') {
            const senderRes = await db.query('SELECT email, display_name FROM users WHERE id = $1', [doc.sender_id]);
            if (senderRes.rows.length > 0) {
                const sender = senderRes.rows[0];
                const isApproved = status === 'approved';
                const statusLabel = isApproved ? 'Approved' : 'Rejected';
                const statusColor = isApproved ? '#10b981' : '#ef4444';
                const subject = `Document ${statusLabel}: ${doc.filename}`;
                const text = `Hello ${sender.display_name},\n\nYour document "${doc.filename}" has been ${statusLabel.toLowerCase()} by ${req.user.display_name}.${notes ? `\n\nNote: ${notes}` : ''}\n\nLog in to DocHandler to view the full status.`;
                const html = `
                    <div style="font-family:sans-serif;max-width:500px;">
                        <h3 style="color:${statusColor};border-bottom:2px solid ${statusColor};padding-bottom:8px;">
                            ${isApproved ? '✅' : '❌'} Document ${statusLabel}
                        </h3>
                        <p>Hello <strong>${sender.display_name}</strong>,</p>
                        <p>Your document has been <strong style="color:${statusColor};">${statusLabel.toLowerCase()}</strong> by ${req.user.display_name}.</p>
                        <table style="border-collapse:collapse;width:100%;margin:1rem 0;">
                            <tr style="background:#f9fafb;">
                                <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;">File</td>
                                <td style="padding:8px;border:1px solid #e5e7eb;">${doc.filename}</td>
                            </tr>
                            <tr>
                                <td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;">Status</td>
                                <td style="padding:8px;border:1px solid #e5e7eb;color:${statusColor};font-weight:700;">${statusLabel}</td>
                            </tr>
                            ${notes ? `<tr style="background:#f9fafb;"><td style="padding:8px;border:1px solid #e5e7eb;font-weight:600;">Note</td><td style="padding:8px;border:1px solid #e5e7eb;">${notes}</td></tr>` : ''}
                        </table>
                        <p style="color:#888;font-size:0.85em;">Log in to DocHandler to view the full document history.</p>
                    </div>
                `;
                // Fire-and-forget — don't let email failure block the response
                sendMail(sender.email, subject, text, html);
            }
        }

        res.json({ message: `Document ${status}. Sender notified.`, document: doc });

    } catch (err) {
        console.error('Approval Workflow Error:', err);
        res.status(500).json({ message: 'Database error updating document status.' });
    }
});

// --- 6b. MULTI-LEVEL APPROVAL CHAINS ---

// Any authenticated user can see who's eligible to be added to an approval
// chain (needed by senders, not just Admins, when building a chain).
app.get('/users/approvers', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, display_name, email, role FROM users
             WHERE role IN ('Supervisor', 'Executive', 'Admin') AND is_approved = TRUE
             ORDER BY display_name ASC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Approvers List Error:', err);
        res.status(500).json({ message: 'Database error fetching eligible approvers.' });
    }
});

// Define (or replace) the ordered list of approvers for a document.
// Only the original sender, an Executive, or an Admin may set this.
app.post('/documents/:id/approval-chain', ensureAuthenticated, async (req, res) => {
    const documentId = req.params.id;
    const { approver_ids } = req.body;
    try {
        if (!Array.isArray(approver_ids) || approver_ids.length === 0) {
            return res.status(400).json({ message: 'approver_ids must be a non-empty ordered array of user ids.' });
        }

        const docRes = await db.query('SELECT * FROM documents WHERE id = $1', [documentId]);
        if (docRes.rows.length === 0) return res.status(404).json({ message: 'Document not found.' });
        const doc = docRes.rows[0];

        const liveRoleRes = await db.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
        const liveRole = liveRoleRes.rows[0]?.role;
        const canDefine = liveRole === 'Executive' || liveRole === 'Admin' || doc.sender_id === req.user.id;
        if (!canDefine) return res.status(403).json({ message: 'Only the sender, an Executive, or an Admin can set the approval chain.' });

        // Confirm every id is a real user before wiping the old chain.
        const usersRes = await db.query('SELECT id FROM users WHERE id = ANY($1::int[])', [approver_ids]);
        if (usersRes.rows.length !== approver_ids.length) {
            return res.status(400).json({ message: 'One or more approver_ids do not match a real user.' });
        }

        await db.query('DELETE FROM approval_chain_steps WHERE document_id = $1', [documentId]);
        for (let i = 0; i < approver_ids.length; i++) {
            const level = i + 1;
            await db.query(
                `INSERT INTO approval_chain_steps (document_id, level, approver_id, status)
                 VALUES ($1, $2, $3, $4)`,
                [documentId, level, approver_ids[i], level === 1 ? 'pending' : 'waiting']
            );
        }
        await db.query(
            `UPDATE documents SET current_level = 1, status = 'pending' WHERE id = $1`,
            [documentId]
        );
        await auditLog(req.user.id, 'APPROVAL_CHAIN_SET', documentId);

        res.status(201).json({ message: `Approval chain set with ${approver_ids.length} level(s).` });
    } catch (err) {
        console.error('Approval Chain Set Error:', err);
        res.status(500).json({ message: 'Database error setting approval chain.' });
    }
});

// Read the chain's current steps plus the full decision history for a document.
app.get('/documents/:id/approval-chain', ensureAuthenticated, async (req, res) => {
    const documentId = req.params.id;
    try {
        const steps = await db.query(
            `SELECT s.level, s.status, s.comments, s.decided_at, u.id as approver_id, u.display_name as approver_name
             FROM approval_chain_steps s JOIN users u ON u.id = s.approver_id
             WHERE s.document_id = $1 ORDER BY s.level ASC`,
            [documentId]
        );
        const history = await db.query(
            `SELECT a.level, a.action, a.comments, a.created_at, u.display_name as approver_name
             FROM approvals a LEFT JOIN users u ON u.id = a.approved_by
             WHERE a.document_id = $1 AND a.action IS NOT NULL ORDER BY a.created_at ASC`,
            [documentId]
        );
        res.json({ steps: steps.rows, history: history.rows });
    } catch (err) {
        console.error('Approval Chain Fetch Error:', err);
        res.status(500).json({ message: 'Database error fetching approval chain.' });
    }
});

// Act on the CURRENT level of a document's chain (approve or reject).
// Approve: activates the next level, or finalizes the document if this was the last level.
// Reject:  level 1 has no prior step, so the document is finalized as rejected;
//          any later level bounces the document back to the previous level for revision.
app.patch('/documents/:id/approval-step', ensureAuthenticated, async (req, res) => {
    const documentId = req.params.id;
    const { status, notes } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be approved or rejected.' });
    }
    try {
        const docRes = await db.query('SELECT * FROM documents WHERE id = $1', [documentId]);
        if (docRes.rows.length === 0) return res.status(404).json({ message: 'Document not found.' });
        const doc = docRes.rows[0];

        const curStepRes = await db.query(
            `SELECT * FROM approval_chain_steps WHERE document_id = $1 AND level = $2`,
            [documentId, doc.current_level]
        );
        if (curStepRes.rows.length === 0) return res.status(404).json({ message: 'No approval chain is set for this document.' });
        const curStep = curStepRes.rows[0];

        const liveRoleRes = await db.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
        const liveRole = liveRoleRes.rows[0]?.role;
        const isAdmin = liveRole === 'Admin';
        if (curStep.approver_id !== req.user.id && !isAdmin) {
            return res.status(403).json({ message: 'You are not the assigned approver for the current level.' });
        }
        if (curStep.status !== 'pending') {
            return res.status(409).json({ message: 'This level is not currently awaiting a decision.' });
        }

        // Append-only history entry, in order, regardless of what happens next.
        await db.query(
            `INSERT INTO approvals (document_id, approved_by, level, action, status, comments)
             VALUES ($1, $2, $3, $4, $4, $5)`,
            [documentId, req.user.id, doc.current_level, status, notes || null]
        );
        await auditLog(req.user.id, `APPROVAL_STEP_${status.toUpperCase()}:L${doc.current_level}`, documentId);

        const totalLevelsRes = await db.query(
            `SELECT COUNT(*)::int as total FROM approval_chain_steps WHERE document_id = $1`,
            [documentId]
        );
        const totalLevels = totalLevelsRes.rows[0].total;
        let newDocStatus = doc.status;
        let newCurrentLevel = doc.current_level;

        if (status === 'approved') {
            await db.query(
                `UPDATE approval_chain_steps SET status = 'approved', comments = $1, decided_at = NOW() WHERE document_id = $2 AND level = $3`,
                [notes || null, documentId, doc.current_level]
            );
            if (doc.current_level >= totalLevels) {
                newDocStatus = 'approved';
            } else {
                newCurrentLevel = doc.current_level + 1;
                await db.query(
                    `UPDATE approval_chain_steps SET status = 'pending' WHERE document_id = $1 AND level = $2`,
                    [documentId, newCurrentLevel]
                );
            }
        } else {
            // rejected
            await db.query(
                `UPDATE approval_chain_steps SET status = 'rejected', comments = $1, decided_at = NOW() WHERE document_id = $2 AND level = $3`,
                [notes || null, documentId, doc.current_level]
            );
            if (doc.current_level <= 1) {
                newDocStatus = 'rejected';
            } else {
                // Bounce back: previous level re-opens for revision, current level resets to unreached.
                newCurrentLevel = doc.current_level - 1;
                await db.query(
                    `UPDATE approval_chain_steps SET status = 'pending', comments = NULL, decided_at = NULL WHERE document_id = $1 AND level = $2`,
                    [documentId, newCurrentLevel]
                );
                await db.query(
                    `UPDATE approval_chain_steps SET status = 'waiting', comments = NULL, decided_at = NULL WHERE document_id = $1 AND level = $2`,
                    [documentId, doc.current_level]
                );
                newDocStatus = 'pending';
            }
        }

        const updated = await db.query(
            `UPDATE documents SET status = $1, current_level = $2, notes = $3 WHERE id = $4 RETURNING *`,
            [newDocStatus, newCurrentLevel, notes || doc.notes, documentId]
        );

        res.json({ message: `Level ${doc.current_level} ${status}.`, document: updated.rows[0] });
    } catch (err) {
        console.error('Approval Step Error:', err);
        res.status(500).json({ message: 'Database error processing approval step.' });
    }
});
// --- 7. DIGEST NOTIFICATION SCHEDULING ---

// Manually trigger a digest run (sends to ALL users with pending items now,
// ignoring their individual schedules — useful for testing).
app.post('/admin/digest/run', ensureAuthenticated, ensureAdmin, async (req, res) => {
    try {
        const summary = await runDigest();
        res.json({ message: 'Digest run complete.', summary });
    } catch (err) {
        console.error('Manual digest trigger error:', err);
        res.status(500).json({ message: 'Failed to run digest.' });
    }
});

// Per-user digest scheduler — checks every minute, respects each user's
// individual digest_mode/interval/daily-time preference.
async function runDigestForUser(recipientId) {
    const { runDigest } = require('./utils/digest');
    // Re-use the existing runDigest but filter to a single recipient
    // by temporarily wrapping the DB query. Simpler: call a targeted export.
    // Since digest.js processes all unsent rows per-recipient anyway, we call
    // runDigest() and let it handle the grouping — the cron just gates timing.
    // For single-user sends, call the module directly with a recipient filter.
    try {
        const db = require('./db');
        const { sendMail } = require('./utils/mailer');

        const pendingRes = await db.query(`
            SELECT nq.id AS queue_id, nq.document_id, nq.recipient_id,
                   d.filename, d.created_at AS document_created_at,
                   sender.display_name AS sender_name, sender.email AS sender_email,
                   p.name AS project_name,
                   recipient.email AS recipient_email, recipient.display_name AS recipient_name
            FROM notification_queue nq
            JOIN documents d ON nq.document_id = d.id
            JOIN users recipient ON nq.recipient_id = recipient.id
            LEFT JOIN users sender ON d.sender_id = sender.id
            LEFT JOIN projects p ON d.project_id = p.id
            WHERE nq.sent_at IS NULL AND nq.recipient_id = $1
            ORDER BY d.created_at ASC
        `, [recipientId]);

        if (pendingRes.rows.length === 0) return;

        const rows = pendingRes.rows;
        const queueIds = rows.map(r => r.queue_id);
        const recipientEmail = rows[0].recipient_email;
        const recipientName = rows[0].recipient_name;

        const listItemsHtml = rows.map(r => `
            <li style="margin-bottom:8px;">
                <strong>${r.filename}</strong><br>
                <span style="color:#666;font-size:0.9em;">
                    From ${r.sender_name || r.sender_email || 'Unknown'}${r.project_name ? ` · ${r.project_name}` : ''}
                </span>
            </li>`).join('');

        const subject = `DocHandler Digest: ${rows.length} new document${rows.length > 1 ? 's' : ''}`;
        const text = `Hello ${recipientName},\n\nYou have ${rows.length} new document(s) in DocHandler. Log in to review them.`;
        const html = `
            <h3>DocHandler Digest</h3>
            <p>Hello ${recipientName},</p>
            <p>You have <strong>${rows.length}</strong> new document(s) waiting:</p>
            <ul>${listItemsHtml}</ul>
            <p>Log in to your dashboard to review them.</p>`;

        const sent = await sendMail(recipientEmail, subject, text, html);
        if (sent) {
            await db.query(
                'UPDATE notification_queue SET sent_at = NOW() WHERE id = ANY($1::int[])',
                [queueIds]
            );
        }
    } catch (err) {
        console.error(`Digest error for user ${recipientId}:`, err.message);
    }
}

// Runs every minute; skips users whose digest isn't due yet.
cron.schedule('* * * * *', async () => {
    try {
        const now = new Date();
        const pendingRes = await db.query(`
            SELECT DISTINCT nq.recipient_id,
                   u.digest_mode,
                   u.digest_interval_hours,
                   u.digest_daily_hour,
                   u.digest_daily_minute,
                   MAX(nq.sent_at) AS last_sent
            FROM notification_queue nq
            JOIN users u ON nq.recipient_id = u.id
            WHERE nq.sent_at IS NULL
            GROUP BY nq.recipient_id, u.digest_mode, u.digest_interval_hours,
                     u.digest_daily_hour, u.digest_daily_minute
        `);

        for (const user of pendingRes.rows) {
            let shouldSend = false;
            if (user.digest_mode === 'daily') {
                shouldSend = now.getHours()   === parseInt(user.digest_daily_hour) &&
                             now.getMinutes() === parseInt(user.digest_daily_minute);
            } else {
                // interval mode
                if (!user.last_sent) {
                    shouldSend = true;
                } else {
                    const hoursSinceLast = (now - new Date(user.last_sent)) / (1000 * 60 * 60);
                    shouldSend = hoursSinceLast >= (parseInt(user.digest_interval_hours) || 4);
                }
            }
            if (shouldSend) await runDigestForUser(user.recipient_id);
        }
    } catch (err) {
        console.error('Digest scheduler error:', err);
    }
});

// --- 8. START SERVER ENGINE ---
app.listen(PORT, () => {
    console.log(`PBE OneForAll active application server streaming live at http://localhost:${PORT}`);
});