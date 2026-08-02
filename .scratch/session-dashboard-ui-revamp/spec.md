Status: ready-for-agent

# Session 管理器儀表板 UI 改版

## Problem Statement

使用者每天用這個儀表板來接續 Claude Code／Codex 的舊 session，但目前的介面在幾個地方拖慢了這件事：

- 想「接續最近做的事」時，得先想到是哪個專案，再展開對應分群才看得到——分群是以專案為單位排序，不是以「全站最近活動」為單位。
- 分群卡片標題常常只是 session 的第一句話（甚至有 28% 的比例根本找不到真實標題，退而顯示「資料夾名+時間戳記」），跟真正的對話內容混在一起看不出差別。
- 複製「接續指令」按鈕點下去沒有任何回饋，不確定是否真的複製成功。
- 如果專案資料夾已經被刪除或不在這台電腦上，儀表板仍然正常顯示、正常給接續按鈕，貼上去執行才會發現路徑早就不存在。
- 只有亮色主題，夜間使用吃力。
- 同時使用 Claude Code 與 Codex，卡片上只用文字前綴分辨工具來源，掃視速度慢。

## Solution

在既有的單一自包含 HTML 儀表板上做兩層資訊架構調整，並補齊幾個可靠性/回饋缺口：

1. 新增頂部「接續快速區」：不分專案、平面顯示全站最新 8 筆「路徑仍存在」的 session，完全獨立於搜尋／篩選，作為固定的「回顧剛剛」錨點。
2. 下方既有的手風琴摺疊分群區，重新定位為「專案樹」：檔案總管式縮排（專案節點→路徑子節點→時間區間→session），預設全部收合，職責變成純粹依專案查找舊 session。
3. 幫「不可靠」的資訊加上明顯的視覺標記：退而標題（灰階／斜體）、失效路徑（警告標籤＋灰階化，且不進入接續快速區的挑選）。
4. 工具來源改用色塊標記；複製按鈕加短暫「已複製✓」回饋；卡片新增點擊展開的預覽（第一則＋最後一則使用者訊息前幾行），套用在接續快速區與專案樹兩邊。
5. 新增自動跟隨系統偏好的深色模式。全部以純 CSS／Unicode 字元／emoji 實作，不引入任何外部資源，維持現有零依賴、單檔部署的架構。

詳見 `CONTEXT.md`（接續快速區、專案樹、專案節點、雜項、退而標題、失效路徑等詞彙定義）與 `docs/adr/0001~0003`（三項不易回頭的架構決策）。

## User Stories

1. As a 使用者剛關掉 Claude Code，I want 一打開儀表板就在最上方看到最近用過的幾筆 session，so that 我不用先想到專案再去分群裡找。
2. As a 正要接續 session 的使用者，I want 複製指令按鈕有明確的「已複製」回饋，so that 我確定貼上去的指令是有效的、剛複製好的。
3. As a 想找某個特定專案舊紀錄的使用者，I want 專案樹預設全部收合，so that 一進來就是乾淨的專案名稱清單，不被展開的卡片干擾。
4. As a 展開了雜項這種很多筆的分群的使用者，I want 裡面依時間區間（今天/昨天/本週/更早）分組，so that 一大堆卡片裡能快速定位大致多久之前的那一筆。
5. As a 不確定卡片標題是不是真實對話內容的使用者，I want 退而標題（資料夾名+時間戳）有明顯的視覺區隔，so that 我不會誤把代用名稱當成真實摘要。
6. As a 正要點接續按鈕的使用者，I want 知道這個 session 的專案資料夾是否已經不在這台電腦上，so that 我不會浪費一次注定失敗的接續。
7. As a 只有 8 個接續快速區名額的使用者，I want 路徑已失效的 session 不佔用這 8 個名額，so that 快速區裡的每一筆都能直接用。
8. As a 同時用 Claude Code 與 Codex 的使用者，I want 工具來源用色塊而非純文字標記，so that 我不用逐字讀就能一眼分辨。
9. As a 不確定卡片是不是自己要找的那個 session 的使用者，I want 點擊展開看到第一則與最後一則使用者訊息的前幾行，so that 我能在接續前多一層確認。
10. As a 晚上使用這個工具的使用者，I want 儀表板自動跟著系統偏好切換深色模式，so that 不需要手動切換、也不會太刺眼。
11. As a 重視離線可靠性的使用者，I want 儀表板維持零外部依賴的單一 HTML 檔案，so that 不管有沒有網路都能立刻打開。
12. As a 專案曾經跨磁碟機搬移過的使用者，I want 同名專案仍聚合在同一個專案節點下（沿用既有行為，不因這次改版而改變），so that 專案樹不會因為搬移紀錄而分裂成看不出關聯的區塊。
13. As a 刪除過舊專案的使用者，I want 那些 session 的歷史紀錄還是看得到（不被靜默隱藏），但清楚標示不能直接接續，so that 我不會失去歷史紀錄、也不會被誤導。
14. As a 正在搜尋框打字的使用者，I want 頂部接續快速區維持不變、不跟著搜尋結果變動，so that 它能穩定當作「剛剛做了什麼」的固定參考點。
15. As a 已經點開某個專案樹節點的使用者，I want 該節點下的所有 session 一次顯示完、不分頁，so that 我不用因為額外的分頁點擊而中斷本來就是要看完整歷史的意圖。
16. As a 瀏覽接續快速區的使用者，I want 那裡的卡片維持精簡（專案名/標題/最後互動時間/接續按鈕），so that 這個錨點區塊本身不會因為資訊過多而變得雜亂。
17. As a 點擊卡片預覽切換的使用者，I want 展開時只往下推擠版面、不放大或彈出，so that 瀏覽多張卡片時畫面不會忽大忽小、不好抓視覺焦點。
18. As a 想看到「最後停在哪裡」的使用者，I want 「最後一則使用者訊息」是真的來自對話尾端而不是開頭窗口裡湊出來的，so that 這個資訊在長 session 上仍然有意義。
19. As a 維護這個 codebase 的人，I want 退而標題與失效路徑判斷直接內建在既有的 `scanClaudeCodeFile`/`scanCodexFile` 裡，而不是另外包一層抽象，so that 程式碼不會為了這次改版多長出不必要的接縫。

