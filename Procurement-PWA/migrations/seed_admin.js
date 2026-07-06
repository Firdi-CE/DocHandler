/**
 * Run the migration SQL and seed the admin user.
 * Usage: node migrations/seed_admin.js <your-google-email>
 * 
 * This will:
 * 1. Apply the migration (alter tables, create new ones)
 * 2. Set your existing user or create a new one as Executive role
 * 3. Create a test project assignment for you
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');

async function run() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node migrations/seed_admin.js <your-google-email>');
    console.log('Example: node migrations/seed_admin.js yourname@gmail.com');
    process.exit(1);
  }

  const adminEmail = args[0];

  try {
    // Step 1: Run migration SQL
    console.log('Running migration...');
    const migrationSql = fs.readFileSync(
      path.join(__dirname, '001_auth_tables.sql'),
      'utf8'
    );

    // Split by semicolons and execute each statement
    const statements = migrationSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await db.query(stmt);
        console.log(`  ✓ Executed: ${stmt.substring(0, 60)}...`);
      } catch (err) {
        // Ignore errors like "column already exists"
        if (!err.message.includes('already exists')) {
          console.warn(`  ⚠ ${err.message.substring(0, 80)}`);
        }
      }
    }

    // Step 2: Seed admin user
    console.log('\nSeeding admin user...');
    
    // Check if user already exists
    const existingUser = await db.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    
    if (existingUser.rows.length > 0) {
      // Update to Executive + approved
      await db.query(
        'UPDATE users SET role = $1, is_approved = true WHERE email = $2',
        ['Executive', adminEmail]
      );
      console.log(`  ✓ Updated ${adminEmail} → Executive (approved)`);
    } else {
      // Create new user as Executive (default to department 1 = Engineering)
      await db.query(
        'INSERT INTO users (email, role, department_id, is_approved) VALUES ($1, $2, $3, true)',
        [adminEmail, 'Executive', 1]
      );
      console.log(`  ✓ Created ${adminEmail} as Executive in Engineering`);
    }

    // Step 3: Get admin user ID
    const userRes = await db.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    const adminId = userRes.rows[0].id;

    // Step 4: Get all projects and assign admin to all
    const projects = await db.query('SELECT id, name FROM projects');
    
    if (projects.rows.length > 0) {
      for (const proj of projects.rows) {
        // Check if already assigned
        const existing = await db.query(
          'SELECT 1 FROM project_assignments WHERE user_id = $1 AND project_id = $2',
          [adminId, proj.id]
        );
        if (existing.rows.length === 0) {
          await db.query(
            'INSERT INTO project_assignments (user_id, project_id) VALUES ($1, $2)',
            [adminId, proj.id]
          );
          console.log(`  ✓ Assigned to project: ${proj.name}`);
        } else {
          console.log(`  - Already assigned to project: ${proj.name}`);
        }
      }
    } else {
      console.log('  ℹ No projects found. Create one in the admin panel.');
    }

    console.log('\n✅ Migration and seeding complete!');
    console.log('   You can now start the server: node Procurement-PWA/server.js');
    console.log('   Then sign in at: http://localhost:3000/login.html');
    console.log('\n   IMPORTANT: First-time Google sign-in will create an account request.');
    console.log('   Since you are already seeded as Executive, you will be approved immediately.');
    
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

run();
