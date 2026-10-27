const express = require('express');
const fs = require('fs');
const path = require('path');
const { ensureCache, loadCache } = require('./build-search-cache');
const { queryInfographics } = require('./historybot-analytics');
const { searchMessages, messageContext } = require('./message-search');

const app = express();
app.use('/vendor/echarts', express.static(path.join(__dirname, 'node_modules/echarts/dist')));
app.use(express.static(__dirname));
const jsonDirectory = path.join(__dirname, 'Split New Format');
const jsonRoutePrefix = 'history';

// ==============================
// SEARCH CACHE (see build-search-cache.js)
// Holds lowercased searchable text for every conversation file in one Buffer.
// Searches run as native substring scans over Buffer slices — no JSON parsing.
// Files added after startup are automatically scanned the old (slow) way.
// ==============================
let cache = null; // { meta, text, byName: Map<filename, metaEntry> }
try {
  ensureCache();
  const loaded = loadCache();
  cache = {
    meta: loaded.meta,
    historyMeta: loaded.historyMeta,
    text: loaded.text,
    byName: new Map(loaded.meta.files.map(f => [f.file, f])),
  };
  console.log(`[search-cache] Loaded ${loaded.meta.files.length} files, ${(loaded.text.length / 1e6).toFixed(1)} MB text in memory.`);
} catch (e) {
  console.error('[search-cache] Init failed — falling back to slow search:', e.message);
  cache = null;
}

app.use(express.json());

// Serve static files (e.g., index.html, CSS, JS) from the current directory
app.use(express.static(__dirname));
app.use(`/${jsonRoutePrefix}`, express.static(jsonDirectory));

app.get('/api/historybot/status', (req, res) => {
  if (!cache?.historyMeta) {
    return res.status(503).json({
      ready: false,
      error: {
        code: 'HISTORYBOT_CACHE_UNAVAILABLE',
        message: "Historybot's local index is unavailable. Restart Split to rebuild it.",
      },
    });
  }
  const { historyMeta } = cache;
  res.json({
    ready: true,
    metaSchemaVersion: historyMeta.schemaVersion,
    messageSearch: Array.isArray(historyMeta.conversations), // message-level routes need schema 2+
    timezone: historyMeta.timezone,
    cacheBuiltAt: new Date(historyMeta.builtAt).toISOString(),
    sourceRange: historyMeta.sourceRange,
    stats: {
      conversations: historyMeta.stats.conversations,
      messages: historyMeta.stats.messages,
      undatedMessages: historyMeta.stats.undatedMessages,
    },
  });
});

// ==============================
// MESSAGE SEARCH (see message-search.js)
// Message-level search and context over the same in-memory cache, for briizOS.
// ==============================
function sendMessageSearchError(res, error, fallback) {
  const status = error.statusCode || 500;
  res.status(status).json({
    error: {
      code: error.code || fallback,
      message: status === 500 ? 'Split could not finish this request. Try again.' : error.message,
    },
  });
}

app.post('/api/messages/search', (req, res) => {
  if (!cache?.historyMeta) {
    return res.status(503).json({ error: { code: 'MESSAGE_CACHE_UNAVAILABLE', message: "Split's local index is unavailable. Restart Split to rebuild it." } });
  }
  try {
    res.json(searchMessages(req.body, cache.text, cache.historyMeta));
  } catch (error) {
    sendMessageSearchError(res, error, 'MESSAGE_SEARCH_FAILED');
  }
});

app.get('/api/messages/context', (req, res) => {
  if (!cache?.historyMeta) {
    return res.status(503).json({ error: { code: 'MESSAGE_CACHE_UNAVAILABLE', message: "Split's local index is unavailable. Restart Split to rebuild it." } });
  }
  try {
    res.json(messageContext(req.query, cache.text, cache.historyMeta));
  } catch (error) {
    sendMessageSearchError(res, error, 'MESSAGE_CONTEXT_FAILED');
  }
});

app.post('/api/historybot/infographics', (req, res) => {
  if (!cache?.historyMeta) {
    return res.status(503).json({
      error: {
        code: 'HISTORYBOT_CACHE_UNAVAILABLE',
        message: "Historybot's local index is unavailable. Restart Split to rebuild it.",
      },
    });
  }
  try {
    res.json(queryInfographics(req.body, cache.text, cache.historyMeta));
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({
      error: {
        code: error.code || 'HISTORYBOT_QUERY_FAILED',
        message: status === 500 ? 'Historybot could not finish this infographic. Try again.' : error.message,
      },
    });
  }
});

// Endpoint to list all JSON files
app.get('/list-json-files', (req, res) => {
  fs.readdir(jsonDirectory, (err, files) => {
    if (err) return res.status(500).send('Error reading directory');
    const jsonFiles = files.filter(file => /^conversations-\d+\.json$/.test(file)).sort();
    res.json(jsonFiles.map(file => `${jsonRoutePrefix}/${file}`));
  });
});

