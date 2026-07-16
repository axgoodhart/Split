'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CACHE_SCHEMA_VERSION,
  HISTORYBOT_META_SCHEMA_VERSION,
  RECORD_OFFSET,
  RECORD_LENGTH,
  RECORD_DATE,
  RECORD_ROLE,
  RECORD_CONVERSATION,
  buildFileCacheData,
  extractHistorybotText,
  getMessagesInOrder,
  isCacheMetadataFresh,
} = require('../build-search-cache');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/historybot-branching-conversation.json'), 'utf8'));

test('active branch traversal is ordered and excludes the regenerated sibling', () => {
  const nodes = getMessagesInOrder(fixture[0]);
  assert.deepEqual(nodes.map(node => node.id), ['user-1', 'assistant-current']);
});

test('fallback traversal is used without current_node', () => {
  const nodes = getMessagesInOrder(fixture[1]);
  assert.deepEqual(nodes.map(node => node.id), ['fallback-user', 'fallback-assistant']);
});

test('a parent cycle is rejected without hanging', () => {
  const cyclic = structuredClone(fixture[0]);
  cyclic.mapping.root.parent = 'assistant-current';
  assert.deepEqual(getMessagesInOrder(cyclic), []);
});

test('Historybot text includes literal and audio text but excludes attachments', () => {
  const message = fixture[0].mapping['user-1'].message;
  assert.equal(extractHistorybotText(message), 'art art cartography\nspoken art');
  assert.doesNotMatch(extractHistorybotText(message), /secret-image|attachment label|branch fixture/i);
});

test('every conversation is indexed with exact shared-buffer message slices', () => {
  const startOffset = 37;
  const built = buildFileCacheData(fixture, startOffset, 'America/New_York', 10);
  assert.equal(built.stats.conversations, 2);
  assert.equal(built.stats.messages, 3);
  assert.equal(built.stats.timestampFallbacks, 1);
  assert.equal(built.stats.undatedMessages, 1);
  assert.deepEqual(built.records.map(record => record[RECORD_ROLE]), ['u', 'a', 'a']);
  assert.deepEqual(built.records.map(record => record[RECORD_DATE]), ['2024-01-01', '2023-12-31', '2024-01-03']);
  assert.deepEqual(built.records.map(record => record[RECORD_CONVERSATION]), [10, 10, 11]);
  const expected = ['art art cartography\nspoken art', 'current reply', 'dated fallback'];
  built.records.forEach((record, index) => {
    const relativeStart = record[RECORD_OFFSET] - startOffset;
    assert.equal(built.buffer.subarray(relativeStart, relativeStart + record[RECORD_LENGTH]).toString('utf8'), expected[index]);
  });
  assert.match(built.buffer.toString('utf8'), /hidden regenerated reply/);
  assert.match(built.buffer.toString('utf8'), /system secret/);
});

test('cache freshness rejects schema, timezone, source, or text mismatches', () => {
  const source = { file: 'conversations-001.json', size: 100, mtimeMs: 1000 };
  const meta = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    builtAt: 2000,
    timezone: 'America/New_York',
    textBuildId: 'abc',
    textByteLength: 500,
    sources: [source],
    files: [{ file: source.file }],
  };
  const historyMeta = {
    schemaVersion: HISTORYBOT_META_SCHEMA_VERSION,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    builtAt: 2000,
    timezone: 'America/New_York',
    textBuildId: 'abc',
    textByteLength: 500,
  };
  const fresh = (overrides = {}) => isCacheMetadataFresh(
    { ...meta, ...(overrides.meta || {}) },
    { ...historyMeta, ...(overrides.historyMeta || {}) },
    overrides.sources || [source],
    overrides.timezone || 'America/New_York',
    overrides.header || 'SPLIT_CACHE_V2:abc',
    overrides.size || 500,
  );
  assert.equal(fresh(), true);
  assert.equal(fresh({ meta: { schemaVersion: 1 } }), false);
  assert.equal(fresh({ timezone: 'UTC' }), false);
  assert.equal(fresh({ sources: [{ ...source, size: 101 }] }), false);
  assert.equal(fresh({ sources: [{ ...source, file: 'conversations-002.json' }] }), false);
  assert.equal(fresh({ sources: [source, source] }), false);
  assert.equal(fresh({ sources: [{ ...source, mtimeMs: 3000 }] }), false);
  assert.equal(fresh({ header: 'SPLIT_CACHE_V2:other' }), false);
});