## Implementation Decisions

### 資料層：`scanClaudeCodeFile` / `scanCodexFile`（既有接縫，擴充回傳欄位）

- 新增 `titleIsFallback: boolean`：目前用 `extractClaudeTitle(...) || fallback字串` 的寫法隱式判斷退而標題；改為先把 `extractClaudeTitle(...)`／`extractCodexTitle(...)` 的結果存成變數，再據此同時決定 `title` 與 `titleIsFallback`，避免重複呼叫。
- 新增 `pathExists: boolean`：對 `effectiveCwd`（Claude Code）／`cwd`（Codex）各執行一次 `fs.existsSync`。不做去重快取——260 筆 session 對應約 24 個不重複路徑，逐筆檢查的效能成本可忽略，不需要額外的批次/快取機制。
- 新增 `firstMessagePreview: string | null`：沿用既有 `readFirstJsonLines(filePath, 20)` 已讀取的範圍，取其中第一則被判定為非 synthetic（`isSyntheticClaudeText`/`isSyntheticCodexText` 判定為 false）的使用者訊息前幾行（建議 3~5 行，實作時可與 `extractClaudeTitle`/`extractCodexTitle` 共用同一套「跳過注入內容找真實訊息」的邏輯，只是保留多行而非單行）。找不到則為 `null`。
- 新增 `lastMessagePreview: string | null`：需要新接縫 `readLastJsonLines(filePath, n)`（見下方），從檔案尾端往回找同樣被判定為非 synthetic 的最後一則使用者訊息。找不到則為 `null`。
- 不引入依賴注入或新的檔案系統抽象層；沿用現有直接呼叫 `fs`/`os`/`path` 模組的風格。

### 新接縫：`readLastJsonLines(filePath, n)`

- 鏡射既有 `readFirstJsonLines` 已解決的問題：用 `fs.openSync`/`fs.readSync` 以固定大小區塊（沿用相同的 64KB 區塊大小）從檔案**尾端**往前讀，累積原始 `Buffer`（不是字串），只在確定落在完整行邊界（`0x0a`）時才切割、解碼成 UTF-8，避免多位元組字元被區塊邊界切斷。
- 回傳最後 `n` 行可解析的 JSON 記錄，順序與檔案中的原始順序一致（由舊到新）。
- 供 `scanClaudeCodeFile`/`scanCodexFile` 呼叫，取得檔案尾端的記錄後，用既有的 synthetic 過濾邏輯往前找真正的最後一則使用者訊息。

### `buildHtml(sessions, meta)`（既有接縫，主要改版承載處）

