import { estimateCost } from "./pricing.js";

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 };

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_creation_5m_tokens",
  "cache_creation_1h_tokens",
  "thinking_tokens",
];

function cutoffDate(range) {
  const days = RANGE_DAYS[range];
  if (!days) return null; // "all" or unrecognized -> no cutoff
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function emptyTotals() {
  const t = { event_count: 0, total_tokens: 0, estimated_cost_usd: 0 };
  for (const f of TOKEN_FIELDS) t[f] = 0;
  return t;
}

function addRow(acc, row) {
  for (const f of TOKEN_FIELDS) acc[f] += row[f] || 0;
  acc.event_count += row.event_count || 0;
  // thinking_tokens is a subset of output_tokens (display-only breakdown) — excluded here.
  acc.total_tokens +=
    (row.input_tokens || 0) +
    (row.output_tokens || 0) +
    (row.cache_creation_input_tokens || 0) +
    (row.cache_read_input_tokens || 0);
  acc.estimated_cost_usd += estimateCost(row);
}

/**
 * Fetch (event_date, model) grouped raw sums for the given range. Cost is computed
 * per (date, model) group in JS (via pricing.js) since it's price-per-model, then
 * re-aggregated up to whatever granularity the caller needs (daily / totals).
 */
async function fetchDailyByModel(db, cutoff) {
  const where = cutoff ? "WHERE event_date >= ?" : "";
  const binds = cutoff ? [cutoff] : [];
  const sql = `
    SELECT event_date, model,
      COUNT(*) as event_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
      SUM(cache_read_input_tokens) as cache_read_input_tokens,
      SUM(cache_creation_5m_tokens) as cache_creation_5m_tokens,
      SUM(cache_creation_1h_tokens) as cache_creation_1h_tokens,
      SUM(thinking_tokens) as thinking_tokens
    FROM usage_events
    ${where}
    GROUP BY event_date, model
    ORDER BY event_date ASC
  `;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results;
}

async function fetchByProjectByModel(db, cutoff) {
  const where = cutoff ? "WHERE event_date >= ?" : "";
  const binds = cutoff ? [cutoff] : [];
  const sql = `
    SELECT project_name, model,
      COUNT(*) as event_count,
      MAX(timestamp) as last_active,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
      SUM(cache_read_input_tokens) as cache_read_input_tokens,
      SUM(cache_creation_5m_tokens) as cache_creation_5m_tokens,
      SUM(cache_creation_1h_tokens) as cache_creation_1h_tokens,
      SUM(thinking_tokens) as thinking_tokens
    FROM usage_events
    ${where}
    GROUP BY project_name, model
  `;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results;
}

async function fetchByDeviceByModel(db, cutoff) {
  const where = cutoff ? "WHERE event_date >= ?" : "";
  const binds = cutoff ? [cutoff] : [];
  const sql = `
    SELECT COALESCE(device_hostname, '(unknown)') as device_hostname, model,
      COUNT(*) as event_count,
      MAX(timestamp) as last_active,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
      SUM(cache_read_input_tokens) as cache_read_input_tokens,
      SUM(cache_creation_5m_tokens) as cache_creation_5m_tokens,
      SUM(cache_creation_1h_tokens) as cache_creation_1h_tokens,
      SUM(thinking_tokens) as thinking_tokens
    FROM usage_events
    ${where}
    GROUP BY device_hostname, model
  `;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results;
}

async function fetchByModel(db, cutoff) {
  const where = cutoff ? "WHERE event_date >= ?" : "";
  const binds = cutoff ? [cutoff] : [];
  const sql = `
    SELECT model,
      COUNT(*) as event_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
      SUM(cache_read_input_tokens) as cache_read_input_tokens,
      SUM(cache_creation_5m_tokens) as cache_creation_5m_tokens,
      SUM(cache_creation_1h_tokens) as cache_creation_1h_tokens,
      SUM(thinking_tokens) as thinking_tokens
    FROM usage_events
    ${where}
    GROUP BY model
    ORDER BY event_count DESC
  `;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results.map((row) => ({
    model: row.model,
    event_count: row.event_count,
    total_tokens:
      (row.input_tokens || 0) +
      (row.output_tokens || 0) +
      (row.cache_creation_input_tokens || 0) +
      (row.cache_read_input_tokens || 0),
    estimated_cost_usd: estimateCost(row),
  }));
}

async function fetchRecentSessions(db, cutoff, limit = 20) {
  const where = cutoff ? "WHERE event_date >= ?" : "";
  const binds = cutoff ? [cutoff, limit] : [limit];
  const sql = `
    SELECT session_id, project_name,
      MAX(timestamp) as last_timestamp,
      COUNT(*) as event_count,
      SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) as total_tokens
    FROM usage_events
    ${where}
    GROUP BY session_id
    ORDER BY last_timestamp DESC
    LIMIT ?
  `;
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results;
}

// Monday-start calendar week, based on the Worker's (UTC) clock. event_date strings are
// plain YYYY-MM-DD written using the watcher machine's local calendar day, so this is a
// simple string/date comparison — a rare near-midnight mismatch across timezones is an
// acceptable trade-off for not needing per-viewer timezone plumbing.
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchRangeByModel(db, startDate, endDateExclusive) {
  const sql = `
    SELECT model,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
      SUM(cache_read_input_tokens) as cache_read_input_tokens,
      SUM(cache_creation_5m_tokens) as cache_creation_5m_tokens,
      SUM(cache_creation_1h_tokens) as cache_creation_1h_tokens,
      SUM(thinking_tokens) as thinking_tokens,
      COUNT(*) as event_count
    FROM usage_events
    WHERE event_date >= ? AND event_date < ?
    GROUP BY model
  `;
  const { results } = await db.prepare(sql).bind(startDate, endDateExclusive).all();
  const totals = emptyTotals();
  for (const row of results) addRow(totals, row);
  return {
    total_tokens: totals.total_tokens,
    estimated_cost_usd: Math.round(totals.estimated_cost_usd * 100) / 100,
    event_count: totals.event_count,
  };
}

async function getWeeklyComparison(db) {
  const now = new Date();
  const thisMonday = mondayOf(now);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); // exclusive upper bound for "up to now"

  const [currentWeek, previousWeek] = await Promise.all([
    fetchRangeByModel(db, toDateStr(thisMonday), toDateStr(tomorrow)),
    fetchRangeByModel(db, toDateStr(lastMonday), toDateStr(thisMonday)),
  ]);

  const change =
    previousWeek.total_tokens > 0
      ? Math.round(((currentWeek.total_tokens - previousWeek.total_tokens) / previousWeek.total_tokens) * 1000) / 10
      : null; // no prior-week data to compare against

  return {
    week_start: toDateStr(thisMonday),
    current_week: currentWeek,
    previous_week: { ...previousWeek, week_start: toDateStr(lastMonday) },
    change_pct: change,
  };
}

