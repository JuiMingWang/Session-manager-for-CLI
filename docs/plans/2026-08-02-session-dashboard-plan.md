# Session 管理器（`/sessions`）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency Node.js tool that scans Claude Code and Codex session history, and renders it as a searchable/filterable local HTML dashboard (`/sessions` slash command + automatic `SessionStart` hook refresh), without breaking the existing pet-companion hooks already registered on the same events.

**Architecture:** One CLI script (`session-dashboard.js`) with two parallel scanner functions (`scanClaudeCode`, `scanCodex`) that read the first ~20 lines + `mtime` of each session's `.jsonl` file, normalize the result into a shared session shape, and render it into a single static HTML file via atomic (temp-file + rename) writes. A separate one-time installer script (`install-session-dashboard-hooks.js`) appends (never overwrites) a `SessionStart` hook entry to Claude Code's `settings.json` and Codex's `hooks.json`.

**Tech Stack:** Plain Node.js (`node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`), Node's built-in test runner (`node:test` + `node:assert/strict`). No npm dependencies, no build step, no framework.

## Global Constraints

- Node.js >= 18 required (uses `node:test`, tested against the installed v24.18.0). No npm packages — zero-dependency script per the spec's "不做額外的 plugin/class 抽象架構" decision.
- Target OS is Windows; the deployed script always runs against `os.homedir()` — never hardcode `C:\Users\sjack`, so the code stays correct if run under a different account.
- Copy-to-clipboard resume commands are PowerShell 5.1 syntax only (`;` separator, not `&&`) — this is an explicit v1 scope limit from the spec, not an oversight.
- `~/.claude/settings.json`'s `hooks.SessionStart` and `~/.codex/hooks.json`'s `hooks.SessionStart` **already contain a hook entry each** (Claude Pet Companion, "Clawd on Desk"). Every task that touches these files must **append**, never overwrite.
- Every string that ends up in the generated HTML (title, cwd, branch) is untrusted (comes from session file contents) and must go through `escapeHtml`/`embedJsonSafely` — never raw string concatenation into HTML.
- The dashboard output file (`~/.claude/sessions-dashboard.html`) can be written concurrently by up to three triggers (two hooks + manual command) — every write goes through `writeAtomic`, which uses a per-call unique temp filename, never a fixed one.

## Real-data finding that changes the Codex title fallback (read before Task 4)

While grounding this plan in the real files, I sampled actual Codex rollout files. `session_index.jsonl` only names sessions Codex Desktop actively tracked; for a session with no index entry, the spec's fallback is "scan the first ~20 lines for a genuine human message, like the Claude Code adapter." In practice this does not work for Codex: one real rollout file has genuine human text starting at **line 860** of **12,180** total, preceded by at least five distinct kinds of injected system content (`<environment_context>`, `<recommended_plugins>`, `# Context from my IDE setup:`, `<permissions instructions>`, and even an injected `# AGENTS.md instructions for ...` block that isn't wrapped in any of the first four tags).

Scanning deep enough to reliably find genuine text would mean reading thousands of lines per file, which breaks the spec's explicit "只讀開頭幾行...不整份解析" performance principle. The pragmatic, honest choice implemented below: **keep the scan window small (same N=20 as Claude Code) and accept that the Codex fallback will fall through to `basename + timestamp` most of the time** when a session has no index entry. This is still strictly better than a crash or a garbled title, and it keeps the scan cost bounded. Flag this to the user after implementation: Codex sessions without an index entry will mostly show generic titles, not scraped human text.

---

## File Structure

```
Session_Manager/
  src/
    session-dashboard.js                    # scanners + HTML builder + atomic writer + CLI
    session-dashboard.test.js               # unit tests for the above
    install-session-dashboard-hooks.js       # one-time idempotent hook installer
    install-session-dashboard-hooks.test.js  # unit tests for the above
  commands/
    sessions.md                             # Claude Code slash command definition
  docs/
    specs/2026-08-02-session-dashboard-design.md   (existing)
    plans/2026-08-02-session-dashboard-plan.md     (this file)
    deploy-log.md                                  (created by Task 11 — dated record of each deploy)
```

**Why source lives in the git repo but must also exist under `~/.claude/`:** `~/.claude` is not a git repo, but the spec fixes the script's *runtime* location at `~/.claude/scripts/session-dashboard.js` (hooks and the slash command both hard-reference that path). So this plan treats `src/` as the versioned source of truth, developed and unit-tested entirely inside the repo, and Task 11 copies the finished files to their real runtime locations as a deploy step — the same way you'd deploy a built artifact. `~/.claude/scripts/`, `~/.claude/commands/sessions.md`, and the two live hook config files are never edited directly during Tasks 1–10; all of that happens against repo-local files and fixtures.

Every scanner/builder function takes its root directory (`claudeHomeDir`, `codexHomeDir`, `homeDir`) as a parameter rather than calling `os.homedir()` internally — this is what makes Tasks 1–10 testable against temp fixture directories instead of the user's real `~/.claude` and `~/.codex`.

---

### Task 1: Pure utility functions (escaping, grouping, resume command, arg parsing)

**Files:**
- Create: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Produces: `escapeHtml(str: string): string`, `embedJsonSafely(data: any): string`, `normalizePath(p: string): string`, `normalizeGroupKey(cwd: string, homeDir: string): string`, `displayNameForCwd(cwd: string): string`, `buildResumeCommand(tool: 'claude-code'|'codex', cwd: string, sessionId: string): string`, `parseArgs(argv: string[]): { quiet: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `src/session-dashboard.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeHtml,
  embedJsonSafely,
  normalizeGroupKey,
  displayNameForCwd,
  buildResumeCommand,
  parseArgs,
} = require('./session-dashboard.js');

test('escapeHtml escapes the five dangerous characters', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('x')"> & </script>`),
    '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; &lt;/script&gt;'
  );
});

test('embedJsonSafely escapes < so </script> cannot break out of the script tag', () => {
  const result = embedJsonSafely({ title: '</script><script>alert(1)</script>' });
  assert.ok(!result.includes('</script>'), 'must not contain a raw </script>');
  assert.ok(result.includes('\\u003c/script\\u003e'));
});

test('embedJsonSafely round-trips through JSON.parse', () => {
  const original = { a: 1, b: '<hello>', c: [1, 2, 3] };
  const embedded = embedJsonSafely(original);
  assert.deepEqual(JSON.parse(embedded.replace(/\\u003c/g, '<')), original);
});

test('normalizeGroupKey returns a sentinel for the home directory itself', () => {
  assert.equal(normalizeGroupKey('C:\\Users\\sjack', 'C:\\Users\\sjack'), '__misc__');
  assert.equal(normalizeGroupKey('C:\\Users\\sjack\\', 'C:\\Users\\sjack'), '__misc__', 'trailing slash ignored');
  assert.equal(normalizeGroupKey('C:\\USERS\\SJACK', 'c:\\users\\sjack'), '__misc__', 'case-insensitive');
});

