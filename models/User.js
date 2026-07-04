// models/User.js
// One account per student, created on first Google sign-in.
// registerNo is filled in the first time the student saves grades on
// cgpa.html, and remembered so future sign-ins can jump straight to
// their saved semester data instead of asking for it again.

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  googleId: { type: String, required: true, unique: true },
  registerNo: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
