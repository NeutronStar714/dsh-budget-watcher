// dsh-budget-watcher — host half.
//
// Answers one question for the client half: how much topped-up balance is left
// on the API account this profile is using? Today that means exactly one
// provider, DeepSeek's public `GET /user/balance`, whose `topped_up_balance`
// field is the money the user actually paid in — as opposed to the promotional
// `granted_balance` that expires.
//
// Three design constraints shape this file:
//
//  * The provider call needs the user's API key, so it can only happen here, in
//    the host. A browser cannot call api.deepseek.com: the key would be exposed
//    and the API sends no CORS headers.
//  * One poll must serve every open window, so the last answer is cached and
//    concurrent requests share a single in-flight upstream call.
//  * Nothing here may take the profile down. Every optional service is read with
//    `ctx.get`, every import that could fail is dynamic, and a fetch failure is
//    reported as a state the widget renders rather than an exception that
//    escapes into the loader.

import { describeHttpFailure, normalizeBalance, pickWallet } from "./lib/balance.js";
import { COST_CURRENCIES, normalizeCostCurrency } from "./lib/cost.js";
import { createFxCache, parseFxSetting } from "./lib/fx.js";
import { createCostLedger } from "./lib/ledger.js";
import { createPriceBook } from "./lib/pricing.js";

/** Base path for this plugin's routes. Owned by the plugin, outside `/api`. */
const ROUTE_BASE = "/dsh-budget-watcher";
const STATE_PATH = `${ROUTE_BASE}/balance`;
/** Write path for the settings tab. Same fence, JSON body required. */
const CONFIG_PATH = `${ROUTE_BASE}/config`;

/** Refuse to buffer more than this from the balance endpoint. */
const MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_REFRESH_MS = 60_000;
const MIN_REFRESH_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * Window for the live burn rate.
 *
 * Short on purpose. This is the number that catches a sudden loss, so it has to
 * be sensitive rather than smooth; the trade is that it reads 0 whenever nothing
 * has settled recently, which is honest — nothing *is* being spent at that
 * instant. `averageBurnPerHour` is the stable companion figure.
 */
const DEFAULT_BURN_WINDOW_MS = 15 * 1000;
const MIN_BURN_WINDOW_MS = 5 * 1000;
/** Per-hour rate above which the panel flags the spend. In the balance's own currency. */
const DEFAULT_BURN_WARN_PER_HOUR = 2;
/**
 * Per-hour rate above which the running turn is interrupted. **0 disables it,
 * and that is the default**: stopping a task is destructive and the rate is an
 * estimate, so it has to be asked for.
 */
const DEFAULT_TERMINATE_PER_HOUR = 0;

/**
 * Reported in every payload.
 *
 * A host plugin's module is imported once and cached for the life of the DSH
 * process, so editing a loaded plugin's source has no effect until that process
 * restarts. Without a marker in the response there is no way to tell a stale
 * module from a plugin that simply has nothing to report — which is exactly the
 * confusion this field exists to end. Keep it in step with package.json.
 */
const PLUGIN_VERSION = "0.2.0";

/**
 * Providers this plugin can read. Only DeepSeek is implemented; the table
 * exists so a second provider is an addition rather than a rewrite of the
 * request path, which is the shape the feature was asked for.
 *
 * `credentialRef` is an environment-variable-style name resolved through
 * `ctx.credentials` — `DEEPSEEK_API_KEY` is the same reference the shipped
 * DeepSeek LLM adapter uses, so one key configured in the Models page serves
 * both inference and this widget.
 */
const PROVIDERS = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/user/balance",
    credentialRef: "DEEPSEEK_API_KEY",
  },
};

// schemastery gives the profile real validation and a settings UI. It is
// imported dynamically because a third-party plugin must keep working when the
// import fails: a static import of a package this installation does not carry
// would stop the whole profile from loading, which is a far worse outcome than
// losing config validation.
let Schema;
try {
  ({ default: Schema } = await import("@deepseek-ai/schemastery"));
} catch {
  Schema = undefined;
}

