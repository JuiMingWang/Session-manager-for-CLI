'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
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

// Regression test for a real misclassification found during manual browser QA of the deployed
// dashboard: a Codex session's title showed up as an injected "# AGENTS.md instructions ..."
// block instead of a real human message or a basename+timestamp fallback. The known-prefix
// whitelist can never be exhaustive — new injection formats appear whenever a tool/IDE changes
// what it prepends. This adds a structural fallback: long text that opens with a markdown
// heading or an XML-like tag, or contains multiple markdown heading lines, is treated as an
// injected document rather than a human message — regardless of whether its specific prefix
// is on the whitelist. The length gate (150 chars) exists so a short genuine message that
// merely starts with "#" or "<" (e.g. a real one-line question about some markup) isn't
// wrongly rejected — only long, structurally document-shaped text is flagged this way.
test('isSyntheticClaudeText flags an unrecognized long injected document by structure (length + heading/tag opener), not just by prefix whitelist', () => {
  // Real example captured from this machine's own Codex session data (a genuine AGENTS.md
  // injection this machine's tooling produces) — not on any prefix list, would previously
  // have been accepted as a real title.
  const realInjectedAgentsMd =
    '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n1.盡量輸出簡潔，說明重點。\n2.每完成我要求的代碼修改時，需建立一個Git，並且Git的名稱須以簡潔中文呈現。\n3.每次展開一個新的項目時，需主動問我是否要將任務拆分成多個簡單任務執行。\n4.寫代碼時，變數命名須明確，註釋要清晰。\n5.寫項目的時候，盡量以架構師的假度去考慮，不要產生超大文件。數據結構要精簡、結構邏輯要合理。\n6.確實按照規畫的去執行。\n7.在開始進行代碼修改與編寫前，需簡潔地向我提出修改方法以及問我是否需要將任務拆分。\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>C:\\Users\\sjack\\OneDrive\\Documents\\PDF名稱修改</cwd>\n</environment_context>';
  assert.equal(isSyntheticClaudeText(realInjectedAgentsMd), true);
});

test('isSyntheticClaudeText does NOT flag a short genuine message merely because it starts with # or <', () => {
  assert.equal(isSyntheticClaudeText('#urgent 這個功能壞了，麻煩幫我看一下'), false);
  assert.equal(isSyntheticClaudeText('<div> 這個標籤在我的畫面上沒有正確渲染，為什麼？'), false);
});

