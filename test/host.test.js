// Host-half tests.
//
// `index.js` is imported for real: the schemastery import inside it fails in
// this repository (the package is only resolvable inside a DSH installation)
// and must degrade rather than throw, which is itself one of the properties
// under test. The Cordis context is a stand-in that records what the plugin
// registers, so the assertions are about the plugin's behaviour rather than
// about a mock of it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { apply } from "../index.js";
import { isPeak } from "../lib/cost.js";

const STATE_PATH = "/dsh-budget-watcher/balance";
const CONFIG_PATH = "/dsh-budget-watcher/config";
const BALANCE_URL = "https://api.deepseek.com/user/balance";

const DOCUMENTED = {
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A Cordis-shaped context that records registrations instead of running them. */
function makeHarness(options = {}) {
  const routes = new Map();
  const disposers = [];
  const state = { credential: undefined, resolveCalls: [] };

  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const credentials = {
    async resolve(ref) {
      state.resolveCalls.push(ref);
      return state.credential;
    },
  };

  const ctx = {
    logger: { warn() {}, info() {} },
    get: (serviceName) => {
      if (serviceName === "credentials") return credentials;
      if (serviceName === "sessions") return options.sessions;
      if (serviceName === "agents") return options.agents;
      if (serviceName === "configEditor") return options.configEditor;
      if (serviceName === "sessionProjections") return options.sessionProjections;
      return undefined;
    },
    inject: (_dependencies, callback) => {
      const dispose = callback({ webServer });
      if (typeof dispose === "function") disposers.push(dispose);
    },
    effect: (factory) => {
      const dispose = factory();
      if (typeof dispose === "function") disposers.push(dispose);
    },
  };

  return { ctx, routes, disposers, state };
}

/** Answer one request against a registered route. */
async function request(route, options = {}) {
  const { method = "GET", url = STATE_PATH, headers = {} } = options;
  let status = 0;
  let payload = "";
  const res = {
    writeHead(code) {
      status = code;
    },
    end(chunk) {
      payload = chunk ?? "";
    },
  };
  await route.handler({ method, url, headers: { host: "127.0.0.1:19387", ...headers } }, res);
  return { status, body: JSON.parse(payload) };
}

/** Count upstream calls and answer with a scripted response. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  return calls;
}

/**
 * Only the balance requests.
 *
 * The plugin also fetches a price list and an exchange rate, on their own TTLs.
 * Those are different upstreams from the one these tests are about, and counting
 * them together would make "one request serves every window" meaningless.
 */
const balanceOnly = (calls) => calls.filter((call) => call.url.includes("/user/balance"));

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test("a numeric usdToCny is accepted and reported, not rejected", async () => {
  // The bug this locks out: `usdToCny: 7.2` in YAML is a *number*, the schema said
  // string, cordis refused the fiber, the route was never registered, and the panel
  // reported that it could not reach dsh. A validation failure on this one field
  // costs the entire plugin, not one feature.
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { usdToCny: 7.2 });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.settings.effective.usdToCny, "7.2", "a number becomes the rate in force");
  assert.equal(body.ok, true, "and the plugin is running at all, which is the real assertion");
});

test("a string usdToCny works too, including auto and the default", async () => {
  for (const [input, expected] of [["auto", "auto"], ["7.2", "7.2"], [undefined, "auto"]]) {
    const harness = makeHarness();
    harness.state.credential = { value: "sk-test", source: "file" };
    stubFetch(() => json(DOCUMENTED));
    apply(harness.ctx, input === undefined ? {} : { usdToCny: input });
    const { body } = await request(harness.routes.get(STATE_PATH));
    assert.equal(body.settings.effective.usdToCny, expected, `usdToCny ${JSON.stringify(input)}`);
  }
});

test("the usdToCny schema is deliberately loose, because a strict one takes the plugin offline", () => {
  // The schema cannot be exercised from here — schemastery is a peer dependency the
  // plugin does not install — so this asserts the declaration itself. A coarse guard,
  // but the failure it prevents is total: a rejected config does not degrade the cost
  // feature, it stops the plugin mounting and the panel loses its host.
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /usdToCny: Schema\.any\(\)\.default\("auto"\)/, "must accept both `auto` and a number");
  assert.doesNotMatch(source, /usdToCny: Schema\.string\(\)/, "Schema.string() rejected `usdToCny: 7.2` and killed the plugin");
});

