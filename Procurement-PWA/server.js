require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { handleGoogleLogin } = require('./auth');
const { requireAuth, requireAdmin, optionalAuth } = require('./middleware/auth');

const app = express();
const PORT = 3000;

// --------------- Middleware ---------------
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --------------- Multer Config ---------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// =============== AUTH ROUTES ===============

// POST /auth/google — Google Sign-In
app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Missing idToken.' });

    const result = await handleGoogleLogin(idToken);
    
    if (result.status === 'approved') {
      return res.json(result);
    } else if (result.status === 'pending') {
      return res.status(403).json(result);
    } else {
      return res.status(201).json(result);
    }
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed.' });
  }
});

// GET /auth/me — Get current user info
app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, role, department_id, display_name, is_approved FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============== PROJECT ROUTES ===============

// GET /projects — Projects accessible to the current user
app.get('/projects', requireAuth, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'Executive') {
      // Executives see all projects
      result = await db.query('SELECT id, name FROM projects ORDER BY name ASC');
    } else {
      // Others see only assigned projects
      result = await db.query(`
        SELECT p.id, p.name FROM projects p
        JOIN project_assignments pa ON pa.project_id = p.id
        WHERE pa.user_id = $1
        ORDER BY p.name ASC
      `, [req.user.userId]);
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============== DOCUMENT ROUTES ===============

// POST /upload — Upload a document
app.post('/upload', requireAuth, upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const { recipientId, projectId, departmentId } = req.body;
    const senderId = req.user.userId;
    const filename = req.file.filename;

    // Verify sender has access to this project
    if (req.user.role !== 'Executive') {
      const accessCheck = await db.query(
        'SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2',
        [senderId, projectId]
      );
      if (accessCheck.rows.length === 0) {
        // Clean up the uploaded file
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'You do not have access to this project.' });
      }
    }

    await db.query(`
      INSERT INTO documents (filename, sender_id, recipient_id, project_id, department_id)
      VALUES ($1, $2, $3, $4, $5)
    `, [filename, senderId, recipientId, projectId, departmentId]);

    res.status(200).send('Document routed and saved successfully!');
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).send('Error saving document metadata.');
  }
});

// GET /documents/my-inbox — Documents visible to the current user
app.get('/documents/my-inbox', requireAuth, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'Executive') {
      // Executives see ALL documents
      result = await db.query(`
        SELECT d.*, sender.email AS sender_email, recipient.email AS recipient_email,
               p.name AS project_name, dept.name AS department_name
        FROM documents d
        LEFT JOIN users sender ON sender.id = d.sender_id
        LEFT JOIN users recipient ON recipient.id = d.recipient_id
        LEFT JOIN projects p ON p.id = d.project_id
        LEFT JOIN departments dept ON dept.id = d.department_id
        ORDER BY d.created_at DESC
      `);
    } else {
      // Others see documents where they are sender/recipient OR in their department within assigned projects
      result = await db.query(`
        SELECT d.*, sender.email AS sender_email, recipient.email AS recipient_email,
               p.name AS project_name, dept.name AS department_name
        FROM documents d
        LEFT JOIN users sender ON sender.id = d.sender_id
        LEFT JOIN users recipient ON recipient.id = d.recipient_id
        LEFT JOIN projects p ON p.id = d.project_id
        LEFT JOIN departments dept ON dept.id = d.department_id
        WHERE d.recipient_id = $1
           OR d.sender_id = $1
           OR (d.department_id = $2 AND d.project_id IN (
               SELECT project_id FROM project_assignments WHERE user_id = $1
             ))
        ORDER BY d.created_at DESC
      `, [req.user.userId, req.user.departmentId]);
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /users/by-department/:deptId — Users in a department (for pickers)
app.get('/users/by-department/:deptId', requireAuth, async (req, res) => {
  try {
    const { deptId } = req.params;
    const result = await db.query(
      'SELECT id, email, display_name FROM users WHERE department_id = $1 AND is_approved = true ORDER BY email ASC',
      [deptId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============== ADMIN ROUTES ===============

// GET /admin/pending-accounts — List unapproved account requests
app.get('/admin/pending-accounts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM account_requests WHERE status = $1 ORDER BY created_at ASC',
      ['pending']
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/approve-account — Approve a pending account
app.post('/admin/approve-account', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { requestId, departmentId, role } = req.body;
    if (!requestId || !departmentId) {
      return res.status(400).json({ error: 'requestId and departmentId are required.' });
    }

    // Get the request
    const reqRes = await db.query('SELECT * FROM account_requests WHERE id = $1', [requestId]);
    if (reqRes.rows.length === 0) return res.status(404).json({ error: 'Request not found.' });
    const accountReq = reqRes.rows[0];

    // Insert into users table
    await db.query(`
      INSERT INTO users (email, google_id, display_name, role, department_id, is_approved)
      VALUES ($1, $2, $3, $4, $5, true)
      ON CONFLICT (email) DO UPDATE SET
        google_id = EXCLUDED.google_id,
        display_name = EXCLUDED.display_name,
        role = EXCLUDED.role,
        department_id = EXCLUDED.department_id,
        is_approved = true
    `, [accountReq.email, accountReq.google_id, accountReq.display_name, role || 'Staff', departmentId]);

    // Mark request as approved
    await db.query('UPDATE account_requests SET status = $1 WHERE id = $2', ['approved', requestId]);

    res.json({ message: 'Account approved successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/reject-account — Reject/delete a pending account request
app.post('/admin/reject-account', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { requestId } = req.body;
    await db.query('DELETE FROM account_requests WHERE id = $1', [requestId]);
    res.json({ message: 'Request rejected and removed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/users — All approved users
app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.id, u.email, u.display_name, u.role, u.is_approved, d.name AS department_name
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      ORDER BY u.email ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/users/:id/projects — Assign user to projects
app.post('/admin/users/:id/projects', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { projectIds } = req.body; // array of project IDs

    // Delete existing assignments
    await db.query('DELETE FROM project_assignments WHERE user_id = $1', [userId]);

    // Insert new ones
    if (projectIds && projectIds.length > 0) {
      const values = projectIds.map(pid => `(${userId}, ${pid})`).join(', ');
      await db.query(`INSERT INTO project_assignments (user_id, project_id) VALUES ${values}`);
    }

    res.json({ message: 'Project assignments updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/users/:id/projects — Get projects assigned to a user
app.get('/admin/users/:id/projects', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT project_id FROM project_assignments WHERE user_id = $1',
      [req.params.id]
    );
    res.json(result.rows.map(r => r.project_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/projects — Create a new project
app.post('/admin/projects', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required.' });

    await db.query('INSERT INTO projects (name) VALUES ($1)', [name]);
    res.status(201).json({ message: 'Project created.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /departments — List all departments
app.get('/departments', requireAuth, async (req, res) => {
  try {
    const result = await db.query('SELECT id, name FROM departments ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============== START SERVER ===============
app.listen(PORT, () => {
  console.log(`DocHandler Server running on http://localhost:${PORT}`);
});
