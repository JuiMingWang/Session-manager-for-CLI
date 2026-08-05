# 設計：用自訂 URL 協議取代「複製指令→貼到終端機」

## 背景與問題

Session 管理器目前的隱藏（單筆）、改名功能，因為儀表板本身是一個沒有伺服器的靜態 HTML
檔案，瀏覽器 JS 無法直接寫檔案，所以做成「按鈕複製一段 PowerShell 指令到剪貼簿，使用者
自己切到終端機貼上執行」。這個間接性造成明顯的手動摩擦（複製→切視窗→貼上→按 Enter）。

使用者希望能省略這個手動步驟，同時明確表示**不想走「常駐本機伺服器」這條路**（維持既有
的零依賴、無背景行程哲學，這點在稍早的批次隱藏設計討論中已經確認過一次）。

## 選定方案：自訂 URL 協議（`sessdash://`）

在 Windows 登錄檔（`HKEY_CURRENT_USER\Software\Classes`，不需要系統管理員權限）註冊一個
自訂協議 `sessdash://`，指向本機的 `node.exe session-dashboard.js --handle-uri "%1"`。
儀表板上的「隱藏」「改名」按鈕，點擊時觸發一個 `sessdash://...` 連結；瀏覽器辨識出這個
協議後，呼叫 Windows 登錄檔裡對應的程式，把完整網址當作 `%1` 傳進去，由該程式解析網址、
執行實際的寫入。

點擊當下才啟動一次性的 Node 行程，執行完就結束，跟現有「零常駐行程」的設計哲學一致。

### 為什麼不選其他兩條路

- **常駐本機伺服器**：使用者已經在稍早的批次隱藏功能設計中明確拒絕過（為了「即時更新」
  這個更輕量的需求都不想開常駐伺服器，更沒理由為了省幾次複製貼上而開）。
- **改寫成 Electron/Tauri 桌面應用程式**：體驗最好、無協議、無確認視窗，但等於重寫整個
  工具的殼（打包、簽章、更新機制、視窗生命週期），維護成本遠高於現有的「一支 Node script
  + 產生一份靜態 HTML」架構，使用者評估後選擇不做這條路。

## 安全設計：這是全系統範圍的協議，不是儀表板專屬的

登錄檔一旦註冊，`sessdash://` 協議是**整個作業系統範圍**都能觸發的，不限於我們自己產生的
儀表板頁面——任何網頁只要放一個 `sessdash://rename?...` 連結，理論上都能呼叫到同一支處理
程式。瀏覽器對「開啟外部程式的協議連結」預設會跳出一次確認視窗（「這個網站要開啟『X』
嗎？」），這是瀏覽器故意設計、防止惡意網頁自動觸發外部程式的機制；但這防不住「使用者被
騙點了允許」的情境。

### 防護：本機權杖（token）驗證

- 權杖檔案路徑：`~/.claude/session-dashboard-token`，內容是一組隨機產生的 128-bit 權
  杖。**只有在產生儀表板的正常流程裡**（`main()` 需要把目前的權杖內嵌進 `buildHtml` 的
  `DATA` 時）才會在檔案不存在時建立；已存在時重複使用同一組（不需要每次重新產生——它是
  「這台機器上，只有我們自己的程式知道」的共享密鑰性質，不是有時效性的一次性密碼，重新產
  生除了讓已開啟分頁的舊分頁失效外沒有額外的安全效益，反而增加「分頁不同步」的困擾）。
- 儀表板產生時，把目前的權杖內嵌進 `DATA.protocolToken`，隱藏／改名按鈕組出的
  `sessdash://` 連結一律帶上 `&token=<這組權杖>`。
- `--handle-uri` 執行時，**權杖比對是驗證流程的最後一步，不是第一步**：必須先通過網址結
  構驗證（協議、action 允許清單、必要參數存在且不重複、`tool` 允許清單，見下方「URI 驗
  證」的完整順序）之後，才會去讀取權杖檔案——而且讀取用的是**唯讀、不會建立檔案**的版本
  （見下方「`--handle-uri` 驗證流程不能意外建立 token」），確保任何格式不正確或不吻合權
  杖的外部請求，都不會有「順便建立了一個原本不存在的權杖檔案」這種副作用。權杖不吻合（或
  權杖檔案原本就不存在）就整個拒絕執行（記錄到錯誤紀錄檔，見下方「錯誤如何被看見」），不
  會嘗試執行任何寫入。
- 這樣即使外部惡意網頁猜中協議名稱、也騙到使用者點了瀏覽器的允許提示，因為它不會知道當
  下這台機器的權杖內容，也無法真正觸發寫入——瀏覽器確認視窗 + 權杖驗證是兩層獨立防護。

### 錯誤如何被使用者看見

