'use strict';

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
  timestampToLocalDate,
} = require('./build-search-cache');

// ==== TOPIC LIMITS ====
const MAX_TOPICS = 5;                 // series per infographic
const MAX_TERMS_PER_TOPIC = 8;        // AND/OR/WITHOUT terms per topic
const MAX_OR_PER_TOPIC = 2;           // same cap as the search bar
const MAX_TERM_LENGTH = 80;           // characters per term
// ==== DRILL-DOWN LIMITS ====
const DEFAULT_CONVERSATION_LIMIT = 100;
const MAX_CONVERSATION_LIMIT = 500;

const OPERATORS = new Set(['AND', 'OR', 'WITHOUT']);
const GRANULARITIES = ['day', 'week', 'month', 'year'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALL_ACTIVITY = { id: 'all-activity', label: 'All activity', groups: null, positives: [], terms: [] };

class HistorybotValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistorybotValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

function invalidTopics(message) {
  return new HistorybotValidationError('INVALID_TOPICS', message);
}

function parseDateOnly(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addUtc(date, unit, amount = 1) {
  const next = new Date(date.getTime());
  if (unit === 'day' || unit === 'week') next.setUTCDate(next.getUTCDate() + amount * (unit === 'week' ? 7 : 1));
  if (unit === 'month') next.setUTCMonth(next.getUTCMonth() + amount);
  if (unit === 'year') next.setUTCFullYear(next.getUTCFullYear() + amount);
  return next;
}

function getBucketStart(dateString, granularity) {
  const date = parseDateOnly(dateString);
  if (!date || !GRANULARITIES.includes(granularity)) throw new Error('Invalid date or granularity.');
  if (granularity === 'week') date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  if (granularity === 'month') date.setUTCDate(1);
  if (granularity === 'year') {
    date.setUTCMonth(0, 1);
  }
  return formatDateOnly(date);
}

function enumerateBucketStarts(start, end, granularity) {
  if (!parseDateOnly(start) || !parseDateOnly(end) || start > end || !GRANULARITIES.includes(granularity)) return [];
  const values = [];
  let cursor = parseDateOnly(getBucketStart(start, granularity));
  while (formatDateOnly(cursor) <= end) {
    values.push(formatDateOnly(cursor));
    cursor = addUtc(cursor, granularity);
  }
  return values;
}

function inclusiveDays(start, end) {
  return Math.floor((parseDateOnly(end) - parseDateOnly(start)) / 86400000) + 1;
}

function chooseAutoGranularity(startOrDays, maybeEnd) {
  const days = typeof startOrDays === 'number' ? startOrDays : inclusiveDays(startOrDays, maybeEnd);
  if (days <= 120) return 'day';
  if (days <= 730) return 'week';
  return 'month';
}

function countOccurrences(haystack, needle) {
  if (!Buffer.isBuffer(haystack) || !Buffer.isBuffer(needle) || needle.length === 0) return 0;
  let count = 0;
  let fromIndex = 0;
  while (fromIndex <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, fromIndex);
    if (found === -1) break;
    count++;
    fromIndex = found + needle.length;
  }
  return count;
}

// A topic is "phrase" or { terms: [{ value, operator }] } in visual order, like the search bar.
// OR starts a new group; a message matches when any group has every AND term and no WITHOUT term.
// Returns null for a blank topic.
function normalizeTopic(value) {
  const rawTerms = typeof value === 'string' ? [{ value }] : value?.terms;
  if (!Array.isArray(rawTerms)) throw invalidTopics('Every topic must be text or a list of terms.');
  if (rawTerms.length > MAX_TERMS_PER_TOPIC) throw invalidTopics(`Use no more than ${MAX_TERMS_PER_TOPIC} terms per topic.`);
  const groups = [];
  const terms = [];
  const labelParts = [];
  let group = { and: [], without: [] };
  for (const term of rawTerms) {
    if (!term || typeof term.value !== 'string') throw invalidTopics('Every term must be text.');
    const operator = String(term.operator || 'AND').toUpperCase();
    if (!OPERATORS.has(operator)) throw invalidTopics('Term operators must be AND, OR, or WITHOUT.');
    const text = term.value.trim();
    if (!text) continue; // blank terms are skipped, like the search bar
    if (text.length > MAX_TERM_LENGTH) throw invalidTopics(`Each term must be ${MAX_TERM_LENGTH} characters or fewer.`);
    if (operator === 'OR' && (group.and.length || group.without.length)) {
      if (groups.length >= MAX_OR_PER_TOPIC) throw invalidTopics(`Use no more than ${MAX_OR_PER_TOPIC} OR operators per topic.`);
      groups.push(group);
      group = { and: [], without: [] };
    }
    (operator === 'WITHOUT' ? group.without : group.and).push(Buffer.from(text.toLowerCase(), 'utf8'));
    terms.push({ value: text, operator });
    labelParts.push(labelParts.length || operator === 'WITHOUT' ? `${operator} ${text}` : text);
  }
  if (group.and.length || group.without.length) groups.push(group);
  if (!groups.length) return null;
  const positives = [...new Map(groups.flatMap(g => g.and).map(needle => [needle.toString('utf8'), needle])).values()];
  return { label: labelParts.join(' '), terms, groups, positives };
}

// Mentions of the topic's positive terms in one message, or 0 when the message does not match.
// A matching message with no positive terms (WITHOUT-only) counts as one mention.
function matchTopic(slice, topic) {
  const matched = topic.groups.some(group =>
    group.and.every(needle => slice.includes(needle)) && !group.without.some(needle => slice.includes(needle)));
  if (!matched) return 0;
  let mentions = 0;
  for (const needle of topic.positives) mentions += countOccurrences(slice, needle);
  return Math.max(1, mentions);
}

function validateInfographicRequest(input = {}) {
  if (!Array.isArray(input.topics)) {
    throw invalidTopics('Topics must be provided as a list.');
  }
  if (input.topics.length > MAX_TOPICS) {
    throw invalidTopics(`Choose no more than ${MAX_TOPICS} topic phrases.`);
  }
  const seenTopics = new Set();
  const topics = [];
  for (const value of input.topics) {
    const topic = normalizeTopic(value);
    if (!topic) continue;
    const normalized = topic.label.toLowerCase();
    if (seenTopics.has(normalized)) continue;
    seenTopics.add(normalized);
    topics.push({ id: `topic-${topics.length + 1}`, ...topic });
  }

  if (!Array.isArray(input.roles)) {
    throw new HistorybotValidationError('INVALID_ROLES', 'Choose Both, You, or Assistant.');
  }
  const roleSet = new Set(input.roles);
  if (roleSet.size !== input.roles.length || [...roleSet].some(role => role !== 'user' && role !== 'assistant') || roleSet.size === 0) {
    throw new HistorybotValidationError('INVALID_ROLES', 'Choose Both, You, or Assistant.');
  }
  const roles = ['user', 'assistant'].filter(role => roleSet.has(role));

  const range = input.dateRange || {};
  const startAbsent = range.start === null || range.start === undefined || range.start === '';
  const endAbsent = range.end === null || range.end === undefined || range.end === '';
  let dateRange = { start: null, end: null };
  if (startAbsent !== endAbsent) {
    throw new HistorybotValidationError('INVALID_DATE_RANGE', 'Choose both a start date and an end date.');
  }
  if (!startAbsent) {
    if (!parseDateOnly(range.start) || !parseDateOnly(range.end)) {
      throw new HistorybotValidationError('INVALID_DATE_RANGE', 'Enter valid dates in YYYY-MM-DD format.');
    }
    if (range.start > range.end) {
      throw new HistorybotValidationError('INVALID_DATE_RANGE', 'The start date must be on or before the end date.');
    }
    const span = inclusiveDays(range.start, range.end);
    if (span > 20 * 366) {
      throw new HistorybotValidationError('INVALID_DATE_RANGE', 'Choose a date range of 20 years or less.');
    }
    dateRange = { start: range.start, end: range.end };
  }
  return { topics, roles, dateRange, isAllActivity: topics.length === 0 };
}

function ensureHistoryCache(text, historyMeta) {
  if (!Buffer.isBuffer(text) || !historyMeta || !Array.isArray(historyMeta.records)) {
    const error = new Error('Historybot cache unavailable.');
    error.code = 'HISTORYBOT_CACHE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
}

// Intersect the requested range with the cache's source range; null when they do not overlap.
function resolveAppliedRange(dateRange, sourceRange) {
  const requestedStart = dateRange.start || sourceRange?.start;
  const requestedEnd = dateRange.end || sourceRange?.end;
  const appliedStart = sourceRange?.start && requestedStart ? (requestedStart > sourceRange.start ? requestedStart : sourceRange.start) : null;
  const appliedEnd = sourceRange?.end && requestedEnd ? (requestedEnd < sourceRange.end ? requestedEnd : sourceRange.end) : null;
  return appliedStart && appliedEnd && appliedStart <= appliedEnd ? { start: appliedStart, end: appliedEnd } : null;
}

function roleCodes(roles) {
  return new Set(roles.map(role => role === 'user' ? 'u' : 'a'));
}

function recordSlice(record, text) {
  const offset = record[RECORD_OFFSET];
  const length = record[RECORD_LENGTH];
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > text.length) return null;
  return text.subarray(offset, offset + length);
}

function makeAccumulator(topic) {
  return {
    ...topic,
    totals: { messages: 0, mentions: 0, conversations: new Set() },
    buckets: Object.fromEntries(GRANULARITIES.map(granularity => [granularity, new Map()])),
  };
}

function incrementBucket(map, key, occurrences, conversationOrdinal) {
  if (!map.has(key)) map.set(key, { messages: 0, mentions: 0, conversations: new Set() });
  const bucket = map.get(key);
  bucket.messages++;
  bucket.mentions += occurrences;
  bucket.conversations.add(conversationOrdinal);
}

function materializeSeries(accumulator, appliedRange) {
  const buckets = {};
  for (const granularity of GRANULARITIES) {
    buckets[granularity] = appliedRange ? enumerateBucketStarts(appliedRange.start, appliedRange.end, granularity).map(start => {
      const value = accumulator.buckets[granularity].get(start);
      return {
        start,
        messages: value?.messages || 0,
        mentions: value?.mentions || 0,
        conversations: value?.conversations.size || 0,
      };
    }) : [];
  }
  return {
    id: accumulator.id,
    label: accumulator.label,
    totals: {
      messages: accumulator.totals.messages,
      mentions: accumulator.totals.mentions,
      conversations: accumulator.totals.conversations.size,
    },
    buckets,
  };
}

function publicTopic({ id, label, terms }) {
  return { id, label, terms };
}

function queryInfographics(input, text, historyMeta) {
  const started = performance.now();
  const validated = validateInfographicRequest(input);
  ensureHistoryCache(text, historyMeta);
  const topics = validated.isAllActivity ? [ALL_ACTIVITY] : validated.topics;
  const accumulators = topics.map(makeAccumulator);
  const sourceRange = historyMeta.sourceRange;
  const appliedRange = resolveAppliedRange(validated.dateRange, sourceRange);
  const allowedRoleCodes = roleCodes(validated.roles);
  let eligibleMessages = 0;

  if (appliedRange) {
    for (const record of historyMeta.records) {
      const date = record[RECORD_DATE];
      if (!allowedRoleCodes.has(record[RECORD_ROLE]) || date < appliedRange.start || date > appliedRange.end) continue;
      const slice = recordSlice(record, text);
      if (!slice) continue;
      eligibleMessages++;
      for (const accumulator of accumulators) {
        const occurrences = validated.isAllActivity ? 1 : matchTopic(slice, accumulator);
        if (!occurrences) continue;
        accumulator.totals.messages++;
        accumulator.totals.mentions += occurrences;
        accumulator.totals.conversations.add(record[RECORD_CONVERSATION]);
        for (const granularity of GRANULARITIES) {
          incrementBucket(accumulator.buckets[granularity], getBucketStart(date, granularity), occurrences, record[RECORD_CONVERSATION]);
        }
      }
    }
  }

  return {
    meta: {
      timezone: historyMeta.timezone,
      cacheBuiltAt: new Date(historyMeta.builtAt).toISOString(),
      generatedAt: new Date().toISOString(),
      sourceRange,
      appliedRange,
      recommendedGranularity: appliedRange ? chooseAutoGranularity(appliedRange.start, appliedRange.end) : null,
      eligibleMessages,
      excludedUndatedMessages: historyMeta.stats?.undatedMessages || 0,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    },
    query: {
      roles: validated.roles,
      isAllActivity: validated.isAllActivity,
      topics: topics.map(publicTopic),
    },
    series: accumulators.map(accumulator => materializeSeries(accumulator, appliedRange)),
  };
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CONVERSATION_LIMIT;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_CONVERSATION_LIMIT) {
    throw new HistorybotValidationError('INVALID_LIMIT', `Limit must be a whole number from 1 to ${MAX_CONVERSATION_LIMIT}.`);
  }
  return number;
}

