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

const { readLastJsonLines } = require('./session-dashboard.js');

test('readLastJsonLines returns the last n parseable records in original (oldest-to-newest) file order, skipping blank lines', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'many.jsonl');
  const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ n: i }));
  fsForTests.writeFileSync(filePath, `\n${lines.join('\n\n')}\n`, 'utf8');
  const records = readLastJsonLines(filePath, 3);
  assert.deepEqual(records.map((r) => r.n), [2, 3, 4]);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('readLastJsonLines skips a truncated last line but keeps the earlier parseable ones', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'truncated.jsonl');
  const goodLine1 = JSON.stringify({ type: 'user', message: { content: 'first' } });
  const goodLine2 = JSON.stringify({ type: 'user', message: { content: 'second' } });
  const truncatedLine = '{"type":"user","message":{"content":"cut off mid-wr';
  fsForTests.writeFileSync(filePath, `${goodLine1}\n${goodLine2}\n${truncatedLine}`, 'utf8');
  const records = readLastJsonLines(filePath, 20);
  assert.equal(records.length, 2);
  assert.equal(records[0].message.content, 'first');
  assert.equal(records[1].message.content, 'second');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('readLastJsonLines does not corrupt a multi-byte UTF-8 character straddling a 64KB chunk boundary, reading from the tail', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'boundary.jsonl');
  const CHUNK_SIZE = 64 * 1024;
  const leadingLine = JSON.stringify({ n: 0 });
  const prefix = '{"type":"user","message":{"content":"';
  const firstChar = '中';
  const rest = '文測試"}}';
  // Backward chunk boundaries are counted from EOF, so (unlike the forward-read test) what
  // must be sized is the content AFTER the target character, not before it: pad so the number
  // of bytes from the character's end to EOF is CHUNK_SIZE - 2, putting 2 of its 3 UTF-8 bytes
  // in the first (tail) backward read and the 3rd byte in the second backward read.
  const afterCharBytesTarget = CHUNK_SIZE - 2;
  const fixedAfterBytes = Buffer.byteLength(rest) + 1; // rest + trailing '\n'
  const filler = 'A'.repeat(Math.max(0, afterCharBytesTarget - fixedAfterBytes));
  fsForTests.writeFileSync(filePath, `${leadingLine}\n${prefix}${firstChar}${filler}${rest}\n`, 'utf8');

  const records = readLastJsonLines(filePath, 1);
  assert.equal(records.length, 1);
  assert.ok(records[0].message.content.endsWith('文測試'), records[0].message.content.slice(-20));
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