`--handle-uri` 是由 Windows 協議機制在背景啟動的 `node.exe` 行程（沒有使用者主動開啟的
終端機視窗可以看 stdout），跟目前「使用者自己在終端機貼上執行、能親眼看到輸出」的模式不
同。為了不讓失敗（權杖不合、session 已經不存在等等）完全無聲無息，任何驗證失敗或例外都
會額外附加時間戳記寫入 `~/.claude/session-dashboard-protocol.log`（append-only，不覆
寫），使用者懷疑改名/隱藏沒生效時，可以打開這個檔案查看原因。成功的情況維持安靜（跟現有
`--hide`/`--rename` CLI 模式成功時一樣不印任何東西），不寫入這份 log。

**寫進 log 的內容不可以包含權杖本身**：權杖是一個 bearer credential，若把它原封不動寫進
一個會不斷累積、任何本機程式都能讀取的純文字 log 檔案，等於讓這層防護的價值打折——記錄
「token mismatch」這個事實本身即可，不記錄使用者送來的 token 值、也不記錄檔案裡正確的
token 值。

**已知、刻意接受的限制（這一輪不處理）**：前端目前的「隱藏」「改名」都是先樂觀更新畫面
（卡片立即消失/立即改名），再讓複製出去的指令/協議連結去做實際寫入——這個「畫面已經顯示
成功，但背景實際寫入可能失敗」的落差，在既有的隱藏功能裡就已經存在（複製的指令要等使用
者自己貼上執行才會真的生效），這次的協議連結只是把「使用者手動執行」換成「Windows background
執行」，並沒有讓這個落差變得更嚴重，也沒有讓它變好——`--handle-uri` 失敗時使用者唯一能
知道的方式是打開 log 檔案，畫面本身不會顯示任何失敗提示。這是刻意不在這一輪解決的已知限
制，不是被忽略的疏漏。log 檔案本身也不設大小上限或輪替機制——這是低頻率、使用者主動觸發
的操作（點一次按鈕才寫一行），實務上不會累積到有意義的大小，暫不處理輪替。

## URI 格式

```
sessdash://<action>?tool=<tool>&id=<id>&title=<url-encoded>&token=<token>
```

- `action` 目前支援 `hide`、`rename` 兩種（對應既有的 `--hide`、`--rename` CLI 語意）。
- `title` 只有 `rename` 需要；`hide` 沒有這個參數。
- 各參數值一律用 `encodeURIComponent` 跳脫，處理端用 `URL`／`URLSearchParams` 解析，不用
  手刻字串切割。

## 這一輪的範圍：哪些按鈕改，哪些不改

- **改**：專案樹卡片上的單筆「隱藏」按鈕、「改名」按鈕——這兩個是這次觸發「想省略複製貼
  上」討論的具體案例。
- **不改（維持現狀，複製指令到剪貼簿）**：批次隱藏列（勾選多筆後的「隱藏已選取」按鈕）。
  批次情境要在網址裡表達「多組 tool/id」，目前的單一 action + 一組 tool/id 的網址格式沒
  有涵蓋這個情況；沒有使用者提出這個具體需求，屬於刻意先不做的範圍外項目，之後有需要可以
  再設計批次版本的網址格式（例如同一個網址帶多組 `pair=tool:id` 重複參數）。
- 兩個改動的按鈕都**同時保留原本複製指令到剪貼簿的行為**，作為協議還沒註冊（使用者還沒
  執行過 `--register-protocol`）時的備援——沒註冊的情況下瀏覽器會顯示原生的「未知協議」
  錯誤，但剪貼簿裡仍然有原本可用的手動指令，不會讓使用者卡住。

## 實作內容

### `main()` 的分派順序（第一輪審查發現原文沒講清楚，這裡明確定案）

`main()` 目前的流程是「套用 hide/unhide/rename → 掃描全部 session → 產生 HTML → 寫檔 →
視情況開瀏覽器」。三個新旗標的介入點各不相同，必須明確定案，不能讓工程師自己猜：

1. `--register-protocol` / `--unregister-protocol`：**最優先檢查，處理完立刻 `return`**，
   不執行後面任何一行（不讀取 claudeHomeDir/codexHomeDir 掃描相關邏輯、不產生 HTML、不寫
   `sessions-dashboard.html`、不開瀏覽器）。這兩個旗標互斥於其他所有旗標；若同時傳入
   `--register-protocol` 又傳入 `--hide` 之類，只處理 register，其餘旗標被忽略（這兩個
   旗標本質是「一次性系統設定」，不是「這次要不要順便整理 session」）。
2. `--handle-uri <uri>`：解析與驗證（見下方「URI 驗證」）**必須全部通過**才呼叫
   `hideSession`／`renameSession`；驗證失敗時直接 `throw`（附帶記錄到 log，見下方），**不
   會**繼續往下執行掃描/寫檔——失敗與成功不能都走到同一個「照樣重新整理儀表板」的結尾。驗
   證通過、寫入成功後，才跟現有 `--hide`/`--rename` 一樣繼續走完整的「掃描全部 session→
   產生儀表板→寫檔」流程，且不開啟瀏覽器（沿用既有 `!hide.length && !unhide.length &&
   !rename` 的否決條件，追加 `&& !handleUri`）。

