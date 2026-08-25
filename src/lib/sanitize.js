/**
 * sanitize.js — write-boundary handling for user-supplied text.
 *
 * The primary XSS control is on the read side: the frontend renders untrusted
 * values as React text, and the few places that must build markup as a string
 * (Leaflet popups, the print view) escape every interpolated value via
 * utils/escapeHtml.js. This module is the second layer, at the point of
 * storage.
 *
 * It replaces a hand-rolled blocklist that stripped <script>, <style> and
 * *quoted* on*= attributes. Blocklists lose: of 15 standard payloads it let 9
 * through untouched, including the obvious
 *   <img src=x onerror=alert(1)>
 * because the attribute is unquoted and the tag is not in the list. An
 * allow-list parser (the `xss` package) is used instead — anything it does not
 * recognise is discarded rather than pattern-matched.
 *
 * Which function to use depends on what the field means, because HTML-stripping
 * is not free. Running it over a mechanic's note turns
 *   "Brake pads worn < 2mm, needs replacement"
 * into
 *   "Brake pads worn "
 * — the parser sees "< 2mm, needs replacement" as an unterminated tag and eats
 * it. That is data destruction in exchange for no security benefit, since the
 * field is rendered as text either way. So:
 *
 *   stripMarkup()       short identity fields — names, addresses, phones,
 *                       plates, emails. Markup is never a legitimate value
 *                       there, so discarding it is pure gain.
 *   clampText()         long free-text — notes, descriptions, complaints.
 *                       Stored verbatim; only length and control characters are
 *                       enforced. "< 2mm" survives intact.
 *   sanitizeRichHtml()  the few fields that are deliberately HTML (email
 *                       template bodies, legal pages) and really are rendered
 *                       as markup. Formatting tags are kept; script, style,
 *                       event handlers, iframes and javascript: hrefs are not.
 */

import { FilterXSS } from 'xss';

/** Default cap for free-text fields, matching the widest TEXT column in use. */
const TEXT_MAX = 5000;

// No tags allowed. stripIgnoreTagBody removes the *contents* of script/style
// too, so "<script>alert(1)</script>" leaves nothing behind rather than a bare
// "alert(1)".
const identityFilter = new FilterXSS({
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style', 'noscript', 'iframe', 'object', 'embed'],
});

// A conservative formatting allow-list. No src-bearing tags, so there is no
// <img onerror> surface and no way to make an outbound request.
const richFilter = new FilterXSS({
  whiteList: {
    p: [], br: [], b: [], strong: [], i: [], em: [], u: [], s: [],
    h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
    ul: [], ol: [], li: [], blockquote: [], pre: [], code: [],
    hr: [], span: [], div: [], small: [],
    table: [], thead: [], tbody: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
    a: ['href', 'title', 'target', 'rel'],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script', 'style', 'noscript', 'iframe', 'object', 'embed'],
  onTagAttr(tag, name, value) {
    if (tag === 'a' && name === 'href') {
      // Only ordinary navigable schemes. javascript:, data: and vbscript: are
      // all script execution in an href.
      if (!/^(https?:\/\/|mailto:|tel:|\/)/i.test(String(value).trim())) return '';
    }
  },
});

/** Control characters have no place in a stored string; NUL can truncate. */
function stripControlChars(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Sanitise a short identity field where markup is never legitimate.
 * Returns null for nullish/non-string input so it can be handed straight to a
 * nullable column.
 */
export function stripMarkup(value, max = 255) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return stripControlChars(identityFilter.process(value)).slice(0, max);
}

/**
 * Store long free text verbatim, bounded. No markup stripping — see the note
 * at the top of this file for why.
 */
export function clampText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return stripControlChars(value).slice(0, max);
}

/**
 * Sanitise a field that is allowed to contain formatting HTML.
 */
export function sanitizeRichHtml(value, max = 100000) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return richFilter.process(value).slice(0, max);
}

/**
 * Apply stripMarkup to the named keys of a body object, returning a shallow
 * copy. Keys absent from the body stay absent, so this is safe for PATCH-style
 * partial updates.
 */
export function stripMarkupFields(body, keys, max = 255) {
  const out = { ...body };
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(out, k) && typeof out[k] === 'string') {
      out[k] = stripMarkup(out[k], max);
    }
  }
  return out;
}

/**
 * Apply clampText to the named free-text keys of a body object, returning a
 * shallow copy.
 *
 * Like stripMarkupFields, this only touches keys the body actually contains.
 * That guard matters: the update routes destructure with defaults taken from
 * the existing row, so writing null for an absent key would wipe the stored
 * value instead of leaving it alone.
 */
export function clampTextFields(body, keys, max = TEXT_MAX) {
  const out = { ...body };
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(out, k) && typeof out[k] === 'string') {
      out[k] = clampText(out[k], max);
    }
  }
  return out;
}

export default stripMarkup;
