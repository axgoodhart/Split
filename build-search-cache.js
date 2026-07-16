// build-search-cache.js
// One-time extraction of searchable text from conversation JSON files.
//
// Produces search-cache/meta.json             -> file-level ordinary-search offsets
//          search-cache/historybot-meta.json  -> active-branch message offsets
//          search-cache/text.bin              -> one shared lowercased UTF-8 corpus
//
// Search semantics are preserved exactly: the cache holds a SUPERSET of the text
// the client matches against (title + every message content part), and the client
// still does its own per-message filtering. The cache only decides which files are
// worth sending back — it can never lose a result.
//
// Run manually:  node build-search-cache.js
// (server.js also builds/refreshes it automatically at startup if stale)

const fs = require('fs');
const path = require('path');

const JSON_DIR = path.join(__dirname, 'Split New Format');
const CACHE_DIR = path.join(__dirname, 'search-cache');
const META_PATH = path.join(CACHE_DIR, 'meta.json');
const HISTORYBOT_META_PATH = path.join(CACHE_DIR, 'historybot-meta.json');
const TEXT_PATH = path.join(CACHE_DIR, 'text.bin');
const FILE_RE = /^conversations-\d+\.json$/;
const CACHE_SCHEMA_VERSION = 2;
const HISTORYBOT_META_SCHEMA_VERSION = 1;
const DEFAULT_TIMEZONE = 'America/New_York';
const RECORD_OFFSET = 0;
const RECORD_LENGTH = 1;
const RECORD_DATE = 2;
const RECORD_ROLE = 3;
const RECORD_CONVERSATION = 4;

function listJsonFiles() {
  return fs.readdirSync(JSON_DIR).filter(f => FILE_RE.test(f)).sort();
}

// Extract all message text parts + title from a conversation object.
// Deliberately a superset of the client's getMessageTextParts (includes every
// mapping node, all branches, all content types) so server-stage filtering
// can only over-match, never under-match.
function extractSearchText(conv) {
  const chunks = [];
  if (conv && typeof conv === 'object') {
    if (typeof conv.title === 'string') chunks.push(conv.title);
    const mapping = conv.mapping;
    if (mapping && typeof mapping === 'object') {
      for (const node of Object.values(mapping)) {
        const parts = node?.message?.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (typeof part === 'string') {
            if (part) chunks.push(part);
          } else if (part && typeof part === 'object') {
            // multimodal parts: transcriptions, asset pointers, etc.
            if (typeof part.text === 'string' && part.text) chunks.push(part.text);
            if (typeof part.asset_pointer === 'string') chunks.push(part.asset_pointer);
          }
        }
      }
    }
  }
  return chunks.join('\n');
}

function extractHistorybotText(message) {
  const content = message?.content;
  if (!content || !Array.isArray(content.parts)) return '';
  if (content.content_type && !['text', 'multimodal_text'].includes(content.content_type)) return '';
  const included = [];
  for (const part of content.parts) {
    if (typeof part === 'string') included.push(part);
    else if (part?.content_type === 'audio_transcription' && typeof part.text === 'string') included.push(part.text);
  }
  const text = included.join('\n');
  return text.trim() ? text.toLowerCase() : '';
}

function isDisplayMessage(message) {
  if (!message?.id || !Array.isArray(message.content?.parts) || !message.content.parts.length || !message.author?.role) return false;
  if (message.author.role === 'system' && !message.metadata?.is_user_system_message) return false;
  return message.content.parts.some(part => {
    if (typeof part === 'string') return Boolean(part.trim());
    return Boolean(part?.text?.trim?.() || part?.asset_pointer);
  });
}

