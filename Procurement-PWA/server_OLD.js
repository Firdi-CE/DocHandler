const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const session = require('express-session');
const passport = require('./auth'); // Imports configured passport from auth.js
const db = require('./db');         // Imports PostgreSQL connection pool from db.js

const app = express();
const PORT = process.env.PORT || 3000;
// Add this to your server.js, line 10
console.log("--- STARTING NEW SERVER VERSION ---");

// --- 1. MIDDLEWARE CONFIGURATION ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Express session setup (Vital for maintaining login states)
app.use(session({
    secret: 'pbe_oneforall_secret_key_placeholder', 
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } 
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


// --- 4. DATA SELECT DROPDOWN ENDPOINTS ---

// API Endpoint to fetch existing company projects to build frontend selections dynamically
app.get('/projects', async (req, res) => {
    try {
        const result = await db.query('SELECT id, name FROM projects ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Endpoint to fetch users grouped by selected department for chained dependent options
app.get('/users/by-department/:deptId', async (req, res) => {
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
app.post('/upload', upload.single('document'), async (req, res) => {
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
app.get('/documents/my-inbox/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.query(
            'SELECT * FROM documents WHERE recipient_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- 6. START SERVER ENGINE ---
app.listen(PORT, () => {
    console.log(`PBE OneForAll active application server streaming live at http://localhost:${PORT}`);
});