async function fetchLastEventAt(db) {
  const { results } = await db
    .prepare("SELECT MAX(timestamp) as last_event_at FROM usage_events")
    .all();
  return results[0]?.last_event_at || null;
}

export async function getUsageSummary(db, range) {
  const cutoff = cutoffDate(range);

  const [dailyByModel, projectByModel, deviceByModel, byModel, recentSessions, lastEventAt, weekly] =
    await Promise.all([
      fetchDailyByModel(db, cutoff),
      fetchByProjectByModel(db, cutoff),
      fetchByDeviceByModel(db, cutoff),
      fetchByModel(db, cutoff),
      fetchRecentSessions(db, cutoff),
      fetchLastEventAt(db),
      getWeeklyComparison(db), // always all-time-window-independent — "this week" vs "last week"
    ]);

  // Re-aggregate (date, model) rows -> one entry per date, and a grand total.
  const dailyMap = new Map();
  const totals = emptyTotals();
  for (const row of dailyByModel) {
    if (!dailyMap.has(row.event_date)) {
      dailyMap.set(row.event_date, { date: row.event_date, ...emptyTotals() });
    }
    addRow(dailyMap.get(row.event_date), row);
    addRow(totals, row);
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Re-aggregate (project, model) rows -> one entry per project.
  const projectMap = new Map();
  for (const row of projectByModel) {
    if (!projectMap.has(row.project_name)) {
      projectMap.set(row.project_name, {
        project_name: row.project_name,
        last_active: row.last_active,
        ...emptyTotals(),
      });
    }
    const acc = projectMap.get(row.project_name);
    addRow(acc, row);
    if (row.last_active > acc.last_active) acc.last_active = row.last_active;
  }
  const byProject = [...projectMap.values()].sort((a, b) => b.total_tokens - a.total_tokens);

  // Re-aggregate (device, model) rows -> one entry per device.
  const deviceMap = new Map();
  for (const row of deviceByModel) {
    if (!deviceMap.has(row.device_hostname)) {
      deviceMap.set(row.device_hostname, {
        device_hostname: row.device_hostname,
        last_active: row.last_active,
        ...emptyTotals(),
      });
    }
    const acc = deviceMap.get(row.device_hostname);
    addRow(acc, row);
    if (row.last_active > acc.last_active) acc.last_active = row.last_active;
  }
  const byDevice = [...deviceMap.values()].sort((a, b) => b.total_tokens - a.total_tokens);

  return {
    generated_at: new Date().toISOString(),
    range,
    totals: {
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      cache_creation_input_tokens: totals.cache_creation_input_tokens,
      cache_read_input_tokens: totals.cache_read_input_tokens,
      thinking_tokens: totals.thinking_tokens,
      total_tokens: totals.total_tokens,
      estimated_cost_usd: Math.round(totals.estimated_cost_usd * 100) / 100,
      event_count: totals.event_count,
    },
    daily: daily.map((d) => ({
      date: d.date,
      input_tokens: d.input_tokens,
      output_tokens: d.output_tokens,
      cache_creation_input_tokens: d.cache_creation_input_tokens,
      cache_read_input_tokens: d.cache_read_input_tokens,
      total_tokens: d.total_tokens,
      estimated_cost_usd: Math.round(d.estimated_cost_usd * 100) / 100,
    })),
    by_project: byProject.map((p) => ({
      project_name: p.project_name,
      event_count: p.event_count,
      total_tokens: p.total_tokens,
      estimated_cost_usd: Math.round(p.estimated_cost_usd * 100) / 100,
      last_active: p.last_active,
    })),
    by_device: byDevice.map((d) => ({
      device_hostname: d.device_hostname,
      event_count: d.event_count,
      total_tokens: d.total_tokens,
      estimated_cost_usd: Math.round(d.estimated_cost_usd * 100) / 100,
      last_active: d.last_active,
    })),
    by_model: byModel,
    recent_sessions: recentSessions,
    last_event_at: lastEventAt,
    weekly,
  };
}
