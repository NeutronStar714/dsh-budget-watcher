import assert from "node:assert/strict";
import test from "node:test";

import { OPENROUTER_MODELS_URL, createPriceBook, parseOpenRouterModels, resolveOpenRouter } from "../lib/pricing.js";
import { parseFxSetting } from "../lib/fx.js";

// Trimmed from a real /api/v1/models response: prices are USD per token, as strings.
const OPENROUTER_BODY = {
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      name: "Anthropic: Claude Sonnet 5.5",
      pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002", input_cache_write: "0.0000025" },
    },
    {
      id: "openai/gpt-5",
      name: "OpenAI: GPT-5",
      pricing: { prompt: "0.00000125", completion: "0.00001" },
    },
    { id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro", pricing: { prompt: "0.00000125", completion: "0.00001" } },
    { id: "broken/model", name: "No prices at all", pricing: {} },
    { name: "No id", pricing: { prompt: "1", completion: "1" } },
  ],
};

// --- the exchange-rate setting -------------------------------------------

test("the exchange-rate setting is auto by default and numeric when fixed", () => {
  assert.deepEqual(parseFxSetting(undefined), { mode: "auto", enabled: true, fallback: 0 });
  assert.deepEqual(parseFxSetting(""), { mode: "auto", enabled: true, fallback: 0 });
  assert.deepEqual(parseFxSetting("auto"), { mode: "auto", enabled: true, fallback: 0 });
  assert.deepEqual(parseFxSetting("AUTO"), { mode: "auto", enabled: true, fallback: 0 });

  // A number is the older behaviour: use it and do not ask anyone.
  assert.deepEqual(parseFxSetting(7.2), { mode: "fixed", enabled: false, fallback: 7.2 });
  assert.deepEqual(parseFxSetting("7.2"), { mode: "fixed", enabled: false, fallback: 7.2 });
  assert.deepEqual(parseFxSetting(" 6.7 "), { mode: "fixed", enabled: false, fallback: 6.7 });

  // Nonsense falls back to auto rather than to a made-up rate.
  assert.deepEqual(parseFxSetting(0), { mode: "auto", enabled: true, fallback: 0 });
  assert.deepEqual(parseFxSetting(-3), { mode: "auto", enabled: true, fallback: 0 });
  assert.deepEqual(parseFxSetting("cheap"), { mode: "auto", enabled: true, fallback: 0 });
  assert.deepEqual(parseFxSetting(Number.NaN), { mode: "auto", enabled: true, fallback: 0 });
});

// --- parsing the list -----------------------------------------------------

test("the model list is converted to a per-million rate card", () => {
  const index = parseOpenRouterModels(OPENROUTER_BODY);
  assert.equal(index.size, 3, "rows without an id or without both prices are dropped");

  const claude = index.byId.get("anthropic/claude-sonnet-5.5");
  // OpenRouter quotes per token, so 0.000002 is $2 per million.
  assert.equal(claude?.cacheMiss, 2);
  assert.equal(claude?.output, 10);
  assert.equal(claude?.cacheHit, 0.2);
  assert.equal(claude?.cacheWrite, 2.5);

  // A model with no cache price is billed as uncached rather than as free.
  const gpt = index.byId.get("openai/gpt-5");
  assert.equal(gpt?.cacheHit, gpt?.cacheMiss);
  assert.equal(gpt?.cacheWrite, gpt?.cacheMiss);
});

test("a session's bare model name resolves against the vendor-prefixed list", () => {
  const index = parseOpenRouterModels(OPENROUTER_BODY);
  // DSH records what the adapter reports, which is usually unprefixed.
  assert.equal(resolveOpenRouter(index, "claude-sonnet-5.5")?.id, "anthropic/claude-sonnet-5.5");
  assert.equal(resolveOpenRouter(index, "gpt-5")?.id, "openai/gpt-5");
  assert.equal(resolveOpenRouter(index, "Anthropic/Claude-Sonnet-5.5")?.id, "anthropic/claude-sonnet-5.5", "case-insensitive");
  assert.equal(resolveOpenRouter(index, "gemini-2.5-pro")?.id, "google/gemini-2.5-pro");
  assert.equal(resolveOpenRouter(index, "not-a-model"), undefined);
  assert.equal(resolveOpenRouter(index, ""), undefined);
});

test("a model resolves across the spellings real session logs use", () => {
  const index = parseOpenRouterModels(OPENROUTER_BODY);
  // Hyphens where the list has dots — the two houses disagree on version separators.
  assert.equal(resolveOpenRouter(index, "claude-sonnet-5-5")?.id, "anthropic/claude-sonnet-5.5");
  // A dated snapshot suffix names the undated model the list carries.
  assert.equal(resolveOpenRouter(index, "claude-sonnet-5.5-20250929")?.id, "anthropic/claude-sonnet-5.5");
  assert.equal(resolveOpenRouter(index, "gpt-5-20250101")?.id, "openai/gpt-5");
  // A vendor prefix the session spells differently still reaches the bare name.
  assert.equal(resolveOpenRouter(index, "vendor2/claude-sonnet-5-5")?.id, "anthropic/claude-sonnet-5.5");
  // Underscores where the list has hyphens.
  assert.equal(resolveOpenRouter(index, "gemini_2_5_pro")?.id, "google/gemini-2.5-pro");

  // Dropping a date must not conjure a model the list never carried.
  assert.equal(resolveOpenRouter(index, "claude-sonnet-4-5-20250929"), undefined);
  // The batch twin keeps its colon, so the interactive price is never used for it.
  const batched = parseOpenRouterModels({
    data: [
      { id: "openai/gpt-5", pricing: { prompt: "0.000001", completion: "0.00001" } },
      { id: "openai/gpt-5:batch", pricing: { prompt: "0.0000005", completion: "0.000005" } },
    ],
  });
  assert.equal(resolveOpenRouter(batched, "gpt-5:batch")?.cacheMiss, 0.5);
  assert.equal(resolveOpenRouter(batched, "gpt-5")?.cacheMiss, 1, "first write wins for the bare name");
});

