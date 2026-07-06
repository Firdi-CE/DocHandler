const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db'); 
const upload = multer({ dest: 'uploads/' });
const app = express();
const PORT = 3000;

const FILE_MANIFEST = path.join(__dirname, 'files.json');

app.post('/upload', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }

        // Capture data from the form
        const { senderId, recipientId, projectId, departmentId } = req.body;
        const filename = req.file.filename;

        // Save metadata to database
        const query = `
            INSERT INTO documents (filename, sender_id, recipient_id, project_id, department_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id;
        `;
        const values = [filename, senderId, recipientId, projectId, departmentId];
        await db.query(query, values);

        res.status(200).send('Document routed and saved successfully!');
    } catch (err) {
        console.error('Database Error:', err);
        res.status(500).send('Error saving document metadata.');
    }
});
// Serve static files from the 'public' directory
app.use(express.static('public'));

// Configure Multer for dynamic team-based folder routing
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Use the 'team' value from the form body to create a subfolder
        const teamName = req.body.team || 'General';
        const uploadPath = path.join(__dirname, 'public/uploads', teamName);
        
        // Ensure the directory exists
        if (!fs.existsSync(uploadPath)){
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// API Endpoint to handle the PDF upload
app.post('/upload', upload.single('document'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    
    // Log the team name (sent from the frontend form)
    const targetTeam = req.body.team;
    console.log(`New PDF routed to: ${targetTeam}`);
    console.log(`File saved as: ${req.file.filename}`);

    res.send(`File successfully uploaded and routed to ${targetTeam}!`);
});
// New Endpoint: Get list of files
app.get('/files', (req, res) => {
    if (!fs.existsSync(FILE_MANIFEST)) return res.json([]);
    res.sendFile(FILE_MANIFEST);
});
// get users by department
app.get('/users/by-department/:deptId', async (req, res) => {
    try {
        const { deptId } = req.params;
        const result = await db.query(
            'SELECT id, email FROM users WHERE department_id = $1',
            [deptId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Start the server
app.listen(PORT, () => {
    console.log(`Procurement PWA Server is running on http://localhost:${PORT}`);
});