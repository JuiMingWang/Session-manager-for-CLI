# 設計：`sessdash://` 協議新增第三個 action（`resume`）

## 背景與問題

`sessdash://` 協議（見 `docs/design/2026-08-04-protocol-handler-for-hide-rename.md`，已審查通過並部署上線）目前只涵蓋「隱藏」「改名」兩個按鈕。「複製續接指令」按鈕（開啟/繼續某個 session）當初刻意不在那份設計的範圍內，維持原本「複製一段 PowerShell 指令到剪貼簿，使用者自己貼到終端機執行」的做法。

使用者希望續接也能省略複製貼上這一步，比照隱藏/改名的規格（含 codex-peer-review）處理。這份文件只處理新增的 `resume` action，**不重新設計**已經審查通過的權杖驗證、登錄檔所有權標記、URI 解析框架——那一整套機制原封不動沿用，這裡只新增第三個分支。

## 跟隱藏/改名的關鍵差異：這次會真的啟動一個新程式

隱藏/改名的 `--handle-uri` 處理，本質是「靜默寫一個檔案或 append 一行，寫完就結束」。續接完全不同：**要打開一個看得見、可互動的終端機視窗**，讓使用者能在裡面繼續打字對話——這代表 `--handle-uri` 第一次需要呼叫 `child_process.spawn` 去啟動一個新的、跟自己分離（detached）的 PowerShell 行程，而不只是讀寫檔案。

這帶來一個隱藏/改名完全不需要考慮的風險類別：**外部網址觸發的輸入，這次會被組進一段真的會被執行的 PowerShell 指令字串**，不是只拿去比對或寫進資料檔案。

## URI 格式

```
sessdash://resume?tool=<tool>&id=<id>&cwd=<url-encoded>&token=<token>
```

- `PROTOCOL_ACTIONS` 從 `['hide', 'rename']` 擴充為 `['hide', 'rename', 'resume']`。
- `resume` 必要參數：`tool`、`id`、`cwd`（沿用既有 `singleParam` 的「剛好出現一次、非空字串」檢查，跟 `rename` 的 `title`同一套邏輯）。
- 沒有新的參數編碼規則——`cwd` 一律用 `encodeURIComponent` 跳脫，跟現有 `title` 一致，處理端一律用 `URLSearchParams` 解析。

## 安全設計：`id` 需要比隱藏/改名更嚴格的字元限制

隱藏/改名對 `id` 的驗證只到「非空、剛好出現一次」——這在那兩個情境下是安全的，因為 `id` 只被拿去當檔名比對（`findClaudeSessionFilePath`）或寫進 JSON 欄位（`renameCodexSession`），從來不會被解讀成程式碼。

**`resume` 不能沿用這個寬鬆度**：續接指令的組成方式是 `(tool === 'codex' ? 'codex resume' : 'claude --resume') + ' ' + id`（沿用既有、已測試的 `buildResumeCommand`），`id` 會被直接接在一段之後會被 `powershell.exe -Command` 執行的字串裡，**沒有經過任何跳脫**（`buildResumeCommand` 目前的設計就是不跳脫 `sessionId`——過去這個函式的呼叫來源只有「使用者自己複製貼上」這一種，`sessionId` 一定是內部信任的值；現在要讓外部網址也能觸發同一個函式，這個歷史假設不再成立）。

修正：`parseAndValidateProtocolUri` 只在 `action === 'resume'` 這個分支，額外對 `id` 做嚴格字元允許清單檢查：

```js
const SAFE_RESUME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
```

真實的 `id`（Claude Code 是 `.jsonl` 檔名去掉副檔名、Codex 是 `session_index.jsonl` 裡的 `id` 欄位或檔名）在正常情況下都是這個範圍內的 UUID 字串，UUID 本身第一個字元永遠是十六進位數字，不會是連字號。不符合這個範圍的一律拒絕，不嘗試猜測「差不多安全」的字元。**這個限制只加在 `resume` 分支**，不動隱藏/改名既有的驗證邏輯——那兩個已經審查通過，沒有理由因為這次新增而重新收緊，也避免無謂擴大這次改動的範圍。

