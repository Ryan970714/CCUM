// Hardcoded model pricing, USD per 1M tokens, standard (non-promotional) list price.
// Priced as of 2026-08-25 — re-check against https://www.anthropic.com/pricing periodically,
// especially cache write/read multipliers below, which are the standard Anthropic ratios
// but were not independently re-verified against the live pricing page for this build.
// This is ONLY used to render an "estimated equivalent API cost" on a subscription account
// that isn't actually billed per token — never treat these numbers as authoritative billing.
const MODEL_PRICING = [
  { match: /opus-5|opus-4-[6-8]/i, input: 5.0, output: 25.0 },
  { match: /sonnet-5|sonnet-4-6/i, input: 3.0, output: 15.0 },
  { match: /haiku-4-5/i, input: 1.0, output: 5.0 },
];

// Cache write/read multipliers relative to base input price (standard Anthropic ratios).
const CACHE_5M_MULTIPLIER = 1.25;
const CACHE_1H_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

// Fallback rate for unrecognized/future model names, so the dashboard never throws —
// it uses the Sonnet-tier rate as a reasonable middle-ground default.
const FALLBACK_PRICING = { input: 3.0, output: 15.0 };

export const PRICING_AS_OF = "2026-08-25";
export const PRICING_NOTE =
  "Estimated equivalent API cost using standard list pricing — you're on a flat-rate " +
  "subscription and are not actually billed per token. Cache multipliers are approximate. " +
  "See anthropic.com/pricing for current official rates.";

function ratesFor(model) {
  const found = MODEL_PRICING.find((p) => p.match.test(model || ""));
  return found || FALLBACK_PRICING;
}

/**
 * Estimate USD cost for one usage_events row (or any object with the same token fields).
 * Returns a number rounded to 6 decimal places.
 */
export function estimateCost(row) {
  const { input, output } = ratesFor(row.model);
  const M = 1_000_000;

  // Note: thinking_tokens is a breakdown/subset of output_tokens (not additional on top of
  // it), confirmed against a real transcript sample where thinking_tokens < output_tokens.
  // It's stored separately only for display purposes, so it must not be added again here.
  const inputCost = ((row.input_tokens || 0) / M) * input;
  const outputCost = ((row.output_tokens || 0) / M) * output;
  const cache5mCost = ((row.cache_creation_5m_tokens || 0) / M) * input * CACHE_5M_MULTIPLIER;
  const cache1hCost = ((row.cache_creation_1h_tokens || 0) / M) * input * CACHE_1H_MULTIPLIER;
  const cacheReadCost = ((row.cache_read_input_tokens || 0) / M) * input * CACHE_READ_MULTIPLIER;

  const total = inputCost + outputCost + cache5mCost + cache1hCost + cacheReadCost;
  return Math.round(total * 1e6) / 1e6;
}

export function isKnownModel(model) {
  return MODEL_PRICING.some((p) => p.match.test(model || ""));
}
