// Cost-model tests.
//
// Every expected number here is hand-computed from DeepSeek's published rates
// so a silent change to the arithmetic fails the suite rather than quietly
// mis-reporting someone's spend.

import assert from "node:assert/strict";
import { test } from "node:test";

import { COST_CURRENCIES, PRICING, foldTurns, isPeak, normalizeCostCurrency, pricedMessages, pricingFor, summarizeCost, usageCost } from "../lib/cost.js";

/** 2026-10-02 is a Friday, so weekday rules apply. */
const FRI = (hhmm) => Date.parse(`2026-10-02T${hhmm}:00Z`);
const SAT = (hhmm) => Date.parse(`2026-10-03T${hhmm}:00Z`);

test("peak hours are the two UTC weekday windows DeepSeek publishes", () => {
  assert.equal(isPeak(FRI("00:30")), false);
  assert.equal(isPeak(FRI("01:00")), true);
  assert.equal(isPeak(FRI("03:59")), true);
  assert.equal(isPeak(FRI("04:00")), false, "04:00 is the first off-peak hour");
  assert.equal(isPeak(FRI("05:59")), false);
  assert.equal(isPeak(FRI("06:00")), true);
  assert.equal(isPeak(FRI("09:59")), true);
  assert.equal(isPeak(FRI("10:00")), false, "10:00 is the end of the second window");
  assert.equal(isPeak(FRI("23:00")), false);
});

test("weekends are off-peak in full", () => {
  assert.equal(isPeak(SAT("02:00")), false);
  assert.equal(isPeak(SAT("07:00")), false);
});

test("legacy model names are priced at the Flash rate, as DeepSeek documents", () => {
  // `pricingFor` flattens the card to one currency's rates, so the USD book is
  // the comparable shape.
  const flash = { label: PRICING["deepseek-flash"].label, ...PRICING["deepseek-flash"].USD };
  const pro = { label: PRICING["deepseek-v4-pro"].label, ...PRICING["deepseek-v4-pro"].USD };
  assert.deepEqual(pricingFor("deepseek-flash"), flash);
  assert.deepEqual(pricingFor("deepseek-v4-flash"), flash);
  assert.deepEqual(pricingFor("deepseek-v4-flash-vision-exp"), flash);
  assert.deepEqual(pricingFor("DeepSeek-Flash"), flash, "matching is case-insensitive");
  assert.deepEqual(pricingFor("deepseek-v4-pro"), pro);
  // The CNY book is a different published table, not a converted copy.
  assert.deepEqual(pricingFor("deepseek-flash", "CNY"), {
    label: "DeepSeek-V4.1-Flash",
    ...PRICING["deepseek-flash"].CNY,
  });
});

test("an unknown model has no price at all, rather than a guessed one", () => {
  assert.equal(pricingFor("gpt-5"), undefined);
  assert.equal(pricingFor(""), undefined);
  assert.equal(pricingFor(undefined), undefined);
  assert.equal(usageCost({ inputTokens: 1000 }, "mimo-v2.6-pro", FRI("12:00")), undefined);
});

