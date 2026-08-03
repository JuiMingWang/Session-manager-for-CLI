'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  readLastJsonLines,
  looksLikeInjectedDocument,
  findGenuineMessageText,
  extractFirstMessagePreview,
  extractLastMessagePreview,
  readExpandingHeadRecords,
  walkJsonlFiles,
  normalizeGroupKey,
  displayNameForCwd,
  TAIL_MESSAGE_SCAN_WINDOW,
} = require('./shared.js');

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

module.exports = {
  extractResponseItemText,
  isSyntheticCodexText,
  extractResponseItemTextAnyRole,
  extractCodexTitle,
  loadCodexIndex,
  scanCodexFile,
  scanCodex,
};
