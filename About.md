# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a conversation viewer application that displays and searches through ChatGPT conversation data. The system consists of three main components:

1. **Python JSON Splitter** (`split.py`) - Splits large JSON files into smaller chunks based on file size
2. **Node.js Backend** (`server.js`) - Express server that serves JSON files and provides search functionality
3. **Frontend Viewer** (`index.html`) - Interactive web interface for viewing and searching conversations

## Architecture

### Data Structure
- JSON files (1.json, 2.json, etc.) contain ChatGPT conversation data with this structure:
  - `title`: Conversation title
  - `create_time`: Unix timestamp
  - `mapping`: Tree structure of conversation messages with IDs, parents, children, and message content
  - Messages have `author.role` (user/assistant/system) and `content.parts` (text content)

### Backend (server.js)
- Express.js server running on port 9002
- Serves static files from current directory; conversation JSONs from `Split New Format/` at `/history/*`
- `/list-json-files` endpoint returns list of JSON files
- `/conversation-index` returns cached {file, title, create_time} for all files (fast sidebar load)
- `/search-json-files` POST endpoint searches via the search cache (see below)

### Search cache (build-search-cache.js)
- At startup, server builds/loads `search-cache/` (meta.json + text.bin): lowercased message text per file, held in RAM as one Buffer
- Searches are native substring scans over Buffer slices (~0.2s) instead of re-parsing all JSON per query
- Cache auto-rebuilds at startup when JSON files change; files added while running are scanned the old slow way until restart
- Accuracy is unchanged: cache text is a superset of what the client matches, and the client still does final per-message filtering

### Frontend (index.html)
- Single-page application with sidebar conversation list and main content viewer
- Real-time search with highlighting of matched terms
- Navigation between search results with arrow buttons
- Responsive design with custom CSS styling
- Handles conversation tree traversal to display messages in chronological order

## Common Commands

### Start the server
```bash
node server.js
```
Server will run on http://localhost:3000

### Split large JSON files
```bash
python3 split.py
```
Interactive script that prompts for:
- Filename to split
- Maximum file size in MB

### View conversations
Open http://localhost:3000 in browser after starting server

## Development Notes

- No build process or package.json - uses vanilla HTML/CSS/JS
- No external dependencies beyond Node.js built-ins (express, fs, path)
- Python script requires Python 3+
- JSON files can be very large (37MB+) - use caution when reading entire files
- Search functionality loads full file content into memory for each search