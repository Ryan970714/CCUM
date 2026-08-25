const fmtInt = new Intl.NumberFormat("en-US");
const fmtUsd = (n) => `$${(n || 0).toFixed(2)}`;

// Table cells are built with innerHTML for layout convenience — always pass raw field
// values (model names, project names, session ids) through this first. Without it, a
// literal value like Claude Code's internal "<synthetic>" model marker gets parsed as
// an HTML tag and silently disappears from the row instead of displaying as text.
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

let chart = null;
let currentRange = "30d";

function setActiveButton(range) {
  document.querySelectorAll("#range-selector button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === range);
  });
}

function renderStats(totals) {
  document.getElementById("stat-total-tokens").textContent = fmtInt.format(totals.total_tokens || 0);
  document.getElementById("stat-input").textContent = fmtInt.format(totals.input_tokens || 0);
  document.getElementById("stat-output").textContent = fmtInt.format(totals.output_tokens || 0);
  document.getElementById("stat-cache-write").textContent = fmtInt.format(
    (totals.cache_creation_input_tokens || 0)
  );
  document.getElementById("stat-cache-read").textContent = fmtInt.format(totals.cache_read_input_tokens || 0);
  document.getElementById("stat-cost").textContent = fmtUsd(totals.estimated_cost_usd);
}

function renderChart(daily) {
  const labels = daily.map((d) => d.date);
  const datasets = [
    { label: "Input", data: daily.map((d) => d.input_tokens), backgroundColor: "#6b8fd6" },
    { label: "Output", data: daily.map((d) => d.output_tokens), backgroundColor: "#d97757" },
    { label: "Cache 寫入", data: daily.map((d) => d.cache_creation_input_tokens), backgroundColor: "#e0b95a" },
    { label: "Cache 讀取", data: daily.map((d) => d.cache_read_input_tokens), backgroundColor: "#8f8f9c" },
  ];

  const ctx = document.getElementById("daily-chart").getContext("2d");
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: { stacked: true, ticks: { callback: (v) => fmtInt.format(v) } },
      },
      plugins: { legend: { position: "bottom" } },
    },
  });
  document.getElementById("daily-chart").parentElement.style.height = "320px";
}

function renderTable(id, rows, columns, emptyMessage) {
  const tbody = document.querySelector(`#${id} tbody`);
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${columns.length}">${emptyMessage}</td></tr>`;
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = columns.map((col) => `<td>${col(row)}</td>`).join("");
    tbody.appendChild(tr);
  }
}

function relativeTime(iso) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

function renderWeekly(weekly) {
  document.getElementById("week-tokens").textContent = fmtInt.format(weekly.current_week.total_tokens || 0);
  document.getElementById("week-cost").textContent = fmtUsd(weekly.current_week.estimated_cost_usd);

  const changeEl = document.getElementById("week-change");
  if (weekly.change_pct === null) {
    changeEl.textContent = "上週無資料";
    changeEl.className = "stat-value";
  } else {
    const sign = weekly.change_pct >= 0 ? "+" : "";
    changeEl.textContent = `${sign}${weekly.change_pct}%`;
    changeEl.className = "stat-value " + (weekly.change_pct >= 0 ? "week-change-up" : "week-change-down");
  }
}

function renderFetchStatus() {
  const now = new Date();
  document.getElementById("fetch-status").textContent =
    `頁面更新於:${now.toLocaleTimeString("zh-TW", { hour12: false })}`;
}

function renderSyncStatus(lastEventAt) {
  const el = document.getElementById("sync-status");
  if (!lastEventAt) {
    el.textContent = "尚無資料 — 等待本機監控程式回填";
    el.className = "sync-status stale";
    return;
  }
  const diffMin = (Date.now() - new Date(lastEventAt).getTime()) / 60000;
  el.textContent = `上次同步:${relativeTime(lastEventAt)}`;
  el.className = "sync-status " + (diffMin > 5 ? "stale" : "fresh");
  if (diffMin > 5) {
    el.textContent += "(監控程式可能離線)";
  }
}

async function loadUsage(range) {
  currentRange = range;
  setActiveButton(range);
  document.getElementById("sync-status").textContent = "載入中…";

  const res = await fetch(`/api/usage?range=${range}`);
  if (!res.ok) {
    document.getElementById("sync-status").textContent = "載入失敗";
    return;
  }
  const data = await res.json();

  renderStats(data.totals);
  renderChart(data.daily);
  renderSyncStatus(data.last_event_at);
  renderWeekly(data.weekly);
  renderFetchStatus();

  renderTable(
    "project-table",
    data.by_project,
    [
      (r) => esc(r.project_name),
      (r) => fmtInt.format(r.total_tokens),
      (r) => fmtUsd(r.estimated_cost_usd),
      (r) => relativeTime(r.last_active),
    ],
    "尚無資料"
  );

  renderTable(
    "model-table",
    data.by_model,
    [
      (r) => esc(r.model),
      (r) => fmtInt.format(r.event_count),
      (r) => fmtInt.format(r.total_tokens),
      (r) => fmtUsd(r.estimated_cost_usd),
    ],
    "尚無資料"
  );

  renderTable(
    "device-table",
    data.by_device,
    [
      (r) => esc(r.device_hostname),
      (r) => fmtInt.format(r.total_tokens),
      (r) => fmtUsd(r.estimated_cost_usd),
      (r) => relativeTime(r.last_active),
    ],
    "尚無資料"
  );

  renderTable(
    "session-table",
    data.recent_sessions,
    [
      (r) => `<code>${esc(r.session_id.slice(0, 8))}…</code>`,
      (r) => esc(r.project_name),
      (r) => relativeTime(r.last_timestamp),
      (r) => fmtInt.format(r.event_count),
      (r) => fmtInt.format(r.total_tokens),
    ],
    "尚無資料"
  );
}

document.getElementById("range-selector").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-range]");
  if (!btn) return;
  loadUsage(btn.dataset.range);
});

loadUsage(currentRange);
// Light auto-refresh so the dashboard stays live if left open on another device.
setInterval(() => loadUsage(currentRange), 30_000);
