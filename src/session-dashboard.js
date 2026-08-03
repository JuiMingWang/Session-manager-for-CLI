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

function readLastJsonLines(filePath, n) {
  const CHUNK_SIZE = 64 * 1024;
  const fd = fs.openSync(filePath, 'r');
  const records = [];
  try {
    // Mirror image of readFirstJsonLines: read fixed-size chunks backward from EOF, each new
    // chunk PREPENDED to the accumulated raw Buffer (so the buffer's tail always stays pinned
    // to a confirmed boundary — the true EOF at first, then a confirmed '\n' after that).
    // A line is only decoded once bounded by a '\n' on both sides (or the true start/end of
    // file), so a multi-byte UTF-8 character split across two backward reads is never decoded
    // until both halves have been read and joined — same corruption hazard as the forward
    // reader, mirrored.
    let buffer = Buffer.alloc(0);
    let position = fs.fstatSync(fd).size;
    const chunk = Buffer.alloc(CHUNK_SIZE);
    do {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const bytesRead = fs.readSync(fd, chunk, 0, readSize, position);
      if (bytesRead > 0) buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer]);

      let newlineIndex;
      while (records.length < n && (newlineIndex = buffer.lastIndexOf(0x0a)) !== -1) {
        pushIfParseable(records, buffer.subarray(newlineIndex + 1).toString('utf8'));
        buffer = buffer.subarray(0, newlineIndex);
      }
    } while (position > 0 && records.length < n);

    if (records.length < n && buffer.length > 0) {
      pushIfParseable(records, buffer.toString('utf8'));
    }
  } finally {
    fs.closeSync(fd);
  }
  // Collected newest-first (peeled off the tail inward) — flip to the file's original order.
  return records.reverse();
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
// Shared "find first genuine (non-synthetic) message" scanning
// ---------------------------------------------------------------------------
//
// extractClaudeTitle/extractCodexTitle (single-line, 120-char titles) and the first/last
// message preview fields (multi-line) all need the identical "loop records, skip
// non-candidates, skip synthetic text, return the first genuine one" logic — factored out
// once here instead of duplicating it across four call sites (first/last x claude/codex).

function findGenuineMessageText(records, matchers) {
  for (const record of records) {
    if (!matchers.isCandidate(record)) continue;
    const text = matchers.extractText(record);
    if (matchers.isSynthetic(text)) continue;
    return text.trim();
  }
  return null;
}

const MESSAGE_PREVIEW_MAX_LINES = 5;

function buildMessagePreview(text) {
  return text.split('\n').slice(0, MESSAGE_PREVIEW_MAX_LINES).join('\n');
}

function extractFirstMessagePreview(records, matchers) {
  const text = findGenuineMessageText(records, matchers);
  return text === null ? null : buildMessagePreview(text);
}

function extractLastMessagePreview(records, matchers) {
  // `records` is expected to already be a small tail window (see readLastJsonLines) in
  // oldest-to-newest order; scan it newest-to-oldest to find the LAST genuine message.
  const text = findGenuineMessageText(records.slice().reverse(), matchers);
  return text === null ? null : buildMessagePreview(text);
}

// A fixed 20-record head window is enough for the vast majority of sessions, but real data
// shows skill invocations (e.g. a `/some-skill:name` command) each burn 2 head slots — a
// `<command-name>` line plus a large synthetic "Base directory for this skill: ..." body,
// both arriving as synthetic user-role records — before the first genuine human message
// ever appears, pushing it past record 20 and making title extraction and
// firstMessagePreview wrongly fall back to null/synthetic. Only widen the read when the
// fixed window truly found nothing genuine yet (the common case costs exactly one read, same
// as before); re-reading from byte 0 on each expansion is cheap and bounded to a handful of
// tries by HEAD_SCAN_MAX_WINDOW, well short of reading a whole file.
const HEAD_SCAN_INITIAL_WINDOW = 20;
const HEAD_SCAN_EXPANSION_FACTOR = 3;
const HEAD_SCAN_MAX_WINDOW = 500;

