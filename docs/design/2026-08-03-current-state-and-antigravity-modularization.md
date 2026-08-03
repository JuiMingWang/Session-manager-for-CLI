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

### 可行性結論（已驗證，非假設）

Google Antigravity（VS Code fork）的本機資料分散在 `~/.gemini/antigravity/` 與 `~/AppData/Roaming/Antigravity IDE/`（Electron userData，標準 VS Code fork 佈局）。逐一驗證各種資料來源後：

| 來源 | 格式 | 可讀性 |
|---|---|---|
| `conversations/*.pb` | 未知二進位（非 gzip/zlib/deflate，幾乎無可印字元） | **不可直接讀取**，不採用 |
| `conversations/*.db` | 真正 SQLite（`node:sqlite` 可開），但訊息內容欄位是 protobuf BLOB | 結構可讀，內容仍需 schema |
| `~/.gemini/antigravity/brain/<uuid>/task.md.metadata.json` | 純 JSON，`summary`／`updatedAt` | **可直接讀取**，但覆蓋率不完整（實測 4 筆對話中 1 筆缺檔） |
| `User/workspaceStorage/<hash>/workspace.json` | 標準 VS Code JSON，`folder` 欄位 | **可直接讀取**，但只列出「目前開啟過的 workspace」，不是「每筆對話對應哪個 workspace」的清單 |
| `User/globalStorage/state.vscdb` 的 `antigravityUnifiedStateSync.trajectorySummaries` key | base64 → protobuf（無官方 schema，UI 內部同步用） | **可讀取** —— 用自寫的 schema-less protobuf wire-format walker 解出，實測對 ~10 筆真實對話都能拿到一致的欄位編號：對話 UUID（depth1/field1）、workspace 資料夾 URI（depth4/field7，例如 `file:///c:/Users/sjack/OneDrive/Documents/ffmpeg功能化`）、標題文字（depth3/field1） |

**確切讀取路徑（端到端，已用真實檔案驗證過，不是抽象描述）**：`state.vscdb` 是標準 SQLite 檔案，用 `SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries'` 取出一筆列；這個 `value` 欄位本身存的是 **文字型別、內容為 base64 字串**（不是原始 bytes），要先 `row.value.toString('utf8')` 拿到 base64 字串，再 `Buffer.from(base64Str, 'base64')` 才會得到真正的 protobuf bytes，之後才餵進 walker。這條路徑（SQL 查詢字串、`ItemTable`/`key`/`value` 欄位名稱、value 是「文字包 base64」而非直接 blob）在這次規劃前已經用真實資料庫實測過，不是憑空假設的 schema。

**結論：Antigravity 對話 → 專案資料夾的對應關係可以取得**，解決了先前認定的阻斷性缺口（沒有這層對應，就只能全部落在雜項）。

### 這一輪的抓取範圍（刻意縮小，降低風險）

`trajectorySummaries` 是 Google 內部 UI 狀態同步用的私有格式，沒有公開文件，欄位編號可能在任何一次更新後改變且不會事先通知 —— 跟 Claude Code／Codex 的 JSONL 格式（穩定、廣泛使用、社群已驗證過）风险量级不同。因此這次只從這個來源抓**兩個**欄位，且都有可驗證的固定格式：

