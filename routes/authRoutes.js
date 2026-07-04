// routes/authRoutes.js
// Mounted in server.js at /api/auth. Google is the only way in — a
// verified Google ID token gets exchanged for a signed JWT the frontend
// stores and sends back as `Authorization: Bearer <token>`.

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const User = require('../models/User');
const requireAuth = require('../middleware/authMiddleware');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const TOKEN_TTL = '30m';

// Only students signed in with a Sri Shakthi college Google account may use this app.
const ALLOWED_EMAIL_DOMAIN = 'srishakthi.ac.in';

function signToken(user) {
  return jwt.sign(
    { id: user._id, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function publicUser(user) {
  return { id: user._id, name: user.name, email: user.email, registerNo: user.registerNo || null };
}

// ---------------------------------------------------------------------
// GET /api/auth/config
// Public, non-secret config the login page needs at load time.
// (Google client IDs are meant to be public — this is not the secret.)
// ---------------------------------------------------------------------
router.get('/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

// ---------------------------------------------------------------------
// POST /api/auth/google
// Signs in (or creates an account) from a Google Identity Services
// credential — an ID token, verified server-side against GOOGLE_CLIENT_ID.
// Restricted to @srishakthi.ac.in accounts.
// ---------------------------------------------------------------------
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google sign-in is not configured on this server.' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(401).json({ error: 'Could not verify Google account.' });
    }
    if (!payload.email_verified) {
      return res.status(401).json({ error: 'That Google account\'s email is not verified.' });
    }

    const email = payload.email.toLowerCase();
    if (!email.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) {
      return res.status(403).json({ error: `Only @${ALLOWED_EMAIL_DOMAIN} college accounts can sign in.` });
    }

    let user = await User.findOne({ $or: [{ googleId: payload.sub }, { email }] });

    if (!user) {
      user = await User.create({
        name: payload.name || email.split('@')[0],
        email,
        googleId: payload.sub
      });
    } else if (!user.googleId) {
      user.googleId = payload.sub;
      await user.save();
    }

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error('Error with Google sign-in:', err);
    res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// GET /api/auth/me
// Returns the signed-in account's details, including any saved register
// number. Used by cgpa.html to prefill the student name + register number
// (so previously-saved semester data loads automatically) and to confirm
// the stored token is still valid.
// ---------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('Error fetching account:', err);
    res.status(500).json({ error: 'Could not fetch your account.' });
  }
});

module.exports = router;