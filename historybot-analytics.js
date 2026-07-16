'use strict';

const { performance } = require('node:perf_hooks');
const {
  RECORD_OFFSET,
  RECORD_LENGTH,
  RECORD_DATE,
  RECORD_ROLE,
  RECORD_CONVERSATION,
} = require('./build-search-cache');

const GRANULARITIES = ['day', 'week', 'month', 'year'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class HistorybotValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistorybotValidationError';
    this.code = code;
    this.statusCode = 400;
  }
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

function validateInfographicRequest(input = {}) {
  if (!Array.isArray(input.topics)) {
    throw new HistorybotValidationError('INVALID_TOPICS', 'Topics must be provided as a list.');
  }
  if (input.topics.length > 5) {
    throw new HistorybotValidationError('INVALID_TOPICS', 'Choose no more than five topic phrases.');
  }
  const seenTopics = new Set();
  const topics = [];
  for (const value of input.topics) {
    if (typeof value !== 'string') throw new HistorybotValidationError('INVALID_TOPICS', 'Every topic must be text.');
    const label = value.trim();
    if (!label) continue;
    if (label.length > 80) throw new HistorybotValidationError('INVALID_TOPICS', 'Each topic must be 80 characters or fewer.');
    const normalized = label.toLowerCase();
    if (seenTopics.has(normalized)) continue;
    seenTopics.add(normalized);
    topics.push({ id: `topic-${topics.length + 1}`, label, needle: Buffer.from(normalized, 'utf8') });
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

function queryInfographics(input, text, historyMeta) {
  const started = performance.now();
  const validated = validateInfographicRequest(input);
  if (!Buffer.isBuffer(text) || !historyMeta || !Array.isArray(historyMeta.records)) {
    const error = new Error('Historybot cache unavailable.');
    error.code = 'HISTORYBOT_CACHE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  const topics = validated.isAllActivity
    ? [{ id: 'all-activity', label: 'All activity', needle: null }]
    : validated.topics;
  const accumulators = topics.map(makeAccumulator);
  const sourceRange = historyMeta.sourceRange;
  const requestedStart = validated.dateRange.start || sourceRange?.start;
  const requestedEnd = validated.dateRange.end || sourceRange?.end;
  const appliedStart = sourceRange?.start && requestedStart ? (requestedStart > sourceRange.start ? requestedStart : sourceRange.start) : null;
  const appliedEnd = sourceRange?.end && requestedEnd ? (requestedEnd < sourceRange.end ? requestedEnd : sourceRange.end) : null;
  const appliedRange = appliedStart && appliedEnd && appliedStart <= appliedEnd ? { start: appliedStart, end: appliedEnd } : null;
  const allowedRoleCodes = new Set(validated.roles.map(role => role === 'user' ? 'u' : 'a'));
  let eligibleMessages = 0;

  if (appliedRange) {
    for (const record of historyMeta.records) {
      const date = record[RECORD_DATE];
      if (!allowedRoleCodes.has(record[RECORD_ROLE]) || date < appliedRange.start || date > appliedRange.end) continue;
      const offset = record[RECORD_OFFSET];
      const length = record[RECORD_LENGTH];
      if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > text.length) continue;
      eligibleMessages++;
      const slice = text.subarray(offset, offset + length);
      for (const accumulator of accumulators) {
        const occurrences = validated.isAllActivity ? 1 : countOccurrences(slice, accumulator.needle);
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

  const queryTopics = topics.map(({ id, label }) => ({ id, label }));
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
      topics: queryTopics,
    },
    series: accumulators.map(accumulator => materializeSeries(accumulator, appliedRange)),
  };
}

module.exports = {
  HistorybotValidationError,
  validateInfographicRequest,
  queryInfographics,
  getBucketStart,
  enumerateBucketStarts,
  chooseAutoGranularity,
  countOccurrences,
};
