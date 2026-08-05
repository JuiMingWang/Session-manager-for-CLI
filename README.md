# Session 管理器

本機 Claude Code / Codex CLI 對話 session 的檢視與接續工具。將散落在 `~/.claude/projects/` 與 `~/.codex/sessions/` 的對話紀錄整理成單一自包含 HTML 儀表板，方便搜尋、瀏覽、隱藏、改名，並一鍵開新終端機接續指定的 session。

## 功能

- **接續快速區**：頂部固定顯示全站最新 8 筆可接續的 session，跨專案、不受篩選影響。
- **專案樹**：以檔案總管式縮排呈現「專案 → 路徑 → 時間區間 → session」階層，同一專案曾存在多個磁碟路徑時會分開列出。
- **搜尋 / 篩選**：依標題、路徑、工具（Claude Code / Codex）篩選。
- **訊息預覽**：列出每筆 session 最後一則訊息的摘要，不用點進去也能判斷是不是要找的那筆。
- **隱藏 / 改名 / 續接一鍵觸發**：透過自訂的 `sessdash://` URL 協議，點擊按鈕即直接執行對應動作（隱藏本地清單、改標題、開新終端機並 `cd` 到原資料夾後執行 `claude --resume <id>` 或 `codex resume <id>`），不用再手動複製指令貼到終端機。細節見 `docs/design/`。
- **久未使用整理區**：超過 90 天未互動的 session 集中顯示在專案樹最上方，方便清理。
- **暗色模式**：跟隨系統 `prefers-color-scheme`。
- **零外部資源**：產出的 HTML 是完全自包含的單一檔案，不依賴任何 CDN 或外部請求（見 `docs/adr/0002-zero-external-resources.md`）。

## 需求

- Node.js 18 以上（僅使用內建模組：`node:fs`、`node:test` 等，無任何外部套件）。
- Windows（`sessdash://` 協議註冊與終端機開啟目前僅針對 Windows 登錄檔 / PowerShell 實作）。

## 安裝與使用

```bash
# 1. 複製核心腳本到 Claude Code 的 scripts 目錄
cp src/session-dashboard.js ~/.claude/scripts/session-dashboard.js
cp src/adapters/*.js ~/.claude/scripts/adapters/

# 2. 註冊 sessdash:// 協議（僅需一次，寫入 HKCU，不需要系統管理員權限）
node ~/.claude/scripts/session-dashboard.js --register-protocol

# 3. 產生並開啟儀表板
node ~/.claude/scripts/session-dashboard.js
```

也可以透過 `commands/sessions.md`（Claude Code 自訂指令 `/sessions`）或 `src/install-session-dashboard-hooks.js`（將產生儀表板掛進 `SessionStart` hook，每次開新 session 自動背景刷新）整合進日常流程。

### CLI 參數

| 參數 | 說明 |
| --- | --- |
| （無參數） | 掃描、產生 `sessions-dashboard.html`，並用預設瀏覽器開啟 |
| `--quiet` | 只掃描並寫檔，不開瀏覽器（用於 hook 背景刷新） |
| `--register-protocol` | 註冊 `sessdash://` 協議處理器到目前使用者的登錄檔 |
| `--unregister-protocol` | 移除協議註冊（僅移除本工具建立的項目，不動其他所有權的登錄鍵） |
| `--handle-uri <uri>` | 內部用途：處理協議連結觸發的 `sessdash://` 請求 |

## 測試

```bash
npm test
# 等同於：node --test src/*.test.js
```

## 專案結構

```
src/
  session-dashboard.js            核心：掃描、產生 HTML、協議處理
  adapters/
    claude-code.js                Claude Code session 掃描邏輯
    codex.js                      Codex session 掃描邏輯
    shared.js                     兩者共用的工具函式
  install-session-dashboard-hooks.js  安裝 SessionStart hook
commands/sessions.md              Claude Code 自訂指令 /sessions
docs/
  specs/ plans/                   最初的規格與實作計畫
  design/                         個別功能的設計文件（含 sessdash:// 協議、Antigravity 整合規劃）
  adr/                            重要且不易反悔的架構決策紀錄
  agents/                         給 agent 看的專案慣例（issue tracker、triage、domain 文件）
  deploy-log.md                   每次部署的詳細紀錄
.scratch/                         功能拆分的 ticket（本地 issue tracker，無 git remote 依賴）
CONTEXT.md                        領域詞彙表
```

## 設計文件

重要決策與功能規格都在 `docs/` 下，經過多輪獨立 AI 審查（peer review）流程才會蓋上核准標記：

- `docs/specs/2026-08-02-session-dashboard-design.md` — 最初規格
- `docs/design/2026-08-04-protocol-handler-for-hide-rename.md` — `sessdash://` 協議：隱藏／改名
- `docs/design/2026-08-05-protocol-handler-resume-action.md` — `sessdash://` 協議：一鍵續接
- `docs/design/2026-08-03-current-state-and-antigravity-modularization.md` — 現況總覽 + Antigravity 整合規劃

## 現況與後續規劃

目前支援 **Claude Code** 與 **Codex CLI** 兩種工具的 session。**Google Antigravity 尚未整合**——`docs/design/2026-08-03-current-state-and-antigravity-modularization.md` 已完成可行性驗證與資料格式逆向工程（`state.vscdb` 內的 protobuf 結構、欄位對照表），但實作尚未開始，且該文件在最後一次修訂後還沒有重新走過 codex-peer-review。這是目前最大的一塊待辦，之後有空會繼續推進。

## 授權

[MIT](./LICENSE)