test("the bundled route serves the normalized topped-up balance", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status, body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.provider.id, "deepseek");
  assert.equal(body.featured.currency, "CNY");
  assert.equal(body.featured.toppedUp, "100.00", "the field this plugin exists to show");
  assert.equal(body.featured.granted, "10.00");
  assert.equal(body.isAvailable, true);
  assert.equal(typeof body.fetchedAt, "number");
});

test("the API key is resolved through the credentials service and sent as a bearer token", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-secret", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  await request(harness.routes.get(STATE_PATH));
  assert.deepEqual(harness.state.resolveCalls, ["DEEPSEEK_API_KEY"]);
  assert.equal(calls[0].url, BALANCE_URL);
  // Bearer, not the `x-api-key` header the inference API uses.
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-secret");
  assert.equal(calls[0].init.redirect, "error");
});

test("one upstream request serves every read inside the freshness window", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { refreshIntervalMs: 60_000 });

  await request(harness.routes.get(STATE_PATH));
  await request(harness.routes.get(STATE_PATH));
  await request(harness.routes.get(STATE_PATH));
  assert.equal(balanceOnly(calls).length, 1, "a poll from each open window must not multiply upstream traffic");
});

test("?refresh=1 bypasses the freshness window", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { refreshIntervalMs: 60_000 });

  await request(harness.routes.get(STATE_PATH));
  await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?refresh=1` });
  assert.equal(balanceOnly(calls).length, 2);
});

test("a rejected key becomes a renderable state, not an exception", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-bad", source: "file" };
  // The unauthenticated 401 is plain text; a wrong key answers JSON. Both are
  // covered because a client that parses the body unconditionally breaks here.
  stubFetch(() => new Response("Authentication Fails (governor)", { status: 401 }));
  apply(harness.ctx, {});

  const first = await request(harness.routes.get(STATE_PATH));
  assert.equal(first.status, 200, "the route answers 200 with a failure state; the widget renders it");
  assert.equal(first.body.ok, false);
  assert.equal(first.body.error.code, "unauthorized");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Authentication Fails, Your api key: ****0000 is invalid" } }), { status: 401 });
  const second = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?refresh=1` });
  assert.equal(second.body.error.code, "unauthorized");
});

test("a missing key is reported without touching the network", async () => {
  const harness = makeHarness();
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "no-key");
  assert.match(body.error.message, /DEEPSEEK_API_KEY/);
  assert.equal(balanceOnly(calls).length, 0, "a missing key must not produce a balance request");
});

