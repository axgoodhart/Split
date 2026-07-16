'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateInfographicRequest,
  queryInfographics,
  getBucketStart,
  enumerateBucketStarts,
  chooseAutoGranularity,
  countOccurrences,
} = require('../historybot-analytics');

function makeCache(messages) {
  const chunks = [];
  const records = [];
  let offset = 0;
  for (const message of messages) {
    const buffer = Buffer.from(message.text.toLowerCase());
    chunks.push(buffer);
    records.push([offset, buffer.length, message.date, message.role === 'user' ? 'u' : 'a', message.conversation]);
    offset += buffer.length;
  }
  return {
    text: Buffer.concat(chunks),
    meta: {
      builtAt: 1700000000000,
      timezone: 'America/New_York',
      sourceRange: { start: '2023-12-31', end: '2024-03-01' },
      stats: { undatedMessages: 2 },
      records,
    },
  };
}

const cache = makeCache([
  { text: 'Art art cartography', date: '2023-12-31', role: 'user', conversation: 1 },
  { text: 'art and science', date: '2024-01-01', role: 'assistant', conversation: 1 },
  { text: 'science only', date: '2024-02-29', role: 'user', conversation: 2 },
  { text: 'unrelated secret payload', date: '2024-03-01', role: 'assistant', conversation: 3 },
]);

function query(input) {
  return queryInfographics(input, cache.text, cache.meta);
}

test('literal substring counting is case-insensitive and non-overlapping', () => {
  const result = query({ topics: ['ART'], roles: ['user', 'assistant'], dateRange: {} });
  assert.deepEqual(result.series[0].totals, { messages: 2, mentions: 4, conversations: 1 });
  assert.equal(countOccurrences(Buffer.from('aaaa'), Buffer.from('aa')), 2);
});

test('role filters and inclusive dates are applied', () => {
  const user = query({ topics: ['science'], roles: ['user'], dateRange: { start: '2024-02-29', end: '2024-02-29' } });
  assert.equal(user.series[0].totals.messages, 1);
  const assistant = query({ topics: ['science'], roles: ['assistant'], dateRange: {} });
  assert.equal(assistant.series[0].totals.messages, 1);
  const both = query({ topics: ['science'], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(both.series[0].totals.messages, 2);
});

test('Sunday week starts, leap days, months, and years are stable', () => {
  assert.equal(getBucketStart('2024-01-01', 'week'), '2023-12-31');
  assert.equal(getBucketStart('2023-12-31', 'week'), '2023-12-31');
  assert.equal(getBucketStart('2024-02-29', 'month'), '2024-02-01');
  assert.equal(getBucketStart('2024-02-29', 'year'), '2024-01-01');
  assert.deepEqual(enumerateBucketStarts('2024-02-28', '2024-03-01', 'day'), ['2024-02-28', '2024-02-29', '2024-03-01']);
});

test('bucket arrays are chronological and zero-filled around matches', () => {
  const result = query({ topics: ['science'], roles: ['user', 'assistant'], dateRange: { start: '2024-02-27', end: '2024-03-01' } });
  assert.deepEqual(result.series[0].buckets.day.map(bucket => bucket.messages), [0, 0, 1, 0]);
  assert.deepEqual(result.series[0].buckets.day.map(bucket => bucket.start), ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01']);
});

test('conversation counts are unique per bucket and across totals', () => {
  const result = query({ topics: ['art'], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(result.series[0].totals.conversations, 1);
  assert.equal(result.series[0].buckets.week.find(bucket => bucket.start === '2023-12-31').conversations, 1);
});

test('overlapping topics increment independent series', () => {
  const result = query({ topics: ['art', 'cartography'], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(result.series[0].totals.messages, 2);
  assert.equal(result.series[1].totals.messages, 1);
});

test('blank topics create All activity with mentions equal to messages', () => {
  const result = query({ topics: ['  '], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(result.query.isAllActivity, true);
  assert.equal(result.series[0].label, 'All activity');
  assert.equal(result.series[0].totals.messages, 4);
  assert.equal(result.series[0].totals.mentions, 4);
});

test('duplicate topics collapse while preserving the first label', () => {
  const validated = validateInfographicRequest({ topics: ['Art', ' art '], roles: ['user'], dateRange: {} });
  assert.equal(validated.topics.length, 1);
  assert.equal(validated.topics[0].label, 'Art');
});

test('request validation returns stable error codes', () => {
  const invalidCases = [
    [{ topics: ['1', '2', '3', '4', '5', '6'], roles: ['user'] }, 'INVALID_TOPICS'],
    [{ topics: ['x'.repeat(81)], roles: ['user'] }, 'INVALID_TOPICS'],
    [{ topics: [], roles: ['tool'] }, 'INVALID_ROLES'],
    [{ topics: [], roles: ['user'], dateRange: { start: '2024-01-01' } }, 'INVALID_DATE_RANGE'],
    [{ topics: [], roles: ['user'], dateRange: { start: '2024-02-01', end: '2024-01-01' } }, 'INVALID_DATE_RANGE'],
    [{ topics: [], roles: ['user'], dateRange: { start: '2000-01-01', end: '2021-01-01' } }, 'INVALID_DATE_RANGE'],
  ];
  for (const [request, code] of invalidCases) {
    assert.throws(() => validateInfographicRequest(request), error => error.code === code);
  }
});

test('Auto granularity boundaries are inclusive', () => {
  assert.equal(chooseAutoGranularity(120), 'day');
  assert.equal(chooseAutoGranularity(121), 'week');
  assert.equal(chooseAutoGranularity(730), 'week');
  assert.equal(chooseAutoGranularity(731), 'month');
});

test('out-of-source requests return an empty successful result', () => {
  const result = query({ topics: ['art'], roles: ['user'], dateRange: { start: '2025-01-01', end: '2025-01-02' } });
  assert.equal(result.meta.appliedRange, null);
  assert.equal(result.meta.recommendedGranularity, null);
  assert.equal(result.series[0].totals.messages, 0);
  assert.deepEqual(result.series[0].buckets.day, []);
});

test('responses do not expose message text, offsets, or conversation ordinals', () => {
  const serialized = JSON.stringify(query({ topics: ['science'], roles: ['user', 'assistant'], dateRange: {} }));
  assert.doesNotMatch(serialized, /secret payload|"offset"|conversationOrdinal/);
});