test('scanClaudeCodeFile sets firstMessagePreview/lastMessagePreview from the first and last genuine (non-synthetic) user messages, capped to 5 lines', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'preview-123.jsonl');
  const firstMultilineContent = 'L1第一行\nL2第二行\nL3第三行\nL4第四行\nL5第五行\nL6不應出現\nL7不應出現';
  writeJsonl(filePath, [
    { type: 'user', cwd: 'C:\\work\\preview-project', isMeta: true, message: { content: '<local-command-caveat>系統注入內容，應被略過</local-command-caveat>' } },
    { type: 'user', message: { content: firstMultilineContent } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '這是助理回覆，不算使用者訊息' }] } },
    { type: 'user', isMeta: true, message: { content: '<local-command-caveat>結尾附近的注入內容，應被略過</local-command-caveat>' } },
    { type: 'user', message: { content: '這是最後一則真實使用者訊息' } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.firstMessagePreview, 'L1第一行\nL2第二行\nL3第三行\nL4第四行\nL5第五行', '應只保留前 5 行，且跳過開頭的注入內容');
  assert.equal(session.lastMessagePreview, '這是最後一則真實使用者訊息');
  assert.notEqual(session.firstMessagePreview, session.lastMessagePreview);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile sets firstMessagePreview/lastMessagePreview to null when every scanned record is synthetic (real AGENTS.md injection case)', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'all-synthetic-789.jsonl');
  const realInjectedAgentsMd =
    '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n1.盡量輸出簡潔，說明重點。\n2.每完成我要求的代碼修改時，需建立一個Git，並且Git的名稱須以簡潔中文呈現。\n3.每次展開一個新的項目時，需主動問我是否要將任務拆分成多個簡單任務執行。\n4.寫代碼時，變數命名須明確，註釋要清晰。\n5.寫項目的時候，盡量以架構師的假度去考慮，不要產生超大文件。數據結構要精簡、結構邏輯要合理。\n6.確實按照規畫的去執行。\n7.在開始進行代碼修改與編寫前，需簡潔地向我提出修改方法以及問我是否需要將任務拆分。\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>C:\\Users\\sjack\\OneDrive\\Documents\\PDF名稱修改</cwd>\n</environment_context>';
  writeJsonl(filePath, [
    { type: 'user', cwd: 'C:\\work\\all-synthetic', isMeta: true, message: { content: '<local-command-caveat>...</local-command-caveat>' } },
    { type: 'user', message: { content: realInjectedAgentsMd } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.firstMessagePreview, null);
  assert.equal(session.lastMessagePreview, null);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

// Regression coverage for a real bug found after ticket 08 shipped: readFirstJsonLines(filePath, 20)
// was called ONCE and reused as a fixed head window for both title extraction and
// firstMessagePreview. Real skill invocations (e.g. a `/some-skill:name` command) each burn 2 head
// slots — a `<command-name>` line plus a large synthetic "Base directory for this skill: ..." body —
// before the first genuine human message appears, so a session with 2+ skill invocations up front
// pushes the real message past record 20 and both title and firstMessagePreview wrongly fell back
// to null/synthetic. Mirrors the real session def4a233-683d-4e90-b52a-37aa006f5fe5.
const { readExpandingHeadRecords } = require('./session-dashboard.js');

const claudeUserMatchersForTest = {
  isCandidate: (record) => record.type === 'user' && record.isMeta !== true,
  extractText: (record) => extractMessageText(record.message),
  isSynthetic: isSyntheticClaudeText,
};

test('readExpandingHeadRecords reads only once when a genuine message is already within the initial window (no extra cost in the common case)', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'quick.jsonl');
  writeJsonl(filePath, [
    { type: 'mode', mode: 'default' },
    { type: 'user', message: { content: '這則訊息在前 20 筆內' } },
  ]);
  const originalOpenSync = fsForTests.openSync;
  let openCount = 0;
  fsForTests.openSync = function (...args) {
    openCount += 1;
    return originalOpenSync.apply(fsForTests, args);
  };
  try {
    const records = readExpandingHeadRecords(filePath, claudeUserMatchersForTest);
    assert.equal(openCount, 1, '找到即回傳，不應多讀一次檔案');
    assert.equal(records.length, 2);
  } finally {
    fsForTests.openSync = originalOpenSync;
  }
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('readExpandingHeadRecords expands the read window when the genuine message lies beyond the initial 20 records (real skill-invocation-noise case)', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'noisy.jsonl');
  const noiseRecords = [];
  for (let i = 0; i < 11; i += 1) {
    noiseRecords.push({ type: 'file-history-snapshot', i });
    noiseRecords.push({ type: 'user', message: { content: '<command-name>mattpocock-skills:ask-matt</command-name>' } });
  }
  const genuineText = '請接手目前 PDF 批次命名專案';
  writeJsonl(filePath, [...noiseRecords, { type: 'user', message: { content: genuineText } }]);

  const originalOpenSync = fsForTests.openSync;
  let openCount = 0;
  fsForTests.openSync = function (...args) {
    openCount += 1;
    return originalOpenSync.apply(fsForTests, args);
  };
  try {
    const records = readExpandingHeadRecords(filePath, claudeUserMatchersForTest);
    assert.ok(openCount > 1, '找不到才需要多讀一次，此案例應觸發擴展');
    assert.ok(records.length > 20, '應讀到超過原本固定的 20 筆窗口');
    assert.equal(records[22].message.content, genuineText);
  } finally {
    fsForTests.openSync = originalOpenSync;
  }
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('readExpandingHeadRecords stops after one read for a genuinely short/empty file instead of expanding all the way to the cap', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'short-empty.jsonl');
  // A short file (fewer than the initial 20-record window) with no genuine user message —
  // e.g. a cancelled /resume. readFirstJsonLines hitting EOF (records.length < n) means a
  // bigger window would return the exact same records, so expansion must not be attempted.
  writeJsonl(filePath, [
    { type: 'mode', mode: 'default' },
    { type: 'system', subtype: 'local_command', content: '<local-command-stdout>Resume cancelled</local-command-stdout>' },
  ]);
  const originalOpenSync = fsForTests.openSync;
  let openCount = 0;
  fsForTests.openSync = function (...args) {
    openCount += 1;
    return originalOpenSync.apply(fsForTests, args);
  };
  try {
    const records = readExpandingHeadRecords(filePath, claudeUserMatchersForTest);
    assert.equal(openCount, 1, '檔案已讀到結尾（EOF），擴大窗口也不會有新內容，不應再多讀');
    assert.equal(records.length, 2);
  } finally {
    fsForTests.openSync = originalOpenSync;
  }
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile finds a real title and firstMessagePreview past the fixed 20-record window when skill-invocation noise delays the first genuine message (regression for def4a233-like sessions)', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'skill-noise-def4a233.jsonl');
  const noiseRecords = [];
  for (let i = 0; i < 11; i += 1) {
    noiseRecords.push({ type: 'file-history-snapshot', i });
    noiseRecords.push({ type: 'user', message: { content: '<command-name>mattpocock-skills:ask-matt</command-name>' } });
  }
  const genuineText = '請接手目前 PDF 批次命名專案';
  writeJsonl(filePath, [
    { type: 'user', cwd: 'C:\\work\\pdf-project', isMeta: true, message: { content: '<local-command-caveat>...' } },
    ...noiseRecords,
    { type: 'user', message: { content: genuineText } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.firstMessagePreview, genuineText, '真實訊息在 20 筆窗口之外，展開後應找到，而非顯示無');
  assert.equal(session.title, genuineText);
  assert.equal(session.titleIsFallback, false);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile\'s lastMessagePreview accepts the assistant\'s final text reply as the last genuine message (conversation ended on the agent\'s turn)', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'assistant-last.jsonl');
  writeJsonl(filePath, [
    { type: 'user', cwd: 'C:\\work\\proj', message: { content: '使用者的問題' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', text: '內部思考，不應被當成內容' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '這是助理的最終回覆，也應被視為最後一則訊息' }] } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.lastMessagePreview, '這是助理的最終回覆，也應被視為最後一則訊息');
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanClaudeCodeFile\'s lastMessagePreview skips a trailing assistant record with no text content (thinking/tool_use only) and falls back to the last genuine text from either role', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'projects', 'proj', 'trailing-tool-use.jsonl');
  writeJsonl(filePath, [
    { type: 'user', cwd: 'C:\\work\\proj', message: { content: '使用者訊息' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '這是有意義的助理回覆' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
  ]);
  const session = scanClaudeCodeFile(filePath, 'C:\\Users\\sjack');
  assert.equal(session.lastMessagePreview, '這是有意義的助理回覆');
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

// Regression: Codex's automated approval/risk-review sub-loop ends a turn with a raw JSON
// verdict instead of prose (real data: ~44% of sessions' last assistant turn looked like
// this), which none of the prefix/heading heuristics above catch since it starts with '{'.
test('isSyntheticCodexText flags a raw JSON approval-verdict blob as synthetic', () => {
  assert.equal(
    isSyntheticCodexText('{"risk_level":"low","user_authorization":"high","outcome":"allow"}'),
    true
  );
});

test('isSyntheticCodexText does not flag a real message that merely starts with "{"', () => {
  assert.equal(isSyntheticCodexText('{這個變數該怎麼命名比較好？'), false);
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

test('scanCodexFile sets firstMessagePreview/lastMessagePreview from the first and last genuine (non-synthetic) user messages, capped to 5 lines', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-preview.jsonl');
  const firstMultilineContent = 'L1第一行\nL2第二行\nL3第三行\nL4第四行\nL5第五行\nL6不應出現\nL7不應出現';
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-preview', cwd: 'C:\\work\\preview', git: {} } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>系統注入內容，應被略過</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstMultilineContent }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '這是助理回覆，不算使用者訊息' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>結尾附近的注入內容，應被略過</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '這是最後一則真實使用者訊息' }] } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.firstMessagePreview, 'L1第一行\nL2第二行\nL3第三行\nL4第四行\nL5第五行', '應只保留前 5 行，且跳過開頭的注入內容');
  assert.equal(session.lastMessagePreview, '這是最後一則真實使用者訊息');
  assert.notEqual(session.firstMessagePreview, session.lastMessagePreview);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile sets firstMessagePreview/lastMessagePreview to null when every scanned record is synthetic (real AGENTS.md injection case)', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-all-synthetic.jsonl');
  const realInjectedAgentsMd =
    '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n1.盡量輸出簡潔，說明重點。\n2.每完成我要求的代碼修改時，需建立一個Git，並且Git的名稱須以簡潔中文呈現。\n3.每次展開一個新的項目時，需主動問我是否要將任務拆分成多個簡單任務執行。\n4.寫代碼時，變數命名須明確，註釋要清晰。\n5.寫項目的時候，盡量以架構師的假度去考慮，不要產生超大文件。數據結構要精簡、結構邏輯要合理。\n6.確實按照規畫的去執行。\n7.在開始進行代碼修改與編寫前，需簡潔地向我提出修改方法以及問我是否需要將任務拆分。\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>C:\\Users\\sjack\\OneDrive\\Documents\\PDF名稱修改</cwd>\n</environment_context>';
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-all-synthetic', cwd: 'C:\\work\\all-synthetic', git: {} } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: realInjectedAgentsMd }] } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.firstMessagePreview, null);
  assert.equal(session.lastMessagePreview, null);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

// Regression coverage mirroring the Claude Code fixture above: Codex sessions can also carry
// 20+ leading synthetic response_item/user records (e.g. repeated environment_context injections)
// before the first genuine human message, which used to push it past the fixed 20-record window.
test('scanCodexFile finds a real title and firstMessagePreview past the fixed 20-record window when synthetic noise delays the first genuine message', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-noisy.jsonl');
  const noiseRecords = Array.from({ length: 22 }, () => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...' }] },
  }));
  const genuineText = '幫我修一下這個延遲很久才出現的 bug';
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-noisy', cwd: 'C:\\work\\noisy', git: {} } },
    ...noiseRecords,
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: genuineText }] } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.firstMessagePreview, genuineText, '真實訊息在 20 筆窗口之外，展開後應找到，而非顯示無');
  assert.equal(session.title, genuineText);
  assert.equal(session.titleIsFallback, false);
  fsForTests.rmSync(dir, { recursive: true, force: true });
});

test('scanCodexFile\'s lastMessagePreview accepts the assistant\'s final output_text reply as the last genuine message', () => {
  const dir = makeTempDir();
  const filePath = pathForTests.join(dir, 'sessions', 'rollout-assistant-last.jsonl');
  writeJsonl(filePath, [
    { type: 'session_meta', payload: { id: 'sess-assistant-last', cwd: 'C:\\work\\proj', git: {} } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '使用者的問題' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '這是助理的最終回覆，對話就此結束' }] } },
  ]);
  const session = scanCodexFile(filePath, new Map(), 'C:\\Users\\sjack');
  assert.equal(session.lastMessagePreview, '這是助理的最終回覆，對話就此結束');
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
    _handlers: {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    dispatchEvent(type) { (this._handlers[type] || []).forEach((fn) => fn()); },
    click() { this.dispatchEvent('click'); },
  };
}

function runDashboardScript(html, controlValues = {}) {
  const defaults = {
    search: '', 'category-filter': 'all', 'tool-filter': 'all', 'range-filter': '30',
    'generated-meta': '', 'skipped-warning': '', app: '', 'quick-resume': '',
  };
  const elementsById = {};
  for (const [id, defaultValue] of Object.entries(defaults)) {
    const el = makeFakeElement(id === 'app' ? 'div' : (id === 'quick-resume' ? 'div' : 'input'));
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
  return { app: elementsById.app, elementsById };
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

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// A card's own .textContent is never set directly (only its title-div child's is, e.g. in
// renderCard) — mirrors the existing `card.children[0].textContent` pattern used elsewhere
// in this file, just generalized to find every card under an arbitrary subtree.
function findAllTextInCards(el) {
  let texts = [];
  if (el.className && el.className.indexOf('card') !== -1) texts.push(el.children[0].textContent);
  (el.children || []).forEach((child) => { texts = texts.concat(findAllTextInCards(child)); });
  return texts;
}

test('buildHtml — 超過 90 天沒有互動的 session 被抽出，集中到樹狀圖最上方的久未使用整理區，不留在原本的專案節點下', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'stale1', title: 'stale session title', cwd: 'C:\\work\\projA', branch: null,
      groupKey: 'c:/work/proja', displayName: 'projA',
      startedAt: daysAgoIso(120), lastActiveAt: daysAgoIso(120),
    },
    {
      tool: 'claude-code', id: 'fresh1', title: 'fresh session title', cwd: 'C:\\work\\projA', branch: null,
      groupKey: 'c:/work/proja', displayName: 'projA',
      startedAt: daysAgoIso(1), lastActiveAt: daysAgoIso(1),
    },
  ];
  const html = buildHtml(sessions, { generatedAt: new Date().toISOString(), skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const detailsEls = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.equal(detailsEls.length, 2, '應該有久未使用整理區＋projA 兩個頂層節點');

  const staleNode = detailsEls.find((el) => el.className.includes('tree-node--stale'));
  assert.ok(staleNode, '久未使用整理區應該存在');
  assert.equal(staleNode.children[0].textContent, '久未使用（超過 90 天）（1 筆）');
  assert.equal(staleNode.open, false, '久未使用整理區也必須預設收合');
  const staleCardTexts = findAllTextInCards(staleNode);
  assert.equal(staleCardTexts.length, 1);
  assert.ok(staleCardTexts[0].includes('stale session title'));

  const projectNode = detailsEls.find((el) => !el.className.includes('tree-node--stale'));
  const projectCardTexts = findAllTextInCards(projectNode);
  assert.equal(projectCardTexts.length, 1, 'projA 節點下應該只剩 fresh1 這張卡片');
  assert.ok(projectCardTexts[0].includes('fresh session title'));
  assert.ok(!projectCardTexts[0].includes('stale session title'), 'stale1 不應該再出現在 projA 的正常樹狀結構裡');
});

test('buildHtml — 久未使用整理區排在專案樹最上方（在所有一般專案節點之前）', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'fresh1', title: 't', cwd: 'C:\\work\\aaa', branch: null,
      groupKey: 'c:/work/aaa', displayName: 'aaa',
      startedAt: daysAgoIso(1), lastActiveAt: daysAgoIso(1),
    },
    {
      tool: 'claude-code', id: 'stale1', title: 't', cwd: 'C:\\work\\bbb', branch: null,
      groupKey: 'c:/work/bbb', displayName: 'bbb',
      startedAt: daysAgoIso(200), lastActiveAt: daysAgoIso(200),
    },
  ];
  const html = buildHtml(sessions, { generatedAt: new Date().toISOString(), skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const detailsEls = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.ok(detailsEls[0].className.includes('tree-node--stale'), '久未使用整理區必須是第一個頂層節點');
});

test('buildHtml — 沒有任何久未使用的 session 時，不渲染久未使用整理區', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'fresh1', title: 't', cwd: 'C:\\work\\aaa', branch: null,
      groupKey: 'c:/work/aaa', displayName: 'aaa',
      startedAt: daysAgoIso(1), lastActiveAt: daysAgoIso(1),
    },
  ];
  const html = buildHtml(sessions, { generatedAt: new Date().toISOString(), skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const detailsEls = app.children.filter((el) => el.tagName === 'DETAILS');
  assert.ok(!detailsEls.some((el) => el.className.includes('tree-node--stale')));
});

