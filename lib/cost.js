// Pure cost model for the DeepSeek API.
//
// This file answers "what did that message cost?" without spending a single
// token of its own: the provider reports exact token usage on every assistant
// message, and DSH records it in the session log. So the estimate is arithmetic
// over numbers that are already on disk, not a model call.
//
// Prices are DeepSeek's published rates per 1M tokens, in **both** currencies
// they publish them in. They are the part most likely to go stale, so they sit
// in one table with the date they were read, and an unknown model is reported as
// unpriced rather than guessed at.

/**
 * Date these rates were read. Both pages were checked on this date:
 * https://api-docs.deepseek.com/quick_start/pricing/ (USD)
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ (CNY)
 */
export const PRICING_READ_ON = "2026-10-03";

/**
 * The currencies DeepSeek prices in. A cost is always expressed in one of these,
 * matching the balance it is shown beside — which is why no exchange rate is
 * involved anywhere: the CNY figures below are published numbers, not a
 * conversion of the USD ones. (They are not a clean multiple either: flash
 * off-peak output is $0.60 or ¥4, an implied ~6.67, while a typical spot rate is
 * nearer 7.2. Converting would be both unnecessary and wrong.)
 */
export const COST_CURRENCIES = ["CNY", "USD"];

/**
 * Per 1M tokens, per currency. Off-peak is exactly half of peak on every line,
 * but both are listed because a table that only stores one and divides is a
 * table that silently breaks when the ratio changes.
 *
 * @typedef {{cacheHit: number, cacheMiss: number, output: number}} Rates
 */
export const PRICING = {
  "deepseek-flash": {
    label: "DeepSeek-V4.1-Flash",
    USD: {
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    },
    CNY: {
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    },
  },
  "deepseek-v4-pro": {
    label: "DeepSeek-V4-Pro-0813",
    USD: {
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    },
    CNY: {
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    },
  },
};

/**
 * Legacy model names DeepSeek still accepts but bills at the Flash rate. The
 * pricing page states the retired models' requests "are served by the
 * DeepSeek-V4.1-Flash model and billed at the Flash price", so pricing them any
 * other way would over-report.
 */
/**
 * Any id that belongs to DeepSeek's own published price list.
 *
 * Used to refuse the third-party book for a DeepSeek model whose exact id the
 * table could not resolve — see the guard in `usageCost`.
 */
const DEEPSEEK_MODEL = /deepseek/i;

const ALIASES = {
  // The id DeepSeek's API actually reports. The `deepseek-flash` row is labelled
  // "DeepSeek-V4.1-Flash" — it was written for this model — but the alias key was
  // spelled without the `.1`, so the one model that row exists for could not find
  // it and fell through to the fetched list instead.
  "deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "deepseek-v4.1-flash-vision-exp": "deepseek-flash",
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
};

/**
 * Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, excluding
 * Chinese public holidays. Weekends are off-peak in full.
 *
 * The holiday exclusion is the one part this cannot compute: the holiday
 * calendar is not published in the API docs and changes yearly. Treating a
 * holiday weekday as peak **over**states the cost, which is the safe direction
 * for a spend warning.
 *
 * @param {number} atMs epoch milliseconds of the call.
 * @returns {boolean}
 */
