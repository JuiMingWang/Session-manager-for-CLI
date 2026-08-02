
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

## 2026-08-02T11:54:09Z
- User feedback after visual review: (1) some titles look like the session's literal first message (working as designed; one specific case turned out to be an indistinguishable automated MCP-trigger message, not a bug — documented limitation), (2) same session showing as duplicate cards, (3) same project split into multiple unexplained blocks across drives.
- Root-caused (2) with real data: Claude Code writes a fresh jsonl copy per project folder location when a project moves/is copied across drives — same session id, multiple physical files. Fixed via dedupeSessions() (commit f0e6f53): dedupe by (tool, id), keep the entry with the latest lastActiveAt. Verified: 0 duplicate (tool,id) pairs remain in real data (previously 5 duplicate ids, 14 physical entries).
- Addressed (3) per user's explicit choice (keep full-path grouping, add visual linking): same-displayName groups now render under one shared cluster heading with a "(N 個位置)" count, and each sub-block shows its real path. Verified in browser: "經營模擬遊戲（3 個位置）" cluster correctly shows all 3 real paths (OneDrive, local Documents, G-drive).
- Redeployed to ~/.claude/scripts/session-dashboard.js and regenerated the dashboard.

## 2026-08-02T12:54:30Z
- User feedback: (1) /sessions 消耗 token，質疑能否比照 /resume 做到零 token；(2) 資訊量大（24 個分組、263+ session）時希望視覺結構能一眼分辨，選擇手風琴摺疊。
- 確認 (1)：main() 本身就是純 Node 腳本（掃描→寫檔→cmd.exe /c start 開瀏覽器），不依賴 Claude Code runtime，可直接在 PowerShell 執行，完全不經過模型 API。改在 $PROFILE（C:\Users\sjack\OneDrive\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1）新增 `agent session` 函式（`agent` 主指令 + `session` 子指令），呼叫 `node "$HOME\.claude\scripts\session-dashboard.js"`，達成 CLI 內零 token 刷新+開啟。同時釐清 SessionStart hook 本來就用 `--quiet`，只背景重新產生 html、不會跳出瀏覽器，不會打斷開新 session 討論。
- 實作 (2)：每個分組（含雜項/隨手）改用原生 `<details>/<summary>` 摺疊，預設只展開最近活動的前 5 個分組，其餘收合；當使用者輸入搜尋文字時，強制展開所有符合的分組（不受名次限制），避免搜尋結果被摺疊擋住。
- 測試：新增 5 個行為測試，透過 node:vm 建立最小 DOM stub 實際執行內嵌的前端 script（而非只檢查字串），驗證摺疊/展開的實際渲染結果——因為同一段渲染/分組程式碼過去已經出過兩次僅靠字串測試抓不到的整合性 bug。全部 76 個測試通過。
- 部署驗證：重新產生的 sessions-dashboard.html 經 `agent session` 開啟後，實測真實資料共 24 個分組，預設展開 5 個、收合 19 個，搜尋「經營模擬遊戲」時 3 個符合的分組全部展開（含原本收合的），行為與設計一致。

## 2026-08-02T15:23:05Z
- 實作 ticket 01（退而標題可靠性標記）：`scanClaudeCodeFile`／`scanCodexFile` 新增 `titleIsFallback: boolean` 欄位——先把 `extractClaudeTitle`／`extractCodexTitle`（Codex 再加 index thread_name）的結果存成變數，再據此同時決定 `title` 與 `titleIsFallback`，不重複呼叫擷取邏輯。`buildHtml` 的 `renderCard` 在 `titleIsFallback === true` 時為標題 div 套用新增的 `.title-fallback` CSS class（沿用既有 `.meta` 灰階色 `#888`，加 `font-style: italic`），與真實標題明顯區隔。
- 嚴格 TDD：先擴充既有的 `scanClaudeCodeFile`（真實標題／退回標題兩種情境）與 `scanCodexFile`（index 標題／file-scan 標題兩種情境）測試斷言 `titleIsFallback`，另新增一個 Codex「index 與 file-scan 皆找不到、真的退回資料夾名+時間戳」的情境測試（先前完全沒有涵蓋這條路徑），以及一個透過既有 `runDashboardScript`/`makeFakeElement`（`node:vm` DOM 執行手法）驗證渲染出的卡片標題 div 確實套用 `title-fallback` class、真實標題不套用的測試。全部先跑過確認會失敗，再實作最小改動讓其通過。
- 測試數：76 → 78（全部通過，無既有測試被破壞）。
- 已同步部署：`cp src/session-dashboard.js ~/.claude/scripts/session-dashboard.js`，重新執行 `node ~/.claude/scripts/session-dashboard.js --quiet` exit code 0。字串檢查確認產出的 `sessions-dashboard.html` 內 `titleIsFallback":true` 出現 80 次、`titleIsFallback":false` 出現 198 次（共 278 筆 session，約 29% 退而標題，與先前記錄的 28% 量測值相符），`title-fallback` class 定義與套用邏輯皆存在。
- 尚未完成：肉眼瀏覽器 QA（ticket 最後一項勾選項）——本次刻意維持 `--quiet` 不開瀏覽器（任務指示不可開瀏覽器操作真實資料），故該項留待使用者或下次工作階段人工確認灰階斜體樣式的實際渲染效果。
