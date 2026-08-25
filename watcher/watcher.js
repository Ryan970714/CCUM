// cc-usage-watcher — watches ~/.claude/projects for new Claude Code transcript data
// and syncs usage records to the cc-usage-dashboard Cloudflare Worker in near-real-time.
//
// Design notes (see plan at C:\Users\10319\.claude\plans\harmonic-conjuring-bumblebee.md):
// - message.id (not the per-line uuid) is the true idempotency key: one assistant response
//   is split across multiple JSONL lines (thinking/text/tool_use) that all carry the same
//   usage. We deliberately do NOT dedupe client-side — the server's INSERT OR IGNORE on
//   message_id absorbs it. This keeps this script simple and stateless w.r.t. dedup.
// - Subagent transcripts live in nested <session>/subagents/agent-*.jsonl files and must be
//   discovered too, not just the top-level <session>.jsonl files.
// - Never lose data: new events are appended to a durable local queue file BEFORE the file
//   offset is advanced, and BEFORE any network attempt. A crash or offline period can only
//   ever produce duplicate re-sends (harmless, deduped server-side), never gaps.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");
const STATE_FILE = path.join(SCRIPT_DIR, "state.json");
const QUEUE_FILE = path.join(SCRIPT_DIR, "pending-queue.jsonl");
const FLUSHING_FILE = path.join(SCRIPT_DIR, "pending-queue.flushing.jsonl");
const CONFIG_FILE = path.join(SCRIPT_DIR, "config.json");
const LOG_FILE = path.join(SCRIPT_DIR, "watcher.log");

const SCAN_DEBOUNCE_MS = 1500;
const FALLBACK_RESCAN_MS = 20_000;
const HEARTBEAT_FLUSH_MS = 30_000;
const BACKOFF_STEPS_MS = [5_000, 15_000, 60_000, 300_000];
const POST_CHUNK_SIZE = 300;

// Rate-limit polling: hits an UNDOCUMENTED Anthropic endpoint using Claude Code's own
// locally-stored OAuth token, to surface real 5h/7d subscription quota utilization on the
// dashboard (not derivable from local transcripts). Community tooling (claude-pulse,
// usage-monitor-for-claude, Claude-Code-Usage-Monitor) converges on: 180s is a safe poll
// interval, and the User-Agent header MUST look like a real Claude Code client or requests
// land in an aggressively-limited bucket and 429 immediately. This endpoint isn't part of
// Anthropic's public API surface and could change or disappear without notice.
const RATE_LIMIT_POLL_MS = 180_000;
const RATE_LIMIT_API_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.229";

// ---------- logging ----------
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // best-effort only
  }
}

// ---------- config ----------
function loadWorkerUrl() {
  if (process.env.CC_USAGE_WORKER_URL) return process.env.CC_USAGE_WORKER_URL;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (cfg.workerUrl && !cfg.workerUrl.includes("<your-subdomain>")) return cfg.workerUrl;
  } catch {
    // no config yet — fine, we just queue locally until one exists
  }
  return null;
}

// ---------- state ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { files: {} };
  }
}

function saveState(state) {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

let state = loadState();

// ---------- project name derivation ----------
function deriveProjectName(cwd) {
  if (!cwd) return "(unknown)";
  const segments = cwd.split(/[\\/]/).filter(Boolean);
  const worktreeIdx = segments.findIndex((s) => /claude-worktrees/i.test(s));
  if (worktreeIdx > 0 && worktreeIdx < segments.length - 1) {
    const mainProject = segments[worktreeIdx - 1];
    const leaf = segments[segments.length - 1];
    return `${mainProject} (worktree: ${leaf})`;
  }
  return segments[segments.length - 1] || cwd;
}

// ---------- subagent meta cache ----------
const metaCache = new Map();
async function agentTypeFor(jsonlPath) {
  if (metaCache.has(jsonlPath)) return metaCache.get(jsonlPath);
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    metaCache.set(jsonlPath, meta.agentType || null);
    return meta.agentType || null;
  } catch {
    return null; // meta file may not exist yet; don't cache the miss, retry later
  }
}

// ---------- discovery ----------
async function discoverJsonlFiles(dir) {
  const found = [];
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(full);
      }
    }
  }
  await walk(dir);
  return found;
}

// ---------- per-file delta read ----------
function toEventDate(isoTimestamp) {
  try {
    return new Date(isoTimestamp).toLocaleDateString("en-CA"); // local timezone, YYYY-MM-DD
  } catch {
    return isoTimestamp?.slice(0, 10) || "";
  }
}

