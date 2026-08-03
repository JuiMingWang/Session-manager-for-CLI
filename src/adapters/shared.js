'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Path/grouping helpers (shared by Claude Code and Codex adapters)
// ---------------------------------------------------------------------------

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

// Tail scan window for lastMessagePreview: sized larger than the head scan window (20)
// because agentic sessions often end with a long burst of tool-call/tool-result records
// after the last real user message, pushing it further back from EOF than a
// symmetric-to-the-head-window scan would reliably reach.
const TAIL_MESSAGE_SCAN_WINDOW = 60;

module.exports = {
  normalizePath,
  normalizeGroupKey,
  displayNameForCwd,
  readFirstJsonLines,
  readLastJsonLines,
  looksLikeInjectedDocument,
  findGenuineMessageText,
  buildMessagePreview,
  extractFirstMessagePreview,
  extractLastMessagePreview,
  readExpandingHeadRecords,
  walkJsonlFiles,
  TAIL_MESSAGE_SCAN_WINDOW,
};