/** Validated configuration, or `undefined` when schemastery is unavailable. */
export const Config = Schema?.object({
  provider: Schema.string().default("deepseek").description("Which API account to read. Only `deepseek` is implemented."),
  apiKey: Schema.string().role("secret").description("Explicit API key. When empty, the key is resolved from the credential reference below."),
  apiKeyEnv: Schema.string().default("DEEPSEEK_API_KEY").description("Credential reference holding the API key, resolved through the credentials service."),
  endpoint: Schema.string().description("Override the balance endpoint. Meant for testing against a stand-in server."),
  refreshIntervalMs: Schema.natural().min(MIN_REFRESH_MS).default(DEFAULT_REFRESH_MS).description(`How long the host reuses one balance answer before calling DeepSeek again, in milliseconds (minimum ${MIN_REFRESH_MS}). This governs the upstream API call, not how often the panel polls — the panel polls its own local route every few seconds so a new turn is noticed promptly.`),
  requestTimeoutMs: Schema.natural().min(1000).max(120_000).default(DEFAULT_TIMEOUT_MS).description("Deadline for one balance request, in milliseconds."),
  currency: Schema.string().default("auto").description("Which wallet to feature, and therefore which currency the cost estimates are priced in: `auto`, `CNY` or `USD`. DeepSeek publishes its rates in CNY and USD, so no exchange rate is involved."),
  allowNonLoopback: Schema.boolean().default(false).description("Allow the widget to read balance when the GUI is served on a non-loopback address. Off by default: the route trusts its host, which is only sound on loopback."),
  costEnabled: Schema.boolean().default(true).description("Estimate what recent turns cost, from the token usage the provider already reports on every assistant message. Costs nothing extra: no API call and no tokens are spent."),
  graphEnabled: Schema.boolean().default(true).description("Draw the live-burn chart in the panel: this turn's burn rate against its own elapsed time, with the warn and terminate lines across it."),
  burnWindowMs: Schema.natural().min(MIN_BURN_WINDOW_MS).default(DEFAULT_BURN_WINDOW_MS).description(`Window for the live burn rate, in milliseconds (minimum ${MIN_BURN_WINDOW_MS}). Short by design: this is the figure that catches a sudden loss, so it is sensitive rather than smooth.`),
  burnWarnPerHour: Schema.number().min(0).default(DEFAULT_BURN_WARN_PER_HOUR).description("Per-hour spend above which the panel turns amber. In the balance's own currency (CNY for a CNY account, USD for a USD one). 0 disables the warning."),
  terminateAbovePerHour: Schema.number().min(0).default(DEFAULT_TERMINATE_PER_HOUR).description("Per-hour spend above which the running turn is interrupted, exactly as if you pressed stop. In the balance's own currency. 0 disables it, and 0 is the default: interrupting a task is destructive and the rate is an estimate, so it has to be asked for deliberately."),
  // Deliberately untyped.
  //
  // This field is either the string `auto` or a number, so `Schema.string()` looks
  // right — but a validation failure here does not degrade a feature, it stops the
  // plugin activating at all: cordis refuses the fiber, the route is never
  // registered, and the panel reports that it cannot reach dsh. A config row of
  // `usdToCny: 7.2` is a YAML number, and that took the whole plugin offline.
  //
  // So the schema accepts anything, and `parseFxSetting` is the real gate: `auto`
  // or a positive number, and anything else falls back to `auto`. A loose type is
  // the right trade when the failure mode is "the plugin disappears".
  usdToCny: Schema.any().default("auto").description("Exchange rate for models priced in USD by a third party. `auto` fetches the European Central Bank's daily reference rate; a number (for example `7.2`) uses that rate instead and makes no network request. Only DeepSeek publishes CNY prices, so this is what lets every other provider's cost appear in a CNY total."),
});

/**
 * Read the API key at the moment of the call.
 *
 * Resolution is deliberately not cached: a key saved from the Models page
 * reaches the next poll without restarting anything, which is what the
 * credentials service promises its consumers.
 *
 * @returns {Promise<{ value: string, source: string } | undefined>}
 */
async function resolveApiKey(ctx, settings) {
  if (settings.apiKey !== "") return { value: settings.apiKey, source: "config" };

  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    // `credentialRef` is a branded string at runtime, so the plain name the
    // config already holds is a valid reference.
    const hit = await credentials.resolve(settings.apiKeyEnv);
    if (hit !== undefined && hit.value !== "") return { value: hit.value, source: hit.source ?? "credentials" };
  }

  const ambient = process.env[settings.apiKeyEnv];
  if (typeof ambient === "string" && ambient !== "") return { value: ambient, source: "environment" };
  return undefined;
}

/**
 * Fetch and normalize one balance answer.
 *
 * `redirect: "error"` keeps a bearer token from being replayed to whatever a
 * redirect points at. The proxy is not configured here on purpose: the launcher
 * installs one global dispatcher before any plugin loads, and passing our own
 * would silently bypass it.
 *
 * @returns {Promise<{ ok: true, isAvailable: boolean, wallets: object[] }
 *   | { ok: false, code: string, message: string }>}
 */
async function fetchBalance(ctx, settings, provider, signal) {
  const key = await resolveApiKey(ctx, settings);
  if (key === undefined) {
    return {
      ok: false,
      code: "no-key",
      message: `No API key is configured. Add one in Settings, or export ${settings.apiKeyEnv}.`,
    };
  }

  const endpoint = settings.endpoint === "" ? provider.endpoint : settings.endpoint;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${key.value}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(settings.requestTimeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, code: "aborted", message: "The request was cancelled." };
    const detail = error?.cause?.code ?? error?.name ?? "network error";
    return { ok: false, code: "network", message: `Could not reach ${new URL(endpoint).host} (${detail}).` };
  }

  const body = await readCapped(response);
  if (!response.ok) {
    const { code, message } = describeHttpFailure(response.status, body);
    return { ok: false, code, message };
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, code: "bad-response", message: "DeepSeek answered with a body that is not JSON." };
  }

  const balance = normalizeBalance(payload);
  if (balance === undefined) {
    return { ok: false, code: "bad-response", message: "DeepSeek's answer did not contain the documented balance fields." };
  }
  return { ok: true, ...balance };
}