test('buildHtml — 久未使用整理區不受時間範圍篩選（range-filter）影響，即使預設 30 天篩選也看得到', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'stale1', title: 't', cwd: 'C:\\work\\ccc', branch: null,
      groupKey: 'c:/work/ccc', displayName: 'ccc',
      startedAt: daysAgoIso(150), lastActiveAt: daysAgoIso(150),
    },
  ];
  const html = buildHtml(sessions, { generatedAt: new Date().toISOString(), skippedCount: 0 });
  // 不覆寫 range-filter，沿用 HTML 內建的預設值（30 天）。
  const { app } = runDashboardScript(html, {});
  const staleNode = app.children.find((el) => el.className.includes('tree-node--stale'));
  assert.ok(staleNode, '即使在預設 30 天範圍篩選下，久未使用整理區仍應該顯示（該篩選語意相反，不應套用於此）');
  assert.equal(staleNode.children[0].textContent, '久未使用（超過 90 天）（1 筆）');
});

test('buildHtml — 久未使用整理區仍受搜尋框篩選影響（跟樹狀圖其餘部分一致）', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'stale1', title: 'apple project', cwd: 'C:\\work\\apple', branch: null,
      groupKey: 'c:/work/apple', displayName: 'apple',
      startedAt: daysAgoIso(150), lastActiveAt: daysAgoIso(150),
    },
    {
      tool: 'claude-code', id: 'stale2', title: 'banana project', cwd: 'C:\\work\\banana', branch: null,
      groupKey: 'c:/work/banana', displayName: 'banana',
      startedAt: daysAgoIso(150), lastActiveAt: daysAgoIso(150),
    },
  ];
  const html = buildHtml(sessions, { generatedAt: new Date().toISOString(), skippedCount: 0 });
  const { app } = runDashboardScript(html, { search: 'apple', 'range-filter': 'all' });
  const staleNode = app.children.find((el) => el.className.includes('tree-node--stale'));
  assert.ok(staleNode);
  assert.equal(staleNode.children[0].textContent, '久未使用（超過 90 天）（1 筆）');
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