export function isPeak(atMs) {
  const at = new Date(atMs);
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * Normalise a currency name to one DeepSeek prices in. Anything unknown is
 * treated as USD, which is the currency the API's own usage reporting assumes.
 * @param {string} [currency]
 * @returns {"CNY" | "USD"}
 */
export function normalizeCostCurrency(currency) {
  const name = String(currency ?? "").trim().toUpperCase();
  return name === "CNY" ? "CNY" : "USD";
}

/**
 * Resolve a model name to its rate card, for one currency.
 * @param {string} model
 * @param {string} [currency]
 * @returns {{label: string, peak: Rates, offPeak: Rates} | undefined}
 */
export function pricingFor(model, currency = "USD") {
  const name = String(model ?? "").trim().toLowerCase();
  if (name === "") return undefined;
  const card = PRICING[name] ?? PRICING[ALIASES[name]];
  if (card === undefined) return undefined;
  const book = card[normalizeCostCurrency(currency)];
  if (book === undefined) return undefined;
  return { label: card.label, peak: book.peak, offPeak: book.offPeak };
}

/**
 * The `usage` DSH records on an assistant message.
 * @typedef {object} Usage
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {number} [reasoningTokens]
 */

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cost of one provider usage report, in the given currency.
 *
 * The bucket semantics are DSH's, and they are not the obvious guess: in a
 * `TokenUsage`, `inputTokens` is the **uncached** input only, and
 * `cacheReadTokens` / `cacheWriteTokens` are separate additional buckets. The
 * DeepSeek adapter states the identity outright —
 * `usage.totalTokens = usage.inputTokens + usage.outputTokens + cacheReadTokens + cacheWriteTokens`
 * (`dsh-llm-deepseek/lib/index.js`) — so subtracting cache reads from
 * `inputTokens` would collapse the uncached half to zero on a well-cached turn
 * and under-report exactly the turns worth watching.
 *
 * DeepSeek's rate card has no separate cache-write line, so cache-write tokens
 * are billed at the uncached input rate. That is the conservative reading and
 * the only one the published prices support.
 *
 * @param {Usage | undefined} usage
 * @param {string} model
 * @param {number} atMs
 * @param {string} [currency] `CNY` or `USD`; anything else is treated as USD.
 * @param {(model: string, options: {currency: string}) => {cacheHit: number, cacheMiss: number, output: number, source?: string} | undefined} [lookup]
 *   Prices for models DeepSeek does not publish — the fetched multi-provider book.
 *   Consulted only when the model is not in the table above, so the provider
 *   whose invoice the user pays always wins over a third party's listing.
 * @returns {{cost: number, currency: string, rates: Rates, peak: boolean, source: string, cacheMissTokens: number, cacheReadTokens: number, outputTokens: number} | undefined}
 *   `undefined` when the model has no published rate — never a guessed number.
 */
export function usageCost(usage, model, atMs, currency = "USD", lookup = undefined) {
  if (usage === undefined || usage === null) return undefined;
  const code = normalizeCostCurrency(currency);

  const card = pricingFor(model, code);
  let rates;
  let peak = false;
  let source = "bundled";
  if (card !== undefined) {
    peak = isPeak(atMs);
    rates = peak ? card.peak : card.offPeak;
  } else if (DEEPSEEK_MODEL.test(String(model ?? ""))) {
    // A DeepSeek-family id the table above could not resolve.
    //
    // Do not ask the book. OpenRouter lists `deepseek/deepseek-v4.1-flash` at
    // 0.044 USD/M in and 0.3/M out — about a third of DeepSeek's own published
    // CNY rate — so a third-party number here would understate the spend by two
    // thirds while looking entirely plausible on the panel. Unpriced is visible;
    // a confident fraction of the truth is not.
    //
    // The earlier precedence test never caught this because it used
    // `deepseek-flash`, which resolves in the table. The alias gap is fixed above;
    // this guard is what stops the next unlisted DeepSeek spelling being mispriced.
    return undefined;
  } else {
    // Not a DeepSeek model. The fetched book prices in a flat rate: no
    // peak/off-peak concept exists for a third party's published number, and
    // inventing one would be worse than reporting the flat truth.
    const flat = typeof lookup === "function" ? lookup(model, { currency: code }) : undefined;
    if (flat === undefined) return undefined;
    rates = { cacheHit: flat.cacheHit, cacheMiss: flat.cacheMiss, output: flat.output };
    source = flat.source ?? "fetched";
  }

  // Uncached input: `inputTokens` itself, plus any cache-write bucket.
  const cacheMissTokens = count(usage.inputTokens) + count(usage.cacheWriteTokens);
  const cacheReadTokens = count(usage.cacheReadTokens);
  const outputTokens = count(usage.outputTokens);

  const cost = (cacheReadTokens * rates.cacheHit + cacheMissTokens * rates.cacheMiss + outputTokens * rates.output) / 1_000_000;

  return { cost, currency: code, rates, peak, source, cacheMissTokens, cacheReadTokens, outputTokens };
}

/** Fold one turn's numbers. */
function emptyTurn(turn) {
  return {
    turn,
    cost: 0,
    // Named for what it is: DSH's `inputTokens` bucket is the uncached half.
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    messages: 0,
    attempts: 0,
    unpricedMessages: 0,
    peak: false,
    models: [],
    startedAt: null,
    endedAt: null,
    lastAt: null,
    ended: false,
  };
}

/**
 * The usage one billed assistant call reports.
 *
 * Two tiers, and this mirrors what DSH itself does: the settled
 * `assistant/message` carries `usage`, but an attempt that failed or was
 * interrupted settles as `assistant/attempt`, which has **no** `usage` field —
 * its numbers survive only in the last `usage` chunk of its stream. Reading
 * just `usage` would silently drop the cost of every retry.
 *
 * @param {{type: string, data: any}} event
 */
export function usageOf(event) {
  const direct = event?.data?.usage;
  if (typeof direct === "object" && direct !== null) return direct;

  const stream = event?.data?.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === "usage" && typeof record.usage === "object" && record.usage !== null) return record.usage;
    const chunk = record?.chunk;
    if (chunk?.type === "usage" && typeof chunk.usage === "object" && chunk.usage !== null) return chunk.usage;
  }
  return undefined;
}