### 登錄檔寫入前先確認「這個機碼是不是我們自己的」

`HKCU\Software\Classes` 是使用者層級的共用命名空間，`sessdash` 這個機碼理論上可能已經被
別的程式用掉（機率低但不是零，而且 `reg add .../f` 會靜默覆寫、`reg delete` 會整個刪
掉）。

第三輪審查指出，先前「檢查三個功能性的值本身」這條路線有三個解不開的問題：(1) 想同時容忍
node.exe 路徑變動又要防止字串偽造，兩者對同一個 command 字串互相拉扯，正規表示式的萬用字
元段（`.*`）終究可能被精心構造的外部字串越過；(2) 只檢查三個特定值名稱，不代表 root 機碼
本身沒有其他外部程式留下的、我們沒去檢查的內容；(3) 三次 `reg add` 不是一個整體的原子操
作，若中途意外中斷，下次執行時「三個值須同時完整且一致」這個條件本身就無法辨認出「這其實
是自己上次沒寫完的狀態」，反而會把自己的半完成狀態誤判成外部程式而拒絕修復。

改用一個**獨立、完全由我們自己定義、不含任何變動路徑的所有權標記值**，一次解決這三個問
題：額外寫入第四個值 `HKCU\Software\Classes\sessdash` 底下的
`SessionDashboardOwner`，內容固定為字面字串 `"session-dashboard-tool-v1"`（不含路徑、不
含任何會變動的內容，純粹是一個身份標記）。**這個標記值本身用逐字完全相等比對，不需要任何
正規表示式或萬用字元**，因為它從頭到尾都是我們自己完全掌控、內容固定的字串——沒有「該固
定哪一段、該放寬哪一段」這種拉扯。

- **判斷是否為我們自己的機碼，只看這一件事**：`reg query "HKCU\Software\Classes\
  sessdash" /v SessionDashboardOwner` 查得到、且值逐字等於 `"session-dashboard-tool-v1"`
  → 是我們自己的，接下來三個功能性的值（root 預設值、`URL Protocol`、
  `shell\open\command`）**一律無條件覆寫成目前預期的內容**，不管它們目前個別處於什麼狀
  態（包括「上次執行中斷、只寫了一部分」這種情況——只要標記在，就代表機碼整體屬於我們，
  可以放心補齊/刷新其餘的值，這同時解決了「三次 reg add 不是原子操作」的問題：只要標記
  寫得成功，之後不管在哪個值卡住，下次執行都能安全地把剩下的補完）。
- **判斷是否為全新環境（可以放心從零開始建立）**：`reg query "HKCU\Software\Classes\
  sessdash"`（查機碼本身，不加 `/v`）查不到 → 整個機碼都不存在，確定是空白狀態，直接依
  序建立標記值與三個功能性的值。
- **兩者都不成立**（機碼存在，但查不到我們的標記，或標記值內容不符）→ **中止，拋出清楚
  的錯誤訊息**，不動任何東西——不論機碼底下實際放了什麼內容，只要沒有我們自己的標記，就
  一律當成外部程式的東西，不嘗試判斷「這三個值看起來像不像我們的」。

寫入順序固定為：**先寫標記值，最後才寫三個功能性的值**。這讓「中途中斷」的恢復路徑最大
化：只要標記值這一次 `reg add` 成功寫入，之後不管在哪一步中斷，下次執行都會透過標記辨認
出「這是我自己的、只是還沒寫完」，繼續把剩下的值補上。

**殘留的極窄邊界情況（刻意接受，不用複雜機制解決）**：`reg add SessionDashboardOwner ...`
這唯一一次呼叫本身，在 Windows 底層可能是「先建立 `sessdash` 這個機碼、再寫入值」兩個步
驟——如果程序剛好在這兩步之間被強制中斷（例如系統崩潰、斷電、或行程被強制終止，不是正常
的例外拋出，是連 Node.js 自己的例外處理都來不及執行的中斷），會留下一個「機碼存在、但完
全沒有任何值（包含標記）」的空殼機碼，下次執行時查詢機碼本身會判定「存在」，但查不到標
記，會被目前的規則當成外部程式而中止。

這個情況觸發條件極窄（單一 `reg add` 呼叫執行過程中的系統層級強制中斷，不是一般的程式錯
誤或例外），而且後果很輕——一個空殼機碼裡沒有任何內容值得保留，不管它「原本」是不是我們
造成的，安全的處理方式都一樣：使用者只要手動執行一次 `reg delete "HKCU\Software\Classes\
sessdash" /f` 清掉這個空殼，再重新執行 `--register-protocol` 即可。這裡刻意不引入「解析
`reg query` 文字輸出來判斷機碼是否完全空白」這種額外機制——`reg.exe` 的文字輸出格式跟系
統語系有關，用字串解析去判斷「有沒有其他內容」本身就是一個新的、更脆弱的問題來源，用來換
一個發生機率極低、而且已經有清楚一行指令可以手動復原的邊界情況，不划算。這個殘留限制記錄
在下方「已知限制」一節。

