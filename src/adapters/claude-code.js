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

module.exports = {
  extractMessageText,
  isSyntheticClaudeText,
  extractClaudeTitle,
  scanClaudeCodeFile,
  scanClaudeCode,
};
