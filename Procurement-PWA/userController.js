const db = require('./db');

const registerUser = async (email, departmentName, role = 'Staff') => {
    try {
        // 1. Get the department ID based on the department name
        const deptRes = await db.query('SELECT id FROM departments WHERE name = $1', [departmentName]);
        
        if (deptRes.rows.length === 0) {
            throw new Error('Department not found');
        }
        
        const departmentId = deptRes.rows[0].id;

        // 2. Insert the user
        const query = `
            INSERT INTO users (email, role, department_id)
            VALUES ($1, $2, $3)
            ON CONFLICT (email) DO NOTHING;
        `;
        await db.query(query, [email, role, departmentId]);
        
        console.log(`User ${email} registered successfully.`);
    } catch (err) {
        console.error('Error registering user:', err.message);
    }
};

module.exports = { registerUser };