/**
 * Read a response body as text, refusing to buffer an unbounded one. A balance
 * answer is a few hundred bytes; anything near this cap is not one.
 * @returns {Promise<string>}
 */
async function readCapped(response) {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "";
  const text = await response.text();
  return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
}

/**
 * The cache and its single-flight rule.
 *
 * A failed refresh keeps the previous good answer and marks it stale. That is
 * the difference between a widget that says "CNY 42.00, last checked 12 minutes
 * ago, could not refresh" and one that blanks itself because the network
 * hiccuped — the first is information, the second is noise.
 */
function createReader(ctx, settings, provider) {
  let cached; // last successful { isAvailable, wallets } with its timestamp
  let failure; // last failure, cleared by the next success
  let inflight;
  let lastAttempt = 0;
  const controllers = new Set();
  const lifetime = new AbortController();

  async function refresh() {
    if (inflight !== undefined) return inflight;
    lastAttempt = Date.now();
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true });
    inflight = (async () => {
      try {
        const result = await fetchBalance(ctx, settings, provider, controller.signal);
        if (result.ok) {
          cached = { isAvailable: result.isAvailable, wallets: result.wallets, fetchedAt: Date.now() };
          failure = undefined;
        } else if (result.code !== "aborted") {
          failure = { code: result.code, message: result.message };
        }
        return result;
      } finally {
        controllers.delete(controller);
        lifetime.signal.removeEventListener("abort", abort);
        inflight = undefined;
      }
    })();
    return inflight;
  }

  return {
    /**
     * @param {boolean} force bypass the freshness window.
     */
    async read(force) {
      const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - cached.fetchedAt;
      const fresh = age < settings.refreshIntervalMs;
      if (!force && fresh) return undefined;
      if (!force && failure !== undefined && Date.now() - lastAttempt < settings.refreshIntervalMs) return undefined;
      await refresh();
      return undefined;
    },
    /** The wire state the client renders. */
    state() {
      return {
        ok: failure === undefined && cached !== undefined,
        stale: failure !== undefined && cached !== undefined,
        provider: { id: provider.id, label: provider.label },
        currency: settings.currency,
        refreshIntervalMs: settings.refreshIntervalMs,
        fetchedAt: cached?.fetchedAt ?? null,
        isAvailable: cached?.isAvailable ?? null,
        wallets: cached?.wallets ?? [],
        featured: cached === undefined ? null : (pickWallet(cached.wallets, settings.currency) ?? null),
        error: failure ?? null,
        lastAttemptAt: lastAttempt === 0 ? null : lastAttempt,
      };
    },
    dispose() {
      lifetime.abort();
      controllers.clear();
    },
  };
}

/**
 * Same-origin fence for the plugin's own routes.
 *
 * These routes live outside `/api`, so the connection layer's Host/Origin fence
 * does not cover them and the plugin must apply its own. Three checks:
 *
 *  * the Host header must name a loopback authority, which is what stops a
 *    DNS-rebinding page from reading a response through a name that resolves to
 *    127.0.0.1;
 *  * a present Origin must match Host, so a cross-site page cannot read the
 *    answer;
 *  * `sec-fetch-site: cross-site` is refused outright as a second opinion.
 *
 * A GET is all this plugin serves, and it changes nothing but the cache, so
 * there is no CSRF-shaped write to protect.
 *
 * @returns {string | undefined} the violation, or `undefined` when acceptable.
 */
function fenceViolation(req, allowNonLoopback) {
  if (!allowNonLoopback) {
    const host = req.headers.host ?? "";
    const hostname = /^\[.*\](?::\d+)?$/.test(host) ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
    const loopback = hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    if (!loopback) return "host is not a loopback authority";
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return "unparseable Origin header";
    }
    if (originHost !== (req.headers.host ?? "")) return "Origin does not match Host";
  }
  if (req.headers["sec-fetch-site"] === "cross-site") return "sec-fetch-site: cross-site";
  // The settings write is a POST. Requiring a JSON content type is what stops a
  // cross-site form or a `text/plain` body from reaching it at all, because
  // those are the only shapes a cross-site "simple request" can send.
  if (req.method === "POST" && !/^\s*application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    return "POST requires an application/json body";
  }
  return undefined;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * @param {object} rawConfig
 */