- **解除註冊時**：機碼不存在（`reg query` 查機碼本身查不到）→ 視為已經是「未註冊」狀
  態，安全地什麼都不做並成功返回。機碼存在且查得到我們的標記值、內容相符 → 執行
  `reg delete` 整個機碼（標記值跟三個功能性的值一起被移除，因為整個機碼都是我們建立
  的）。機碼存在但查不到標記、或標記內容不符 → **中止，拋出清楚的錯誤訊息**，不刪除別人
  的東西。

#### `reg.exe` 非零結束碼的兩種意義（第二輪審查抓到這裡邏輯自相矛盾）

「非零結束碼一律拋出例外」這條規則**只適用於 `reg add`／`reg delete`（真正的寫入動作）**。
`reg query` 的非零結束碼，在「機碼/值不存在」這個情境下是**正常、預期的回報方式**（這就是
`reg query` 表達「找不到」的手段），必須被註冊/解除註冊流程當成合法分支處理（對應到上面
「機碼不存在 → 直接建立/安全地不做任何事」這兩條路徑），不能被一條通用的「非零就拋錯」規
則攔截，否則**全新環境第一次執行 `--register-protocol` 一定會失敗**（因為機碼本來就還不
存在，`reg query` 一定回報找不到）。實作時 `reg query` 的呼叫要用自己專屬的錯誤處理邏輯
（區分「找不到」與其他真正的失敗，例如 `reg.exe` 本身不存在或權限問題——後者才要拋出），
不能跟 `reg add`／`reg delete` 共用同一段「非零就拋錯」程式碼。

`reg query`／`reg add`／`reg delete` 都透過同一個可注入的 `execFn`（見下方），一律用
`execFileSync`（同步、參數陣列形式，不經過 shell 字串組合，不把使用者可控的內容交給 shell
解析）呼叫。

### canonical 腳本路徑：跟現有複製指令用同一份部署路徑，不是 repo 路徑

第一輪審查抓到一個會直接讓功能失效的錯誂：`buildHideCmd`/`buildRenameCmd` 複製出去的指令
一直用的是**部署後的路徑** `$HOME/.claude/scripts/session-dashboard.js`（`hooks`/`/sessions`
skill 實際執行的也是這一份，不是 repo 裡的 `src/session-dashboard.js`）。登錄檔裡
`shell\open\command` 要註冊的腳本路徑，必須固定使用
`path.join(os.homedir(), '.claude', 'scripts', 'session-dashboard.js')`
這個**固定的部署路徑**（在註冊當下用 `os.homedir()` 現算，不用 `__filename`）——這樣不管
使用者是從 repo 目錄還是從部署目錄執行 `--register-protocol`，登錄檔裡指向的都是實際會被
`/sessions` skill 更新維護的那一份，不會出現「註冊到 repo 路徑、之後 repo 目錄被搬走或只
更新了部署副本」的失效情況。Node 執行檔路徑用 `process.execPath`（目前執行中的 node.exe
絕對路徑）。

註冊的完整命令組成：
```
"<process.execPath>" "<~/.claude/scripts/session-dashboard.js 絕對路徑>" --handle-uri "%1"
```

### 新的 CLI 模式（沿用既有 `--hide`/`--unhide`/`--rename` 那種 flag-based 分派方式）

- `--register-protocol`：依照上面兩節的順序與所有權檢查，寫入四個登錄檔值（所有權標記
  `SessionDashboardOwner`、`HKCU\Software\Classes\sessdash` 的預設值、`URL Protocol`
  空字串標記、`shell\open\command` 的預設值——標記值最先寫入，見上方順序說明）。
- `--unregister-protocol`：依照所有權檢查，移除整個 `HKCU\Software\Classes\sessdash`
  機碼（或機碼本來就不存在時安全地不做任何事）。
- `--handle-uri <uri>`：解析網址、嚴格驗證、驗證權杖、依 action 分派到既有的
  `hideSession`／`renameSession`（完全複用既有函式，不重寫寫入邏輯）。

`reg.exe` 的實際執行函式（`execFn`）採依賴注入（跟現有 `openBrowser` 用同一種模式，透過
`options.execProtocolCommand` 傳入），**測試永遠餵假的記錄函式，絕對不會在跑測試時真的碰
觸機器上的登錄檔**。

### 權杖的建立：寫暫存檔＋硬連結搶佔，真正的原子發布

第一輪審查指出「讀取不存在就建立」在多行程並行時會產生兩個不同 token 的競態；第二輪審查
進一步指出，光用 `{ flag: 'wx' }` 只保證「不會有兩個行程都成功建立/覆寫檔案」，**不保證
其他行程在贏家的內容完整寫入前，看到的不是一個空檔案或只寫了一半的內容**（`wx` 防止的是
「誰能建立」，不是「建立的過程本身是原子的」）。改成「先把完整內容寫進一個獨一無二的暫存
檔，再用硬連結（`fs.linkSync`）把暫存檔接到目標路徑」——硬連結本身是單一系統呼叫、要嘛整
個成功要嘛整個失敗，而且失敗時（目標已存在）是 `EEXIST`，天生具備「只有一個贏家」的語
意，同時暫存檔在連結之前就已經完整寫完，不存在任何人會讀到「半份」內容的時間窗：

