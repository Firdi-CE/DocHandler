const { verifyToken } = require('../auth');

/**
 * Middleware: Require a valid JWT. Attaches user to req.user.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

/**
 * Middleware: Require admin role.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'Executive') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

/**
 * Middleware: Optionally attach user if token present, but don't block.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      req.user = verifyToken(token);
    } catch (err) {
      // Token invalid, proceed without user
    }
  }
  next();
}

module.exports = { requireAuth, requireAdmin, optionalAuth };
