'use strict';

/**
 * Slack's own markup, read by hand. Slack already hands back message text
 * with its literal `&`, `<`, `>` escaped — so `<@U123>` in the API's text is
 * really Slack's own token, not a stray angle bracket — which means the safe
 * order is: HTML-escape the whole string first, exactly as if it were plain
 * text, and only then recognise Slack's tokens in their *escaped* form
 * (`&lt;@U123&gt;` and so on). Anything that is not one of those recognised,
 * escaped shapes — a `<script>` someone typed, a `javascript:` link — stays
 * escaped text and never becomes a tag or a clickable href.
 */

const { applyEmoji } = require('./emoji');

const CODE_FENCE = /```([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+?)`/g;
const MENTION = /&lt;@([A-Z0-9]+)(?:\|([^&]*?))?&gt;/g;
const CHANNEL = /&lt;#([A-Z0-9]+)\|([^&]*?)&gt;/g;
const LINK_LABELLED = /&lt;((?:https?:\/\/|mailto:)[^&|]*)\|([^&]*?)&gt;/g;
const LINK_BARE = /&lt;((?:https?:\/\/|mailto:)[^&]*?)&gt;/g;
const BOLD = /\*([^*\n]+?)\*/g;
const ITALIC = /(^|[^\w])_([^_\n]+?)_(?!\w)/g;
const STRIKE = /~([^~\n]+?)~/g;

/** Escape the four characters that matter, nothing cleverer. */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** `names[id]`, or the id itself if nobody has resolved it. */
function nameFor(names, id) {
  return (names && names[id]) || id;
}

/**
 * Pull out code spans before anything else touches the text, so formatting
 * characters and mentions inside a code block are shown literally rather
 * than interpreted.
 */
function protectCode(escaped) {
  const stash = [];
  const place = (html) => {
    stash.push(html);
    return '\u0000' + (stash.length - 1) + '\u0000';
  };
  let out = escaped.replace(CODE_FENCE, (_, body) => place('<pre><code>' + body.replace(/^\n/, '') + '</code></pre>'));
  out = out.replace(INLINE_CODE, (_, body) => place('<code>' + body + '</code>'));
  return { out, stash };
}

function restoreCode(html, stash) {
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

/** Blockquote lines — `&gt;` at the start of a line, Slack's own convention. */
function blockquotes(text) {
  return text.split('\n').map((line) => {
    const m = /^&gt;\s?(.*)$/.exec(line);
    return m ? '<blockquote>' + m[1] + '</blockquote>' : line;
  }).join('\n');
}

/**
 * @param {string} text   raw text as Slack's API returns it
 * @param {object} [names] user id -> display name
 * @returns {string} safe HTML for a webview
 */
function toHtml(text, names) {
  // Shortcodes become their emoji before anything else touches the text, so
  // an unknown one's underscores survive the markup rules that follow.
  const { out: protectedText, stash } = protectCode(escapeHtml(applyEmoji(text)));
  let html = protectedText
    .replace(MENTION, (_, id, label) => '@' + escapeHtml(label || nameFor(names, id)))
    .replace(CHANNEL, (_, _id, label) => '#' + escapeHtml(label))
    .replace(LINK_LABELLED, (_, url, label) => '<a href="' + url + '">' + label + '</a>')
    .replace(LINK_BARE, (_, url) => '<a href="' + url + '">' + url + '</a>')
    .replace(BOLD, '<strong>$1</strong>')
    .replace(ITALIC, '$1<em>$2</em>')
    .replace(STRIKE, '<del>$1</del>');
  html = blockquotes(html).replace(/\n/g, '<br>');
  html = restoreCode(html, stash);
  return html;
}

/**
 * The same text, flattened for a notification body: mentions resolved, no
 * markup, one line, cut to 140 characters.
 *
 * @param {string} text
 * @param {object} [names]
 */
function toPlain(text, names) {
  // Shortcodes first, same as toHtml, so an unknown one's underscores are
  // never mistaken for italic markup by what follows.
  let plain = applyEmoji(String(text == null ? '' : text))
    .replace(MENTION_RAW, (_, id, label) => '@' + (label || nameFor(names, id)))
    .replace(CHANNEL_RAW, (_, _id, label) => '#' + label)
    .replace(LINK_LABELLED_RAW, (_, _url, label) => label)
    .replace(LINK_BARE_RAW, (_, url) => url)
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+?)`/g, '$1')
    // Only markup's own paired markers are stripped — never a bare
    // underscore, which may belong to a word or an unrecognised shortcode.
    .replace(BOLD_RAW, '$1')
    .replace(ITALIC_RAW, '$1$2')
    .replace(STRIKE_RAW, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  if (plain.length > 140) plain = plain.slice(0, 139).trimEnd() + '…';
  return plain;
}

// Raw (un-escaped) versions of the same tokens, for toPlain, which works
// directly on Slack's text rather than on HTML-escaped text.
const MENTION_RAW = /<@([A-Z0-9]+)(?:\|([^>]*?))?>/g;
const CHANNEL_RAW = /<#([A-Z0-9]+)\|([^>]*?)>/g;
const LINK_LABELLED_RAW = /<((?:https?:\/\/|mailto:)[^|>]*)\|([^>]*?)>/g;
const LINK_BARE_RAW = /<((?:https?:\/\/|mailto:)[^>]*?)>/g;
const BOLD_RAW = /\*([^*\n]+?)\*/g;
const ITALIC_RAW = /(^|[^\w])_([^_\n]+?)_(?!\w)/g;
const STRIKE_RAW = /~([^~\n]+?)~/g;

module.exports = { toHtml, toPlain, escapeHtml };