```js
function loadOrCreateProtocolToken(filePath) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.session-dashboard-token.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(tempPath, token, 'utf8'); // 完整寫完才會有下一步，這裡不會有人讀到
  try {
    fs.linkSync(tempPath, filePath); // 原子的「建立，若已存在則失敗」；EEXIST 代表別人贏了競態
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  } finally {
    fs.unlinkSync(tempPath); // 不管輸贏都要清掉自己的暫存檔，跟 writeAtomic 的暫存檔慣例一致
  }
  return fs.readFileSync(filePath, 'utf8').trim(); // 不管是自己剛建立的還是別人贏了競態建立的，一律回頭讀檔案內容——絕不會讀到半份
}
```

暫存檔刻意建立在跟目標檔案**同一個目錄**（跟既有 `writeAtomic()` 的慣例一致），確保
`linkSync` 是同一個磁碟區內的操作，不會遇到跨磁碟區導致連結失敗的情況。

### `--handle-uri` 驗證流程不能意外建立 token（第二輪審查抓到的問題）

上面的 `loadOrCreateProtocolToken` 只能在**產生儀表板的正常流程**（`main()` 需要把目前
的權杖內嵌進 `buildHtml` 的 `DATA` 時）呼叫——那是我們自己主動需要一組權杖的時刻，建立是
合理的。但 `--handle-uri` 的驗證流程如果沿用同一個函式，代表**任何格式正確、但權杖對不上
的外部請求，都會在驗證失敗前先把 token 檔案「建立」出來**（如果它原本還不存在的話）——
這違反了「驗證失敗完全不執行任何動作」的原則，也讓一個不受信任的外部請求擁有了「觸發本機
狀態被建立」的副作用。`--handle-uri` 改用一個**只讀、不建立**的版本：

```js
function loadProtocolTokenIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const token = fs.readFileSync(filePath, 'utf8').trim();
  return token || null;
}
```

`--handle-uri` 驗證時呼叫 `loadProtocolTokenIfExists`：回傳 `null`（代表儀表板從來沒有
被正常產生過，不可能有任何合法的連結）就直接拒絕，不建立任何東西；回傳實際權杖字串才拿去
跟網址裡的 `token` 參數比對。

### token／log 路徑必須是可注入的依賴，不能寫死指向真實 `~/.claude`

`main(argv, options)` 現有的 `options.claudeHomeDir`／`codexHomeDir`／`hiddenListPath`／
`openBrowser` 都是可注入的，這次新增的 `options.protocolTokenPath`（預設
`path.join(claudeHomeDir, 'session-dashboard-token')`）與 `options.protocolLogPath`（預
設 `path.join(claudeHomeDir, 'session-dashboard-protocol.log')`）也必須比照辦理，否則單
元測試會直接讀寫到執行測試那台機器上真實的 `~/.claude/` 檔案，污染真實資料、也讓測試結果
依賴機器上是否已經存在舊的 token 檔案。

### URI 驗證：嚴格 allowlist，不接受「差不多對」的輸入

第一輪審查指出 `URLSearchParams.get()` 對缺漏/重複欄位過於寬容，且既有內部函式
`renameSession` 對「非 `codex` 就當 `claude-code`」的寬鬆判斷，一旦輸入來源是外部網址
（理論上任何網頁都能構造），不該直接沿用這種寬鬆度。`--handle-uri` 的驗證管線，依序：

1. `new URL(uriString)` 解析失敗（畸形網址）→ 直接拒絕。
2. `parsed.protocol` 必須嚴格等於 `'sessdash:'`，`parsed.hostname` 必須是允許清單
   `['hide', 'rename']` 其中之一（大小寫需完全相符，不做寬鬆比對）→ 其餘一律拒絕。
3. 依 action 檢查必要參數：`hide` 需要 `tool`、`id`；`rename` 需要 `tool`、`id`、
   `title`。每個必要參數都用 `searchParams.getAll(key)` 檢查**剛好等於一次**（`length
   !== 1` 一律拒絕，防止重複參數造成的歧義），且非空字串。
4. `tool` 必須嚴格等於 `'claude-code'` 或 `'codex'` 其中之一，其餘一律拒絕（不套用既有
   `renameSession` 內部「非 codex 就當 claude-code」的寬鬆 fallback——那個寬鬆判斷是給
   內部、可信任的 CLI flag 用的，這裡的輸入來源不可信任，要收得比內部呼叫更嚴）。
5. 前四步都通過後，呼叫 `loadProtocolTokenIfExists()`（只讀，見上方，不會意外建立
   token）；回傳 `null`（代表儀表板從未正常產生過）或跟網址裡的 `token` 參數不相等，一
   律拒絕。
