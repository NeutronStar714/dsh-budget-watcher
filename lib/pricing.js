// Prices for models that are not DeepSeek's.
//
// DeepSeek publishes its own rates in CNY and USD, so it needs nothing from here.
// Every other provider publishes USD only, and the account's balance is usually
// CNY — which is why this module never returns a number it cannot justify. When a
// USD price has to be shown in CNY and there is no rate available, the model is
// reported as unpriced rather than converted at a guess.
//
// The rate source is OpenRouter's public model list: free, no key, and its four
// price buckets (`prompt`, `completion`, `input_cache_read`, `input_cache_write`)
// are exactly the three-plus-one this plugin already prices, so nothing has to be
// reinterpreted on the way in.
//
// Its prices are OpenRouter's. For most models that is the provider's own list
// price, but a model routed through OpenRouter can carry their margin — an
// estimate, not your invoice. That belongs in the README, not hidden here.

/** OpenRouter's public model list. No auth, ~466 models at the time of writing. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Prices move rarely; a day is plenty and keeps the request count trivial. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * How long to wait before trying again after a failure.
 *
 * The panel polls every few seconds. A failure caches nothing, so without this
 * every poll would retry the model list — a dead endpoint hammered forever.
 * Attempts are rate-limited, not just successes.
 */
const DEFAULT_RETRY_MS = 10 * 60 * 1000;

/** OpenRouter quotes per token; this plugin's whole rate card is per million. */
const PER_MILLION = 1_000_000;

/**
 * One canonical key for a model name, so spellings of the same model meet.
 *
 * Three differences show up in real session logs, and each one silently turns a
 * priced model into an unpriced one:
 *
 *  - OpenRouter writes version numbers with dots (`claude-sonnet-4.6`) while
 *    adapters and users write hyphens (`claude-sonnet-4-6`).
 *  - A dated snapshot suffix (`claude-sonnet-4-5-20250929`) names a model the
 *    list carries undated. The date is dropped, never matched literally, so a
 *    name only resolves when the model itself is listed.
 *  - A vendor prefix the session spells differently (`zai/glm-5.3-flash`
 *    against `z-ai/glm-5.3-flash`). The prefix survives in the canonical form
 *    of the full id, so this only ever matches through the bare name — one
 *    model per bare name, the same rule the exact match already follows.
 *
 * Applied to both sides — the list on the way in, the session's name on the way
 * out — so a lookup tries the exact id, the exact bare name, and then these
 * canonical spellings, in that order.
 *
 * @param {unknown} name
 * @returns {string}
 */
function canonicalName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/-\d{8}(?:-\d{6})?$/, "")
    .replace(/_/g, "-")
    .replace(/\./g, "-");
}

/**
 * OpenRouter quotes per token; this plugin's whole rate card is per million.
 *
 * Rounded, because the multiply is not exact in binary floating point —
 * `0.0000002 * 1e6` is `0.19999999999999998`, and a rate table full of that would
 * surface in the panel as `≈¥14.000000000001`. Six decimals is far below any
 * published price and far above the noise.
 */
function perMillion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.round(numeric * PER_MILLION * 1e6) / 1e6;
}

/**
 * Turn OpenRouter's model list into a rate card keyed the way sessions name models.
 *
 * Pure, so the arithmetic and the key handling are testable without a network.
 *
 * @param {unknown} json the parsed /api/v1/models body.
 * @returns {{byId: Map<string, object>, byBareName: Map<string, object>, byCanonical: Map<string, object>, size: number}}
 */
export function parseOpenRouterModels(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  const byId = new Map();
  const byBareName = new Map();
  const byCanonical = new Map();

  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id : "";
    if (id === "") continue;
    const pricing = row?.pricing ?? {};
    const cacheMiss = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    // Without the two prices that dominate a turn's cost, this row cannot price
    // anything; a half-known model is worse than an honestly unpriced one.
    if (cacheMiss === undefined || output === undefined) continue;

    const entry = {
      id,
      label: typeof row?.name === "string" && row.name !== "" ? row.name : id,
      // A model with no cache price is billed as uncached input, which is the
      // conservative reading and the only one the published numbers support.
      cacheMiss,
      cacheHit: perMillion(pricing.input_cache_read) ?? cacheMiss,
      cacheWrite: perMillion(pricing.input_cache_write) ?? cacheMiss,
      output,
    };

    byId.set(id.toLowerCase(), entry);
    const bare = (id.split("/").pop() ?? id).toLowerCase();
    // First write wins for a bare name: the list is ordered by prominence, so the
    // first entry for a given suffix is the one a session most likely named.
    if (!byBareName.has(bare)) byBareName.set(bare, entry);

    // The canonical map folds the spelling variants onto one key, under the same
    // first-write-wins rule. Two distinct ids that collide here are one model
    // with two spellings far more often than two models — and `:batch` keeps its
    // colon, so a batch row never displaces its interactive twin.
    const canonicalId = canonicalName(id);
    if (canonicalId !== "" && !byCanonical.has(canonicalId)) byCanonical.set(canonicalId, entry);
    const canonicalBare = canonicalName(bare);
    if (canonicalBare !== "" && !byCanonical.has(canonicalBare)) byCanonical.set(canonicalBare, entry);
  }

  return { byId, byBareName, byCanonical, size: byId.size };
}