function resolveSettings(rawConfig) {
  const config = rawConfig !== null && typeof rawConfig === "object" ? rawConfig : {};
  const providerId = String(config.provider ?? "deepseek").trim().toLowerCase();
  const provider = PROVIDERS[providerId];
  const refresh = Number(config.refreshIntervalMs);
  const timeout = Number(config.requestTimeoutMs);

  return {
    providerId,
    provider,
    apiKey: typeof config.apiKey === "string" ? config.apiKey.trim() : "",
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv !== "" ? config.apiKeyEnv : "DEEPSEEK_API_KEY",
    endpoint: typeof config.endpoint === "string" ? config.endpoint.trim() : "",
    refreshIntervalMs: Number.isFinite(refresh) ? Math.max(MIN_REFRESH_MS, Math.trunc(refresh)) : DEFAULT_REFRESH_MS,
    requestTimeoutMs: Number.isFinite(timeout) ? Math.max(1000, Math.trunc(timeout)) : DEFAULT_TIMEOUT_MS,
    currency: String(config.currency ?? "auto").trim() || "auto",
    allowNonLoopback: config.allowNonLoopback === true,
    costEnabled: config.costEnabled !== false,
    graphEnabled: config.graphEnabled !== false,
    burnWindowMs: Number.isFinite(Number(config.burnWindowMs)) ? Math.max(MIN_BURN_WINDOW_MS, Math.trunc(Number(config.burnWindowMs))) : DEFAULT_BURN_WINDOW_MS,
    burnWarnPerHour: Number.isFinite(Number(config.burnWarnPerHour)) ? Math.max(0, Number(config.burnWarnPerHour)) : DEFAULT_BURN_WARN_PER_HOUR,
    terminateAbovePerHour: Number.isFinite(Number(config.terminateAbovePerHour)) ? Math.max(0, Number(config.terminateAbovePerHour)) : DEFAULT_TERMINATE_PER_HOUR,
    // Kept as the raw value: it is either the string "auto" or something numeric,
    // and parseFxSetting is what decides, in one place.
    usdToCny: config.usdToCny === undefined || config.usdToCny === null ? "auto" : config.usdToCny,
  };
}

/**
 * Turn the ledger's figures into the payload the panel renders.
 *
 * Amounts are already in the right currency: the ledger prices in the featured
 * wallet's currency, using DeepSeek's own published rate card for that currency.
 * Nothing is converted here, which is the point — there is no exchange rate to
 * get wrong, and no rate for the user to keep up to date.
 *
 * @param {object} summary from the ledger.
 * @param {object} settings
 * @param {object|null} featured the wallet the panel is featuring, for `auto`.
 */
function costPayload(summary, settings, featured, nowMs = Date.now()) {
  const currency = normalizeCostCurrency(summary.currency ?? featured?.currency);

  const thisTurn = summary.thisTurn;

  /**
   * The live rate: what the last `burnWindowMs` cost, projected to an hour.
   *
   * This is the sudden-loss detector. It is deliberately short and therefore
   * jumpy — it reads 0 whenever nothing has settled inside the window, which is
   * true rather than broken, and it moves within seconds of a fan-out starting.
   */
  const liveBurnPerHour = summary.recent.costPerHour;
  /**
   * The turn's own running average, frozen when the turn closes. Stable, and the
   * figure worth comparing one task against another.
   */
  const averageBurnPerHour = thisTurn !== null ? thisTurn.burnPerHour : 0;

  // Both thresholds are in the balance's own currency, because the amounts are.
  const warn = settings.burnWarnPerHour > 0 && liveBurnPerHour >= settings.burnWarnPerHour;
  const overTerminate =
    settings.terminateAbovePerHour > 0 &&
    thisTurn !== null &&
    thisTurn.ended !== true &&
    liveBurnPerHour >= settings.terminateAbovePerHour;

  return {
    available: true,
    sessionId: summary.sessionId,
    currency,
    pricingReadOn: summary.pricingReadOn ?? null,
    burnWindowMs: summary.recent.windowMs,
    graphEnabled: settings.graphEnabled !== false,
    liveBurnPerHour,
    liveAmountPerHour: liveBurnPerHour,
    averageBurnPerHour,
    averageAmountPerHour: averageBurnPerHour,
    warn,
    warnPerHour: settings.burnWarnPerHour,
    terminateAbovePerHour: settings.terminateAbovePerHour,
    overTerminate,
    /**
     * The server's clock. The panel ticks the elapsed time locally once a
     * second, and an offset measured once per payload keeps that honest if the
     * page's clock has drifted from the host's.
     */
    serverNow: nowMs,
    thisTurn:
      thisTurn === null
        ? null
        : {
            turn: thisTurn.turn,
            ended: thisTurn.ended === true,
            startedAt: thisTurn.startedAt,
            endedAt: thisTurn.endedAt,
            durationMs: thisTurn.durationMs,
            cost: thisTurn.cost,
            amount: thisTurn.cost,
            burnPerHour: thisTurn.burnPerHour,
            amountPerHour: thisTurn.burnPerHour,
            uncachedInputTokens: thisTurn.uncachedInputTokens,
            cacheReadTokens: thisTurn.cacheReadTokens,
            outputTokens: thisTurn.outputTokens,
            messages: thisTurn.messages,
            attempts: thisTurn.attempts,
            models: thisTurn.models,
            /** Windowed live-burn samples for the chart, relative to the turn start. */
            series: thisTurn.series ?? [],
          },
    /** Closed turns, oldest first, so two finished tasks can be compared. */
    turns: summary.turns.map((turn) => ({
      turn: turn.turn,
      endedAt: turn.endedAt,
      durationMs: turn.durationMs,
      cost: turn.cost,
      amount: turn.cost,
      burnPerHour: turn.burnPerHour,
      amountPerHour: turn.burnPerHour,
      messages: turn.messages,
    })),
    session: {
      cost: summary.session.cost,
      amount: summary.session.cost,
      turns: summary.session.turns,
      sessions: summary.session.sessions,
      descendants: summary.session.descendants,
      unpricedTurns: summary.session.unpricedTurns,
    },
    recent: {
      windowMs: summary.recent.windowMs,
      cost: summary.recent.cost,
      amount: summary.recent.cost,
      costPerHour: summary.recent.costPerHour,
      amountPerHour: summary.recent.costPerHour,
      messages: summary.recent.messages,
    },
  };
}