test('normalizeGroupKey does not collide same-basename folders on different drives', () => {
  const keyD = normalizeGroupKey('D:\\work\\api', 'C:\\Users\\sjack');
  const keyE = normalizeGroupKey('E:\\backup\\api', 'C:\\Users\\sjack');
  assert.notEqual(keyD, keyE);
});

test('normalizeGroupKey treats mixed separators as equal', () => {
  const a = normalizeGroupKey('C:/work/api/', 'C:\\Users\\sjack');
  const b = normalizeGroupKey('C:\\work\\api', 'C:\\Users\\sjack');
  assert.equal(a, b);
});

test('displayNameForCwd returns the basename regardless of separator style', () => {
  assert.equal(displayNameForCwd('C:\\work\\my-project'), 'my-project');
  assert.equal(displayNameForCwd('C:/work/my-project/'), 'my-project');
});

test('buildResumeCommand produces PowerShell 5.1-safe syntax (no &&, single-quoted path)', () => {
  const claudeCmd = buildResumeCommand('claude-code', 'C:\\Users\\sjack\\proj', 'abc-123');
  assert.equal(claudeCmd, "Set-Location -LiteralPath 'C:\\Users\\sjack\\proj'; claude --resume abc-123");
  const codexCmd = buildResumeCommand('codex', 'C:\\Users\\sjack\\proj', 'abc-123');
  assert.equal(codexCmd, "Set-Location -LiteralPath 'C:\\Users\\sjack\\proj'; codex resume abc-123");
});

test('buildResumeCommand single-quotes the path so $ and backtick in a real folder name are never expanded by PowerShell, and escapes embedded single quotes', () => {
  const cmd = buildResumeCommand('claude-code', "C:\\work\\$weird`path\\O'Brien", 'abc-123');
  assert.equal(cmd, "Set-Location -LiteralPath 'C:\\work\\$weird`path\\O''Brien'; claude --resume abc-123");
});

test('parseArgs detects --quiet', () => {
  assert.deepEqual(parseArgs([]), { quiet: false });
  assert.deepEqual(parseArgs(['--quiet']), { quiet: true });
});
```

Note: `buildResumeCommand` uses a **single-quoted** PowerShell string (`'...'`), not double-quoted. PowerShell expands `$variables` and treats backtick as an escape character inside double-quoted strings — a real folder name containing either (both are legal Windows path characters) would silently corrupt a double-quoted command. Single-quoted strings in PowerShell never interpolate; the only character that needs escaping is a literal `'`, done by doubling it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — `src/session-dashboard.js` does not exist yet (`Cannot find module`).

- [ ] **Step 3: Write the minimal implementation**

Create `src/session-dashboard.js`:

```js
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
  return JSON.stringify(data).replace(/</g, '\\u003c');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增 session-dashboard 基礎工具函式（escape、分組、續接指令、參數解析）"
```

---

### Task 2: Claude Code title extraction

**Files:**
- Modify: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent pure logic).
- Produces: `readFirstJsonLines(filePath: string, n: number): object[]`, `extractMessageText(message: {content: string|Array<{type:string,text?:string}>}): string`, `isSyntheticClaudeText(text: string): boolean`, `extractClaudeTitle(records: object[], maxScan?: number): string|null`

- [ ] **Step 1: Write the failing tests**

Append to `src/session-dashboard.test.js`:

```js
const fsForTests = require('node:fs');
const osForTests = require('node:os');
const pathForTests = require('node:path');

const {
  readFirstJsonLines,
  extractMessageText,
  isSyntheticClaudeText,
  extractClaudeTitle,
} = require('./session-dashboard.js');

function makeTempDir() {
  return fsForTests.mkdtempSync(pathForTests.join(osForTests.tmpdir(), 'sdtest-'));
}

test('extractMessageText handles string content', () => {
  assert.equal(extractMessageText({ content: 'hello world' }), 'hello world');
});

test('extractMessageText joins text-type array items and ignores tool_result items', () => {
  const message = {
    content: [
      { type: 'tool_result', tool_use_id: 'x', content: 'some tool output' },
    ],
  };
  assert.equal(extractMessageText(message), '', 'tool_result-only content yields no extractable text');
});

test('extractMessageText extracts text-type array items', () => {
  const message = { content: [{ type: 'text', text: '我想討論一下這個問題' }] };
  assert.equal(extractMessageText(message), '我想討論一下這個問題');
});

test('isSyntheticClaudeText flags known injected wrapper prefixes', () => {
  assert.equal(isSyntheticClaudeText('<command-message>brainstorming</command-message>...'), true);
  assert.equal(isSyntheticClaudeText('<local-command-caveat>Caveat: ...'), true);
  assert.equal(isSyntheticClaudeText('<system-reminder>...'), true);
  assert.equal(isSyntheticClaudeText('Base directory for this skill: C:\\...'), true);
  assert.equal(isSyntheticClaudeText(''), true, 'empty text is not usable as a title');
  assert.equal(isSyntheticClaudeText('我想討論一下 session 管理器怎麼做'), false);
});

test('isSyntheticClaudeText flags <command-name> and <local-command-stdout/stderr> — confirmed against real transcripts, where some invocations lead with <command-name> instead of <command-message>', () => {
  // Real example from this machine: '<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>marketplace add ...'
  assert.equal(isSyntheticClaudeText('<command-name>/plugin</command-name>\n<command-message>plugin</command-message>'), true);
  // Real example: '<local-command-stdout>Successfully added marketplace: openai-codex</local-command-stdout>'
  assert.equal(isSyntheticClaudeText('<local-command-stdout>Successfully added marketplace: openai-codex</local-command-stdout>'), true);
  assert.equal(isSyntheticClaudeText('<local-command-stderr>some error output</local-command-stderr>'), true);
});

test('extractClaudeTitle skips isMeta records and synthetic-wrapped records, picks first genuine human text', () => {
  const records = [
    { type: 'user', isMeta: true, message: { content: '<local-command-caveat>Caveat: ...' } },
    { type: 'user', message: { content: '<command-message>brainstorming</command-message><command-args>我想討論session管理</command-args>' } },
    { type: 'user', message: { content: [{ type: 'text', text: 'Base directory for this skill: C:\\...' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '這條不算，type 不是 user' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '我想討論一下 session 管理器怎麼做' }] } },
  ];
  assert.equal(extractClaudeTitle(records), '我想討論一下 session 管理器怎麼做');
});

test('extractClaudeTitle returns null when no genuine record found within maxScan', () => {
  const records = Array.from({ length: 25 }, () => ({
    type: 'user',
    isMeta: true,
    message: { content: '<local-command-caveat>...' },
  }));
  assert.equal(extractClaudeTitle(records, 20), null);
});

test('extractClaudeTitle truncates long titles to 120 chars', () => {
  const longText = 'a'.repeat(200);
  const records = [{ type: 'user', message: { content: longText } }];
  assert.equal(extractClaudeTitle(records).length, 120);
});

test('readFirstJsonLines skips unparseable lines but keeps parseable ones (truncated-file resilience)', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'truncated.jsonl');
  const goodLine1 = JSON.stringify({ type: 'user', message: { content: 'first' } });
  const goodLine2 = JSON.stringify({ type: 'user', message: { content: 'second' } });
  const truncatedLine = '{"type":"user","message":{"content":"cut off mid-wr';
  fsForTests.writeFileSync(filePath, `${goodLine1}\n${goodLine2}\n${truncatedLine}`, 'utf8');
  const records = readFirstJsonLines(filePath, 20);
  assert.equal(records.length, 2);
  assert.equal(records[0].message.content, 'first');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('readFirstJsonLines stops at n records and skips blank lines', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'many.jsonl');
  const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ n: i }));
  fsForTests.writeFileSync(filePath, `\n${lines.join('\n\n')}\n`, 'utf8');
  const records = readFirstJsonLines(filePath, 3);
  assert.deepEqual(records.map((r) => r.n), [0, 1, 2]);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('readFirstJsonLines does not corrupt a multi-byte UTF-8 character straddling a 64KB chunk boundary', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'boundary.jsonl');
  const CHUNK_SIZE = 64 * 1024;
  const prefix = '{"type":"user","message":{"content":"';
  const suffix = '中文測試"}}';
  // Pad the line so the multi-byte suffix starts 2 bytes before the chunk boundary,
  // guaranteeing the first character's 3-byte UTF-8 encoding is split across two reads.
  const targetPrefixByteLength = CHUNK_SIZE - 2;
  const filler = 'A'.repeat(Math.max(0, targetPrefixByteLength - Buffer.byteLength(prefix)));
  fsForTests.writeFileSync(filePath, prefix + filler + suffix + '\n', 'utf8');

  const records = readFirstJsonLines(filePath, 1);
  assert.equal(records.length, 1);
  assert.ok(records[0].message.content.endsWith('中文測試'), records[0].message.content.slice(-20));
  assert.ok(!records[0].message.content.includes('�'), 'must not contain the UTF-8 replacement character');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — `readFirstJsonLines`, `extractMessageText`, `isSyntheticClaudeText`, `extractClaudeTitle` are not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/session-dashboard.js`, above `module.exports`:

```js
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
  return CLAUDE_SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
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
```

Update `module.exports` to also include `readFirstJsonLines, extractMessageText, isSyntheticClaudeText, extractClaudeTitle`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 21 tests passing (10 from Task 1 + 11 new).

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增 Claude Code 標題擷取規則（跳過 isMeta 與系統注入內容）"
```

---

### Task 3: Claude Code file and directory scanning

**Files:**
- Modify: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Consumes: `readFirstJsonLines`, `extractClaudeTitle`, `normalizeGroupKey`, `displayNameForCwd` (Tasks 1–2)
- Produces: `walkJsonlFiles(rootDir: string, excludeDirNames?: string[]): string[]`, `scanClaudeCodeFile(filePath: string, homeDir: string): SessionRecord`, `scanClaudeCode(claudeHomeDir: string): { sessions: SessionRecord[], skipped: number }`

  where `SessionRecord = { tool: 'claude-code'|'codex', id: string, title: string, cwd: string, branch: string|null, groupKey: string, displayName: string, startedAt: string, lastActiveAt: string }`

- [ ] **Step 1: Write the failing tests**

Append to `src/session-dashboard.test.js`:

```js
const { walkJsonlFiles, scanClaudeCodeFile, scanClaudeCode } = require('./session-dashboard.js');