**接續快速區**（新增，`#quick-resume`，頁面最上方）
- 從 `sessions` 中排除 `pathExists === false` 者，依 `lastActiveAt` 新到舊排序，取前 8 筆，平面顯示（不分專案分組）。
- 渲染邏輯完全不讀取搜尋框／分類／工具／時間範圍的篩選 state（ADR-0001）；獨立於 `render()` 既有的篩選流程之外，各自维护。
- 卡片精簡型：`displayName`、`title`、`lastActiveAt`、接續按鈕。不顯示 branch／`startedAt`／完整 `cwd`。
- 支援點擊展開預覽（見下方）。

**專案樹**（既有分群手風琴摺疊區重構，ADR-0003）
- 階層：專案節點（依 `displayName` 聚合）→ 路徑子節點（僅當同一專案節點下有多個 `groupKey` 時才出現）→ 時間區間（今天／昨天／本週／更早，依 `lastActiveAt` 分類）→ session 卡片。
- 沿用既有 `<details>/<summary>` 語意；視覺上加強縮排、連接線、展開/收合圖示的「樹狀感」，純 CSS 實作，不用 canvas/SVG。
- 移除現行「預設展開最近 5 組」邏輯（`DEFAULT_EXPANDED_CLUSTER_COUNT`／`searchTerm.length > 0` 那段判斷），所有節點含雜項一律預設 `open = false`。
- 單一節點展開後不分頁、全部顯示，但依時間區間分組。
- 雜項節點沒有路徑子節點這一層，直接是「雜項節點 → 時間區間 → session」。

**可靠性視覺標記**
- `titleIsFallback === true`：標題文字改用灰階＋斜體樣式（沿用現有 `.meta` 灰階色 `#888`／`#666` 的既有配色邏輯，不用另外發明新顏色）。
- `pathExists === false`：卡片加上警告標籤（文字例如「資料夾已不存在」）＋卡片整體降低對比（灰階化），但保留卡片本身與複製按鈕（複製出來的指令仍會失敗，但不隱藏歷史紀錄——見 user story 13）。

**工具來源色塊**
- 每張卡片加一個小色塊／文字徽章，`tool === 'claude-code'` 與 `tool === 'codex'` 各自固定一種顏色，取代目前 `'[' + s.tool + '] '` 純文字前綴。純 CSS 實作。

**複製回饋**
- 現有 `btn.addEventListener('click', ...)` 內，在 `navigator.clipboard.writeText(cmd)` 之後把 `btn.textContent` 暫時改成「已複製✓」，用 `setTimeout` 於 1~2 秒後恢復原文字。不引入額外 DOM 元素或通知元件。

**點擊展開預覽**
- 卡片新增一個可點擊的預覽切換區（例如卡片本身或一個小箭頭），點擊後在卡片內展開顯示 `firstMessagePreview` 與 `lastMessagePreview`（各自標明是「開始」還是「最後」），再點一次收起。
- 套用在接續快速區與專案樹兩邊的卡片。
- 展開/收起只會推擠版面（沿用 `<details>` 的自然行為或等效的 DOM 顯示切換），不做 hover 浮層、不做彈窗/popover。

**深色模式**
- 新增 `@media (prefers-color-scheme: dark)` CSS 區塊，涵蓋所有既有與新增的視覺元素（卡片、標記、色塊、樹狀縮排線、接續快速區）。純 CSS，不需要 JS 或手動切換按鈕。

**零外部依賴**（ADR-0002）
- 以上所有視覺元素都用純 CSS／Unicode 字元／emoji 實作，綔在單一 HTML 檔案內的既有 `<style>`/`<script>` 區塊，不引入任何 CDN 資源。

## Testing Decisions

- 只測外部可觀察行為（渲染出的 DOM 結構、資料欄位值），不測實作細節（例如不斷言用了哪個 CSS class 名稱本身，除非那是驗證渲染正確性唯一可行的方式，例如驗證退而標題/失效路徑真的套用了不同樣式時，可以合理斷言 class 名稱存在）。
- `scanClaudeCodeFile`/`scanCodexFile` 新欄位：沿用既有的「真實暫存目錄」測試手法（`makeTempDir`/`fsForTests`），不 mock `fs`。
  - `pathExists`：建立一個真的存在的暫存目錄（預期 `true`）與一個刻意指向不存在路徑的情境（預期 `false`）。
  - `titleIsFallback`：延用既有測試中「有真實標題」與「找不到標題退回資料夾名+時間戳」兩種既有情境，新增對 `titleIsFallback` 欄位的斷言。
  - `firstMessagePreview`/`lastMessagePreview`：比照現有 synthetic-content 過濾測試的寫法（例如已有的 AGENTS.md 注入內容真實案例），驗證能正確跳過注入內容找到真實訊息，以及全部都是注入內容時回傳 `null`。