- **對話 UUID**（depth1/field1）：驗證方式有兩層，不只是「長得像 UUID」——(a) 符合 UUID 正規表示式；(b) **必須能在 `conversations/` 目錄下找到同名檔案**（實測確認該目錄下的檔名就是 `<uuid>.pb` 或 `<uuid>.db`，例如 `156aeb2b-3f2c-41b2-9037-9b813b58d97b.pb`）。只符合格式但目錄下找不到對應檔案的項目視為解析失敗、整筆丟棄——這一層是against「格式編號被 Google 換掉、solved 剛好又解出另一個合法 UUID 但語意已經錯了」這種格式檢查本身防不住的情況：真正的 trajectory 一定會有對應的實體檔案，混淆到別的欄位則幾乎不可能剛好對到一個真實存在的檔名。
- **workspace 資料夾 URI**（depth4/field7）：不是「以 `file:///` 開頭就好」，而是明確的轉換＋驗證步驟：(1) 必須整體符合 `^file:\/\/\/[a-zA-Z](:|%3[Aa])\//` 這種「磁碟機代號開頭」的形狀（能排除大部分非路徑的文字誤判）；(2) 去掉 `file:///` 前綴後對剩餘部分做 `decodeURIComponent`（同時處理磁碟機代號本身可能是 `c:` 或 `c%3A` 兩種寫法，以及資料夾名稱中的中文／符號百分比編碼），解碼失敗（例如截斷的 `%` 序列）視為驗證失敗；(3) 解碼後的字串（例如 `c:/Users/sjack/OneDrive/Documents/ffmpeg功能化`）直接可以餵給既有的 `normalizePath`／`normalizeGroupKey`／`displayNameForCwd`——這三個函式本來就把反斜線／正斜線視為等價（`replace(/\\/g, '/')`），所以不需要額外轉成反斜線，Node 的 `fs.existsSync` 在 Windows 上也接受正斜線路徑。

  **殘留風險、單筆結構指紋比對、與整批一致性檢查（三層防禦，取代原本只有 canary 一層）**：光靠「URI 形狀＋解碼」與整批比例，仍防不住 codex 在第三輪指出的情況——欄位編號整體位移後，新位置上剛好普遍（甚至每一筆）都長得像合法且存在的路徑，這時比例門檻會誤判成「格式沒變」而全部接受。要真正把這個風險壓低，不能只看單一欄位或事後統計，必須在**單筆記錄內部**驗證「這是不是原本就認得的那個結構」，而不只是「這個值長得像不像 URI」：
  1. **單筆結構指紋比對（record-level structural fingerprint，主要防線）**：實測 ~10 筆真實 trajectory 得到的不只是 depth4/field7 這一個欄位，而是一組**同時存在、彼此固定**的欄位樣板——depth1/field1 是 UUID 形狀的文字、depth3/field1 是像標題的自由文字、depth3/field4 是另一個 UUID 形狀的文字、depth4/field7 是 URI 形狀的文字，四者出現在同一筆記錄的固定巢狀位置。驗證改成要求**這四個欄位同時符合各自預期的形狀**才採信這筆記錄的任何欄位（不只是驗證 workspace URI 單獨一個欄位）；只要其中任一欄位對不上預期形狀，就判定「這筆記錄的結構樣板跟已知格式不符」，整筆記錄（UUID、標題、路徑全部）視為解析失敗、不採信、不使用。這是 fail-closed 設計：格式一旦真的位移，位移通常會同時打亂樣板裡的好幾個欄位，而不會恰好只動一個又剛好維持其餘三個不變——要求四個獨立特徵同時吻合，遠比只驗證一個欄位的巧合機率低很多。

     **trajectory 邊界的明確定義（先前版本遺漏，這次補上——這是正確性上的必要前提，不只是風險緩解）**：`trajectorySummaries` 這個 protobuf 值本身是「多筆 trajectory 依序排列」的頂層 repeated 結構，walker 在最外層（depth 0）逐一走訪這些 length-delimited 子區塊時，**每一個頂層子區塊就是一筆獨立的 trajectory**，其餘所有更深的欄位（depth1/field1、depth3/field1、depth3/field4、depth4/field7）都必須是「對這一個子區塊各自遞迴解析」得到的結果，不能把整個 `trajectorySummaries` 一次性攤平成一份跨越所有 trajectory 的全域 (depth, field) → 文字清單再去配對——那樣做的話，若 walker 的實作是「不分 trajectory、全域收集所有符合形狀的字串」，四個欄位很可能各自來自不同筆 trajectory（例如 A 對話的 UUID 配到 B 對話的 workspace URI），會把 session 歸類到完全不相關的專案，而且這個錯誤不會被任何格式驗證擋下（每個欄位單獨看都是合法的）。具體要求：walker 的輸出結構必須是「一個陣列，每個元素對應一筆 trajectory，內含只在該筆子區塊遞迴範圍內收集到的欄位」，四欄同時驗證的比對只能在同一個陣列元素內部進行，絕不能跨元素配對。測試計畫需新增一則「兩筆 trajectory 各自都通過結構指紋比對，但斷言 A 的 UUID 只會跟 A 自己的 URI 配對、絕不會跟 B 的 URI 配對」的 fixture 測試，直接驗證這個邊界規則。

     四個子檢查各自的具體規則（避免「title-shaped＝任意非空字串」這種寬鬆到沒有防護力的定義，也避免過嚴誤拒真實資料）：
     - depth1/field1（第一個 UUID）／depth3/field4（第二個 UUID）：套用同一條 UUID 正規表示式，兩者規則完全相同、獨立各自檢查。
     - depth4/field7（workspace URI）：套用前面已定義的「磁碟機代號開頭形狀＋`decodeURIComponent` 成功」規則。
     - depth3/field1（標題形狀文字）：**不是「非空字串就算數」**，而是必須同時滿足 (a) `looksLikeUtf8Text(bytes)` 判斷——這段 bytes 重新編碼回 UTF-8 後要能無損還原（排除誤把二進位資料當文字），且可印字元佔比需高於 85%；(b) 解碼後的字元數落在 1～300 之間（上界比對既有 `extractClaudeTitle`/`extractCodexTitle` 120 字截斷與訊息預覽多行上限的量級，避免把一段格式錯位後湊巧解出的長篇雜訊也當成標題形狀）。**澄清這個判斷函式的來源**：`looksLikeUtf8Text` 目前只存在於這次調查用的一次性 scratch 腳本（`protobuf_walk.js`）裡，**這個 repo 的正式程式碼裡沒有這個函式，也沒有任何既有的 protobuf 解析邏輯**——因為整個 protobuf wire-format walker 本身就是這次 Antigravity adapter 要新寫的程式碼，不是「重用某個既有 repo 函式」；上面這條規則是這個新 walker 內部要實作的其中一個判斷式，其邏輯已經在 scratch 腳本上針對真實資料驗證過（對 ~10 筆真實 trajectory 有效區分文字與二進位欄位），但落地時是全新程式碼，不是既有 `isSyntheticClaudeText`／`looksLikeInjectedDocument`（這兩個是既有的、但服務於完全不同用途——過濾 JSONL 訊息內容裡的雜訊，不是判斷 protobuf 欄位是否為文字）那類函式的延伸。這個欄位**只用來當作指紋比對的其中一項獨立檢查，其值本身不會被拿來顯示**（顯示標題仍照上一段所述完全不採用這個來源，用 `task.md.metadata.json`／退而標題）——用意是多一個獨立、可證偽的形狀約束，而不是提供顯示內容。
     - **明確承認並測試這個 fingerprint 抓不到的反例**：測試計畫需包含一則刻意建構的「假設欄位已經漂移，但漂移後在這四個位置上剛好同時產生合法 UUID／合法 UUID／合法標題形狀文字／合法且存在的 URI」fixture，斷言這種情況下 fingerprint 檢查『會』通過（也就是明確證明並記錄這個已知、無法排除的殘留風險邊界，而不是留給實作者自己猜或誤以為 fingerprint 能防住一切）——這則測試的目的是讓「殘留風險」從一句文件敘述變成一個可執行、可回歸驗證的已知邊界。
  2. **整批一致性檢查（次要防線，抓「大部分記錄的樣板都對不上」這種明顯drift）**：同一次掃描中，統計通過「單筆結構指紋比對」的 trajectory 佔全部候選的比例；若這個比例明顯偏低（低於既有 ~10 筆真實資料驗證時觀察到的「幾乎全數通過」水準，門檻訂為低於 50%），代表格式很可能已經整體改變，判定「這次掃描的來源整體不可信」，觸發失敗安全網第 4 層的「安裝但讀取失敗」路徑：回傳 `{ sessions: [], sourceError: true, skipped: <這次掃描到的 trajectory 總筆數> }`（連原本少數通過單筆指紋比對的記錄也一併不採信、計入 `skipped`），**不會產生任何 Antigravity session、也不會有任何一筆落到雜項**——跟 Claude/Codex 既有「cwd 是家目錄本身 → 雜項」的語意是完全不同的兩件事，不能混用同一個詞彙或當作彼此的同義詞。
  3. **誠實承認無法歸零的殘留風險**：即使加上結構指紋比對，理論上仍無法完全排除「Google 剛好把四個欄位全部搬到另一組同樣自洽、同樣格式正確的新位置」這種極端巧合——這是使用沒有官方文件的私有格式本質上無法用任何客戶端檢查證明到零風險的部分，必須誠實記錄而非假裝解決。但這個殘留風險的**實際影響是有界且可逆的**：最壞情況是某筆 Antigravity session 被歸類到錯誤的專案節點（顯示層的分類錯誤），不會造成 Claude Code／Codex 資料損毀或遺失，且使用者一旦目視發現分類錯誤，既有的「隱藏」功能可以立即讓這筆 session 不再顯示——不是一個會擴散或無法挽回的風險，值得記錄但不构成阻擋這個功能上線的理由。

     **另一種性質不同的殘留風險：整份 blob 尾端被截斷，導致最後一批 trajectory 整批默默消失（codex 第 12 輪指出，這裡誠實承認、不強行解決）**：`complete` 旗標只能偵測「單一子區塊內部」的截斷，抓不到「整個 `trajectorySummaries` 這份 repeated 清單本身在某個子區塊的正常結尾後被截斷，後面本來還有更多筆 trajectory」——因為 protobuf 的 repeated 欄位沒有明確的「清單到此結束」標記，讀到 buffer 結尾這件事，語法上完全無法區分「清單真的到此為止」跟「清單被截斷、後面遺失的部分剛好從一個子區塊的正常邊界開始」。這是這個 wire format 本身的結構性限制，不是這次設計的疏漏，也沒有辦法單靠 `trajectorySummaries` 自己的 bytes 解決。**但這個殘留風險在性質上跟其他幾層防禦要防的風險不同，嚴重程度也更低**：它造成的後果是「某些真實存在的 Antigravity session 暫時不會出現在儀表板上」（遺漏／省略），而不是「顯示出歸類錯誤或內容錯誤的 session」（誤植／顯示錯誤資料）——這正好完全符合這份文件從頭到尾採用的核心原則「寧可誠實跳過，不要悄悄顯示錯的」：跳過／不顯示，是這個系統本來就選擇的、比顯示錯誤內容更能接受的結果。此外，這個殘留風險實務上也不是新增的失敗模式：即使 `trajectorySummaries` 完全沒有損毀，Antigravity 自己的內部同步機制本身就可能落後於 `conversations/` 目錄下真實存在的對話檔案（例如剛結束、還來不及同步進這個 key 的對話）——這種「檔案存在但還沒同步進 `trajectorySummaries`」的情況，看起來跟「被截斷而遺漏」一模一樣，都是「這個工具這次沒抓到這筆 session」，屬於已知、既有、任何同步機制都無法完全避免的落後視窗，不是這次新引入的缺陷。因此這裡的處理方式是誠實記錄這個邊界（截斷偵測在協定層級無法做到，效果等同於既有的同步延遲落差），而不是嘗試發明一個無法真正解決的偵測機制。

