'use strict';

const { findTicket } = require('./ticket');

// One naming rule for both sides of the sidebar: an instance and the transcript
// it came from must never show up under two different names.
const MAX = 28;
const URLS = /https?:\/\/\S+/g;
const FIRST_URL = /https?:\/\/[^\s)\]]+/i;

function cut(text, max) {
  const limit = max || MAX;
  return text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text;
}

/** A prompt trimmed down to something that fits a tree row, or null if nothing survives. */
function shortLabel(text, max) {
  const cleaned = String(text || '')
    .replace(URLS, '')
    .replace(/\[Image[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cut(cleaned, max) : null;
}

/**
 * Last resort for a prompt that is nothing but a link: host plus the tail of
 * the path, which at least says which thing was being looked at.
 */
function urlHint(text, max) {
  const m = String(text || '').match(FIRST_URL);
  if (!m) return null;
  const rest = m[0].replace(/[).,]+$/, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const parts = rest.split('/');
  const host = parts.shift().replace(/^www\./i, '');
  const tail = parts.length ? parts[parts.length - 1] : '';
  if (!host) return null;
  return cut(tail ? host + '/' + tail : host, max);
}

/** The name a conversation goes by, derived from its opening prompt. */
function labelFor(text, max) {
  return findTicket(text) || shortLabel(text, max) || urlHint(text, max) || null;
}

module.exports = { labelFor, shortLabel, urlHint, MAX };
