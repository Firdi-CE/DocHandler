const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const db = require('./db');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET || 'dochandler_demo_secret_change_in_production';

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token and return the payload.
 */
async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload();
}

/**
 * Issue a JWT for a given user row from the database.
 */
function issueToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      departmentId: user.department_id,
      displayName: user.display_name,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * Verify and decode a JWT token string.
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Handle Google Sign-In flow:
 * 1. Verify Google ID token
 * 2. Check if user exists in DB
 * 3. If approved → return JWT
 * 4. If not found → create account_request
 * 5. If found but not approved → return pending status
 */
async function handleGoogleLogin(idToken) {
  const payload = await verifyGoogleToken(idToken);
  const { sub: googleId, email, name: displayName } = payload;

  // Check if user already exists
  const userRes = await db.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (userRes.rows.length > 0) {
    const user = userRes.rows[0];

    // Update google_id if not set
    if (!user.google_id) {
      await db.query(
        'UPDATE users SET google_id = $1, display_name = $2 WHERE id = $3',
        [googleId, displayName, user.id]
      );
      user.google_id = googleId;
      user.display_name = displayName;
    }

    if (!user.is_approved) {
      return { status: 'pending', message: 'Your account is awaiting admin approval.' };
    }

    const token = issueToken(user);
    return {
      status: 'approved',
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        departmentId: user.department_id,
        displayName: user.display_name,
      },
    };
  }

  // New user — create account request
  // Check if there's already a pending request
  const existingReq = await db.query(
    'SELECT * FROM account_requests WHERE email = $1',
    [email]
  );

  if (existingReq.rows.length === 0) {
    await db.query(
      'INSERT INTO account_requests (email, google_id, display_name) VALUES ($1, $2, $3)',
      [email, googleId, displayName]
    );
  }

  return { status: 'new', message: 'Account request submitted. Please wait for admin approval.' };
}

module.exports = {
  verifyGoogleToken,
  issueToken,
  verifyToken,
  handleGoogleLogin,
};