**刻意不從這個來源抓「標題」欄位**（尽管 depth3/field1 實測看起來是可用的真實標題）。原因：路徑與 UUID 都有明確、可程式驗證的固定格式，格式不符就能安全判定「這欄位解析失敗」；但標題是自由文字，沒有可驗證的形狀，一旦欄位編號在未來版本位移，抓到的可能是「看起来像標題但其實是別的欄位內容」而不會被任何驗證擋下 —— 這正是最需要避免的「靜默顯示錯誤資料」情境。標題改用兩層既有、零風險的退路：

1. `task.md.metadata.json` 的 `summary`（純 JSON 讀取，沒有逆向工程成分）。
2. 上述都沒有時，比照 Claude/Codex 既有的「退而標題」機制（CONTEXT.md 定義：資料夾名稱＋時間戳記），標記為退而標題並套用既有的灰階／斜體視覺警告。

本輪範圍另外排除「訊息預覽」（首/末則訊息內容）——這需要解開 protobuf BLOB 裡的實際對話內容，风险與工作量都明顯高於 UUID／路徑兩個自我驗證欄位，且使用者已在先前決策中選擇「這輪先不做訊息預覽，其他都做」。

### SessionRecord 完整欄位映射（先前規劃遺漏，本次補上）

前端整個渲染邏輯（排序、時間範圍篩選、久未使用判定、時間區間分桶、接續快速區候選挑選）都依賴一組固定欄位形狀，先前版本只談到 `id`／`title`／`cwd` 三個核心欄位怎麼來，沒有明確定義其餘既有欄位在 Antigravity 這邊怎麼填，若漏填或填入無效值，會在既有那些依賴這些欄位的邏輯裡出現排序錯誤、`Invalid Date`、或永遠進不了久未使用區等問題。比照 `scanClaudeCodeFile`／`scanCodexFile` 既有回傳形狀，逐一定義：

