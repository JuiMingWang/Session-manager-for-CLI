# 03 — 工具來源色塊標記

**What to build:** 同時使用 Claude Code 與 Codex 的使用者，掃視卡片時不用逐字閱讀文字前綴就能一眼分辨這筆 session 來自哪個工具。

**Blocked by:** None — can start immediately

- [ ] 卡片上原本的純文字前綴（例如 `[claude-code] ...`）改為（或加上）一個小色塊／徽章，`tool === 'claude-code'` 與 `tool === 'codex'` 各自固定一種顏色
- [ ] 純 CSS 實作，不引入外部圖示庫或字型（沿用零外部依賴原則）
- [ ] 淺色與深色模式下（若深色模式尚未實作，先確保淺色模式本身對比清楚、可辨識）色塊都清楚可辨識，不依賴顏色以外唯一的辨識方式過度（例如仍保留文字說明，不是純靠顏色分辨）
- [ ] 透過既有的 DOM 執行測試手法驗證 `claude-code` 與 `codex` 兩種 session 渲染出不同的色塊／徽章樣式
- [ ] 部署後在真實資料／瀏覽器上肉眼確認：混合 Claude Code 與 Codex 的卡片列表中，兩種工具來源清楚可辨識
