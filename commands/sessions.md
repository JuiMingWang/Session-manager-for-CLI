---
description: 重新整理並開啟 Session 管理器儀表板（Claude Code + Codex）。
allowed-tools: Bash(node:*)
---

Run:

```bash
node "$HOME/.claude/scripts/session-dashboard.js"
```

Then tell the user the dashboard has been refreshed and opened in their browser. If the command's output mentions skipped files, mention the count to the user.