/**
 * Find the entry a session's model string refers to.
 *
 * DSH records whatever the provider's adapter reports, which is usually the bare
 * model id — `claude-sonnet-4-5` — while OpenRouter lists `anthropic/claude-sonnet-4-5`.
 * So the exact id is tried first, then the bare name, then the canonical
 * spellings of both, which is what lets `claude-sonnet-4-5-20250929`,
 * `zai/glm-5.3-flash` and `gemini_2.5_pro` reach the models they name.
 *
 * @param {{byId: Map<string, object>, byBareName: Map<string, object>, byCanonical?: Map<string, object>}} index
 * @param {string} model
 */
export function resolveOpenRouter(index, model) {
  const name = String(model ?? "").trim().toLowerCase();
  if (name === "") return undefined;
  const direct = index.byId.get(name) ?? index.byBareName.get(name);
  if (direct !== undefined) return direct;

  const byCanonical = index.byCanonical;
  if (byCanonical === undefined) return undefined;
  const bare = name.slice(name.lastIndexOf("/") + 1);
  return byCanonical.get(canonicalName(name)) ?? byCanonical.get(canonicalName(bare));
}

/**
 * A price book that stays current without ever blocking a cost estimate.
 *
 * `lookup` answers in the currency the caller is displaying. A USD-priced model
 * shown in CNY is converted with the supplied rate, and if there is no rate it
 * returns `undefined` — the caller reports the turn as unpriced, which is visible,
 * rather than as a converted guess, which is not.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {boolean} [options.enabled] false to stay on the bundled table only.
 * @param {number} [options.ttlMs]
 * @param {number} [options.timeoutMs]
 * @param {() => number} [options.now]
 * @param {object} [options.bundled] model id -> {currency, cacheHit, cacheMiss, output}
 *   Prices published in a currency other than USD — DeepSeek's, or a Chinese
 *   provider's own CNY table. These win over anything fetched, because they come
 *   from the provider whose invoice the user actually pays.
 */
export function createPriceBook({ fetchImpl = fetch, enabled = true, ttlMs = DEFAULT_TTL_MS, retryMs = DEFAULT_RETRY_MS, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, bundled = {} } = {}) {
  const bundledIndex = new Map();
  for (const [key, entry] of Object.entries(bundled)) {
    bundledIndex.set(String(key).trim().toLowerCase(), { source: "bundled", ...entry });
  }

  let fetched; // { index, fetchedAtMs, fetchedAt }
  /** When the last attempt started, successful or not. */
  let lastAttemptMs = 0;
  let inflight;

  async function fetchOnce(force) {
    // Joining an in-flight attempt comes first: otherwise a concurrent caller
    // would mistake the attempt it is waiting on for a recent failure and back off.
    if (inflight !== undefined) return inflight;
    if (!force && lastAttemptMs !== 0 && now() - lastAttemptMs < retryMs) return undefined;
    lastAttemptMs = now();
    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(OPENROUTER_MODELS_URL, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response?.ok) return undefined;
        const index = parseOpenRouterModels(await response.json());
        if (index.size === 0) return undefined;
        fetched = { index, fetchedAtMs: now(), fetchedAt: new Date().toISOString() };
        return fetched;
      } catch {
        // Offline, blocked, timed out, or a body that is not the list. The bundled
        // table and any previous fetch still stand.
        return undefined;
      } finally {
        clearTimeout(timer);
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    /** Refresh if the TTL has passed. Never throws; failure is not an error here. */
    async refresh(force = false) {
      if (enabled === false) return false;
      if (fetched !== undefined && !force && now() - fetched.fetchedAtMs < ttlMs) return true;
      return (await fetchOnce(force)) !== undefined;
    },

    /**
     * @param {string} model
     * @param {object} [options]
     * @param {string} [options.currency] the currency to answer in.
     * @param {number} [options.usdToCny] required to answer a USD price in CNY.
     * @returns {{cacheHit: number, cacheMiss: number, output: number, currency: string, source: string, label: string} | undefined}
     */
    lookup(model, { currency = "USD", usdToCny = 0 } = {}) {
      const name = String(model ?? "").trim().toLowerCase();
      if (name === "") return undefined;

      const fromBundle = bundledIndex.get(name);
      if (fromBundle !== undefined) {
        const native = String(fromBundle.currency ?? "USD").toUpperCase();
        return convert(fromBundle, native, currency, usdToCny, "bundled");
      }

      if (fetched === undefined) return undefined;
      const entry = resolveOpenRouter(fetched.index, name);
      if (entry === undefined) return undefined;
      return convert(entry, "USD", currency, usdToCny, "openrouter");
    },

    /** What the book knows right now, without touching the network. */
    snapshot() {
      return {
        bundled: bundledIndex.size,
        fetched: fetched === undefined ? 0 : fetched.index.size,
        fetchedAt: fetched?.fetchedAt ?? null,
        stale: fetched === undefined ? true : now() - fetched.fetchedAtMs >= ttlMs,
        enabled: enabled !== false,
      };
    },
  };
}

/**
 * Express one entry's prices in the requested currency.
 *
 * Only USD→CNY is supported, because USD and CNY are the only two currencies any
 * of these providers publish in. Converting in the other direction would be a
 * different number arrived at by dividing, and nothing here needs it.
 */
function convert(entry, native, currency, usdToCny, source) {
  const wanted = String(currency ?? "USD").toUpperCase();
  const scale = native === wanted ? 1 : native === "USD" && wanted === "CNY" && usdToCny > 0 ? usdToCny : 0;
  // No rate means no answer. Silently returning USD under a CNY heading is exactly
  // the kind of wrong that looks right.
  if (scale === 0) return undefined;
  return {
    label: entry.label ?? entry.id ?? "",
    cacheHit: entry.cacheHit * scale,
    cacheMiss: entry.cacheMiss * scale,
    output: entry.output * scale,
    currency: wanted,
    source,
  };
}