6. 只有 1-5 全部通過，才呼叫 `hideSession`／`renameSession`。

任何一步拒絕，統一走同一個「記錄到 log（見下方遮罩規則）→ `throw` 一個清楚的錯誤」路徑，
不會有「驗證失敗但仍然執行了一部分」的中間狀態。

### 改名要寫對「畫面上實際顯示的那個複本」，不是隨便找到的第一個檔案

第一輪審查指出一個跟本專案既有已知情況直接相關的錯誂：`dedupeSessions()` 在同一個
`(tool, id)` 有多個檔案（專案資料夾搬移/複製留下的舊複本，`deploy-log.md` 已記錄過這個
真實案例）時，會保留 `lastActiveAt` 最新的那一份顯示在畫面上；但 `findClaudeSessionFilePath`
如果只取 `walkJsonlFiles()` 找到的第一個相符檔案，可能挑到的是畫面上根本沒顯示的舊複本
——改名寫入了舊檔案，畫面顯示的仍是另一份，使用者會看到「改名指令執行了，但重新整理後名
字沒變」。修正：`findClaudeSessionFilePath` 找出所有 basename 相符的候選檔案，若不只一
個，各自呼叫 `scanClaudeCodeFile` 取得其 `lastActiveAt`，挑最新的那一份。只有一個候選時
（絕大多數情況）不需要這個額外比較，維持原本的低成本。

**第三輪審查指出兩個沒講清楚的邊界情況**：

1. **候選檔案本身可能損壞**：`scanClaudeCodeFile` 對無法解析的檔案會拋出例外（既有的
   `scanClaudeCode` 批次掃描本來就是靠 catch 這個例外來跳過異常檔案、計入 `skipped`）。
   多候選比較時，每個候選都要各自用 `try/catch` 包住這次呼叫，掃描失敗的候選直接跳過
   （視為不可用，不是让整個改名操作失敗）——只有當**全部**候選都掃描失敗時，才整個拋出
   錯誤（此時真的沒有任何可寫入的目標）。不能讓「其中一個複本剛好壞掉」拖累「另一個複本
   其實好好的、也應該能正常改名」這個情況。
2. **`lastActiveAt` 剛好相同時的決勝規則**：`dedupeSessions()` 用嚴格大於（`>`）比較，
   在完全相等時保留先遍歷到的那一筆。`findClaudeSessionFilePath` 的候選比較要用同一種
   規則（嚴格大於，同分時保留 `walkJsonlFiles()` 回傳順序中先出現的那一個），確保「挑到
   哪一份」的邏輯跟 `dedupeSessions()` 決定「畫面上顯示哪一份」的邏輯永遠一致，不會出現
   兩套函式各自決勝規則不同、導致改名目標又跟畫面顯示的對不上的情況。

### 前端改動

- `buildHtml` 的內嵌 `DATA` 多一個 `protocolToken` 欄位。
- 隱藏／改名按鈕的點擊處理，除了原本的 `navigator.clipboard.writeText(...)`，多一行
  `location.href = 'sessdash://...'`（帶上 tool/id/title/token）。

**第三輪審查指出，光補一個 `.catch(function(){})` 不足以保證兩者真的互相獨立**：
`.catch()` 只能接住「Promise 被 reject」，接不住「`navigator.clipboard` 這個物件本身就
不存在」（例如非安全環境下這個 API 可能整個不存在，存取 `.writeText` 會直接丟出同步的
`TypeError`，根本沒有 Promise 可以掛 `.catch()`）或「`writeText()` 呼叫本身同步拋出例
外」這兩種情況——一旦發生，會在還沒執行到 `location.href = ...` 那一行之前就讓整個點擊處
理函式中斷，導致協議連結完全沒有被觸發，跟文件宣稱的「兩者互不依賴」自相矛盾。

修正為：**先觸發協議導覽，再用 `try/catch` 包住整個剪貼簿嘗試**，讓剪貼簿那一步的任何失
敗形式（同步拋出、API 不存在、Promise reject）都不可能擋住前面已經執行過的協議導覽：

```js
function triggerHideOrRename(uri, clipboardText) {
  location.href = uri; // 先做，任何後續失敗都不影響這一步已經發生
  try {
    var p = navigator.clipboard && navigator.clipboard.writeText(clipboardText);
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (err) {
    // API 不存在、或呼叫本身同步拋出——維持沿用剪貼簿只是錦上添花的 best-effort 定位，
    // 不影響已經觸發的協議導覽，也不需要讓使用者看到這個失敗。
  }
}
```

協議尚未註冊、或使用者在瀏覽器確認視窗按下拒絕時，剪貼簿裡仍然會有原本可用的手動指令可以
貼上執行（只要剪貼簿 API 本身可用）。

## 測試計畫

