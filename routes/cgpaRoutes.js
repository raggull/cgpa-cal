// routes/cgpaRoutes.js
// Backend for the CGPA calculator (Semester 1 & Semester 2 grade entry).
// Mounted in server.js at /api/grades. Uses the Mongoose connection
// that server.js opens on startup.

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const User = require('../models/User');

const REGNO_PATTERN = /^71402\d{7}$/;
const VALID_SEMESTERS = [1, 2];

// One document per student per semester. Re-submitting the same
// register number + semester overwrites that semester's record
// (upsert) rather than duplicating it.
//
// A subject inside a semester's record is either:
//  - a regular course registered for that semester, or
//  - an arrear clearance: a course originally registered (and failed
//    with grade 'U') in an earlier semester, re-entered here once the
//    student clears it. isArrearClearance/originalSemester track that
//    so the CGPA route can drop the earlier failed attempt.
const gradeRecordSchema = new mongoose.Schema({
  registerNo: { type: String, required: true, match: REGNO_PATTERN },
  semester: { type: Number, required: true },
  subjects: [{
    code: String,
    title: String,
    credit: Number,
    grade: String,
    gradePoint: Number,                     // null for audit/non-credit courses
    isArrearClearance: { type: Boolean, default: false },
    originalSemester: { type: Number, default: null }
  }],
  sgpa: Number,          // this semester's own SGPA — regular courses only
  totalCredits: Number,  // credit base used for that SGPA
  updatedAt: { type: Date, default: Date.now }
});
gradeRecordSchema.index({ registerNo: 1, semester: 1 }, { unique: true });

const GradeRecord = mongoose.models.GradeRecord || mongoose.model('GradeRecord', gradeRecordSchema);

