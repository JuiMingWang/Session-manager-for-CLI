# Session 管理器（`/sessions`）設計文件

日期：2026-08-02

## 背景與動機

隨著專案數量增加，coding agent（Claude Code、Codex 等）產生的對話 session 越來越難管理。有些 session 屬於特定專案的長期工作，有些是在家目錄下隨手處理的小任務，兩者目前混在一起，難以回顧、續接或整理。

初步環境調查發現：`~/.claude/projects/` 底下的 `C--Users-sjack`（即直接在家目錄啟動 Claude Code 產生的 session）數量遠多於各專案資料夾內的 session，代表大量工作並未進到專案目錄內執行，使得依「工作目錄」分組的機制失去作用。

## 範圍決策

- 評估過現成工具 `agtx`（多 agent 協作看板）：功能涵蓋 Claude Code、Codex、Gemini CLI、Cursor Agent CLI 等多種工具，但核心工作流是整套 kanban + git worktree + spec-driven 流程，且**硬性需要 tmux**（本機未安裝，Windows 原生也不支援）。與需求「單純可視覺化瀏覽/續接 session」的範圍差距過大，決定不採用，改為自建輕量工具。
- 各 agent 工具的 session 儲存方式調查結果：

| 工具 | 可行性 | 原因 |
|---|---|---|
| Claude Code | 可行 | 純文字 jsonl，內含完整 `cwd`，且有 `SessionStart` hook |
| Codex | 可行 | `session_index.jsonl` 已內建 `thread_name`，`sessions/`／`archived_sessions/` 存 rollout jsonl，`hooks.json` 也有 `SessionStart` |
| Antigravity（agy） | 不可行（v1 排除） | 本機 `state.vscdb` 裡的 `chat.ChatSessionStore.index` 是空的，對話狀態疑似同步到 Google 雲端，非本機可讀 log；要整合需逆向私有雲端協定，範圍過大 |
| Cursor | 不可行（v1 排除，資料不存在） | 這台機器沒有 Cursor 桌面 App 的資料夾，也沒裝 `cursor-agent` CLI，無資料可讀 |

**v1 只做 Claude Code + Codex 兩個 adapter**（架構上採可插拔的 source adapter 設計，未來要加 Antigravity／Cursor 時可再擴充）。

## 1. 架構與觸發

- **核心腳本**：`~/.claude/scripts/session-dashboard.js`（單一 Node.js 檔案）。內含兩個平行的掃描函式 `scanClaudeCode()` / `scanCodex()`，各自回傳統一格式的 session 物件。不做額外的 plugin/class 抽象架構，兩個來源的差異不足以需要那種複雜度。
- **輸出**：固定覆寫單一檔案 `~/.claude/sessions-dashboard.html`（資料以 JSON 內嵌在 `<script>` 裡，純前端 JS 做搜尋/篩選/排序，不需啟動伺服器）。
- **兩種觸發方式**：
  - **手動**：`/sessions` 斜線指令（`~/.claude/commands/sessions.md`）→ 執行腳本 + 用系統預設瀏覽器自動開啟（`start` 指令）。
  - **自動背景更新**：`~/.claude/settings.json` 的 `hooks.SessionStart` 與 `~/.codex/hooks.json` 的 `hooks.SessionStart` 都掛上同一支腳本（`--quiet` 模式，只重新產生檔案、不開瀏覽器）。不管在 Claude Code 或 Codex 開新對話，儀表板資料都會在背景自動更新。
  - 採用 hook 而非常駐 file watcher / polling 服務：不需管理額外程序、不需處理程序意外掛掉或吃資源的問題，完全借用 agent 工具本來就有的生命週期事件。取捨是儀表板只在「新對話開始」當下更新，不會即時反映同一個長對話中途的最新訊息——但那正是使用者當下就在看的對話，通常不需要在儀表板上看。

## 2. 資料來源

| | Claude Code | Codex |
|---|---|---|
| 檔案位置 | `~/.claude/projects/**/*.jsonl`（排除 `subagents/` 子資料夾，那是 Agent 工具產生的子對話，非使用者會直接續接的 session） | `~/.codex/sessions/**/*.jsonl` + `~/.codex/archived_sessions/*.jsonl` |
| 標題 | 第一則使用者訊息（截斷） | 優先讀 `~/.codex/session_index.jsonl` 裡現成的 `thread_name` |
| cwd 來源 | 每行內的 `cwd` 欄位 | 第一行 `session_meta` 裡的 `payload.cwd` |
| 最後互動時間 | 檔案 mtime | 檔案 mtime |

兩者都採「輕量讀取」：每個檔案只讀開頭幾行（取得標題、`cwd`、起始時間、`gitBranch`）+ 檔案 mtime，**不整份解析**。此法成本只跟檔案數量有關（目前約 32 個），跟檔案大小無關，掃全部歷史其實一樣快，不需要在掃描端做「只掃 30 天」的硬限制。

## 3. 分類與卡片內容

- **分類規則（全自動）**：`cwd` 等於家目錄本身 → 標「雜項/隨手」；其他路徑 → 以資料夾名稱（basename）當專案名稱分組。**關鍵修正**：分組/顯示一律使用 jsonl 內容裡的 `cwd` 欄位（真實路徑），不用磁碟上的資料夾名稱——因為中文路徑會被 Claude Code 編碼成一串底線（例如「經營模擬遊戲」→ `G--------------------`），資料夾名稱本身不可讀，只能用來定位檔案。
- **頁面呈現**：依專案分組卡片區塊，每張卡片顯示：
  - 工具標籤（Claude Code／Codex）
  - 標題
  - 最後互動時間（相對時間）
  - 開始時間
  - git branch（若有）
  - 「複製續接指令」按鈕：Claude Code 為 `cd "<cwd>" && claude --resume <id>`；Codex 的確切 resume 指令語法尚待查證，實作時以 `codex resume --help` 核對後填入，不會憑印象亂寫。
- **搜尋/篩選（純前端，不需重新掃描）**：關鍵字搜尋、分類篩選（全部/專案/雜項）、工具篩選（全部/Claude Code/Codex）、時間範圍（7天/30天(預設)/90天/全部）、排序（最後互動時間，預設）。

## 4. 邊界情況

- 壞掉/截斷的 jsonl 檔案 → try/catch 跳過該檔，頁面角落顯示「已跳過 N 個異常檔案」，不讓整個腳本中斷。
- 找不到 `~/.codex`（未安裝 Codex）→ 該來源直接跳過，Claude Code 部分照常顯示。
- Windows 路徑比對不分大小寫，判斷「是否為家目錄」時統一轉小寫比較。
- 頁面顯示「資料產生時間」，因為 HTML 是靜態檔案，已開啟的分頁需要手動重新整理才會看到最新資料。

## 5. 測試計畫

- 手動跑 `/sessions`，確認中文路徑專案（如「經營模擬遊戲」）正確顯示、Claude Code + Codex 混合分組正常。
- 用截斷過的假 jsonl 測試腳本不 crash。
- 分別在 Claude Code / Codex 開新對話，確認 `SessionStart` hook 有背景更新到檔案（看 mtime）、且不彈出任何干擾視窗。
- 搜尋/篩選/排序純前端功能手動點過一輪即可，不用寫 e2e 測試。
