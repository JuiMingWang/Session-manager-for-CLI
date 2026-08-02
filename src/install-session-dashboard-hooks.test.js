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