function lineToEvent(obj, filePath) {
  if (obj.type !== "assistant" || !obj.message?.usage) return null;
  const usage = obj.message.usage;
  const isSubagent = /[\\/]subagents[\\/]/.test(filePath);
  return {
    message_id: obj.message.id,
    line_uuid: obj.uuid || null,
    session_id: obj.sessionId,
    project_cwd: obj.cwd,
    project_name: deriveProjectName(obj.cwd),
    is_subagent: isSubagent,
    agent_type: null, // filled in async below if is_subagent
    model: obj.message.model,
    git_branch: obj.gitBranch || null,
    timestamp: obj.timestamp,
    event_date: toEventDate(obj.timestamp),
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    cache_creation_5m_tokens: usage.cache_creation?.ephemeral_5m_input_tokens || 0,
    cache_creation_1h_tokens: usage.cache_creation?.ephemeral_1h_input_tokens || 0,
    thinking_tokens: usage.output_tokens_details?.thinking_tokens || 0,
    service_tier: usage.service_tier || null,
    device_hostname: os.hostname(),
  };
}

async function scanFileDelta(filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return []; // file disappeared between discovery and read; skip this cycle
  }

  const prevOffset = state.files[filePath]?.offset || 0;
  if (stat.size < prevOffset) {
    log("WARN file shrank, resetting offset:", filePath);
    state.files[filePath] = { offset: 0 };
  }
  const offset = state.files[filePath]?.offset || 0;
  if (stat.size <= offset) return [];

  const handle = await fsp.open(filePath, "r");
  let events = [];
  try {
    const length = stat.size - offset;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, offset);

    const lastNewline = buf.lastIndexOf(0x0a); // '\n' — always safe split point in UTF-8
    if (lastNewline === -1) return []; // no complete line yet; wait for more data

    const text = buf.slice(0, lastNewline + 1).toString("utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // skip malformed/partial line
      }
      const ev = lineToEvent(obj, filePath);
      if (ev) events.push(ev);
    }

    if (events.some((e) => e.is_subagent)) {
      const agentType = await agentTypeFor(filePath);
      for (const e of events) if (e.is_subagent) e.agent_type = agentType;
    }

    state.files[filePath] = { offset: offset + lastNewline + 1 };
  } finally {
    await handle.close();
  }
  return events;
}

// ---------- durable queue ----------
async function appendToQueue(events) {
  if (events.length === 0) return;
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fsp.appendFile(QUEUE_FILE, lines);
}

// ---------- scan cycle ----------
let scanTimer = null;
function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(runScanCycle, SCAN_DEBOUNCE_MS);
}

let scanInFlight = false;
async function runScanCycle() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const files = await discoverJsonlFiles(PROJECTS_DIR);
    let total = 0;
    for (const f of files) {
      const events = await scanFileDelta(f);
      if (events.length) {
        await appendToQueue(events);
        total += events.length;
      }
    }
    if (total > 0) {
      saveState(state);
      log(`scanned ${files.length} files, queued ${total} new usage event(s)`);
      triggerFlush();
    }
  } catch (err) {
    log("ERROR scan cycle failed:", err.message);
  } finally {
    scanInFlight = false;
  }
}

// ---------- flush (send queue to Worker) ----------
let flushing = false;
let backoffIdx = 0;
let backoffTimer = null;

