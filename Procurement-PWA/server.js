const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadPath = path.join(__dirname, 'public/uploads');
        // Ensure the uploads directory exists
        if (!fs.existsSync(uploadPath)){
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Save the file with the original name and a timestamp to prevent overwriting
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
    const directoryPath = path.join(__dirname, 'public/uploads');
    fs.readdir(directoryPath, (err, files) => {
        if (err) {
            return res.status(500).send('Unable to scan directory');
        }
        res.json(files); // Sends the list of files as a JSON array
    });
});
// Start the server
app.listen(PORT, () => {
    console.log(`Procurement PWA Server is running on http://localhost:${PORT}`);
});