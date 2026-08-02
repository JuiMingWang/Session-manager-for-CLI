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