async function postBatch(workerUrl, events) {
  const res = await fetch(`${workerUrl.replace(/\/$/, "")}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "cc-usage-watcher", clientId: os.hostname(), events }),
  });
  if (!res.ok) throw new Error(`ingest failed: HTTP ${res.status}`);
  return res.json();
}

async function flushQueue() {
  if (flushing) return;
  const workerUrl = loadWorkerUrl();
  if (!workerUrl) return; // not configured yet — keep queuing locally, try again later

  if (!fs.existsSync(QUEUE_FILE)) return;
  const stat = await fsp.stat(QUEUE_FILE).catch(() => null);
  if (!stat || stat.size === 0) return;

  flushing = true;
  try {
    // Atomically claim the current queue contents so concurrent scan cycles can keep
    // appending to a fresh QUEUE_FILE while we send this snapshot.
    await fsp.rename(QUEUE_FILE, FLUSHING_FILE);

    const raw = await fsp.readFile(FLUSHING_FILE, "utf8");
    const events = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let sent = 0;
    for (let i = 0; i < events.length; i += POST_CHUNK_SIZE) {
      const chunk = events.slice(i, i + POST_CHUNK_SIZE);
      const result = await postBatch(workerUrl, chunk);
      sent += chunk.length;
      log(`flushed batch: ${chunk.length} sent, ${result.inserted} inserted, ${result.ignored_or_duplicate} dup`);
    }

    await fsp.unlink(FLUSHING_FILE).catch(() => {});
    backoffIdx = 0; // success — reset backoff
  } catch (err) {
    log("WARN flush failed, will retry:", err.message);
    // Put the claimed batch back at the front of the queue so nothing is lost, ahead of
    // anything a concurrent scan cycle may have appended to a fresh QUEUE_FILE meanwhile.
    try {
      if (fs.existsSync(FLUSHING_FILE)) {
        const claimed = await fsp.readFile(FLUSHING_FILE, "utf8");
        const current = fs.existsSync(QUEUE_FILE) ? await fsp.readFile(QUEUE_FILE, "utf8") : "";
        await fsp.writeFile(QUEUE_FILE, claimed + current);
        await fsp.unlink(FLUSHING_FILE).catch(() => {});
      }
    } catch (mergeErr) {
      log("ERROR could not restore unsent queue:", mergeErr.message);
    }
    scheduleRetry();
  } finally {
    flushing = false;
  }
}

function scheduleRetry() {
  if (backoffTimer) return; // a retry is already pending
  const delay = BACKOFF_STEPS_MS[Math.min(backoffIdx, BACKOFF_STEPS_MS.length - 1)];
  backoffIdx++;
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    triggerFlush();
  }, delay);
}

function triggerFlush() {
  flushQueue();
}

// ---------- rate-limit polling (5h/7d subscription quota) ----------
function readOAuthToken() {
  let cred;
  try {
    cred = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch (err) {
    log("WARN rate-limit poll: could not read credentials file:", err.message);
    return null;
  }
  const oauth = cred.claudeAiOauth;
  if (!oauth?.accessToken) {
    log("WARN rate-limit poll: no claudeAiOauth.accessToken in credentials file");
    return null;
  }
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
    log("WARN rate-limit poll: OAuth token expired, waiting for Claude Code to refresh it");
    return null;
  }
  return oauth.accessToken;
}

async function pollRateLimits() {
  const workerUrl = loadWorkerUrl();
  if (!workerUrl) return;
  const token = readOAuthToken();
  if (!token) return;

  let data;
  try {
    const res = await fetch(RATE_LIMIT_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      log(`WARN rate-limit poll: HTTP ${res.status} from Anthropic`);
      return;
    }
    data = await res.json();
  } catch (err) {
    log("WARN rate-limit poll: request failed:", err.message);
    return;
  }

  const payload = { ...data, captured_at: new Date().toISOString(), device_hostname: os.hostname() };
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/api/rate-limit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log(
      `rate limits: 5h=${data.five_hour?.utilization ?? "?"}% 7d=${data.seven_day?.utilization ?? "?"}%`
    );
  } catch (err) {
    log("WARN rate-limit poll: failed to push snapshot to Worker:", err.message);
  }
}

// ---------- lifecycle ----------
function setupFsWatch() {
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, () => scheduleScan());
    log("watching (recursive):", PROJECTS_DIR);
  } catch (err) {
    log("WARN recursive fs.watch unavailable, relying on periodic rescan only:", err.message);
  }
}

async function main() {
  log("cc-usage-watcher starting. Projects dir:", PROJECTS_DIR);
  if (!fs.existsSync(PROJECTS_DIR)) {
    log("ERROR projects dir does not exist, nothing to watch:", PROJECTS_DIR);
    process.exit(1);
  }
  if (!loadWorkerUrl()) {
    log("WARN no workerUrl configured yet (see config.example.json) — events will queue locally until it is.");
  }

  setupFsWatch();
  setInterval(scheduleScan, FALLBACK_RESCAN_MS); // belt-and-suspenders periodic rescan
  setInterval(triggerFlush, HEARTBEAT_FLUSH_MS); // recover after offline periods with no fs activity
  setInterval(pollRateLimits, RATE_LIMIT_POLL_MS);

  await runScanCycle(); // initial backfill
  pollRateLimits(); // fire once at startup too, don't wait a full interval

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log(`${sig} received, shutting down`);
      saveState(state);
      process.exit(0);
    });
  }
}

main();