**第一輪 codex-peer-review 抓到一個純用字元黑名單想不到的問題**：光排除 shell metacharacter 不夠——`^[A-Za-z0-9_-]+$` 仍然容許 `id` 開頭就是連字號（例如 `--help`），組出 `claude --resume --help` 這種指令時，`--help` 會被底層 CLI 的參數解析器當成一個選項旗標，不是位置參數，導致執行的是完全不同的行為（顯示說明文字，或該 CLI 剛好有其他更嚴重副作用的旗標），不是「字元不安全」而是「格式合法但語意被劫持」。修正：規定**開頭必須是英數字**，禁止 `id` 以連字號開頭，排除掉「被解讀成 CLI 選項」的可能性。

`cwd` 不需要額外的字元限制：它會經過既有、已測試過的 `escapePowerShellSingleQuoted`（`buildResumeCommand` 內部已在用），並放進 PowerShell 的 `-LiteralPath '...'` 單引號字面值——這正是這個函式當初設計要處理的情境（測試已涵蓋含 `$`、反引號、單引號的路徑），不需要為了這次新增再收緊。

## 指令組成：重用 `escapePowerShellSingleQuoted`，但不逐字重用 `buildResumeCommand`

`session-dashboard.js` 已經有一個獨立、已測試的 `buildResumeCommand(tool, cwd, sessionId)`（`Set-Location -LiteralPath '<跳脫過的 cwd>'; <resume 指令> <id>`）。**原本這裡打算直接重用它**，但第一輪 codex-peer-review 指出一個它目前沒處理、但 `resume` action 必須處理的情況（見下一節）。修正後 `resume` action 用同一個 `escapePowerShellSingleQuoted` 組出**自己的**指令字串，`cwd` 跳脫邏輯仍跟 `buildResumeCommand` 完全一致（同一個函式），只有 `Set-Location` 那一段的錯誤處理方式不同——**不修改 `buildResumeCommand` 本身**：它是既有、已部署、已審查通過的複製指令功能在用的函式，這次的新問題只在「協議觸發、無人看著執行過程」這個新情境下才成立，不動它可以避免無謂影響既有的複製貼上流程，也不用重新驗證那條已核准的路徑。

```js
function buildResumeCommandForProtocol(tool, cwd, sessionId) {
  const cmd = tool === 'codex' ? 'codex resume' : 'claude --resume';
  const safeCwd = escapePowerShellSingleQuoted(cwd);
  return `Set-Location -LiteralPath '${safeCwd}' -ErrorAction Stop; ${cmd} ${sessionId}`;
}
```

## 啟動終端機：`spawn('cmd.exe', ['/c', 'start', ...])`——實測直接 spawn `powershell.exe` 開不出真正互動的視窗

**這節是修正過的結論，過程記錄下來避免以後重踩同一個坑。**

最初的想法是直接呼叫 `powershell.exe`，刻意避開 `cmd.exe /c start`（理由：`cmd.exe`／`start` 對 `&`、`|`、`%`、`^` 等字元有自己一套跟一般 argv 不同的解析規則，看起來是不必要的攻擊面）。**這個判斷沒有實測過，寫這份文件的當下直接在真機上驗證了兩種做法，結果推翻了最初的選擇**：

- `spawn('powershell.exe', ['-NoExit', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: false })`：行程在 2 秒內就自動消失，`-Command` 裡的第一行都沒執行到（用寫入標記檔驗證），`stdio` 改成預設的 `'pipe'` 結果一樣。原因：`detached` 在 Windows 上確實會配置一個新的 console，但 `stdio` 導向 NUL（或 unref 後管線被關閉）會讓 PowerShell 認為輸入已經結束，`-NoExit` 救不回一個「認定輸入已經 EOF」的互動迴圈。
- `spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: false })`：視窗確實開啟、確實存活、確實可互動，`-Command` 內容確實執行（標記檔正確寫入）。額外測試了含 `&`、`%NAME%`、`^caret` 的資料夾路徑（模擬最壞情況的 `cwd`）——透過 Node 的 argv 陣列傳給 `cmd.exe`（不是自己組字串再丟給 shell 解析）時，完整字串（含反斜線、含 metacharacter）逐字保留。