/** Provenance written into the session log when the plugin stops a turn. */
const TERMINATE_REASON = "dsh-budget-watcher/over-budget";

/**
 * Interrupt the running turn of a session, exactly as the stop button does.
 *
 * This is the same primitive the UI reaches: the client's cancel is only a
 * Remote wrapper around `agent.cancel(...)`, so calling it directly needs no
 * Remote carrier and no client round trip. The cause is `hook` rather than
 * `user` so the session log records *why* the turn ended — `hook` is the only
 * cause that carries a provenance string, and `dsh-deepseek-account` sets the
 * same precedent for a programmatic stop.
 *
 * The turn guard is advisory, and deliberately so: an `Agent` outlives any one
 * turn, so holding a reference identifies the agent, not the turn. Sampling the
 * open-turn boundary immediately either side of the call cannot make the stop
 * atomic — nothing in the API can cancel "turn N" — but it does turn a silent
 * wrong-turn abort into a logged raced one.
 *
 * @returns {{ok: boolean, why: string, turn?: number}}
 */
function stopRunningTurn(ctx, sessionId, reason) {
  const agents = ctx.get("agents");
  if (agents === undefined) return { ok: false, why: "agents-unavailable" };

  let agent;
  try {
    agent = agents.get(sessionId);
  } catch {
    return { ok: false, why: "lookup-failed" };
  }
  if (agent === undefined) return { ok: false, why: "not-attached" };
  if (agent.status !== "running") return { ok: true, why: "already-idle" };

  const boundaryOf = () => {
    try {
      return ctx.get("sessionProjections")?.stateOf(agent.session, "turnBoundary");
    } catch {
      return undefined;
    }
  };
  const before = boundaryOf();
  // No open turn means there is nothing to stop, and cancelling an idle agent
  // would only risk clearing queued input.
  if (before === undefined || before.openTurnStartSeq === null || before.openTurnStartSeq === undefined) {
    return { ok: true, why: "no-open-turn" };
  }
  const turn = before.lastTurn;

  // `keepInbox` preserves queued and steering input: stopping a runaway must not
  // also silently discard what the user already typed.
  agent.cancel({ kind: "hook", reason }, { keepInbox: true });

  const after = boundaryOf();
  if (after !== undefined && after.lastTurn !== turn) {
    return { ok: true, why: "raced-next-turn", turn };
  }
  return { ok: true, why: "cancelled", turn };
}

/**
 * The live sessions to price.
 *
 * `ctx.sessions` is the host session registry and the direct answer. `agents`
 * is a fallback for a composition without it: an agent and its session share one
 * id, so `agent.session` is the same object. Both are read defensively — a
 * missing or throwing service disables the cost section rather than the route.
 *
 * @param {object} ctx
 * @returns {object[]}
 */
function liveSessionsOf(ctx) {
  const store = ctx.get("sessions");
  if (store !== undefined && typeof store.list === "function") {
    try {
      const list = store.list();
      if (Array.isArray(list)) return list;
    } catch {
      /* fall through to the agent view */
    }
  }
  const agents = ctx.get("agents");
  if (agents !== undefined && typeof agents.list === "function") {
    try {
      const list = agents.list();
      if (Array.isArray(list)) return list.map((agent) => agent?.session).filter((session) => session !== undefined);
    } catch {
      /* both views unavailable */
    }
  }
  return [];
}

const name = "dsh-budget-watcher";

/** Refuse a config write larger than this. The form sends a handful of fields. */
const MAX_CONFIG_BYTES = 8 * 1024;

/**
 * The configuration a user may change from the settings tab, and the type each
 * value is coerced to before it reaches the loader.
 *
 * This is an allow-list rather than "whatever the request contained": the value
 * is written into the user's profile patch file, where an unrecognised key is at
 * best noise and at worst a validation failure that stops the profile loading.
 * `apiKey` is handled separately because it is a secret with leave-unchanged
 * semantics.
 */
const EDITABLE = {
  provider: "string",
  apiKeyEnv: "string",
  endpoint: "string",
  refreshIntervalMs: "number",
  requestTimeoutMs: "number",
  currency: "string",
  allowNonLoopback: "boolean",
  costEnabled: "boolean",
  graphEnabled: "boolean",
  usdToCny: "string",
  burnWindowMs: "number",
  burnWarnPerHour: "number",
  terminateAbovePerHour: "number",
};