// Ticket 07 — 接續快速區：獨立於 render()/篩選狀態的頂部固定區塊（ADR-0001）。
function makeQuickResumeSessions() {
  const base = new Date('2026-08-02T12:00:00.000Z').getTime();
  const sessions = [];
  for (let i = 0; i < 10; i++) {
    const t = new Date(base - i * 3600000).toISOString();
    sessions.push({
      tool: i % 2 === 0 ? 'claude-code' : 'codex', id: 'qr-' + i, title: '標題' + i,
      cwd: 'C:\\work\\proj' + i, branch: 'main',
      groupKey: 'c:/work/proj' + i, displayName: 'proj' + i, pathExists: true,
      startedAt: t, lastActiveAt: t,
    });
  }
  // 兩筆路徑已失效，時間比其他所有 session 都新，驗證挑選規則確實排除它們，而非只挑最新的 8 筆
  for (let i = 0; i < 2; i++) {
    const t = new Date(base + (i + 1) * 3600000).toISOString();
    sessions.push({
      tool: 'claude-code', id: 'gone-' + i, title: '已失效' + i,
      cwd: 'C:\\work\\gone' + i, branch: null,
      groupKey: 'c:/work/gone' + i, displayName: 'gone' + i, pathExists: false,
      startedAt: t, lastActiveAt: t,
    });
  }
  return sessions;
}