| 欄位 | 來源 | 說明 |
|---|---|---|
| `tool` | 固定字串 `'antigravity'` | 新增的第三種工具值 |
| `id` | trajectory UUID | 已定義的驗證規則見上 |
| `cwd` | workspace URI 解碼後的路徑 | 已定義的轉換規則見上 |
| `groupKey`／`displayName` | 套用既有 `normalizeGroupKey`／`displayNameForCwd`，輸入為上面的 `cwd` | 與 Claude/Codex 完全相同的既有函式，不需要新邏輯 |
| `startedAt` | `fs.statSync(對應的 conversations/<uuid>.pb 或 .db 檔案).birthtime.toISOString()` | **直接比照 `scanClaudeCodeFile`/`scanCodexFile` 既有慣例**（兩者皆用檔案的 `birthtime` 當 `startedAt`），不使用 `task.md.metadata.json` 的時間戳，因為後者覆蓋率不完整（實測約 75%），而對應的實體檔案一定存在（第 3 節已定義 UUID 必須對應到實體檔案才算通過驗證） |
| `lastActiveAt` | 同上，改用該檔案的 `mtime.toISOString()` | 同上，比照既有慣例，100% 覆蓋率，不依賴 `task.md.metadata.json` |
| `branch` | 固定 `null` | Antigravity 沒有 git 分支概念可對應；既有前端本來就對 `s.branch` 做 falsy 檢查（`(s.branch ? '　branch：' + s.branch : '')`），`null` 是既有程式碼已經優雅處理的既定情況，不需要新增分支邏輯 |
| `title`／`titleIsFallback` | 見上一節（`task.md.metadata.json` 的 `summary`，或退而標題） | `titleIsFallback` 依實際採用哪一層設為 `true`/`false`，比照既有欄位語意 |
| `pathExists` | 對解碼後的 `cwd` 呼叫既有 `fs.existsSync`，跟 Claude/Codex 完全相同的檢查方式 | 沿用既有失效路徑機制，不需要新邏輯 |
| `firstMessagePreview`／`lastMessagePreview` | 固定 `null` | 本輪明確排除訊息預覽（見上），既有前端本來就對 `null` 顯示「（無）」占位文字，不需要新增處理 |

### Antigravity 與既有 UI／續接契約的整合缺口（先前規劃遺漏，本次補上）

先前版本的規劃只談到「`scanAntigravity()` 回傳的 session 併入既有 `sessions` 陣列」，但實際檢查現有前端程式碼後發現：**現有 UI 與續接指令是寫死只認兩種工具**，Antigravity session 混進去會直接壞掉，不是自動相容。具體要處理：

