// routes/sheetsRoutes.js
// Mounted in server.js at /api/sheets (behind requireAuth — every route
// here needs a signed-in college account).
//
// POST /add          — writes one saved semester record into the default
//                       sheet, but only after the register number is found
//                       AND the sheet's own listed name matches what the
//                       student typed. Supports dryRun:true to check/preview
//                       without writing.
// POST /convert-all   — admin only. Writes every saved record for a given
//                       semester into a sheet (default or an override id),
//                       sorted by register number ascending.
// GET  /debug         — admin only, read-only. Reports what the column
//                       detection found, to sanity-check a sheet template
//                       without risking a write.

const express = require('express');
const router = express.Router();

const { GradeRecord, REGNO_PATTERN } = require('./cgpaRoutes');
const sheetsSvc = require('../services/googleSheets');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ragula25cs@srishakthi.ac.in').toLowerCase();

function requireAdmin(req, res, next) {
  if ((req.user.email || '').toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access only.' });
  }
  next();
}

// Same "pending arrear" rule as GET /api/grades/arrears/:registerNo —
// a course first failed and never since cleared — but scoped to records
// up to and including the given semester, and returning just the count.
async function countStandingArrears(registerNo, uptoSemester) {
  const records = await GradeRecord.find({ registerNo, semester: { $lte: uptoSemester } }).sort({ semester: 1 });
  const attempts = new Map();
  records.forEach(record => {
    record.subjects.forEach(s => {
      if (!attempts.has(s.code)) attempts.set(s.code, []);
      attempts.get(s.code).push({ semester: record.semester, grade: s.grade });
    });
  });
  let pending = 0;
  attempts.forEach(list => {
    const firstFail = list.find(a => a.grade === 'U');
    if (!firstFail) return;
    const cleared = list.find(a => a.semester > firstFail.semester && a.grade !== 'U');
    if (!cleared) pending += 1;
  });
  return pending;
}

// ---------------------------------------------------------------------
// POST /api/sheets/add
// ---------------------------------------------------------------------
router.post('/add', async (req, res) => {
  try {
    const registerNo = (req.body.registerNo || '').trim();
    const studentName = (req.body.studentName || '').trim();
    const semester = Number(req.body.semester);
    const dryRun = !!req.body.dryRun;

    if (!REGNO_PATTERN.test(registerNo)) {
      return res.status(400).json({ error: 'Invalid register number format.' });
    }
    if (!studentName) {
      return res.status(400).json({ error: 'Enter the student name.' });
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      return res.status(500).json({ error: 'Google Sheets is not configured on the server (GOOGLE_SHEET_ID is missing).' });
    }

    const record = await GradeRecord.findOne({ registerNo, semester });
    if (!record) {
      return res.status(404).json({ error: `No saved record for semester ${semester} yet — click Calculate first.` });
    }

    const { sheets, tab, grid } = await sheetsSvc.loadGrid(sheetId, process.env.GOOGLE_SHEET_TAB);
    const colMap = sheetsSvc.locateColumns(grid, record.subjects.map(s => s.code));

    if (colMap.regNoCol === -1 || colMap.dataStartRow === -1) {
      return res.status(500).json({ error: 'Could not find a "Reg. No" header in the sheet — check the template layout.' });
    }

    const rowIndex = sheetsSvc.findRowForRegisterNo(grid, colMap, registerNo);
    if (rowIndex === -1) {
      return res.status(404).json({ error: `Register number ${registerNo} was not found in the sheet template.`, match: false });
    }

    if (colMap.nameCol !== -1) {
      const sheetName = (grid[rowIndex][colMap.nameCol] || '').toString();
      if (sheetsSvc.normalizeName(sheetName) !== sheetsSvc.normalizeName(studentName)) {
        return res.status(409).json({
          error: `That register number is listed under a different name on the sheet. Double-check your name and register number.`,
          match: false
        });
      }
    }

    const standingArrears = await countStandingArrears(registerNo, semester);
    const { updates, preview } = sheetsSvc.buildRowUpdates({ tab, colMap, rowIndex, record, standingArrears });

    if (!updates.length) {
      return res.status(422).json({
        error: 'None of this semester\'s subjects matched a column on the sheet — check the sheet\'s course-code headers.',
        match: true
      });
    }

    if (dryRun) {
      return res.json({ match: true, preview });
    }

    await sheetsSvc.commitUpdates(sheets, sheetId, updates);
    res.json({ match: true, success: true, cellsWritten: updates.length, preview });
  } catch (err) {
    console.error('Error adding to sheet:', err);
    res.status(500).json({ error: err.message || 'Could not update the sheet.' });
  }
});