- 單元測試（沿用現有測試檔的 fake-DOM／temp-dir 測試模式）：
  - `loadOrCreateProtocolToken`：檔案不存在時建立、已存在時重複使用同一組；模擬
    `linkSync` 遇到 `EEXIST`（例如先手動建立好目標檔案）時，正確退回讀取既有內容而不拋
    出，且暫存檔會被清掉，不留下孤兒 `.tmp` 檔案。
  - `loadProtocolTokenIfExists`：檔案不存在時回傳 `null`、且**不會**建立任何檔案；檔案存
    在時回傳其內容。
  - URI 解析與嚴格驗證：合法的 `sessdash://rename?tool=...&id=...&title=...&token=...`
    正確拆解（含中文/特殊字元的 title 正確 decode）；`protocol` 不是 `sessdash:`、
    `hostname` 不在允許清單、必要參數缺漏、必要參數重複出現、`tool` 不是
    `claude-code`/`codex` 這幾種情況，各自獨立測試都被拒絕且不呼叫任何寫入函式、也不呼叫
    `loadProtocolTokenIfExists`（驗證失敗要在比對 token 之前就短路，不能有任何副作用）。
  - `--handle-uri` 端到端：權杖吻合且驗證通過時正確呼叫 `hideSession`/`renameSession`
    （用真實暫存目錄驗證檔案真的被改到，跟現有 `--hide`/`--rename` 測試同一種驗證方
    式），且確認後續仍會走完整的掃描/產生/寫檔流程但不開啟瀏覽器；權杖不吻合、或驗證失敗
    時完全不寫入、且錯誤被記錄到 log 檔案，並確認 log 內容不包含任何 token 原始值；權杖
    檔案根本不存在時（模擬從未正常產生過儀表板）同樣被拒絕，且不會意外建立出 token 檔案。
  - 改名寫入正確的複本：`findClaudeSessionFilePath` 在同一 id 有多個候選檔案時，挑選
    `lastActiveAt` 最新的那一份（模擬 `deploy-log.md` 已記錄過的「專案搬移留下舊複本」情
    境），而不是任意挑到的第一個；其中一個候選檔案損壞（無法被 `scanClaudeCodeFile` 解
    析）時，跳過該候選、仍正確挑出另一個可用且較新的候選，不因為單一候選損壞就整個失敗；
    全部候選都損壞時才整個拋出錯誤；`lastActiveAt` 完全相同的兩個候選，保留
    `walkJsonlFiles()` 順序中先出現的那一個（跟 `dedupeSessions()` 的決勝規則一致）。
  - `--register-protocol`/`--unregister-protocol`：驗證餵進去的假 `execFn` 收到的指令
    參數（`reg add`/`reg delete` 的機碼路徑、四個值各自的內容與寫入順序——標記值必須是第
    一個被寫入的，`shell\open\command` 裡包含正確的
    `~/.claude/scripts/session-dashboard.js` 絕對路徑與 `--handle-uri "%1"`），不驗證真
    實登錄檔效果；模擬 `reg query`（查機碼本身）回報「機碼不存在」時（第一次註冊的正常情
    境）正確視為全新環境、依序建立四個值，而不是被誤判成錯誤中止；模擬「機碼存在、標記值
    `SessionDashboardOwner` 存在且內容相符，但 `shell\open\command` 裡的 node.exe 路徑
    跟這次執行的 `process.execPath` 不同」（模擬 Node 升級/搬移安裝路徑）時，正確視為
    「自己的舊註冊」而正常覆寫三個功能性的值，**不會**被誤判成外部程式；模擬「機碼存在、
    標記值存在且相符，但 `shell\open\command` 缺失（模擬上次執行中斷在寫完標記之後、寫完
    命令之前）」時，正確視為「自己未完成的狀態」而補齊剩下的值，不中止；模擬「機碼存在，
    但查不到標記值，即使 `URL Protocol`/`shell\open\command` 看起來很像我們會寫的內容」
    時，register 與 unregister 都要中止並丟出錯誤，不呼叫 `reg add`/`reg delete`（驗證不
    會被「內容看起來很像」唬過，只認標記值）；模擬機碼存在且標記值相符時，register 正常
    覆寫、unregister 正常刪除整個機碼。
  - 前端：隱藏/改名按鈕點擊後 `location.href` 被設成正確的 `sessdash://` 網址（含
    token），且原本的剪貼簿複製行為不受影響（兩者都要發生，不是二選一）；模擬
    `clipboard.writeText()` 回傳一個 rejected Promise、模擬 `navigator.clipboard` 整個
    不存在（存取即拋出）、模擬 `writeText()` 本身同步拋出例外，這三種情況都要驗證
    `location.href` 仍然正常被設定、點擊處理不會讓例外往外拋出中斷其他程式碼。