// Drill-down: the conversations behind one topic's count in a date window.
// input: { topic: "phrase" | { terms } | null, roles, dateRange: { start, end }, limit }
function queryConversations(input = {}, text, historyMeta) {
  const started = performance.now();
  const validated = validateInfographicRequest({ ...input, topics: input.topic == null ? [] : [input.topic] });
  const limit = parseLimit(input.limit);
  ensureHistoryCache(text, historyMeta);
  if (!Array.isArray(historyMeta.conversations)) {
    const error = new Error("Historybot's index predates conversation lists. Restart Split to rebuild it.");
    error.code = 'HISTORYBOT_CACHE_OUTDATED';
    error.statusCode = 503;
    throw error;
  }
  const topic = validated.isAllActivity ? ALL_ACTIVITY : validated.topics[0];
  const appliedRange = resolveAppliedRange(validated.dateRange, historyMeta.sourceRange);
  const allowedRoleCodes = roleCodes(validated.roles);
  const hits = new Map(); // conversation ordinal -> { messages, mentions, first, last }
  let totalMessages = 0;
  let totalMentions = 0;

  if (appliedRange) {
    for (const record of historyMeta.records) {
      const date = record[RECORD_DATE];
      if (!allowedRoleCodes.has(record[RECORD_ROLE]) || date < appliedRange.start || date > appliedRange.end) continue;
      const slice = recordSlice(record, text);
      if (!slice) continue;
      const occurrences = validated.isAllActivity ? 1 : matchTopic(slice, topic);
      if (!occurrences) continue;
      totalMessages++;
      totalMentions += occurrences;
      const ordinal = record[RECORD_CONVERSATION];
      let hit = hits.get(ordinal);
      if (!hit) hits.set(ordinal, (hit = { messages: 0, mentions: 0, first: date, last: date }));
      hit.messages++;
      hit.mentions += occurrences;
      if (date < hit.first) hit.first = date;
      if (date > hit.last) hit.last = date;
    }
  }

  const conversations = [...hits.entries()].map(([ordinal, hit]) => {
    const ref = historyMeta.conversations[ordinal] || [];
    const createTime = ref[CONVERSATION_CREATE_TIME];
    return {
      conversation: ordinal,
      title: typeof ref[CONVERSATION_TITLE] === 'string' ? ref[CONVERSATION_TITLE] : '',
      file: ref[CONVERSATION_FILE] || null,
      indexInFile: Number.isInteger(ref[CONVERSATION_INDEX]) ? ref[CONVERSATION_INDEX] : null,
      conversationDate: Number.isFinite(createTime) ? timestampToLocalDate(createTime, historyMeta.timezone) : null,
      firstMatchDate: hit.first,
      lastMatchDate: hit.last,
      messages: hit.messages,
      mentions: hit.mentions,
    };
  }).sort((a, b) => b.messages - a.messages || b.lastMatchDate.localeCompare(a.lastMatchDate) || a.conversation - b.conversation);

  return {
    meta: {
      timezone: historyMeta.timezone,
      generatedAt: new Date().toISOString(),
      appliedRange,
      totalConversations: hits.size,
      totalMessages,
      totalMentions,
      returned: Math.min(limit, conversations.length),
      limit,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    },
    query: {
      roles: validated.roles,
      isAllActivity: validated.isAllActivity,
      topic: publicTopic(topic),
    },
    conversations: conversations.slice(0, limit),
  };
}

module.exports = {
  HistorybotValidationError,
  validateInfographicRequest,
  normalizeTopic,
  matchTopic,
  queryInfographics,
  queryConversations,
  getBucketStart,
  enumerateBucketStarts,
  chooseAutoGranularity,
  countOccurrences,
};