- **`buildResumeCommand(tool, cwd, sessionId)`**（後端 `session-dashboard.js:43`）與前端 `<script>` 裡的同邏輯複製品（`tool === 'codex' ? 'codex resume' : 'claude --resume'`）：目前只有二分支，任何非 `codex` 的 tool 值都會被誤判成走 `claude --resume`。Antigravity 必須新增自己的分支，不能落到 else。
- **續接方式本身需要重新定義**：這台機器上只找到 Antigravity 的 GUI 執行檔（`Antigravity IDE.exe`，實測路徑為 `%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe`），沒有查到任何能像 `claude --resume <id>`／`codex resume <id>` 那樣「直接跳轉到指定對話」的命令列參數——這是**未驗證假設**：Antigravity 可能根本沒有這種 CLI 能力。因此這次的設計決定是：Antigravity 卡片的「續接」改成「複製開啟該 workspace 資料夾」的指令，並在按鈕文字／說明上明確告知使用者「這會開啟專案資料夾，需要自行在 IDE 內找到該對話」，不能沿用「直接接續到那一句對話」的既有語意，避免使用者誤以為跟 Claude/Codex 的續接是一樣的體驗。這個指令的完整契約（先前版本只給了一個沒有定義來源的範例，這裡補上）：
  - **執行檔路徑的來源**：前端是純靜態 HTML，瀏覽器端沒有檔案系統存取能力，不可能在點擊當下才去找 exe 在哪——執行檔路徑必須在 **Node 端掃描時**（`scanAntigravity()` 內）用 `fs.existsSync` 探測 `%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe` 這個已知安裝位置，探測到才把路徑寫進該筆 session 的資料（例如 `s.antigravityExePath`）隨 HTML 一併嵌入；探測不到則該筆 session 完全不產生「續接」按鈕，只顯示 workspace 資料夾路徑的純文字供使用者自行處理——這是「誠實跳過」原則在這個子功能上的具體應用，而不是硬產生一個很可能執行不了的指令。
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
3. **環境相依性的顯式檢查，且明確規定檢查順序（先前版本遺漏順序，這次補上）**：`node:sqlite` 是較新版 Node.js 才有的內建模組（這個 repo 目前沒有在任何地方宣告最低 Node 版本要求），且需要用 `{ readOnly: true }` 開啟 `state.vscdb`／`*.db`（這些檔案可能正被執行中的 Antigravity IDE 佔用，唯讀開啟避免鎖定或意外寫入）。**順序很重要**：判斷「沒裝」與「裝了但還沒有 `state.vscdb` 檔案」這兩種情況，只需要 `fs.existsSync`（純檔案系統檢查），完全不需要用到 `node:sqlite`——必須先做完這兩層純檔案系統檢查，確認 `state.vscdb` 這個檔案本身真的存在之後，才需要 `require('node:sqlite')` 去開啟它查詢；如果順序反過來（一開始就不分青紅皂白先 `require('node:sqlite')`），會導致「這台機器根本沒有 Antigravity 或還沒建立這個檔案」跟「`node:sqlite` 模組本身不可用」這兩種情況被錯誤地混在一起判斷，而後者才是真正該算 `sourceError: true` 的組合情境（`state.vscdb` 檔案確實存在，但因為 `node:sqlite` 不可用而讀不到裡面的內容——檔案存在代表資料很可能就在裡面，只是這台機器現在讀不到，跟「還沒有資料」語意不同）。`require('node:sqlite')` 本身必須包在 try/catch 裡（不能是模組頂層直接 `require`，否則版本不支援時會在載入 adapter 檔案當下就拋錯，跳過所有後續 try/catch）。測試計畫需新增一則「`state.vscdb` 檔案確實存在，但模擬 `require('node:sqlite')` 拋錯」的情境，斷言結果是 `sourceError: true`（不是 `false`），驗證這個判斷順序真的有被實作出來，而不是被誤判成「還沒有資料」。
4. **Antigravity adapter 整體 try/catch，且區分「沒裝」「裝了但還沒有資料」「裝了但讀取失敗」三種情況，並明確定義從 adapter 到畫面的完整串接路徑**：`scanAntigravity()` 最外層包一層 try/catch，明確定義三種結果（先前版本只談了頭尾兩種，中間這種「合法的空狀態」先前版本沒有明確定義，這次補上）：

   - **沒裝**：`~/.gemini/antigravity` 與 Antigravity IDE userData 兩個目錄都不存在 → `{ sessions: [], skipped: 0, sourceError: false }`（誠實代表「這台機器沒有安裝 Antigravity」）。
   - **裝了但還沒有 trajectory 資料（合法的空狀態，不是錯誤）**：上述目錄存在，但 (a) `state.vscdb` 檔案本身不存在，或 (b) `state.vscdb` 存在且能正常開啟查詢，但 `SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries'` 查不到任何一列 → 這兩種情況都代表「使用者裝了 Antigravity、但目前為止沒有任何對話被同步寫進這個 key」（剛安裝、或裝了但從未真正開始一次對話），是完全合法、預期得到的空狀態，**不是錯誤**，回傳 `{ sessions: [], skipped: 0, sourceError: false }`，跟「沒裝」給同一種誠實但空的結果，不應該讓使用者看到警告訊息。
   - **裝了、有資料，但讀取過程中真的失敗**：`state.vscdb` 存在、`ItemTable` 裡也查得到 `trajectorySummaries` 這一列，但後續任何一步失敗——`value` 不是預期的文字型別、`node:sqlite` 模組不可用（見上一點的順序規則）、資料庫檔案損毀或被鎖定導致開啟/查詢本身就拋例外、或是 protobuf bytes 完全無法用 walker 解析出任何一筆通過結構指紋比對的合法 trajectory（見下方整批一致性檢查，0% 通過率是這裡的極端情況）——這代表「資料很可能存在，但讀不出來」，跟前一種「還沒有資料」在语意上完全不同，**不能回傳跟前兩種一樣的結果**，回傳 `{ sessions: [], skipped: 0, sourceError: true }`。

     **「base64 decode 失敗」不是獨立的偵測手段（先前版本的錯誤假設，這次修正）**：先前版本把「base64 decode 失敗」當成一個會拋例外、可以直接 try/catch 抓到的獨立失敗情境，但這是錯的——**已用真實 Node 環境驗證過，`Buffer.from(str, 'base64')` 對非法字元或截斷輸入完全不會拋錯**（例如 `Buffer.from('not@@base64', 'base64')` 不拋例外，只會安靜跳過不合法字元、回傳它能拼湊出的任意 bytes；`Buffer.from('%%', 'base64')` 回傳長度 0 的空 buffer；沒有一種輸入會讓這行程式碼拋出例外）。所以「value 損毀」不能靠 base64 decode 這一步的 try/catch 偵測，真正能偵測到問題的地方，是 decode 出來的（可能是垃圾的）bytes 餵進 walker 之後，**找不到任何一筆通過單筆結構指紋比對的 trajectory**——這正好就是下方「整批一致性檢查」在通過率 0% 時的極端情況，不需要另外設計一個獨立的「base64 失敗」分支，這兩者本來就是同一個機制的自然延伸。

     **protobuf walker 本身面對垃圾／截斷輸入必須是有界、不拋出未預期例外的（先前版本沒有明確要求，這次補上）**：由於 value 損毀時 decode 不會報錯、餵進 walker 的可能是完全隨機的 bytes，walker 的實作必須自己對這種輸入保持穩固，而不是假設輸入永遠是合法的 protobuf：(a) 遞迴深度需要有上限（沿用先前調查用的 scratch 腳本已驗證過的做法，深度超過一個固定上限就停止遞迴，不使用真實資料才會出現的深度）；(b) 讀取 varint／length-delimited 長度時，一旦超出 buffer 剩餘長度就直接停止解析這個子區塊，不能無界讀取或造成無窮迴圈；(c) 遇到未知或不支援的 wire type 就停止解析目前這個子區塊。這三條規則的目的是確保 walker 面對任意亂數 bytes 時，最壞情況只會是「找不到任何合法 trajectory」（進而觸發上述的 `sourceError: true` 路徑），而不會讓單一垃圾輸入造成掛起或程式崩潰——測試計畫需新增以純隨機 bytes（非真實 protobuf）餵給 walker 的 fuzz 測試，驗證函式呼叫必定在有限時間內回傳、不拋出未被上層 try/catch 涵蓋的例外。

     **「提早停止時回傳已收集欄位」本身還不夠 fail-closed，需要額外傳遞完整度旗標（codex 第 11 輪指出，這次修正）**：上面 (b)(c) 兩條規則只解決「不會掛起／不會拋例外」，但沒解決一個更細的正確性問題——如果某個子區塊在成功收集到全部四個 fingerprint 欄位『之後』才因為超出邊界或遇到未知 wire type而提早停止，這筆記錄目前的規則會讓它照樣通過四欄指紋比對（畢竟四個欄位都在，只是这筆資料實際上是被截斷、不完整的），這不是真正的 fail-closed。修正：walker 對每個頂層子區塊（每筆 trajectory）除了收集欄位內容之外，還要額外回傳一個 `complete: boolean` 旗標——只有子區塊被完整走訪到最後一個 byte、且過程中從未觸發 (b)(c) 的提早停止規則，才標記 `complete: true`；只要曾經觸發過任何一次提早停止（即使停止點在四個欄位都已經收集到之後），就標記 `complete: false`。單筆結構指紋比對必須把 `complete === true` 當成第五個必要條件，跟四個欄位形狀檢查一起要求同時成立——`complete: false` 的子區塊無論欄位形狀看起來多正常，一律視為解析失敗，不採信任何欄位。測試計畫需新增一則「四個欄位都在正常位置、但子區塊本身被人為截斷在最後一個欄位之後」的 fixture，驗證這種情況下 `complete` 為 `false`、整筆記錄仍被判定失敗，不會因為欄位剛好都讀到就被誤判為通過。

     **base64 内容形狀的最低限度前置檢查，以及為何不做到「canonical round-trip」等級（codex 對此持保留意見，這裡明確記錄判斷與理由）**：已用真實 Node 環境驗證過，在合法 base64 字串前後插入非法字元（例如 `!!!` 或 `###`）之後 `Buffer.from(..., 'base64')` 會直接忽略這些非法字元、解碼出跟乾淨字串完全相同的 bytes——代表單靠「decode 有沒有拋錯」或「decode 出來的 bytes 長度看起來合理」都無法分辨「這段文字混入了不該有的雜訊字元」。因此在 decode 之前，加一道最低限度的形狀檢查：整個 `value` 字串必須符合 `^[A-Za-z0-9+/]*={0,2}$`（只含合法 base64 字元集，等號只能出現在結尾且最多兩個），不符合就直接視為第 4 節「裝了、有資料，但讀取過程中真的失敗」的其中一種情況（`sourceError: true` 路徑）。**這裡刻意不做到 codex 建議的「canonical round-trip」（decode 後重新編碼回去比對是否完全一致）等級的驗證**：這個工具的風險模型是「Google 未來改變私有格式」與「檔案損毀／截斷」，不是「有敵意的第三方故意在字串中插入偽裝字元」——真實世界的磁碟損毀／截斷通常是位元反轉（字元被替換掉，會直接讓形狀檢查或後續 walker 解析失敗）或整段內容被截短（會被上面的 `complete` 旗標抓到），而不是「在維持所有原始字元、原始順序不變的前提下，額外插入完全不影響 decode 結果的雜訊字元」這種特定模式——這種模式需要刻意建構才會出現，不是這個系統實際會遇到的損毀樣態，加上最低限度的字元集檢查已經能擋掉「內容明顯不是 base64」的情況，這裡判斷不需要為了防禦一個不太可能自然發生的情境，再疊加一層更昂貴的 canonical round-trip 檢查——若使用者或未來維護者認為這個判斷過於樂觀，可以再加強，但這是一個經過權衡、有記錄理由的決定，不是遺漏。

   區分「還沒有資料」與「讀取失敗」的判斷依據，是**有沒有讀到能明確代表『目前不存在』的具體訊號**（檔案不存在、查詢回傳零列，這兩者都是資料庫／檔案系統明確、無歧義地告知「沒有」）；只要流程進行到需要「解讀已經拿到手的內容」（value 型別、base64、protobuf bytes）卻失敗，就代表可能有資料只是解不出來，必須算作 `sourceError: true`，不能因為「反正結果都是空 session 列表」就把這兩種語意混為一談。

   這個旗標不能停在 adapter 回傳值就結束，必須明確定義完整往下傳遞的路徑（先前版本只寫到「讓 main() 能夠顯示」為止，沒有具體規定怎麼接，這次補上）：`main()` 讀出 `antigravityResult.sourceError` 後，加進既有傳給 `buildHtml(sessions, meta)` 的 `meta` 物件裡（比照現有 `meta.skippedCount` 的做法，新增 `meta.antigravitySourceError: boolean`）；`buildHtml` 內嵌的 `dataJson`／`DATA` 物件比照 `DATA.skippedCount` 的既有模式一併帶上這個欄位。

