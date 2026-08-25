# CCUM — Claude Code 用量儀表板

從任何裝置監看自己的 Claude Code token 用量。資料來源是本機 `~/.claude/projects/**/*.jsonl`(Claude Code 的對話紀錄,內建完整 token usage),由本機常駐監控程式即時同步到一個 Cloudflare Worker,再由 Worker 提供一個網頁儀表板。

完整規劃見 [`C:\Users\10319\.claude\plans\harmonic-conjuring-bumblebee.md`](C:\Users\10319\.claude\plans\harmonic-conjuring-bumblebee.md)。

## 架構

```
本機 ~/.claude/projects/**/*.jsonl
  → watcher/watcher.js(常駐監控,近乎即時)
  → POST /api/ingest → Cloudflare Worker → D1 (cc-usage-db)
                              ↓
                     GET /api/usage ← 任何裝置的瀏覽器
```

## 目錄

- [`worker/`](worker/) — Cloudflare Worker:`/api/ingest`、`/api/usage`、`/api/health`,以及 `public/` 底下的儀表板網頁(靜態資源)。
- [`watcher/`](watcher/) — 本機監控程式與 Windows 開機自動啟動設定,見 [`watcher/README.md`](watcher/README.md)。

## 部署

```bash
cd worker
npm install
npx wrangler deploy
```
需要 `wrangler login`(互動登入)或設定 `CLOUDFLARE_API_TOKEN` 環境變數,見規劃檔的「部署流程」小節。

部署完成後,把印出的網址填進 `watcher/config.json`(參考 `watcher/config.example.json`),即可開始同步。

## 功能

- 總量 / 每日趨勢 / 依專案 / 依模型 / 依裝置分類、近期 session
- 本週用量(自週一起)與上週比較的漲跌幅
- 多裝置:每台跑 watcher 的電腦資料會自動匯總在同一個儀表板,見 [watcher/README.md](watcher/README.md#多裝置)
- **沒有**「weekly 配額剩餘 %」——Anthropic 沒有公開這個數字的 API,Claude Code 本機也沒有快取,查證過，只能用爬蟲抓登入態網頁才拿得到,故意不做

## 自動部署

`.github/workflows/deploy.yml`:push 到 `main` 且改動到 `worker/**` 時,自動 `wrangler deploy`。需要 repo 的 Settings → Secrets → Actions 有一組 `CLOUDFLARE_API_TOKEN`(權限:Workers Scripts:Edit、D1:Edit、Account Settings:Read)。

## 注意事項

- 儀表板網址**沒有密碼保護**(使用者已確認接受此風險)。
- 費用欄位是**估算值**(標準牌價換算),你是訂閱制不是按 token 計費,僅供參考。