function getMessagesInOrder(conversationOrMapping) {
  if (!conversationOrMapping) return [];
  const conversation = conversationOrMapping.mapping ? conversationOrMapping : null;
  const mapping = conversation?.mapping || conversationOrMapping;
  if (!mapping || typeof mapping !== 'object') return [];

  if (conversation?.current_node && mapping[conversation.current_node]) {
    const result = [];
    const seen = new Set();
    let currentNode = conversation.current_node;
    while (currentNode && mapping[currentNode]) {
      if (seen.has(currentNode)) return [];
      seen.add(currentNode);
      if (isDisplayMessage(mapping[currentNode].message)) result.push(mapping[currentNode]);
      currentNode = mapping[currentNode].parent;
    }
    return result.reverse();
  }

  const result = [];
  const seen = new Set();
  const roots = Object.values(mapping).filter(node => node?.parent == null);
  function traverse(node) {
    if (!node || seen.has(node.id)) return;
    if (node.id) seen.add(node.id);
    if (isDisplayMessage(node.message)) result.push(node);
    for (const childId of (node.children || [])) traverse(mapping[childId]);
  }
  roots.forEach(traverse);
  return result;
}

function timestampToLocalDate(timestamp, timezone = DEFAULT_TIMEZONE) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return null;
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function extractActiveSearchExtras(message) {
  const parts = message?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => {
    if (!part || typeof part !== 'object') return '';
    if (part.content_type === 'audio_transcription') return '';
    return [part.text, part.asset_pointer].filter(value => typeof value === 'string' && value).join('\n');
  }).filter(Boolean).join('\n').toLowerCase();
}

function extractOrdinaryMessageText(message) {
  const parts = message?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return [part.text, part.asset_pointer].filter(value => typeof value === 'string' && value).join('\n');
  }).filter(Boolean).join('\n').toLowerCase();
}

function buildFileCacheData(conversations, startOffset = 0, timezone = DEFAULT_TIMEZONE, conversationOrdinalStart = 0) {
  const chunks = [];
  const records = [];
  const stats = { conversations: 0, messages: 0, timestampFallbacks: 0, undatedMessages: 0 };
  let relativeOffset = 0;
  const append = value => {
    if (!value) return;
    const buffer = Buffer.from(`${value}\n`, 'utf8');
    chunks.push(buffer);
    relativeOffset += buffer.length;
  };

  conversations.forEach((conversation, index) => {
    if (!conversation || typeof conversation !== 'object') return;
    const conversationOrdinal = conversationOrdinalStart + stats.conversations;
    stats.conversations++;
    append(typeof conversation.title === 'string' ? conversation.title.toLowerCase() : '');
    const activeNodes = getMessagesInOrder(conversation);
    const activeMessages = new Set(activeNodes.map(node => node?.message).filter(Boolean));

    for (const node of activeNodes) {
      const message = node?.message;
      const role = message?.author?.role;
      if (role !== 'user' && role !== 'assistant') {
        append(extractOrdinaryMessageText(message));
        continue;
      }
      const text = extractHistorybotText(message);
      if (!text) {
        append(extractOrdinaryMessageText(message));
        continue;
      }
      const ownDate = timestampToLocalDate(message.create_time, timezone);
      const date = ownDate || timestampToLocalDate(conversation.create_time, timezone);
      const buffer = Buffer.from(text, 'utf8');
      if (!date) {
        stats.undatedMessages++;
        chunks.push(buffer, Buffer.from('\n'));
        relativeOffset += buffer.length + 1;
        append(extractActiveSearchExtras(message));
        continue;
      }
      if (!ownDate) stats.timestampFallbacks++;
      records.push([
        startOffset + relativeOffset,
        buffer.length,
        date,
        role === 'user' ? 'u' : 'a',
        conversationOrdinal,
      ]);
      chunks.push(buffer, Buffer.from('\n'));
      relativeOffset += buffer.length + 1;
      stats.messages++;
      append(extractActiveSearchExtras(message));
    }

    for (const node of Object.values(conversation.mapping || {})) {
      const message = node?.message;
      if (activeMessages.has(message)) continue;
      const parts = message?.content?.parts;
      if (!Array.isArray(parts)) continue;
      append(extractOrdinaryMessageText(message));
    }
  });

  return { buffer: Buffer.concat(chunks), records, stats };
}

