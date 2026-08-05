# Session 管理器：現況總覽與 Antigravity 整合／模組化規劃

## 目的

這份文件有兩個目的：

1. 完整記錄目前 `src/session-dashboard.js` 具備哪些功能、各自如何執行（掃描來源、資料流、輸出），做為既有行為的基準（regression baseline）。
2. 記錄尚未動工的兩項規劃 —— (a) 既有兩個 adapter（Claude Code、Codex）的模組化拆分，(b) 新增 Antigravity 支援 —— 的具體設計，交由 codex-peer-review 檢驗方向與細節是否合理，再據以實作。

範圍只涵蓋「現況＋這兩項規劃」，不重新討論已經定案並上線的功能決策（例如久未使用整理區要不要顯示、隱藏功能要不要做刪除等）——那些已經是使用者核准過的既定行為，此文件只如實記錄它們「現在長什麼樣子」。

## 現況：已完成功能與執行方式

工具是一個零 npm 依賴、單一自包含 HTML 檔案的產生器。`node src/session-dashboard.js` 是唯一入口，執行後在 `~/.claude/sessions-dashboard.html` 寫出（`writeAtomic`，先寫暫存檔再 rename，避免半寫檔案）一份完整的靜態頁面，並在非 `--quiet`／非 `--hide`／`--unhide` 模式下自動開啟瀏覽器（`defaultOpenBrowser`）。

### 執行流程（`main(argv, options)`）

1. `parseArgs(argv)` 解析 `--quiet`、`--hide <tool> <id>`、`--unhide <tool> <id>`。
2. 若帶 `--hide`／`--unhide`，先呼叫 `hideSession`／`unhideSession` 寫入 `~/.claude/session-dashboard-hidden.json`。
3. `scanClaudeCode(claudeHomeDir, homeDir)` 與 `scanCodex(codexHomeDir, homeDir)` **各自獨立**掃描本機檔案，回傳 `{ sessions, skipped }`。
4. `dedupeSessions([...claude, ...codex])` 依 `(tool, id)` 去重。
5. `loadHiddenList` 讀隱藏清單，`filterHiddenSessions` 過濾掉已隱藏的 session（此步驟在 `dedupeSessions` 之後、`buildHtml` 之前，因此隱藏會同時套用到接續快速區／專案樹／久未使用整理區三處，不需要在每個 render 分支各自處理一次）。
6. `buildHtml(sessions, meta)` 產生完整 HTML 字串（包含內嵌 `<script>`，資料以 `embedJsonSafely` 序列化後嵌入頁面，瀏覽器端不再讀取任何外部檔案或網路資源 — 見 ADR-0002）。
7. `writeAtomic` 寫檔，非靜默模式下開瀏覽器。

**部署機制**：`src/install-session-dashboard-hooks.js` 在 Claude Code 的 `~/.claude/settings.json`（`SessionStart` hook）與 Codex 的 `~/.codex/hooks.json`（若存在）各自安裝一筆 `node .../session-dashboard.js --quiet` 的呼叫，兩者的 session 一開始就自動重新產生儀表板；改動 `session-dashboard.js` 後另需手動 `cp` 到 `~/.claude/scripts/session-dashboard.js`（部署副本），這是目前唯一的「原始碼」與「實際執行檔」不同路徑的落差。**這個手動複製的動作本身（改完程式碼要記得部署一次）在模組化之後依然存在，不會消失**；但「複製哪些檔案」這個具體內容，會因為模組化拆出 `src/adapters/` 目錄而必須跟著改變——詳見下方「規劃一：既有 adapter 模組化拆分」段落新增的「模組化對部署流程的影響」小節，那一節定義的新複製方式是模組化這輪的強制項目，不是可以延後的既有慣例。

### 資料掃描（Claude Code、Codex 兩個來源，各自獨立實作）

| | Claude Code | Codex |
|---|---|---|
| 掃描根目錄 | `~/.claude/projects/**/*.jsonl`（`walkJsonlFiles`，排除特定目錄） | `~/.codex` 下的 session 記錄（含 index 檔 `loadCodexIndex`） |
| 單檔解析 | `scanClaudeCodeFile` | `scanCodexFile` |
| cwd／分支 | `findClaudeCwdAndBranch` 從記錄裡找 | 由 index/檔案內容取得 |
| 標題掃描 | `extractClaudeTitle` | `extractCodexTitle` |
| 訊息預覽（首/末則） | `extractFirstMessagePreview` / `extractLastMessagePreview`，共用 `findGenuineMessageText` + 各自的 matcher（`CLAUDE_MESSAGE_MATCHERS`／`CLAUDE_LAST_MESSAGE_MATCHERS`） | 同左，`CODEX_MESSAGE_MATCHERS`／`CODEX_LAST_MESSAGE_MATCHERS` + `extractResponseItemTextAnyRole` |
| 雜訊過濾 | `isSyntheticClaudeText` | `isSyntheticCodexText`（含 JSON approval 區塊過濾、`looksLikeInjectedDocument`） |

兩者都靠 `readFirstJsonLines`／`readLastJsonLines`（64KB 定長區塊讀取、只在原始 `0x0a` byte 上切行，避免 UTF-8 多位元組字元被切斷）做檔案 I/O，`readExpandingHeadRecords` 則是效能關鍵：從 20 筆開始往前掃，掃不到真實訊息才擴大視窗（20→60→180→500），一旦 `readFirstJsonLines` 回傳筆數小於要求視窗（代表已到檔尾）就立刻停止擴張——這是先前訊息預覽 bug 修復後，為了避免「真的是空 session」被反覆放大視窗掃描拖慢效能而加的停損。

### 前端渲染（`buildHtml` 內嵌的 `<script>`，皆為原生 JS，無框架）

- **接續快速區**：頁面頂部固定區塊，全站最新 8 筆可接續 session，獨立於篩選狀態、只在載入時渲染一次（`renderQuickResume()`，見 ADR-0001），排除失效路徑（cwd 不存在於本機磁碟）的 session。
- **專案樹**：依 `groupKey`（正規化後的專案識別）分組，展開圖示＋連接線的縮排階層，預設全部收合；`groupKey === '__misc__'` 的 session（cwd 就是家目錄本身）落在「雜項」淺層分支，沒有路徑子節點這一層。
- **久未使用整理區**：對 `lastActiveAt` 超過 90 天（`STALE_THRESHOLD_MS`）的 session，額外集中列在專案樹最上方一個獨立區塊；**同一筆 session 會同時出現在這裡與其原本的專案節點下**（不是互斥的兩個位置），專案節點下的卡片會多一個「久未使用（也列於最上方整理區）」的 `.stale-marker` 標記，整理區裡的卡片本身則不重複顯示這個標記（`renderCard(s, container, { hideStaleMarker: true })`）。這個區塊有自己獨立的過濾管線，刻意不套用「最近 N 天」篩選（否則 90 天前的 session 會先被篩選器排除，導致整理區永遠是空的 —— 這是實作時自己抓到並修正過的邏輯矛盾）。
- **隱藏功能**：每張專案樹卡片（不含接續快速區的精簡卡片）有「隱藏」按鈕，點擊後把 `node "$HOME/.claude/scripts/session-dashboard.js" --hide <tool> <id>` 複製到剪貼簿（`navigator.clipboard.writeText`），使用者貼到終端機執行，才會真的寫入 `~/.claude/session-dashboard-hidden.json` 並讓儀表板重新產生時排除它 —— 跟既有「複製續接指令」按鈕是同一套「複製指令→貼到終端機」模式，沒有另外發明新機制。指令路徑刻意用正斜線（不是反斜線），避免這段文字要穿過兩層 JS 字串跳脫（`buildHtml` 的外層 template literal → 瀏覽器解析內嵌 `<script>` 文字）時，反斜線需要寫成 `\\\\` 才能存活成單一反斜線的雙重跳脫陷阱。
- **其他既有 UI 決策**：工具徽章（區分 Claude Code／Codex）、退而標題與失效路徑的視覺警告（灰階／斜體，見 CONTEXT.md 對應詞彙）、深色模式、依專案／依工具／依時間區間的篩選器、搜尋框。

### 測試（`src/session-dashboard.test.js`，141 筆，皆通過）

除了對後端純函式（掃描、解析、去重、隱藏清單 CRUD）的單元測試外，前端渲染邏輯是用 `node:vm` 把 `buildHtml` 產出的 HTML 中的 `<script>` 實際丟進一個假 `document`／`navigator` 執行（`runDashboardScript(html, controlValues)`），包含追蹤 `clipboardWrites` 陣列來驗證複製到剪貼簿的按鈕行為 —— 也就是說前端互動邏輯有被真的「執行」驗證過，不只是字串比對 HTML 有沒有出現某個 class 名稱。

## 規劃一：既有 adapter 模組化拆分

### 現況問題

`session-dashboard.js` 單一檔案已經 1150 行，混雜了「Claude Code 掃描」「Codex 掃描」「前端 HTML/CSS/JS 產生」「CLI 進入點」四種職責。這本身不是 bug，但在即將新增第三個資料來源（Antigravity）時，若繼續往同一個檔案疊加，會讓「這次改動有沒有不小心影響到 Claude/Codex 既有邏輯」這件事難以用檔案邊界直接看出來，只能靠讀 diff 逐行確認 —— 使用者在這次需求裡明確要求擴充 Antigravity 時「不要影響到另外兩個 agent 的管理」，模組化正是把這個約束變成「結構上就分開」而不是「靠小心翼翼不要改錯」。

### 拆分方式（純搬移程式碼，不改變任何行為）

