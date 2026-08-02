# 01 — 退而標題可靠性標記

**What to build:** 使用者在儀表板上瀏覽卡片時，能夠一眼分辨這筆 session 的標題是「真實對話開場白」還是「找不到真實標題、退而用資料夾名稱+建立時間戳記湊出來的代用名稱」，不會誤把代用名稱當成真實摘要。

**Blocked by:** None — can start immediately

- [x] `scanClaudeCodeFile`／`scanCodexFile` 回傳的 session 物件新增 `titleIsFallback: boolean` 欄位：找到真實標題（`extractClaudeTitle`／`extractCodexTitle`／Codex index 名稱）時為 `false`，退回「資料夾名稱＋建立時間戳記」湊成的標題時為 `true`
- [x] `titleIsFallback` 的判斷不重複呼叫標題擷取邏輯（先存結果再分岔決定 `title` 與 `titleIsFallback`）
- [x] `buildHtml` 渲染卡片時，`titleIsFallback === true` 的標題以灰階＋斜體樣式呈現，與真實標題在視覺上明顯區隔
- [x] 有真實標題與退回代用標題兩種情境都有對應測試，斷言 `titleIsFallback` 值正確
- [x] 透過既有的 DOM 執行測試手法（`node:vm` + 最小 DOM stub）驗證渲染出的卡片確實套用了區隔樣式
- [ ] 部署後在真實資料／瀏覽器上肉眼確認：至少一筆已知退而標題的卡片顯示灰階斜體，至少一筆真實標題的卡片維持正常樣式（本次未開啟瀏覽器操作，僅以 `--quiet` 重新產生並用字串檢查確認 titleIsFallback:true/false 與 title-fallback class 皆存在於產出的 HTML，尚待人工肉眼確認）
