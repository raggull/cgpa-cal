// services/googleSheets.js
// Talks to the Google Sheets API using a service account (server-to-server,
// no user login involved). The service account's email must be added as
// an Editor on the target spreadsheet, or every call here will fail with
// a permissions error.
//
// The sheet is treated as an unknown-but-well-formed layout: rather than
// hardcoding row/column numbers (which shift if a row is inserted, or
// differ semester to semester), we scan a block of header rows for the
// labels we care about ("Reg. No", "Name of the students", "SGPA", ...)
// and for column headers that match a subject's course code exactly.
// That mapping is then used to read/write specific cells.

const { google } = require('googleapis');

function getAuth() {
  const email = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error('Google Sheets is not configured — set GOOGLE_SHEETS_CLIENT_EMAIL and GOOGLE_SHEETS_PRIVATE_KEY.');
  }
  // Private keys in .env are stored with literal \n escapes (real newlines
  // don't survive a single-line env var), so they're converted back here.
  const key = rawKey.replace(/\\n/g, '\n');
  return new google.auth.JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

function client() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// 0-based column index -> A1 column letters (0 -> 'A', 26 -> 'AA', ...)
function colLetters(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const HEADER_SCAN_ROWS = 20;  // how many rows from the top to search for header labels
const HEADER_SCAN_COLS = 60;  // how many columns to search within those rows
const GRID_ROWS = 300;        // total rows fetched — header block + plenty of student rows

async function firstTabTitle(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const title = meta.data.sheets && meta.data.sheets[0] && meta.data.sheets[0].properties.title;
  if (!title) {
    throw new Error('Could not read the spreadsheet — check the sheet ID and that it is shared with the service account.');
  }
  return title;
}

// Fetches the whole working area of the sheet in one call.
// semester (1 or 2) drives the default tab name (SEM I / SEM II) when
// tabTitleOverride is not set via env.
async function loadGrid(spreadsheetId, tabTitleOverride, semester) {
  if (!spreadsheetId) throw new Error('No Google Sheet ID given.');
  const sheets = client();
  const defaultTab = semester === 2 ? 'SEM II' : 'SEM I';
  const tab = tabTitleOverride || defaultTab;
  const range = `'${tab}'!A1:AH${GRID_ROWS}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { sheets, tab, grid: res.data.values || [] };
}

function normalizeSubjectCode(code) {
  if (!code) return '';
  return code.toString().trim().toUpperCase()
    .replace(/[\u0395]/g, 'E') // Greek Capital Epsilon
    .replace(/[\u039D]/g, 'N') // Greek Capital Nu
    .replace(/[\u0397]/g, 'H') // Greek Capital Eta
    .replace(/[\u0391]/g, 'A') // Greek Capital Alpha
    .replace(/[\u0392]/g, 'B') // Greek Capital Beta
    .replace(/[\u039C]/g, 'M') // Greek Capital Mu
    .replace(/[\u03A4]/g, 'T') // Greek Capital Tau
    .replace(/[\u039F]/g, 'O') // Greek Capital Omicron
    .replace(/[\u03A1]/g, 'P') // Greek Capital Rho
    .replace(/[\u03A7]/g, 'X') // Greek Capital Chi
    .replace(/[\u03A5]/g, 'Y') // Greek Capital Upsilon
    .replace(/[\u0396]/g, 'Z') // Greek Capital Zeta
    .replace(/[\u0421]/g, 'C'); // Cyrillic Capital Es
}

function locateColumns(grid, subjectCodes) {
  const codeSet = new Set((subjectCodes || []).map(c => normalizeSubjectCode(c)));
  const map = {
    regNoCol: -1, nameCol: -1, creditsCol: -1, sgpaCol: -1,
    // currentArrearsICol  — "Current No. of Arrears (I)"  (sem-1 arrears)
    // currentArrearsIICol — "Current No. of Arrears (II)" (sem-2 arrears)
    // currentArrearsCol   — any other "Current Arrear" fallback
    currentArrearsICol: -1, currentArrearsIICol: -1, currentArrearsCol: -1,
    standingArrearsCol: -1,
    subjectCols: {}, headerRow: -1
  };

  const maxRow = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < maxRow; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < Math.min(row.length, HEADER_SCAN_COLS); c++) {
      const raw = (row[c] || '').toString().trim();
      if (!raw) continue;
      const cell = raw.toUpperCase();
      const normalizedCell = normalizeSubjectCode(raw);

      // Subject code takes priority — skip generic label checks for this cell.
      if (codeSet.has(normalizedCell)) {
        map.subjectCols[normalizedCell] = c;
        map.headerRow = Math.max(map.headerRow, r);
        continue;
      }

      if (map.regNoCol === -1 && /REG\.?\s*NO/.test(cell)) { map.regNoCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.nameCol === -1 && cell.includes('NAME')) { map.nameCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.creditsCol === -1 && cell.includes('CREDIT') && cell.includes('EARN')) { map.creditsCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.sgpaCol === -1 && cell === 'SGPA') { map.sgpaCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.standingArrearsCol === -1 && cell.includes('STANDING') && cell.includes('ARREAR')) { map.standingArrearsCol = c; map.headerRow = Math.max(map.headerRow, r); }

      // Specific semester arrear columns must be checked before generic fallback.
      if (cell.includes('CURRENT') && cell.includes('ARREAR')) {
        if      (map.currentArrearsIICol === -1 && (cell.includes('(II)') || cell.includes('SEM II') || cell.includes('SEM 2'))) { map.currentArrearsIICol = c; map.headerRow = Math.max(map.headerRow, r); }
        else if (map.currentArrearsICol  === -1 && (cell.includes('(I)')  || cell.includes('SEM I')  || cell.includes('SEM 1'))) { map.currentArrearsICol  = c; map.headerRow = Math.max(map.headerRow, r); }
        else if (map.currentArrearsCol   === -1) { map.currentArrearsCol = c; map.headerRow = Math.max(map.headerRow, r); }
      }
    }
  }

  map.dataStartRow = map.headerRow >= 0 ? map.headerRow + 1 : -1;
  return map;
}

function findRowForRegisterNo(grid, colMap, registerNo) {
  if (colMap.regNoCol === -1 || colMap.dataStartRow === -1) return -1;
  const target = (registerNo || '').trim().toUpperCase();
  for (let r = colMap.dataStartRow; r < grid.length; r++) {
    const cell = ((grid[r] || [])[colMap.regNoCol] || '').toString().trim().toUpperCase();
    if (cell === target) return r;
  }
  return -1;
}

function normalizeName(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

// Builds cell writes for one student row.
// sem1Arrears: weighted arrear count from semester-1 DB record (needed when
// writing semester-2 data so the "Current No. of Arrears (I)" column gets
// filled from the database rather than the current semester's grades).
function buildRowUpdates({ tab, colMap, rowIndex, record, standingArrears, sem1Arrears }) {
  const rowNumber = rowIndex + 1; // grid is 0-based, A1 rows are 1-based
  const updates = [];
  const preview = [];

  record.subjects.forEach(s => {
    const col = colMap.subjectCols[normalizeSubjectCode(s.code)];
    if (col === undefined) return;
    updates.push({ range: `'${tab}'!${colLetters(col)}${rowNumber}`, values: [[s.grade]] });
    preview.push({ code: s.code, title: s.title, grade: s.grade });
  });

  if (colMap.creditsCol !== -1) {
    updates.push({ range: `'${tab}'!${colLetters(colMap.creditsCol)}${rowNumber}`, values: [[record.totalCredits ?? '']] });
  }
  if (colMap.sgpaCol !== -1) {
    updates.push({ range: `'${tab}'!${colLetters(colMap.sgpaCol)}${rowNumber}`, values: [[record.sgpa != null ? Number(record.sgpa.toFixed(2)) : '']] });
  }

  // Weighted current arrears: sum arrearCount for every failed subject.
  const currentArrears = record.subjects
    .filter(s => s.grade === 'U')
    .reduce((sum, s) => sum + (s.arrearCount || 1), 0);

  // Write to whichever column(s) the sheet exposes.
  // Sem-2 sheets may have both (I) for sem-1 arrears and (II) for sem-2 arrears.
  if (colMap.currentArrearsIICol !== -1) {
    // Sheet has explicit sem-II column → write current sem arrears there.
    updates.push({ range: `'${tab}'!${colLetters(colMap.currentArrearsIICol)}${rowNumber}`, values: [[currentArrears]] });
    // Also backfill the sem-I column from the passed sem-1 data.
    if (colMap.currentArrearsICol !== -1 && sem1Arrears != null) {
      updates.push({ range: `'${tab}'!${colLetters(colMap.currentArrearsICol)}${rowNumber}`, values: [[sem1Arrears]] });
    }
  } else if (colMap.currentArrearsICol !== -1) {
    // Sheet only has a single named (I) column — treat it as "current semester".
    updates.push({ range: `'${tab}'!${colLetters(colMap.currentArrearsICol)}${rowNumber}`, values: [[currentArrears]] });
  } else if (colMap.currentArrearsCol !== -1) {
    // Generic fallback column.
    updates.push({ range: `'${tab}'!${colLetters(colMap.currentArrearsCol)}${rowNumber}`, values: [[currentArrears]] });
  }

  if (colMap.standingArrearsCol !== -1 && standingArrears != null) {
    updates.push({ range: `'${tab}'!${colLetters(colMap.standingArrearsCol)}${rowNumber}`, values: [[standingArrears]] });
  }

  return { updates, preview };
}

async function commitUpdates(sheets, spreadsheetId, updates) {
  if (!updates || !updates.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: updates }
  });
}

module.exports = {
  colLetters,
  loadGrid,
  locateColumns,
  findRowForRegisterNo,
  normalizeName,
  buildRowUpdates,
  commitUpdates
};