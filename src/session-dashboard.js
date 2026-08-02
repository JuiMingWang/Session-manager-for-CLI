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

module.exports = {
  escapeHtml,
  embedJsonSafely,
  normalizePath,
  normalizeGroupKey,
  displayNameForCwd,
  escapePowerShellSingleQuoted,
  buildResumeCommand,
  parseArgs,
};
