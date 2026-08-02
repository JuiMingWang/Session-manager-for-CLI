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
