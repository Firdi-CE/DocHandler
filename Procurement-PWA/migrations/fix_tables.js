const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'pbe_oneforall',
  password: 'PilarBahtera',
  port: 5432,
});

async function run() {
  try {
    // Create project_assignments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_assignments (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        project_id INT REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE(user_id, project_id)
      )
    `);
    console.log('✓ Created project_assignments table');

    // Create account_requests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_requests (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        google_id VARCHAR(255),
        display_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Created account_requests table');

    // Assign admin to all projects
    const result = await pool.query(`
      INSERT INTO project_assignments (user_id, project_id)
      SELECT u.id, p.id FROM users u, projects p
      WHERE u.email = 'alamfirdaus0401@gmail.com'
      AND NOT EXISTS (
        SELECT 1 FROM project_assignments pa WHERE pa.user_id = u.id AND pa.project_id = p.id
      )
    `);
    console.log(`✓ Assigned admin to ${result.rowCount} projects`);

    console.log('\n✅ All done!');
    process.exit(0);
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}

run();
