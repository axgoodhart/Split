'use strict';

// Message-level search and context over the in-memory search cache.
// Used by briizOS (Stylofact) to find what Alex has said on a subject.

const { performance } = require('node:perf_hooks');
const {
  RECORD_OFFSET,
  RECORD_LENGTH,
  RECORD_DATE,
  RECORD_ROLE,
  RECORD_CONVERSATION,
  CONVERSATION_FILE,
  CONVERSATION_INDEX,
  CONVERSATION_TITLE,
  CONVERSATION_CREATE_TIME,
} = require('./build-search-cache');

// ==== LIMITS ====
const MAX_QUERIES = 12;          // phrasings per search
const MAX_QUERY_LENGTH = 120;    // characters per phrasing
const DEFAULT_LIMIT = 20;        // messages returned
const MAX_LIMIT = 100;
const MAX_TEXT_CHARS = 4000;     // per returned message; longer text is cut and flagged
const MAX_CONTEXT_SPAN = 5;      // neighbours each side

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ROLES = { user: new Set(['u']), assistant: new Set(['a']), both: new Set(['u', 'a']) };

class MessageSearchError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'MessageSearchError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseCount(value, fallback, min, max, code, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new MessageSearchError(code, `${label} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

function validateSearchRequest(input = {}) {
  if (!Array.isArray(input.queries)) throw new MessageSearchError('INVALID_QUERIES', 'Queries must be provided as a list.');
  if (input.queries.length > MAX_QUERIES) throw new MessageSearchError('INVALID_QUERIES', `Send no more than ${MAX_QUERIES} phrasings.`);
  const seen = new Set();
  const queries = [];
  for (const value of input.queries) {
    if (typeof value !== 'string') throw new MessageSearchError('INVALID_QUERIES', 'Every phrasing must be text.');
    const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!normalized) continue;
    if (normalized.length > MAX_QUERY_LENGTH) throw new MessageSearchError('INVALID_QUERIES', `Each phrasing must be ${MAX_QUERY_LENGTH} characters or fewer.`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    queries.push(normalized);
  }
  if (!queries.length) throw new MessageSearchError('INVALID_QUERIES', 'Send at least one phrasing.');

  const role = input.role === undefined || input.role === null || input.role === '' ? 'user' : input.role;
  if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) throw new MessageSearchError('INVALID_ROLE', 'Role must be user, assistant, or both.');

  const fromAbsent = input.from === undefined || input.from === null || input.from === '';
  const toAbsent = input.to === undefined || input.to === null || input.to === '';
  if (fromAbsent !== toAbsent) throw new MessageSearchError('INVALID_DATE_RANGE', 'Give both a from date and a to date, or neither.');
  let from = null;
  let to = null;
  if (!fromAbsent) {
    if (!isDateOnly(input.from) || !isDateOnly(input.to)) throw new MessageSearchError('INVALID_DATE_RANGE', 'Dates must be YYYY-MM-DD.');
    if (input.from > input.to) throw new MessageSearchError('INVALID_DATE_RANGE', 'The from date must be on or before the to date.');
    from = input.from;
    to = input.to;
  }

  const limit = parseCount(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'INVALID_LIMIT', 'Limit');
  return { queries, role, from, to, limit };
}

function validateContextRequest(input = {}) {
  const conversation = parseCount(input.conversation, null, 0, Number.MAX_SAFE_INTEGER, 'INVALID_CONVERSATION', 'Conversation');
  if (conversation === null) throw new MessageSearchError('INVALID_CONVERSATION', 'Conversation is required.');
  const index = parseCount(input.index, null, 0, Number.MAX_SAFE_INTEGER, 'INVALID_INDEX', 'Index');
  if (index === null) throw new MessageSearchError('INVALID_INDEX', 'Index is required.');
  const before = parseCount(input.before, 1, 0, MAX_CONTEXT_SPAN, 'INVALID_SPAN', 'Before');
  const after = parseCount(input.after, 1, 0, MAX_CONTEXT_SPAN, 'INVALID_SPAN', 'After');
  return { conversation, index, before, after };
}

function ensureCache(text, historyMeta) {
  if (!Buffer.isBuffer(text) || !historyMeta || !Array.isArray(historyMeta.records)) {
    throw new MessageSearchError('MESSAGE_CACHE_UNAVAILABLE', 'Message cache unavailable.', 503);
  }
  if (!Array.isArray(historyMeta.conversations)) {
    throw new MessageSearchError('MESSAGE_CACHE_OUTDATED', "Split's index predates message search. Restart Split to rebuild it.", 503);
  }
}

// Records of one conversation are contiguous and in message order, so a
// conversation is a start index plus a count. Built once per loaded cache.
const conversationSpans = new WeakMap();
function spansFor(historyMeta) {
  let spans = conversationSpans.get(historyMeta);
  if (spans) return spans;
  spans = new Map();
  historyMeta.records.forEach((record, recordIndex) => {
    const ordinal = record[RECORD_CONVERSATION];
    const span = spans.get(ordinal);
    if (span) span.count++;
    else spans.set(ordinal, { start: recordIndex, count: 1 });
  });
  conversationSpans.set(historyMeta, spans);
  return spans;
}

