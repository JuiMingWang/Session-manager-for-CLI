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
