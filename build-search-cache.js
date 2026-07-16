// build-search-cache.js
// One-time extraction of searchable text from conversation JSON files.
//
// Produces search-cache/meta.json  -> [{ file, title, create_time, offset, byteLength }]
//      and search-cache/text.bin   -> concatenated lowercased UTF-8 text, one block per file
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
const TEXT_PATH = path.join(CACHE_DIR, 'text.bin');
const FILE_RE = /^conversations-\d+\.json$/;

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

// Is the existing cache up to date with the JSON directory?
function isCacheFresh() {
  try {
    const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    if (!meta.builtAt || !Array.isArray(meta.files)) return false;
    if (!fs.existsSync(TEXT_PATH)) return false;
    const files = listJsonFiles();
    if (files.length !== meta.files.length) return false;
    const cachedNames = new Set(meta.files.map(f => f.file));
    for (const f of files) {
      if (!cachedNames.has(f)) return false;
      if (fs.statSync(path.join(JSON_DIR, f)).mtimeMs > meta.builtAt) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function buildCache(log = console.log) {
  const started = Date.now();
  const files = listJsonFiles();
  log(`[search-cache] Building cache for ${files.length} files...`);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmpText = TEXT_PATH + '.tmp';
  const out = fs.openSync(tmpText, 'w');
  const metaFiles = [];
  let offset = 0;

  files.forEach((file, i) => {
    let text = '';
    let title = file;
    let create_time = null;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(JSON_DIR, file), 'utf8'));
      const convs = Array.isArray(data) ? data : [data];
      title = (convs[0] && convs[0].title) || file;
      create_time = extractCreateTime(data);
      text = convs.map(extractSearchText).join('\n').toLowerCase();
    } catch (e) {
      log(`[search-cache] WARN: could not parse ${file}: ${e.message}`);
    }
    const buf = Buffer.from(text + '\n', 'utf8'); // trailing \n = block separator
    fs.writeSync(out, buf);
    metaFiles.push({ file, title, create_time, offset, byteLength: buf.length - 1 });
    offset += buf.length;
    if ((i + 1) % 2000 === 0) log(`[search-cache]   ${i + 1}/${files.length}...`);
  });

  fs.closeSync(out);
  fs.renameSync(tmpText, TEXT_PATH);
  fs.writeFileSync(META_PATH, JSON.stringify({ builtAt: Date.now(), files: metaFiles }));
  log(`[search-cache] Done: ${files.length} files, ${(offset / 1e6).toFixed(1)} MB text, ${((Date.now() - started) / 1000).toFixed(1)}s`);
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
  const text = fs.readFileSync(TEXT_PATH); // single Buffer, slices are views (no copies)
  return { meta, text };
}

module.exports = { ensureCache, buildCache, loadCache, isCacheFresh, extractCreateTime };

if (require.main === module) {
  buildCache();
}