**第二輪 codex-peer-review 指出上一輪的測試不夠嚴謹**：`%NAME%` 之所以沒被展開，是因為它不是一個真的存在的環境變數；`cmd.exe` 對「已定義」的環境變數（例如 `%USERNAME%`）就算包在雙引號裡，一樣會展開，這是 `cmd.exe` 本身有文件記載的行為，跟這次呼叫方式是不是陣列傳參無關。**實測驗證了這個問題確實存在**：把 `cwd` 換成一個路徑名稱字面上含有 `%USERNAME%` 這幾個字元（不是真的想引用環境變數，只是資料夾名稱剛好長這樣）丟進同一條呼叫鏈，標記檔案裡看到的是被展開成真實使用者名稱後的路徑，不是原始字面文字——代表任何 `cwd` 只要剛好含有跟某個已定義環境變數同名的 `%...%` 片段，就會被 `cmd.exe` 悄悄改寫成別的路徑，不是我們原本以為的「只要陣列傳參就不會被 `cmd.exe` 動手腳」。

修正：**不用 `-Command` 傳純文字，改用 `-EncodedCommand` 傳 UTF-16LE Base64**——PowerShell 指令字串先組好（`escapePowerShellSingleQuoted` 跳脫 `cwd`、`-ErrorAction Stop` 都在這一步做完），再整段轉成 Base64 之後才交給 `cmd.exe`。Base64 只包含英數字與 `+`、`/`、`=`，`cmd.exe` 沒有任何字元需要展開、沒有引號要重新配對、沒有空白需要跳脫——不是「把每一種危險字元都想過一輪並跳脫」，而是讓整段內容在結構上就不含 `cmd.exe` 認得的任何特殊字元，`cmd.exe` 那一層的解析風險直接歸零，不需要持續列舉「還有沒有漏掉哪個字元」。**同樣用含 `%USERNAME%` 字面文字的 `cwd` 重新實測**，這次標記檔案裡的內容是未被展開的原始字面文字，確認修正有效；期間也確認新開的 PowerShell 視窗一樣正常存活、可互動。

修正後的實作：

```js
function resumeSession(tool, id, cwd, spawnFn, logPath) {
  const command = buildResumeCommandForProtocol(tool, cwd, id);
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const child = spawnFn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-EncodedCommand', encodedCommand], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', (err) => {
    appendProtocolLog(logPath, `resume spawn failed: ${err.message}`);
  });
  child.unref();
}
```

- `-EncodedCommand` 是 PowerShell 內建、文件記載的參數，接受 UTF-16LE 編碼後的 Base64 字串，解碼後當成一般 `-Command` 腳本執行——語意跟 `-Command` 一致，只是傳遞方式對中間層（`cmd.exe`）是不透明的。
- `'""'` 是 `start` 命令的空視窗標題參數——`start` 把第一個帶引號的參數當標題，不給的話它會把 `powershell.exe` 誤判成標題、真正的程式變成第二個參數而執行失敗，這是 `start` 本身的既有慣例，不是這次新發明的技巧。
- `-NoExit`：resume 指令跑完（或中途出錯）之後視窗留著，使用者能繼續在裡面互動，不會一閃而過。
- `detached: true` + `stdio: 'ignore'` + `unref()`：跟現有「零常駐行程」哲學一致——`--handle-uri` 這個 node 行程本身完成後照樣立刻結束；`unref()` 是關鍵，沒有它 node 事件迴圈會因為子行程的 handle 而不結束，變相多了一個一直存在的背景行程。這裡的子行程是 `cmd.exe /c`，它本身會在 `start` 把視窗交出去之後立刻結束（**會有一個 `cmd.exe` 視窗閃一下就消失的正常現象**，這是 `start` 這個機制本身的行為，不是 bug）。
- 刻意**不用**既有 `execProtocolCommand`（`execFileSync`）— 那是「同步執行、等它結束、拿結果」的模式，用在 `reg.exe`（跑完立刻回傳、沒有互動視窗）正合適；`resume` 要開一個「不等它結束、使用者會一直用下去」的互動視窗，語意完全不同，用 `spawn` 而非 `execFileSync` 是必要的，不是隨意換一個函式。

## `cwd` 不存在時怎麼辦：交給使用者在終端機裡自己看到，不用額外機制

`cwd` 對應的資料夾可能已經被搬移或刪除（既有的 `pathExists` 欄位就是為了這個情況存在，卡片本身已經有「資料夾已不存在」的警告）。這裡刻意**不**在 `--handle-uri` 端額外檢查 `cwd` 是否存在：