test("off-peak Flash output is billed at the published output rate", () => {
  const priced = usageCost({ outputTokens: 1_000_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.peak, false);
  assert.equal(priced?.cost, 0.6);
});

test("cached and uncached input are billed at their own rates, as separate buckets", () => {
  // DSH's `inputTokens` is the UNCACHED half; cache reads are additional.
  // 1M uncached at $0.15 + 400k cache-read at $0.003.
  const priced = usageCost({ inputTokens: 1_000_000, cacheReadTokens: 400_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.cacheMissTokens, 1_000_000, "cache reads are not subtracted from the uncached bucket");
  assert.equal(Math.abs((priced?.cost ?? 0) - (0.15 + 0.0012)) < 1e-12, true, `got ${priced?.cost}`);
});

test("a fully cached prompt is nearly free, and a fully fresh one is not", () => {
  const cached = usageCost({ inputTokens: 0, cacheReadTokens: 1_000_000 }, "deepseek-flash", FRI("12:00"));
  const fresh = usageCost({ inputTokens: 1_000_000, cacheReadTokens: 0 }, "deepseek-flash", FRI("12:00"));
  assert.equal(cached?.cacheMissTokens, 0);
  assert.equal(cached?.cost, 0.003);
  assert.equal(fresh?.cost, 0.15);
});

test("the id DeepSeek's API reports resolves to the row written for that model", () => {
  // The bug: the `deepseek-flash` row is labelled "DeepSeek-V4.1-Flash", but the
  // alias key was spelled `deepseek-v4-flash`, without the `.1`. The one model the
  // row exists for therefore fell through to the fetched list — where it priced at
  // roughly a third of the real rate, because OpenRouter's DeepSeek numbers are not
  // DeepSeek's.
  const events = billedTurn({ provider: "deepseek", model: "deepseek-v4.1-flash", inputTokens: 1_000_000 });
  const summary = summarizeCost({ events, nowMs: FRI("12:01"), currency: "CNY" });

  assert.equal(summary.session.unpricedTurns, 0, "it must be priced, not reported as absent");
  // FRI("12:00") local is 04:00 UTC, and peak ends at 04:00 — so this is DeepSeek's
  // off-peak CNY uncached rate, 1/M.
  assert.equal(summary.session.cost, 1, "1M uncached at DeepSeek's own CNY 1/M off-peak rate");
});

test("every alias in the table resolves, including the dotted spellings", () => {
  for (const name of ["deepseek-v4.1-flash", "deepseek-v4-flash", "deepseek-v4.1-flash-vision-exp", "deepseek-chat", "deepseek-reasoner"]) {
    assert.notEqual(pricingFor(name, "CNY"), undefined, `${name} must resolve in the bundled table`);
  }
});

test("a DeepSeek id the table cannot resolve is never priced from the book", () => {
  // Worse than unpriced: OpenRouter's DeepSeek rows are about a third of DeepSeek's
  // own rate, so falling through there would understate spend convincingly.
  const events = billedTurn({ provider: "deepseek", model: "deepseek-v9-unreleased", inputTokens: 1_000_000 });
  let consulted = false;
  const summary = summarizeCost({
    events,
    nowMs: FRI("12:01"),
    currency: "CNY",
    lookup: () => {
      consulted = true;
      return { cacheHit: 0.04, cacheMiss: 0.3, output: 2 };
    },
  });

  assert.equal(consulted, false, "the book is not asked about a DeepSeek name at all");
  assert.equal(summary.session.cost, 0);
  assert.equal(summary.session.unpricedTurns, 1, "it reports unknown rather than a confident fraction of the truth");
});

test("a large cached prefix does not cancel the uncached remainder", () => {
  // The bug this guards: treating `inputTokens` as the whole prompt and
  // subtracting cache reads would clamp 50k uncached against a 1M cached prefix
  // to zero and report the turn as almost free.
  const priced = usageCost({ inputTokens: 50_000, cacheReadTokens: 1_000_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.cacheMissTokens, 50_000);
  assert.equal(Math.abs((priced?.cost ?? 0) - (50_000 * 0.15 + 1_000_000 * 0.003) / 1_000_000) < 1e-12, true);
});

test("DeepSeek has no cache-write line, so cache writes bill as uncached input", () => {
  const priced = usageCost({ inputTokens: 100_000, cacheWriteTokens: 900_000 }, "deepseek-flash", FRI("12:00"));
  assert.equal(priced?.cacheMissTokens, 1_000_000);
  assert.equal(priced?.cost, 0.15);
});

test("peak costs exactly twice off-peak", () => {
  const usage = { inputTokens: 250_000, cacheReadTokens: 250_000, outputTokens: 500_000 };
  const off = usageCost(usage, "deepseek-v4-pro", FRI("12:00"));
  const peak = usageCost(usage, "deepseek-v4-pro", FRI("02:00"));
  assert.equal(peak?.peak, true);
  assert.equal(Math.abs((peak?.cost ?? 0) - 2 * (off?.cost ?? 0)) < 1e-12, true);
});

test("missing or nonsense token fields price as zero rather than NaN", () => {
  assert.equal(usageCost({}, "deepseek-flash", FRI("12:00"))?.cost, 0);
  assert.equal(usageCost({ inputTokens: -5, outputTokens: Number.NaN }, "deepseek-flash", FRI("12:00"))?.cost, 0);
});

test("foldTurns groups usage by the turn that produced it", () => {
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: 2000, data: { turn: 1, step: 1, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens: 1000, outputTokens: 100 } } },
    { type: "assistant/message", seq: 2, time: 3000, data: { turn: 1, step: 2, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens: 2000, outputTokens: 200 } } },
    { type: "turn/end", seq: 3, time: 4000, data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", seq: 4, time: 5000, data: { turn: 2 } },
    { type: "assistant/message", seq: 5, time: 6000, data: { turn: 2, step: 1, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens: 4000, outputTokens: 400 } } },
  ];
  const turns = foldTurns(events);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turn, 1);
  assert.equal(turns[0].messages, 2);
  assert.equal(turns[0].uncachedInputTokens, 3000);
  assert.equal(turns[0].outputTokens, 300);
  assert.equal(turns[0].ended, true);
  assert.equal(turns[1].turn, 2);
  assert.equal(turns[1].ended, false, "a turn still running is not marked ended");
  assert.equal(turns[0].models.length, 1, "one model is recorded once, not per message");
});