function writeJsonl(filePath, records) {
  fsForTests.mkdirSync(pathForTests.dirname(filePath), { recursive: true });
  fsForTests.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('walkJsonlFiles finds .jsonl files recursively and excludes named directories', () => {
  const dir = makeTempDir();
  writeJsonl(pathForTests.join(dir, 'proj1', 'a.jsonl'), [{ n: 1 }]);
  writeJsonl(pathForTests.join(dir, 'proj1', 'subagents', 'b.jsonl'), [{ n: 2 }]);
  writeJsonl(pathForTests.join(dir, 'proj2', 'c.jsonl'), [{ n: 3 }]);
  fsForTests.writeFileSync(pathForTests.join(dir, 'proj2', 'notes.txt'), 'ignore me');

  const files = walkJsonlFiles(dir, ['subagents']).map((f) => pathForTests.basename(f)).sort();
  assert.deepEqual(files, ['a.jsonl', 'c.jsonl']);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('walkJsonlFiles returns empty array for a missing root directory', () => {
  assert.deepEqual(walkJsonlFiles('C:\\does\\not\\exist\\at\\all', []), []);
});

test('scanClaudeCodeFile extracts title, cwd, branch, group key from a real-shaped file', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'abc-123.jsonl');
  writeJsonl(filePath, [
    { type: 'mode', mode: 'default' },
    {
      type: 'user',
      cwd: 'C:\\work\\my-project',
      gitBranch: 'main',
      message: { content: '我想討論一下 session 管理器怎麼做' },
    },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.tool, 'claude-code');
  assert.equal(session.id, 'abc-123');
  assert.equal(session.title, '我想討論一下 session 管理器怎麼做');
  assert.equal(session.cwd, 'C:\\work\\my-project');
  assert.equal(session.branch, 'main');
  assert.equal(session.displayName, 'my-project');
  assert.equal(session.groupKey, normalizeGroupKeyForTest());

  function normalizeGroupKeyForTest() {
    const { normalizeGroupKey: fn } = require('./session-dashboard.js');
    return fn('C:\\work\\my-project', 'C:\\Users\\sjack');
  }
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile falls back to basename+timestamp title when no genuine text found', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'def-456.jsonl');
  writeJsonl(filePath, [
    { type: 'user', cwd: 'C:\\work\\other-project', isMeta: true, message: { content: '<local-command-caveat>...' } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.ok(session.title.startsWith('other-project ('), session.title);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile throws when the file contains zero parseable JSON records', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'garbage.jsonl');
  fsForTests.writeFileSync(filePath, 'this is not json at all\nneither is this line', 'utf8');
  assert.throws(() => scanClaudeCodeFile(filePath, 'C:\\Users\\sjack'));
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCode skips a file with zero parseable JSON and counts it, still returns the good ones', () => {
  const dir = makeTempDir();
  writeJsonl(pathForTests.join(dir, 'projects', 'proj', 'good.jsonl'), [
    { type: 'user', cwd: 'C:\\work\\proj', message: { content: '正常的一則訊息' } },
  ]);
  fsForTests.writeFileSync(
    pathForTests.join(dir, 'projects', 'proj', 'broken.jsonl'),
    'not json at all\nstill not json',
    'utf8'
  );

  const { sessions, skipped } = scanClaudeCode(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, '正常的一則訊息');
  assert.equal(skipped, 1);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCode also counts files that fail for other I/O reasons, not just empty-parse (defense in depth)', () => {
  const dir = makeTempDir();
  const okPath = pathForTests.join(dir, 'projects', 'proj', 'ok.jsonl');
  writeJsonl(okPath, [{ type: 'user', cwd: 'C:\\work\\proj', message: { content: '正常訊息' } }]);
  const flakyPath = pathForTests.join(dir, 'projects', 'proj', 'flaky.jsonl');
  writeJsonl(flakyPath, [{ type: 'user', cwd: 'C:\\work\\proj', message: { content: '正常訊息2' } }]);

  const originalStatSync = fsForTests.statSync;
  fsForTests.statSync = function (p, ...rest) {
    if (p === flakyPath) throw new Error('simulated stat failure');
    return originalStatSync.call(fsForTests, p, ...rest);
  };
  try {
    const { sessions, skipped } = scanClaudeCode(dir);
    assert.equal(sessions.length, 1);
    assert.equal(skipped, 1);
  } finally {
    fsForTests.statSync = originalStatSync;
  }
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCode returns empty result when the projects directory does not exist', () => {
  const dir = makeTempDir();
  const { sessions, skipped } = scanClaudeCode(dir);
  assert.deepEqual(sessions, []);
  assert.equal(skipped, 0);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — `walkJsonlFiles`, `scanClaudeCodeFile`, `scanClaudeCode` not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/session-dashboard.js`, above `module.exports`:

```js
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

function scanClaudeCode(claudeHomeDir) {
  const projectsDir = path.join(claudeHomeDir, 'projects');
  const files = walkJsonlFiles(projectsDir, ['subagents']);
  const sessions = [];
  let skipped = 0;
  for (const file of files) {
    try {
      sessions.push(scanClaudeCodeFile(file, claudeHomeDir));
    } catch (err) {
      skipped += 1;
    }
  }
  return { sessions, skipped };
}
```

Update `module.exports` to also include `walkJsonlFiles, scanClaudeCodeFile, scanClaudeCode`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 29 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增 Claude Code 目錄掃描（含 subagents 排除與壞檔跳過）"
```

---

### Task 4: Codex title extraction and index loading

**Files:**
- Modify: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Consumes: `readFirstJsonLines` (Task 2)
- Produces: `extractResponseItemText(payload: {content?: Array<{type:string,text?:string}>}): string`, `isSyntheticCodexText(text: string): boolean`, `extractCodexTitle(records: object[], maxScan?: number): string|null`, `loadCodexIndex(indexFilePath: string): Map<string,string>`

- [ ] **Step 1: Write the failing tests**

Append to `src/session-dashboard.test.js`:

```js
const {
  extractResponseItemText,
  isSyntheticCodexText,
  extractCodexTitle,
  loadCodexIndex,
} = require('./session-dashboard.js');

test('extractResponseItemText extracts input_text items only', () => {
  const payload = { content: [{ type: 'input_text', text: '幫我修一下這個 bug' }] };
  assert.equal(extractResponseItemText(payload), '幫我修一下這個 bug');
});

test('extractResponseItemText returns empty string for non-array content', () => {
  assert.equal(extractResponseItemText({ content: 'not an array' }), '');
  assert.equal(extractResponseItemText({}), '');
});

test('isSyntheticCodexText flags known injected prefixes observed in real rollout files', () => {
  assert.equal(isSyntheticCodexText('<environment_context>\n  <cwd>...'), true);
  assert.equal(isSyntheticCodexText('<recommended_plugins>\nHere is a list...'), true);
  assert.equal(isSyntheticCodexText('<permissions instructions>\nFilesystem sandboxing...'), true);
  assert.equal(isSyntheticCodexText('# Context from my IDE setup:\n\n## Open tabs:'), true);
  assert.equal(isSyntheticCodexText('幫我修一下這個 bug'), false);
});

test('extractCodexTitle only considers response_item/message/role=user records', () => {
  const records = [
    { type: 'session_meta', payload: { id: 'x' } },
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '幫我修一下這個 bug' }] } },
  ];
  assert.equal(extractCodexTitle(records), '幫我修一下這個 bug');
});

test('extractCodexTitle returns null when nothing genuine found within maxScan', () => {
  const records = Array.from({ length: 20 }, () => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] },
  }));
  assert.equal(extractCodexTitle(records, 20), null);
});

test('loadCodexIndex builds an id -> thread_name map, later duplicate wins', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'session_index.jsonl');
  fsForTests.writeFileSync(
    filePath,
    [
      JSON.stringify({ id: 'aaa', thread_name: '舊名稱', updated_at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ id: 'bbb', thread_name: '另一個', updated_at: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ id: 'aaa', thread_name: '新名稱', updated_at: '2026-02-01T00:00:00Z' }),
    ].join('\n'),
    'utf8'
  );
  const map = loadCodexIndex(filePath);
  assert.equal(map.get('aaa'), '新名稱');
  assert.equal(map.get('bbb'), '另一個');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('loadCodexIndex returns an empty map when the index file does not exist', () => {
  assert.equal(loadCodexIndex('C:\\does\\not\\exist.jsonl').size, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — new functions not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/session-dashboard.js`, above `module.exports`:

```js
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
  return CODEX_SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
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
```

Update `module.exports` to also include `extractResponseItemText, isSyntheticCodexText, extractCodexTitle, loadCodexIndex`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 36 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增 Codex 標題擷取規則與 session_index dedup 邏輯"
```

---

### Task 5: Codex file and directory scanning

**Files:**
- Modify: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Consumes: `readFirstJsonLines`, `extractCodexTitle`, `loadCodexIndex`, `walkJsonlFiles`, `normalizeGroupKey`, `displayNameForCwd` (Tasks 1–4)
- Produces: `scanCodexFile(filePath: string, indexMap: Map<string,string>, homeDir: string): SessionRecord`, `scanCodex(codexHomeDir: string): { sessions: SessionRecord[], skipped: number }`

- [ ] **Step 1: Write the failing tests**

Append to `src/session-dashboard.test.js`:

```js
const { scanCodexFile, scanCodex } = require('./session-dashboard.js');

test('scanCodexFile prefers the session_index thread_name when present', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', '2026', '07', '10', 'rollout-x.jsonl');
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-1', cwd: 'C:\\work\\api', git: { branch: 'master' } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] } },
  ]);
  const indexMap = new Map([['sess-1', '修 API bug']]);
  const session = scanCodexFile(filePath, indexMap, 'C:\\Users\\sjack');
  assert.equal(session.tool, 'codex');
  assert.equal(session.id, 'sess-1');
  assert.equal(session.title, '修 API bug');
  assert.equal(session.cwd, 'C:\\work\\api');
  assert.equal(session.branch, 'master');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile falls back to file-scan title, then basename+timestamp, when index has no entry', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-y.jsonl');
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-2', cwd: 'C:\\work\\other', git: {} } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '幫我加個功能' }] } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.title, '幫我加個功能');
  assert.equal(session.branch, null, 'empty git object has no branch');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile handles a missing session_meta record gracefully', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-z.jsonl');
  writeJsonl(filePath, [
    { type: 'event_msg', payload: { type: 'task_started' } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.id, 'rollout-z');
  assert.equal(session.cwd, 'C:\\Users\\sjack');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile throws when the file contains zero parseable JSON records', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'garbage.jsonl');
  fsForTests.mkdirSync(pathForTests.dirname(filePath), { recursive: true });
  fsForTests.writeFileSync(filePath, 'not json\nstill not json', 'utf8');
  assert.throws(() => scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack'));
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodex reads both sessions/ (nested) and archived_sessions/ (flat), dedupes via index once', () => {
  const dir = makeTempDir();
  writeJsonl(pathForTests.join(dir, 'sessions', '2026', '07', '10', 'rollout-a.jsonl'), [
    { type: 'session_meta', payload: { id: 'a1', cwd: 'C:\\work\\proj' } },
  ]);
  writeJsonl(pathForTests.join(dir, 'archived_sessions', 'rollout-b.jsonl'), [
    { type: 'session_meta', payload: { id: 'b1', cwd: 'C:\\work\\proj' } },
  ]);
  writeJsonl(pathForTests.join(dir, 'session_index.jsonl'), [
    { id: 'a1', thread_name: 'A 任務' },
    { id: 'b1', thread_name: 'B 任務' },
  ]);
  const { sessions, skipped } = scanCodex(dir);
  assert.equal(sessions.length, 2);
  assert.equal(skipped, 0);
  const titles = sessions.map((s) => s.title).sort();
  assert.deepEqual(titles, ['A 任務', 'B 任務']);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodex returns empty result without throwing when ~/.codex does not exist', () => {
  const dir = makeTempDir();
  const missingCodexDir = pathForTests.join(dir, 'does-not-exist');
  const { sessions, skipped } = scanCodex(missingCodexDir);
  assert.deepEqual(sessions, []);
  assert.equal(skipped, 0);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodex skips a file with zero parseable JSON and counts it, still returns the good ones', () => {
  const dir = makeTempDir();
  writeJsonl(pathForTests.join(dir, 'sessions', 'good.jsonl'), [
    { type: 'session_meta', payload: { id: 'g1', cwd: 'C:\\work\\proj' } },
  ]);
  fsForTests.writeFileSync(pathForTests.join(dir, 'sessions', 'broken.jsonl'), 'not json\nstill not json', 'utf8');

  const { sessions, skipped } = scanCodex(dir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'g1');
  assert.equal(skipped, 1);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — `scanCodexFile`, `scanCodex` not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/session-dashboard.js`, above `module.exports`:

```js
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

function scanCodex(codexHomeDir) {
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
      sessions.push(scanCodexFile(file, indexMap, codexHomeDir));
    } catch (err) {
      skipped += 1;
    }
  }
  return { sessions, skipped };
}
```

Update `module.exports` to also include `scanCodexFile, scanCodex`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 43 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增 Codex 目錄掃描（sessions + archived_sessions，含 index fallback）"
```

---

### Task 6: HTML dashboard builder

**Files:**
- Modify: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Consumes: `embedJsonSafely`, `escapeHtml` (Task 1), the `SessionRecord` shape (Tasks 3, 5)
- Produces: `buildHtml(sessions: SessionRecord[], meta?: { generatedAt?: string, skippedCount?: number }): string`

- [ ] **Step 1: Write the failing tests**

Append to `src/session-dashboard.test.js`:

```js
const { buildHtml } = require('./session-dashboard.js');

test('buildHtml embeds session data without a raw </script> breakout', () => {
  const sessions = [
    {
      tool: 'claude-code',
      id: 'abc',
      title: '</script><script>alert(1)</script>',
      cwd: 'C:\\work\\<proj>',
      branch: null,
      groupKey: 'c:/work/proj',
      displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z',
      lastActiveAt: '2026-08-01T01:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T00:00:00.000Z', skippedCount: 0 });
  assert.ok(!html.includes('</script><script>alert(1)</script>'), 'dangerous string must not appear raw');
  assert.ok(html.includes('\\u003c/script\\u003e'));
  assert.ok(html.includes('<title>Session'));
});

test('buildHtml includes generatedAt and skippedCount in the embedded payload', () => {
  const html = buildHtml([], { generatedAt: '2026-08-02T00:00:00.000Z', skippedCount: 3 });
  assert.ok(html.includes('"generatedAt":"2026-08-02T00:00:00.000Z"'));
  assert.ok(html.includes('"skippedCount":3'));
});

test('buildHtml defaults generatedAt/skippedCount when meta is omitted', () => {
  const html = buildHtml([]);
  assert.ok(html.includes('"skippedCount":0'));
  assert.ok(/"generatedAt":"\d{4}-\d{2}-\d{2}T/.test(html));
});

test('buildHtml embeds every session field needed by the front end', () => {
  const sessions = [
    {
      tool: 'codex', id: 'xyz', title: '正常標題', cwd: 'C:\\work\\proj', branch: 'main',
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T01:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions);
  for (const field of ['tool', 'id', 'title', 'cwd', 'branch', 'groupKey', 'displayName', 'startedAt', 'lastActiveAt']) {
    assert.ok(html.includes(`"${field}"`), `missing field ${field}`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — `buildHtml` not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/session-dashboard.js`, above `module.exports`:

```js
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

      var groups = new Map();
      filtered.forEach(function (s) {
        if (!groups.has(s.groupKey)) groups.set(s.groupKey, []);
        groups.get(s.groupKey).push(s);
      });

      groups.forEach(function (items, groupKey) {
        var groupTitle = document.createElement('div');
        groupTitle.className = 'group-title';
        groupTitle.textContent = groupKey === '__misc__' ? '雜項/隨手' : items[0].displayName;
        app.appendChild(groupTitle);

        items.forEach(function (s) {
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
```

Update `module.exports` to also include `buildHtml`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 47 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增儀表板 HTML 產生器（安全跳脫 + 搜尋/篩選/排序前端）"
```

---

### Task 7: Atomic write

**Files:**
- Modify: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Produces: `writeAtomic(targetPath: string, content: string): void`

- [ ] **Step 1: Write the failing tests**

Append to `src/session-dashboard.test.js`:

```js
const { writeAtomic } = require('./session-dashboard.js');

test('writeAtomic writes the final content to the target path', () => {
  const dir = makeTempDir();
  const target = pathForTests.join(dir, 'out.html');
  writeAtomic(target, '<html>v1</html>');
  assert.equal(fsForTests.readFileSync(target, 'utf8'), '<html>v1</html>');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic leaves no leftover .tmp files after a successful write', () => {
  const dir = makeTempDir();
  const target = pathForTests.join(dir, 'out.html');
  writeAtomic(target, '<html>v1</html>');
  const leftovers = fsForTests.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('writeAtomic uses a unique temp filename per call (no fixed shared name)', () => {
  const dir = makeTempDir();
  const target = pathForTests.join(dir, 'out.html');
  writeAtomic(target, '<html>v1</html>');
  writeAtomic(target, '<html>v2</html>');
  // Both calls must succeed without throwing, and the final content is a complete write, never a mix.
  const finalContent = fsForTests.readFileSync(target, 'utf8');
  assert.ok(finalContent === '<html>v1</html>' || finalContent === '<html>v2</html>');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — `writeAtomic` not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/session-dashboard.js`, above `module.exports`:

```js
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
```

Update `module.exports` to also include `writeAtomic`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 50 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增輸出原子寫入（獨立暫存檔名 + rename）"
```

---

### Task 8: CLI entry point (`main`)

**Files:**
- Modify: `src/session-dashboard.js`
- Test: `src/session-dashboard.test.js`

**Interfaces:**
- Consumes: `parseArgs`, `scanClaudeCode`, `scanCodex`, `buildHtml`, `writeAtomic` (Tasks 1, 3, 5, 6, 7)
- Produces: `main(argv: string[], options?: { claudeHomeDir?: string, codexHomeDir?: string, openBrowser?: (targetPath: string) => void }): { targetPath: string, sessionCount: number, skippedCount: number }`

`options` lets tests inject fixture directories and a no-op browser opener instead of touching the real `~/.claude`, `~/.codex`, and the real OS "open in browser" call — `main` defaults every option to the real thing when not given, which is what the deployed script uses.

- [ ] **Step 1: Write the failing tests**

Append to `src/session-dashboard.test.js`:

```js
const { main } = require('./session-dashboard.js');

test('main scans both sources, writes the dashboard, and skips opening the browser in --quiet mode', () => {
  const dir = makeTempDir();
  const claudeHomeDir = pathForTests.join(dir, 'claude-home');
  const codexHomeDir = pathForTests.join(dir, 'codex-home');
  writeJsonl(pathForTests.join(claudeHomeDir, 'projects', 'proj', 'aaa.jsonl'), [
    { type: 'user', cwd: 'C:\\work\\proj', gitBranch: 'main', message: { content: '第一個 session' } },
  ]);
  writeJsonl(pathForTests.join(codexHomeDir, 'sessions', 'rollout-bbb.jsonl'), [
    { type: 'session_meta', payload: { id: 'bbb', cwd: 'C:\\work\\proj' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二個 session' }] } },
  ]);

  let browserOpened = false;
  const result = main(['--quiet'], {
    claudeHomeDir,
    codexHomeDir,
    openBrowser: () => { browserOpened = true; },
  });

  assert.equal(browserOpened, false, '--quiet must not open the browser');
  assert.equal(result.sessionCount, 2);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.targetPath, pathForTests.join(claudeHomeDir, 'sessions-dashboard.html'));
  const html = fsForTests.readFileSync(result.targetPath, 'utf8');
  assert.ok(html.includes('第一個 session'));
  assert.ok(html.includes('第二個 session'));
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('main opens the browser when --quiet is not passed', () => {
  const dir = makeTempDir();
  const claudeHomeDir = pathForTests.join(dir, 'claude-home');
  const codexHomeDir = pathForTests.join(dir, 'codex-home-missing');
  writeJsonl(pathForTests.join(claudeHomeDir, 'projects', 'proj', 'ccc.jsonl'), [
    { type: 'user', cwd: 'C:\\work\\proj', message: { content: '一個 session' } },
  ]);

  let openedPath = null;
  main([], { claudeHomeDir, codexHomeDir, openBrowser: (p) => { openedPath = p; } });

  assert.equal(openedPath, pathForTests.join(claudeHomeDir, 'sessions-dashboard.html'));
  fsForTests.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/session-dashboard.test.js`
Expected: FAIL — `main` not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add to `src/session-dashboard.js`, above `module.exports`, and add the `require.main` guard at the very end of the file:

```js
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

  const claudeResult = scanClaudeCode(claudeHomeDir);
  const codexResult = scanCodex(codexHomeDir);
  const sessions = [...claudeResult.sessions, ...codexResult.sessions];
  const skippedCount = claudeResult.skipped + codexResult.skipped;

  const html = buildHtml(sessions, { generatedAt: new Date().toISOString(), skippedCount });
  const targetPath = path.join(claudeHomeDir, 'sessions-dashboard.html');
  writeAtomic(targetPath, html);

  if (!quiet) openBrowser(targetPath);

  return { targetPath, sessionCount: sessions.length, skippedCount };
}
```

At the very end of `src/session-dashboard.js`, after `module.exports = {...}`:

```js
if (require.main === module) {
  main(process.argv.slice(2));
}
```

Update `module.exports` to also include `main`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/session-dashboard.test.js`
Expected: PASS — 52 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/session-dashboard.js src/session-dashboard.test.js
git commit -m "新增 CLI 進入點 main()，整合掃描/產生/寫入/開瀏覽器"
```

---

### Task 9: Slash command file

**Files:**
- Create: `commands/sessions.md`

**Interfaces:** none (static file, no code).

- [ ] **Step 1: Create the command file**

Create `commands/sessions.md`:

```markdown
---
description: 重新整理並開啟 Session 管理器儀表板（Claude Code + Codex）。
allowed-tools: Bash(node:*)
---

Run:

```bash
node "$HOME/.claude/scripts/session-dashboard.js"
```

Then tell the user the dashboard has been refreshed and opened in their browser. If the command's output mentions skipped files, mention the count to the user.
```

- [ ] **Step 2: Commit**

```bash
git add commands/sessions.md
git commit -m "新增 /sessions 斜線指令定義"
```

---

### Task 10: Hook installer (pure logic + tests)

**Files:**
- Create: `src/install-session-dashboard-hooks.js`
- Test: `src/install-session-dashboard-hooks.test.js`

**Interfaces:**
- Consumes: `writeAtomic(targetPath: string, content: string): void` (Task 7, imported from `./session-dashboard.js` — installing a hook writes a live, shared config file, so it gets the same atomic temp-file+rename safety as the dashboard output).
- Produces: `addSessionStartHookEntry(hooksConfig: object, newEntry: object): { config: object, changed: boolean }`, `backupFile(filePath: string): string`, `installIntoFile(filePath: string, newEntry: object): { changed: boolean, backupPath: string|null }`

- [ ] **Step 1: Write the failing tests**

Create `src/install-session-dashboard-hooks.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addSessionStartHookEntry, backupFile, installIntoFile } = require('./install-session-dashboard-hooks.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdhooktest-'));
}

const OUR_ENTRY = {
  matcher: '',
  hooks: [{ type: 'command', command: '& "node.exe" "session-dashboard.js" --quiet', async: true, timeout: 15 }],
};

test('addSessionStartHookEntry appends to an empty config', () => {
  const { config, changed } = addSessionStartHookEntry({}, OUR_ENTRY);
  assert.equal(changed, true);
  assert.equal(config.hooks.SessionStart.length, 1);
  assert.equal(config.hooks.SessionStart[0], OUR_ENTRY);
});

test('addSessionStartHookEntry preserves an existing unrelated hook entry (e.g. the pet companion)', () => {
  const existing = {
    hooks: {
      SessionStart: [
        { matcher: '', hooks: [{ type: 'command', command: '"pet-companion.exe" --hook --state idle --event session-start', async: true, timeout: 5 }] },
      ],
    },
  };
  const { config, changed } = addSessionStartHookEntry(existing, OUR_ENTRY);
  assert.equal(changed, true);
  assert.equal(config.hooks.SessionStart.length, 2);
  assert.ok(config.hooks.SessionStart[0].hooks[0].command.includes('pet-companion.exe'), 'existing entry must survive untouched');
  assert.equal(config.hooks.SessionStart[1], OUR_ENTRY);
});

test('addSessionStartHookEntry is idempotent — running twice does not duplicate', () => {
  const first = addSessionStartHookEntry({}, OUR_ENTRY);
  const second = addSessionStartHookEntry(first.config, OUR_ENTRY);
  assert.equal(second.changed, false);
  assert.equal(second.config.hooks.SessionStart.length, 1);
});

test('addSessionStartHookEntry preserves unrelated top-level config keys', () => {
  const existing = { enabledPlugins: { foo: true }, hooks: { Notification: [{ matcher: '', hooks: [] }] } };
  const { config } = addSessionStartHookEntry(existing, OUR_ENTRY);
  assert.deepEqual(config.enabledPlugins, { foo: true });
  assert.deepEqual(config.hooks.Notification, [{ matcher: '', hooks: [] }]);
});

test('backupFile copies the file to a timestamped .bak path and leaves the original untouched', () => {
  const dir = makeTempDir();
  const original = path.join(dir, 'settings.json');
  fs.writeFileSync(original, '{"a":1}', 'utf8');
  const backupPath = backupFile(original);
  assert.ok(fs.existsSync(backupPath));
  assert.ok(backupPath.startsWith(original));
  assert.equal(fs.readFileSync(backupPath, 'utf8'), '{"a":1}');
  assert.equal(fs.readFileSync(original, 'utf8'), '{"a":1}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installIntoFile backs up and writes when a change is needed', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'settings.json');
  fs.writeFileSync(filePath, JSON.stringify({ hooks: {} }), 'utf8');
  const result = installIntoFile(filePath, OUR_ENTRY);
  assert.equal(result.changed, true);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.hooks.SessionStart.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installIntoFile is idempotent on a second run — no duplicate entry, no second backup', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'settings.json');
  fs.writeFileSync(filePath, JSON.stringify({ hooks: {} }), 'utf8');
  installIntoFile(filePath, OUR_ENTRY);
  const second = installIntoFile(filePath, OUR_ENTRY);
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, null);
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(written.hooks.SessionStart.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/install-session-dashboard-hooks.test.js`
Expected: FAIL — `src/install-session-dashboard-hooks.js` does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `src/install-session-dashboard-hooks.js`:

```js
#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeAtomic } = require('./session-dashboard.js');

const MARKER = 'session-dashboard.js';

function addSessionStartHookEntry(hooksConfig, newEntry) {
  const config = hooksConfig && typeof hooksConfig === 'object' ? hooksConfig : {};
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];

  const alreadyInstalled = sessionStart.some(
    (group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(MARKER))
  );

  if (alreadyInstalled) {
    return { config: { ...config, hooks: { ...hooks, SessionStart: sessionStart } }, changed: false };
  }

  return {
    config: { ...config, hooks: { ...hooks, SessionStart: [...sessionStart, newEntry] } },
    changed: true,
  };
}

function backupFile(filePath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak-session-dashboard-${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function installIntoFile(filePath, newEntry) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const { config, changed } = addSessionStartHookEntry(parsed, newEntry);
  if (!changed) return { changed: false, backupPath: null };

  const backupPath = backupFile(filePath);
  writeAtomic(filePath, JSON.stringify(config, null, 2) + '\n');
  return { changed: true, backupPath };
}

function main() {
  const homeDir = os.homedir();
  const nodePath = process.execPath;
  const scriptPath = path.join(homeDir, '.claude', 'scripts', 'session-dashboard.js');

  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  const claudeEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: `& "${nodePath}" "${scriptPath}" --quiet`, async: true, timeout: 15 }],
  };
  const claudeResult = installIntoFile(claudeSettingsPath, claudeEntry);
  console.log(
    claudeResult.changed
      ? `已在 ${claudeSettingsPath} 新增 SessionStart hook（備份於 ${claudeResult.backupPath}）`
      : `${claudeSettingsPath} 已經裝過，略過`
  );

  const codexHooksPath = path.join(homeDir, '.codex', 'hooks.json');
  if (fs.existsSync(codexHooksPath)) {
    const codexEntry = {
      hooks: [{ type: 'command', command: `& "${nodePath}" "${scriptPath}" --quiet`, timeout: 15 }],
    };
    const codexResult = installIntoFile(codexHooksPath, codexEntry);
    console.log(
      codexResult.changed
        ? `已在 ${codexHooksPath} 新增 SessionStart hook（備份於 ${codexResult.backupPath}）`
        : `${codexHooksPath} 已經裝過，略過`
    );
  } else {
    console.log(`找不到 ${codexHooksPath}，略過 Codex hook 安裝`);
  }
}

module.exports = { addSessionStartHookEntry, backupFile, installIntoFile };

if (require.main === module) {
  main();
}
```

Note: Codex's `hooks.json` entries have no `matcher` key (confirmed against the real file) — `claudeEntry` includes `matcher: ''` to match Claude's `settings.json` shape, `codexEntry` deliberately omits it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/install-session-dashboard-hooks.test.js`
Expected: PASS — 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/install-session-dashboard-hooks.js src/install-session-dashboard-hooks.test.js
git commit -m "新增 SessionStart hook 安裝器（新增式、備份、可重複執行）"
```

---

### Task 11: Deploy to the real environment (requires user confirmation before the live-file step)

**Files:**
- Copy: `src/session-dashboard.js` → `~/.claude/scripts/session-dashboard.js`
- Copy: `commands/sessions.md` → `~/.claude/commands/sessions.md`
- Modify (live, via installer): `~/.claude/settings.json`, `~/.codex/hooks.json`

**Interfaces:** none — this task runs the already-tested code against real paths.

**⚠ Before running Step 3 against the real `~/.claude/settings.json` and `~/.codex/hooks.json`: show the user the exact hook entry that will be appended and get explicit confirmation.** These are live, currently-in-use config files (the pet companion and "Clawd on Desk" hooks already run from them) — Tasks 1–10 never touched them, only fixtures. This is the one step in the whole plan with real, if backed-up, blast radius.

- [ ] **Step 1: Run the full test suite once more before touching anything real**

Run: `node --test src/`
Expected: PASS — 59 tests total (52 in `src/session-dashboard.test.js` from Tasks 1–8, plus 7 in `src/install-session-dashboard-hooks.test.js` from Task 10).

- [ ] **Step 2: Copy the script and slash command into place**

```bash
mkdir -p ~/.claude/scripts
cp "src/session-dashboard.js" ~/.claude/scripts/session-dashboard.js
cp "commands/sessions.md" ~/.claude/commands/sessions.md
```

- [ ] **Step 3: Show the user the diff, get confirmation, then run the hook installer against the real files**

Print what will change (the exact `command` string that will be appended, and which two files will be backed up), wait for explicit user go-ahead, then:

```bash
node src/install-session-dashboard-hooks.js
```

Expected console output: two lines confirming a hook entry was appended to `~/.claude/settings.json` and `~/.codex/hooks.json`, each naming a `.bak-session-dashboard-<timestamp>` backup path.

- [ ] **Step 4: Verify the existing hooks survived**

```bash
node -e "const s=require('./src/install-session-dashboard-hooks.js'); const fs=require('fs'); const os=require('os'); const path=require('path'); const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude','settings.json'),'utf8')); console.log(JSON.stringify(cfg.hooks.SessionStart, null, 2));"
```

Expected: the array contains **two** entries — the original pet-companion entry (`claude-pet-companion.exe`) and the new one (`session-dashboard.js`). Repeat conceptually for `~/.codex/hooks.json`, expecting the original "Clawd on Desk" entry plus the new one.

- [ ] **Step 5: Manually run `/sessions` and confirm the dashboard**

Run the `/sessions` slash command (or directly `node ~/.claude/scripts/session-dashboard.js`). Confirm:
- The browser opens `~/.claude/sessions-dashboard.html`.
- Sessions from both Claude Code and Codex appear, grouped by project.
- A project with a Chinese-character folder name (e.g. 「經營模擬遊戲」) shows a readable Chinese display name, not an encoded folder name.
- Clicking "複製續接指令" on a card copies a `Set-Location -LiteralPath '...'; claude --resume <id>` (or `codex resume <id>`) string (single-quoted); pasting it into a fresh PowerShell 5.1 window and running it lands in the right directory and resumes the right session.
- Specifically test one session whose `cwd` contains a `$` or a space (e.g. create a throwaway folder like `C:\Users\sjack\Documents\$test folder` and start a one-line Claude Code session in it, or reuse an existing path with a space) — copy its resume command and confirm `Set-Location` lands in the correct directory rather than silently expanding `$test` as an empty PowerShell variable. This exercises the single-quote escaping fix from the round-1 review, which only the manual step covers (front-end JS isn't unit-tested per the spec's own test plan).

- [ ] **Step 6: Record the deploy in the repo**

The copied files under `~/.claude/` are outside this git repo (that directory isn't a repo), so there is nothing to `git add` from the copy step itself — append a dated deploy record instead of running an empty `git commit`:

```bash
mkdir -p docs
cat >> docs/deploy-log.md <<EOF

## $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Deployed session-dashboard.js and sessions.md to ~/.claude/
- Ran install-session-dashboard-hooks.js — appended SessionStart hooks to ~/.claude/settings.json and ~/.codex/hooks.json (existing pet-companion / Clawd on Desk entries preserved)
- Verified /sessions opens the dashboard with sessions from both tools, including a $-in-path resume command
EOF
git add docs/deploy-log.md
git commit -m "記錄 Session 管理器部署完成"
```

---

## Self-Review Notes

**Spec coverage:** 架構與觸發（Task 8, 11）、資料來源含 Claude/Codex 標題規則（Task 2, 4）、分類與卡片內容含分組/續接指令/XSS 安全（Task 1, 6）、邊界情況（Task 3, 5 的壞檔跳過與 `~/.codex` 缺失處理）、測試計畫的七個項目（都對應到 Task 2–6, 10 的具體測試案例）全部有對應任務。唯一在 spec 之外新增的是「Codex fallback 標題掃描視窗保持 N=20、大多數情況會退回 basename+時間戳」——這是根據真實資料驗證後的實作細節澄清，不是功能刪減，已在文件開頭的「Real-data finding」段落交代原因。

**Placeholder scan:** 無 TBD/TODO；每個 step 都含完整可執行程式碼。

**Type consistency：** `SessionRecord` 形狀（`tool/id/title/cwd/branch/groupKey/displayName/startedAt/lastActiveAt`）在 Task 3、5、6、8 全程一致；`scanClaudeCode`/`scanCodex` 都回傳 `{sessions, skipped}`；`buildResumeCommand`（Task 1）與卡片按鈕內重複實作的瀏覽器端組字串（Task 6）採同一種單引號 PowerShell 語法與同一種跳脫規則（`'` 加倍），未出現兩套不同格式——瀏覽器端無法 `require()` Node 模組，所以這段邏輯無法真的去重，僅能保持手動同步，已在程式碼註解中標明。

**Post-round-1-review fixes (codex-peer-review):** 修正了 7 個問題中的 6 個——`readFirstJsonLines` 改成有界的分塊讀取（不再整檔載入）、Claude 標題過濾清單補上 `<command-name>`/`<local-command-stdout>`/`<local-command-stderr>`（皆已對照本機真實 transcript 驗證存在）、`scanClaudeCodeFile`/`scanCodexFile` 在零筆可解析記錄時改為 throw（讓 `skipped` 計數正確反映全毀檔案）、Task 3 原本用資料夾偽裝 `.jsonl` 的壞檔測試（`walkJsonlFiles` 的 `isFile()` 檢查會直接濾掉目錄，測試永遠不會觸發被測邏輯）換成真正會讓程式碼路徑執行到的壞檔內容、續接指令改用單引號 PowerShell 字串並跳脫內嵌單引號（避免路徑中的 `$`／反引號被誤判為變數展開）、Task 10 的 hook 安裝也採用已有的 `writeAtomic`、Task 11 移除了一個必然失敗的空 `git commit` 步驟改為寫部署紀錄。對 Codex fallback 標題掃描深度（第 4 個問題）採取推翻——理由記錄在下方 codex-peer-review 對話與文件開頭的「Real-data finding」段落，codex 第二輪已 CONCEDE。

**Round 2 額外發現並修正：** 分塊讀取以 buffer 而非字串累積，只在確定切到完整行（即遇到單一位元組的 `\n`）時才呼叫一次 `.toString('utf8')`，避免中文等多位元組字元剛好卡在 64KB 邊界被拆成亂碼（`�`）；新增針對此邊界情況的專門測試。也修正了先前殘留、寫死沒跟著更新的測試總數。

<!-- codex-peer-reviewed: 2026-08-02T02:55:47Z rounds=3 verdict=approved -->
