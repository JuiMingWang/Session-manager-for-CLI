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
- **輸出（原子寫入）**：先寫入**每個寫入者自己獨立的暫存檔**（檔名帶行程 PID + 亂數，例如 `~/.claude/sessions-dashboard.<pid>-<random>.html.tmp`），寫完再 rename 覆蓋成 `~/.claude/sessions-dashboard.html`（資料以 JSON 內嵌在 `<script>` 裡，純前端 JS 做搜尋/篩選/排序，不需啟動伺服器）。**暫存檔名不可固定共用**：若 Claude hook、Codex hook、手動 `/sessions` 三個觸發來源剛好同時執行、又共用同一個暫存檔名，會互相覆寫/截斷對方還沒寫完的暫存內容，甚至讓其中一個 rename 失敗；改成各自獨立命名的暫存檔後，每個寫入者只會 rename 自己完整寫完的檔案，rename 本身在檔案系統層級是原子操作，讀者永遠只會看到某一個完整版本（不保證是最新的那個，但不會是半成品），寫完後可以刪除自己的暫存檔殘留。
- **兩種觸發方式**：
  - **手動**：`/sessions` 斜線指令（`~/.claude/commands/sessions.md`）→ 執行腳本 + 用系統預設瀏覽器自動開啟（`start` 指令）。
  - **自動背景更新**：`~/.claude/settings.json` 的 `hooks.SessionStart` 與 `~/.codex/hooks.json` 的 `hooks.SessionStart` **都已經各自掛了一個既有 hook**（分別是桌寵 Claude Pet Companion、"Clawd on Desk"）。實作時必須讀出現有 JSON，在對應事件的 `hooks` 陣列裡**新增（append）一筆**指向我們腳本的項目，不可整段覆蓋或取代既有內容，否則會讓桌寵功能失效。新增的 hook command 要比照現有寫法明確指定完整直譯器路徑（例如 `& "C:/Program Files/nodejs/node.exe" "C:/Users/sjack/.claude/scripts/session-dashboard.js" --quiet`），不能只寫腳本檔名——Windows 不會自動用副檔名關聯去執行 `.js`。此觸發只重新產生檔案、不開瀏覽器。不管在 Claude Code 或 Codex 開新對話，儀表板資料都會在背景自動更新。
  - 採用 hook 而非常駐 file watcher / polling 服務：不需管理額外程序、不需處理程序意外掛掉或吃資源的問題，完全借用 agent 工具本來就有的生命週期事件。取捨是儀表板只在「新對話開始」當下更新，不會即時反映同一個長對話中途的最新訊息——但那正是使用者當下就在看的對話，通常不需要在儀表板上看。

## 2. 資料來源

| | Claude Code | Codex |
|---|---|---|
| 檔案位置 | `~/.claude/projects/**/*.jsonl`（排除 `subagents/` 子資料夾，那是 Agent 工具產生的子對話，非使用者會直接續接的 session） | `~/.codex/sessions/**/*.jsonl` + `~/.codex/archived_sessions/*.jsonl` |
| 標題 | 見下方「Claude Code 標題擷取規則」 | 見下方「Codex 標題與索引規則」 |
| cwd 來源 | 每行內的 `cwd` 欄位 | 第一行 `session_meta` 裡的 `payload.cwd` |
| git branch 欄位 | `gitBranch` | `git.branch`（巢狀物件，不是頂層 `gitBranch`） |
| 最後互動時間 | 檔案 mtime | 檔案 mtime |

兩者都採「輕量讀取」：每個檔案只讀開頭幾行（取得標題、`cwd`、起始時間、branch）+ 檔案 mtime，**不整份解析**。此法成本只跟檔案數量有關（目前約 32 個），跟檔案大小無關，掃全部歷史其實一樣快，不需要在掃描端做「只掃 30 天」的硬限制。

**Claude Code 標題擷取規則**：實測發現不少 jsonl 的第一則 `user` 記錄並非人類真正輸入的內容，而是 `isMeta: true` 的系統記錄，或是被 `<command-message>`、`<local-command-caveat>`、`<system-reminder>` 等標籤包住的指令/hook 注入文字（例如整段是 `<command-message>brainstorming</command-message>...`）。直接取「第一則使用者訊息」當標題會讓卡片標題變成這些系統文字、無法辨識。規則改為：依序掃描前 N 則（N=20）`user` 記錄，跳過 `isMeta: true` 的記錄，以及內容整段被上述已知系統標籤包住的記錄，取第一則「看起來是人類自然語言輸入」的訊息當標題（截斷）。若掃到 N 則都沒有符合條件的記錄，標題退回使用 `<cwd 的 basename>（時間戳記）`，確保卡片一定有可讀標題。

**Codex 標題與索引規則**：實測 `~/.codex/session_index.jsonl` 只有 41 筆記錄，但 `sessions/` 底下有 203 個 rollout 檔案，且索引裡有重複的 session id——索引**不是** rollout 檔案的完整對照表。規則改為：先把 `session_index.jsonl` 讀成一個 map（若同一個 id 出現多筆，以檔案中**較後面**的那筆為準，視為較新的更新覆蓋較舊的），再逐一比對每個 rollout 檔案的 session id；有對應索引項目就用其 `thread_name` 當標題，**沒有對應項目時**，退回跟 Claude Code 相同的策略——讀該 rollout 檔案開頭幾行，取第一則非 meta 的使用者輸入當標題，一樣找不到就退回 `<cwd 的 basename>（時間戳記）`。