// ---------------------------------------------------------------------
// POST /api/sheets/convert-all   (admin only)
// Body: { semester (required), sheetId (optional override) }
// Every saved record for that semester, sorted by register number
// ascending. There's no per-student "claimed" name to check here (bulk
// conversion pulls straight from the database, not from a form) — a
// record is written once its register number is found on the sheet;
// the sheet's own listed name is trusted as-is. Records whose register
// number isn't on the sheet, or whose subjects don't match any column,
// are skipped and reported rather than written.
// ---------------------------------------------------------------------
router.post('/convert-all', requireAdmin, async (req, res) => {
  try {
    const semester = Number(req.body.semester);
    const sheetId = (req.body.sheetId || '').trim() || process.env.GOOGLE_SHEET_ID;

    if (!semester) {
      return res.status(400).json({ error: 'Semester is required.' });
    }
    if (!sheetId) {
      return res.status(500).json({ error: 'No sheet ID given, and GOOGLE_SHEET_ID is not set on the server.' });
    }

    const records = await GradeRecord.find({ semester }).sort({ registerNo: 1 });
    if (!records.length) {
      return res.json({ total: 0, updated: 0, skipped: [] });
    }

    const { sheets, tab, grid } = await sheetsSvc.loadGrid(sheetId, process.env.GOOGLE_SHEET_TAB);

    // One shared column map, built from the union of every subject code
    // across all records — covers everyone even if records differ slightly.
    const allCodes = new Set();
    records.forEach(r => r.subjects.forEach(s => allCodes.add(s.code)));
    const colMap = sheetsSvc.locateColumns(grid, [...allCodes]);

    if (colMap.regNoCol === -1 || colMap.dataStartRow === -1) {
      return res.status(500).json({ error: 'Could not find a "Reg. No" header in the sheet — check the template layout.' });
    }

    const allUpdates = [];
    const skipped = [];
    let updated = 0;

    for (const record of records) {
      const rowIndex = sheetsSvc.findRowForRegisterNo(grid, colMap, record.registerNo);
      if (rowIndex === -1) {
        skipped.push({ registerNo: record.registerNo, reason: 'Register number not found on the sheet.' });
        continue;
      }
      const standingArrears = await countStandingArrears(record.registerNo, semester);
      const { updates } = sheetsSvc.buildRowUpdates({ tab, colMap, rowIndex, record, standingArrears });
      if (!updates.length) {
        skipped.push({ registerNo: record.registerNo, reason: 'No matching subject columns for this record.' });
        continue;
      }
      allUpdates.push(...updates);
      updated += 1;
    }

    await sheetsSvc.commitUpdates(sheets, sheetId, allUpdates);

    res.json({ total: records.length, updated, skipped });
  } catch (err) {
    console.error('Error converting all records to sheet:', err);
    res.status(500).json({ error: err.message || 'Bulk conversion failed.' });
  }
});

// ---------------------------------------------------------------------
// GET /api/sheets/debug?semester=1&sheetId=optional   (admin only)
// Read-only. Reports what the header scan found so a mismatched template
// can be diagnosed before running a real write.
// ---------------------------------------------------------------------
router.get('/debug', requireAdmin, async (req, res) => {
  try {
    const semester = Number(req.query.semester) || 1;
    const sheetId = (req.query.sheetId || '').toString().trim() || process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      return res.status(500).json({ error: 'No sheet ID given, and GOOGLE_SHEET_ID is not set on the server.' });
    }

    const records = await GradeRecord.find({ semester }).limit(100);
    const allCodes = new Set();
    records.forEach(r => r.subjects.forEach(s => allCodes.add(s.code)));

    const { tab, grid } = await sheetsSvc.loadGrid(sheetId, process.env.GOOGLE_SHEET_TAB);
    const colMap = sheetsSvc.locateColumns(grid, [...allCodes]);

    const sampleRows = [];
    if (colMap.dataStartRow !== -1) {
      const end = Math.min(grid.length, colMap.dataStartRow + 5);
      for (let r = colMap.dataStartRow; r < end; r++) {
        sampleRows.push({
          row: r + 1,
          regNo: colMap.regNoCol !== -1 ? (grid[r][colMap.regNoCol] || '') : null,
          name: colMap.nameCol !== -1 ? (grid[r][colMap.nameCol] || '') : null
        });
      }
    }

    const subjectColumns = {};
    Object.entries(colMap.subjectCols).forEach(([code, col]) => {
      subjectColumns[code] = sheetsSvc.colLetters(col);
    });

    res.json({
      tab,
      headerRow: colMap.headerRow >= 0 ? colMap.headerRow + 1 : null,
      dataStartRow: colMap.dataStartRow >= 0 ? colMap.dataStartRow + 1 : null,
      regNoColumn: colMap.regNoCol !== -1 ? sheetsSvc.colLetters(colMap.regNoCol) : null,
      nameColumn: colMap.nameCol !== -1 ? sheetsSvc.colLetters(colMap.nameCol) : null,
      creditsColumn: colMap.creditsCol !== -1 ? sheetsSvc.colLetters(colMap.creditsCol) : null,
      sgpaColumn: colMap.sgpaCol !== -1 ? sheetsSvc.colLetters(colMap.sgpaCol) : null,
      currentArrearsColumn: colMap.currentArrearsCol !== -1 ? sheetsSvc.colLetters(colMap.currentArrearsCol) : null,
      standingArrearsColumn: colMap.standingArrearsCol !== -1 ? sheetsSvc.colLetters(colMap.standingArrearsCol) : null,
      subjectColumnsFound: subjectColumns,
      subjectCodesLookedFor: [...allCodes],
      sampleStudentRows: sampleRows
    });
  } catch (err) {
    console.error('Error running sheets debug:', err);
    res.status(500).json({ error: err.message || 'Debug check failed.' });
  }
});

module.exports = router;