# cc-usage-watcher

本機常駐程式,監看 `~/.claude/projects/**/*.jsonl`(Claude Code 的對話紀錄,含 subagent 的巢狀檔案),將 token 用量即時同步到 `cc-usage-dashboard` Worker。

## 多裝置

這個監控程式天生就支援多台電腦同時跑,不需要額外設定——每台裝置各自讀自己的 `~/.claude/projects`,獨立送到同一個 Worker,資料庫用 `message.id` 去重,不會重複計算,還會各自標上 `device_hostname`,在儀表板的「依裝置分類」表格裡分開統計。

要在另一台電腦上啟用:
1. 把整個 `CCUM` 專案(或至少 `watcher/` 這個資料夾)複製過去
2. 照下面「設定」的步驟做一次,`config.json` 的 `workerUrl` 填**同一個**網址(`https://cc-usage-dashboard.rtnexen.workers.dev`)
3. 注意:啟動資料夾機制是「使用者登入時」觸發,如果那台電腦開機後沒人登入 Windows 帳號,監控程式就不會啟動——單純開機、停在鎖定畫面是不夠的。

## 設定

1. Worker 部署完成、拿到網址後,複製 `config.example.json` 為 `config.json`,把 `workerUrl` 換成實際網址:
   ```json
   { "workerUrl": "https://cc-usage-dashboard.<你的-subdomain>.workers.dev" }
   ```
   在設定好之前,監控程式仍會正常掃描並把資料存進本機的 `pending-queue.jsonl`,只是不會送出——不會遺失資料,設定好之後會自動補送。

2. 手動先跑一次確認正常運作(會看到回填既有歷史資料的 log):
   ```bash
   node watcher.js
   ```
   `Ctrl+C` 結束。

3. 開機自動啟動:**已經設定好了**,用的是「啟動資料夾」機制,不是 Task Scheduler。

   原本規劃用 Windows 工作排程器(`install-task.ps1`),但這台電腦的安全政策會擋掉 `Register-ScheduledTask`/`schtasks`(不管是自動化執行還是使用者自己手動跑,都是 Access Denied)。改用不受這個限制的方式:在
   ```
   C:\Users\10319\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\ClaudeUsageWatcher.vbs
   ```
   放一個小的啟動腳本,內容只是呼叫這個資料夾裡的 `run-watcher.vbs`。Windows 登入時會自動執行「啟動資料夾」裡的所有東西,這是作業系統內建的基本功能,已經實測驗證過會正常啟動監控程式。

   `install-task.ps1` 還留著——如果哪天換到一台 Task Scheduler 沒被政策擋住的電腦,可以照原本規劃跑它改用排程工作。

## 檔案說明

- `state.json` — 每個檔案已讀到的 byte offset,重啟不會重複讀取。
- `pending-queue.jsonl` — 尚未成功送出的事件(離線緩衝),送出成功後會清空。
- `watcher.log` — 執行紀錄(啟動資料夾啟動的是隱藏視窗,看不到 console,靠這個檔案除錯)。

## 管理指令

```powershell
Get-Process node                        # 確認程式正在跑
Get-Content watcher.log -Wait -Tail 20  # 即時看 log
```

移除自動啟動:刪除
```
C:\Users\10319\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\ClaudeUsageWatcher.vbs
```
(或按 `Win+R` 打 `shell:startup` 開啟該資料夾用滑鼠刪)。