- `src/adapters/claude-code.js`：`findClaudeCwdAndBranch`、`extractClaudeTitle`、`isSyntheticClaudeText`、`scanClaudeCodeFile`、`scanClaudeCode`，以及 Claude 專屬的 matcher 常數。對外只匯出 `scanClaudeCode(claudeHomeDir, realHomeDir)`，回傳 `{ sessions, skipped }`（跟現在的回傳形狀完全相同）。
- `src/adapters/codex.js`：對應的 Codex 邏輯與 `scanCodex(codexHomeDir, realHomeDir)`，回傳形狀同上。
- 共用工具（`readFirstJsonLines`、`readLastJsonLines`、`readExpandingHeadRecords`、`findGenuineMessageText`、`extractFirstMessagePreview`、`extractLastMessagePreview`、`buildMessagePreview`、`looksLikeInjectedDocument`、`normalizePath`、`normalizeGroupKey`、`displayNameForCwd`，以及**先前版本誤放進 Claude adapter 清單、實際上是兩者共用的 `walkJsonlFiles` 與 `TAIL_MESSAGE_SCAN_WINDOW`**——`walkJsonlFiles` 不只被 Claude 用，`scanCodex` 也用它掃 `sessions`／`archived_sessions` 兩個子目錄（`session-dashboard.js:549-550`），`TAIL_MESSAGE_SCAN_WINDOW` 同樣被兩個 adapter 的檔尾掃描共用（`session-dashboard.js:356,372,525`），這兩個都必須放進 `src/adapters/shared.js`，不能只放進 Claude adapter 檔案，否則 Codex adapter 會沒有合法的依賴路徑（Claude adapter 依規劃只對外匯出 `scanClaudeCode`，沒有匯出 `walkJsonlFiles` 給 Codex 引用））留在一個 `src/adapters/shared.js`，由三個 adapter 各自 `require`。**這些函式各自依賴的常數必須跟著函式一起搬過去，不能只搬函式、把常數留在 orchestrator（否則 shared module 執行時會因為讀不到常數拋出 `ReferenceError`）**：`readExpandingHeadRecords` 依賴 `HEAD_SCAN_INITIAL_WINDOW`／`HEAD_SCAN_EXPANSION_FACTOR`／`HEAD_SCAN_MAX_WINDOW`；`buildMessagePreview` 依賴 `MESSAGE_PREVIEW_MAX_LINES`；`looksLikeInjectedDocument` 依賴 `INJECTED_DOCUMENT_MIN_LENGTH`——這三組常數都要跟著對應函式一起移到 `shared.js`。
- `src/session-dashboard.js` 縮減為「orchestrator」：`parseArgs`、`dedupeSessions`、隱藏清單相關函式、`buildHtml`、`writeAtomic`、`main()` —— 呼叫三個 adapter 的 `scanXxx()`、合併結果、產生 HTML。

### 驗證方式

這是一次純粹的程式碼搬移（code motion），不是重構或改行為。驗證標準：**搬移前後，現有 141 筆測試必須全部維持通過，不新增、不刪除、不修改任何測試斷言**（除了測試檔案內 `require` 路徑因應新檔案位置而更新之外）。如果某筆既有測試因為搬移而需要改斷言內容（而不只是 import 路徑），就代表這不是純搬移，必須先停下來確認是不是不小心改了行為。

### 風險與取捨

- 好處：Antigravity 的程式碼將完全落在自己的 `src/adapters/antigravity.js`，讀 diff 或做 code review 時「這次改動有沒有碰到 Claude/Codex」直接由檔案清單回答，不需要逐行讀懂 orchestrator 邏輯。
- 代價：這輪需要花時間做一次跟功能無關的搬移，且搬移期間 141 筆測試的 import 路徑要跟著調整 —— 純屬一次性 token／時間成本，換取後續加 Antigravity 時的隔離保證。
- 這步驟必須先於 Antigravity 開發完成，因為如果先把 Antigravity 加進尚未拆分的單一大檔案，之後再拆分時就要同時處理「搬三份邏輯」＋「這次搬移有沒有不小心動到剛寫好的 Antigravity 邏輯」兩件事，風險疊加；反過來，先拆分（此時只有兩個既有、已被 141 筆測試充分覆蓋的來源）再加第三個，新程式碼从一開始就寫在正確的檔案邊界內，不需要再搬一次。

### 模組化對部署流程的影響（先前規劃遺漏，會直接讓部署壞掉，這次補上）

`docs/deploy-log.md` 記錄的既有部署方式，每一次改動都是單純 `cp src/session-dashboard.js ~/.claude/scripts/session-dashboard.js`——只複製這一個檔案。模組化拆分後，`session-dashboard.js` 會變成 `require('./adapters/claude-code.js')` 等等，若部署流程沒有跟著改，只複製這一個檔案到 `~/.claude/scripts/` 底下，`adapters/` 整個目錄不會被一起複製過去——SessionStart hook 觸發執行時會因為 `require` 找不到模組而直接拋出例外、整個腳本執行失敗，這不是「Antigravity 這個來源掛掉」而是「整支工具在使用者每次開新 session 時都會噴錯」，比引入 Antigravity 之前任何一個問題都嚴重。而且**這個 regression 完全不會被 141 筆測試或任何在 `src/` 目錄底下跑的測試抓到**——測試是直接對著 `src/session-dashboard.js`（連同它旁邊的 `src/adapters/`）跑的，模組解析永遠會成功；只有「真的模擬部署流程、對複製出去的那份檔案執行」才會暴露這個問題。

因此模組化拆分的完成定義（definition of done）必須明確包含部署契約的更新與驗證，不能只看測試是否全綠：
- 部署指令改成連同 `adapters/` 目錄一起複製（例如 `cp src/session-dashboard.js ~/.claude/scripts/session-dashboard.js` 之後，再 `cp -r src/adapters ~/.claude/scripts/adapters`，或直接複製整個 `src/` 目錄排除測試檔），`docs/deploy-log.md` 往後每一則部署記錄都要沿用新的複製方式。
- 完成模組化後，實作者必須**實際**清空一份暫存的「模擬部署目錄」、依新的複製方式部署過去，再對那份複製出來的檔案執行 `node <部署路徑>/session-dashboard.js --quiet` 確認 exit code 0、沒有 `Cannot find module` 之類的錯誤——這是既有「肉眼 QA／人工驗證」慣例之外，這次模組化必須新增的一個具體、非人工判斷（有明確 exit code 可驗證）的驗證步驟，不可省略。

## 規劃二：新增 Antigravity 支援

> **本節於 2026-08-03 第二次修訂**：初版規劃寫完並經過 codex-peer-review 核准後，使用者要求「先上網研究社群是否已經摸清 Antigravity 的資料結構，避免我們自己閉門造車漏掉東西」。研究＋對照真機資料庫重新驗證後，發現初版對 protobuf 欄位位置的推測有一處實質錯誤，並發現一個原本設計的安全機制在真實資料上完全不成立。以下內容取代初版的對應段落；被取代的具體理由與新舊差異，見文末〈本次修訂摘要〉。

### 可行性結論（已驗證，非假設；本次追加社群交叉驗證）

Google Antigravity（VS Code fork）的本機資料分散在 `~/.gemini/antigravity/` 與 `~/AppData/Roaming/Antigravity IDE/`（Electron userData，標準 VS Code fork 佈局）。逐一驗證各種資料來源後：

| 來源 | 格式 | 可讀性 |
|---|---|---|
| `conversations/*.pb` | 未知二進位（非 gzip/zlib/deflate，幾乎無可印字元） | **不可直接讀取**，不採用 |
| `conversations/*.db` | 真正 SQLite（`node:sqlite` 可開），但訊息內容欄位是 protobuf BLOB | 結構可讀，內容仍需 schema |
| `~/.gemini/antigravity/brain/<uuid>/task.md.metadata.json` | 純 JSON，`summary`／`updatedAt` | **可直接讀取**，但覆蓋率不完整（實測 10 筆對話中 5 筆有這個檔案） |
| `~/.gemini/antigravity/brain/<uuid>/.system_generated/logs/transcript.jsonl` | 純 JSON Lines，逐輪紀錄，`source:"USER_EXPLICIT"`＋`type:"USER_INPUT"`＋`<USER_REQUEST>` 標記包住使用者逐字輸入 | **可直接讀取，且是逐字輸入**（跟 Claude Code／Codex 的 `history.jsonl` 精神一致），但覆蓋率比 `task.md.metadata.json` 更低（實測 10 筆對話中只有 2 筆有這個檔案）；本輪不採用，留作未來訊息預覽的候選來源 |
| `User/workspaceStorage/<hash>/workspace.json` | 標準 VS Code JSON，`folder` 欄位 | **可直接讀取**，但只列出「目前開啟過的 workspace」，不是「每筆對話對應哪個 workspace」的清單 |
| `User/globalStorage/state.vscdb` 的 `antigravityUnifiedStateSync.trajectorySummaries` key | base64 → protobuf（無官方 schema，UI 內部同步用） | **可讀取，且欄位位置已經社群交叉驗證＋對照真機資料庫修正**（見下一節） |