## 3. 分類與卡片內容

- **分類規則（全自動）**：`cwd` 等於家目錄本身 → 標「雜項/隨手」；其他路徑 → 分組。**分組 key 用正規化後的完整 `cwd`**（統一轉小寫、`/` 與 `\` 都換成同一種分隔符、去除結尾斜線），**只有卡片顯示名稱**用該路徑的 basename——不能直接拿 basename 當分組 key，因為不同磁碟機/不同上層路徑下可能有同名資料夾（例如 `D:\work\api` 和 `E:\backup\api`），若只比對 basename 會把兩個完全無關的專案誤合併成同一組。分組/顯示一律使用 jsonl 內容裡的 `cwd` 欄位（真實路徑），不用磁碟上的資料夾名稱——因為中文路徑會被 Claude Code 編碼成一串底線（例如「經營模擬遊戲」→ `G--------------------`），資料夾名稱本身不可讀，只能用來定位檔案。
- **頁面呈現**：依專案分組卡片區塊，每張卡片顯示：
  - 工具標籤（Claude Code／Codex）
  - 標題
  - 最後互動時間（相對時間）
  - 開始時間
  - git branch（若有）
  - 「複製續接指令」按鈕：目標是這台機器的預設互動 shell（Windows PowerShell 5.1），該版本**不支援 `&&`**（PowerShell 7+ 才有），所以指令一律用分號銜接：Claude Code 為 `Set-Location -LiteralPath "<cwd>"; claude --resume <id>`；Codex 已用 `codex resume --help` 查證確有此指令（`codex resume [SESSION_ID] [PROMPT]`），格式為 `Set-Location -LiteralPath "<cwd>"; codex resume <id>`。v1 只保證這組指令能在 PowerShell 5.1 貼上執行，不特別處理 cmd.exe／bash 的複製格式。
- **搜尋/篩選（純前端，不需重新掃描）**：關鍵字搜尋、分類篩選（全部/專案/雜項）、工具篩選（全部/Claude Code/Codex）、時間範圍（7天/30天(預設)/90天/全部）、排序（最後互動時間，預設）。
- **輸出安全性（防止 stored XSS / 頁面損毀）**：標題、cwd、branch 名稱等全部來自使用者輸入或第三方檔案內容，視為不可信字串。JSON 內嵌到 `<script>` 時，序列化後要跳脫 `<`（例如把字串中的 `<` 換成 `\u003c`），避免內容中若剛好出現 `</script>` 提前結束整個 script 區塊、破壞頁面或造成注入。前端渲染卡片時一律用安全的方式輸出文字（如 `textContent`，或明確做 HTML escape 後才拼字串），不可把這些字串直接串進 `innerHTML`。

## 4. 邊界情況

- 壞掉/截斷的 jsonl 檔案 → try/catch 跳過該檔，頁面角落顯示「已跳過 N 個異常檔案」，不讓整個腳本中斷。
- 找不到 `~/.codex`（未安裝 Codex）→ 該來源直接跳過，Claude Code 部分照常顯示。
- Windows 路徑比對不分大小寫，判斷「是否為家目錄」時統一轉小寫比較。
- 頁面顯示「資料產生時間」，因為 HTML 是靜態檔案，已開啟的分頁需要手動重新整理才會看到最新資料。

## 5. 測試計畫

- 手動跑 `/sessions`，確認中文路徑專案（如「經營模擬遊戲」）正確顯示、Claude Code + Codex 混合分組正常。
- 用截斷過的假 jsonl 測試腳本不 crash。
- 用第一則使用者記錄是 `isMeta`／`<command-message>`／`<local-command-caveat>` 的假 jsonl 測試，確認標題會跳過這些記錄、抓到後面真正的人類輸入，或在都找不到時退回 `basename+時間戳` 而不是顯示系統文字。
- 用刻意重複 session id 的假 `session_index.jsonl`，搭配一個索引裡沒有對應項目的 rollout 檔案，確認 dedup（取較後面那筆）與「索引沒有時退回讀檔案本身」兩條路徑都正確。
- 用兩個不同磁碟機／路徑但同名資料夾（如 basename 都叫 `api`）的假資料，確認不會被誤合併成同一個分組卡片。
- 用標題或 cwd 裡包含 `</script>`、`<img src=x onerror=...>` 等字串的假資料，確認產出的 HTML 開啟後不會執行注入的程式碼、頁面結構不會被破壞。
- 分別在 Claude Code / Codex 開新對話，確認 `SessionStart` hook 有背景更新到檔案（看 mtime）、且不彈出任何干擾視窗；並確認 hook 修改後 `settings.json` / `hooks.json` 裡原本桌寵/Clawd on Desk 的 hook 項目還在（新增而非覆蓋)。
- 搜尋/篩選/排序純前端功能手動點過一輪即可，不用寫 e2e 測試。

<!-- codex-peer-reviewed: 2026-08-02T01:50:29Z rounds=3 verdict=approved -->
