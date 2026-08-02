# 02 — 失效路徑可靠性標記

**What to build:** 使用者在點擊「接續」前，能夠看出這筆 session 對應的專案資料夾在這台電腦上是否還存在，不會浪費一次注定失敗的接續（貼上去執行才發現路徑早就不存在）。歷史紀錄本身仍然保留、不被隱藏。

**Blocked by:** None — can start immediately

- [x] `scanClaudeCodeFile`／`scanCodexFile` 回傳的 session 物件新增 `pathExists: boolean` 欄位：對該 session 記錄的專案路徑（Claude Code 是 `effectiveCwd`，Codex 是 `cwd`）執行一次 `fs.existsSync`
- [x] 不引入任何快取或去重批次機制——逐筆檢查即可，不需要額外的效能優化
- [x] `buildHtml` 渲染卡片時，`pathExists === false` 的卡片加上明顯的警告標籤（例如「資料夾已不存在」文字）並整體降低視覺對比（灰階化）
- [x] 即使 `pathExists === false`，卡片本身與複製接續指令按鈕仍然保留、可以正常點擊（不隱藏、不停用）
- [x] 用既有的真實暫存目錄測試手法，分別對「路徑確實存在」與「路徑刻意指向不存在的位置」兩種情境驗證 `pathExists` 值正確
- [x] 透過既有的 DOM 執行測試手法驗證渲染出的卡片確實套用了警告標籤與灰階樣式
- [ ] 部署後在真實資料／瀏覽器上肉眼確認：至少找一筆已知路徑不存在的 session（或用暫存資料模擬）顯示警告，其餘正常 session 不受影響
      （未勾選原因：僅能以字串比對方式驗證真實產出的 sessions-dashboard.html——確認其中 18 筆 session 的 `"pathExists":false`、262 筆 `"pathExists":true`，且 `card-path-missing`／「資料夾已不存在」字樣確實出現在產出的 HTML 中；未實際開瀏覽器肉眼確認渲染畫面，需使用者自行以瀏覽器確認。）
