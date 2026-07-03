// routes/cgpaRoutes.js
// Backend for the Semester II grade-entry page (index.html).
// Mounted in server.js at /api/grades. Uses the Mongoose connection
// that server.js opens on startup.

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const REGNO_PATTERN = /^71402\d{7}$/;

// One document per student per semester. Re-submitting the same
// register number + semester overwrites that semester's record
// (upsert) rather than duplicating it.
const gradeRecordSchema = new mongoose.Schema({
  registerNo: { type: String, required: true, match: REGNO_PATTERN },
  semester: { type: Number, required: true },
  subjects: [{
    code: String,
    title: String,
    credit: Number,
    grade: String,
    gradePoint: Number   // null for audit/non-credit courses
  }],
  sgpa: Number,
  totalCredits: Number,
  updatedAt: { type: Date, default: Date.now }
});
gradeRecordSchema.index({ registerNo: 1, semester: 1 }, { unique: true });

const GradeRecord = mongoose.models.GradeRecord || mongoose.model('GradeRecord', gradeRecordSchema);

// POST /api/grades/semester2
// Saves (or updates) this student's Semester II grades + SGPA.
router.post('/semester2', async (req, res) => {
  try {
    const { registerNo, subjects, sgpa, totalCredits } = req.body;

    if (!REGNO_PATTERN.test(registerNo || '')) {
      return res.status(400).json({ error: 'Invalid register number format.' });
    }
    if (!Array.isArray(subjects) || subjects.length === 0) {
      return res.status(400).json({ error: 'No subject grades provided.' });
    }

    const record = await GradeRecord.findOneAndUpdate(
      { registerNo, semester: 2 },
      { registerNo, semester: 2, subjects, sgpa, totalCredits, updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, record });
  } catch (err) {
    console.error('Error saving semester 2 grades:', err);
    res.status(500).json({ error: 'Could not save grades.' });
  }
});

// GET /api/grades/cgpa/:registerNo
// Cumulative CGPA = sum(credit * gradePoint) / sum(credit) across
// every semester record stored for that student. Audit / 0-credit
// courses don't affect the ratio since their credit weight is 0.
router.get('/cgpa/:registerNo', async (req, res) => {
  try {
    const { registerNo } = req.params;

    if (!REGNO_PATTERN.test(registerNo)) {
      return res.status(400).json({ error: 'Invalid register number format.' });
    }

    const records = await GradeRecord.find({ registerNo });

    let creditSum = 0;
    let weightedSum = 0;
    records.forEach(record => {
      record.subjects.forEach(s => {
        if (s.credit > 0 && s.gradePoint != null) {
          creditSum += s.credit;
          weightedSum += s.credit * s.gradePoint;
        }
      });
    });

    const cgpa = creditSum > 0 ? weightedSum / creditSum : null;

    res.json({
      registerNo,
      cgpa,
      semestersRecorded: records.length,
      totalCredits: creditSum
    });
  } catch (err) {
    console.error('Error computing CGPA:', err);
    res.status(500).json({ error: 'Could not compute CGPA.' });
  }
});

module.exports = router;