**`skippedCount` 也必須把 Antigravity 算進去（先前版本遺漏）**：現有 `main()` 是 `const skippedCount = claudeResult.skipped + codexResult.skipped;`，只加了兩個來源。Antigravity adapter 一樣會回傳 `skipped`（第 1 層單筆 try/catch、以及結構指紋比對沒通過的筆數都計入），這個數字必須一併加進總數——`const skippedCount = claudeResult.skipped + codexResult.skipped + antigravityResult.skipped;`——否則 Antigravity 這邊被跳過的記錄不會反映在既有「已跳過 N 個異常檔案」的提示文字裡，等於這部分的「誠實跳過」訊息被漏報，違反核心原則。

**前端渲染時兩則警告訊息共存的處理（先前版本遺漏，這次補上）**：既有 `#skipped-warning` 是單一 DOM 元素，既有邏輯是 `if (DATA.skippedCount > 0) { document.getElementById('skipped-warning').textContent = '已跳過 ' + ... }` 這種直接覆寫 `textContent` 的寫法。若照原計畫單純加一個對稱的 `if (DATA.antigravitySourceError) { ... textContent = ... }`，當兩個條件同時成立時，後執行的 `if` 會直接覆寫掉前一個訊息，使用者只會看到其中一則警告——這是先前版本沒考慮到的真實 bug。修正做法：改成先收集適用的訊息到一個陣列，兩個 `if` 都只做 `warnings.push(...)`，最後統一 `if (warnings.length > 0) { document.getElementById('skipped-warning').textContent = warnings.join('；'); }`——共用同一個既有 DOM 元素，不需要新增元素或改版面，兩則訊息用「；」串接同時顯示。測試計畫需新增一則「`skippedCount > 0` 與 `antigravitySourceError` 同時為真時，兩則警告文字都出現在渲染結果中」的 DOM 測試，覆蓋這個先前遺漏的共存情境。

