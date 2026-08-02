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
