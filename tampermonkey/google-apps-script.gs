/**
 * Dockflow → Google Sheets receiver
 * ---------------------------------
 * Paste this into Extensions → Apps Script on your Google Sheet, then deploy
 * as a Web App (see README.md). The Tampermonkey script POSTs here every minute.
 *
 * Tabs it manages:
 *   Live — always-current snapshot, one row per dock door, color-coded.
 *   Log  — append-only history (the "data log" for handoffs / trend review).
 */

var SHARED_SECRET = "change-me"; // must match SHARED_SECRET in the userscript

// Recirc thresholds for the Live tab status colors (tune to your building)
var RECIRC_RED    = 120; // recirc at/above this → RED
var RECIRC_YELLOW = 90;  // at/above this → YELLOW
var RECIRC_ORANGE = 70;  // at/above this → ORANGE, below → green/no fill

var COLORS = {
  RED:    "#f4cccc",
  YELLOW: "#fff2cc",
  ORANGE: "#fce5cd",
  OK:     "#d9ead3",
};

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ error: "bad json" });
  }

  if (payload.secret !== SHARED_SECRET) {
    return jsonOut({ error: "unauthorized" });
  }

  var rows = payload.rows || [];
  if (!rows.length) return jsonOut({ error: "no rows" });

  var stamp = new Date();
  writeLive(rows, stamp);
  appendLog(rows, stamp);

  return jsonOut({ ok: true, rows: rows.length });
}

// Handy for testing the deployment in a browser
function doGet() {
  return jsonOut({ ok: true, message: "Dockflow receiver is live. POST data here." });
}

// ── Live tab: overwrite with current snapshot ────────────────────────────────

function writeLive(rows, stamp) {
  var sheet = getSheet("Live");
  sheet.clear();

  sheet.getRange(1, 1, 1, 5)
    .setValues([["Dock Door", "Utilization", "Recirc", "Cause", "Last Updated"]])
    .setFontWeight("bold")
    .setBackground("#1a1a2e")
    .setFontColor("#ffffff");

  var timeStr = Utilities.formatDate(stamp, Session.getScriptTimeZone(), "MM/dd HH:mm:ss");
  var values = rows.map(function (r) {
    return [r.door, toNum(r.utilization), toNum(r.recirc), r.cause, timeStr];
  });

  var range = sheet.getRange(2, 1, values.length, 5);
  range.setValues(values);

  // Color each row by recirc severity
  var backgrounds = values.map(function (v) {
    var recirc = v[2];
    var color =
      recirc >= RECIRC_RED    ? COLORS.RED :
      recirc >= RECIRC_YELLOW ? COLORS.YELLOW :
      recirc >= RECIRC_ORANGE ? COLORS.ORANGE :
                                COLORS.OK;
    return [color, color, color, color, color];
  });
  range.setBackgrounds(backgrounds);

  sheet.autoResizeColumns(1, 5);
}

// ── Log tab: append-only history ─────────────────────────────────────────────

function appendLog(rows, stamp) {
  var sheet = getSheet("Log");

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Timestamp", "Dock Door", "Utilization", "Recirc", "Cause"]);
    sheet.getRange(1, 1, 1, 5).setFontWeight("bold");
  }

  var timeStr = Utilities.formatDate(stamp, Session.getScriptTimeZone(), "MM/dd/yyyy HH:mm:ss");
  var values = rows.map(function (r) {
    return [timeStr, r.door, toNum(r.utilization), toNum(r.recirc), r.cause];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, 5).setValues(values);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function toNum(v) {
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? v : n;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
