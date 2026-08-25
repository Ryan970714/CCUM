import { getUsageSummary } from "./queries.js";

const INSERT_SQL = `
  INSERT OR IGNORE INTO usage_events (
    message_id, line_uuid, session_id, project_cwd, project_name,
    is_subagent, agent_type, model, git_branch, timestamp, event_date,
    input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation_5m_tokens, cache_creation_1h_tokens, thinking_tokens, service_tier,
    device_hostname
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const REQUIRED_FIELDS = [
  "message_id",
  "session_id",
  "project_cwd",
  "project_name",
  "model",
  "timestamp",
  "event_date",
];

const BATCH_SIZE = 100;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function toStatement(db, ev) {
  return db
    .prepare(INSERT_SQL)
    .bind(
      ev.message_id,
      ev.line_uuid ?? null,
      ev.session_id,
      ev.project_cwd,
      ev.project_name,
      ev.is_subagent ? 1 : 0,
      ev.agent_type ?? null,
      ev.model,
      ev.git_branch ?? null,
      ev.timestamp,
      ev.event_date,
      ev.input_tokens ?? 0,
      ev.output_tokens ?? 0,
      ev.cache_creation_input_tokens ?? 0,
      ev.cache_read_input_tokens ?? 0,
      ev.cache_creation_5m_tokens ?? 0,
      ev.cache_creation_1h_tokens ?? 0,
      ev.thinking_tokens ?? 0,
      ev.service_tier ?? null,
      ev.device_hostname ?? null
    );
}

async function handleIngest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, { status: 400 });
  }

  const events = Array.isArray(body?.events) ? body.events : [];
  if (events.length === 0) {
    return json({ received: 0, inserted: 0, ignored_or_duplicate: 0, rejected: 0 });
  }

  const valid = [];
  let rejected = 0;
  for (const ev of events) {
    if (ev && REQUIRED_FIELDS.every((f) => ev[f] !== undefined && ev[f] !== null && ev[f] !== "")) {
      valid.push(ev);
    } else {
      rejected++;
    }
  }

  let changes = 0;
  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const chunk = valid.slice(i, i + BATCH_SIZE).map((ev) => toStatement(env.DB, ev));
    const results = await env.DB.batch(chunk);
    for (const r of results) changes += r.meta?.changes || 0;
  }

  return json({
    received: events.length,
    inserted: changes,
    ignored_or_duplicate: valid.length - changes,
    rejected,
  });
}

async function handleUsage(request, env) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "30d";
  const allowed = new Set(["7d", "30d", "90d", "all"]);
  const safeRange = allowed.has(range) ? range : "30d";
  const summary = await getUsageSummary(env.DB, safeRange);
  return json(summary);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }
    if (url.pathname === "/api/ingest" && request.method === "POST") {
      return handleIngest(request, env);
    }
    if (url.pathname === "/api/usage" && request.method === "GET") {
      return handleUsage(request, env);
    }
    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, { status: 404 });
    }

    // Everything else falls through to the static dashboard assets.
    return env.ASSETS.fetch(request);
  },
};
