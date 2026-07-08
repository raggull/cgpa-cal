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
const HEADER_SCAN_COLS = 30;  // how many columns to search within those rows
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
async function loadGrid(spreadsheetId, tabTitleOverride) {
  if (!spreadsheetId) throw new Error('No Google Sheet ID given.');
  const sheets = client();
  const tab = tabTitleOverride || await firstTabTitle(sheets, spreadsheetId);
  const range = `'${tab}'!A1:AH${GRID_ROWS}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { sheets, tab, grid: res.data.values || [] };
}

// Scans the header block for the columns we need. subjectCodes is the set
// of course codes we're looking to place — a column only counts as a
// subject column if its header text exactly matches one of them.
function locateColumns(grid, subjectCodes) {
  const codeSet = new Set((subjectCodes || []).map(c => c.toUpperCase()));
  const map = {
    regNoCol: -1, nameCol: -1, creditsCol: -1, sgpaCol: -1,
    currentArrearsCol: -1, standingArrearsCol: -1,
    subjectCols: {}, headerRow: -1
  };

  const maxRow = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < maxRow; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < Math.min(row.length, HEADER_SCAN_COLS); c++) {
      const raw = (row[c] || '').toString().trim();
      if (!raw) continue;
      const cell = raw.toUpperCase();

      if (map.regNoCol === -1 && /REG\.?\s*NO/.test(cell)) { map.regNoCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.nameCol === -1 && cell.includes('NAME')) { map.nameCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.creditsCol === -1 && cell.includes('CREDIT') && cell.includes('EARN')) { map.creditsCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.sgpaCol === -1 && cell === 'SGPA') { map.sgpaCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.currentArrearsCol === -1 && cell.includes('CURRENT') && cell.includes('ARREAR')) { map.currentArrearsCol = c; map.headerRow = Math.max(map.headerRow, r); }
      if (map.standingArrearsCol === -1 && cell.includes('STANDING') && cell.includes('ARREAR')) { map.standingArrearsCol = c; map.headerRow = Math.max(map.headerRow, r); }

      if (codeSet.has(cell)) { map.subjectCols[cell] = c; map.headerRow = Math.max(map.headerRow, r); }
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

// Builds the {range, values} cell writes for one student's row, without
// calling the API. Subjects with no matching header column (e.g. an
// arrear clearance carried over from a different semester's course list)
// are silently left out — there's no cell for them on this sheet.
function buildRowUpdates({ tab, colMap, rowIndex, record, standingArrears }) {
  const rowNumber = rowIndex + 1; // grid is 0-based, A1 rows are 1-based
  const updates = [];
  const preview = [];

  record.subjects.forEach(s => {
    const col = colMap.subjectCols[s.code.toUpperCase()];
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
  const currentArrears = record.subjects.filter(s => s.grade === 'U').length;
  if (colMap.currentArrearsCol !== -1) {
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