// Store active search sessions
const searchSessions = new Map();

// Endpoint to get search progress
app.get('/search-progress/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = searchSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    processed: session.processed,
    total: session.total,
    completed: session.completed
  });
});

// Fast index of all conversations: file, title, create_time (from cache)
app.get('/conversation-index', (req, res) => {
  if (!cache) return res.status(503).json({ error: 'search cache unavailable' });
  res.json(cache.meta.files.map(f => ({
    file: `${jsonRoutePrefix}/${f.file}`,
    title: f.title,
    create_time: f.create_time,
  })));
});

// Precompile boolean search groups into Buffers, replicating the original
// term-skipping semantics exactly (empty values are skipped BEFORE the
// operator check, so client-style WITHOUT terms stay message-level only).
function prepareBooleanGroups(searches) {
  return (searches || []).map(g => {
    const terms = [];
    for (const term of (g.terms || [])) {
      const value = (term.value || '').toLowerCase().trim();
      if (!value) continue; // original behavior: skip empty-value terms entirely
      const operator = (term.operator || 'AND').toUpperCase();
      if (operator === 'AND') {
        terms.push({ op: 'AND', buf: Buffer.from(value, 'utf8') });
      } else if (operator === 'WITHOUT') {
        const excludeValue = (term.exclude || term.value || '').toLowerCase().trim();
        if (excludeValue) terms.push({ op: 'WITHOUT', buf: Buffer.from(excludeValue, 'utf8') });
      }
    }
    return { hasTerms: Array.isArray(g.terms) && g.terms.length > 0, terms };
  });
}