function findQuickResumeCards(elementsById) {
  return elementsById['quick-resume'].children.filter((el) => (el.className || '').split(' ').indexOf('card') !== -1);
}

test('buildHtml — 接續快速區固定顯示全站最新 8 筆，排除 pathExists:false，即使那些失效路徑的 session 時間更新', () => {
  const sessions = makeQuickResumeSessions();
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T12:00:00.000Z', skippedCount: 0 });
  const { elementsById } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findQuickResumeCards(elementsById);
  assert.equal(cards.length, 8, '接續快速區必須固定顯示 8 筆');
  cards.forEach((card) => {
    assert.equal(
      card.children.some((el) => el.textContent.indexOf('已失效') !== -1),
      false,
      '失效路徑的 session 不應出現在接續快速區'
    );
  });
  assert.ok(cards[0].children[0].textContent.indexOf('proj0') !== -1, '第一筆應是未失效者中最新的 session');
});

test('buildHtml — 接續快速區在合格 session 不足 8 筆時，顯示全部合格筆數而非硬湊 8 筆', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 's1', title: 't1', cwd: 'C:\\work\\p1', branch: null,
      groupKey: 'c:/work/p1', displayName: 'p1', pathExists: true,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
    {
      tool: 'claude-code', id: 's2', title: 't2', cwd: 'C:\\work\\p2', branch: null,
      groupKey: 'c:/work/p2', displayName: 'p2', pathExists: false,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-02T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T00:00:00.000Z', skippedCount: 0 });
  const { elementsById } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findQuickResumeCards(elementsById);
  assert.equal(cards.length, 1, '只有 1 筆合格 session 時，接續快速區應只顯示 1 筆');
});

