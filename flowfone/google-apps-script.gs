/**
 * FlowFone — Google Apps Script web app
 * =====================================
 * Receives Sorter snapshots pushed by flowfone.user.js (running in your
 * logged-in DockFlow tab) and writes them into this spreadsheet so your phone
 * can read live data from the Google Sheets app.
 *
 * SETUP (do this once):
 *   1. Open your Google Sheet → Extensions → Apps Script.
 *   2. Paste this whole file. Set CONFIG.TOKEN below to a secret of your choice.
 *   3. Deploy → New deployment → type "Web app".
 *        - Execute as:      Me
 *        - Who has access:  Anyone
 *      Copy the /exec URL it gives you — paste that into the FlowFone panel.
 *   4. Put the SAME token in the FlowFone panel's "Shared token" box.
 *
 * The script is "container-bound" to the Sheet, so SpreadsheetApp.getActive()
 * targets this exact spreadsheet — no Sheet ID needed.
 */

var CONFIG = {
  // Must match the token entered in the FlowFone userscript panel.
  // Set to '' to disable the check (NOT recommended — the web app is public).
  TOKEN: 'flowfone-secret',

  LIVE_SHEET: 'Live',          // snapshot of the current Sorter table (overwritten each push)
  HISTORY_SHEET: 'History',    // one row per push, for a quick freshness/trend trail
  KEEP_HISTORY: true,
  MAX_HISTORY_ROWS: 5000,      // older history rows are trimmed beyond this
};

// ── In-Sheet helper menu (appears after you reload the Sheet) ─────────────────
// Removes the guesswork: shows the exact URL to paste, creates the tabs, and
// reports whether data is arriving.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('FlowFone')
    .addItem('① Show Web App URL', 'showWebAppUrl')
    .addItem('② Create / reset tabs', 'setupSheets')
    .addItem('③ Connection status', 'showStatus')
    .addToUi();
}

function showWebAppUrl() {
  var ui = SpreadsheetApp.getUi();
  var url = ScriptApp.getService().getUrl();
  if (!url) {
    ui.alert('FlowFone — not deployed yet',
      'Deploy → New deployment → Web app\n' +
      '   • Execute as: Me\n' +
      '   • Who has access: Anyone\n' +
      'then Deploy, approve access, and run this menu item again.',
      ui.ButtonSet.OK);
    return;
  }
  ui.alert('FlowFone — paste this into the panel',
    'Web App URL (must end in /exec):\n\n' + url + '\n\n' +
    'Shared token to enter in the panel:\n' + (CONFIG.TOKEN || '(none — token check is off)'),
    ui.ButtonSet.OK);
}

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(CONFIG.LIVE_SHEET)) ss.insertSheet(CONFIG.LIVE_SHEET);
  if (CONFIG.KEEP_HISTORY && !ss.getSheetByName(CONFIG.HISTORY_SHEET)) {
    ss.insertSheet(CONFIG.HISTORY_SHEET);
  }
  SpreadsheetApp.getUi().alert('FlowFone',
    'Ready. Pushed data lands in the "' + CONFIG.LIVE_SHEET + '" tab — ' +
    'not Sheet1. Check that tab at the bottom of the spreadsheet.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function showStatus() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.LIVE_SHEET);
  var when = sheet ? sheet.getRange(1, 2).getValue() : null;
  ui.alert('FlowFone status',
    'Live tab: ' + (sheet ? 'exists' : 'missing — run ②') + '\n' +
    'Last update received: ' + (when ? when : 'never (nothing pushed yet)') + '\n' +
    'Token required: ' + (CONFIG.TOKEN ? 'yes' : 'no'),
    ui.ButtonSet.OK);
}

// ── POST: receive a snapshot ──────────────────────────────────────────────────
function doPost(e) {
  var out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply(out, { ok: false, error: 'empty body' });
    }
    var body = JSON.parse(e.postData.contents);

    if (CONFIG.TOKEN && String(body.token || '') !== String(CONFIG.TOKEN)) {
      return reply(out, { ok: false, error: 'bad token' });
    }

    var n = writeSnapshot(body);
    if (CONFIG.KEEP_HISTORY) logHistory(body, n);
    return reply(out, { ok: true, rows: n });
  } catch (err) {
    return reply(out, { ok: false, error: String(err) });
  }
}

// ── GET: quick status (open the /exec URL in a browser to test) ───────────────
function doGet() {
  var out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.LIVE_SHEET);
  var lastUpdated = sheet ? sheet.getRange(1, 2).getValue() : null;
  return reply(out, { ok: true, app: 'FlowFone', live: !!sheet, lastUpdated: lastUpdated });
}

// ── Write the current snapshot into the Live sheet ────────────────────────────
function writeSnapshot(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.LIVE_SHEET) || ss.insertSheet(CONFIG.LIVE_SHEET);

  var headers = body.headers || [];
  var rows = body.rows || [];
  var ts = body.capturedAt ? new Date(body.capturedAt) : new Date();
  var width = Math.max(headers.length, 1);

  sheet.clear();

  // Row 1: meta line so you can see freshness at a glance on the phone.
  sheet.getRange(1, 1).setValue('Last updated:');
  sheet.getRange(1, 2).setValue(ts).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange(1, 4).setValue('Source:');
  sheet.getRange(1, 5).setValue(body.source || '');
  sheet.getRange(1, 7).setValue('Rows:');
  sheet.getRange(1, 8).setValue(rows.length);
  sheet.getRange(1, 1, 1, 8).setFontColor('#718096');

  // Row 2: header. Row 3+: data.
  if (headers.length) {
    sheet.getRange(2, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  if (rows.length) {
    var norm = rows.map(function (r) {
      var a = r.slice(0, width);
      while (a.length < width) a.push('');
      return a;
    });
    sheet.getRange(3, 1, norm.length, width).setValues(norm);
  }

  sheet.setFrozenRows(2);
  try { sheet.autoResizeColumns(1, width); } catch (ignore) {}
  return rows.length;
}

// ── Append one row per push to History (freshness / trend trail) ──────────────
function logHistory(body, rowCount) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var h = ss.getSheetByName(CONFIG.HISTORY_SHEET) || ss.insertSheet(CONFIG.HISTORY_SHEET);
  if (h.getLastRow() === 0) {
    h.appendRow(['Timestamp', 'Rows', 'Source']);
    h.setFrozenRows(1);
  }
  var ts = body.capturedAt ? new Date(body.capturedAt) : new Date();
  h.appendRow([ts, rowCount, body.source || '']);

  var extra = h.getLastRow() - (CONFIG.MAX_HISTORY_ROWS + 1);
  if (extra > 0) h.deleteRows(2, extra); // drop oldest, keep header
}

// ── helper ────────────────────────────────────────────────────────────────────
function reply(out, obj) {
  out.setContent(JSON.stringify(obj));
  return out;
}