// Match one cached text slice against prepared boolean groups + date range
function matchBooleanSlice(slice, entry, groups, dates) {
  if (dates && entry.create_time) {
    const itemDate = new Date(entry.create_time * 1000);
    if (itemDate < dates.start || itemDate > dates.end) return false;
  }
  for (const g of groups) {
    if (!g.hasTerms) continue;
    let ok = true;
    for (const t of g.terms) {
      const found = slice.includes(t.buf);
      if (t.op === 'AND' ? !found : found) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// Endpoint to search JSON files - supports both simple and boolean search
app.post('/search-json-files', (req, res) => {
  const sessionId = req.body.sessionId || Date.now().toString();
  const results = [];

  // Determine search mode: simple (backward compat) or boolean
  const isBoolean = req.body.searches && Array.isArray(req.body.searches);
  const simpleSearchTerm = req.body.searchTerm ? req.body.searchTerm.toLowerCase() : null;
  const searches = isBoolean ? req.body.searches : null;
  const dateRange = req.body.dateRange || null;

  // If neither simple nor boolean search provided, return empty
  if (!simpleSearchTerm && !isBoolean) {
    return res.json({ results: [], sessionId });
  }

  fs.readdir(jsonDirectory, (err, files) => {
    if (err) return res.status(500).send('Error reading directory');

    const jsonFiles = files.filter(file => /^conversations-\d+\.json$/.test(file)).sort();

    // Initialize search session
    searchSessions.set(sessionId, {
      processed: 0,
      total: jsonFiles.length,
      completed: false
    });

    if (jsonFiles.length === 0) {
      searchSessions.set(sessionId, { processed: 0, total: 0, completed: true });
      return res.json({ results: [], sessionId });
    }

    const finish = () => {
      const session = searchSessions.get(sessionId);
      if (session) session.completed = true;
      res.json({ results, sessionId });
      setTimeout(() => searchSessions.delete(sessionId), 30000);
    };

    // ---- Fast path: scan cached text slices (no JSON parsing) ----
    const uncachedFiles = [];
    let processed = 0;

    if (cache) {
      const groups = isBoolean ? prepareBooleanGroups(searches) : null;
      let dates = null;
      if (isBoolean && dateRange && dateRange.start && dateRange.end) {
        const start = parseDateRange(dateRange.start);
        const end = parseDateRange(dateRange.end);
        if (start && end) dates = { start, end };
      }
      const simpleNeedle = simpleSearchTerm ? Buffer.from(simpleSearchTerm, 'utf8') : null;

      for (const file of jsonFiles) {
        const entry = cache.byName.get(file);
        if (!entry) { uncachedFiles.push(file); continue; }
        const slice = cache.text.subarray(entry.offset, entry.offset + entry.byteLength);
        const matched = isBoolean
          ? matchBooleanSlice(slice, entry, groups, dates)
          : slice.includes(simpleNeedle);
        if (matched) results.push({ file: `${jsonRoutePrefix}/${file}`, matches: ['match'] });
        processed++;
      }
      const session = searchSessions.get(sessionId);
      if (session) session.processed = processed;
    } else {
      uncachedFiles.push(...jsonFiles);
    }

    if (uncachedFiles.length === 0) return finish();

    // ---- Slow path: files not in cache (added since startup) or no cache ----
    let slowProcessed = 0;
    uncachedFiles.forEach(file => {
      fs.readFile(path.join(jsonDirectory, file), 'utf8', (err, data) => {
        slowProcessed++;
        const session = searchSessions.get(sessionId);
        if (session) session.processed = processed + slowProcessed;

        if (!err) {
          try {
            const jsonData = JSON.parse(data);
            if (isBoolean) {
              const booleanMatches = searchJsonBoolean(jsonData, searches, dateRange);
              if (booleanMatches.length > 0) {
                results.push({ file: `${jsonRoutePrefix}/${file}`, matches: booleanMatches });
              }
            } else {
              const matches = searchJson(jsonData, simpleSearchTerm);
              if (matches.length > 0) {
                results.push({ file: `${jsonRoutePrefix}/${file}`, matches });
              }
            }
          } catch (e) {
            console.error(`Error parsing JSON in file ${file}:`, e);
          }
        }

        if (slowProcessed === uncachedFiles.length) finish();
      });
    });
  });
});

// Helper function to search JSON recursively (simple mode - backward compat)
function searchJson(json, searchTerm) {
  const matches = [];
  if (typeof json === 'string' && json.toLowerCase().includes(searchTerm)) {
    matches.push(json);
  } else if (Array.isArray(json)) {
    json.forEach(item => matches.push(...searchJson(item, searchTerm)));
  } else if (typeof json === 'object' && json !== null) {
    Object.values(json).forEach(value => matches.push(...searchJson(value, searchTerm)));
  }
  return matches;
}

// Boolean search: processes multiple OR-separated search groups
// Each search group has terms with operators (AND, WITHOUT)
// Returns matches array (same format as simple search for compatibility)
function searchJsonBoolean(json, searches, dateRange) {
  // Flatten all text from the JSON
  const allText = extractAllText(json);
  const fullText = allText.join(' ').toLowerCase();

  // Check date range filter if provided
  if (dateRange && dateRange.start && dateRange.end) {
    const createTime = extractCreateTime(json);
    if (createTime) {
      const startDate = parseDateRange(dateRange.start);
      const endDate = parseDateRange(dateRange.end);
      if (startDate && endDate) {
        const itemDate = new Date(createTime * 1000);
        if (itemDate < startDate || itemDate > endDate) {
          return []; // Outside date range
        }
      }
    }
  }

  // Process each OR group - if ANY group matches, the file matches
  let anyGroupMatched = false;
  const allMatches = [];

  for (const searchGroup of searches) {
    if (!searchGroup.terms || searchGroup.terms.length === 0) continue;

    let groupMatches = true;

    for (const term of searchGroup.terms) {
      const value = (term.value || '').toLowerCase().trim();
      if (!value) continue;

      const operator = (term.operator || 'AND').toUpperCase();

      if (operator === 'AND') {
        // Must contain this term
        if (!fullText.includes(value)) {
          groupMatches = false;
          break;
        }
      } else if (operator === 'WITHOUT') {
        // Must NOT contain the exclude term
        const excludeValue = (term.exclude || term.value || '').toLowerCase().trim();
        if (excludeValue && fullText.includes(excludeValue)) {
          groupMatches = false;
          break;
        }
      }
    }

    if (groupMatches) {
      anyGroupMatched = true;
      // Collect matching text snippets for this group
      const andTerms = searchGroup.terms
        .filter(t => (t.operator || 'AND').toUpperCase() === 'AND')
        .map(t => (t.value || '').toLowerCase().trim())
        .filter(v => v);

      for (const text of allText) {
        const lower = text.toLowerCase();
        const hasAnyTerm = andTerms.some(term => lower.includes(term));
        if (hasAnyTerm) {
          allMatches.push(text);
        }
      }
    }
  }

  return anyGroupMatched ? (allMatches.length > 0 ? allMatches : ['match']) : [];
}

// Extract all text strings from JSON recursively
function extractAllText(json) {
  const texts = [];
  if (typeof json === 'string') {
    texts.push(json);
  } else if (Array.isArray(json)) {
    json.forEach(item => texts.push(...extractAllText(item)));
  } else if (typeof json === 'object' && json !== null) {
    Object.values(json).forEach(value => texts.push(...extractAllText(value)));
  }
  return texts;
}

// Extract create_time from conversation JSON
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

// Parse date string like "01/01/24" or "01/01/2024" to Date object
function parseDateRange(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  let [month, day, year] = parts.map(p => parseInt(p, 10));
  if (year < 100) year += 2000; // 24 -> 2024
  return new Date(year, month - 1, day);
}
const PORT = 9002;

const server = app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);

server.on('error', (err) => {
  console.error('Server error:', err);
});