test('buildHtml — 接續快速區卡片為精簡型：只有專案名稱/標題/最後互動時間/接續按鈕，不含 branch、開始時間、完整 cwd', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'qr-solo', title: '精簡卡片標題', cwd: 'C:\\work\\solo-project', branch: 'feature/foo',
      groupKey: 'c:/work/solo-project', displayName: 'solo-project', pathExists: true,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-02T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T00:00:00.000Z', skippedCount: 0 });
  const { elementsById } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findQuickResumeCards(elementsById);
  assert.equal(cards.length, 1);
  const cardText = cards[0].children.map((el) => el.textContent).join('\n');
  assert.ok(cardText.indexOf('solo-project') !== -1, '應顯示 displayName');
  assert.ok(cardText.indexOf('精簡卡片標題') !== -1, '應顯示標題');
  assert.ok(cardText.indexOf('2026-08-02T00:00:00.000Z') !== -1, '應顯示 lastActiveAt');
  assert.equal(cardText.indexOf('feature/foo'), -1, '不應顯示 branch');
  assert.equal(cardText.indexOf('2026-08-01T00:00:00.000Z'), -1, '不應顯示 startedAt');
  assert.equal(cardText.indexOf('C:\\work\\solo-project'), -1, '不應顯示完整 cwd');
  assert.ok(cards[0].children.some((el) => el.tagName === 'BUTTON'), '應包含接續按鈕');
});