這條路徑（adapter 回傳值 → `main()` 組進 `meta` → `buildHtml` 序列化進 `DATA` → 前端讀 `DATA` 並渲染警告文字）每一段銜接都要各自被測試覆蓋，不能只測 adapter 自己回傳的欄位對不對（見下方測試計畫的對應項目），否則 adapter 測試全綠，畫面上卻沒有真的顯示警告這種「串接漏接」的落差不會被任何測試抓到。
5. **結構性隔離（模組化的直接效益）**：`main()` 本來就是「各自獨立呼叫 `scanClaudeCode`／`scanCodex`／`scanAntigravity`，各自回傳結果後才合併」，任何一個來源的 try/catch 兜底之後，其餘來源的資料與既有測試斷言完全不受影響 —— 這件事在模組化完成、Antigravity 有自己的檔案之後，會是程式結構本身保證的，不需要額外加測試去證明「改 Antigravity 沒有動到 Claude/Codex 的程式碼」。

核心原則（使用者訪談中確認）：**寧可誠實跳過，不要悄悄顯示錯的**。任何一筆資料只要無法通過驗證，寧可讓這筆 session 退回到比較不精確但誠實的狀態，也不會顯示未經驗證、可能已經對應錯欄位的內容；「整個來源讀取失敗」也必須誠實地顯示出來，不能跟「本來就沒有這個來源」長得一樣。**「比較不精確但誠實的狀態」在不同來源代表不同的具體行為，不是同一種結果**：Claude/Codex 既有的「雜項」分類，適用的是「cwd 本身就是家目錄」這種本來就合法、只是沒有專屬專案資料夾的情況（見 CONTEXT.md「雜項」定義），標題退回「退而標題」也是同樣邏輯——都是「資料本身沒問題，只是缺少某個資訊」；但 Antigravity 的單筆結構指紋比對失敗／整批一致性檢查判定不可信，代表的是「解析結果可能整個是錯的、不可信」，對應的誠實行為是**整筆或整批直接不採信、計入 `skipped`，不產生任何 session、也不會落到雜項**——不能把這兩種情況都說成「歸類雜項」，兩者的資料可信度前提完全不同。

### 測試計畫

既有 141 筆測試只覆蓋 Claude/Codex 兩個來源，即使 protobuf 解析或 URI 轉換整段邏輯完全錯誤，這 141 筆也會全數照常通過——不能拿「既有測試沒壞」當作 Antigravity 功能正確的證據。新增功能至少需要以下幾類測試（沿用既有測試檔的風格：真實輸入的純函式單元測試＋`runDashboardScript` 的前端 DOM 執行測試）：

