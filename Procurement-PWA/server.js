require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const session = require('express-session');
const passport = require('./auth'); // Imports configured passport from auth.js
const db = require('./db');         // Imports PostgreSQL connection pool from db.js

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// --- 1. MIDDLEWARE CONFIGURATION ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Express session setup (Vital for maintaining login states)
app.use(session({
    secret: 'pbe_oneforall_secret_key_placeholder', 
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,    // Set to false for local dev (use true only if you have HTTPS)
        httpOnly: true,
        sameSite: 'lax',  // 'lax' allows the cookie to pass through the tunnel
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
    }
}));

// Initialize Passport sessions
app.use(passport.initialize());
app.use(passport.session());

// Serve static web interface assets from the public directory
app.use(express.static(path.join(__dirname, 'public')));


// --- 2. SELF-CORRECTING MULTER STORAGE PATH ---
const uploadDir = path.join(__dirname, 'uploads');

// Automatically build directory path if missing to prevent ENOENT errors
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Created missing uploads folder structure at:', uploadDir);
}

// Storage engine configuration keeping original names safely timestamps
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Serve uploaded PDFs so they can be viewed/downloaded via the client dashboard link
app.use('/uploads', express.static(uploadDir));


// --- 3. GOOGLE SINGLE SIGN-ON (SSO) AUTHENTICATION ROUTES ---

// Route to kick off the Google OAuth login prompt overlay
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

// Callback redirect route target whitelisted in Google Cloud Platform Console
app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login.html' }),
    (req, res) => {
        // Successfully authenticated cookie token verified. Forward to main portal view page.
        res.redirect('/index.html'); 
    }
);

// Middleware to protect routes by ensuring the user is authenticated.
const ensureAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ message: 'Not authenticated' });
};

// --- 4. DATA SELECT DROPDOWN ENDPOINTS ---

// API Endpoint to fetch existing company projects to build frontend selections dynamically
app.get('/projects', ensureAuthenticated, async (req, res) => {
    try {
        const result = await db.query('SELECT id, name FROM projects ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Endpoint to fetch users grouped by selected department for chained dependent options
app.get('/users/by-department/:deptId', ensureAuthenticated, async (req, res) => {
    try {
        const { deptId } = req.params;
        const result = await db.query(
            'SELECT id, email FROM users WHERE department_id = $1 ORDER BY email ASC',
            [deptId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- 5. DOCUMENT TRANSACTION MANAGEMENT ---

// Endpoint handling physical multi-part upload write transactions and relational database linking
app.post('/upload', ensureAuthenticated, upload.single('document'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }

        // Capture properties emitted from form elements matching layout targets
        const { senderId, recipientId, projectId, departmentId } = req.body;
        const filename = req.file.filename;

        // Perform strict table transaction sequence mapping elements cleanly to table relations
        const query = `
            INSERT INTO documents (filename, sender_id, recipient_id, project_id, department_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        const values = [filename, senderId, recipientId, projectId, departmentId];
        await db.query(query, values);

        console.log(`Document transaction completed successfully: ${filename}`);
        res.status(200).send('Document routed and saved successfully!');
    } catch (err) {
        console.error('Database Upload Route Error:', err);
        res.status(500).send('Error saving document metadata relation fields.');
    }
});

// Endpoint to capture inbox layout listings targeting single identity profile logs
app.get('/documents/my-inbox', ensureAuthenticated, async (req, res) => {
    try {
        const userId = req.user.id; // Securely get user ID from the authenticated session
        const result = await db.query(
            `SELECT d.*, p.name as project_name, u_sender.email as sender_email, dept.name as department_name
             FROM documents d
             LEFT JOIN projects p ON d.project_id = p.id
             LEFT JOIN users u_sender ON d.sender_id = u_sender.id
             LEFT JOIN departments dept ON d.department_id = dept.id
             WHERE d.recipient_id = $1 ORDER BY d.created_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
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