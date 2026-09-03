/**
 * Pioneer — Google Form responses Sheet → Customer Survey
 * ═══════════════════════════════════════════════════════════════════
 *
 * Bound to the "Pioneer Customer Feedback Survey (Responses)" spreadsheet
 * rather than to the Form. Two reasons that is the better place for it:
 *
 *   - the header row is right there, so the question wording is read from the
 *     sheet instead of being assumed
 *   - backfilling the responses collected before this existed is just a loop
 *     over the rows
 *
 * No Google credentials are stored on the Pioneer server: the sheet pushes to
 * us, we never read from Google.
 *
 * ── Install (5 minutes, once) ─────────────────────────────────────
 *  1. Open the responses spreadsheet.
 *  2. Extensions → Apps Script.
 *  3. Delete anything in Code.gs and paste this whole file in.
 *  4. Fill in the values in CONFIG below (SPREADSHEET_ID is already set).
 *  5. Save, then Run ▸ `installTrigger`. Approve the permission prompt —
 *     it is asking to "connect to an external service", which is this
 *     script calling the Pioneer API.
 *  6. Run ▸ `testLastRow` and check View → Executions. It should log
 *     "Sent OK".
 *  7. Run ▸ `backfillAll` once to import the responses already collected.
 *
 * After that every new submission arrives in Customer Feedback by itself.
 */

var CONFIG = {
  // Must be reachable from Google's servers — not localhost.
  ENDPOINT: 'https://workshop.pioneeruae.com/api/public/survey/google-form',

  // Must equal GOOGLE_FORM_TOKEN in the backend .env. Treat as a password.
  TOKEN: 'PASTE_THE_GOOGLE_FORM_TOKEN_HERE',

  // Which workshop these responses belong to.
  WORKSHOP_SLUG: 'demo-auto-workshop',

  // The tab holding the form responses. Leave as-is unless it was renamed.
  SHEET_NAME: 'Form_Responses',

  // The responses spreadsheet, taken from its URL:
  //   docs.google.com/spreadsheets/d/<THIS PART>/edit
  // Only needed when this script is a standalone project rather than one
  // opened from the sheet's own Extensions menu. Harmless to set either way,
  // and setting it means the script cannot end up pointing at the wrong file.
  SPREADSHEET_ID: '1hXXg3ZuZ9OB8oqaVorIs7gUMsfjVuATEo5STGl5B8Gw',
};

/**
 * The spreadsheet this script works on.
 *
 * A script opened from Extensions -> Apps Script is bound to the sheet and
 * getActive() works. A standalone project (one created at script.google.com,
 * titled "Untitled project") has no active spreadsheet at all, and every call
 * would fail with a null. Falling back to openById makes both cases work.
 */
function spreadsheet_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActive(); } catch (ignored) {}
  if (ss) return ss;
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID.indexOf('PASTE') === 0) {
    throw new Error('This is a standalone script, so CONFIG.SPREADSHEET_ID must be set.');
  }
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/** Install the on-submit trigger. Safe to run repeatedly. */
function installTrigger() {
  var ss = spreadsheet_();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  Logger.log('Trigger installed on: ' + ss.getName());
}

/**
 * Fires when the Form appends a row.
 *
 * e.namedValues is already a question-title -> answers map, which is exactly
 * the shape the API wants, so nothing has to be inferred from column order —
 * inserting a column in the sheet cannot silently shift the mapping.
 */
function onFormSubmit(e) {
  try {
    if (!e || !e.namedValues) { Logger.log('No namedValues on the event.'); return; }
    var answers = {};
    for (var title in e.namedValues) {
      if (!Object.prototype.hasOwnProperty.call(e.namedValues, title)) continue;
      var v = e.namedValues[title];
      var text = Array.isArray(v) ? v.filter(String).join(', ') : String(v || '');
      if (text !== '') answers[title] = text;
    }
    var row = e.range ? e.range.getRow() : null;
    send(buildPayload(answers, row, answers['Timestamp']));
    retryFailed();
  } catch (err) {
    Logger.log('onFormSubmit failed: ' + err);
    throw err;   // surface it in Executions rather than swallowing it
  }
}

/**
 * The row number is the stable key. A form-responses sheet is append-only, so
 * row N always refers to the same submission — which is what lets the API
 * treat a repeat as an update instead of inflating the averages.
 */