- **protobuf walker 的純函式測試**：用手動建構的、已知內容的 byte buffer（不依賴真實 `state.vscdb`，避免測試綁定使用者本機資料）驗證能正確解出巢狀欄位；並用「刻意打亂欄位編號」的 fixture 驗證解析失敗時回傳「解析失敗」而不是拋錯或吐出垃圾值。另需涵蓋 `complete` 旗標：正常走訪到子區塊結尾 → `complete: true`；四個欄位都已收集到、但子區塊本身被人為截斷在其後 → `complete: false` 且該筆記錄整體判定失敗。
- **base64 形狀前置檢查**：涵蓋合法 base64（含結尾 `=`／`==` padding）、內容混入非法字元（例如插在合法字串前後）、完全不是 base64 的隨機文字三種情況，驗證只有第一種通過前置檢查、後兩種都在 decode 之前就被判定為「讀取失敗」而不是被 `Buffer.from` 靜默吞掉非法字元後意外解出可用資料。
- **URI 轉換與驗證**：涵蓋 `file:///c:/...`、`file:///c%3A/...`、包含中文/符號的路徑、格式不符（不是 `file://` 開頭、drive letter 前綴缺失）、`decodeURIComponent` 會拋錯的截斷編碼字串等案例。
- **UUID 交叉比對**：格式正確但目錄下找不到對應檔案時必須判定為失敗；格式正確且檔案存在時必須通過。
- **單筆結構指紋比對**：至少三種 fixture——(a) 四個欄位（UUID、標題、第二個 UUID、URI）全部符合預期形狀 → 整筆採信；(b) 只有 URI 欄位單獨對不上、其餘三個仍正常 → 整筆判定失敗（不能只丟棄 URI、卻仍採信同一筆的其他欄位，因為結構指紋比對的前提就是「同一筆記錄的欄位若有一個對不上，代表整體樣板可能已經改變，不該再信任這筆的任何欄位」）；(c) 四個欄位全部對不上 → 整筆判定失敗。
- **整批一致性檢查**：構造一批「多數記錄通過單筆結構指紋比對」與一批「多數記錄未通過」的合成資料，驗證只有後者會回傳 `sourceError: true`、`sessions: []`、`skipped` 等於掃描到的總筆數（不產生任何 session，也不會有任何一筆落到雜項），前者則逐筆正常採信、正常產生對應的 session。
- **`scanAntigravity` 整合測試**：比照 `scanClaudeCode`／`scanCodex` 既有測試的做法，用暫存目錄構造假的 `.gemini/antigravity`／`Antigravity IDE` 結構，至少涵蓋五種情境並各自斷言對應的 `sessions`／`skipped`／`sourceError`：(a) 兩個根目錄都不存在 → 沒裝，`sourceError: false`；(b) 目錄存在但 `state.vscdb` 不存在 → 還沒有資料，`sourceError: false`；(c) `state.vscdb` 存在、可正常查詢，但查不到 `trajectorySummaries` 這一列 → 還沒有資料，`sourceError: false`；(d) `state.vscdb` 存在、查得到該列，但 `value` 內容損毀（例如不是合法 base64，或 decode 後的 bytes 无法被 walker 解析出任何合法 trajectory）→ 讀取失敗，`sourceError: true`；(e) 正常案例（真實可解析的資料）→ 正常產生 session。(b)(c) 兩種必須明確斷言 `sourceError` 為 `false`（不是 `true`），驗證「還沒有資料」不會被誤判成「讀取失敗」而顯示不必要的警告給剛安裝、還沒開始使用 Antigravity 的使用者。
- **`node:sqlite` 不可用時的降級**：模擬 `require('node:sqlite')` 拋錯的情境（例如透過依賴注入或 module mock），驗證 adapter 走「來源讀取失敗」的路徑而非讓整支程式當掉。
- **端到端驗證不能只靠手工 fixture／mock**：手工建構的 protobuf bytes 與 mock 過的 SQLite 呼叫，就算全部通過測試，仍不能證明 production 那條「`node:sqlite` 開 `state.vscdb` → `SELECT value FROM ItemTable WHERE key = ...` → `value` 先 `toString('utf8')` 再 base64 decode → walker 解析」的真實路徑本身是接對的（例如：SQL 拿到的 row 是 `undefined`、`value` 型別不是預期的文字、base64 decode 前少做了一次轉換等，都不會被 mock 過的測試發現）。因此在自動化測試之外，實作完成時至少要用一份**真實存在的 `state.vscdb`**（開發機上已有）手動跑過一次完整流程並肉眼核對結果（例如比對輸出的 workspace 路徑與資料夾名稱是否對得上使用者自己認得的專案），做為自動化測試涵蓋不到的最後一道確認，並在 `docs/deploy-log.md` 記錄這次人工核對的結果——這是既有專案「肉眼瀏覽器 QA 留給人工確認」慣例的延伸,不是新發明的流程。
- **`sourceError` 從 adapter 到畫面的完整串接測試（不能只測 adapter 自己回傳的欄位）**：至少一個測試比照現有 `main --hide` 那類整合測試的做法，構造一個「目錄存在但 `state.vscdb` 損毀」的假環境，直接呼叫 `main()`，驗證產出的 HTML 字串裡确實含有 `meta.antigravitySourceError`／`DATA.antigravitySourceError` 序列化後的內容；再用 `runDashboardScript` 額外驗證當 `DATA.antigravitySourceError` 為真時，前端確實渲染出警告文字的 DOM 元素——涵蓋 `main()` 組 `meta`、`buildHtml` 序列化進 `DATA`、前端讀取並渲染三段銜接，避免「adapter 測試全綠但畫面沒有警告」這種串接漏接不被任何測試發現。
- **前端三工具整合測試**：擴充既有的 `runDashboardScript` DOM 測試，驗證三種 `tool` 值都能被篩選下拉選單選取、`antigravity` session 的續接按鈕產生的是「開啟資料夾」指令而非誤用 `claude --resume`、以及三種工具徽章都有各自對應的樣式。

模組化拆分（規劃一）與 Antigravity 開發（規劃二）兩者的驗證標準不同，不能混用同一套「141 筆全過」的標準：模組化只要求「維持全綠、不改斷言」，Antigravity 則需要上述新測試先紅後綠，才能證明新功能本身是對的。

## 尚未涵蓋 / Out of scope

- Antigravity 的訊息預覽（首/末則訊息內容）——本輪明確排除，未來若要做，需要另外解開 protobuf BLOB 裡的訊息內容格式，屬於獨立的可行性調查。
- Claude Code／Codex 自身的 session 保留機制（`cleanupPeriodDays` 預設 30 天自動刪除、Codex 的 archived_sessions）——本工具刻意不做競爭的刪除機制，只做本機端的顯示層隱藏（`session-dashboard-hidden.json`），這是先前已核准的既定決策，此文件只是記錄現況，不重新開放討論。
- 「原始碼與部署副本是兩個不同路徑、改完要手動同步」這件事本身的既有落差（例如要不要改成自動化部署腳本）——這輪不處理，維持手動 `cp` 的既有工作模式。**但注意這不等於「複製哪些檔案」也維持不變**：模組化拆出 `src/adapters/` 後，複製的內容必須包含這個新目錄，是「規劃一：模組化對部署流程的影響」小節裡明確要求的強制項目，不屬於這裡排除的範圍。

<!-- codex-peer-reviewed: 2026-08-03T11:51:52Z rounds=13 verdict=approved -->