**社群交叉驗證**：GitHub 上已有人針對這個資料格式做過獨立逆向工程並公開 `.proto` schema——[`ag-donald/Antigravity-Database-Manager`](https://github.com/ag-donald/Antigravity-Database-Manager)（`docs/schema.proto`）記錄了 `TrajectorySummary`／`TrajectoryPayload`／`WorkspaceInfo` 的欄位編號，[`winters27/google-antigravity-export`](https://github.com/winters27/google-antigravity-export) 則走另一條路（連 Antigravity 執行中的本機 HTTP API，呼叫 `GetAllCascadeTrajectories`），需要 Antigravity 正在執行，跟本專案「離線掃描靜態檔案」的既定設計方向不同，本輪不採用，僅供未來參考。拿這份社群 schema 對照這台機器真實的 `state.vscdb` 逐欄位重新解碼後，**確認初版規劃裡的「depth4/field7 = workspace URI」是錯的**（見下一節修正版）。

### 修正後的欄位結構（已對照社群 schema＋真機資料重新驗證）

**關鍵修正：中間多了一層先前完全沒發現的 base64 包裝。** 完整路徑：

1. `state.vscdb` 的 `value` 欄位（文字型別）→ `Buffer.from(value, 'base64')` → 外層 protobuf bytes（此步驟初版就有，沒有變）。
2. 外層 protobuf：`repeated TrajectorySummary entries = field 1`。每筆 `TrajectorySummary` 只有兩個欄位：`field 1`＝對話 UUID（字串）、`field 2`＝**又是一段 base64 字串**（不是直接的巢狀 protobuf bytes！這是初版完全沒發現的一層）。
3. 把 `field 2` 的 bytes 當 UTF-8 文字讀出來，**再做一次** `Buffer.from(str, 'base64')`，才會拿到真正的 `TrajectoryPayload` protobuf bytes。

`TrajectoryPayload` 已驗證的欄位（對照這台機器全部 8 筆真實資料，欄位位置 100% 一致）：

| 欄位 | 型別 | 內容 | 初版規劃是否正確 |
|---|---|---|---|
| `field 1` | string | **標題**（例如「整理並上傳專案至 GitHub」） | 位置猜對了，但初版決定「不採用」，本次修正為採用（見下） |
| `field 3` | Timestamp `{seconds, nanos}` | created_at | 初版沒提到 |
| `field 4` | string | 第二組 UUID（與 outer UUID 不同） | 位置猜對了 |
| `field 7` | Timestamp `{seconds, nanos}` | updated_at | **初版誤判為 workspace URI，這是本次修正的核心錯誤** |
| `field 9` | 巢狀訊息 `WorkspaceInfo` | 見下 | 初版完全沒發現這層巢狀 |
| `field 10` | Timestamp | accessed_at | 初版沒提到 |

`WorkspaceInfo`（巢狀在 `field 9` 裡面，不是直接攤平在 `TrajectoryPayload` 底下）：

| 欄位 | 型別 | 內容 |
|---|---|---|
| `field 1` | string | workspace 路徑（`file:///...` URI，例如 `file:///c:/Users/sjack/OneDrive/Documents/ffmpeg功能化`）——**真正的路徑欄位在這裡，不是 `TrajectoryPayload.field 7`** |
| `field 3` | 巢狀訊息 `GitContext` | `field 1`＝repo 名稱（例如 `JuiMingWang/pdf-field-renamer`）、`field 2`＝remote URL；資料夾不是 git repo 時這個欄位是空的（長度 0），不是缺欄位 |
| `field 4` | string | git branch（例如 `main`）；只在資料夾是 git repo 時才有值 |

`GitContext`（`field 3`）解出的 repo 名稱／remote URL 本輪**不**進入 `SessionRecord` 或 UI——目前只有 `branch` 有對應的既有欄位／既有前端顯示邏輯可以沿用，repo 名稱／remote URL 沒有對應的既有欄位，硬塞會需要新的 UI 元素，超出這輪範圍；解碼出來但先不使用，留作未來如果要顯示 git 資訊時的候選欄位。

實測這台機器 8 筆真實 trajectory：8 筆都解出標題與 workspace 路徑（100%），2 筆有 GitContext，3 筆有 branch 值——**證實初版「Antigravity 沒有 git 分支概念，`branch` 寫死 `null`」這個假設是錯的**，branch 資訊在資料夾是 git repo 時確實拿得到。

### 一個原本設計的安全機制在真實資料上不成立，必須拿掉

初版規劃要求「對話 UUID 必須能在 `conversations/` 目錄下找到同名檔案，對不上就整筆丟棄」，理由是防止欄位位移後巧合解出的假 UUID。**這個假設已用真機資料證偽**：把 8 筆 trajectory 裡的三個 UUID（outer UUID、`TrajectoryPayload.field 4` 的第二組 UUID、更深層還有第三組 UUID）逐一拿去比對 `conversations/` 目錄下 10 個真實檔案的檔名——**沒有任何一筆、任何一個 UUID 對得上**。

追查可能原因：`conversations/` 目錄下 10 個檔案裡有 7 個的修改時間精確落在同一秒（微秒級差異），是典型的「批次搬移／還原」痕跡；對照社群論壇上多篇「Antigravity 未正常關機後對話紀錄遺失」「版本升級後 profile 遷移需要手動復原」的回報，這台機器的 `conversations/` 資料夾很可能經歷過一次資料復原/搬移事件，導致跟 `state.vscdb` 快取的索引不同步——這比較像是這台機器資料本身處於不一致狀態，不是官方資料模型本來就沒有這層對應。但既然**目前找不到任何一台機器可以驗證這個對應關係成立**，繼續把它當成硬性擋門的驗證條件，會讓 8 筆結構完整、內容正確的真實資料在這個檢查上全部被誤判為失敗、完全不顯示——這比「保留這 8 筆但少一層交叉驗證」的風險更糟。**決定：拿掉「UUID 必須對應到 `conversations/` 真實檔案」這個驗證條件**，其餘結構指紋比對（欄位形狀、巢狀關係、`complete` 旗標）維持不變。

### 這一輪的抓取範圍（比初版更寬：標題本次改為採用）

初版規劃「刻意不抓標題欄位」，原因是「標題是自由文字，沒有可驗證的形狀，欄位位移時抓錯也不會被任何驗證擋下」。**這個顧慮本身仍然成立**，但這次改變決定的理由是：既然已經改用「四個獨立形狀同時吻合才採信」的結構指紋比對（見下），標題欄位不再是唯一的信任依據，而是四個必須同時吻合的獨立特徵之一——只要其中任何一個位移，整筆記錄都會被判定失敗、標題也不會被採用。所以標題本次**改為抓取**，作為主要標題來源，直接顯示；若指紋比對失敗，一樣完全不採用（含標題）。

抓取的欄位與對應的結構指紋比對條件：

- **對話 UUID**（`TrajectorySummary.field 1`）：符合 UUID 正規表示式。
- **第二組 UUID**（`TrajectoryPayload.field 4`）：符合同一條 UUID 正規表示式，獨立檢查。
- **標題**（`TrajectoryPayload.field 1`）：`looksLikeUtf8Text(bytes)` 判斷（可印字元佔比需高於 85%，且能無損還原 UTF-8）＋長度落在 1～300 字元。
- **workspace URI**（`WorkspaceInfo.field 1`，即 `TrajectoryPayload.field 9` 的巢狀內容，**不是 `field 7`**）：驗證與轉換分兩步，缺一不可——(1) 整體符合 `^file:\/\/\/[a-zA-Z](:|%3[Aa])\//` 磁碟機代號開頭形狀；(2) 驗證通過後，**去掉 `file:///` 前綴**，對剩餘部分做 `decodeURIComponent`（解碼失敗視為驗證失敗），得到的結果（例如 `c:/Users/sjack/OneDrive/Documents/ffmpeg功能化`）才是可以直接餵給 `fs.existsSync`／既有 `normalizeGroupKey`／`displayNameForCwd` 的路徑字串——這三者本來就把正斜線／反斜線視為等價，Windows 上 `fs.existsSync` 也接受正斜線路徑，不需要額外轉換。**沒有做步驟 (2)、直接把原始 `file:///...` URI 拿去用，會讓 `fs.existsSync`／`normalizeGroupKey`／`Set-Location` 全部誤判成路徑不存在**——這是一個真實會發生的實作錯誤，不是理論風險；`SessionRecord.cwd` 與所有後續測試都必須是轉換後的結果，不能是原始 URI。

**單筆結構指紋比對（record-level structural fingerprint，主要防線）**：這四個欄位必須同時符合各自形狀，且巢狀關係必須正確（workspace URI 必須來自 `field 9` 巢狀展開後的 `field 1`，不能直接在 `TrajectoryPayload` 底下找形狀像 URI 的欄位），才採信這筆記錄的任何欄位；任一項不符，整筆記錄（UUID、標題、路徑全部）視為解析失敗、不採信、計入 `skipped`。這是 fail-closed 設計：格式一旦真的位移，通常會同時打亂樣板裡好幾個欄位，要求四個獨立特徵＋正確的巢狀關係同時吻合，比只驗證一兩個欄位的巧合機率低很多。

**trajectory 邊界的明確定義**：`trajectorySummaries` 頂層是 `repeated TrajectorySummary`，walker 逐一走訪每個頂層子區塊時，該子區塊「自己的」`field 2`（第二層 base64）展開後得到的 `TrajectoryPayload` 才是這筆 trajectory 的欄位來源，不能把所有子區塊攤平成一份全域 (field) → 值清單再配對——否則 A 對話的 UUID 可能被誤配到 B 對話的 workspace URI，而且這個錯誤不會被任何格式驗證擋下。測試計畫需包含「兩筆 trajectory 各自通過指紋比對，但 A 的 UUID 只會跟 A 自己的 URI 配對」的 fixture 測試。

**`complete` 完整度旗標**：walker 對每個頂層子區塊，除了收集欄位內容，還要回傳 `complete: boolean`——只有完整走訪到子區塊最後一個 byte、過程中從未因超界或未知 wire type 提早停止，才標記 `true`。單筆結構指紋比對把 `complete === true` 當第五個必要條件，跟四個欄位形狀一起要求同時成立。walker 本身面對垃圾／截斷輸入必須有界、不拋出未預期例外：遞迴深度有上限、讀取長度超出 buffer 剩餘長度就停止解析、遇到不支援的 wire type 就停止——最壞情況是「找不到任何合法 trajectory」，不會掛起或崩潰。

**整批一致性檢查（次要防線）**：同一次掃描中，通過單筆結構指紋比對的 trajectory 佔全部候選的比例，若低於 50%（這台機器 8/8 全數通過，門檻仍訂在明顯偏低的水準），判定整個來源不可信，回傳 `{ sessions: [], sourceError: true, skipped: <總筆數> }`，不產生任何 session、也不會落到雜項。

**base64 內容形狀前置檢查**：兩層 base64（外層 SQLite value、`TrajectorySummary.field 2`）都要先做 `^[A-Za-z0-9+/]*={0,2}$` 形狀檢查，不符合直接視為讀取失敗，理由同初版（`Buffer.from` 對非法字元不拋錯，必須自己擋）。

**誠實承認無法歸零的殘留風險**：即使指紋比對＋巢狀關係都吻合，理論上仍無法完全排除 Google 未來把欄位搬到另一組同樣自洽的新位置。這個風險有界且可逆（最壞情況是分類到錯誤專案節點，可用既有「隱藏」功能排除），值得記錄但不構成阻擋上線的理由。`trajectorySummaries` 整份 blob 尾端被截斷、導致最後一批 trajectory 默默消失，是 protobuf repeated 欄位本身沒有「清單到此結束」標記造成的結構性限制，效果等同於既有的「Antigravity 內部同步落後於 `conversations/` 真實檔案」——只會造成遺漏，不會顯示錯誤內容，符合本文件一貫的「寧可誠實跳過」原則。

本輪範圍仍然排除「訊息預覽」（首/末則訊息內容）——已知有兩個候選來源（`.system_generated/logs/transcript.jsonl` 覆蓋率 2/10、`task.md.metadata.json` 的 `summary` 覆蓋率 5/10），但都不是這次 `trajectorySummaries` 路徑的一部分，且使用者已在先前決策中選擇「這輪先不做訊息預覽，其他都做」——留作獨立的未來評估項目。

### SessionRecord 完整欄位映射（本次修正 title／branch／startedAt／lastActiveAt 的來源）

前端整個渲染邏輯（排序、時間範圍篩選、久未使用判定、時間區間分桶、接續快速區候選挑選）都依賴一組固定欄位形狀。比照 `scanClaudeCodeFile`／`scanCodexFile` 既有回傳形狀，逐一定義：

| 欄位 | 來源 | 說明 |
|---|---|---|
| `tool` | 固定字串 `'antigravity'` | 新增的第三種工具值 |
| `id` | 對話 UUID（`TrajectorySummary.field 1`） | 已定義的驗證規則見上；**不再要求對應到 `conversations/` 真實檔案**（見上一節修正） |
| `cwd` | `WorkspaceInfo.field 1` 解碼後的路徑 | 已定義的轉換規則見上 |
| `groupKey`／`displayName` | 套用既有 `normalizeGroupKey`／`displayNameForCwd`，輸入為上面的 `cwd` | 與 Claude/Codex 完全相同的既有函式，不需要新邏輯 |
| `startedAt` | `TrajectoryPayload.field 3`（created_at Timestamp）解出的時間 | **本次修正**：初版打算用對應實體檔案的 `birthtime`，但既然 UUID 常常對不上真實檔案（見上），這個備援本身不可靠；`created_at` 是 payload 自帶的欄位，不依賴檔案是否存在，已驗證可正確解出 |
| `lastActiveAt` | `TrajectoryPayload.field 7`（updated_at Timestamp）解出的時間 | 同上，改用 payload 自帶欄位，不依賴對應檔案 |
| `branch` | `WorkspaceInfo.field 4`，不存在則 `null` | **本次修正**：初版假設「Antigravity 沒有分支概念」是錯的，實測 3/8 筆有值；沿用既有前端對 `s.branch` 的 falsy 檢查，`null` 時不需要新邏輯 |
| `title`／`titleIsFallback` | 通過結構指紋比對時，直接用 `TrajectoryPayload.field 1`，`titleIsFallback` 固定為 `false` | **本次修正並修正一個矛盾**：初版排除這個來源，本次改為主要來源；但初版曾一併規劃「指紋比對沒過就退回 `task.md.metadata.json` 的 `summary`」，這跟「指紋比對任一項不符，整筆記錄含標題視為解析失敗、不採信」互相矛盾——指紋比對沒過代表這筆 trajectory 根本不會產生 SessionRecord，不會走到「有 session 但標題退回」這個狀態，`task.md.metadata.json` 退路因此拿掉。**這代表 Antigravity 這個來源沒有「退而標題」這一級**：指紋比對失敗＝整筆連同標題一起消失（計入 `skipped`），跟 Claude/Codex「標題退回但 session 仍存在」是不同的行為，需要在文件與 UI 說明裡交代清楚，不能誤用同一個詞彙 |
| `pathExists` | 對解碼後的 `cwd` 呼叫既有 `fs.existsSync` | 沿用既有失效路徑機制，不需要新邏輯 |
| `firstMessagePreview`／`lastMessagePreview` | 固定 `null` | 本輪仍排除訊息預覽（見上），既有前端本來就對 `null` 顯示「（無）」占位文字 |

**時間戳記有效性也是採信條件之一（先前版本遺漏，這次補上）**：`startedAt`／`lastActiveAt` 解析出的 `TrajectoryPayload.field 3`／`field 7` 若不是有效的 `Timestamp`（巢狀的 `seconds`／`nanos` 欄位缺失、型別不對、或轉出的日期是 `Invalid Date`），不能讓這筆記錄帶著無效時間繼續產生 session——前端排序、時間範圍篩選、久未使用判定全部依賴這兩個欄位是合法的 ISO 時間字串，無效時間會讓這些邏輯靜默出錯（`Invalid Date` 參與排序比較、或永遠/永不落入某個時間分桶），而不是拋出看得到的錯誤。因此**時間戳記能否解出有效日期，是跟 UUID／標題／URI 同等級的採信條件**：任一時間戳記解析失敗，整筆記錄視同結構指紋比對失敗，計入 `skipped`，不產生 session。測試計畫需新增一則「`created_at`／`updated_at` 的巢狀 `seconds`／`nanos` 欄位缺失或型別錯誤」的 fixture，驗證這種情況下記錄被判定失敗，而不是帶著 `Invalid Date` 產生 session。

### Antigravity 與既有 UI／續接契約的整合缺口（先前規劃遺漏，本次補上）

先前版本的規劃只談到「`scanAntigravity()` 回傳的 session 併入既有 `sessions` 陣列」，但實際檢查現有前端程式碼後發現：**現有 UI 與續接指令是寫死只認兩種工具**，Antigravity session 混進去會直接壞掉，不是自動相容。具體要處理：

- **`buildResumeCommand(tool, cwd, sessionId)`**（後端 `session-dashboard.js:43`）與前端 `<script>` 裡的同邏輯複製品（`tool === 'codex' ? 'codex resume' : 'claude --resume'`）：目前只有二分支，任何非 `codex` 的 tool 值都會被誤判成走 `claude --resume`。**這裡先前的措辭容易誤導**——不是「在 `buildResumeCommand` 裡新增 Antigravity 分支」：這個函式的簽章 `(tool, cwd, sessionId)` 完全沒有 exe 路徑的位置，而 Antigravity 的指令組成方式（`& '<exe>' '<folder>'`，見下方 PowerShell escaping 小節）跟 `buildResumeCommand` 產出的 `Set-Location ...; claude --resume <id>` 形狀也完全不同，硬塞進同一個函式只會讓兩種不相干的命令格式混在一起、難以測試。正確做法是**前端與後端都改成三分支判斷**（`s.tool === 'antigravity'` 時完全不呼叫 `buildResumeCommand`，改呼叫一個新的、簽章不同的函式，例如 `buildOpenFolderCommand(exePath, cwd)`），`buildResumeCommand` 本身維持原本二分支不變，只需確保呼叫端（`createCopyButton`／`createHideButton` 之外的接續按鈕邏輯）根據 `tool` 分流到正確的函式，而不是讓 `buildResumeCommand` 自己長出第三個分支。
- **續接方式本身需要重新定義**：這台機器上只找到 Antigravity 的 GUI 執行檔（`Antigravity IDE.exe`，實測路徑為 `%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe`），沒有查到任何能像 `claude --resume <id>`／`codex resume <id>` 那樣「直接跳轉到指定對話」的命令列參數——這是**未驗證假設**：Antigravity 可能根本沒有這種 CLI 能力。因此這次的設計決定是：Antigravity 卡片的「續接」改成「複製開啟該 workspace 資料夾」的指令，並在按鈕文字／說明上明確告知使用者「這會開啟專案資料夾，需要自行在 IDE 內找到該對話」，不能沿用「直接接續到那一句對話」的既有語意，避免使用者誤以為跟 Claude/Codex 的續接是一樣的體驗。這個指令的完整契約（先前版本只給了一個沒有定義來源的範例，這裡補上）：
  - **執行檔路徑的來源**：前端是純靜態 HTML，瀏覽器端沒有檔案系統存取能力，不可能在點擊當下才去找 exe 在哪——執行檔路徑必須在 **Node 端掃描時**（`scanAntigravity()` 內）用 `fs.existsSync` 探測 `%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe` 這個已知安裝位置，探測到才把路徑寫進該筆 session 的資料（例如 `s.antigravityExePath`）隨 HTML 一併嵌入；探測不到則該筆 session 完全不產生「續接」按鈕，只顯示 workspace 資料夾路徑的純文字供使用者自行處理——這是「誠實跳過」原則在這個子功能上的具體應用，而不是硬產生一個很可能執行不了的指令。

    **這個規則必須實際接到現有渲染程式碼，不能只是文字描述（先前版本遺漏，這次補上）**：現有 `renderCard(s, container, options)` 與 `renderQuickResume()` 兩處都是**無條件**呼叫 `card.appendChild(createCopyButton(s))`——對 Claude/Codex 這是對的（一定產得出續接指令），但 Antigravity 的續接按鈕依賴 `s.antigravityExePath` 是否存在。兩個渲染路徑都必須改成：`s.tool === 'antigravity' && !s.antigravityExePath` 時跳過建立續接按鈕（改渲染純文字路徑），其餘情況維持原本無條件呼叫——否則就算 `scanAntigravity()` 正確地不寫入 `antigravityExePath`，前端仍會呼叫 `buildResumeCmd(s)` 對一個 `undefined` 的 exe 路徑組出一句執行不了、甚至可能落回 `claude --resume` 語意的指令。測試計畫需在 `renderCard`／`renderQuickResume` 兩個路徑各自涵蓋「有 `antigravityExePath`」與「沒有」兩種情境，斷言後者不產生可點擊的續接按鈕。
  - **PowerShell escaping**：既有 `buildResumeCommand` 已經用單引號＋`escapePowerShellSingleQuoted`（把 `'` 加倍）來組 `Set-Location -LiteralPath '<safeCwd>'`，理由寫在前端程式碼註解裡——雙引號字串在 PowerShell 裡會做變數／反引號展開，資料夾名稱若含 `$` 或反引號就會讓指令跑掉。Antigravity 的開啟資料夾指令必須沿用同一套單引號跳脫方式，對執行檔路徑與 workspace 路徑兩個字串都套用 `escapePowerShellSingleQuoted`，例如 `& '<跳脫後的 exe 路徑>' '<跳脫後的資料夾路徑>'`，不能像先前草稿那樣用雙引號。
- **前端篩選器與徽章**：`tool` 篩選下拉選單目前只有 `all`／`claude-code`／`codex` 幾個選項，需要新增 `antigravity`；工具徽章的樣式表也需要新增第三種顏色/文字。

### `main()` 的測試注入契約（先前版本遺漏，這次補上）

現有 `main(argv, options)` 已經有 `options.claudeHomeDir`／`options.codexHomeDir` 兩個注入點（預設分別是 `path.join(homeDir, '.claude')`／`path.join(homeDir, '.codex')`），既有測試（包含 `main --hide`／`main --unhide` 那類整合測試）都是靠這兩個注入點指向暫存目錄，才能在不碰真實使用者資料的前提下測試 `main()` 的完整行為。Antigravity 有兩個實體資料來源目錄（`~/.gemini/antigravity` 與使用者的 Antigravity IDE userData 資料夾），必須比照既有慣例各自開一個對應的注入點，而不是讓測試被迫使用真實的 `os.homedir()`：

- `options.antigravityGeminiDir`，預設 `path.join(homeDir, '.gemini', 'antigravity')`。
- `options.antigravityUserDataDir`，預設 `path.join(homeDir, 'AppData', 'Roaming', 'Antigravity IDE')`（沿用既有程式碼「相對於 `homeDir` 組路徑」的風格，不新增 `process.env.APPDATA` 這種既有程式碼未使用過的環境變數依賴）。

`scanAntigravity(antigravityGeminiDir, antigravityUserDataDir, realHomeDir)` 的簽章對應這兩個注入點＋既有 adapter 共用的 `realHomeDir` 慣例（比照 `scanClaudeCode`/`scanCodex` 已有的 `realHomeDir` 參數）。有了這兩個注入點，測試計畫中「main 層級整合測試（`state.vscdb` 損毀情境）」才能真的用暫存目錄構造假環境並呼叫真實 `main()`，不會意外讀到使用者本機真正的 Antigravity 資料。

### 失敗安全網設計

分五層，任何一層失敗都只影響「這一筆」或「Antigravity 這整個來源」，不會擴散：

1. **單筆對話層級 try/catch**：每筆 trajectory 的解析獨立包裹，失敗只讓這一筆退回「跳過並計入 skipped 計數」，比照現有 `scanned/skipped` 統計模式，不中斷其餘筆數的處理。
2. **欄位層級的格式驗證閘門，與「單筆結構指紋比對」的關係（修正先前版本的自相矛盾）**：先前版本這裡寫「路徑沒抓到 → 歸類雜項」，聽起來像是這筆 trajectory 還會被保留、只是沒有 cwd；但這跟上一節「單筆結構指紋比對」明確要求的「四個欄位只要有一個對不上，整筆記錄視為解析失敗、不採信、不使用」互相矛盾——同一種輸入（URI 驗證失敗）不能同時對應「保留為雜項」跟「整筆丟棄」兩種結果。**以結構指紋比對的規則為準，修正這裡的敘述**：UUID／路徑／第二個 UUID／標題形狀四個欄位任一個沒通過格式驗證，代表整筆 trajectory 沒通過結構指紋比對，直接視為解析失敗、計入 `skipped`，不使用這筆記錄裡任何欄位（不會有「路徑沒過但保留其他欄位退到雜項」這種部分採信的情況）——因為結構指紋比對存在的前提，就是任一欄位對不上時，連原本看似正常的其他欄位也不再可信。「歸類雜項」只適用於 Claude Code／Codex 既有的、cwd 本身就是家目錄的情況（見 CONTEXT.md「雜項」定義），跟 Antigravity 這裡「驗證失敗」是兩件不同的事，不應該混用同一個詞彙。
3. **環境相依性的顯式檢查，且明確規定檢查順序（先前版本遺漏順序，這次補上）**：`node:sqlite` 是較新版 Node.js 才有的內建模組（這個 repo 目前沒有在任何地方宣告最低 Node 版本要求），且需要用 `{ readOnly: true }` 開啟 `state.vscdb`／`*.db`（這些檔案可能正被執行中的 Antigravity IDE 佔用，唯讀開啟避免鎖定或意外寫入）。**順序很重要**：判斷「沒裝」與「裝了但還沒有 `state.vscdb` 檔案」這兩種情況，只需要 `fs.existsSync`（純檔案系統檢查），完全不需要用到 `node:sqlite`——必須先做完這兩層純檔案系統檢查，確認 `state.vscdb` 這個檔案本身真的存在之後，才需要 `require('node:sqlite')` 去開啟它查詢；如果順序反過來（一開始就不分青紅皂白先 `require('node:sqlite')`），會導致「這台機器根本沒有 Antigravity 或還沒建立這個檔案」跟「`node:sqlite` 模組本身不可用」這兩種情況被錯誤地混在一起判斷，而後者才是真正該算 `sourceError: true` 的組合情境（`state.vscdb` 檔案確實存在，但因為 `node:sqlite` 不可用而讀不到裡面的內容——檔案存在代表資料很可能就在裡面，只是這台機器現在讀不到，跟「還沒有資料」語意不同）。`require('node:sqlite')` 本身必須包在 try/catch 裡（不能是模組頂層直接 `require`，否則版本不支援時會在載入 adapter 檔案當下就拋錯，跳過所有後續 try/catch）。開啟的 `DatabaseSync` 連線必須在 `try/finally` 裡 `close()`，不能只在成功路徑上關閉——查詢失敗、`value` 型別不對等任何一步拋例外時都要確保連線被釋放，否則重複執行 `main()`（例如 `SessionStart` hook 每次新開對話都會跑）會逐次留下未關閉的檔案控制代碼。測試計畫需新增一則「`state.vscdb` 檔案確實存在，但模擬 `require('node:sqlite')` 拋錯」的情境，斷言結果是 `sourceError: true`（不是 `false`），驗證這個判斷順序真的有被實作出來，而不是被誤判成「還沒有資料」。

   **這個功能隱含一個先前沒有明確宣告的 Node 版本門檻（先前版本遺漏，這次補上）**：`node:sqlite` 在 Node 22.5 才以實驗性旗標形式引入，要到 Node 24 才不需要 `--experimental-sqlite` 即可直接使用——本文件所有真機驗證都在 Node v24.18.0 上進行。這代表低於 Node 24 的環境，`require('node:sqlite')` 一定會拋錯，正確地觸發 `sourceError: true`，但這種情況的根因是「執行環境版本太舊」，不是「Antigravity 資料讀取失敗」，兩者目前共用同一個 `sourceError: true` 訊號，前端警告文字無法區分。既有 Claude Code／Codex 兩個 adapter 完全沒有這種執行環境版本依賴，這是 Antigravity adapter 新引入、先前版本沒有明確聲明的限制——部署說明（`docs/deploy-log.md`）與使用者可見的說明文字裡需要明確寫出「Antigravity 功能需要 Node 24 以上」，避免使用者在舊版 Node 上看到 `sourceError: true` 時誤以為自己的 Antigravity 資料損毀。

   **與既有 `docs/plans/2026-08-02-session-dashboard-plan.md:13`「Node.js >= 18 required」的關係（需要明確調和，不是互相矛盾）**：既有那份計畫講的是整個工具的最低門檻，當時只用到 `node:fs`／`node:path`／`node:os`／`node:crypto`／`node:child_process`／`node:test`，這些在 Node 18 都能用，那個門檻本身沒有錯、不需要調高——Claude Code／Codex 掃描在 Node 18～23 上完全正常運作。Antigravity adapter 是在既有門檻之上疊加的**額外、僅限這個來源**的需求：Node 18～23 上 Antigravity 會誠實回報 `sourceError: true`（優雅降級，不影響 Claude/Codex 資料），只有 Node 24 以上才能真正讀到 Antigravity 資料。這不是把全專案門檻改成 24，而是「整個工具最低需要 18，但 Antigravity 這個來源額外需要 24」——兩份文件都要用這個說法互相參照，而不是各自宣告一個看起來衝突的絕對版本號。
4. **Antigravity adapter 整體 try/catch，且區分「沒裝」「裝了但還沒有資料」「裝了但讀取失敗」三種情況，並明確定義從 adapter 到畫面的完整串接路徑**：`scanAntigravity()` 最外層包一層 try/catch，明確定義三種結果（先前版本只談了頭尾兩種，中間這種「合法的空狀態」先前版本沒有明確定義，這次補上）：

   - **沒裝**：`~/.gemini/antigravity` 與 Antigravity IDE userData 兩個目錄都不存在 → `{ sessions: [], skipped: 0, sourceError: false }`（誠實代表「這台機器沒有安裝 Antigravity」）。
   - **裝了但還沒有 trajectory 資料（合法的空狀態，不是錯誤）**：上述目錄存在，但 (a) `state.vscdb` 檔案本身不存在，或 (b) `state.vscdb` 存在且能正常開啟查詢，但 `SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries'` 查不到任何一列 → 這兩種情況都代表「使用者裝了 Antigravity、但目前為止沒有任何對話被同步寫進這個 key」（剛安裝、或裝了但從未真正開始一次對話），是完全合法、預期得到的空狀態，**不是錯誤**，回傳 `{ sessions: [], skipped: 0, sourceError: false }`，跟「沒裝」給同一種誠實但空的結果，不應該讓使用者看到警告訊息。
   - **裝了、有資料，但讀取過程中真的失敗**：`state.vscdb` 存在、`ItemTable` 裡也查得到 `trajectorySummaries` 這一列，但後續任何一步失敗——`value` 不是預期的文字型別、`node:sqlite` 模組不可用（見上一點的順序規則）、資料庫檔案損毀或被鎖定導致開啟/查詢本身就拋例外、或是 protobuf bytes 完全無法用 walker 解析出任何一筆通過結構指紋比對的合法 trajectory（見下方整批一致性檢查，0% 通過率是這裡的極端情況）——這代表「資料很可能存在，但讀不出來」，跟前一種「還沒有資料」在语意上完全不同，**不能回傳跟前兩種一樣的結果**，回傳 `{ sessions: [], sourceError: true }`，`skipped` 的值**與下方「整批一致性檢查」的契約一致**：等於這次掃描到的候選 trajectory 總筆數（不是 `0`——`0` 會讓使用者以為「什麼都沒掃到」，但實際上是掃到了、只是全部驗證失敗，兩者對使用者的意義不同，`skipped` 要誠實反映後者）。這裡先前版本寫成 `skipped: 0` 是本文件內部不一致的地方，已修正為跟整批一致性檢查同一套契約，避免實作者兩邊各實作一種行為。

     **「base64 decode 失敗」不是獨立的偵測手段（先前版本的錯誤假設，這次修正）**：先前版本把「base64 decode 失敗」當成一個會拋例外、可以直接 try/catch 抓到的獨立失敗情境，但這是錯的——**已用真實 Node 環境驗證過，`Buffer.from(str, 'base64')` 對非法字元或截斷輸入完全不會拋錯**（例如 `Buffer.from('not@@base64', 'base64')` 不拋例外，只會安靜跳過不合法字元、回傳它能拼湊出的任意 bytes；`Buffer.from('%%', 'base64')` 回傳長度 0 的空 buffer；沒有一種輸入會讓這行程式碼拋出例外）。所以「value 損毀」不能靠 base64 decode 這一步的 try/catch 偵測，真正能偵測到問題的地方，是 decode 出來的（可能是垃圾的）bytes 餵進 walker 之後，**找不到任何一筆通過單筆結構指紋比對的 trajectory**——這正好就是下方「整批一致性檢查」在通過率 0% 時的極端情況，不需要另外設計一個獨立的「base64 失敗」分支，這兩者本來就是同一個機制的自然延伸。

     **protobuf walker 本身面對垃圾／截斷輸入必須是有界、不拋出未預期例外的（先前版本沒有明確要求，這次補上）**：由於 value 損毀時 decode 不會報錯、餵進 walker 的可能是完全隨機的 bytes，walker 的實作必須自己對這種輸入保持穩固，而不是假設輸入永遠是合法的 protobuf：(a) 遞迴深度需要有上限（沿用先前調查用的 scratch 腳本已驗證過的做法，深度超過一個固定上限就停止遞迴，不使用真實資料才會出現的深度）；(b) 讀取 varint／length-delimited 長度時，一旦超出 buffer 剩餘長度就直接停止解析這個子區塊，不能無界讀取或造成無窮迴圈；(c) 遇到未知或不支援的 wire type 就停止解析目前這個子區塊。這三條規則的目的是確保 walker 面對任意亂數 bytes 時，最壞情況只會是「找不到任何合法 trajectory」（進而觸發上述的 `sourceError: true` 路徑），而不會讓單一垃圾輸入造成掛起或程式崩潰——測試計畫需新增以純隨機 bytes（非真實 protobuf）餵給 walker 的 fuzz 測試，驗證函式呼叫必定在有限時間內回傳、不拋出未被上層 try/catch 涵蓋的例外。

     **「提早停止時回傳已收集欄位」本身還不夠 fail-closed，需要額外傳遞完整度旗標（codex 第 11 輪指出，這次修正）**：上面 (b)(c) 兩條規則只解決「不會掛起／不會拋例外」，但沒解決一個更細的正確性問題——如果某個子區塊在成功收集到全部四個 fingerprint 欄位『之後』才因為超出邊界或遇到未知 wire type而提早停止，這筆記錄目前的規則會讓它照樣通過四欄指紋比對（畢竟四個欄位都在，只是这筆資料實際上是被截斷、不完整的），這不是真正的 fail-closed。修正：walker 對每個頂層子區塊（每筆 trajectory）除了收集欄位內容之外，還要額外回傳一個 `complete: boolean` 旗標——只有子區塊被完整走訪到最後一個 byte、且過程中從未觸發 (b)(c) 的提早停止規則，才標記 `complete: true`；只要曾經觸發過任何一次提早停止（即使停止點在四個欄位都已經收集到之後），就標記 `complete: false`。單筆結構指紋比對必須把 `complete === true` 當成第五個必要條件，跟四個欄位形狀檢查一起要求同時成立——`complete: false` 的子區塊無論欄位形狀看起來多正常，一律視為解析失敗，不採信任何欄位。測試計畫需新增一則「四個欄位都在正常位置、但子區塊本身被人為截斷在最後一個欄位之後」的 fixture，驗證這種情況下 `complete` 為 `false`、整筆記錄仍被判定失敗，不會因為欄位剛好都讀到就被誤判為通過。

     **base64 内容形狀的最低限度前置檢查，以及為何不做到「canonical round-trip」等級（codex 對此持保留意見，這裡明確記錄判斷與理由）**：已用真實 Node 環境驗證過，在合法 base64 字串前後插入非法字元（例如 `!!!` 或 `###`）之後 `Buffer.from(..., 'base64')` 會直接忽略這些非法字元、解碼出跟乾淨字串完全相同的 bytes——代表單靠「decode 有沒有拋錯」或「decode 出來的 bytes 長度看起來合理」都無法分辨「這段文字混入了不該有的雜訊字元」。因此在 decode 之前，加一道最低限度的形狀檢查：整個 `value` 字串必須符合 `^[A-Za-z0-9+/]*={0,2}$`（只含合法 base64 字元集，等號只能出現在結尾且最多兩個），不符合就直接視為第 4 節「裝了、有資料，但讀取過程中真的失敗」的其中一種情況（`sourceError: true` 路徑）。**這裡刻意不做到 codex 建議的「canonical round-trip」（decode 後重新編碼回去比對是否完全一致）等級的驗證**：這個工具的風險模型是「Google 未來改變私有格式」與「檔案損毀／截斷」，不是「有敵意的第三方故意在字串中插入偽裝字元」——真實世界的磁碟損毀／截斷通常是位元反轉（字元被替換掉，會直接讓形狀檢查或後續 walker 解析失敗）或整段內容被截短（會被上面的 `complete` 旗標抓到），而不是「在維持所有原始字元、原始順序不變的前提下，額外插入完全不影響 decode 結果的雜訊字元」這種特定模式——這種模式需要刻意建構才會出現，不是這個系統實際會遇到的損毀樣態，加上最低限度的字元集檢查已經能擋掉「內容明顯不是 base64」的情況，這裡判斷不需要為了防禦一個不太可能自然發生的情境，再疊加一層更昂貴的 canonical round-trip 檢查——若使用者或未來維護者認為這個判斷過於樂觀，可以再加強，但這是一個經過權衡、有記錄理由的決定，不是遺漏。

   區分「還沒有資料」與「讀取失敗」的判斷依據，是**有沒有讀到能明確代表『目前不存在』的具體訊號**（檔案不存在、查詢回傳零列，這兩者都是資料庫／檔案系統明確、無歧義地告知「沒有」）；只要流程進行到需要「解讀已經拿到手的內容」（value 型別、base64、protobuf bytes）卻失敗，就代表可能有資料只是解不出來，必須算作 `sourceError: true`，不能因為「反正結果都是空 session 列表」就把這兩種語意混為一談。

   這個旗標不能停在 adapter 回傳值就結束，必須明確定義完整往下傳遞的路徑（先前版本只寫到「讓 main() 能夠顯示」為止，沒有具體規定怎麼接，這次補上）：`main()` 讀出 `antigravityResult.sourceError` 後，加進既有傳給 `buildHtml(sessions, meta)` 的 `meta` 物件裡（比照現有 `meta.skippedCount` 的做法，新增 `meta.antigravitySourceError: boolean`）；`buildHtml` 內嵌的 `dataJson`／`DATA` 物件比照 `DATA.skippedCount` 的既有模式一併帶上這個欄位。

**`skippedCount` 也必須把 Antigravity 算進去（先前版本遺漏）**：現有 `main()` 是 `const skippedCount = claudeResult.skipped + codexResult.skipped;`，只加了兩個來源。Antigravity adapter 一樣會回傳 `skipped`（第 1 層單筆 try/catch、以及結構指紋比對沒通過的筆數都計入），這個數字必須一併加進總數——`const skippedCount = claudeResult.skipped + codexResult.skipped + antigravityResult.skipped;`——否則 Antigravity 這邊被跳過的記錄不會反映在既有「已跳過 N 個異常檔案」的提示文字裡，等於這部分的「誠實跳過」訊息被漏報，違反核心原則。

**`skippedDetails` 也要一併補上，且必須是具體、可實作的契約（先前版本留白，這次補上明確定義）**：本文件寫成之後、實作前，`skippedCount` 已經在 Claude/Codex 兩個既有 adapter 上進一步擴充為 `skippedDetails`——每筆跳過的記錄額外帶 `{tool, filePath, reason, rawPreview, sizeBytes, mtime}`。既有前端 renderer（`createSkippedEntry`）**無條件**讀取 `detail.filePath`／`detail.reason` 並直接串進 `textContent`——這兩個欄位若是 `undefined`，畫面會顯示成字面上的 `[antigravity] undefined`，是一個真實會發生的顯示 bug，不是理論風險。

Antigravity 沒有「一筆 trajectory 對應一個檔案」這種關係（`state.vscdb` 是所有 trajectory 共用的單一檔案），所以不能直接沿用 Claude/Codex 那套「`filePath` 是這筆 session 自己的檔案」的語意，也不套用既有的 `buildSkippedDetail(tool, filePath, err)` 共用函式（那個函式會對 `filePath` 做 `fs.statSync`／讀取檔頭 bytes 當預覽，對 Antigravity 的「filePath」沒有意義，硬套用只會讀到 `state.vscdb` 自己的大小/內容，而不是任何一筆 trajectory 的資訊）。Antigravity adapter 要自己組出 `skippedDetails` 物件，不透過那個共用函式，欄位定義如下：

- `tool`：固定 `'antigravity'`。
- `reason`：具體失敗原因（例如「base64 形狀不符」「結構指紋比對失敗：workspace URI 格式不符」「timestamp 無效」），不可為 `undefined`。
- `filePath`：**這裡刻意不是真實檔案路徑，而是一段人類可讀的識別字串**——已知 `TrajectorySummary.field 1`（outer UUID）本身在進入雙層 base64／指紋比對之前就能獨立解析，即使後續 `TrajectoryPayload` 驗證失敗，這個 UUID 通常還在，所以格式為 `` `${stateVscdbPath}（trajectory ${outerUuid}）` ``；連 outer UUID 都解析失敗的極端情況（例如最外層 protobuf 本身就損毀），格式退為 `` `${stateVscdbPath}（trajectory UUID 也解析失敗）` ``——兩種情況 `filePath` 都是一個非 `undefined` 的字串，且盡量帶有可以跟其他失敗記錄區分的資訊。
- `rawPreview`／`sizeBytes`／`mtime`：固定 `null`（既有前端已經對 `mtime` 做 falsy 檢查跳過整個區塊、對 `rawPreview` 有 `|| '（無法讀取）'` 的預設值，`null` 不會產生顯示 bug）。

測試計畫需新增一則「Antigravity 跳過清單顯示」的 DOM 測試，用上述形狀的 fixture 驗證畫面不會出現字面上的 `undefined`。

**前端渲染時兩則警告訊息共存的處理（先前版本遺漏，這次補上）**：既有 `#skipped-warning` 是單一 DOM 元素，既有邏輯是 `if (DATA.skippedCount > 0) { document.getElementById('skipped-warning').textContent = '已跳過 ' + ... }` 這種直接覆寫 `textContent` 的寫法。若照原計畫單純加一個對稱的 `if (DATA.antigravitySourceError) { ... textContent = ... }`，當兩個條件同時成立時，後執行的 `if` 會直接覆寫掉前一個訊息，使用者只會看到其中一則警告——這是先前版本沒考慮到的真實 bug。修正做法：改成先收集適用的訊息到一個陣列，兩個 `if` 都只做 `warnings.push(...)`，最後統一 `if (warnings.length > 0) { document.getElementById('skipped-warning').textContent = warnings.join('；'); }`——共用同一個既有 DOM 元素，不需要新增元素或改版面，兩則訊息用「；」串接同時顯示。測試計畫需新增一則「`skippedCount > 0` 與 `antigravitySourceError` 同時為真時，兩則警告文字都出現在渲染結果中」的 DOM 測試，覆蓋這個先前遺漏的共存情境。

這條路徑（adapter 回傳值 → `main()` 組進 `meta` → `buildHtml` 序列化進 `DATA` → 前端讀 `DATA` 並渲染警告文字）每一段銜接都要各自被測試覆蓋，不能只測 adapter 自己回傳的欄位對不對（見下方測試計畫的對應項目），否則 adapter 測試全綠，畫面上卻沒有真的顯示警告這種「串接漏接」的落差不會被任何測試抓到。
5. **結構性隔離（模組化的直接效益）**：`main()` 本來就是「各自獨立呼叫 `scanClaudeCode`／`scanCodex`／`scanAntigravity`，各自回傳結果後才合併」，任何一個來源的 try/catch 兜底之後，其餘來源的資料與既有測試斷言完全不受影響 —— 這件事在模組化完成、Antigravity 有自己的檔案之後，會是程式結構本身保證的，不需要額外加測試去證明「改 Antigravity 沒有動到 Claude/Codex 的程式碼」。

核心原則（使用者訪談中確認）：**寧可誠實跳過，不要悄悄顯示錯的**。任何一筆資料只要無法通過驗證，寧可讓這筆 session 退回到比較不精確但誠實的狀態，也不會顯示未經驗證、可能已經對應錯欄位的內容；「整個來源讀取失敗」也必須誠實地顯示出來，不能跟「本來就沒有這個來源」長得一樣。**「比較不精確但誠實的狀態」在不同來源代表不同的具體行為，不是同一種結果**：Claude/Codex 既有的「雜項」分類，適用的是「cwd 本身就是家目錄」這種本來就合法、只是沒有專屬專案資料夾的情況（見 CONTEXT.md「雜項」定義），標題退回「退而標題」也是同樣邏輯——都是「資料本身沒問題，只是缺少某個資訊」；但 Antigravity 的單筆結構指紋比對失敗／整批一致性檢查判定不可信，代表的是「解析結果可能整個是錯的、不可信」，對應的誠實行為是**整筆或整批直接不採信、計入 `skipped`，不產生任何 session、也不會落到雜項**——不能把這兩種情況都說成「歸類雜項」，兩者的資料可信度前提完全不同。

### 測試計畫

既有 141 筆測試只覆蓋 Claude/Codex 兩個來源，即使 protobuf 解析或 URI 轉換整段邏輯完全錯誤，這 141 筆也會全數照常通過——不能拿「既有測試沒壞」當作 Antigravity 功能正確的證據。新增功能至少需要以下幾類測試（沿用既有測試檔的風格：真實輸入的純函式單元測試＋`runDashboardScript` 的前端 DOM 執行測試）：

- **protobuf walker 的純函式測試**：用手動建構的、已知內容的 byte buffer（不依賴真實 `state.vscdb`，避免測試綁定使用者本機資料）驗證能正確解出巢狀欄位；並用「刻意打亂欄位編號」的 fixture 驗證解析失敗時回傳「解析失敗」而不是拋錯或吐出垃圾值。另需涵蓋 `complete` 旗標：正常走訪到子區塊結尾 → `complete: true`；四個欄位都已收集到、但子區塊本身被人為截斷在其後 → `complete: false` 且該筆記錄整體判定失敗。
- **base64 形狀前置檢查**：涵蓋合法 base64（含結尾 `=`／`==` padding）、內容混入非法字元（例如插在合法字串前後）、完全不是 base64 的隨機文字三種情況，驗證只有第一種通過前置檢查、後兩種都在 decode 之前就被判定為「讀取失敗」而不是被 `Buffer.from` 靜默吞掉非法字元後意外解出可用資料。
- **URI 轉換與驗證**：涵蓋 `file:///c:/...`、`file:///c%3A/...`、包含中文/符號的路徑、格式不符（不是 `file://` 開頭、drive letter 前綴缺失）、`decodeURIComponent` 會拋錯的截斷編碼字串等案例。
- **雙層 base64 解碼**：涵蓋外層 `TrajectorySummary.field 2` 正確解出第二層 base64 字串、第二層再解出正確 `TrajectoryPayload` bytes 的完整路徑；以及任一層 base64 形狀檢查失敗時的行為（見上方「base64 形狀前置檢查」）。**不再測試「UUID 是否對應到 `conversations/` 真實檔案」**——這項檢查已確認在真機資料上不成立而拿掉（見規劃內文），保留會讓測試對著一個已知不可靠的假設斷言。
- **單筆結構指紋比對**：至少三種 fixture——(a) 四個欄位（UUID、標題、第二個 UUID、URI）全部符合預期形狀 → 整筆採信；(b) 只有 URI 欄位單獨對不上、其餘三個仍正常 → 整筆判定失敗（不能只丟棄 URI、卻仍採信同一筆的其他欄位，因為結構指紋比對的前提就是「同一筆記錄的欄位若有一個對不上，代表整體樣板可能已經改變，不該再信任這筆的任何欄位」）；(c) 四個欄位全部對不上 → 整筆判定失敗。
- **整批一致性檢查**：構造一批「多數記錄通過單筆結構指紋比對」與一批「多數記錄未通過」的合成資料，驗證只有後者會回傳 `sourceError: true`、`sessions: []`、`skipped` 等於掃描到的總筆數（不產生任何 session，也不會有任何一筆落到雜項），前者則逐筆正常採信、正常產生對應的 session。
- **`scanAntigravity` 整合測試**：比照 `scanClaudeCode`／`scanCodex` 既有測試的做法，用暫存目錄構造假的 `.gemini/antigravity`／`Antigravity IDE` 結構，至少涵蓋五種情境並各自斷言對應的 `sessions`／`skipped`／`sourceError`：(a) 兩個根目錄都不存在 → 沒裝，`sourceError: false`；(b) 目錄存在但 `state.vscdb` 不存在 → 還沒有資料，`sourceError: false`；(c) `state.vscdb` 存在、可正常查詢，但查不到 `trajectorySummaries` 這一列 → 還沒有資料，`sourceError: false`；(d) `state.vscdb` 存在、查得到該列，但 `value` 內容損毀（例如不是合法 base64，或 decode 後的 bytes 无法被 walker 解析出任何合法 trajectory）→ 讀取失敗，`sourceError: true`；(e) 正常案例（真實可解析的資料）→ 正常產生 session。(b)(c) 兩種必須明確斷言 `sourceError` 為 `false`（不是 `true`），驗證「還沒有資料」不會被誤判成「讀取失敗」而顯示不必要的警告給剛安裝、還沒開始使用 Antigravity 的使用者。
- **`node:sqlite` 不可用時的降級**：模擬 `require('node:sqlite')` 拋錯的情境（例如透過依賴注入或 module mock），驗證 adapter 走「來源讀取失敗」的路徑而非讓整支程式當掉。
- **端到端驗證不能只靠手工 fixture／mock**：手工建構的 protobuf bytes 與 mock 過的 SQLite 呼叫，就算全部通過測試，仍不能證明 production 那條「`node:sqlite` 開 `state.vscdb` → `SELECT value FROM ItemTable WHERE key = ...` → `value` 先 `toString('utf8')` 再 base64 decode → walker 解析」的真實路徑本身是接對的（例如：SQL 拿到的 row 是 `undefined`、`value` 型別不是預期的文字、base64 decode 前少做了一次轉換等，都不會被 mock 過的測試發現）。因此在自動化測試之外，實作完成時至少要用一份**真實存在的 `state.vscdb`**（開發機上已有）手動跑過一次完整流程並肉眼核對結果（例如比對輸出的 workspace 路徑與資料夾名稱是否對得上使用者自己認得的專案），做為自動化測試涵蓋不到的最後一道確認，並在 `docs/deploy-log.md` 記錄這次人工核對的結果——這是既有專案「肉眼瀏覽器 QA 留給人工確認」慣例的延伸,不是新發明的流程。
- **`sourceError` 從 adapter 到畫面的完整串接測試（不能只測 adapter 自己回傳的欄位）**：至少一個測試比照現有 `main --hide` 那類整合測試的做法，構造一個「目錄存在但 `state.vscdb` 損毀」的假環境，直接呼叫 `main()`，驗證產出的 HTML 字串裡确實含有 `meta.antigravitySourceError`／`DATA.antigravitySourceError` 序列化後的內容；再用 `runDashboardScript` 額外驗證當 `DATA.antigravitySourceError` 為真時，前端確實渲染出警告文字的 DOM 元素——涵蓋 `main()` 組 `meta`、`buildHtml` 序列化進 `DATA`、前端讀取並渲染三段銜接，避免「adapter 測試全綠但畫面沒有警告」這種串接漏接不被任何測試發現。
- **前端三工具整合測試**：擴充既有的 `runDashboardScript` DOM 測試，驗證三種 `tool` 值都能被篩選下拉選單選取、`antigravity` session 的續接按鈕產生的是「開啟資料夾」指令而非誤用 `claude --resume`、以及三種工具徽章都有各自對應的樣式。
- **「開啟資料夾」指令的真機行為驗證（自動化測試涵蓋不到，先前版本遺漏，這次補上）**：`Antigravity IDE.exe <folder>` 能不能真的開啟指定 workspace，目前仍是**未驗證假設**（見上方「續接方式本身需要重新定義」小節）；自動化測試只能驗證產出的命令字串格式正確，無法證明執行後真的會開啟正確的資料夾。實作完成時，至少要手動複製一次產生的指令、貼到 PowerShell 實際執行，確認 Antigravity 開啟的是命令裡指定的那個 workspace 資料夾（不是開啟到別的專案、或完全沒反應），並涵蓋一個路徑含空白字元的真實資料夾（驗證 PowerShell 單引號跳脫在真實執行環境下真的有效，不是只在字串比對層級正確），把結果記錄進 `docs/deploy-log.md`——這是既有專案「肉眼瀏覽器 QA 留給人工確認」慣例在這個子功能上的延伸。若真機驗證發現 `Antigravity IDE.exe` 不接受資料夾路徑參數（假設不成立），需要回頭重新設計這個子功能，不能假設自動化測試通過就代表這個功能真的可用。

模組化拆分（規劃一）與 Antigravity 開發（規劃二）兩者的驗證標準不同，不能混用同一套「141 筆全過」的標準：模組化只要求「維持全綠、不改斷言」，Antigravity 則需要上述新測試先紅後綠，才能證明新功能本身是對的。

## 尚未涵蓋 / Out of scope

- Antigravity 的訊息預覽（首/末則訊息內容）——本輪明確排除，未來若要做，需要另外解開 protobuf BLOB 裡的訊息內容格式，屬於獨立的可行性調查。
- Claude Code／Codex 自身的 session 保留機制（`cleanupPeriodDays` 預設 30 天自動刪除、Codex 的 archived_sessions）——本工具刻意不做競爭的刪除機制，只做本機端的顯示層隱藏（`session-dashboard-hidden.json`），這是先前已核准的既定決策，此文件只是記錄現況，不重新開放討論。
- 「原始碼與部署副本是兩個不同路徑、改完要手動同步」這件事本身的既有落差（例如要不要改成自動化部署腳本）——這輪不處理，維持手動 `cp` 的既有工作模式。**但注意這不等於「複製哪些檔案」也維持不變**：模組化拆出 `src/adapters/` 後，複製的內容必須包含這個新目錄，是「規劃一：模組化對部署流程的影響」小節裡明確要求的強制項目，不屬於這裡排除的範圍。
- **Antigravity 的另外兩個候選來源**：`.system_generated/logs/transcript.jsonl`（逐字使用者輸入，覆蓋率 2/10）可作為未來訊息預覽的候選來源；`winters27/google-antigravity-export` 走的本機 HTTP API 路線（`GetAllCascadeTrajectories`／`GetCascadeTrajectorySteps`）資料更完整，但需要 Antigravity 正在執行中，跟本工具「離線掃描靜態檔案」的既定方向衝突，這輪不採用，留待未來評估是否要為 Antigravity 開一條不同於 Claude/Codex 的「即時資料」路徑。

## 本次修訂摘要（2026-08-03 第二次修訂）

使用者要求「先上網研究社群是否已經摸清 Antigravity 的資料結構」後，對照 [`ag-donald/Antigravity-Database-Manager`](https://github.com/ag-donald/Antigravity-Database-Manager) 公開的逆向工程 schema，重新解碼這台機器真實的 `state.vscdb`，發現並修正了初版規劃兩個實質性錯誤：

1. **少了一層 base64 包裝**：`TrajectorySummary.field 2` 不是直接的巢狀 protobuf，而是要再做一次 `Buffer.from(str, 'base64')` 才能拿到真正的 `TrajectoryPayload`。少了這一步，後面所有欄位位置都會建立在解析錯誤位置的 bytes 上。
2. **workspace 路徑的欄位位置猜錯**：初版說是 `depth4/field7`，實際上 `field 7` 是 `updated_at` 時間戳，真正的路徑在巢狀的 `field 9`（`WorkspaceInfo`）裡的 `field 1`。

以及一個原本設計的安全機制在真實資料上不成立：「UUID 必須對應到 `conversations/` 目錄下的真實檔案」這項驗證，拿這台機器 8 筆真實資料的三組 UUID 逐一比對，**沒有一筆對得上**（很可能是這台機器的 `conversations/` 資料夾經歷過資料復原/搬移，詳見規劃內文），已經拿掉這項驗證。

**優點**：標題欄位（先前排除、這次改為採用）在測試的 8 筆真實資料裡 100% 有值，且是 Antigravity 自己產生的乾淨標題（例如「整理並上傳專案至 GitHub」），比先前規劃仰賴的 `task.md.metadata.json`（覆蓋率 50%）可靠得多；額外拿到 branch／git remote 資訊（先前誤判「沒有分支概念」）；時間戳記改用 payload 自帶欄位，不再依賴常常對不上的實體檔案。

**缺點／取捨**：拿掉「對應到真實檔案」這層驗證後，安全網完全依賴結構指紋比對（欄位形狀＋巢狀關係＋`complete` 旗標），比初版設計的「兩層獨立防禦」少了一層；且這次的修正同樣建立在**一台機器**的真實資料與**一份非官方**的社群逆向工程 schema 上，仍然可能有本文件目前沒發現的邊界情況——跟初版一樣，這是私有格式先天無法用客戶端檢查證明到零風險的部分，需要誠實記錄而非假裝解決。

**本節尚未經過 codex-peer-review**：文末的審查標記是針對修訂前的版本，本次修訂涉及的欄位位置與驗證機制屬於實質變更，若要沿用先前「重要決策需要獨立審查」的慣例，應該在實作前再跑一輪 review，而不是逕行套用舊的審查結論。

<!-- codex-peer-reviewed: 2026-08-03T11:51:52Z rounds=13 verdict=approved (內容已於 2026-08-03 第二次修訂後更新，此標記僅適用於修訂前版本，尚待重新審查) -->
