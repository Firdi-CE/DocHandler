require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const auth = require('./auth'); // Imports JWT auth helpers
const db = require('./db');         // Imports PostgreSQL connection pool from db.js

const app = express();
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

// Serve uploaded PDFs so they can be viewed/downloaded via the client dashboard link
//app.use('/uploads', express.static(uploadDir));


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
// Secure Endpoint to stream a document only to cleared personnel
app.get('/documents/:id/stream', ensureAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const role = req.user.role || 'Staff';
        const deptId = req.user.department_id;

        // 1. Fetch document ownership metadata
        const docRes = await db.query('SELECT * FROM documents WHERE id = $1', [id]);
        if (docRes.rows.length === 0) {
            return res.status(404).json({ message: 'Document not found or moved.' });
        }
        const doc = docRes.rows[0];

        // 2. Defensive Scoping Re-Verification (Never trust the frontend request blindly)
        let isAuthorized = false;
        
        if (role === 'Executive') {
            isAuthorized = true; // Execs see everything
        } else if (role === 'Supervisor' || role === 'Staff') {
            // Check if the user is mapped to the project holding this document
            const projCheck = await db.query('SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2', [userId, doc.project_id]);
            
            if (role === 'Supervisor') {
                if (doc.department_id === deptId || projCheck.rows.length > 0) isAuthorized = true;
            } else {
                if (doc.department_id === deptId && projCheck.rows.length > 0) isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({ message: 'Unauthorized: You lack clearance for this project payload.' });
        }

        // 3. Serve the physical file absolutely and securely via Express
        res.sendFile(doc.file_path);

    } catch (err) {
        console.error('File streaming security error:', err);
        res.status(500).json({ message: 'Internal error resolving secure document.' });
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

        // Perform strict table transaction mapping elements cleanly to table relations
        const query = `
            INSERT INTO public.documents (filename, file_path, sender_id, recipient_id, project_id, department_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id;
        `;
        const values = [filename, filePath, uploadedBy, recipientId, projectId, departmentId];
        await db.query(query, values);

        console.log(`Document transaction completed successfully: ${filename}`);
        res.status(200).send('Document sent!');
    } catch (err) {
        console.error('Database Upload Route Error:', err);
        res.status(500).send('Error saving document metadata relation fields.');
    }
});

// Get documents scoped strictly by role-based permissions
app.get('/documents/my-inbox', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id;
        const role = req.user.role || 'Staff'; // Default fallback if null
        const deptId = req.user.department_id;

        // Base query selecting documents along with contextual project/sender strings
        let query = `
            SELECT d.*, p.name as project_name, u.display_name as uploader_name,
                   u.email as sender_email, dept.name as department_name
            FROM public.documents d
            LEFT JOIN public.projects p ON d.project_id = p.id
            LEFT JOIN public.users u ON d.sender_id = u.id
            LEFT JOIN public.departments dept ON d.department_id = dept.id
            WHERE 1=1
        `;
        const values = [];

        // Dynamic Query Adjustments depending on Role-Based Access Scoping Rules
        if (role === 'Executive') {
            // Rule: Executive can see ALL projects and their contents.
            // No extra limiting WHERE conditions needed.
        } 
        else if (role === 'Supervisor') {
            // Rule: Supervisor can see everything under their department 
            // OR any project they are explicitly assigned to.
            query += ` AND (d.department_id = $1 OR d.project_id IN (
                SELECT project_id FROM public.project_assignments WHERE user_id = $2
            ))`;
            values.push(deptId, userId);
        } 
        else {
            // Rule: Staff can only see documents in their respective department 
            // AND where they belong to the assigned project.
            query += ` AND (d.department_id = $1 AND d.project_id IN (
                SELECT project_id FROM public.project_assignments WHERE user_id = $2
            ))`;
            values.push(deptId, userId);
        }

        query += ` ORDER BY d.created_at DESC`;

        const result = await db.query(query, values);
        res.json(result.rows);
    } catch (err) {
        console.error("Error running role-scoped data selection mapping:", err);
        res.status(500).json({ error: "Failed to fetch secure inbox documents" });
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

// --- 6. START SERVER ENGINE ---
app.listen(PORT, () => {
    console.log(`PBE OneForAll active application server streaming live at http://localhost:${PORT}`);
});