test("foldTurns tolerates a malformed log without throwing", () => {
  assert.deepEqual(foldTurns([]), []);
  assert.deepEqual(foldTurns(undefined), []);
  assert.deepEqual(foldTurns([null, { type: "nonsense" }, { type: "assistant/message" }]).length, 1);
});

test("a message with no usage report is counted as unpriced, not as free", () => {
  const events = [
    { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: 2000, data: { turn: 1, message: { source: { model: "deepseek-flash" } } } },
  ];
  const [turn] = foldTurns(events);
  assert.equal(turn.unpricedMessages, 1);
  assert.equal(turn.cost, 0);
});

test("summarizeCost totals the session and reports the last turn", () => {
  const now = FRI("12:00");
  const events = [
    { type: "turn/start", seq: 0, time: now - 60_000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: now - 50_000, data: { turn: 1, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
    { type: "turn/end", seq: 2, time: now - 40_000, data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", seq: 3, time: now - 30_000, data: { turn: 2 } },
    { type: "assistant/message", seq: 4, time: now - 20_000, data: { turn: 2, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 0, outputTokens: 1_000_000 } } },
  ];
  const summary = summarizeCost({ events, nowMs: now });
  assert.equal(summary.session.turns, 2);
  assert.equal(summary.session.cost.toFixed(4), (0.15 + 0.6).toFixed(4));
  assert.equal(summary.lastTurn.turn, 2, "the last turn is the one the person's last message started");
  assert.equal(summary.lastTurn.cost.toFixed(4), "0.6000");
  assert.equal(summary.session.unpricedTurns, 0);
  assert.equal(summary.recent.windowMs, 15 * 60 * 1000);
});

test("the recent window projects a per-hour burn rate from messages inside it", () => {
  const now = FRI("12:00");
  const windowMs = 15 * 60 * 1000;
  // One message 5 minutes ago costing $0.15 → $0.60/hour over the 15-minute window.
  const events = [
    { type: "turn/start", seq: 0, time: now - 5 * 60_000, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, time: now - 5 * 60_000, data: { turn: 1, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 1_000_000 } } },
  ];
  const summary = summarizeCost({ events, nowMs: now, windowMs });
  assert.equal(summary.recent.messages, 1);
  assert.equal(summary.recent.cost.toFixed(4), "0.1500");
  assert.equal(summary.recent.costPerHour.toFixed(4), "0.6000");
});

test("messages older than the window do not inflate the burn rate", () => {
  const now = FRI("12:00");
  const events = [
    { type: "assistant/message", seq: 0, time: now - 90 * 60_000, data: { turn: 1, message: { source: { model: "deepseek-flash" } }, usage: { inputTokens: 1_000_000 } } },
  ];
  const summary = summarizeCost({ events, nowMs: now, windowMs: 15 * 60 * 1000 });
  assert.equal(summary.recent.cost, 0);
  assert.equal(summary.recent.costPerHour, 0);
  assert.equal(summary.session.cost.toFixed(4), "0.1500", "the session total still counts it");
});

test("an empty or unreadable log summarises to zeroes instead of throwing", () => {
  const summary = summarizeCost({ events: [], nowMs: FRI("12:00") });
  assert.equal(summary.lastTurn, null);
  assert.equal(summary.session.cost, 0);
  assert.equal(summary.session.turns, 0);
  assert.equal(summary.recent.costPerHour, 0);
  assert.equal(summary.pricingReadOn, "2026-10-03");
});

/** One turn with one assistant message on `model` from `provider`. */
function billedTurn({ provider, model, inputTokens = 1_000_000, outputTokens = 0 }) {
  return [
    { type: "turn/start", seq: 0, time: FRI("12:00"), data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 1,
      time: FRI("12:00") + 1000,
      data: { turn: 1, message: { source: { provider, model } }, usage: { inputTokens, outputTokens } },
    },
  ];
}

test("a model DeepSeek does not publish is priced from the fetched book", () => {
  const events = billedTurn({ provider: "anthropic", model: "claude-sonnet-5.5" });
  const lookup = (model, options) => {
    assert.equal(model, "claude-sonnet-5.5");
    assert.equal(options.currency, "USD", "the book is asked in the currency on screen");
    return { cacheHit: 0.2, cacheMiss: 2, output: 10, source: "openrouter" };
  };

  const summary = summarizeCost({ events, nowMs: FRI("12:01"), currency: "USD", lookup });
  // 1M uncached tokens at $2 per million.
  assert.equal(summary.session.cost.toFixed(2), "2.00");
  assert.equal(summary.session.unpricedTurns, 0, "it is priced, not reported as unknown");
});

test("without a book the same turn is honestly unpriced, not silently free", () => {
  const events = billedTurn({ provider: "anthropic", model: "claude-sonnet-5.5" });
  const summary = summarizeCost({ events, nowMs: FRI("12:01"), currency: "USD" });
  assert.equal(summary.session.cost, 0);
  assert.equal(summary.session.unpricedTurns, 1, "an unknown cost is reported, never assumed to be zero");
});

test("DeepSeek's own table wins over the book, which lists it far cheaper", () => {
  // Not hypothetical: OpenRouter lists deepseek-v4.1-flash at $0.003/M input where
  // DeepSeek's own published off-peak rate is $0.15/M. The provider whose invoice
  // the user actually pays has to win.
  const events = billedTurn({ provider: "deepseek", model: "deepseek-flash" });
  let consulted = false;
  const lookup = () => {
    consulted = true;
    return { cacheHit: 0.003, cacheMiss: 0.003, output: 2.4, source: "openrouter" };
  };

  const summary = summarizeCost({ events, nowMs: FRI("12:01"), currency: "USD", lookup });
  assert.equal(summary.session.cost.toFixed(4), "0.1500", "the bundled DeepSeek rate, not the fetched one");
  assert.equal(consulted, false, "the book is not even asked about a model DeepSeek publishes");
});

test("each priced message records which provider answered", () => {
  const events = billedTurn({ provider: "anthropic", model: "claude-sonnet-5.5" });
  const messages = pricedMessages(events, "", "USD", () => ({ cacheHit: 0.2, cacheMiss: 2, output: 10, source: "openrouter" }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].provider, "anthropic", "so a turn spanning two providers is distinguishable from an unpriced one");
  assert.equal(messages[0].priced, true);
});

test("a currency normalises to one DeepSeek prices in", () => {
  assert.deepEqual(COST_CURRENCIES, ["CNY", "USD"]);
  assert.equal(normalizeCostCurrency("cny"), "CNY");
  assert.equal(normalizeCostCurrency(" USD "), "USD");
  assert.equal(normalizeCostCurrency(undefined), "USD", "an unknown currency falls back to the API's own reporting currency");
  assert.equal(normalizeCostCurrency("EUR"), "USD");
});

test("CNY is priced from DeepSeek's published CNY rates, not converted", () => {
  // Flash off-peak: CNY 1 per 1M uncached in, CNY 0.02 cached, CNY 4 out.
  const tokens = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };
  const cny = usageCost(tokens, "deepseek-flash", FRI("12:00"), "CNY");
  assert.equal(cny?.currency, "CNY");
  assert.equal(Number(cny?.cost.toFixed(4)), 5.02);

  const usd = usageCost(tokens, "deepseek-flash", FRI("12:00"), "USD");
  assert.equal(usd?.currency, "USD");
  assert.equal(Number(usd?.cost.toFixed(4)), 0.753);

  // The published CNY figures are not the USD ones times any rate, which is the
  // whole reason there is no exchange rate in this plugin.
  assert.notEqual(Number(cny?.cost.toFixed(2)), Number((usd.cost * 7.2).toFixed(2)));
});

test("an unknown currency falls back to USD rather than pricing at nothing", () => {
  const priced = usageCost({ inputTokens: 1_000_000 }, "deepseek-flash", FRI("12:00"), "EUR");
  assert.equal(priced?.currency, "USD");
  assert.equal(priced?.cost, 0.15);
});