- 如果不存在，`Set-Location -LiteralPath '<cwd>' -ErrorAction Stop` 會在**已經打開、使用者看得到**的 PowerShell 視窗裡失敗，印出 PowerShell 自己的原生錯誤訊息，`-NoExit` 讓視窗留著，使用者可以直接看到失敗原因、自己手動 cd 到別的地方繼續。
- 這跟隱藏/改名的「失敗要寫進 log 檔案使用者才看得到」完全不同——那兩個是**沒有畫面**的背景寫入，失敗必須額外想辦法讓使用者看見；`resume` 打開的**終端機本身就是畫面**，錯誤自然可見，不需要再疊加一層 log 機制去解決一個已經有更直接呈現方式的問題。

**第一輪 codex-peer-review 抓到一個原本設計沒處理的問題**：`Set-Location` 找不到路徑，預設是**非終止性錯誤**（non-terminating error）——印完錯誤訊息後，`;` 後面的 `claude --resume <id>`／`codex resume <id>` 照樣會執行，只是從一個「繼承到的、不知道是哪裡」的目錄下執行，使用者以為自己在正確的專案資料夾，實際上不是，agent 可能因此在錯的目錄裡工作。修正：`Set-Location` 加上 `-ErrorAction Stop`，把它轉成終止性錯誤——PowerShell 執行一段用 `;` 串起來的 `-Command` 腳本時，前面的陳述式拋出終止性例外會讓後面的陳述式不再執行，`claude --resume`／`codex resume` 就不會在錯誤目錄下被誤跑。使用者看到的仍然是同一個原生錯誤訊息，只是後面不會再接著誤跑續接指令。

**殘留、刻意接受的限制**：如果 `powershell.exe` 這個執行檔本身找不到（例如整個 PATH 環境異常），`spawn` 的 `error` 事件會非同步觸發；因為 `--handle-uri` 是跑完就結束的一次性行程，理論上這個事件有可能在行程已經結束之後才觸發，屆時 `appendProtocolLog` 不會被執行到，這個失敗就完全無聲。這個情況觸發條件極窄（Windows 內建的 `powershell.exe` 事實上幾乎不可能真的解析不到），跟隱藏/改名文件裡「已知、刻意接受的限制」是同一種取捨精神——不為了這個機率極低的邊界情況引入「行程要等非同步事件跑完才能結束」這種會弄髒既有同步 `main()` 流程的複雜機制。

## 不需要的部分（確認範圍，避免誤以為要動）

- **不需要重新 `--register-protocol`**：登錄檔裡 `shell\open\command` 寫的是通用的 `--handle-uri "%1"`，本來就不綁定特定 action，`resume` 直接沿用已經註冊好的登錄檔。
- **不需要新增登錄檔所有權標記/驗證邏輯**：整套機制屬於協議本身，不屬於單一 action，`hide`/`rename` 已經驗證過的部分原封不動。
- **不需要改權杖建立/驗證邏輯**：`resume` 沿用跟 `hide`/`rename` 完全相同的 token 比對——`loadProtocolTokenIfExists` 讀出的權杖必須跟網址裡的 `token` 相符，沒過就整個拒絕、不會呼叫 `resumeSession`。

## 前端改動

- 新增 `buildResumeUri(s)`：`buildProtocolUri('resume', { tool: s.tool, id: s.id, cwd: s.cwd, token: DATA.protocolToken })`，重用既有的 `buildProtocolUri` 組合函式。
- 「複製續接指令」按鈕（`createCopyButton`）的點擊處理，從直接呼叫 `navigator.clipboard.writeText(...)` 改成呼叫既有、已測試的 `triggerProtocolAction(buildResumeUri(s), buildResumeCmd(s))`——跟隱藏/改名同一個函式，協議導覽跟剪貼簿複製各自獨立、互不依賴（先觸發協議導覽，剪貼簿包在 `try/catch` 裡，任何失敗形式都不擋住已經觸發的導覽），不用再寫一次同樣的邏輯。
- 按鈕點擊後的文字回饋維持「已複製✓」不變——跟隱藏/改名按鈕維持「已複製XX指令✓」文字的既有慣例一致：剪貼簿複製這個動作本身確實還是會發生（保底），文字沒有失真。
- 協議尚未註冊、或使用者在瀏覽器確認視窗按下拒絕時，剪貼簿裡仍然有原本可用的手動指令。

## 測試計畫