// Binary search: which record holds this byte position? -1 for title/extra text between records.
function recordAt(records, position) {
  let low = 0;
  let high = records.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const record = records[mid];
    if (position < record[RECORD_OFFSET]) high = mid - 1;
    else if (position >= record[RECORD_OFFSET] + record[RECORD_LENGTH]) low = mid + 1;
    else return mid;
  }
  return -1;
}

function dateOnlyFromSeconds(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function describeConversation(ordinal, historyMeta, span) {
  const ref = historyMeta.conversations[ordinal];
  return {
    conversation: ordinal,
    title: ref ? ref[CONVERSATION_TITLE] : '',
    file: ref ? ref[CONVERSATION_FILE] : null,
    indexInFile: ref ? ref[CONVERSATION_INDEX] : null,
    conversationDate: ref ? dateOnlyFromSeconds(ref[CONVERSATION_CREATE_TIME]) : null,
    messageCount: span ? span.count : 0,
  };
}

function messageAt(recordIndex, text, historyMeta, spans) {
  const record = historyMeta.records[recordIndex];
  const ordinal = record[RECORD_CONVERSATION];
  const span = spans.get(ordinal);
  const full = text.subarray(record[RECORD_OFFSET], record[RECORD_OFFSET] + record[RECORD_LENGTH]).toString('utf8');
  return {
    ...describeConversation(ordinal, historyMeta, span),
    index: recordIndex - span.start,
    date: record[RECORD_DATE],
    role: historyMeta.roles?.[record[RECORD_ROLE]] || (record[RECORD_ROLE] === 'u' ? 'user' : 'assistant'),
    text: full.length > MAX_TEXT_CHARS ? full.slice(0, MAX_TEXT_CHARS) : full,
    truncated: full.length > MAX_TEXT_CHARS,
  };
}

function searchMessages(input, text, historyMeta) {
  const started = performance.now();
  const request = validateSearchRequest(input);
  ensureCache(text, historyMeta);
  const { records } = historyMeta;
  const allowedRoles = ROLES[request.role];
  const hits = new Map(); // recordIndex -> Set of query indexes

  request.queries.forEach((query, queryIndex) => {
    const needle = Buffer.from(query, 'utf8');
    let position = 0;
    while (position <= text.length - needle.length) {
      const found = text.indexOf(needle, position);
      if (found === -1) break;
      const recordIndex = recordAt(records, found);
      if (recordIndex === -1) {
        position = found + needle.length;
        continue;
      }
      const record = records[recordIndex];
      position = record[RECORD_OFFSET] + record[RECORD_LENGTH]; // one hit per message per phrasing
      if (!allowedRoles.has(record[RECORD_ROLE])) continue;
      if (request.from && (record[RECORD_DATE] < request.from || record[RECORD_DATE] > request.to)) continue;
      let hit = hits.get(recordIndex);
      if (!hit) hits.set(recordIndex, (hit = new Set()));
      hit.add(queryIndex);
    }
  });

  const ranked = [...hits.entries()]
    .map(([recordIndex, hit]) => ({ recordIndex, score: hit.size, matched: [...hit].sort((a, b) => a - b).map(i => request.queries[i]) }))
    .sort((a, b) => b.score - a.score
      || records[b.recordIndex][RECORD_DATE].localeCompare(records[a.recordIndex][RECORD_DATE])
      || a.recordIndex - b.recordIndex)
    .slice(0, request.limit);
  const spans = spansFor(historyMeta);

  return {
    meta: {
      cacheBuiltAt: new Date(historyMeta.builtAt).toISOString(),
      generatedAt: new Date().toISOString(),
      totalMatches: hits.size,
      returned: ranked.length,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    },
    query: request,
    messages: ranked.map(({ recordIndex, score, matched }) => ({ ...messageAt(recordIndex, text, historyMeta, spans), score, matched })),
  };
}

function messageContext(input, text, historyMeta) {
  const request = validateContextRequest(input);
  ensureCache(text, historyMeta);
  const spans = spansFor(historyMeta);
  const span = spans.get(request.conversation);
  if (!span) throw new MessageSearchError('CONVERSATION_NOT_FOUND', 'No conversation with that number is in the index.', 404);
  if (request.index >= span.count) throw new MessageSearchError('MESSAGE_NOT_FOUND', 'That conversation has no message at that index.', 404);
  const low = Math.max(0, request.index - request.before);
  const high = Math.min(span.count - 1, request.index + request.after);
  const messages = [];
  for (let index = low; index <= high; index++) messages.push(messageAt(span.start + index, text, historyMeta, spans));
  return {
    ...describeConversation(request.conversation, historyMeta, span),
    focus: request.index,
    messages,
  };
}

module.exports = {
  MessageSearchError,
  validateSearchRequest,
  validateContextRequest,
  searchMessages,
  messageContext,
  recordAt,
};
