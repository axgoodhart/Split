const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.static(__dirname));
const jsonDirectory = __dirname; // Use the current directory (Split) as the base directory

app.use(express.json());

// Serve static files (e.g., index.html, CSS, JS) from the current directory
app.use(express.static(jsonDirectory));

// Endpoint to list all JSON files
app.get('/list-json-files', (req, res) => {
  fs.readdir(jsonDirectory, (err, files) => {
    if (err) return res.status(500).send('Error reading directory');
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    res.json(jsonFiles.map(file => `/${file}`)); // Adjusted to serve files from the current directory
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

    const jsonFiles = files.filter(file => file.endsWith('.json'));
    let filesProcessed = 0;

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

    jsonFiles.forEach(file => {
      fs.readFile(path.join(jsonDirectory, file), 'utf8', (err, data) => {
        filesProcessed++;

        // Update progress
        const session = searchSessions.get(sessionId);
        if (session) {
          session.processed = filesProcessed;
        }

        if (!err) {
          try {
            const jsonData = JSON.parse(data);

            if (isBoolean) {
              // Boolean search mode
              const booleanMatches = searchJsonBoolean(jsonData, searches, dateRange);
              if (booleanMatches.length > 0) {
                results.push({ file, matches: booleanMatches });
              }
            } else {
              // Simple search mode (backward compatible)
              const matches = searchJson(jsonData, simpleSearchTerm);
              if (matches.length > 0) {
                results.push({ file, matches });
              }
            }
          } catch (e) {
            console.error(`Error parsing JSON in file ${file}:`, e);
          }
        }

        if (filesProcessed === jsonFiles.length) {
          // Mark session as completed
          const session = searchSessions.get(sessionId);
          if (session) {
            session.completed = true;
          }

          res.json({ results, sessionId });

          // Clean up session after 30 seconds
          setTimeout(() => {
            searchSessions.delete(sessionId);
          }, 30000);
        }
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