# 03 — 工具來源色塊標記

**What to build:** 同時使用 Claude Code 與 Codex 的使用者，掃視卡片時不用逐字閱讀文字前綴就能一眼分辨這筆 session 來自哪個工具。

**Blocked by:** None — can start immediately

- [x] 卡片上原本的純文字前綴（例如 `[claude-code] ...`）改為（或加上）一個小色塊／徽章，`tool === 'claude-code'` 與 `tool === 'codex'` 各自固定一種顏色 — 保留原文字前綴，於標題 div 內加上 `<span class="tool-badge tool-badge-claude-code|codex">` 色塊
- [x] 純 CSS 實作，不引入外部圖示庫或字型（沿用零外部依賴原則） — 僅新增 `.tool-badge`／`.tool-badge-claude-code`／`.tool-badge-codex` 三條 CSS 規則
- [x] 淺色與深色模式下（若深色模式尚未實作，先確保淺色模式本身對比清楚、可辨識）色塊都清楚可辨識，不依賴顏色以外唯一的辨識方式過度（例如仍保留文字說明，不是純靠顏色分辨） — 橙 `#d97706` vs 藍 `#2563eb`，淺色卡片背景下對比明顯且加了淡邊框；文字前綴 `[claude-code]`/`[codex]` 維持不變，滿足非純色辨識要求；深色模式為未來獨立 ticket，本輪不處理
- [x] 透過既有的 DOM 執行測試手法驗證 `claude-code` 與 `codex` 兩種 session 渲染出不同的色塊／徽章樣式 — 新測試 `buildHtml renders a distinct tool-badge class for claude-code vs codex sessions`
- [ ] 部署後在真實資料／瀏覽器上肉眼確認：混合 Claude Code 與 Codex 的卡片列表中，兩種工具來源清楚可辨識 — 未執行：本輪維持 `--quiet` 不開瀏覽器操作真實資料；已用字串比對確認真實產出 HTML 中 47 筆 claude-code／233 筆 codex session 與三條色塊 CSS 規則均存在，實際視覺呈現留待人工開瀏覽器確認