- **必須由使用者手動驗證、無法在沙盒測試中涵蓋的部分**（這是跟作業系統登錄檔/瀏覽器互動
  的真實效果，沙盒測試只能驗證「我們自己這端的程式邏輯」，驗不到「Windows 真的把連結正確
  轉發給我們的程式」這件事本身）：
  1. **先確認 `~/.claude/scripts/session-dashboard.js`（及 `adapters/`）已經是包含這次改
     動的最新版本**（依既有 `deploy-log.md` 的手動部署慣例，把 `src/` 底下改好的檔案複製
     過去）——這是前面「前置條件」那節講的順序要求，順序顛倒的話註冊會「看似成功」但按鈕
     點了沒反應。部署完成後，執行一次
     `node "$HOME/.claude/scripts/session-dashboard.js" --register-protocol`。
  2. 打開儀表板，點擊某張卡片的「改名」按鈕，輸入新名稱。
  3. 確認瀏覽器跳出「是否開啟 Session 管理器」之類的確認視窗，點擊允許。
  4. 確認該 session 的標題真的被改掉（重新整理儀表板頁面，或直接查看 jsonl/
     session_index.jsonl 檔案內容）。
  5. 手動把網址裡的 `token` 參數改錯，確認會被拒絕、且 `session-dashboard-protocol.log`
     裡出現對應的錯誤紀錄，且該紀錄不包含任何 token 原始值。
  6. 針對一個確認在 `~/.claude/projects/` 底下有多個複本檔案的 session id（若手上沒有現
     成案例，可手動複製一份既有 session 的 jsonl 到另一個模擬的專案資料夾底下製造出重
     複），透過改名按鈕改名，確認新名稱出現在畫面上實際顯示的那一份，而不是意外寫進了沒
     有顯示出來的舊複本。
  7. 執行 `node "$HOME/.claude/scripts/session-dashboard.js" --unregister-protocol`，確認協議被移除後點擊按鈕會
     出現瀏覽器原生的「無法識別的協議」錯誤（而不是靜默失敗），且剪貼簿裡仍然有可手動貼上
     執行的備援指令。
  8. 確認 `reg query "HKCU\Software\Classes\sessdash\shell\open\command"` 查出來的值，
     指向的確實是 `~/.claude/scripts/session-dashboard.js`（部署路徑），不是 repo 底下的
     `src/session-dashboard.js`。

## 已知限制

- 僅支援 Windows（`reg.exe`／`HKEY_CURRENT_USER\Software\Classes`），跟現有
  `buildResumeCommand` 已經假設 PowerShell/Windows 一致，不是這次新引入的限制。
- 若專案資料夾搬移或 Node.js 安裝路徑改變，登錄檔裡记录的絕對路徑會失效，需要重新執行一次
  `--register-protocol` 覆寫登錄檔（`reg add ... /f` 本身就是覆寫語意，重複執行是安全
  的）。
- **極窄邊界情況**：若寫入所有權標記值的那次 `reg add` 呼叫本身在執行過程中被系統層級強
  制中斷（斷電、崩潰，不是一般的例外拋出），可能留下一個「機碼存在但沒有任何值」的空殼機
  碼，下次執行 `--register-protocol`/`--unregister-protocol` 會因為查不到標記而中止並回
  報「不是我們自己的機碼」。復原方式：手動執行
  `reg delete "HKCU\Software\Classes\sessdash" /f` 清掉這個空殼，再重新執行
  `--register-protocol`。刻意不透過解析 `reg query` 的文字輸出來自動判斷「機碼是否完全
  空白」——那個文字輸出格式跟系統語系相關，用字串解析去猜測內容，換來的是一個新的、更脆
  弱的問題來源，用來處理一個發生機率極低、且已有清楚一行指令可以復原的情況，不划算。

## 前置條件：`--register-protocol` 必須在部署最新腳本之後執行

第二輪審查指出一個操作順序上的落差：登錄檔註冊的是 `~/.claude/scripts/session-
dashboard.js`（部署副本），但這個部署副本目前是**手動同步**的（`deploy-log.md` 已記錄的
慣例是修改完 `src/` 底下的檔案後手動 `cp` 到 `~/.claude/scripts/`），這份設計文件本身**不
會**自動觸發那次部署。如果使用者在 repo 目錄改完 `src/session-dashboard.js`、但還沒手動
部署到 `~/.claude/scripts/` 之前就執行 `--register-protocol`，登錄檔會「看似註冊成功」，
但實際被呼叫到的部署副本是舊版本、根本不認得 `--handle-uri` 這個旗標——點擊按鈕時會靜默
失敗（舊版本的 `parseArgs` 不認得這個旗標，多半只是忽略、照舊跑一次正常掃描，不會有清楚
的錯誤訊息）。

這一輪不把「自動部署」做進 `--register-protocol` 本身（部署動作目前刻意是一個獨立、手動
的步驟，讓改動可以先確認過再上到實際運作的副本，`--register-protocol` 內部夾帶自動部署
會繞過這個既有的把關方式）。改成把**先部署、後註冊**明確寫成執行順序的前置條件，並列進下
方手動驗證清單的第一步。

<!-- codex-peer-reviewed: 2026-08-03T18:08:06Z rounds=7 verdict=approved -->
