# 08 — 訊息預覽功能

**What to build:** 使用者不確定某張卡片是不是自己要找的那個 session 時，可以點擊展開，看到這個 session 第一則與最後一則使用者訊息的前幾行，藉此在接續前多一層確認；再點一次收起，不會影響其他卡片的版面。這個功能在接續快速區與專案樹兩邊的卡片都能用。

**Blocked by:** 06（專案樹卡片需存在）、07（接續快速區卡片需存在）——預覽要同時掛在這兩處的卡片上

- [x] 新增一個從檔案尾端往回讀取的函式，鏡射既有「從檔頭往前讀」函式已解決的問題：用固定大小區塊從檔尾讀取、累積原始位元組、只在確定落在完整行邊界時才切割解碼成 UTF-8，避免多位元組字元被區塊邊界切斷
- [x] `scanClaudeCodeFile`／`scanCodexFile` 回傳的 session 物件新增 `firstMessagePreview: string | null` 與 `lastMessagePreview: string | null` 兩個欄位
  - `firstMessagePreview`：沿用既有檔頭讀取範圍內第一則被判定為非注入內容（synthetic）的使用者訊息前幾行
  - `lastMessagePreview`：用新增的檔尾讀取函式，取得檔案尾端記錄後，找最後一則被判定為非注入內容的使用者訊息前幾行
  - 兩者都找不到真實訊息時為 `null`
- [x] 卡片新增一個可點擊展開/收起的預覽區塊：展開時分別標示「開始」與「最後」，顯示 `firstMessagePreview`／`lastMessagePreview`；再點一次收起
- [x] 套用在接續快速區與專案樹兩邊的卡片
- [x] 展開/收起只會讓卡片本身往下推擠版面，不做放大、hover 浮層或彈出視窗；且不影響其他卡片的大小或位置
- [x] 新增檔尾讀取函式的 UTF-8 跨區塊邊界正確切割測試（比照既有檔頭讀取函式的對應測試）
- [x] 新增測試驗證 `firstMessagePreview`／`lastMessagePreview` 能正確跳過注入內容找到真實訊息，以及全部都是注入內容時回傳 `null`
- [x] 透過既有的 DOM 執行測試手法驗證：點擊預覽切換後正確顯示/隱藏兩則訊息預覽，且不影響其他卡片
- [ ] 部署後在真實資料／瀏覽器上肉眼確認：找一筆內容較長的 session，展開預覽後「最後一則」確實是接近該 session 結尾的內容，而不是跟「第一則」幾乎一樣
  - 資料層級部分已完成（見 `docs/deploy-log.md` 對應條目）：直接讀取部署後的 `sessions-dashboard.html` 內嵌 `DATA`，挑一筆跨度 674 小時的真實 Codex session，`firstMessagePreview`/`lastMessagePreview` 確實是主題完全不同的兩段內容，證實 `lastMessagePreview` 真的來自對話尾端而非開頭窗口。
  - 瀏覽器上實際點擊展開、肉眼確認 UI 互動行為這部分尚未執行，維持未勾選。

## 上線後修正（見 `docs/deploy-log.md` 2026-08-03 條目）

實際使用後發現本票原始設計有 bug：檔頭固定讀 20 筆一次性重複用於標題擷取與 `firstMessagePreview`，遇到 skill 呼叫等雜訊會把真實訊息擠出 20 筆窗口外，導致明明有內容卻顯示「無」（真實案例 `def4a233-...`）。修正為「找不到才逐步擴大檔頭讀取窗口（20→60→180→500）」，並讓 `lastMessagePreview`（僅此欄位，不含標題與 `firstMessagePreview`）改為接受使用者或 agent 任一方的最後一則真實訊息。詳見 deploy-log 對應條目。