function buildPayload(answers, rowNumber, timestamp) {
  var ssId = spreadsheet_().getId();
  var submitted = null;
  if (timestamp) {
    var d = new Date(timestamp);
    if (!isNaN(d.getTime())) submitted = d.toISOString();
  }
  return {
    workshop: CONFIG.WORKSHOP_SLUG,
    form_id: ssId,
    response_id: 'gsheet:' + ssId.substring(0, 10) + ':row' + (rowNumber || 'x'),
    submitted_at: submitted,
    answers: answers,
  };
}

function send(payload) {
  var res = UrlFetchApp.fetch(CONFIG.ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Pioneer-Token': CONFIG.TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code < 200 || code >= 300) {
    queueForRetry(payload);
    throw new Error('Pioneer returned ' + code + ': ' + body);
  }
  Logger.log('Sent OK (' + payload.response_id + '): ' + body);
}

/* ── Retry ─────────────────────────────────────────────────────────
   A submission that cannot be delivered is parked and retried on the next
   one, so a restart or a network blip does not lose a customer's feedback. */

function queueForRetry(payload) {
  var props = PropertiesService.getScriptProperties();
  var q = JSON.parse(props.getProperty('retry_queue') || '[]');
  if (q.length >= 50) q.shift();
  q.push(payload);
  props.setProperty('retry_queue', JSON.stringify(q));
}

function retryFailed() {
  var props = PropertiesService.getScriptProperties();
  var q = JSON.parse(props.getProperty('retry_queue') || '[]');
  if (!q.length) return;
  var left = [];
  for (var i = 0; i < q.length; i++) {
    try { send(q[i]); } catch (err) { left.push(q[i]); }
  }
  props.setProperty('retry_queue', JSON.stringify(left));
  Logger.log('Retry: ' + (q.length - left.length) + ' sent, ' + left.length + ' pending.');
}

/* ── Reading the sheet directly (test + backfill) ─────────────────── */

function sheet_() {
  var ss = spreadsheet_();
  return ss.getSheetByName(CONFIG.SHEET_NAME) || ss.getSheets()[0];
}

/** Row N of the sheet as a title -> answer map, using row 1 as the headers. */
function rowToAnswers_(headers, values) {
  var answers = {};
  for (var c = 0; c < headers.length; c++) {
    var title = String(headers[c] || '').trim();
    if (!title) continue;
    var cell = values[c];
    if (cell === '' || cell === null || cell === undefined) continue;
    // A Timestamp cell comes back as a Date; send it as ISO so the API can
    // parse it rather than guessing the sheet's locale date format.
    answers[title] = (cell instanceof Date) ? cell.toISOString() : String(cell);
  }
  return answers;
}

/** Send the most recent row, to prove the wiring end to end. */
function testLastRow() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) { Logger.log('No responses in the sheet yet.'); return; }
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var values  = sh.getRange(last, 1, 1, sh.getLastColumn()).getValues()[0];
  var answers = rowToAnswers_(headers, values);
  send(buildPayload(answers, last, answers['Timestamp']));
}

/**
 * Import every response already in the sheet.
 *
 * Safe to run more than once: the API keys on response_id (the row number), so
 * a second run updates the same rows rather than duplicating them.
 */
function backfillAll() {
  var sh = sheet_();
  var last = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (last < 2) { Logger.log('Nothing to backfill.'); return; }

  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var all = sh.getRange(2, 1, last - 1, lastCol).getValues();
  var sent = 0, failed = 0;

  for (var i = 0; i < all.length; i++) {
    var rowNumber = i + 2;                 // sheet rows are 1-based, row 1 is the header
    var answers = rowToAnswers_(headers, all[i]);
    if (!Object.keys(answers).length) continue;
    try { send(buildPayload(answers, rowNumber, answers['Timestamp'])); sent++; }
    catch (err) { failed++; Logger.log('Row ' + rowNumber + ' failed: ' + err); }
    Utilities.sleep(300);                  // stay inside the API rate limit
  }
  Logger.log('Backfill finished: ' + sent + ' sent, ' + failed + ' failed.');
}

/**
 * Print the header row. Run this and paste the output back if any question
 * shows up as "unmapped" in the API's reply — that is the list needed to
 * extend the mapping.
 */
function listHeaders() {
  var sh = sheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    Logger.log((i + 1) + '. ' + headers[i]);
  }
}