test('isSyntheticClaudeText does NOT flag a long genuine message that has no heading/tag structure', () => {
  const longGenuineMessage =
    '我這邊想把整個資料匯入流程重新設計一下，目前的做法是先讀取 CSV，再逐行寫入資料庫，這樣速度太慢，' +
    '想改成批次寫入，並且加上失敗重試機制，你覺得這個方向合理嗎？順便也想問一下要不要加上進度條顯示，' +
    '另外我也在想是不是該把這個流程拆成兩個獨立的服務，一個專門負責匯入、一個負責驗證資料正確性，這樣未來比較好維護。';
  assert.ok(longGenuineMessage.length > 150, 'sanity check: must actually exceed the length gate');
  assert.equal(isSyntheticClaudeText(longGenuineMessage), false);
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
  assert.equal(session.titleIsFallback, false, '真實標題不應標記為退而標題');

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
  assert.equal(session.titleIsFallback, true, '退回資料夾名+時間戳應標記為退而標題');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile sets pathExists true when the recorded cwd directory still exists on disk', () => {
  const dir = makeTempDir();
  const realProjectDir = pathForTests.join(dir, 'real-project');
  fsForTests.mkdirSync(realProjectDir, { recursive: true });
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'exists-123.jsonl');
  writeJsonl(filePath, [
    { type: 'user', cwd: realProjectDir, message: { content: '這個資料夾還在' } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.pathExists, true, '真實存在的資料夾應標記為 pathExists: true');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile sets pathExists false when the recorded cwd directory no longer exists on disk', () => {
  const dir = makeTempDir();
  const missingProjectDir = pathForTests.join(dir, 'deleted-project');
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'missing-456.jsonl');
  writeJsonl(filePath, [
    { type: 'user', cwd: missingProjectDir, message: { content: '這個資料夾已經刪掉了' } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.pathExists, false, '已刪除的資料夾應標記為 pathExists: false');
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

// Regression test for a real bug found during manual browser QA of the deployed dashboard:
// main() was passing claudeHomeDir/codexHomeDir (e.g. ~/.claude, ~/.codex) as the "homeDir"
// grouping reference into scanClaudeCode/scanCodex, instead of the real OS home directory
// (~/). Because those two paths are never equal, every home-directory session (the exact
// case this whole tool was built to declutter) silently failed to group as "misc" and
// instead got its own group literally titled after the home folder's basename.
test('scanClaudeCode groups a home-directory session as misc using a real home dir distinct from claudeHomeDir', () => {
  const dir = makeTempDir();
  const claudeHomeDir = pathForTests.join(dir, 'claude-home');
  const realHomeDir = 'C:\\Users\\sjack';
  writeJsonl(pathForTests.join(claudeHomeDir, 'projects', 'C--Users-sjack', 'home-session.jsonl'), [
    { type: 'user', cwd: realHomeDir, message: { content: '隨手問一個小問題' } },
  ]);
  const { sessions } = scanClaudeCode(claudeHomeDir, realHomeDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].groupKey, '__misc__');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCode does NOT default the grouping reference to claudeHomeDir when realHomeDir is passed explicitly (guards against reintroducing the bug)', () => {
  const dir = makeTempDir();
  const claudeHomeDir = pathForTests.join(dir, 'claude-home');
  const realHomeDir = pathForTests.join(dir, 'a-completely-different-real-home');
  writeJsonl(pathForTests.join(claudeHomeDir, 'projects', 'proj', 'a.jsonl'), [
    { type: 'user', cwd: claudeHomeDir, message: { content: '這個 cwd 剛好等於 claudeHomeDir，不該被誤判成 misc' } },
  ]);
  const { sessions } = scanClaudeCode(claudeHomeDir, realHomeDir);
  assert.notEqual(sessions[0].groupKey, '__misc__');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

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

// Regression test for a real misclassification found during manual browser QA: a Codex
// session's title showed up as a raw "# AGENTS.md instructions ..." injection block, which
// is not on CODEX_SYNTHETIC_PREFIXES (that list only covers environment_context/recommended_
// plugins/permissions-instructions/IDE-tabs — the actual set of injected formats real tools
// produce is not exhaustively enumerable). Same structural fallback as the Claude Code side:
// long text opening with a heading/tag, or containing multiple heading lines, is treated as
// an injected document regardless of whether its specific prefix was ever seen before.
test('isSyntheticCodexText flags an unrecognized long injected document by structure, not just by prefix whitelist', () => {
  // Real example captured from this machine's own Codex rollout data.
  const realInjectedAgentsMd =
    '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n1.盡量輸出簡潔，說明重點。\n2.每完成我要求的代碼修改時，需建立一個Git，並且Git的名稱須以簡潔中文呈現。\n3.每次展開一個新的項目時，需主動問我是否要將任務拆分成多個簡單任務執行。\n4.寫代碼時，變數命名須明確，註釋要清晰。\n5.寫項目的時候，盡量以架構師的假度去考慮，不要產生超大文件。數據結構要精簡、結構邏輯要合理。\n6.確實按照規畫的去執行。\n7.在開始進行代碼修改與編寫前，需簡潔地向我提出修改方法以及問我是否需要將任務拆分。\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>C:\\Users\\sjack\\OneDrive\\Documents\\PDF名稱修改</cwd>\n</environment_context>';
  assert.equal(isSyntheticCodexText(realInjectedAgentsMd), true);
});

test('isSyntheticCodexText does NOT flag a short genuine message merely because it starts with # or <', () => {
  assert.equal(isSyntheticCodexText('#urgent 這個功能壞了，麻煩幫我看一下'), false);
  assert.equal(isSyntheticCodexText('<div> 這個標籤在我的畫面上沒有正確渲染，為什麼？'), false);
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
  assert.equal(session.titleIsFallback, false, 'index thread_name 不應標記為退而標題');
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
  assert.equal(session.titleIsFallback, false, 'extractCodexTitle 找到的真實標題不應標記為退而標題');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile falls back to basename+timestamp title when neither index nor file scan find a real title', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-w.jsonl');
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-3', cwd: 'C:\\work\\other-thing', git: {} } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.ok(session.title.startsWith('other-thing ('), session.title);
  assert.equal(session.titleIsFallback, true, '退回資料夾名+時間戳應標記為退而標題');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile sets pathExists true when the recorded cwd directory still exists on disk', () => {
  const dir = makeTempDir();
  const realProjectDir = pathForTests.join(dir, 'real-project');
  fsForTests.mkdirSync(realProjectDir, { recursive: true });
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-exists.jsonl');
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-exists', cwd: realProjectDir } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.pathExists, true, '真實存在的資料夾應標記為 pathExists: true');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile sets pathExists false when the recorded cwd directory no longer exists on disk', () => {
  const dir = makeTempDir();
  const missingProjectDir = pathForTests.join(dir, 'deleted-project');
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-missing.jsonl');
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-missing', cwd: missingProjectDir } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.pathExists, false, '已刪除的資料夾應標記為 pathExists: false');
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

// Same regression as scanClaudeCode's home-directory misc-grouping bug, for the Codex adapter.
test('scanCodex groups a home-directory session as misc using a real home dir distinct from codexHomeDir', () => {
  const dir = makeTempDir();
  const codexHomeDir = pathForTests.join(dir, 'codex-home');
  const realHomeDir = 'C:\\Users\\sjack';
  writeJsonl(pathForTests.join(codexHomeDir, 'sessions', 'home-session.jsonl'), [
    { type: 'session_meta', payload: { id: 'h1', cwd: realHomeDir } },
  ]);
  const { sessions } = scanCodex(codexHomeDir, realHomeDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].groupKey, '__misc__');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

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

test('buildHtml includes a prefers-color-scheme: dark media query', () => {
  const html = buildHtml([]);
  assert.ok(html.includes('@media (prefers-color-scheme: dark)'));
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

// Minimal DOM stub to actually execute buildHtml's embedded front-end <script>
// via node:vm, instead of only asserting on substrings of the generated source.
// This exact render/clustering code has caused two real regressions before
// (misc-grouping wiring, duplicate cards) that shallow string checks missed,
// so behavioral execution is worth the small amount of extra harness code.
function makeFakeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    open: false,
    children: [],
    _clickHandlers: [],
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { if (type === 'click') this._clickHandlers.push(fn); },
    click() { this._clickHandlers.forEach((fn) => fn()); },
  };
}

function runDashboardScript(html, controlValues = {}) {
  const defaults = {
    search: '', 'category-filter': 'all', 'tool-filter': 'all', 'range-filter': '30',
    'generated-meta': '', 'skipped-warning': '', app: '',
  };
  const elementsById = {};
  for (const [id, defaultValue] of Object.entries(defaults)) {
    const el = makeFakeElement(id === 'app' ? 'div' : 'input');
    el.value = controlValues[id] !== undefined ? controlValues[id] : defaultValue;
    elementsById[id] = el;
  }
  const sandbox = {
    document: {
      createElement: makeFakeElement,
      getElementById(id) {
        if (!elementsById[id]) elementsById[id] = makeFakeElement('div');
        return elementsById[id];
      },
    },
    navigator: { clipboard: { writeText() {} } },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('embedded <script> not found in buildHtml output');
  vm.runInContext(scriptMatch[1], sandbox);
  return { app: elementsById.app };
}

// Ticket 06 nests cards inside project node -> (optional path sub-node) -> time-bucket
// node -> card, instead of the old flat project-node -> card shape. Tests that only care
// about "which cards exist and what's on them" (not the exact tree depth) should not have
// to hardcode how many levels deep a card sits, so this walks the whole subtree.
function findAllCards(el) {
  var found = [];
  (el.children || []).forEach(function (child) {
    var classes = (child.className || '').split(' ');
    if (classes.indexOf('card') !== -1) found.push(child);
    found = found.concat(findAllCards(child));
  });
  return found;
}

test('buildHtml renders each project node inside a collapsible <details>/<summary>', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'a', title: 't', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const detailsEls = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.equal(detailsEls.length, 1);
  assert.equal(detailsEls[0].children[0].tagName, 'SUMMARY');
  assert.equal(detailsEls[0].children[0].textContent, 'proj');
});

test('buildHtml — 專案樹所有節點（專案節點、路徑子節點、時間區間）預設一律收合，不再有「展開最近 5 組」的例外', () => {
  const base = new Date('2026-08-02T12:00:00.000Z').getTime();
  const sessions = [];
  for (let i = 0; i < 7; i++) {
    const t = new Date(base - i * 3600000).toISOString();
    sessions.push({
      tool: 'claude-code', id: 'id' + i, title: 't' + i, cwd: 'C:\\work\\p' + i, branch: null,
      groupKey: 'c:/work/p' + i, displayName: 'p' + i, startedAt: t, lastActiveAt: t,
    });
  }
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T12:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const projectNodes = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.equal(projectNodes.length, 7);
  assert.ok(projectNodes.every((d) => d.open === false), '所有專案節點都必須預設收合，包含最近活動的節點');
});

test('buildHtml — 搜尋時專案樹節點仍維持收合，不再有搜尋強制展開的例外', () => {
  const base = new Date('2026-08-02T12:00:00.000Z').getTime();
  const sessions = [];
  for (let i = 0; i < 7; i++) {
    const t = new Date(base - i * 3600000).toISOString();
    sessions.push({
      tool: 'claude-code', id: 'id' + i, title: 't' + i, cwd: 'C:\\work\\p' + i, branch: null,
      groupKey: 'c:/work/p' + i, displayName: 'p' + i, startedAt: t, lastActiveAt: t,
    });
  }
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T12:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { search: 'work', 'range-filter': 'all' });
  const projectNodes = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.equal(projectNodes.length, 7);
  assert.ok(projectNodes.every((d) => d.open === false), '搜尋中的節點也必須維持收合');
});

test('buildHtml wraps the misc project node in the same collapsible <details> structure as project nodes, defaulting closed', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'm1', title: 'misc title', cwd: 'C:\\Users\\sjack', branch: null,
      groupKey: '__misc__', displayName: '雜項/隨手',
      startedAt: '2026-08-02T00:00:00.000Z', lastActiveAt: '2026-08-02T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const detailsEls = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.equal(detailsEls.length, 1);
  assert.equal(detailsEls[0].children[0].tagName, 'SUMMARY');
  assert.equal(detailsEls[0].children[0].textContent, '雜項/隨手');
  assert.equal(detailsEls[0].open, false, '雜項節點也必須預設收合，沒有例外');
});

test('buildHtml — 雜項節點下沒有路徑子節點這一層，直接是時間區間', () => {
  // buildHtml's embedded script buckets against the real wall-clock Date.now() at render
  // time, not meta.generatedAt — so "today" here must be computed from the actual current
  // time, not a hardcoded historical date (which would drift out of "today" as soon as the
  // real calendar date moves on).
  const nowIso = new Date().toISOString();
  const sessions = [
    {
      tool: 'claude-code', id: 'm1', title: 'misc title', cwd: 'C:\\Users\\sjack', branch: null,
      groupKey: '__misc__', displayName: '雜項/隨手',
      startedAt: nowIso, lastActiveAt: nowIso,
    },
  ];
  const html = buildHtml(sessions, { generatedAt: nowIso, skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const miscNode = app.children.find((el) => el.tagName === 'DETAILS');
  const bodyDiv = miscNode.children.find((el) => el.tagName === 'DIV');
  const childNodes = bodyDiv.children.filter((el) => el.tagName === 'DETAILS');
  assert.equal(childNodes.length, 1, '雜項節點下應該只有時間區間節點，沒有路徑子節點層');
  assert.ok(childNodes[0].className.includes('tree-node--time'));
  assert.equal(childNodes[0].children[0].textContent, '今天');
});

test('buildHtml still clusters same-name multi-path groups inside one project node, with a collapsible path sub-node per real path', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'a', title: 't', cwd: 'D:\\proj', branch: null,
      groupKey: 'd:/proj', displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
    {
      tool: 'claude-code', id: 'b', title: 't', cwd: 'E:\\proj', branch: null,
      groupKey: 'e:/proj', displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const detailsEls = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.equal(detailsEls.length, 1);
  assert.ok(detailsEls[0].children[0].textContent.includes('proj（2 個位置）'));
  const projectBody = detailsEls[0].children.find((el) => el.tagName === 'DIV');
  const pathNodes = projectBody.children.filter((el) => el.className.includes('tree-node--path'));
  assert.equal(pathNodes.length, 2, '同一專案節點下應該有兩個路徑子節點');
  const pathTexts = pathNodes.map((el) => el.children[0].textContent);
  assert.deepEqual(pathTexts, ['D:\\proj', 'E:\\proj']);
  assert.ok(pathNodes.every((d) => d.open === false), '路徑子節點也必須預設收合');
});

test('buildHtml — 單一路徑的專案節點不會出現路徑子節點這一層，直接是時間區間', () => {
  // See note above: bucketing is computed against real Date.now(), so use "now" here too.
  const nowIso = new Date().toISOString();
  const sessions = [
    {
      tool: 'claude-code', id: 'a', title: 't', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: nowIso, lastActiveAt: nowIso,
    },
  ];
  const html = buildHtml(sessions, { generatedAt: nowIso, skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const projectNode = app.children.find((el) => el.tagName === 'DETAILS');
  const body = projectNode.children.find((el) => el.tagName === 'DIV');
  const pathNodes = body.children.filter((el) => el.className.includes('tree-node--path'));
  const timeNodes = body.children.filter((el) => el.className.includes('tree-node--time'));
  assert.equal(pathNodes.length, 0, '單一路徑不應該出現路徑子節點層');
  assert.equal(timeNodes.length, 1);
  assert.equal(timeNodes[0].children[0].textContent, '今天');
});

test('buildHtml — 依 lastActiveAt 分成今天／昨天／本週／更早，且只渲染有內容的時間區間', () => {
  // Mirror buildHtml's own bucket-boundary math (calendar-day start of the real "now"),
  // then place one session solidly inside each bucket, so this test stays correct
  // regardless of what the real calendar date is when it runs.
  const now = Date.now();
  function dayStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const todayStart = dayStart(now);
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  const sessions = [
    {
      tool: 'claude-code', id: 'today', title: '今天的', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: new Date(todayStart + HOUR).toISOString(), lastActiveAt: new Date(todayStart + HOUR).toISOString(),
    },
    {
      tool: 'claude-code', id: 'yesterday', title: '昨天的', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: new Date(yesterdayStart + HOUR).toISOString(), lastActiveAt: new Date(yesterdayStart + HOUR).toISOString(),
    },
    {
      tool: 'claude-code', id: 'thisweek', title: '這週的', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: new Date(weekStart + HOUR).toISOString(), lastActiveAt: new Date(weekStart + HOUR).toISOString(),
    },
    {
      tool: 'claude-code', id: 'older', title: '更早的', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: new Date(weekStart - 24 * 60 * 60 * 1000).toISOString(), lastActiveAt: new Date(weekStart - 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
  const html = buildHtml(sessions, { generatedAt: new Date(now).toISOString(), skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const projectNode = app.children.find((el) => el.tagName === 'DETAILS');
  const body = projectNode.children.find((el) => el.tagName === 'DIV');
  const timeNodes = body.children.filter((el) => el.className.includes('tree-node--time'));
  const labels = timeNodes.map((el) => el.children[0].textContent);
  assert.deepEqual(labels, ['今天', '昨天', '本週', '更早'], '四個時間區間都各有一筆，應該全部渲染，且依此順序排列');
  timeNodes.forEach((node) => {
    const bucketBody = node.children.find((el) => el.tagName === 'DIV');
    const cards = bucketBody.children.filter((el) => el.className.indexOf('card') !== -1);
    assert.equal(cards.length, 1, node.children[0].textContent + ' 應該只有一筆 session');
  });
});

test('buildHtml — 單一時間區間展開後不分頁，全部顯示（無論筆數多少）', () => {
  const t = '2026-08-02T09:00:00.000Z';
  const sessions = [];
  for (let i = 0; i < 30; i++) {
    sessions.push({
      tool: 'claude-code', id: 'id' + i, title: 't' + i, cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj', startedAt: t, lastActiveAt: t,
    });
  }
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T12:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const projectNode = app.children.find((el) => el.tagName === 'DETAILS');
  const body = projectNode.children.find((el) => el.tagName === 'DIV');
  const timeNode = body.children.find((el) => el.className.includes('tree-node--time'));
  const bucketBody = timeNode.children.find((el) => el.tagName === 'DIV');
  const cards = bucketBody.children.filter((el) => el.className.indexOf('card') !== -1);
  assert.equal(cards.length, 30, '不應該有分頁或「顯示更多」上限，全部 30 筆都要出現');
  assert.ok(!bucketBody.children.some((el) => el.tagName === 'BUTTON' && /更多/.test(el.textContent)), '不應該有「顯示更多」按鈕');
});

test('buildHtml marks a titleIsFallback card with a distinct style, leaving a real title unmarked', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'real', title: '真實標題', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj', titleIsFallback: false,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
    {
      tool: 'claude-code', id: 'fallback', title: 'proj (2026-08-01T00:00:00.000Z)', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj', titleIsFallback: true,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findAllCards(app).filter((c) => c.className === 'card');
  assert.equal(cards.length, 2);
  const realCard = cards.find((c) => c.children[0].textContent.indexOf('真實標題') !== -1);
  const fallbackCard = cards.find((c) => c.children[0].textContent.indexOf('proj (2026-08-01') !== -1);
  assert.equal(fallbackCard.children[0].className, 'title-fallback', '退而標題應套用區隔樣式 class');
  assert.notEqual(realCard.children[0].className, 'title-fallback', '真實標題不應套用退而標題樣式');
});

test('buildHtml marks a pathExists:false card with a warning label and greyscale style, leaving a pathExists:true card unmarked', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'here', title: '路徑還在', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj', pathExists: true,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
    {
      tool: 'claude-code', id: 'gone', title: '路徑已刪除', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj', pathExists: false,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findAllCards(app);
  assert.equal(cards.length, 2);
  const existsCard = cards.find((c) => c.children[0].textContent.indexOf('路徑還在') !== -1);
  const goneCard = cards.find((c) => c.children[0].textContent.indexOf('路徑已刪除') !== -1);

  assert.equal(existsCard.className, 'card', 'pathExists:true 卡片不應套用灰階樣式');
  assert.ok(goneCard.className.indexOf('card-path-missing') !== -1, 'pathExists:false 卡片應套用灰階樣式 class');

  const goneWarningEl = goneCard.children.find((el) => el.textContent === '資料夾已不存在');
  assert.ok(goneWarningEl, 'pathExists:false 卡片應顯示「資料夾已不存在」警告標籤');
  const existsWarningEl = existsCard.children.find((el) => el.textContent === '資料夾已不存在');
  assert.equal(existsWarningEl, undefined, 'pathExists:true 卡片不應顯示警告標籤');

  const btn = goneCard.children.find((el) => el.tagName === 'BUTTON');
  assert.ok(btn, 'pathExists:false 卡片的複製按鈕仍須存在，不可被隱藏或移除');
});

test('buildHtml renders a distinct tool-badge class for claude-code vs codex sessions', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'cc', title: 'cc title', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
    {
      tool: 'codex', id: 'cx', title: 'cx title', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findAllCards(app);
  assert.equal(cards.length, 2);
  const ccCard = cards.find((c) => c.children[0].textContent.indexOf('cc title') !== -1);
  const cxCard = cards.find((c) => c.children[0].textContent.indexOf('cx title') !== -1);
  const ccBadge = ccCard.children[0].children.find((el) => el.className.indexOf('tool-badge') !== -1);
  const cxBadge = cxCard.children[0].children.find((el) => el.className.indexOf('tool-badge') !== -1);
  assert.ok(ccBadge, 'claude-code 卡片標題應包含色塊徽章元素');
  assert.ok(cxBadge, 'codex 卡片標題應包含色塊徽章元素');
  assert.notEqual(ccBadge.className, cxBadge.className, 'claude-code 與 codex 的色塊徽章應套用不同 class 以呈現不同顏色');
  assert.equal(ccBadge.className, 'tool-badge tool-badge-claude-code');
  assert.equal(cxBadge.className, 'tool-badge tool-badge-codex');
});

function buildSingleSessionHtmlForCopyTests() {
  const sessions = [
    {
      tool: 'claude-code', id: 'copy-test', title: 't', cwd: 'C:\\work\\proj', branch: null,
      groupKey: 'c:/work/proj', displayName: 'proj',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  return buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
}

function findCopyButton(app) {
  const card = findAllCards(app)[0];
  return card.children.find((el) => el.tagName === 'BUTTON');
}

test('點擊複製按鈕後，按鈕文字立即變成「已複製✓」', () => {
  const html = buildSingleSessionHtmlForCopyTests();
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const btn = findCopyButton(app);
  assert.equal(btn.textContent, '複製續接指令');
  btn.click();
  assert.equal(btn.textContent, '已複製✓');
});

test('點擊複製按鈕後，經過延遲時間文字自動恢復原本文字', async () => {
  const html = buildSingleSessionHtmlForCopyTests();
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const btn = findCopyButton(app);
  btn.click();
  assert.equal(btn.textContent, '已複製✓');
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(btn.textContent, '複製續接指令');
});

test('連續快速點擊複製按鈕不會讓文字卡住，也不會被舊計時器提前恢復', async () => {
  const html = buildSingleSessionHtmlForCopyTests();
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const btn = findCopyButton(app);
  btn.click();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  btn.click();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(btn.textContent, '已複製✓', '第一次點擊的計時器應已被第二次點擊清除，不應提前恢復');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(btn.textContent, '複製續接指令', '第二次點擊的計時器應正常觸發恢復，不會卡住');
});

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

const { main } = require('./session-dashboard.js');

test('main scans both sources, writes the dashboard, and skips opening the browser in --quiet mode', () => {
  const dir = makeTempDir();
  const claudeHomeDir = pathForTests.join(dir, 'claude-home');
  const codexHomeDir = pathForTests.join(dir, 'codex-home');
  writeJsonl(pathForTests.join(claudeHomeDir, 'projects', 'proj', 'aaa.jsonl'), [
    { type: 'user', cwd: 'C:\work\proj', gitBranch: 'main', message: { content: '第一個 session' } },
  ]);
  writeJsonl(pathForTests.join(codexHomeDir, 'sessions', 'rollout-bbb.jsonl'), [
    { type: 'session_meta', payload: { id: 'bbb', cwd: 'C:\work\proj' } },
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
    { type: 'user', cwd: 'C:\work\proj', message: { content: '一個 session' } },
  ]);

  let openedPath = null;
  main([], { claudeHomeDir, codexHomeDir, openBrowser: (p) => { openedPath = p; } });

  assert.equal(openedPath, pathForTests.join(claudeHomeDir, 'sessions-dashboard.html'));
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

// Integration-level regression test: main() must pass the REAL os.homedir() as the grouping
// reference into scanClaudeCode/scanCodex, not claudeHomeDir/codexHomeDir. main() always uses
// the real os.homedir() internally (it's not injectable via options, unlike claudeHomeDir/
// codexHomeDir), so this test uses the real value directly to prove the full wiring end-to-end.
test('main groups a session whose cwd is the real home directory as misc, not its own project group', () => {
  const dir = makeTempDir();
  const claudeHomeDir = pathForTests.join(dir, 'claude-home');
  const codexHomeDir = pathForTests.join(dir, 'codex-home-missing');
  const realHome = osForTests.homedir();
  writeJsonl(pathForTests.join(claudeHomeDir, 'projects', 'home', 'ddd.jsonl'), [
    { type: 'user', cwd: realHome, message: { content: '在家目錄隨手問的問題' } },
  ]);

  const result = main(['--quiet'], { claudeHomeDir, codexHomeDir, openBrowser: () => {} });
  const html = fsForTests.readFileSync(result.targetPath, 'utf8');
  const dataMatch = html.match(/var DATA = (.*);\n\s*\(function/);
  const data = JSON.parse(dataMatch[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].groupKey, '__misc__', 'a real home-directory session must be grouped as misc, not as its own project');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

// Regression test for a real duplicate-card bug found during manual browser QA: Claude Code
// stores a session's jsonl file keyed by the project folder it was CURRENTLY running from —
// when a project folder is moved or copied to a new location and the same session is resumed
// from there, Claude Code writes a fresh copy of that session's jsonl file under the new
// project folder while leaving the old copy in place. Confirmed on this machine: the exact
// same session id physically exists as 2-3 separate files under different
// ~/.claude/projects/<encoded-path>/ folders. Our scanner walks all of them, so the same
// conversation showed up as 2-3 identical-looking cards. dedupeSessions() collapses entries
// sharing the same (tool, id) down to one, keeping the copy with the latest lastActiveAt
// (mtime) — confirmed against the real duplicate files that the newest-mtime copy is also the
// most complete one (more lines, i.e. the session kept being used from that location).
const { dedupeSessions } = require('./session-dashboard.js');

test('dedupeSessions collapses sessions sharing the same (tool, id), keeping the one with the latest lastActiveAt', () => {
  const older = {
    tool: 'claude-code',
    id: 'shared-id',
    title: '舊的複本',
    cwd: 'C:\\Users\\sjack\\OneDrive\\Documents\\proj',
    branch: null,
    groupKey: 'c:/users/sjack/onedrive/documents/proj',
    displayName: 'proj',
    startedAt: '2026-07-29T00:00:00.000Z',
    lastActiveAt: '2026-07-29T00:31:46.000Z',
  };
  const newer = {
    ...older,
    title: '新的複本（專案已搬到本機）',
    cwd: 'C:\\Users\\sjack\\Documents\\proj',
    groupKey: 'c:/users/sjack/documents/proj',
    lastActiveAt: '2026-08-01T01:51:46.000Z',
  };
  const unrelated = { ...older, id: 'a-different-id' };

  const result = dedupeSessions([older, newer, unrelated]);
  assert.equal(result.length, 2);
  const kept = result.find((s) => s.id === 'shared-id');
  assert.equal(kept.lastActiveAt, newer.lastActiveAt);
  assert.equal(kept.title, '新的複本（專案已搬到本機）');
});

test('dedupeSessions does not collapse sessions with the same id but different tools', () => {
  const claudeSession = {
    tool: 'claude-code', id: 'x', title: 't', cwd: 'C:\\p', branch: null,
    groupKey: 'c:/p', displayName: 'p', startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z',
  };
  const codexSession = { ...claudeSession, tool: 'codex' };
  const result = dedupeSessions([claudeSession, codexSession]);
  assert.equal(result.length, 2);
});

test('main deduplicates a session whose jsonl file exists under two different project folders, keeping the more recently active copy', () => {
  const dir = makeTempDir();
  const claudeHomeDir = pathForTests.join(dir, 'claude-home');
  const codexHomeDir = pathForTests.join(dir, 'codex-home-missing');
  const sharedId = 'duplicated-across-folders';

  const oldFile = pathForTests.join(claudeHomeDir, 'projects', 'onedrive-copy', `${sharedId}.jsonl`);
  writeJsonl(oldFile, [
    { type: 'user', cwd: 'C:\\Users\\sjack\\OneDrive\\Documents\\proj', message: { content: '這是搬家前的舊路徑版本' } },
  ]);
  const newFile = pathForTests.join(claudeHomeDir, 'projects', 'local-copy', `${sharedId}.jsonl`);
  writeJsonl(newFile, [
    { type: 'user', cwd: 'C:\\Users\\sjack\\Documents\\proj', message: { content: '這是搬家後的新路徑版本' } },
  ]);
  // Force a deterministic mtime ordering instead of relying on wall-clock timing between
  // two back-to-back writes, which could tie on a fast filesystem.
  const oldTime = new Date('2026-07-29T00:31:46.000Z');
  const newTime = new Date('2026-08-01T01:51:46.000Z');
  fsForTests.utimesSync(oldFile, oldTime, oldTime);
  fsForTests.utimesSync(newFile, newTime, newTime);

  const result = main(['--quiet'], { claudeHomeDir, codexHomeDir, openBrowser: () => {} });
  assert.equal(result.sessionCount, 1, 'the two physical copies must collapse into one session');
  const html = fsForTests.readFileSync(result.targetPath, 'utf8');
  const dataMatch = html.match(/var DATA = (.*);\n\s*\(function/);
  const data = JSON.parse(dataMatch[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].title, '這是搬家後的新路徑版本', 'must keep the more recently active copy');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});