function snapshotElement(el) {
  return {
    tagName: el.tagName,
    className: el.className,
    textContent: el.textContent,
    children: (el.children || []).map(snapshotElement),
  };
}

test('buildHtml — 接續快速區完全不受搜尋框、分類、工具、時間範圍篩選狀態影響，內容維持不變', () => {
  const sessions = makeQuickResumeSessions();
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T12:00:00.000Z', skippedCount: 0 });
  const { elementsById } = runDashboardScript(html, { 'range-filter': 'all' });
  const before = JSON.stringify(snapshotElement(elementsById['quick-resume']));

  elementsById.search.value = 'proj0';
  elementsById.search.dispatchEvent('input');
  elementsById['category-filter'].value = 'misc';
  elementsById['category-filter'].dispatchEvent('change');
  elementsById['tool-filter'].value = 'codex';
  elementsById['tool-filter'].dispatchEvent('change');
  elementsById['range-filter'].value = '7';
  elementsById['range-filter'].dispatchEvent('change');

  const after = JSON.stringify(snapshotElement(elementsById['quick-resume']));
  assert.equal(after, before, '接續快速區內容在篩選狀態變動後必須維持完全不變');
});

test('buildHtml — 接續快速區接續按鈕的複製行為與專案樹卡片一致（點擊後顯示「已複製✓」）', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'qr-copy', title: '複製測試', cwd: 'C:\\work\\copy-test', branch: null,
      groupKey: 'c:/work/copy-test', displayName: 'copy-test', pathExists: true,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-02T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T00:00:00.000Z', skippedCount: 0 });
  const { elementsById } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findQuickResumeCards(elementsById);
  const btn = cards[0].children.find((el) => el.tagName === 'BUTTON');
  assert.equal(btn.textContent, '複製續接指令');
  btn.click();
  assert.equal(btn.textContent, '已複製✓');
});

// Ticket 08 — 訊息預覽功能：卡片上可點擊展開/收起的預覽切換，套用在專案樹與接續快速區兩邊。
function findByClassName(el, cls) {
  if ((el.className || '').split(' ').indexOf(cls) !== -1) return el;
  for (const child of el.children || []) {
    const found = findByClassName(child, cls);
    if (found) return found;
  }
  return null;
}

test('buildHtml — 點擊卡片的預覽切換後正確顯示 firstMessagePreview/lastMessagePreview（標示「開始」／「最後」），再次點擊收合', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'preview-a', title: 't', cwd: 'C:\\work\\preview-a', branch: null,
      groupKey: 'c:/work/preview-a', displayName: 'preview-a',
      firstMessagePreview: '開始訊息第一行\n開始訊息第二行',
      lastMessagePreview: '最後訊息內容',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const card = findAllCards(app)[0];
  const toggle = findByClassName(card, 'preview-toggle');
  const body = findByClassName(card, 'preview-body');
  assert.ok(toggle, '卡片應包含可點擊的預覽切換元素');
  assert.ok(body, '卡片應包含預覽內容區塊');
  assert.equal(body.className.indexOf('preview-open'), -1, '預設應為收合狀態');

  const bodyTextBefore = body.children.map((el) => el.textContent).join('\n');
  assert.ok(bodyTextBefore.indexOf('開始') !== -1 && bodyTextBefore.indexOf('開始訊息第一行') !== -1, '應包含標示「開始」與 firstMessagePreview 內容');
  assert.ok(bodyTextBefore.indexOf('最後') !== -1 && bodyTextBefore.indexOf('最後訊息內容') !== -1, '應包含標示「最後」與 lastMessagePreview 內容');

  toggle.click();
  assert.ok(body.className.indexOf('preview-open') !== -1, '點擊後應展開（套用可見樣式 class）');

  toggle.click();
  assert.equal(body.className.indexOf('preview-open'), -1, '再次點擊應收合');
});

