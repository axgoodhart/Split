'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateInfographicRequest,
  queryInfographics,
  queryConversations,
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
      // [file, indexInFile, title, create_time] indexed by conversation ordinal
      conversations: [0, 1, 2, 3].map(ordinal => [`conversations-00${ordinal}.json`, 0, `Conversation ${ordinal}`, 1704067200 + ordinal]),
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

test('AND, OR and WITHOUT terms group like the search bar', () => {
  const both = query({ topics: [{ terms: [{ value: 'art' }, { value: 'science', operator: 'AND' }] }], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(both.query.topics[0].label, 'art AND science');
  assert.deepEqual(both.series[0].totals, { messages: 1, mentions: 2, conversations: 1 });

  const either = query({ topics: [{ terms: [{ value: 'cartography' }, { value: 'only', operator: 'OR' }] }], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(either.query.topics[0].label, 'cartography OR only');
  assert.deepEqual(either.series[0].totals, { messages: 2, mentions: 2, conversations: 2 });

  const without = query({ topics: [{ terms: [{ value: 'art' }, { value: 'science', operator: 'WITHOUT' }] }], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(without.query.topics[0].label, 'art WITHOUT science');
  assert.deepEqual(without.series[0].totals, { messages: 1, mentions: 3, conversations: 1 });

  const exclusionOnly = query({ topics: [{ terms: [{ value: 'art', operator: 'WITHOUT' }] }], roles: ['user', 'assistant'], dateRange: {} });
  assert.equal(exclusionOnly.query.topics[0].label, 'WITHOUT art');
  assert.deepEqual(exclusionOnly.series[0].totals, { messages: 2, mentions: 2, conversations: 2 });
});

test('plain string topics and blank terms keep the original semantics', () => {
  const plain = validateInfographicRequest({ topics: ['Art'], roles: ['user'], dateRange: {} });
  const structured = validateInfographicRequest({ topics: [{ terms: [{ value: ' ' }, { value: 'Art', operator: 'OR' }] }], roles: ['user'], dateRange: {} });
  assert.equal(plain.topics[0].label, 'Art');
  assert.equal(structured.topics[0].label, 'Art');
  assert.deepEqual(structured.topics[0].terms, [{ value: 'Art', operator: 'OR' }]);
  assert.equal(validateInfographicRequest({ topics: [{ terms: [{ value: '' }] }], roles: ['user'], dateRange: {} }).isAllActivity, true);
});

test('term limits and unknown operators are INVALID_TOPICS', () => {
  const invalidCases = [
    { topics: [{ terms: Array.from({ length: 9 }, () => ({ value: 'x' })) }], roles: ['user'] },
    { topics: [{ terms: [{ value: 'a' }, { value: 'b', operator: 'OR' }, { value: 'c', operator: 'OR' }, { value: 'd', operator: 'OR' }] }], roles: ['user'] },
    { topics: [{ terms: [{ value: 'a' }, { value: 'b', operator: 'NOT' }] }], roles: ['user'] },
    { topics: [{ terms: 'a' }], roles: ['user'] },
    { topics: [42], roles: ['user'] },
  ];
  for (const request of invalidCases) {
    assert.throws(() => validateInfographicRequest(request), error => error.code === 'INVALID_TOPICS');
  }
});

test('drill-down lists the conversations behind a count, busiest first', () => {
  const all = queryConversations({ topic: 'science', roles: ['user', 'assistant'], dateRange: {} }, cache.text, cache.meta);
  assert.equal(all.query.topic.label, 'science');
  assert.equal(all.meta.totalConversations, 2);
  assert.equal(all.meta.totalMessages, 2);
  assert.deepEqual(all.conversations.map(entry => entry.conversation), [2, 1]);
  assert.deepEqual(all.conversations[0], {
    conversation: 2,
    title: 'Conversation 2',
    file: 'conversations-002.json',
    indexInFile: 0,
    conversationDate: '2023-12-31',
    firstMatchDate: '2024-02-29',
    lastMatchDate: '2024-02-29',
    messages: 1,
    mentions: 1,
  });

  const window = queryConversations({ topic: 'art', roles: ['user', 'assistant'], dateRange: { start: '2024-01-01', end: '2024-01-01' } }, cache.text, cache.meta);
  assert.equal(window.conversations.length, 1);
  assert.equal(window.conversations[0].messages, 1);

  const everything = queryConversations({ topic: null, roles: ['user', 'assistant'], dateRange: {}, limit: 2 }, cache.text, cache.meta);
  assert.equal(everything.query.isAllActivity, true);
  assert.equal(everything.meta.totalConversations, 3);
  assert.equal(everything.meta.returned, 2);
  assert.equal(everything.conversations.length, 2);
});

test('drill-down validates its limit and needs conversation refs', () => {
  assert.throws(() => queryConversations({ topic: 'art', roles: ['user'], dateRange: {}, limit: 0 }, cache.text, cache.meta), error => error.code === 'INVALID_LIMIT');
  const { conversations, ...outdated } = cache.meta;
  assert.throws(() => queryConversations({ topic: 'art', roles: ['user'], dateRange: {} }, cache.text, outdated), error => error.code === 'HISTORYBOT_CACHE_OUTDATED');
});
