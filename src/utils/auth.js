const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'qa-engine-secret-key-2024';
const JWT_EXPIRES_IN = '24h';

/**
 * Generate a JWT token for a user
 */
function generateToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function authMiddleware(req, res, next) {
    // 1. Check for token in headers or cookies
    let token = null;
    
    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.split(' ')[1]) {
        token = authHeader.split(' ')[1];
    }
    
    // Check Cookie (token is stored in 'qa_token' cookie)
    if (!token && req.cookies && req.cookies.qa_token) {
        token = req.cookies.qa_token;
    }

    if (!token) {
        const isApi = req.path.startsWith('/api/');
        const isAjax = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
        
        if (isApi || isAjax) {
            return res.status(401).json({ error: 'Unauthorized: No token provided' });
        }
        return res.redirect('/login.html');
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
        }
        // If it's an invalid cookie, clear it and redirect
        res.clearCookie('qa_token');
        return res.redirect('/login.html');
    }
}

/**
 * Middleware to restrict to ADMIN role
 */
function adminOnly(req, res, next) {
    if (req.user && req.user.role === 'ADMIN') {
        next();
    } else {
        res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
}

module.exports = {
    generateToken,
    authMiddleware,
    adminOnly,
    JWT_SECRET
};