test('buildHtml — firstMessagePreview/lastMessagePreview 為 null 時顯示「無」占位文字，而非空白或拋出例外', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'null-preview', title: 't', cwd: 'C:\\work\\np', branch: null,
      groupKey: 'c:/work/np', displayName: 'np', firstMessagePreview: null, lastMessagePreview: null,
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const card = findAllCards(app)[0];
  const body = findByClassName(card, 'preview-body');
  const bodyText = body.children.map((el) => el.textContent).join('\n');
  assert.ok(bodyText.indexOf('無') !== -1, '找不到真實訊息時應顯示「無」占位文字');
});

test('buildHtml — 展開一張卡片的預覽不影響其他卡片的展開狀態（各卡片獨立）', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'card-alpha', title: 'Alpha標題', cwd: 'C:\\work\\alpha', branch: null,
      groupKey: 'c:/work/alpha', displayName: 'alpha', firstMessagePreview: 'Alpha開始', lastMessagePreview: 'Alpha最後',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
    {
      tool: 'claude-code', id: 'card-beta', title: 'Beta標題', cwd: 'C:\\work\\beta', branch: null,
      groupKey: 'c:/work/beta', displayName: 'beta', firstMessagePreview: 'Beta開始', lastMessagePreview: 'Beta最後',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-01T00:00:00.000Z', skippedCount: 0 });
  const { app } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findAllCards(app);
  assert.equal(cards.length, 2);
  const cardAlpha = cards.find((c) => c.children[0].textContent.indexOf('Alpha標題') !== -1);
  const cardBeta = cards.find((c) => c.children[0].textContent.indexOf('Beta標題') !== -1);
  const toggleAlpha = findByClassName(cardAlpha, 'preview-toggle');
  const bodyAlpha = findByClassName(cardAlpha, 'preview-body');
  const bodyBeta = findByClassName(cardBeta, 'preview-body');

  toggleAlpha.click();
  assert.ok(bodyAlpha.className.indexOf('preview-open') !== -1, 'Alpha 卡片應展開');
  assert.equal(bodyBeta.className.indexOf('preview-open'), -1, 'Beta 卡片不應受 Alpha 卡片點擊影響，維持收合');
});

test('buildHtml — 接續快速區卡片也套用相同的預覽切換（點擊展開顯示開始／最後訊息）', () => {
  const sessions = [
    {
      tool: 'claude-code', id: 'qr-preview', title: 't', cwd: 'C:\\work\\qrp', branch: null,
      groupKey: 'c:/work/qrp', displayName: 'qrp', pathExists: true,
      firstMessagePreview: '快速區開始', lastMessagePreview: '快速區最後',
      startedAt: '2026-08-01T00:00:00.000Z', lastActiveAt: '2026-08-02T00:00:00.000Z',
    },
  ];
  const html = buildHtml(sessions, { generatedAt: '2026-08-02T00:00:00.000Z', skippedCount: 0 });
  const { elementsById } = runDashboardScript(html, { 'range-filter': 'all' });
  const cards = findQuickResumeCards(elementsById);
  const card = cards[0];
  const toggle = findByClassName(card, 'preview-toggle');
  const body = findByClassName(card, 'preview-body');
  assert.ok(toggle && body, '接續快速區卡片也應有預覽切換元素');
  toggle.click();
  assert.ok(body.className.indexOf('preview-open') !== -1, '點擊後應展開');
  const bodyText = body.children.map((el) => el.textContent).join('\n');
  assert.ok(bodyText.indexOf('快速區開始') !== -1 && bodyText.indexOf('快速區最後') !== -1);
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