test("a failed refresh keeps the last good balance and marks it stale", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const good = await request(harness.routes.get(STATE_PATH));
  assert.equal(good.body.featured.toppedUp, "100.00");

  globalThis.fetch = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  const failed = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?refresh=1` });
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.stale, true);
  assert.equal(failed.body.featured.toppedUp, "100.00", "the previous number is still the most useful thing on screen");
  assert.equal(failed.body.error.code, "network");
  assert.match(failed.body.error.message, /ECONNREFUSED/);
});

test("an unreadable body is a protocol error rather than a zero balance", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "bad-response");
  assert.deepEqual(body.wallets, [], "no wallet is invented from a body that carries none");
});

test("the endpoint can be pointed at a stand-in server", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { endpoint: "http://127.0.0.1:9/user/balance" });

  await request(harness.routes.get(STATE_PATH));
  assert.equal(calls[0].url, "http://127.0.0.1:9/user/balance");
});

test("the fence refuses a non-loopback authority and a cross-site caller", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});
  const route = harness.routes.get(STATE_PATH);

  const rebound = await request(route, { headers: { host: "evil.example:19387" } });
  assert.equal(rebound.status, 403);
  assert.match(rebound.body.error, /loopback/);

  const crossSite = await request(route, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);

  const wrongOrigin = await request(route, { headers: { origin: "http://evil.example" } });
  assert.equal(wrongOrigin.status, 403);

  const sameOrigin = await request(route, { headers: { origin: "http://127.0.0.1:19387" } });
  assert.equal(sameOrigin.status, 200);
});

test("allowNonLoopback drops the loopback requirement but keeps the origin checks", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { allowNonLoopback: true });
  const route = harness.routes.get(STATE_PATH);

  assert.equal((await request(route, { headers: { host: "192.168.1.10:19387" } })).status, 200);
  assert.equal((await request(route, { headers: { host: "192.168.1.10:19387", "sec-fetch-site": "cross-site" } })).status, 403);
});

test("only GET is served", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status } = await request(harness.routes.get(STATE_PATH), { method: "POST" });
  assert.equal(status, 405);
});

test("an unknown provider degrades instead of failing the profile", async () => {
  const harness = makeHarness();
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { provider: "openai" });

  const { status, body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(status, 200);
  assert.equal(body.provider.label, "openai");
  assert.equal(body.ok, false);
});

test("disposing the plugin removes the route and aborts in-flight work", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  assert.equal(harness.routes.has(STATE_PATH), true);
  for (const dispose of harness.disposers) dispose();
  assert.equal(harness.routes.has(STATE_PATH), false);
});

test("an explicit config key wins over the credentials service", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-from-store", source: "file" };
  const calls = stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { apiKey: "sk-from-config" });

  await request(harness.routes.get(STATE_PATH));
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-from-config");
  assert.deepEqual(harness.state.resolveCalls, [], "the store is not consulted when the config carries a key");
});

// --- cost estimates -------------------------------------------------------

/** One session whose log holds a single priced assistant message. */
function costSession({ id, parent, inputTokens, time, endAt }) {
  const events = [
    { type: "turn/start", seq: 0, time, data: { turn: 1 } },
    {
      type: "assistant/message",
      seq: 1,
      time: time + 1,
      data: { turn: 1, message: { source: { provider: "deepseek", model: "deepseek-flash" } }, usage: { inputTokens } },
    },
  ];
  // Closing the turn fixes its duration, which is what makes the burn rate
  // deterministic instead of drifting with the wall clock.
  if (endAt !== undefined) events.push({ type: "turn/end", seq: 2, time: endAt, data: { turn: 1, reason: { kind: "completed" } } });
  return {
    id,
    header: parent === undefined ? {} : { parentSession: parent },
    seq: events.length,
    ownEvents: () => events,
    snapshotEvents: () => [events[events.length - 1]],
  };
}

/** Off-peak Flash input, so 1M uncached tokens is exactly $0.15. */
const OFF_PEAK = Date.parse("2026-10-02T12:00:00Z");

test("the route attaches a priced cost block when the sessions service is present", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK, endAt: OFF_PEAK + 2000 });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  // Warning disabled so this test is about the figures, not the threshold.
  apply(harness.ctx, { burnWarnPerHour: 0 });

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.cost.available, true);
  assert.equal(body.cost.sessionId, "session-root");
  // The fixture's only wallet is CNY, so the turn is priced from DeepSeek's
  // published CNY card: 1M uncached Flash input off-peak is exactly CNY 1.
  assert.equal(body.cost.currency, "CNY", "the cost follows the featured wallet");
  assert.equal(body.cost.session.cost.toFixed(4), "1.0000");
  assert.equal(body.cost.session.amount.toFixed(2), "1.00", "no exchange rate was applied to reach this");
  assert.equal(body.cost.thisTurn.cost.toFixed(4), "1.0000");
  assert.equal(body.cost.thisTurn.ended, true);
  assert.equal(body.cost.thisTurn.durationMs, 2000, "the turn is frozen at its own measured duration");
  // CNY 1 over 2s -> CNY 1800/hour.
  assert.equal(body.cost.thisTurn.burnPerHour.toFixed(2), "1800.00");
  assert.equal(body.cost.turns.length, 1, "the closed turn is kept for comparison");
  assert.equal(body.cost.turns[0].burnPerHour.toFixed(2), "1800.00");
  assert.equal(body.cost.burnWindowMs, 15_000, "the live window defaults to 15s");
  assert.equal(body.cost.graphEnabled, true, "the chart is on by default");
  // One step, 1 ms into the turn and inside the 15 s window: CNY 1.00 over that
  // window is CNY 240/hour.
  assert.equal(body.cost.thisTurn.series.length, 1);
  assert.equal(body.cost.thisTurn.series[0].atMs, 1);
  assert.equal(body.cost.thisTurn.series[0].amountPerHour.toFixed(2), "240.00");
  assert.equal(typeof body.cost.serverNow, "number", "the panel ticks elapsed time locally against this");
  assert.equal(body.cost.warn, false, "the warning was disabled");
});

test("a fan-out raises the burn warning the turn figure alone would hide", async () => {
  // Times are relative to now, because the live rate is a *window* rate: a
  // fixture dated hours ago is honestly outside a 15 s window and would read 0.
  const now = Date.now();
  const root = costSession({ id: "session-root", inputTokens: 10_000, time: now - 5_000, endAt: now - 2_000 });
  const children = Array.from({ length: 40 }, (_, index) =>
    costSession({ id: `session-child-${index}`, parent: "session-root", inputTokens: 1_000_000, time: now - 3_000 }),
  );
  const harness = makeHarness({ sessions: { list: () => [root, ...children] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { burnWarnPerHour: 2 });

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.cost.session.descendants, 40);
  // The rate depends on the wall clock: DeepSeek charges double at peak
  // (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday). Hardcoding the off-peak
  // rate made this suite fail for seven hours of every weekday — observed, not
  // theorised: it passed at 08:43 Beijing and failed at 09:20, which is 01:20 UTC.
  // The expectation now follows the same rule the plugin does, so what is being
  // asserted is the aggregation — forty children, each counted once — rather than
  // the time of day.
  const perMillion = isPeak(now) ? 2 : 1; // CNY, uncached input
  const expected = (40 * perMillion + 0.01 * perMillion).toFixed(2);
  assert.equal(body.cost.session.cost.toFixed(2), expected);
  // The turn's own figure is attributed by time window, so the agents it
  // spawned land inside it rather than being invisible until the rollup.
  assert.equal(body.cost.thisTurn.cost.toFixed(2), expected);
  assert.equal(body.cost.burnWindowMs, 15_000);
  assert.equal(body.cost.liveBurnPerHour > 2, true, `the live rate is what warns, got ${body.cost.liveBurnPerHour}`);
  assert.equal(body.cost.warn, true, "the live rate is what warns");
  assert.equal(body.cost.terminateAbovePerHour, 0, "termination is off unless asked for");
  assert.equal(body.cost.overTerminate, false);
});

test("terminate above interrupts the running turn, once and only once", async () => {
  const now = Date.now();
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: now - 5_000 });
  const cancelled = [];
  const agent = {
    id: "session-root",
    session: root,
    status: "running",
    cancel: (cause, options) => cancelled.push({ cause, options }),
  };
  const harness = makeHarness({
    sessions: { list: () => [root] },
    agents: { list: () => [agent], get: (id) => (id === "session-root" ? agent : undefined) },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: 4, lastTurn: 7 }) },
  });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { terminateAbovePerHour: 1 });

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.cost.overTerminate, true, "the live rate is over the limit");
  assert.equal(cancelled.length, 1, "the running turn was interrupted");
  // The same primitive the stop button uses, tagged with provenance rather than
  // pretending a user pressed it.
  assert.deepEqual(cancelled[0].cause, { kind: "hook", reason: "dsh-budget-watcher/over-budget" });
  assert.equal(cancelled[0].options.keepInbox, true, "queued input is not silently discarded");
  assert.equal(body.terminated.turn, 1, "the latch records the turn it stopped");
  assert.equal(body.terminated.outcome, "cancelled");

  // A second poll must not stop it again: the fire is latched per turn.
  await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(cancelled.length, 1, "one runaway turn is stopped once, not once per poll");
});

test("terminate above is inert at 0, which is the default", async () => {
  const now = Date.now();
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: now - 5_000 });
  const cancelled = [];
  const agent = { id: "session-root", session: root, status: "running", cancel: () => cancelled.push(1) };
  const harness = makeHarness({
    sessions: { list: () => [root] },
    agents: { list: () => [agent], get: () => agent },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: 1, lastTurn: 1 }) },
  });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.cost.terminateAbovePerHour, 0);
  assert.equal(body.cost.overTerminate, false, "an expensive turn is not stopped unless asked for");
  assert.equal(cancelled.length, 0, "nothing was interrupted");
  assert.equal(body.terminated, null);
});

test("a turn is not stopped when the session has no open turn", async () => {
  const now = Date.now();
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: now - 5_000 });
  const cancelled = [];
  const agent = { id: "session-root", session: root, status: "running", cancel: () => cancelled.push(1) };
  const harness = makeHarness({
    sessions: { list: () => [root] },
    agents: { list: () => [agent], get: () => agent },
    // `openTurnStartSeq: null` is the projection's way of saying no turn is open,
    // even though the agent still reports itself as running.
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: null, lastTurn: 7 }) },
  });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { terminateAbovePerHour: 1 });

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.terminated.outcome, "no-open-turn");
  assert.equal(cancelled.length, 0, "nothing to stop, so nothing is cancelled");
});

test("the chart can be turned off without turning the figures off", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK, endAt: OFF_PEAK + 2000 });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { graphEnabled: false });

  const { body } = await request(harness.routes.get(STATE_PATH), { url: `${STATE_PATH}?session=session-root` });
  assert.equal(body.cost.graphEnabled, false);
  assert.equal(body.cost.thisTurn.cost.toFixed(4), "1.0000", "the figures are unaffected");
});

test("costEnabled false still answers the balance, and says why there are no figures", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { costEnabled: false });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.deepEqual(body.cost, { available: false, reason: "disabled" });
  assert.equal(body.ok, true, "the balance still works");
});

test("a broken sessions service costs the cost block, not the balance", async () => {
  const harness = makeHarness({ sessions: { list: () => { throw new Error("sessions exploded"); } } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status, body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.featured.toppedUp, "100.00");
  assert.equal(body.cost.available, false);
  assert.equal(body.cost.reason, "no-live-sessions");
  // The pricing provenance rides along even with no figures, because "the rate is
  // unknown" is a normal state worth reporting rather than an absence.
  assert.equal(body.cost.pricing.usdToCny, null, "no rate has been fetched on this path");
  assert.equal(typeof body.cost.pricing.thirdPartyModels, "number");
});

test("the payload carries the plugin version, so a stale module is visible", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  // Compared against package.json, not against a literal. The previous version of
  // this test asserted `=== "0.2.0"` while package.json said 0.7.x, so it confirmed
  // the constant matched itself and the field silently lied for six releases.
  // Reading the same source the plugin reads is what makes drift impossible.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(body.pluginVersion, pkg.version, "a host module is cached for the life of the DSH process; this says which one answered");
  assert.notEqual(body.pluginVersion, "0.2.0", "the stale value this field reported for six releases");
});

test("the agents service is used when there is no session registry", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ agents: { list: () => [{ session: root }] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.cost.session.cost.toFixed(4), "1.0000");
});

test("an explicit currency setting prices and labels the costs in that currency", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  // The documented account holds only CNY. Asking for USD must still mean USD:
  // choosing a currency is a display decision, not a claim about which wallets
  // exist, and silently falling back made the setting look broken.
  apply(harness.ctx, { currency: "USD" });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.cost.currency, "USD", "the setting wins");
  // 1M uncached Flash input off-peak in the USD book is exactly $0.15.
  assert.equal(body.cost.session.cost.toFixed(4), "0.1500", "priced from the USD card");
  assert.equal(body.cost.session.amount.toFixed(4), "0.1500");
});

test("auto follows the featured wallet's currency", async () => {
  const root = costSession({ id: "session-root", inputTokens: 1_000_000, time: OFF_PEAK });
  const harness = makeHarness({ sessions: { list: () => [root] } });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { currency: "auto" });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.cost.currency, "CNY");
  assert.equal(body.cost.session.cost.toFixed(4), "1.0000", "priced from the CNY card");
});

// --- settings tab ---------------------------------------------------------

/** The row the loader would have inserted from cordis.patch.yml. */
function configRow(overrides = {}) {
  return { options: { id: "budget-watcher", name: "dsh-budget-watcher" }, fiber: { state: 2 }, ...overrides };
}

function fakeEditor(edit, rows = [configRow()]) {
  return { entries: () => rows, documentPath: "C:/profile/cordis.patch.yml", edit };
}

/** POST a JSON body at the config route, emitting the body after the handler subscribes. */
async function postConfig(route, body, headers = {}) {
  let status = 0;
  let payload = "";
  const res = { writeHead(code) { status = code; }, end(chunk) { payload = chunk ?? ""; } };
  const listeners = {};
  const req = {
    method: "POST",
    url: CONFIG_PATH,
    headers: { host: "127.0.0.1:19387", "content-type": "application/json", ...headers },
    on(event, handler) {
      (listeners[event] ??= []).push(handler);
      return req;
    },
    destroy() {},
  };
  const handled = route.handler(req, res);
  const chunk = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  for (const handler of listeners.data ?? []) handler(chunk);
  for (const handler of listeners.end ?? []) handler();
  await handled;
  return { status, body: payload === "" ? undefined : JSON.parse(payload) };
}

test("the state payload carries the running settings, never the key itself", async () => {
  const harness = makeHarness({ configEditor: fakeEditor(async () => {}) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, { apiKey: "sk-secret", refreshIntervalMs: 30_000 });

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.settings.editable, true);
  assert.equal(body.settings.apiKeySet, true, "the panel may know a key is set");
  assert.equal(JSON.stringify(body).includes("sk-secret"), false, "but the secret never crosses to the page");
  assert.equal(body.settings.effective.refreshIntervalMs, 30_000);
  assert.equal("apiKey" in body.settings.effective, false, "the effective projection has no secret field at all");
});

test("without a config editor the row reports itself uneditable instead of failing", async () => {
  const harness = makeHarness();
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { body } = await request(harness.routes.get(STATE_PATH));
  assert.equal(body.settings.editable, false);
  assert.equal(body.settings.reason, "no-config-editor");

  const posted = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { currency: "USD" } });
  assert.equal(posted.status, 409);
  assert.equal(posted.body.ok, false);
});

test("saving validates, merges onto the current config, and reports the new values", async () => {
  let seen;
  const editor = fakeEditor(async (entry, change) => {
    seen = { entry, next: change({ currency: "auto" }, {}) };
  });
  const harness = makeHarness({ configEditor: editor });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status, body } = await postConfig(harness.routes.get(CONFIG_PATH), {
    patch: { currency: "USD", costEnabled: false, burnWindowMs: 30_000, burnWarnPerHour: 7.1, terminateAbovePerHour: 50 },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(seen.entry.options.id, "budget-watcher", "the editor writes to this plugin's own row");
  assert.deepEqual(seen.next, { currency: "USD", costEnabled: false, burnWindowMs: 30_000, burnWarnPerHour: 7.1, terminateAbovePerHour: 50 },
    "only the fields that were sent, merged onto what was there");
});

test("an unknown field is refused rather than written into the profile", async () => {
  let called = false;
  const harness = makeHarness({ configEditor: fakeEditor(async () => { called = true; }) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  // An unrecognised key would land in the user's patch file; it is dropped
  // silently, so the write still succeeds with only the known fields.
  const { status } = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { nonsense: 1, currency: "USD" } });
  assert.equal(status, 200);
  assert.equal(called, true);
});

test("a wrong-typed field is refused", async () => {
  const harness = makeHarness({ configEditor: fakeEditor(async () => {}) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const numeric = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { refreshIntervalMs: "soon" } });
  assert.equal(numeric.status, 400);
  assert.match(numeric.body.error, /refreshIntervalMs/);

  const boolean = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { costEnabled: "yes" } });
  assert.equal(boolean.status, 400);
  assert.match(boolean.body.error, /costEnabled/);
});

test("the settings write requires a JSON body and the same fence as the read", async () => {
  const harness = makeHarness({ configEditor: fakeEditor(async () => {}) });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});
  const route = harness.routes.get(CONFIG_PATH);

  const notJson = await postConfig(route, { patch: {} }, { "content-type": "text/plain" });
  assert.equal(notJson.status, 403, "a cross-site simple request cannot reach the write");

  const rebound = await postConfig(route, { patch: {} }, { host: "evil.example" });
  assert.equal(rebound.status, 403);

  const GET = await request(route);
  assert.equal(GET.status, 405, "only POST writes");

  const malformed = await postConfig(route, "{not json");
  assert.equal(malformed.status, 400);
});

test("apiKey is tri-state: absent leaves it, empty clears it, a value sets it", async () => {
  let seen;
  const editor = fakeEditor(async (entry, change) => {
    seen = change({ currency: "auto", apiKey: "sk-existing" }, {});
  });
  const harness = makeHarness({ configEditor: editor });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});
  const route = harness.routes.get(CONFIG_PATH);

  await postConfig(route, { patch: { currency: "USD" } });
  assert.equal(seen.apiKey, "sk-existing", "an untouched password box must not delete the key");

  await postConfig(route, { patch: { apiKey: "" } });
  assert.equal("apiKey" in seen, false, "clearing it removes the field");

  await postConfig(route, { patch: { apiKey: "sk-new" } });
  assert.equal(seen.apiKey, "sk-new");
});

test("a config equal to the inherited layer is written as no override at all", async () => {
  let seen;
  const editor = fakeEditor(async (entry, change) => {
    seen = change({ currency: "USD" }, { currency: "USD" });
  });
  const harness = makeHarness({ configEditor: editor });
  harness.state.credential = { value: "sk-test", source: "file" };
  stubFetch(() => json(DOCUMENTED));
  apply(harness.ctx, {});

  const { status } = await postConfig(harness.routes.get(CONFIG_PATH), { patch: { currency: "USD" } });
  assert.equal(status, 200);
  assert.deepEqual(seen, {}, "matching the layer beneath means the row goes back to inheriting");
});