// ---------------------------------------------------------------------
// POST /api/grades/:semester
// Saves (or updates) this student's grades + SGPA for the given semester.
// semester must be 1 or 2 (extend VALID_SEMESTERS as later semesters are added).
// ---------------------------------------------------------------------
router.post('/:semester', async (req, res) => {
  try {
    const semester = Number(req.params.semester);
    const { registerNo, subjects, sgpa, totalCredits } = req.body;

    if (!VALID_SEMESTERS.includes(semester)) {
      return res.status(400).json({ error: 'Semester must be 1 or 2.' });
    }
    if (!REGNO_PATTERN.test(registerNo || '')) {
      return res.status(400).json({ error: 'Invalid register number format.' });
    }
    if (!Array.isArray(subjects) || subjects.length === 0) {
      return res.status(400).json({ error: 'No subject grades provided.' });
    }

    const record = await GradeRecord.findOneAndUpdate(
      { registerNo, semester },
      { registerNo, semester, subjects, sgpa, totalCredits, updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );


    // Remember this register number on the signed-in account so future
    // sign-ins can load this student's saved semester data automatically.
    if (req.user && req.user.id) {
      try {
        await User.findByIdAndUpdate(req.user.id, { registerNo });
      } catch (linkErr) {
        console.error('Could not save register number to account:', linkErr);
        // Non-fatal — the grade record itself saved fine.
      }
    }

    res.json({ success: true, record });
  } catch (err) {
    console.error('Error saving grades:', err);
    res.status(500).json({ error: 'Could not save grades.' });
  }
});

// ---------------------------------------------------------------------
// GET /api/grades/record/:registerNo/:semester
// Fetches one semester's stored record, if any. The frontend uses this
// two ways: to prefill a semester being reopened, and (for semester 2)
// to look at semester 1's record and pull out any 'U' grades so they
// can be re-listed as arrears to clear.
// ---------------------------------------------------------------------
router.get('/record/:registerNo/:semester', async (req, res) => {
  try {
    const { registerNo } = req.params;
    const semester = Number(req.params.semester);

    if (!REGNO_PATTERN.test(registerNo)) {
      return res.status(400).json({ error: 'Invalid register number format.' });
    }
    if (!VALID_SEMESTERS.includes(semester)) {
      return res.status(400).json({ error: 'Semester must be 1 or 2.' });
    }

    const record = await GradeRecord.findOne({ registerNo, semester });
    res.json({ record: record || null });
  } catch (err) {
    console.error('Error fetching record:', err);
    res.status(500).json({ error: 'Could not fetch record.' });
  }
});

// ---------------------------------------------------------------------
// GET /api/grades/cgpa/:registerNo
// CGPA = sum(credit * gradePoint) / sum(credit), counting each course
// code ONCE. If a course was failed (U) in one semester and cleared in
// a later one, only the clearing attempt is used — the earlier failed
// attempt is dropped from CGPA even though that semester's own stored
// SGPA still reflects the original U (SGPA is a fixed historical value;
// CGPA is what gets corrected once a backlog clears).
// ---------------------------------------------------------------------
router.get('/cgpa/:registerNo', async (req, res) => {
  try {
    const { registerNo } = req.params;

    if (!REGNO_PATTERN.test(registerNo)) {
      return res.status(400).json({ error: 'Invalid register number format.' });
    }

    const records = await GradeRecord.find({ registerNo }).sort({ semester: 1 });

    // Later semester wins for a given course code (that's the cleared attempt).
    const bestByCode = new Map();
    records.forEach(record => {
      record.subjects.forEach(s => {
        if (s.credit > 0 && s.gradePoint != null) {
          const prev = bestByCode.get(s.code);
          if (!prev || record.semester >= prev.semester) {
            bestByCode.set(s.code, { credit: s.credit, gradePoint: s.gradePoint, semester: record.semester });
          }
        }
      });
    });

    let creditSum = 0;
    let weightedSum = 0;
    bestByCode.forEach(({ credit, gradePoint }) => {
      creditSum += credit;
      weightedSum += credit * gradePoint;
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

// ---------------------------------------------------------------------
// GET /api/grades/arrears/:registerNo
// Arrear history: every course ever graded 'U', and whether it's since
// been cleared (in which semester, with what grade) or is still pending.
// ---------------------------------------------------------------------
router.get('/arrears/:registerNo', async (req, res) => {
  try {
    const { registerNo } = req.params;

    if (!REGNO_PATTERN.test(registerNo)) {
      return res.status(400).json({ error: 'Invalid register number format.' });
    }

    const records = await GradeRecord.find({ registerNo }).sort({ semester: 1 });

    // attempts.get(code) = ordered list of every attempt at that course, across semesters
    const attempts = new Map();
    records.forEach(record => {
      record.subjects.forEach(s => {
        if (!attempts.has(s.code)) attempts.set(s.code, []);
        attempts.get(s.code).push({
          semester: record.semester,
          grade: s.grade,
          title: s.title,
          credit: s.credit
        });
      });
    });

    const arrears = [];
    attempts.forEach((list, code) => {
      const firstFail = list.find(a => a.grade === 'U');
      if (!firstFail) return; // never failed at this course — not an arrear

      const clearingAttempt = list.find(a => a.semester > firstFail.semester && a.grade !== 'U');
      const stillFailingLater = list.find(a => a.semester > firstFail.semester && a.grade === 'U');

      arrears.push({
        code,
        title: firstFail.title,
        credit: firstFail.credit,
        failedInSemester: firstFail.semester,
        status: clearingAttempt ? 'cleared' : 'pending',
        clearedInSemester: clearingAttempt ? clearingAttempt.semester : (stillFailingLater ? stillFailingLater.semester : null),
        clearedGrade: clearingAttempt ? clearingAttempt.grade : null
      });
    });

    arrears.sort((a, b) => a.failedInSemester - b.failedInSemester);

    res.json({ registerNo, arrears });
  } catch (err) {
    console.error('Error computing arrear history:', err);
    res.status(500).json({ error: 'Could not compute arrear history.' });
  }
});

module.exports = router;
module.exports.GradeRecord = GradeRecord;
module.exports.REGNO_PATTERN = REGNO_PATTERN;