/**
 * Every assistant call in a log that was billed, in order.
 *
 * An `assistant/attempt` event names no model — the agent loop writes it on the
 * failure and interrupt paths with only `{ turn, step, stream }`. The retry is
 * the same request, so the model comes from the turn it belongs to, falling
 * back to the session's own request context.
 *
 * @param {readonly object[]} events
 * @param {string} [fallbackModel]
 */
export function collectBilledUnits(events, fallbackModel = "") {
  const units = [];
  for (const event of events ?? []) {
    if (event === null || typeof event !== "object") continue;
    if (event.type === "assistant/message") {
      units.push({
        turn: event.data?.turn,
        time: event.time,
        kind: "message",
        model: event.data?.message?.source?.model ?? "",
        provider: event.data?.message?.source?.provider ?? "",
        usage: usageOf(event),
      });
    } else if (event.type === "assistant/attempt") {
      units.push({ turn: event.data?.turn, time: event.time, kind: "attempt", model: "", provider: "", usage: usageOf(event) });
    }
  }

  const modelByTurn = new Map();
  for (const unit of units) {
    if (unit.model !== "") modelByTurn.set(unit.turn, unit.model);
  }
  for (const unit of units) {
    if (unit.model === "") unit.model = modelByTurn.get(unit.turn) ?? (fallbackModel === "" ? "" : fallbackModel);
  }
  return units;
}

/**
 * Fold a session's events into per-turn token and cost totals.
 *
 * `turn/start` and `turn/end` bound turns; every billed assistant call inside
 * one adds to it. Tool calls and results carry no usage of their own — their
 * tokens are inside the next assistant call's prompt, which is exactly why a
 * fan-out turn shows up as one enormous number.
 *
 * @param {readonly {type: string, seq: number, time: number, data: any}[]} events
 * @param {string} [fallbackModel] session model, for an attempt whose turn has no message yet.
 * @returns {object[]} turns in ascending order.
 */
export function foldTurns(events, fallbackModel = "", currency = "USD", lookup = undefined) {
  const turns = [];
  const byNumber = new Map();

  const open = (turn, time) => {
    if (!byNumber.has(turn)) {
      const created = emptyTurn(turn);
      byNumber.set(turn, created);
      turns.push(created);
    }
    const found = byNumber.get(turn);
    if (found.startedAt === null) found.startedAt = time;
    return found;
  };

  for (const event of events ?? []) {
    if (event === null || typeof event !== "object") continue;
    const data = event.data ?? {};
    if (event.type === "turn/start") open(data.turn, event.time);
    else if (event.type === "turn/end") {
      const turn = open(data.turn, event.time);
      turn.endedAt = event.time;
      turn.ended = true;
    }
  }

  for (const unit of collectBilledUnits(events, fallbackModel)) {
    const turn = open(unit.turn, unit.time);
    turn.lastAt = unit.time;

    const usage = unit.usage;
    if (unit.kind === "message") {
      turn.messages += 1;
      if (unit.model !== "" && !turn.models.some((entry) => entry.model === unit.model)) {
        turn.models.push({ provider: unit.provider, model: unit.model });
      }
    } else {
      turn.attempts += 1;
    }

    turn.uncachedInputTokens += count(usage?.inputTokens);
    turn.outputTokens += count(usage?.outputTokens);
    turn.cacheReadTokens += count(usage?.cacheReadTokens);
    turn.reasoningTokens += count(usage?.reasoningTokens);

    const priced = usageCost(usage, unit.model, unit.time, currency, lookup);
    if (priced === undefined) {
      // No usage report at all, or a model with no published rate. Either way
      // this is an unknown cost, not a free one.
      turn.unpricedMessages += 1;
    } else {
      turn.cost += priced.cost;
      turn.cacheMissTokens += priced.cacheMissTokens;
      turn.peak = priced.peak;
    }
  }

  return turns;
}