test("a malformed list is empty rather than a crash", () => {
  assert.equal(parseOpenRouterModels(undefined).size, 0);
  assert.equal(parseOpenRouterModels({}).size, 0);
  assert.equal(parseOpenRouterModels({ data: "nope" }).size, 0);
  assert.equal(parseOpenRouterModels({ data: [null, 7] }).size, 0);
});

// --- the book -------------------------------------------------------------

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test("a fetched model is priced in USD, and converted when the display is CNY", async () => {
  const book = createPriceBook({ fetchImpl: async (url) => {
    assert.equal(url, OPENROUTER_MODELS_URL);
    return response(OPENROUTER_BODY);
  } });

  assert.equal(await book.refresh(), true);

  const usd = book.lookup("claude-sonnet-5.5", { currency: "USD" });
  assert.equal(usd?.cacheMiss, 2);
  assert.equal(usd?.currency, "USD");
  assert.equal(usd?.source, "openrouter");

  const cny = book.lookup("claude-sonnet-5.5", { currency: "CNY", usdToCny: 7 });
  assert.equal(cny?.cacheMiss, 14);
  assert.equal(cny?.output, 70);
  assert.equal(cny?.currency, "CNY");
});

test("a USD price with no rate available is unpriced, never converted at a guess", async () => {
  const book = createPriceBook({ fetchImpl: async () => response(OPENROUTER_BODY) });
  await book.refresh();
  assert.equal(book.lookup("claude-sonnet-5.5", { currency: "CNY" }), undefined, "no rate means no answer");
  assert.equal(book.lookup("claude-sonnet-5.5", { currency: "CNY", usdToCny: 0 }), undefined);
  assert.equal(book.lookup("claude-sonnet-5.5", { currency: "EUR", usdToCny: 7 }), undefined, "only CNY is convertible here");
});

test("a bundled Chinese price wins, and needs no conversion", async () => {
  const book = createPriceBook({
    bundled: { "glm-4.6": { currency: "CNY", cacheHit: 0.1, cacheMiss: 2, output: 8, label: "GLM-4.6" } },
    fetchImpl: async () => response(OPENROUTER_BODY),
  });
  await book.refresh();

  const cny = book.lookup("glm-4.6", { currency: "CNY" });
  assert.equal(cny?.cacheMiss, 2, "a CNY price shown in CNY is used as published");
  assert.equal(cny?.source, "bundled");

  // Asked for in USD it cannot answer, because nothing here converts CNY to USD.
  assert.equal(book.lookup("glm-4.6", { currency: "USD" }), undefined);
});

test("a failure leaves the last good list standing", async () => {
  let broken = false;
  const book = createPriceBook({
    ttlMs: 0,
    fetchImpl: async () => {
      if (broken) throw new Error("offline");
      return response(OPENROUTER_BODY);
    },
  });
  await book.refresh();
  broken = true;
  assert.equal(await book.refresh(true), false, "the refresh failed and says so");
  assert.equal(book.lookup("gpt-5", { currency: "USD" })?.cacheMiss, 1.25, "but the rate card survives");
});

test("with nothing but a bundled table it still answers, and never fetches", async () => {
  let called = false;
  const book = createPriceBook({
    enabled: false,
    bundled: { "deepseek-flash": { currency: "CNY", cacheHit: 0.02, cacheMiss: 1, output: 4 } },
    fetchImpl: async () => {
      called = true;
      return response(OPENROUTER_BODY);
    },
  });
  assert.equal(await book.refresh(), false);
  assert.equal(called, false);
  assert.equal(book.lookup("deepseek-flash", { currency: "CNY" })?.output, 4);
});

test("an empty or failed fetch leaves an unknown model unpriced", async () => {
  const book = createPriceBook({ fetchImpl: async () => response({ data: [] }) });
  await book.refresh();
  assert.equal(book.lookup("gpt-5", { currency: "USD" }), undefined);
});

test("concurrent refreshes share one fetch", async () => {
  let calls = 0;
  const book = createPriceBook({
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return response(OPENROUTER_BODY);
    },
  });
  await Promise.all([book.refresh(true), book.refresh(true), book.refresh(true)]);
  assert.equal(calls, 1, "one list, however many windows asked at once");
});

test("the snapshot reports provenance without a network call", async () => {
  const book = createPriceBook({ fetchImpl: async () => response(OPENROUTER_BODY), bundled: { a: { currency: "USD", cacheHit: 1, cacheMiss: 1, output: 1 } } });
  assert.equal(book.snapshot().fetched, 0);
  assert.equal(book.snapshot().stale, true, "nothing fetched yet is honestly stale");
  await book.refresh();
  const after = book.snapshot();
  assert.equal(after.fetched, 3);
  assert.equal(after.bundled, 1);
  assert.equal(after.stale, false);
  assert.equal(typeof after.fetchedAt, "string");
});