function extractCreateTime(json) {
  if (typeof json !== 'object' || json === null) return null;
  if (json.create_time) return json.create_time;
  if (Array.isArray(json)) {
    for (const item of json) {
      const t = extractCreateTime(item);
      if (t) return t;
    }
  }
  return null;
}

function getSourceFiles() {
  return listJsonFiles().map(file => {
    const stat = fs.statSync(path.join(JSON_DIR, file));
    return { file, size: stat.size, mtimeMs: stat.mtimeMs };
  });
}

function isCacheMetadataFresh(meta, historyMeta, sources, timezone, textHeader, textSize) {
  if (meta?.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (historyMeta?.schemaVersion !== HISTORYBOT_META_SCHEMA_VERSION) return false;
  if (historyMeta.cacheSchemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (!meta.builtAt || meta.builtAt !== historyMeta.builtAt) return false;
  if (historyMeta.timezone !== timezone || meta.timezone !== timezone) return false;
  if (!Array.isArray(meta.files) || !Array.isArray(meta.sources)) return false;
  if (sources.length !== meta.sources.length || sources.length !== meta.files.length) return false;
  if (meta.textBuildId !== historyMeta.textBuildId || textHeader !== `SPLIT_CACHE_V2:${meta.textBuildId}`) return false;
  if (meta.textByteLength !== textSize || historyMeta.textByteLength !== textSize) return false;
  for (let index = 0; index < sources.length; index++) {
    const current = sources[index];
    const cached = meta.sources[index];
    if (current.file !== cached?.file || current.size !== cached.size || current.mtimeMs !== cached.mtimeMs) return false;
    if (current.mtimeMs > meta.builtAt) return false;
  }
  return true;
}

// Is the existing cache up to date with the JSON directory?
function isCacheFresh(timezone = process.env.HISTORYBOT_TIMEZONE || DEFAULT_TIMEZONE) {
  try {
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    const historyMeta = JSON.parse(fs.readFileSync(HISTORYBOT_META_PATH, 'utf8'));
    const textStat = fs.statSync(TEXT_PATH);
    const descriptor = fs.openSync(TEXT_PATH, 'r');
    const headerBuffer = Buffer.alloc(128);
    const bytesRead = fs.readSync(descriptor, headerBuffer, 0, headerBuffer.length, 0);
    fs.closeSync(descriptor);
    const textHeader = headerBuffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
    return isCacheMetadataFresh(meta, historyMeta, getSourceFiles(), timezone, textHeader, textStat.size);
  } catch (e) {
    return false;
  }
}

function buildCache(log = console.log) {
  const started = Date.now();
  const timezone = process.env.HISTORYBOT_TIMEZONE || DEFAULT_TIMEZONE;
  const sources = getSourceFiles();
  log(`[search-cache] Building cache for ${sources.length} files...`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmpText = TEXT_PATH + '.tmp';
  const tmpMeta = META_PATH + '.tmp';
  const tmpHistoryMeta = HISTORYBOT_META_PATH + '.tmp';
  [tmpText, tmpMeta, tmpHistoryMeta].forEach(file => fs.rmSync(file, { force: true }));
  const out = fs.openSync(tmpText, 'w');
  const metaFiles = [];
  const records = [];
  const stats = { conversations: 0, messages: 0, timestampFallbacks: 0, undatedMessages: 0 };
  const textBuildId = `${Date.now()}-${process.pid}`;
  const header = Buffer.from(`SPLIT_CACHE_V2:${textBuildId}\n`, 'utf8');
  fs.writeSync(out, header);
  let offset = header.length;

  sources.forEach((source, i) => {
    const file = source.file;
    let title = file;
    let create_time = null;
    let fileBuffer = Buffer.alloc(0);
    try {
      const data = JSON.parse(fs.readFileSync(path.join(JSON_DIR, file), 'utf8'));
      const convs = Array.isArray(data) ? data : [data];
      title = (convs[0] && convs[0].title) || file;
      create_time = extractCreateTime(data);
      const built = buildFileCacheData(convs, offset, timezone, stats.conversations);
      fileBuffer = built.buffer;
      records.push(...built.records);
      for (const key of Object.keys(stats)) stats[key] += built.stats[key];
    } catch (e) {
      log(`[search-cache] WARN: could not parse ${file}: ${e.message}`);
    }
    fs.writeSync(out, fileBuffer);
    metaFiles.push({ file, title, create_time, offset, byteLength: fileBuffer.length });
    offset += fileBuffer.length;
    if ((i + 1) % 2000 === 0) log(`[search-cache]   ${i + 1}/${sources.length}...`);
  });

  fs.closeSync(out);
  const builtAt = Date.now();
  const sourceRange = records.length ? {
    start: records.reduce((min, record) => record[RECORD_DATE] < min ? record[RECORD_DATE] : min, records[0][RECORD_DATE]),
    end: records.reduce((max, record) => record[RECORD_DATE] > max ? record[RECORD_DATE] : max, records[0][RECORD_DATE]),
  } : { start: null, end: null };
  const shared = { builtAt, timezone, textBuildId, textByteLength: offset };
  const meta = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    ...shared,
    sources,
    files: metaFiles,
  };
  const historyMeta = {
    schemaVersion: HISTORYBOT_META_SCHEMA_VERSION,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    ...shared,
    sourceRange,
    recordLayout: ['offset', 'byteLength', 'date', 'role', 'conversationOrdinal'],
    roles: { u: 'user', a: 'assistant' },
    stats,
    records,
  };
  fs.writeFileSync(tmpMeta, JSON.stringify(meta));
  fs.writeFileSync(tmpHistoryMeta, JSON.stringify(historyMeta));
  const verifiedMeta = JSON.parse(fs.readFileSync(tmpMeta, 'utf8'));
  const verifiedHistory = JSON.parse(fs.readFileSync(tmpHistoryMeta, 'utf8'));
  const temporaryTextSize = fs.statSync(tmpText).size;
  if (verifiedMeta.textByteLength !== temporaryTextSize || verifiedHistory.textByteLength !== temporaryTextSize) {
    throw new Error('Temporary cache size verification failed.');
  }
  for (const record of verifiedHistory.records) {
    if (record[RECORD_OFFSET] < header.length || record[RECORD_OFFSET] + record[RECORD_LENGTH] > temporaryTextSize) {
      throw new Error('Temporary Historybot record range verification failed.');
    }
  }
  fs.renameSync(tmpText, TEXT_PATH);
  fs.renameSync(tmpMeta, META_PATH);
  fs.renameSync(tmpHistoryMeta, HISTORYBOT_META_PATH);
  log(`[search-cache] Done: ${sources.length} files, ${(offset / 1e6).toFixed(1)} MB text, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return metaFiles.length;
}

function ensureCache(log = console.log) {
  if (isCacheFresh()) {
    log('[search-cache] Cache is fresh.');
    return false;
  }
  buildCache(log);
  return true;
}

function loadCache() {
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const historyMeta = JSON.parse(fs.readFileSync(HISTORYBOT_META_PATH, 'utf8'));
  const text = fs.readFileSync(TEXT_PATH); // single Buffer, slices are views (no copies)
  const header = text.subarray(0, Math.min(text.length, 128)).toString('utf8').split('\n', 1)[0];
  if (header !== `SPLIT_CACHE_V2:${meta.textBuildId}` || meta.textBuildId !== historyMeta.textBuildId) {
    throw new Error('Search cache text and metadata do not match.');
  }
  return { meta, historyMeta, text };
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  HISTORYBOT_META_SCHEMA_VERSION,
  RECORD_OFFSET,
  RECORD_LENGTH,
  RECORD_DATE,
  RECORD_ROLE,
  RECORD_CONVERSATION,
  ensureCache,
  buildCache,
  loadCache,
  isCacheFresh,
  isCacheMetadataFresh,
  extractCreateTime,
  extractHistorybotText,
  getMessagesInOrder,
  timestampToLocalDate,
  buildFileCacheData,
};

if (require.main === module) {
  buildCache();
}