- `parseAndValidateProtocolUri`：合法的 `resume` URI 正確解析出 `cwd`；缺漏/重複 `cwd` 被拒絕；`id` 含有允許清單以外字元（例如空白、`;`、`` ` ``、`$`、`'`、路徑分隔符）時被拒絕；`id` 以連字號開頭（例如 `--help`）時被拒絕（CLI 選項劫持風險，見上方修正說明），且不呼叫 `loadProtocolTokenIfExists`（驗證失敗要在比對 token 之前短路，沿用既有原則）；合法字元範圍內、開頭是英數字的 `id` 正常通過。
- `buildResumeCommandForProtocol`：跟 `cwd` 內含 `$`、反引號、單引號的路徑組合，輸出跟 `escapePowerShellSingleQuoted` 的既有跳脫規則一致，且包含 `-ErrorAction Stop`。
- `resumeSession`：餵入假的 `spawnFn`，驗證呼叫參數正確（`cmd.exe`、`['/c', 'start', '""', 'powershell.exe', '-NoExit', '-EncodedCommand', <base64>]`，其中 `<base64>` 用 `Buffer.from(<跟 buildResumeCommandForProtocol 輸出逐字相同的字串>, 'utf16le').toString('base64')` 反向驗證解碼後內容正確、`detached: true`、`stdio: 'ignore'`）；模擬回傳的假 child 物件觸發 `error` 事件時，驗證 log 檔案收到對應訊息且不含任何 token 相關內容；驗證回傳的假 child 物件的 `unref` 確實被呼叫過一次。
- `handleProtocolUri`：`action === 'resume'` 且 token 吻合時正確呼叫 `resumeSession`（不呼叫 `hideSession`/`renameSession`）；token 不吻合時完全不呼叫 `resumeSession`。
- `main --handle-uri`（`resume`）端到端：驗證通過後正確把控制權交給注入的假 `spawnResumeFn`，且沿用既有「不開瀏覽器、仍會走一次掃描/產生/寫檔」流程；驗證失敗（token 錯誤、`id` 字元不合法、`id` 以連字號開頭）時完全不呼叫 `spawnResumeFn`。
- 前端：續接按鈕點擊後 `location.href` 被設成正確的 `sessdash://resume?...` 網址（含 `cwd`、`token`），且原本的剪貼簿複製行為不受影響；剪貼簿三種失敗形式（rejected promise／API 不存在／同步拋出）都不擋住 `location.href` 的設定，沿用隱藏/改名同一組回歸測試手法。

- **必須由使用者手動驗證的部分**（沿用隱藏/改名文件同一個理由：這是跟 Windows/PowerShell 互動的真實效果，沙盒測試驗不到；下面第 1-3、5 步在寫這份文件時已經用獨立的實測腳本在真機上驗證過機制本身可行，這裡是驗證接上真實 `--handle-uri`／真實按鈕之後的端到端效果）：
  1. 部署最新腳本後（不需要重新 `--register-protocol`），點擊某張卡片的「複製續接指令」按鈕。
  2. 確認瀏覽器跳出協議確認視窗，點擊允許。
  3. 確認真的跳出一個新的、獨立的 PowerShell 視窗（過程中會有一個 `cmd.exe` 視窗閃一下就消失，這是正常現象），`cd` 到正確的資料夾並執行 `claude --resume <id>`／`codex resume <id>`，且視窗維持開啟可互動（可以實際打字）。
  4. 針對一個 `pathExists: false`（資料夾已搬移/刪除）的 session 點擊續接，確認 PowerShell 視窗裡看得到 `Set-Location` 的原生錯誤訊息、且**沒有**接著跑 `claude --resume`／`codex resume`（`-ErrorAction Stop` 生效），視窗仍然留著、沒有一閃而逝。
  5. 手動把網址裡的 `token` 參數改錯，確認不會有任何新視窗被打開。

## 已知限制

- 若 `cmd.exe`／`powershell.exe` 本身無法被解析（PATH 環境異常，極罕見），且該次 `--handle-uri` 一次性行程剛好在非同步 `error` 事件觸發前就已結束，這次失敗會完全無聲、不會被寫進 log。見上方「殘留、刻意接受的限制」。
- `start` 開新視窗的過程中會有一個 `cmd.exe` 視窗閃一下即逝，這是 Windows `start` 機制本身的正常現象，不是這次設計要解決或能解決的問題。
- 沿用 `docs/design/2026-08-04-protocol-handler-for-hide-rename.md` 已記錄的限制（僅支援 Windows、需要 `~/.claude/scripts/session-dashboard.js` 先部署到最新版才能生效等），不重複列出。

<!-- codex-peer-reviewed: 2026-08-05T09:44:00Z rounds=3 verdict=approved -->