/**
 * Price every billed assistant call in a log individually.
 *
 * The window question ("what have we spent in the last N minutes") is a
 * message-time question, so it is answered from this list rather than from
 * turn totals: a fanned-out turn can run for twenty minutes and never close,
 * and a turn-level figure would stay silent for exactly that whole time.
 *
 * Token counts ride along so a caller can attribute a turn's tokens *and* its
 * cost to the same time window, rather than mixing a time-windowed cost with a
 * turn-numbered token total.
 *
 * @param {readonly object[]} events
 * @param {string} [fallbackModel]
 * @param {string} [currency]
 * @param {Function} [lookup] the multi-provider price book, for models DeepSeek does not publish.
 * @returns {{time: number, cost: number, priced: boolean, model: string, provider: string, kind: string,
 *   uncachedInputTokens: number, cacheReadTokens: number, outputTokens: number}[]}
 */
export function pricedMessages(events, fallbackModel = "", currency = "USD", lookup = undefined) {
  return collectBilledUnits(events, fallbackModel).map((unit) => {
    const priced = usageCost(unit.usage, unit.model, unit.time, currency, lookup);
    return {
      time: typeof unit.time === "number" ? unit.time : 0,
      cost: priced?.cost ?? 0,
      priced: priced !== undefined,
      model: unit.model,
      // Which API answered. Carried through so the panel can tell "this turn
      // span two providers" from "this model has no published price".
      provider: unit.provider,
      kind: unit.kind,
      uncachedInputTokens: count(unit.usage?.inputTokens),
      cacheReadTokens: count(unit.usage?.cacheReadTokens),
      outputTokens: count(unit.usage?.outputTokens),
    };
  });
}

/**
 * A burn rate per hour: cost over elapsed time, in whatever currency the cost is
 * expressed in.
 *
 * This is a cumulative average, not an instantaneous one — cost so far divided
 * by time so far. That is deliberate: a turn's spend arrives in lumps as each
 * step settles, so an "instantaneous" rate would read as a spike at every step
 * and as zero between them. The cumulative average is stable while a turn runs
 * and lands exactly on the turn's true average rate when it closes, which is
 * what makes two finished turns comparable.
 *
 * @param {number} cost
 * @param {number} durationMs
 * @returns {number} currency per hour, 0 when no time has passed.
 */
export function burnPerHour(cost, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return (cost / durationMs) * 3_600_000;
}

/**
 * The summary the panel renders.
 *
 * `recent` is the early-warning number. A turn that fans out to dozens of
 * subagents does not finish, so a "cost of the last completed turn" would stay
 * silent through exactly the runaway this is meant to catch. Cost is therefore
 * accumulated per assistant message with its own timestamp, and the recent
 * window reports what the session has spent in the last few minutes and what
 * that projects to per hour.
 *
 * @param {object} input
 * @param {readonly object[]} input.events session events.
 * @param {number} input.nowMs
 * @param {number} [input.windowMs] recent-burn window, default 15 minutes.
 * @param {number} [input.sessionStartedAt]
 */
export function summarizeCost({ events, nowMs, windowMs = 15 * 60 * 1000, sessionStartedAt = null, fallbackModel = "", currency = "USD", lookup = undefined }) {
  const turns = foldTurns(events, fallbackModel, currency, lookup);
  const messages = pricedMessages(events, fallbackModel, currency, lookup);

  let cost = 0;
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let unpricedTurns = 0;

  const since = nowMs - windowMs;
  let recentCost = 0;
  let recentMessages = 0;
  for (const message of messages) {
    if (message.time < since) continue;
    recentMessages += 1;
    if (message.priced) recentCost += message.cost;
  }

  let lastTurn = null;
  for (const turn of turns) {
    cost += turn.cost;
    uncachedInputTokens += turn.uncachedInputTokens;
    outputTokens += turn.outputTokens;
    cacheReadTokens += turn.cacheReadTokens;
    if (turn.unpricedMessages > 0) unpricedTurns += 1;
    if (lastTurn === null || turn.turn >= lastTurn.turn) lastTurn = turn;
  }

  const recentPerHour = recentMessages === 0 ? 0 : (recentCost / windowMs) * 3_600_000;

  return {
    pricingReadOn: PRICING_READ_ON,
    currency: normalizeCostCurrency(currency),
    lastTurn,
    session: { cost, turns: turns.length, uncachedInputTokens, outputTokens, cacheReadTokens, unpricedTurns },
    recent: {
      windowMs,
      cost: recentCost,
      messages: recentMessages,
      costPerHour: recentPerHour,
      since,
    },
    messages,
    sessionStartedAt,
    nowMs,
  };
}
