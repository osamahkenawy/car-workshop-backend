/**
 * Pioneer — Google Form → Customer Survey
 * ═══════════════════════════════════════════════════════════════════
 *
 * Pushes each Google Form response into the workshop the moment it is
 * submitted, so it appears on Customer Feedback with no polling, no export,
 * and no Google credentials stored on the Pioneer server. The Form pushes to
 * us; we never read from Google.
 *
 * ── Install (5 minutes, done once) ────────────────────────────────
 *  1. Open the Form → ⋮ (top right) → "Apps Script".
 *  2. Delete whatever is in Code.gs and paste this whole file in.
 *  3. Edit the two values in CONFIG below.
 *  4. Save (💾).
 *  5. Run ▸ `installTrigger` once. Google will ask for permission to
 *     "connect to an external service" — that is this script calling the
 *     Pioneer API. Approve it.
 *  6. Run ▸ `testConnection` to confirm the workshop answers. Check
 *     "Executions" in the left sidebar to see the result.
 *
 * From then on every submission is sent automatically.
 *
 * ── If something stops working ────────────────────────────────────
 * Apps Script → Executions shows every run and its error. A response that
 * fails is retried by `retryFailed` on the next submission, so a brief
 * outage does not lose data.
 */

var CONFIG = {
  // The Pioneer API. Use the staging/production host, not localhost —
  // Google's servers run this script, so they cannot reach your machine.
  ENDPOINT: 'https://workshop.pioneeruae.com/api/public/survey/google-form',

  // Shared secret. Must match GOOGLE_FORM_TOKEN in the backend .env.
  // Treat it like a password: anyone with it can post survey responses.
  TOKEN: 'PASTE_THE_GOOGLE_FORM_TOKEN_HERE',

  // Which workshop the responses belong to.
  WORKSHOP_SLUG: 'demo-auto-workshop',
};

/** Wire the trigger up. Safe to run more than once — it never doubles up. */
function installTrigger() {
  var form = FormApp.getActiveForm();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'onFormSubmit') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
  Logger.log('Trigger installed for: ' + form.getTitle());
}

/** Fires on every submission. */
function onFormSubmit(e) {
  try {
    var response = e && e.response ? e.response : null;
    if (!response) { Logger.log('No response on the event — nothing to send.'); return; }
    send(buildPayload(response));
    retryFailed();
  } catch (err) {
    Logger.log('onFormSubmit failed: ' + err);
    throw err;   // so it shows up in Executions rather than failing silently
  }
}

/** Turn a form response into the payload the API expects. */
function buildPayload(response) {
  var answers = {};
  var items = response.getItemResponses();
  for (var i = 0; i < items.length; i++) {
    var title = items[i].getItem().getTitle();
    var value = items[i].getResponse();
    // A checkbox question answers with an array; join it so the text survives.
    answers[title] = Array.isArray(value) ? value.join(', ') : value;
  }

  var email = '';
  try { email = response.getRespondentEmail() || ''; } catch (ignored) {}
  if (email && !answers['Email']) answers['Email'] = email;

  return {
    workshop: CONFIG.WORKSHOP_SLUG,
    // Google's own id for this submission. The API keys on it, so a retried
    // trigger updates the existing row instead of double-counting the score.
    response_id: response.getId(),
    form_id: FormApp.getActiveForm().getId(),
    submitted_at: response.getTimestamp().toISOString(),
    answers: answers,
  };
}

/** POST it. Throws on anything that is not a 2xx. */
function send(payload) {
  var res = UrlFetchApp.fetch(CONFIG.ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Pioneer-Token': CONFIG.TOKEN },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,   // read the body instead of a generic failure
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code < 200 || code >= 300) {
    queueForRetry(payload);
    throw new Error('Pioneer returned ' + code + ': ' + body);
  }
  Logger.log('Sent OK: ' + body);
}

/* ── Retry ─────────────────────────────────────────────────────────
   A response that cannot be delivered — the API restarting, a network
   blip — is parked in script properties and retried on the next
   submission, so a short outage does not lose a customer's feedback. */

function queueForRetry(payload) {
  var props = PropertiesService.getScriptProperties();
  var queue = JSON.parse(props.getProperty('retry_queue') || '[]');
  // Bounded: a permanently broken endpoint must not grow this forever.
  if (queue.length >= 50) queue.shift();
  queue.push(payload);
  props.setProperty('retry_queue', JSON.stringify(queue));
}

function retryFailed() {
  var props = PropertiesService.getScriptProperties();
  var queue = JSON.parse(props.getProperty('retry_queue') || '[]');
  if (!queue.length) return;
  var left = [];
  for (var i = 0; i < queue.length; i++) {
    try { send(queue[i]); } catch (err) { left.push(queue[i]); }
  }
  props.setProperty('retry_queue', JSON.stringify(left));
  Logger.log('Retry: ' + (queue.length - left.length) + ' sent, ' + left.length + ' still pending.');
}

/* ── Tools ─────────────────────────────────────────────────────────── */

/** Send the most recent existing response, to prove the wiring works. */
function testConnection() {
  var all = FormApp.getActiveForm().getResponses();
  if (!all.length) { Logger.log('No responses on this form yet.'); return; }
  send(buildPayload(all[all.length - 1]));
}

/**
 * Send every response the Form already holds — for the ones collected before
 * this script existed. Safe to run twice: the API keys on Google's response
 * id, so re-sending updates rather than duplicating.
 */
function backfillAll() {
  var all = FormApp.getActiveForm().getResponses();
  var sent = 0, failed = 0;
  for (var i = 0; i < all.length; i++) {
    try { send(buildPayload(all[i])); sent++; }
    catch (err) { failed++; Logger.log('Backfill failed for #' + (i + 1) + ': ' + err); }
    Utilities.sleep(250);   // stay well inside the API's rate limit
  }
  Logger.log('Backfill finished: ' + sent + ' sent, ' + failed + ' failed.');
}

/** Print the question titles, to check they match what the API maps. */
function listQuestions() {
  var items = FormApp.getActiveForm().getItems();
  for (var i = 0; i < items.length; i++) {
    Logger.log((i + 1) + '. ' + items[i].getTitle());
  }
}
