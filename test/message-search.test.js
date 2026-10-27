'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchMessages, messageContext, recordAt, MessageSearchError } = require('../message-search');

// Mirrors build-search-cache: a title line (no record) before each conversation's messages.
function makeCache(conversations) {
  const chunks = [];
  const records = [];
  const refs = [];
  let offset = 0;
  const append = (value) => {
    const buffer = Buffer.from(`${value}\n`, 'utf8');
    chunks.push(buffer);
    offset += buffer.length;
    return buffer.length;
  };
  conversations.forEach((conversation, ordinal) => {
    refs.push(['conversations-001.json', ordinal, conversation.title, conversation.createTime || null]);
    append(conversation.title.toLowerCase());
    for (const message of conversation.messages) {
      const start = offset;
      const length = append(message.text.toLowerCase()) - 1; // record excludes the newline
      records.push([start, length, message.date, message.role === 'user' ? 'u' : 'a', ordinal]);
    }
  });
  return {
    text: Buffer.concat(chunks),
    meta: {
      schemaVersion: 2,
      builtAt: 1700000000000,
      roles: { u: 'user', a: 'assistant' },
      records,
      conversations: refs,
    },
  };
}

const cache = makeCache([
  {
    title: 'Modal Harmony Notes',
    createTime: 1704067200,
    messages: [
      { text: 'I keep returning to modal harmony as emotional self-help.', date: '2024-01-01', role: 'user' },
      { text: 'Modal harmony can indeed map onto moods.', date: '2024-01-01', role: 'assistant' },
      { text: 'Yes, Dorian feels like hopeful grief to me.', date: '2024-01-02', role: 'user' },
    ],
  },
  {
    title: 'Unrelated Cooking',
    messages: [
      { text: 'How long do I roast a chicken?', date: '2024-02-10', role: 'user' },
    ],
  },
  {
    title: 'Modal Harmony Again',
    messages: [
      { text: 'Still thinking about modal harmony and grief.', date: '2024-03-05', role: 'user' },
    ],
  },
]);

const search = (input) => searchMessages(input, cache.text, cache.meta);
const context = (input) => messageContext(input, cache.text, cache.meta);

test('matches are message-level, case-insensitive, and ranked by how many phrasings hit', () => {
  const result = search({ queries: ['MODAL harmony', 'grief'] });
  assert.equal(result.meta.totalMatches, 3);
  assert.equal(result.messages[0].text, 'still thinking about modal harmony and grief.');
  assert.deepEqual(result.messages[0].matched, ['modal harmony', 'grief']);
  assert.equal(result.messages[0].score, 2);
  assert.equal(result.messages[0].title, 'Modal Harmony Again');
  assert.equal(result.messages[0].conversation, 2);
});

test('title lines never count as a message hit', () => {
  const result = search({ queries: ['cooking'] });
  assert.equal(result.meta.totalMatches, 0);
});

test('role defaults to user; both includes the assistant', () => {
  assert.equal(search({ queries: ['modal harmony'] }).meta.totalMatches, 2);
  assert.equal(search({ queries: ['modal harmony'], role: 'both' }).meta.totalMatches, 3);
  assert.equal(search({ queries: ['modal harmony'], role: 'assistant' }).meta.totalMatches, 1);
});

test('inclusive date range and limit are applied', () => {
  const ranged = search({ queries: ['modal harmony'], role: 'both', from: '2024-01-01', to: '2024-01-01' });
  assert.equal(ranged.meta.totalMatches, 2);
  const limited = search({ queries: ['modal harmony'], role: 'both', limit: 1 });
  assert.equal(limited.messages.length, 1);
  assert.equal(limited.meta.totalMatches, 3);
});

test('a hit carries its position within the conversation', () => {
  const result = search({ queries: ['dorian'] });
  assert.equal(result.messages[0].conversation, 0);
  assert.equal(result.messages[0].index, 2);
  assert.equal(result.messages[0].messageCount, 3);
  assert.equal(result.messages[0].conversationDate, '2024-01-01');
});

test('context returns neighbours within the same conversation', () => {
  const result = context({ conversation: '0', index: '1', before: '1', after: '1' });
  assert.equal(result.title, 'Modal Harmony Notes');
  assert.equal(result.focus, 1);
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'user']);
  const clipped = context({ conversation: 0, index: 0, before: 3, after: 0 });
  assert.equal(clipped.messages.length, 1);
});

test('bad input is rejected with a code', () => {
  assert.throws(() => search({ queries: [] }), (error) => error instanceof MessageSearchError && error.code === 'INVALID_QUERIES');
  assert.throws(() => search({ queries: ['x'], role: 'robot' }), (error) => error.code === 'INVALID_ROLE');
  assert.throws(() => search({ queries: ['x'], from: '2024-01-01' }), (error) => error.code === 'INVALID_DATE_RANGE');
  assert.throws(() => context({ conversation: 9, index: 0 }), (error) => error.code === 'CONVERSATION_NOT_FOUND' && error.statusCode === 404);
  assert.throws(() => context({ conversation: 1, index: 5 }), (error) => error.code === 'MESSAGE_NOT_FOUND');
});

test('an index without conversation references is reported as outdated', () => {
  const stale = { ...cache.meta, conversations: undefined };
  assert.throws(() => searchMessages({ queries: ['modal'] }, cache.text, stale), (error) => error.code === 'MESSAGE_CACHE_OUTDATED' && error.statusCode === 503);
});

test('recordAt finds the record for a byte position and -1 between records', () => {
  const [first] = cache.meta.records;
  assert.equal(recordAt(cache.meta.records, first[0]), 0);
  assert.equal(recordAt(cache.meta.records, first[0] + first[1] - 1), 0);
  assert.equal(recordAt(cache.meta.records, 0), -1); // inside the first title line
});