function readExpandingHeadRecords(filePath, matchers) {
  let n = HEAD_SCAN_INITIAL_WINDOW;
  let records = readFirstJsonLines(filePath, n);
  // records.length < n means readFirstJsonLines hit EOF before filling the window — the
  // file is simply short (e.g. a cancelled /resume with no real messages ever sent), so
  // re-reading a bigger window would return the exact same records. Stop immediately
  // instead of paying up to 3 wasted reads on every genuinely-empty session.
  while (
    n < HEAD_SCAN_MAX_WINDOW &&
    records.length === n &&
    findGenuineMessageText(records, matchers) === null
  ) {
    n = Math.min(n * HEAD_SCAN_EXPANSION_FACTOR, HEAD_SCAN_MAX_WINDOW);
    records = readFirstJsonLines(filePath, n);
  }
  return records;
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

const CLAUDE_MESSAGE_MATCHERS = {
  isCandidate: (record) => record.type === 'user' && record.isMeta !== true,
  extractText: (record) => extractMessageText(record.message),
  isSynthetic: isSyntheticClaudeText,
};

// For lastMessagePreview only (never title extraction or firstMessagePreview): the last
// genuine message can legitimately be the assistant's, since that's often where the
// conversation actually left off. extractMessageText already only pulls type:'text' blocks,
// so a pure thinking/tool_use assistant record naturally yields '' and is skipped as synthetic.
const CLAUDE_LAST_MESSAGE_MATCHERS = {
  isCandidate: (record) => (record.type === 'user' || record.type === 'assistant') && record.isMeta !== true,
  extractText: (record) => extractMessageText(record.message),
  isSynthetic: isSyntheticClaudeText,
};

function extractClaudeTitle(records, maxScan = 20) {
  const text = findGenuineMessageText(records.slice(0, maxScan), CLAUDE_MESSAGE_MATCHERS);
  return text === null ? null : text.slice(0, 120);
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

// Tail scan window for lastMessagePreview: sized larger than the head scan window (20)
// because agentic sessions often end with a long burst of tool-call/tool-result records
// after the last real user message, pushing it further back from EOF than a
// symmetric-to-the-head-window scan would reliably reach.
const TAIL_MESSAGE_SCAN_WINDOW = 60;

function scanClaudeCodeFile(filePath, homeDir) {
  const records = readExpandingHeadRecords(filePath, CLAUDE_MESSAGE_MATCHERS);
  if (records.length === 0) {
    throw new Error(`no parseable JSON records found in ${filePath}`);
  }
  const { cwd, branch } = findClaudeCwdAndBranch(records);
  const effectiveCwd = cwd || homeDir;
  const stat = fs.statSync(filePath);
  const extractedTitle = extractClaudeTitle(records, records.length);
  const titleIsFallback = !extractedTitle;
  const title =
    extractedTitle || `${displayNameForCwd(effectiveCwd)} (${stat.birthtime.toISOString()})`;
  const pathExists = fs.existsSync(effectiveCwd);
  const firstMessagePreview = extractFirstMessagePreview(records, CLAUDE_MESSAGE_MATCHERS);
  const tailRecords = readLastJsonLines(filePath, TAIL_MESSAGE_SCAN_WINDOW);
  const lastMessagePreview = extractLastMessagePreview(tailRecords, CLAUDE_LAST_MESSAGE_MATCHERS);
  return {
    tool: 'claude-code',
    id: path.basename(filePath, '.jsonl'),
    title,
    titleIsFallback,
    pathExists,
    firstMessagePreview,
    lastMessagePreview,
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
  // Codex's automated approval/risk-review sub-loop ends turns with a raw JSON verdict
  // (e.g. {"risk_level":"low",...,"outcome":"allow"}) instead of prose — real data shows
  // this on ~44% of sessions' last assistant turn, far too common to leave as the preview.
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch (err) {
      // Not actually JSON (e.g. a real message that happens to start with '{') — fall through.
    }
  }
  return looksLikeInjectedDocument(trimmed);
}

const CODEX_MESSAGE_MATCHERS = {
  isCandidate: (record) =>
    record.type === 'response_item' &&
    !!record.payload &&
    record.payload.type === 'message' &&
    record.payload.role === 'user',
  extractText: (record) => extractResponseItemText(record.payload),
  isSynthetic: isSyntheticCodexText,
};

// For lastMessagePreview only: accepts both input_text (user) and output_text (assistant)
// item types unconditionally — a record only ever has one or the other in practice, so no
// role branching is needed. Known caveat: some Codex sessions run an internal auto-approval
// sub-loop whose output_text is a raw JSON blob (e.g. {"risk_level":"low",...}) rather than
// prose; isSyntheticCodexText's heading/tag heuristics don't catch JSON (it starts with `{`),
// so a small number of sessions' lastMessagePreview may show that raw JSON. Accepted edge case.
function extractResponseItemTextAnyRole(payload) {
  const content = payload && payload.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item && (item.type === 'input_text' || item.type === 'output_text'))
    .map((item) => item.text || '')
    .join('\n');
}

const CODEX_LAST_MESSAGE_MATCHERS = {
  isCandidate: (record) =>
    record.type === 'response_item' &&
    !!record.payload &&
    record.payload.type === 'message' &&
    (record.payload.role === 'user' || record.payload.role === 'assistant'),
  extractText: (record) => extractResponseItemTextAnyRole(record.payload),
  isSynthetic: isSyntheticCodexText,
};

function extractCodexTitle(records, maxScan = 20) {
  const text = findGenuineMessageText(records.slice(0, maxScan), CODEX_MESSAGE_MATCHERS);
  return text === null ? null : text.slice(0, 120);
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
  const records = readExpandingHeadRecords(filePath, CODEX_MESSAGE_MATCHERS);
  if (records.length === 0) {
    throw new Error(`no parseable JSON records found in ${filePath}`);
  }
  const metaRecord = records.find((r) => r.type === 'session_meta');
  const payload = (metaRecord && metaRecord.payload) || {};
  const id = payload.id || path.basename(filePath, '.jsonl');
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : homeDir;
  const branch = payload.git && typeof payload.git.branch === 'string' ? payload.git.branch : null;
  const stat = fs.statSync(filePath);

  const indexTitle = indexMap.has(id) ? indexMap.get(id) : null;
  const extractedTitle = indexTitle || extractCodexTitle(records, records.length);
  const titleIsFallback = !extractedTitle;
  const title = extractedTitle || `${displayNameForCwd(cwd)} (${stat.birthtime.toISOString()})`;
  const pathExists = fs.existsSync(cwd);
  const firstMessagePreview = extractFirstMessagePreview(records, CODEX_MESSAGE_MATCHERS);
  const tailRecords = readLastJsonLines(filePath, TAIL_MESSAGE_SCAN_WINDOW);
  const lastMessagePreview = extractLastMessagePreview(tailRecords, CODEX_LAST_MESSAGE_MATCHERS);

  return {
    tool: 'codex',
    id,
    title,
    titleIsFallback,
    pathExists,
    firstMessagePreview,
    lastMessagePreview,
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
  .tree-node { margin-top: 0.4rem; }
  .tree-node > .tree-body { margin-left: 0.5rem; padding-left: 1rem; border-left: 1px dashed #ccc; margin-top: 0.3rem; }
  summary.tree-summary { cursor: pointer; list-style: none; }
  summary.tree-summary::-webkit-details-marker { display: none; }
  summary.tree-summary::before { content: '▸'; display: inline-block; width: 1em; margin-right: 0.3em; transition: transform 0.12s ease; }
  .tree-node[open] > summary.tree-summary::before { transform: rotate(90deg); }
  .tree-node--project > summary.tree-summary { font-weight: bold; }
  .tree-node--path > summary.tree-summary { color: #888; font-size: 0.85rem; font-family: monospace; }
  .tree-node--time > summary.tree-summary { color: #666; font-size: 0.85rem; }
  .tree-node--stale > summary.tree-summary { color: #a56a1a; }
  .meta { color: #666; font-size: 0.85rem; }
  .title-fallback { color: #888; font-style: italic; }
  .card-path-missing { filter: grayscale(1); opacity: 0.7; }
  .path-missing-warning { color: #a33; font-weight: bold; }
  .tool-badge { display: inline-block; width: 0.7em; height: 0.7em; border-radius: 3px; margin-left: 0.4em; vertical-align: middle; border: 1px solid rgba(0,0,0,0.25); }
  .tool-badge-claude-code { background: #d97706; }
  .tool-badge-codex { background: #2563eb; }
  button.copy-btn { cursor: pointer; margin-top: 0.4rem; }
  .preview-toggle { cursor: pointer; color: #555; font-size: 0.85rem; margin-top: 0.4rem; }
  .preview-body { display: none; margin-top: 0.3rem; font-size: 0.85rem; color: #444; white-space: pre-wrap; }
  .preview-body.preview-open { display: block; }
  #controls > * { margin-right: 0.5rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #ddd; }
    .card { border-color: #444; }
    .tree-node > .tree-body { border-left-color: #444; }
    .tree-node--path > summary.tree-summary { color: #999; }
    .tree-node--time > summary.tree-summary { color: #aaa; }
    .tree-node--stale > summary.tree-summary { color: #d99a4e; }
    .meta { color: #aaa; }
    .title-fallback { color: #999; }
    .path-missing-warning { color: #f87171; }
    .tool-badge { border-color: rgba(255, 255, 255, 0.3); }
    .tool-badge-claude-code { background: #f59e0b; }
    .tool-badge-codex { background: #60a5fa; }
    button.copy-btn { background: #2a2a2a; color: #ddd; border-color: #555; }
    .preview-toggle { color: #aaa; }
    .preview-body { color: #ccc; }
    #controls input, #controls select { background: #2a2a2a; color: #ddd; border-color: #555; }
  }
</style>
</head>
<body>
<h1>Session 管理器</h1>
<div class="meta" id="generated-meta"></div>
<div id="skipped-warning" class="meta"></div>
<h2>接續快速區</h2>
<div id="quick-resume"></div>
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

    var COPY_BTN_LABEL = '複製續接指令';
    function buildResumeCmd(s) {
      // Single-quoted PowerShell string, matching buildResumeCommand's escaping in session-dashboard.js:
      // double-quoted strings would let a real folder name containing $ or a backtick corrupt the command.
      var safeCwd = String(s.cwd).replace(/'/g, "''");
      return "Set-Location -LiteralPath '" + safeCwd + "'; " + (s.tool === 'codex' ? 'codex resume' : 'claude --resume') + ' ' + s.id;
    }

    function createCopyButton(s) {
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = COPY_BTN_LABEL;
      var copyResetTimer = null;
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(buildResumeCmd(s));
        btn.textContent = '已複製✓';
        if (copyResetTimer) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(function () {
          btn.textContent = COPY_BTN_LABEL;
          copyResetTimer = null;
        }, 1500);
      });
      return btn;
    }

    function createPreviewToggle(s) {
      var wrapper = document.createElement('div');
      wrapper.className = 'preview-toggle-wrap';

      var toggleEl = document.createElement('div');
      toggleEl.className = 'preview-toggle';
      toggleEl.textContent = '▸ 訊息預覽';

      var bodyEl = document.createElement('div');
      bodyEl.className = 'preview-body';

      var startEl = document.createElement('div');
      startEl.textContent = '開始：' + (s.firstMessagePreview || '（無）');
      bodyEl.appendChild(startEl);

      var lastEl = document.createElement('div');
      lastEl.textContent = '最後：' + (s.lastMessagePreview || '（無）');
      bodyEl.appendChild(lastEl);

      var expanded = false;
      toggleEl.addEventListener('click', function () {
        expanded = !expanded;
        bodyEl.className = expanded ? 'preview-body preview-open' : 'preview-body';
        toggleEl.textContent = (expanded ? '▾' : '▸') + ' 訊息預覽';
      });

      wrapper.appendChild(toggleEl);
      wrapper.appendChild(bodyEl);
      return wrapper;
    }

    var QUICK_RESUME_COUNT = 8;
    function renderQuickResume() {
      var container = document.getElementById('quick-resume');
      var candidates = DATA.sessions.filter(function (s) { return s.pathExists !== false; });
      candidates.sort(function (a, b) { return new Date(b.lastActiveAt) - new Date(a.lastActiveAt); });
      candidates.slice(0, QUICK_RESUME_COUNT).forEach(function (s) {
        var card = document.createElement('div');
        card.className = 'card';
        var titleEl = document.createElement('div');
        titleEl.textContent = s.displayName + '：' + s.title;
        card.appendChild(titleEl);
        var metaEl = document.createElement('div');
        metaEl.className = 'meta';
        metaEl.textContent = '最後互動：' + s.lastActiveAt;
        card.appendChild(metaEl);
        card.appendChild(createCopyButton(s));
        card.appendChild(createPreviewToggle(s));
        container.appendChild(card);
      });
    }

    function render() {
      var app = document.getElementById('app');
      app.innerHTML = '';
      var searchTerm = normalize(document.getElementById('search').value);
      var category = document.getElementById('category-filter').value;
      var tool = document.getElementById('tool-filter').value;
      var range = document.getElementById('range-filter').value;
      var now = Date.now();
      var rangeMs = range === 'all' ? Infinity : Number(range) * 24 * 60 * 60 * 1000;

      var searchCategoryToolFiltered = DATA.sessions.filter(function (s) {
        if (tool !== 'all' && s.tool !== tool) return false;
        if (category === 'misc' && s.groupKey !== '__misc__') return false;
        if (category === 'project' && s.groupKey === '__misc__') return false;
        if (searchTerm && normalize(s.title + ' ' + s.cwd).indexOf(searchTerm) === -1) return false;
        return true;
      });

      // 久未使用整理區：>90 天沒有互動的 session 從各自的專案節點抽出，集中到樹狀圖
      // 最上方一個獨立、跨專案、預設摺疊的區塊，方便使用者一次看完所有可能不再需要的
      // session，而不用一個個專案點開找。閥值先寫死，本輪不做刪除/歸檔，純顯示用途。
      // 刻意不套用時間範圍篩選（range-filter）——那個篩選的語意是「只看最近 N 天內有
      // 活動的」，跟久未使用（>90 天沒活動）的目的正好相反；預設 30 天的範圍篩選會讓
      // 這個整理區永遠是空的。搜尋/分類/工具篩選則正常套用，跟樹狀圖其餘部分一致。
      var STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;
      var staleSessions = [];
      var freshSessions = [];
      searchCategoryToolFiltered.forEach(function (s) {
        var age = now - new Date(s.lastActiveAt).getTime();
        if (age > STALE_THRESHOLD_MS) {
          staleSessions.push(s);
        } else if (age <= rangeMs) {
          freshSessions.push(s);
        }
      });
      freshSessions.sort(function (a, b) { return new Date(b.lastActiveAt) - new Date(a.lastActiveAt); });

      function renderCard(s, container) {
        var card = document.createElement('div');
        card.className = s.pathExists === false ? 'card card-path-missing' : 'card';

        var titleEl = document.createElement('div');
        titleEl.textContent = '[' + s.tool + '] ' + s.title;
        if (s.titleIsFallback) titleEl.className = 'title-fallback';
        var badgeEl = document.createElement('span');
        badgeEl.className = 'tool-badge tool-badge-' + s.tool;
        titleEl.appendChild(badgeEl);
        card.appendChild(titleEl);

        if (s.pathExists === false) {
          var warningEl = document.createElement('div');
          warningEl.className = 'path-missing-warning';
          warningEl.textContent = '資料夾已不存在';
          card.appendChild(warningEl);
        }

        var metaEl = document.createElement('div');
        metaEl.className = 'meta';
        metaEl.textContent = '最後互動：' + s.lastActiveAt + '　開始：' + s.startedAt + (s.branch ? '　branch：' + s.branch : '');
        card.appendChild(metaEl);

        card.appendChild(createCopyButton(s));
        card.appendChild(createPreviewToggle(s));

        container.appendChild(card);
      }

      function mostRecentTime(items) {
        return items.reduce(function (max, s) {
          var t = new Date(s.lastActiveAt).getTime();
          return t > max ? t : max;
        }, 0);
      }

      var groups = new Map();
      freshSessions.forEach(function (s) {
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

      // 時間區間邊界：以「今天」的日曆日起點為基準，往前推算「昨天」與「本週」，
      // 不採 ISO 週（週一為始）——這是單人工具，使用者關心的是「大概多久以前」，
      // 用滾動 7 天視窗（扣掉今天／昨天）比對齊團隊行事曆週界更直覺、不需要額外解釋。
      function dayStart(ms) {
        var d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      }
      var todayStart = dayStart(now);
      var yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
      var weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;
      var TIME_BUCKET_LABELS = ['今天', '昨天', '本週', '更早'];
      function bucketLabelFor(lastActiveAt) {
        var t = new Date(lastActiveAt).getTime();
        if (t >= todayStart) return '今天';
        if (t >= yesterdayStart) return '昨天';
        if (t >= weekStart) return '本週';
        return '更早';
      }

      function createTreeNode(levelClass) {
        var details = document.createElement('details');
        details.className = 'tree-node ' + levelClass;
        // Ticket 06: removed the old "expand top N clusters / force-open while searching"
        // behavior entirely — every tree node, at every level, always starts collapsed.
        details.open = false;
        var summary = document.createElement('summary');
        summary.className = 'tree-summary';
        details.appendChild(summary);
        var body = document.createElement('div');
        body.className = 'tree-body';
        details.appendChild(body);
        return { details: details, summary: summary, body: body };
      }

      function renderTimeBuckets(sessions, container) {
        var byBucket = new Map();
        sessions.forEach(function (s) {
          var label = bucketLabelFor(s.lastActiveAt);
          if (!byBucket.has(label)) byBucket.set(label, []);
          byBucket.get(label).push(s);
        });
        TIME_BUCKET_LABELS.forEach(function (label) {
          var items = byBucket.get(label);
          if (!items || items.length === 0) return;
          var node = createTreeNode('tree-node--time');
          node.summary.textContent = label;
          items.forEach(function (s) { renderCard(s, node.body); });
          container.appendChild(node.details);
        });
      }

      if (staleSessions.length > 0) {
        staleSessions.sort(function (a, b) { return new Date(b.lastActiveAt) - new Date(a.lastActiveAt); });
        var staleNode = createTreeNode('tree-node--project tree-node--stale');
        staleNode.summary.textContent = '久未使用（超過 90 天）（' + staleSessions.length + ' 筆）';
        staleSessions.forEach(function (s) { renderCard(s, staleNode.body); });
        app.appendChild(staleNode.details);
      }

      clusterEntries.forEach(function (entry) {
        var label = entry[0];
        var subGroups = entry[1];
        subGroups.sort(function (a, b) { return mostRecentTime(b) - mostRecentTime(a); });

        var isMisc = label === MISC_CLUSTER_KEY;
        // 雜項沒有路徑子節點這一層（規格明文規定），即使實務上雜項的 groupKey
        // 永遠只會有一組，這裡仍明確用 isMisc 排除，直接依照規格表達意圖，
        // 不依賴「雜項剛好只有一組」這個分群邏輯的隱含副作用。
        var isClustered = !isMisc && subGroups.length > 1;

        var projectNode = createTreeNode('tree-node--project');
        projectNode.summary.textContent = isMisc
          ? '雜項/隨手'
          : (isClustered ? label + '（' + subGroups.length + ' 個位置）' : label);

        if (isClustered) {
          subGroups.forEach(function (items) {
            var pathNode = createTreeNode('tree-node--path');
            pathNode.summary.textContent = items[0].cwd;
            renderTimeBuckets(items, pathNode.body);
            projectNode.body.appendChild(pathNode.details);
          });
        } else {
          var allItems = [];
          subGroups.forEach(function (items) { allItems = allItems.concat(items); });
          renderTimeBuckets(allItems, projectNode.body);
        }

        app.appendChild(projectNode.details);
      });
    }

    document.getElementById('search').addEventListener('input', render);
    document.getElementById('category-filter').addEventListener('change', render);
    document.getElementById('tool-filter').addEventListener('change', render);
    document.getElementById('range-filter').addEventListener('change', render);
    // ADR-0001: 接續快速區刻意獨立於 render()／篩選狀態，只在載入時渲染一次，不要接上任何篩選事件。
    renderQuickResume();
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
  readLastJsonLines,
  readExpandingHeadRecords,
  extractMessageText,
  isSyntheticClaudeText,
  extractClaudeTitle,
  walkJsonlFiles,
  scanClaudeCodeFile,
  scanClaudeCode,
  extractResponseItemText,
  extractResponseItemTextAnyRole,
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