/**
 * Project the running configuration into the shape the settings tab renders.
 *
 * The `apiKey` value never crosses this boundary — only whether one is set. A
 * secret that reaches the page has already leaked, and this route is not on the
 * authenticated `/api` prefix.
 */
function settingsPayload(settings, extras) {
  return {
    effective: {
      provider: settings.providerId,
      apiKeyEnv: settings.apiKeyEnv,
      endpoint: settings.endpoint,
      refreshIntervalMs: settings.refreshIntervalMs,
      requestTimeoutMs: settings.requestTimeoutMs,
      currency: settings.currency,
      allowNonLoopback: settings.allowNonLoopback,
      costEnabled: settings.costEnabled,
      graphEnabled: settings.graphEnabled,
      usdToCny: String(settings.usdToCny ?? "auto"),
      burnWindowMs: settings.burnWindowMs,
      burnWarnPerHour: settings.burnWarnPerHour,
      terminateAbovePerHour: settings.terminateAbovePerHour,
    },
    apiKeySet: settings.apiKey !== "",
    ...extras,
  };
}

/**
 * Type-check a request body's patch before anything else happens.
 *
 * This runs *before* `configEditor.edit`, not inside its change callback, so a
 * mistyped field is refused without the profile patch ever being opened. The
 * loader would reject it anyway — but only after the write path had begun, and
 * the difference between "rejected" and "rejected after touching the user's
 * config file" is worth the small duplication.
 *
 * @returns {string | undefined} the problem, or `undefined` when acceptable.
 */
