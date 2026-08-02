
## 2026-08-02T07:30:58Z
- Deployed session-dashboard.js and sessions.md to ~/.claude/
- Ran install-session-dashboard-hooks.js — appended SessionStart hooks to ~/.claude/settings.json and ~/.codex/hooks.json (existing pet-companion / Clawd on Desk entries preserved, verified by direct inspection)
- Manual QA: /sessions ran successfully — 262 sessions scanned (53 Claude Code + 209 Codex), 0 files skipped
- Verified Chinese folder name (經營模擬遊戲) renders correctly, not as an encoded folder name
- Verified embedJsonSafely correctly escaped a real </script> sequence found in actual session data (1 literal closing tag, 1 escaped occurrence)
- Verified resume-command copy button uses single-quoted PowerShell syntax (Set-Location -LiteralPath '...'; claude --resume <id>)

## 2026-08-02T08:01:50Z
- Manual browser QA (post-deploy) surfaced two real bugs unit tests didn't catch:
  1. main() passed claudeHomeDir/codexHomeDir instead of the real os.homedir() into scanClaudeCode/scanCodex — home-directory sessions were never grouped as 雜項/隨手. Fixed (commit 1a9e434) by threading os.homedir() through explicitly, plus 4 regression tests including a main()-level integration test.
  2. A Codex session title showed the raw injected "# AGENTS.md instructions ..." block instead of a real title — its prefix wasn't on CODEX_SYNTHETIC_PREFIXES, since a whitelist can never be exhaustive. Fixed (commit 73a37dd) by adding looksLikeInjectedDocument(): long text opening with a heading/tag, or with 2+ heading lines, is treated as synthetic regardless of prefix.
- Redeployed both fixes to ~/.claude/scripts/session-dashboard.js and regenerated the dashboard.
- Verified against real data: 263 sessions, 0 sessions still showing the AGENTS.md-injection title, home-directory sessions correctly grouped as misc (visually confirmed via screenshot).
- Noted for follow-up: 73/263 (28%) of sessions still fall back to basename+timestamp titles — this is the already-disclosed N=20 scan-window tradeoff, now with a real measured rate. Flagged to the user as a separate discussion, not fixed in this pass.