- `readLastJsonLines`：比照既有 `readFirstJsonLines` 的測試（`src/session-dashboard.test.js` 中已有的 UTF-8 chunk-boundary 測試），新增一個「跨區塊邊界的多位元組字元不被切壞」的對應測試，只是驗證方向是從檔尾算起。
- `buildHtml` 新行為：延用手風琴摺疊功能時新建的 `runDashboardScript`（`node:vm` + 最小 DOM stub，見 `src/session-dashboard.test.js` 中 `makeFakeElement`/`runDashboardScript`）執行內嵌 `<script>`，斷言：
  - 接續快速區只含 8 筆、不含 `pathExists === false` 的項目、且不受 `search`/`category-filter`/`tool-filter`/`range-filter` 控制項的值影響。
  - 專案樹所有節點預設 `open === false`（含雜項）。
  - 同一節點展開後依時間區間分組、且不分頁全部顯示。
  - `titleIsFallback`/`pathExists` 為 true 時，對應的樣式標記（class 或文字警告）存在。
  - 複製按鈕點擊後文字暫時變成「已複製✓」。
  - 預覽切換點擊後正確顯示/隱藏 `firstMessagePreview`/`lastMessagePreview`。
- 深色模式：屬於靜態 CSS，不易用 DOM 執行測試斷言視覺效果，比照現行 `buildHtml` 對 CSS 的字串測試慣例，改用字串檢查確認 `@media (prefers-color-scheme: dark)` 區塊存在於產出的 HTML。
- Prior art：`src/session-dashboard.test.js` 中的 `runDashboardScript`/`makeFakeElement`（手風琴摺疊功能新增）、`readFirstJsonLines` 的 UTF-8 chunk-boundary 測試、`isSyntheticClaudeText`/`isSyntheticCodexText` 的真實注入內容測試、`scanClaudeCode groups a home-directory session as misc...` 等既有真實暫存目錄測試。

## Out of Scope

- 節點連線圖（node-link diagram）視覺形式——已透過 ADR-0003 決定不做。
- 手動切換深色/淺色模式的按鈕——只做自動跟隨系統偏好。
- 專案樹節點內部的分頁／「顯示更多」按鈕——已決定不限制筆數。
- 28% session 標題退回顯示「資料夾名+時間戳」的根本解法（例如擴大掃描範圍找到更多真實標題）——這次只處理「視覺上標記讓使用者分辨」，不處理「怎麼找到更多真實標題」，那是獨立、尚未解決的問題。
- 鍵盤快捷鍵（例如 focus 搜尋框的「/」快捷鍵）——這次訪談沒有討論到。
- 接續快速區筆數（8）、專案樹內部無分頁上限等數字之外的可調整設定——目前寫死為常數，不做成使用者可調整的選項。
- 針對 `~/.claude/scripts/session-dashboard.js` 以外環境（例如非 Windows、非 PowerShell）的相容性調整——不在這次範圍內。

## Further Notes

- 全部決策記錄於 repo 根目錄 `CONTEXT.md`（詞彙定義：接續快速區、專案樹、專案節點、雜項、退而標題、失效路徑）與 `docs/adr/0001~0003`（三項不易回頭的架構決策：接續快速區獨立於篩選、零外部依賴、專案樹縮排而非節點連線圖）。實作與審查時請沿用這些用詞，不要另創同義詞。
- 這是對既有、已部署到 `~/.claude/scripts/session-dashboard.js` 的儀表板的迭代改版，不是全新專案。完成後需要重新部署並在真實資料／瀏覽器上肉眼驗證（沿用本專案一貫的「不只信任單元測試」慣例，過程記錄於 `docs/deploy-log.md`）。
- `readLastJsonLines` 是這次唯一真正新增的接縫（其餘都是既有接縫的欄位擴充），來源是「最後一則使用者訊息預覽」這個需求逼出來的必要技術缺口，已在訪談中與使用者確認過取捨（見本 spec 對應的對話紀錄）。