function validatePatch(patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return "body.patch must be an object";
  for (const [key, kind] of Object.entries(EDITABLE)) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (kind === "boolean" && typeof value !== "boolean") return `${key} must be a boolean`;
    if (kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${key} must be a finite number`;
    if (kind === "string" && typeof value !== "string") return `${key} must be a string`;
  }
  if (Object.hasOwn(patch, "apiKey") && patch.apiKey !== null && typeof patch.apiKey !== "string") {
    return "apiKey must be a string or null";
  }
  return undefined;
}

/**
 * Merge a validated patch onto the configuration currently in the patch.
 *
 * `apiKey` is deliberately tri-state: absent leaves it alone, `""` removes it,
 * anything else sets it. A form that posted an empty string for an untouched
 * field would otherwise silently delete the user's key.
 */
function mergeConfig(current, patch, inherited) {
  const next = { ...current };

  for (const key of Object.keys(EDITABLE)) {
    if (!Object.hasOwn(patch, key)) continue;
    const kind = EDITABLE[key];
    if (kind === "string") {
      if (patch[key].trim() === "") delete next[key];
      else next[key] = patch[key].trim();
    } else {
      next[key] = patch[key];
    }
  }

  if (Object.hasOwn(patch, "apiKey")) {
    if (patch.apiKey === null || patch.apiKey === "") delete next.apiKey;
    else next.apiKey = patch.apiKey;
  }

  // A value identical to the layer beneath is not worth persisting: the editor
  // drops the whole `config` key when the result equals `inherited`, which is
  // what makes "reset to default" work.
  return JSON.stringify(next) === JSON.stringify(inherited ?? {}) ? {} : next;
}

/** Read a bounded JSON request body. */
function readJsonBody(req, limit = MAX_CONFIG_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => finish({ error: "body read failed" }));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return finish({ value: {} });
      try {
        finish({ value: JSON.parse(text) });
      } catch {
        finish({ error: "body is not valid JSON" });
      }
    });
  });
}

/**
 * Locate this plugin's own row in the profile patch.
 *
 * `configEditor.entries()` returns only rows it can address unambiguously, so a
 * duplicate id means the row is not editable from here — reported rather than
 * written to the wrong one.
 */
function findConfigEntry(ctx) {
  const editor = ctx.get("configEditor");
  if (editor === undefined || typeof editor.edit !== "function") return { reason: "no-config-editor" };
  let entries;
  try {
    entries = editor.entries();
  } catch {
    return { reason: "entries-unavailable" };
  }
  const entry = entries.find((candidate) => candidate?.options?.name === name);
  if (entry === undefined) return { reason: "row-not-addressable" };
  return { editor, entry };
}

function apply(ctx, config) {
  const settings = resolveSettings(config);

  if (settings.provider === undefined) {
    // An unusable config must not throw: a throw here fails the plugin's fiber
    // and the profile reports a load error for what is really a typo. The
    // widget renders this instead.
    ctx.logger?.warn?.(`[${name}] unknown provider "${settings.providerId}"; no balance will be read`);
  }

  const reader = createReader(ctx, settings, settings.provider ?? { id: settings.providerId, label: settings.providerId });

  // The "terminate above" latch: set to the turn number already stopped, so one
  // runaway turn is interrupted once rather than once per poll.
  let terminatedTurn = null;
  let terminated = null;

  // Reads the live agent tree to price what recent turns actually cost. It
  // spends no tokens of its own: every figure comes from the usage the provider
  // already reported and DSH already logged.
  //
  // The currency is supplied as a getter rather than a value because it is not
  // known until the first balance read, which happens long after this ledger is
  // built.
  //
  // An explicit `currency` setting wins outright here. That is the point of the
  // setting: choosing USD means the figures are shown in USD, whether or not the
  // account happens to hold a USD wallet. Only `auto` defers to whichever wallet
  // is on screen. (This previously ignored the setting and followed the featured
  // wallet, which meant picking USD on a CNY-only account silently did nothing.)
  const costCurrencyNow = () =>
    settings.currency === "auto" ? normalizeCostCurrency(reader.state().featured?.currency) : normalizeCostCurrency(settings.currency);

  // Prices for everything DeepSeek does not publish, and the rate that lets a
  // USD-only price appear in a CNY total. Both are cheap and both degrade to
  // "unknown" rather than to a made-up number: an unpriced turn is visible on the
  // panel, a wrongly priced one is not.
  //
  // `usdToCny` is one field with two modes. `auto` fetches the ECB's daily rate;
  // a number means use it and make no network request at all, which is the right
  // answer behind a proxy or when you want the rate you were actually billed at.
  const fxSetting = parseFxSetting(settings.usdToCny);
  const fx = createFxCache({ fallback: fxSetting.fallback, enabled: fxSetting.enabled });
  const priceBook = createPriceBook({});

  // Keep both current on a timer, not only when a poll happens to arrive.
  //
  // Two reasons this is a timer rather than just the request path. A collapsed
  // panel stops polling, so a request-driven refresh would let the rate go stale
  // for as long as the pill stayed collapsed. And the first poll after a TTL
  // expires would otherwise answer from the old rate, with only the *next* one
  // fresh. The tick is shorter than either TTL, so it is a no-op almost always —
  // both caches decide, and neither will fetch more often than its own TTL.
  const PRICING_TICK_MS = 15 * 60 * 1000;
  const pricingTimer = settings.costEnabled
    ? setInterval(() => {
        void fx.resolve();
        void priceBook.refresh();
      }, PRICING_TICK_MS)
    : undefined;
  // A pending interval keeps the Node process alive; unref so the plugin cannot
  // hold DSH open by itself.
  pricingTimer?.unref?.();

  /**
   * The currency, the prices, and a key that changes whenever either does.
   *
   * The key is what keeps the ledger honest: folds are cached per session, and a
   * fold done against yesterday's rate or an older model list has to be redone
   * rather than served.
   */
  const getPricing = () => {
    const currency = costCurrencyNow();
    const rate = fx.snapshot();
    const book = priceBook.snapshot();
    const usdToCny = rate?.usdToCny ?? 0;
    return {
      currency,
      key: `${currency}|${usdToCny}|${book.fetchedAt ?? "none"}`,
      lookup: (model) => priceBook.lookup(model, { currency, usdToCny }),
    };
  };

  const ledger = settings.costEnabled
    ? createCostLedger({
        getSessions: () => liveSessionsOf(ctx),
        windowMs: settings.burnWindowMs,
        getCurrency: costCurrencyNow,
        getPricing,
      })
    : undefined;

  /**
   * What the settings tab renders.
   *
   * Only the running values plus whether the row can be written. Reading the
   * patch document's own values back (`configEditor.configuration()`) would mean
   * touching the profile directory on every poll for a cosmetic
   * "explicitly set vs default" hint, so it is deliberately not done.
   */
  const currentSettings = () => {
    const located = findConfigEntry(ctx);
    if (located.reason !== undefined) return settingsPayload(settings, { editable: false, reason: located.reason });
    return settingsPayload(settings, { editable: true });
  };

  // `ctx.inject` rather than the exported `inject`: a profile without a web
  // server should still load this plugin and simply have nothing to serve,
  // instead of parking the fiber forever.
  ctx.inject(["webServer"], (injected) => {
    const webServer = injected.webServer ?? ctx.get("webServer");
    if (webServer === undefined) return () => {};

    // Whether the fiber's first poll has primed the rate card and the model
    // list yet. One flag per fiber, reset only when the plugin reloads.
    let primedPricing = false;

    const dispose = webServer.register({
      kind: "exact",
      path: STATE_PATH,
      handler: async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const violation = fenceViolation(req, settings.allowNonLoopback);
        if (violation !== undefined) {
          sendJson(res, 403, { error: `forbidden: ${violation}` });
          return;
        }
        const params = new URL(req.url ?? STATE_PATH, "http://localhost").searchParams;
        const force = params.get("refresh") === "1";
        try {
          await reader.read(force);
        } catch (error) {
          ctx.logger?.warn?.(`[${name}] balance refresh failed: ${String(error)}`);
        }

        // Deliberately not awaited — with one exception. Both are TTL-guarded, so
        // this is a no-op on almost every poll; on the first one it starts the
        // fetches and the panel prices third-party models a poll or two later
        // rather than making this request wait on a stranger's server.
        // `?refresh=1` — the button — does wait, because the user asked.
        //
        // The exception is the very first poll of this fiber's life: it waits for
        // both, so the first panel the user ever sees prices third-party turns
        // instead of reporting them unpriced and only correcting itself on the
        // next poll. Once, not always: afterwards the flag routes every poll
        // through the fire-and-forget path, and a dead endpoint costs this
        // request one timeout rather than every poll one — the backoff inside
        // each cache keeps the later un-awaited attempts cheap.
        if (ledger !== undefined) {
          if (force) {
            await Promise.all([fx.resolve(true), priceBook.refresh(true)]);
          } else if (!primedPricing) {
            primedPricing = true;
            await Promise.all([fx.resolve(), priceBook.refresh()]);
          } else {
            void fx.resolve();
            void priceBook.refresh();
          }
        }

        const state = { ...reader.state(), pluginVersion: PLUGIN_VERSION };
        let cost;
        if (ledger === undefined) {
          cost = { available: false, reason: "disabled" };
        } else {
          try {
            // The client names the conversation it is showing when it can. The
            // ledger falls back to the newest live root session otherwise, so
            // an older client still gets an answer.
            const requested = params.get("session");
            const summary = ledger.summary({
              sessionId: requested !== null && requested !== "" ? requested : undefined,
            });
            // A silent absence is indistinguishable from a bug, so the payload
            // says why there are no figures instead of omitting the key.
            cost = summary === undefined ? { available: false, reason: "no-live-sessions" } : costPayload(summary, settings, state.featured);
            // Where the prices came from, and how old they are. A cost figure is
            // only as trustworthy as its rate card, and "unknown" is a legitimate
            // answer worth showing rather than hiding.
            const rate = fx.snapshot();
            const book = priceBook.snapshot();
            cost.pricing = {
              usdToCny: rate?.usdToCny ?? null,
              usdToCnySource: rate?.source ?? null,
              usdToCnyDate: rate?.date ?? null,
              usdToCnyStale: rate?.stale ?? null,
              thirdPartyModels: book.fetched,
              thirdPartyFetchedAt: book.fetchedAt,
              thirdPartyStale: book.stale,
            };
          } catch (error) {
            // Cost is an addition to the balance, never a reason to fail it.
            ctx.logger?.warn?.(`[${name}] cost estimate failed: ${String(error)}`);
            cost = { available: false, reason: "failed" };
          }

          // The "terminate above" action. Fire-and-forget on purpose: stopping a
          // turn must not make this route slow, and the abort is synchronous at
          // the call site anyway.
          if (cost !== null && cost.overTerminate === true && cost.thisTurn !== null) {
            const turn = cost.thisTurn.turn;
            if (terminatedTurn !== turn) {
              // Latched before the call so a poll arriving mid-abort cannot fire
              // a second one, and keyed by turn so a later turn can still be
              // stopped.
              terminatedTurn = turn;
              terminated = { turn, at: Date.now(), reason: TERMINATE_REASON, liveBurnPerHour: cost.liveBurnPerHour, above: settings.terminateAbovePerHour };
              const outcome = stopRunningTurn(ctx, cost.sessionId, TERMINATE_REASON);
              terminated.outcome = outcome.why;
              ctx.logger?.warn?.(
                `[${name}] live burn ${cost.liveBurnPerHour.toFixed(2)}/h is over the ${settings.terminateAbovePerHour}/h limit: ` +
                  `interrupted turn ${turn} of ${cost.sessionId} (${outcome.why})`,
              );
            }
          }
        }

        sendJson(res, 200, { ...state, cost, terminated, settings: currentSettings() });
      },
    });

    // The settings tab's write path. Same fence as the read, plus a required
    // JSON content type, so a cross-site form cannot reach it.
    const disposeConfig = webServer.register({
      kind: "exact",
      path: CONFIG_PATH,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const violation = fenceViolation(req, settings.allowNonLoopback);
        if (violation !== undefined) {
          sendJson(res, 403, { error: `forbidden: ${violation}` });
          return;
        }

        const located = findConfigEntry(ctx);
        if (located.reason !== undefined) {
          sendJson(res, 409, { ok: false, error: `the profile row is not editable (${located.reason})`, settings: currentSettings() });
          return;
        }

        const body = await readJsonBody(req);
        if (body.error !== undefined) {
          sendJson(res, 400, { ok: false, error: body.error, settings: currentSettings() });
          return;
        }

        // Refused before the profile patch is opened.
        const invalid = validatePatch(body.value?.patch);
        if (invalid !== undefined) {
          sendJson(res, 400, { ok: false, error: invalid, settings: currentSettings() });
          return;
        }

        try {
          await located.editor.edit(located.entry, (current, inherited) => mergeConfig(current ?? {}, body.value.patch, inherited));
        } catch (error) {
          // A rejected write leaves the profile untouched: configEditor rolls
          // the file back when reconciliation fails.
          ctx.logger?.warn?.(`[${name}] config write failed: ${String(error)}`);
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error), settings: currentSettings() });
          return;
        }

        sendJson(res, 200, { ok: true, settings: currentSettings(), note: "Saved to the profile patch. Config edits apply live." });
      },
    });

    return () => {
      dispose();
      disposeConfig();
    };
  });

  ctx.effect(() => () => {
    if (pricingTimer !== undefined) clearInterval(pricingTimer);
    reader.dispose();
    ledger?.dispose();
  });
}

export { apply, name };
