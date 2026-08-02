#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

function embedJsonSafely(data) {
  return JSON.stringify(data).replace(/[<>]/g, (ch) => (ch === '<' ? '\\u003c' : '\\u003e'));
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function normalizeGroupKey(cwd, homeDir) {
  const normCwd = normalizePath(cwd);
  const normHome = normalizePath(homeDir);
  return normCwd === normHome ? '__misc__' : normCwd;
}

function displayNameForCwd(cwd) {
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(cwd);
}

function escapePowerShellSingleQuoted(str) {
  return String(str).replace(/'/g, "''");
}

function buildResumeCommand(tool, cwd, sessionId) {
  const cmd = tool === 'codex' ? 'codex resume' : 'claude --resume';
  const safeCwd = escapePowerShellSingleQuoted(cwd);
  return `Set-Location -LiteralPath '${safeCwd}'; ${cmd} ${sessionId}`;
}

function parseArgs(argv) {
  return { quiet: argv.includes('--quiet') };
}

// ---------------------------------------------------------------------------
// Shared jsonl reading
// ---------------------------------------------------------------------------
//
// Reads only as many bytes as needed to gather the first `n` parseable lines
// (bounded, chunked reads via a raw file descriptor), instead of loading the
// whole file. Real Codex rollout files run to 10,000+ lines / several MB —
// `fs.readFileSync` followed by `split('\n')` would defeat the spec's "cost
// scales with file count, not file size" requirement.

function pushIfParseable(records, rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return;
  try {
    records.push(JSON.parse(trimmed));
  } catch (err) {
    // Malformed/truncated line (e.g. file was mid-write) — skip it, keep scanning.
  }
}

function readFirstJsonLines(filePath, n) {
  const CHUNK_SIZE = 64 * 1024;
  const fd = fs.openSync(filePath, 'r');
  const records = [];
  try {
    // Accumulate raw bytes (a Buffer), not a string — a chunk boundary can land in the
    // middle of a multi-byte UTF-8 character (e.g. Chinese text), and decoding each 64KB
    // chunk to a string independently would silently corrupt that character into U+FFFD.
    // '\n' is the single-byte ASCII 0x0A, which never appears inside a multi-byte UTF-8
    // sequence, so it's always safe to split on — only call .toString('utf8') on a byte
    // range that ends exactly at a '\n', i.e. a complete line.
    let buffer = Buffer.alloc(0);
    const chunk = Buffer.alloc(CHUNK_SIZE);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, chunk, 0, CHUNK_SIZE, null);
      if (bytesRead > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);

      let newlineIndex;
      while (records.length < n && (newlineIndex = buffer.indexOf(0x0a)) !== -1) {
        pushIfParseable(records, buffer.subarray(0, newlineIndex).toString('utf8'));
        buffer = buffer.subarray(newlineIndex + 1);
      }
    } while (bytesRead > 0 && records.length < n);

    if (records.length < n && buffer.length > 0) {
      pushIfParseable(records, buffer.toString('utf8'));
    }
  } finally {
    fs.closeSync(fd);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Structural fallback for detecting injected/synthetic text
// ---------------------------------------------------------------------------
//
// A prefix whitelist can never be exhaustive — tools and IDEs add new injected
// content formats over time, and each one we haven't seen yet slips through as
// if it were a genuine human message (confirmed on real data: a "# AGENTS.md
// instructions ..." injection block was accepted as a session title because
// its exact prefix wasn't on the list). This adds a second, structural check:
// long text that opens with a markdown heading or an XML-like tag, or contains
// multiple heading lines, is treated as an injected document regardless of its
// specific prefix. The length gate exists so a short genuine message that
// merely starts with "#" or "<" (e.g. a real one-line question about markup)
// isn't wrongly rejected — only long, structurally document-shaped text is
// flagged this way.

const INJECTED_DOCUMENT_MIN_LENGTH = 150;

function looksLikeInjectedDocument(text) {
  if (text.length < INJECTED_DOCUMENT_MIN_LENGTH) return false;
  if (/^[<#]/.test(text)) return true;
  const headingLineCount = (text.match(/^#{1,6}\s/gm) || []).length;
  return headingLineCount >= 2;
}

// ---------------------------------------------------------------------------
// Claude Code title extraction
// ---------------------------------------------------------------------------

const CLAUDE_SYNTHETIC_PREFIXES = [
  '<command-message>',
  '<command-name>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<system-reminder>',
  'Base directory for this skill:',
];

function extractMessageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && item.type === 'text')
      .map((item) => item.text || '')
      .join('\n');
  }
  return '';
}

function isSyntheticClaudeText(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return true;
  if (CLAUDE_SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  return looksLikeInjectedDocument(trimmed);
}

function extractClaudeTitle(records, maxScan = 20) {
  for (const record of records.slice(0, maxScan)) {
    if (record.type !== 'user') continue;
    if (record.isMeta === true) continue;
    const text = extractMessageText(record.message);
    if (isSyntheticClaudeText(text)) continue;
    return text.trim().slice(0, 120);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

function walkJsonlFiles(rootDir, excludeDirNames = []) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirNames.includes(entry.name)) continue;
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

function findClaudeCwdAndBranch(records) {
  for (const record of records) {
    if (typeof record.cwd === 'string') {
      return {
        cwd: record.cwd,
        branch: typeof record.gitBranch === 'string' ? record.gitBranch : null,
      };
    }
  }
  return { cwd: null, branch: null };
}

function scanClaudeCodeFile(filePath, homeDir) {
  const records = readFirstJsonLines(filePath, 20);
  if (records.length === 0) {
    throw new Error(`no parseable JSON records found in ${filePath}`);
  }
  const { cwd, branch } = findClaudeCwdAndBranch(records);
  const effectiveCwd = cwd || homeDir;
  const stat = fs.statSync(filePath);
  const title =
    extractClaudeTitle(records) ||
    `${displayNameForCwd(effectiveCwd)} (${stat.birthtime.toISOString()})`;
  return {
    tool: 'claude-code',
    id: path.basename(filePath, '.jsonl'),
    title,
    cwd: effectiveCwd,
    branch,
    groupKey: normalizeGroupKey(effectiveCwd, homeDir),
    displayName: displayNameForCwd(effectiveCwd),
    startedAt: stat.birthtime.toISOString(),
    lastActiveAt: stat.mtime.toISOString(),
  };
}

function scanClaudeCode(claudeHomeDir, realHomeDir = os.homedir()) {
  const projectsDir = path.join(claudeHomeDir, 'projects');
  const files = walkJsonlFiles(projectsDir, ['subagents']);
  const sessions = [];
  let skipped = 0;
  for (const file of files) {
    try {
      sessions.push(scanClaudeCodeFile(file, realHomeDir));
    } catch (err) {
      skipped += 1;
    }
  }
  return { sessions, skipped };
}

// ---------------------------------------------------------------------------
// Codex adapter — title extraction and index
// ---------------------------------------------------------------------------

const CODEX_SYNTHETIC_PREFIXES = [
  '<environment_context>',
  '<recommended_plugins>',
  '<permissions instructions>',
  '# Context from my IDE setup:',
];

function extractResponseItemText(payload) {
  const content = payload && payload.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && item.type === 'input_text')
    .map((item) => item.text || '')
    .join('\n');
}

function isSyntheticCodexText(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return true;
  if (CODEX_SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  return looksLikeInjectedDocument(trimmed);
}

function extractCodexTitle(records, maxScan = 20) {
  for (const record of records.slice(0, maxScan)) {
    if (record.type !== 'response_item') continue;
    const payload = record.payload;
    if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;
    const text = extractResponseItemText(payload);
    if (isSyntheticCodexText(text)) continue;
    return text.trim().slice(0, 120);
  }
  return null;
}

function loadCodexIndex(indexFilePath) {
  const map = new Map();
  if (!fs.existsSync(indexFilePath)) return map;
  const content = fs.readFileSync(indexFilePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.id === 'string') {
        map.set(obj.id, obj.thread_name);
      }
    } catch (err) {
      // Malformed line — skip it.
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Codex adapter — file and directory scanning
// ---------------------------------------------------------------------------

function scanCodexFile(filePath, indexMap, homeDir) {
  const records = readFirstJsonLines(filePath, 20);
  if (records.length === 0) {
    throw new Error(`no parseable JSON records found in ${filePath}`);
  }
  const metaRecord = records.find((r) => r.type === 'session_meta');
  const payload = (metaRecord && metaRecord.payload) || {};
  const id = payload.id || path.basename(filePath, '.jsonl');
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : homeDir;
  const branch = payload.git && typeof payload.git.branch === 'string' ? payload.git.branch : null;
  const stat = fs.statSync(filePath);

  let title = indexMap.has(id) ? indexMap.get(id) : null;
  if (!title) title = extractCodexTitle(records);
  if (!title) title = `${displayNameForCwd(cwd)} (${stat.birthtime.toISOString()})`;

  return {
    tool: 'codex',
    id,
    title,
    cwd,
    branch,
    groupKey: normalizeGroupKey(cwd, homeDir),
    displayName: displayNameForCwd(cwd),
    startedAt: stat.birthtime.toISOString(),
    lastActiveAt: stat.mtime.toISOString(),
  };
}

function scanCodex(codexHomeDir, realHomeDir = os.homedir()) {
  if (!fs.existsSync(codexHomeDir)) return { sessions: [], skipped: 0 };
  const indexMap = loadCodexIndex(path.join(codexHomeDir, 'session_index.jsonl'));
  const files = [
    ...walkJsonlFiles(path.join(codexHomeDir, 'sessions')),
    ...walkJsonlFiles(path.join(codexHomeDir, 'archived_sessions')),
  ];
  const sessions = [];
  let skipped = 0;
  for (const file of files) {
    try {
      sessions.push(scanCodexFile(file, indexMap, realHomeDir));
    } catch (err) {
      skipped += 1;
    }
  }
  return { sessions, skipped };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------
//
// Claude Code stores a session's jsonl file keyed by the project folder it was
// CURRENTLY running from. When a project folder is moved or copied to a new
// location and the same session is resumed from there, Claude Code writes a
// fresh copy of that session's jsonl file under the new project folder — the
// old copy is left in place, not cleaned up. Confirmed on real data: the same
// session id can physically exist as 2-3 separate files under different
// ~/.claude/projects/<encoded-path>/ folders, each scanned as its own card.
// Collapse entries sharing the same (tool, id) down to one, keeping the copy
// with the latest lastActiveAt (mtime) — on real duplicate files, the
// newest-mtime copy was also the most complete one (more lines), since that's
// the location the session kept being used from.

function dedupeSessions(sessions) {
  const byKey = new Map();
  for (const session of sessions) {
    const key = `${session.tool}:${session.id}`;
    const existing = byKey.get(key);
    if (!existing || new Date(session.lastActiveAt) > new Date(existing.lastActiveAt)) {
      byKey.set(key, session);
    }
  }
  return Array.from(byKey.values());
}

// ---------------------------------------------------------------------------
// HTML dashboard builder
// ---------------------------------------------------------------------------

function buildHtml(sessions, meta = {}) {
  const generatedAt = meta.generatedAt || new Date().toISOString();
  const skippedCount = meta.skippedCount || 0;
  const dataJson = embedJsonSafely({ sessions, generatedAt, skippedCount });

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>Session 管理器</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
  .group-title { font-weight: bold; margin-top: 1.5rem; }
  .group-path { color: #888; font-size: 0.8rem; margin: 0.2rem 0 0.5rem; font-family: monospace; }
  .meta { color: #666; font-size: 0.85rem; }
  button.copy-btn { cursor: pointer; margin-top: 0.4rem; }
  #controls > * { margin-right: 0.5rem; }
</style>
</head>
<body>
<h1>Session 管理器</h1>
<div class="meta" id="generated-meta"></div>
<div id="skipped-warning" class="meta"></div>
<div id="controls">
  <input id="search" placeholder="搜尋標題/路徑">
  <select id="category-filter">
    <option value="all">全部</option>
    <option value="project">專案</option>
    <option value="misc">雜項</option>
  </select>
  <select id="tool-filter">
    <option value="all">全部</option>
    <option value="claude-code">Claude Code</option>
    <option value="codex">Codex</option>
  </select>
  <select id="range-filter">
    <option value="7">7 天</option>
    <option value="30" selected>30 天</option>
    <option value="90">90 天</option>
    <option value="all">全部</option>
  </select>
</div>
<div id="app"></div>
<script>
  var DATA = ${dataJson};
  (function () {
    document.getElementById('generated-meta').textContent = '資料產生時間：' + DATA.generatedAt;
    if (DATA.skippedCount > 0) {
      document.getElementById('skipped-warning').textContent = '已跳過 ' + DATA.skippedCount + ' 個異常檔案';
    }

    function normalize(str) { return (str || '').toLowerCase(); }

    function render() {
      var app = document.getElementById('app');
      app.innerHTML = '';
      var searchTerm = normalize(document.getElementById('search').value);
      var category = document.getElementById('category-filter').value;
      var tool = document.getElementById('tool-filter').value;
      var range = document.getElementById('range-filter').value;
      var now = Date.now();
      var rangeMs = range === 'all' ? Infinity : Number(range) * 24 * 60 * 60 * 1000;

      var filtered = DATA.sessions.filter(function (s) {
        if (tool !== 'all' && s.tool !== tool) return false;
        if (category === 'misc' && s.groupKey !== '__misc__') return false;
        if (category === 'project' && s.groupKey === '__misc__') return false;
        if (searchTerm && normalize(s.title + ' ' + s.cwd).indexOf(searchTerm) === -1) return false;
        var age = now - new Date(s.lastActiveAt).getTime();
        if (age > rangeMs) return false;
        return true;
      });

      filtered.sort(function (a, b) { return new Date(b.lastActiveAt) - new Date(a.lastActiveAt); });

      function renderCard(s) {
        var card = document.createElement('div');
        card.className = 'card';

        var titleEl = document.createElement('div');
        titleEl.textContent = '[' + s.tool + '] ' + s.title;
        card.appendChild(titleEl);

        var metaEl = document.createElement('div');
        metaEl.className = 'meta';
        metaEl.textContent = '最後互動：' + s.lastActiveAt + '　開始：' + s.startedAt + (s.branch ? '　branch：' + s.branch : '');
        card.appendChild(metaEl);

        var btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = '複製續接指令';
        btn.addEventListener('click', function () {
          // Single-quoted PowerShell string, matching buildResumeCommand's escaping in session-dashboard.js:
          // double-quoted strings would let a real folder name containing $ or a backtick corrupt the command.
          var safeCwd = String(s.cwd).replace(/'/g, "''");
          var cmd = "Set-Location -LiteralPath '" + safeCwd + "'; " + (s.tool === 'codex' ? 'codex resume' : 'claude --resume') + ' ' + s.id;
          navigator.clipboard.writeText(cmd);
        });
        card.appendChild(btn);

        app.appendChild(card);
      }

      function mostRecentTime(items) {
        return items.reduce(function (max, s) {
          var t = new Date(s.lastActiveAt).getTime();
          return t > max ? t : max;
        }, 0);
      }

      var groups = new Map();
      filtered.forEach(function (s) {
        if (!groups.has(s.groupKey)) groups.set(s.groupKey, []);
        groups.get(s.groupKey).push(s);
      });

      // Cluster path-groups that share the same project name (e.g. the same project moved or
      // copied across drives over time — a real, observed pattern, not a hypothetical) so they
      // render together under one shared heading instead of looking like unrelated, unexplained
      // duplicate sections. Each sub-block still shows its own real path (address), since that's
      // the only thing that actually distinguishes them from one another.
      var MISC_CLUSTER_KEY = '__misc_cluster__';
      var clusters = new Map();
      groups.forEach(function (items, groupKey) {
        var label = groupKey === '__misc__' ? MISC_CLUSTER_KEY : items[0].displayName;
        if (!clusters.has(label)) clusters.set(label, []);
        clusters.get(label).push(items);
      });

      var clusterEntries = Array.from(clusters.entries());
      clusterEntries.sort(function (a, b) {
        var aRecent = Math.max.apply(null, a[1].map(mostRecentTime));
        var bRecent = Math.max.apply(null, b[1].map(mostRecentTime));
        return bRecent - aRecent;
      });

      clusterEntries.forEach(function (entry) {
        var label = entry[0];
        var subGroups = entry[1];
        subGroups.sort(function (a, b) { return mostRecentTime(b) - mostRecentTime(a); });

        if (label === MISC_CLUSTER_KEY) {
          var miscTitle = document.createElement('div');
          miscTitle.className = 'group-title';
          miscTitle.textContent = '雜項/隨手';
          app.appendChild(miscTitle);
          subGroups.forEach(function (items) { items.forEach(renderCard); });
          return;
        }

        var isClustered = subGroups.length > 1;
        var header = document.createElement('div');
        header.className = 'group-title';
        header.textContent = isClustered ? label + '（' + subGroups.length + ' 個位置）' : label;
        app.appendChild(header);

        subGroups.forEach(function (items) {
          var pathEl = document.createElement('div');
          pathEl.className = 'group-path';
          pathEl.textContent = items[0].cwd;
          app.appendChild(pathEl);
          items.forEach(renderCard);
        });
      });
    }

    document.getElementById('search').addEventListener('input', render);
    document.getElementById('category-filter').addEventListener('change', render);
    document.getElementById('tool-filter').addEventListener('change', render);
    document.getElementById('range-filter').addEventListener('change', render);
    render();
  })();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Atomic write (unique temp file per writer, then rename)
// ---------------------------------------------------------------------------

function writeAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  const uniqueSuffix = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tempPath = path.join(dir, `${path.basename(targetPath)}.${uniqueSuffix}.tmp`);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function defaultOpenBrowser(targetPath) {
  execFile('cmd.exe', ['/c', 'start', '', targetPath]);
}

function main(argv, options = {}) {
  const { quiet } = parseArgs(argv);
  const homeDir = os.homedir();
  const claudeHomeDir = options.claudeHomeDir || path.join(homeDir, '.claude');
  const codexHomeDir = options.codexHomeDir || path.join(homeDir, '.codex');
  const openBrowser = options.openBrowser || defaultOpenBrowser;

  const claudeResult = scanClaudeCode(claudeHomeDir, homeDir);
  const codexResult = scanCodex(codexHomeDir, homeDir);
  const sessions = dedupeSessions([...claudeResult.sessions, ...codexResult.sessions]);
  const skippedCount = claudeResult.skipped + codexResult.skipped;

  const html = buildHtml(sessions, { generatedAt: new Date().toISOString(), skippedCount });
  const targetPath = path.join(claudeHomeDir, 'sessions-dashboard.html');
  writeAtomic(targetPath, html);

  if (!quiet) openBrowser(targetPath);

  return { targetPath, sessionCount: sessions.length, skippedCount };
}

module.exports = {
  escapeHtml,
  embedJsonSafely,
  normalizePath,
  normalizeGroupKey,
  displayNameForCwd,
  escapePowerShellSingleQuoted,
  buildResumeCommand,
  parseArgs,
  readFirstJsonLines,
  extractMessageText,
  isSyntheticClaudeText,
  extractClaudeTitle,
  walkJsonlFiles,
  scanClaudeCodeFile,
  scanClaudeCode,
  extractResponseItemText,
  isSyntheticCodexText,
  extractCodexTitle,
  loadCodexIndex,
  scanCodexFile,
  scanCodex,
  dedupeSessions,
  buildHtml,
  writeAtomic,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2));
}
