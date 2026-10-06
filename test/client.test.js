// Client-half tests.
//
// The browser half is a classic script that hands a factory to
// `window.__ModuleLoader__`, so it is loaded here the way the shell loads it —
// in a VM context with a `window`, a `document` and a stubbed `fetch` — rather
// than imported as a module. React is stubbed with a hook harness that can run
// one render pass, which is enough to assert what the widget actually draws for
// each host state without pulling in a DOM implementation.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const PACKAGE_NAME = "dsh-budget-watcher";
// The overlay cell key is its own namespace: it must be an id this plugin owns
// so the entry is added beside the shipped ones rather than replacing one.
const SLOT_ID = "budget-watcher";

/** Flush the microtask queue enough times for a fetch chain to settle. */
async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Minimal React: element objects plus hooks that survive a manual re-render. */
function createReact() {
  const store = { states: [], refs: [], cursor: 0, effects: [] };
  return {
    store,
    React: {
      createElement(type, props, ...children) {
        const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
        return { type, props: { ...(props ?? {}), children: kids } };
      },
      useState(initial) {
        const index = store.cursor++;
        if (!(index in store.states)) store.states[index] = typeof initial === "function" ? initial() : initial;
        const set = (next) => {
          store.states[index] = typeof next === "function" ? next(store.states[index]) : next;
        };
        return [store.states[index], set];
      },
      useRef(initial) {
        const index = store.cursor++;
        if (!(index in store.refs)) store.refs[index] = { current: initial };
        return store.refs[index];
      },
      useCallback(callback) {
        store.cursor++;
        return callback;
      },
      useEffect(effect) {
        store.cursor++;
        store.effects.push(effect);
      },
    },
  };
}

/** Run one render pass, then the effects that render scheduled. */
function render(component, store, props = {}) {
  store.cursor = 0;
  store.effects = [];
  const tree = component(props);
  const cleanups = [];
  for (const effect of store.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return { tree, cleanups };
}

/** Every string a React element tree would render. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return textOf(node.props?.children);
}

/**
 * Load `lib/client.cjs` the way the web shell does and hand back the module it
 * registered plus the parts of the environment the assertions need.
 */
async function loadPlugin(options = {}) {
  const source = await readFile(new URL("../lib/client.cjs", import.meta.url), "utf8");
  const registrations = [];
  const styles = [];
  const storage = new Map(Object.entries(options.storage ?? {}));

  const document = {
    baseURI: "http://127.0.0.1:19387/",
    querySelector(selector) {
      return styles.find((style) => `style[data-plugin-css="${style.dataset.pluginCss}"]` === selector) ?? null;
    },
    createElement(tag) {
      return { tag, dataset: {}, textContent: "" };
    },
    head: { appendChild: (element) => styles.push(element) },
  };

  // The delays are recorded, not discarded: the poll cadence is the difference
  // between noticing a prompt in seconds and looking frozen until someone presses
  // refresh, and that is worth asserting.
  const intervalDelays = [];
  const window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    setInterval: (_fn, delay) => {
      intervalDelays.push(delay);
      return intervalDelays.length;
    },
    clearInterval: () => {},
    innerWidth: 1280,
    innerHeight: 800,
  };

  const fetchCalls = [];
  const sandbox = {
    window,
    document,
    console,
    URL,
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return options.respond === undefined ? new Response("{}", { status: 200 }) : options.respond(String(url), init);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "client.cjs" });

  assert.equal(registrations.length, 1, "the bundle must register exactly one module");
  const registration = registrations[0];
  const moduleExports = registration.factory((specifier) => {
    if (specifier === "react") return options.React;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });

  return { registration, moduleExports, styles, storage, fetchCalls, document, intervalDelays };
}

const HOST_STATE = {
  ok: true,
  stale: false,
  provider: { id: "deepseek", label: "DeepSeek" },
  refreshIntervalMs: 60_000,
  fetchedAt: Date.now() - 5_000,
  isAvailable: true,
  wallets: [{ currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" }],
  featured: { currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00" },
  error: null,
  lastAttemptAt: Date.now() - 5_000,
};

/** Load the plugin, mount the overlay entry, and return the registered component. */
async function mount(options = {}) {
  const { React, store } = createReact();
  const loaded = await loadPlugin({
    React,
    respond: options.respond ?? (() => Response.json(options.state ?? HOST_STATE)),
    storage: options.storage,
  });

  const entries = [];
  const tabEntries = [];
  const serviceDisposers = [];
  let slotName;
  let openedTab = null;

  // Only the services a test asks for exist; everything else reads as absent,
  // which is how `apply` decides whether to offer the settings button.
  const services = { ...(options.services ?? {}) };
  if (options.withSidebar === true) {
    services.sidebarRight = {
      openTabIn: (sessionId, kind) => {
        openedTab = { sessionId, kind };
      },
    };
    services.sidebarRightTabs = {
      register: (definition) => {
        tabEntries.push({ definition });
        return () => {};
      },
    };
  }

  const ctx = {
    get: (name) => services[name],
    inject: (_dependencies, callback) => {
      const dispose = callback(ctx);
      if (typeof dispose === "function") serviceDisposers.push(dispose);
    },
    slots: {
      inject: (name, callback) => {
        slotName = name;
        // `inject` runs its callback synchronously when the slot is already
        // declared, which is the case once ui-layout has mounted.
        const dispose = callback();
        return typeof dispose === "function" ? dispose : () => {};
      },
      register: (registration, component) => {
        entries.push({ registration, component });
        return () => {};
      },
    },
  };
  // The tab body and title are registered on the *sidebar's* slots, not the
  // overlay's, so the sidebar host needs its own register.
  ctx.inject = (_dependencies, callback) => {
    const injected = {
      get: (name) => services[name],
      slots: {
        register: (registration, component) => {
          entries.push({ registration, component });
          return () => {};
        },
      },
    };
    const dispose = callback(injected);
    if (typeof dispose === "function") serviceDisposers.push(dispose);
  };

  loaded.moduleExports.apply(ctx);
  assert.equal(entries.filter((candidate) => candidate.registration.name === "shell.overlay").length, 1, "apply() must register exactly one component into shell.overlay");
  const entry = entries.find((candidate) => candidate.registration.name === "shell.overlay");
  return {
    ...loaded,
    store,
    component: entry.component,
    entry,
    slotName,
    entries,
    tabEntries,
    serviceDisposers,
    openedTab: () => openedTab,
  };
}

test("the bundle registers under the package name the loader composes for", async () => {
  const { registration } = await loadPlugin({ React: createReact().React });
  assert.equal(registration.id, PACKAGE_NAME, "a mismatched id leaves the row unregistered and fails the page boot");
  assert.equal(typeof registration.factory, "function");
  assert.equal(registration.chunk, undefined, "this bundle has no package-local chunks");
});

test("the module exports apply and the exact service set it needs", async () => {
  const { React } = createReact();
  const { moduleExports } = await loadPlugin({ React });
  assert.equal(typeof moduleExports.apply, "function");
  // `slots` is the only service guaranteed wherever shell.overlay exists. A
  // name the profile does not provide would leave the fiber pending, and the
  // web boot fails the entire page for any entry that did not activate.
  // Spread first: the array is built in the VM realm and has that realm's
  // Array prototype, which a strict deep comparison rejects.
  assert.deepEqual([...moduleExports.inject], ["slots"]);
  assert.equal(moduleExports.default, undefined, "a default export would win over apply in the loader");
});

test("apply mounts into shell.overlay with a plugin-owned id and a tagged stylesheet", async () => {
  const { slotName, entry, styles } = await mount();
  assert.equal(slotName, "shell.overlay");
  assert.equal(entry.registration.name, "shell.overlay");
  assert.equal(entry.registration.id, SLOT_ID);
  assert.equal(entry.registration.label, "Budget watcher");
  assert.equal(typeof entry.registration.order, "number");
  assert.equal(styles.length, 1, "one stylesheet");
  assert.equal(styles[0].dataset.plugin, PACKAGE_NAME, "the loader only reclaims styles it can attribute");
  assert.match(styles[0].textContent, /--dsw-alias-bg-layer-2/, "the panel uses the theme tokens, not literal colors");
});

test("the settings form scrolls, and Save is pinned so it stays reachable", async () => {
  const { styles } = await mount({ withSidebar: true });
  const css = styles[0].textContent;

  // The pane gives the tab a bounded height and does not scroll it, so the form
  // has to own its scrolling. Without this the content below the fold — Save
  // among it — is simply unreachable.
  const formRule = css.slice(css.indexOf(".dshbw-form{"), css.indexOf(".dshbw-form{") + 400);
  assert.match(formRule, /overflow-y:auto/, "the form is a scroll container");
  assert.match(formRule, /min-height:0/, "a flex child must be allowed to shrink, or it overflows instead of scrolling");
  assert.match(css, /\.dshbw-actions-row\{[^}]*position:sticky/, "Save sticks to the bottom of the scroll container");
  assert.match(css, /\.dshbw-actions-row\{[^}]*background:/, "and carries its own background, or rows scroll through it");
  // The turn list grows with the conversation, so it is capped separately.
  assert.match(css, /\.dshbw-turns\{[^}]*max-height:\d+px/, "the turn list is bounded");
  assert.match(css, /\.dshbw-turns\{[^}]*overflow-y:auto/, "and scrolls itself");
});

test("the recent-turns list is wrapped in its own scrolling container", async () => {
  const harness = await mount({
    withSidebar: true,
    respond: (url) =>
      url.includes("/config")
        ? Response.json({ ok: true, settings: SETTINGS })
        : Response.json({ ...HOST_STATE, settings: SETTINGS, cost: COST }),
  });
  const body = tabBody(harness);
  render(body, harness.store);
  await settle();
  const tree = render(body, harness.store).tree;
  assert.equal(findByClass(tree, "dshbw-turns") !== undefined, true, "the rows sit in the bounded container");
  // Save is still rendered alongside it, not crowded out.
  assert.ok(findButtons(tree).some((button) => textOf(button) === "Save"), "Save survives a populated turn list");
});

test("the panel draws the whole balance as its headline, with no second line", async () => {
  const { component, store } = await mount();
  render(component, store);
  await settle();
  const { tree } = render(component, store);
  const text = textOf(tree);
  assert.match(text, /\u00a5110\.00 CNY/, "the headline is total_balance, not the topped-up part");
  assert.doesNotMatch(text, /topped up/, "the caption is gone; the header already names the figure");
  assert.doesNotMatch(text, /granted/, "the split is not a panel row");
  assert.match(text, /just now/);
});

test("the panel says so when the balance cannot be used", async () => {
  const state = { ...HOST_STATE, isAvailable: false, featured: { ...HOST_STATE.featured, toppedUp: "0.00" }, wallets: [] };
  const { component, store } = await mount({ state });
  render(component, store);
  await settle();
  const { tree } = render(component, store);
  assert.match(textOf(tree), /Not available for API calls/);
});

test("a host-reported failure is rendered as an error, and a stale one keeps the number", async () => {
  const state = {
    ...HOST_STATE,
    ok: false,
    stale: true,
    error: { code: "unauthorized", message: "DeepSeek rejected the API key." },
  };
  const { component, store } = await mount({ state });
  render(component, store);
  await settle();
  const { tree } = render(component, store);
  const text = textOf(tree);
  assert.match(text, /DeepSeek rejected the API key\./);
  assert.match(text, /Last check failed:/, "a stale number must not look current");
  assert.match(text, /\u00a5110\.00 CNY/, "the last known balance survives the failure");
});

test("an unreachable host is reported without losing the widget", async () => {
  const { component, store } = await mount({
    respond: () => new Response("nope", { status: 500 }),
  });
  render(component, store);
  await settle();
  const { tree } = render(component, store);
  assert.match(textOf(tree), /Cannot reach dsh: HTTP 500/);
});

// --- cost estimates -------------------------------------------------------

/**
 * A turn 30 seconds in, having spent $0.0305. `serverNow` is fixed so the
 * elapsed calculation is deterministic: the host's clock offset cancels the
 * page's real clock, leaving exactly 30 000 ms.
 */
const TURN_START = Date.parse("2026-10-02T12:00:00Z");
const COST = {
  available: true,
  sessionId: "session-root",
  currency: "CNY",
  pricingReadOn: "2026-10-03",
  burnWindowMs: 15_000,
  liveBurnPerHour: 8.4,
  liveAmountPerHour: 60.48,
  averageBurnPerHour: 3.66,
  averageAmountPerHour: 26.352,
  warn: false,
  warnPerHour: 2,
  terminateAbovePerHour: 0,
  overTerminate: false,
  graphEnabled: true,
  serverNow: TURN_START + 30_000,
  thisTurn: {
    turn: 3,
    ended: false,
    startedAt: TURN_START,
    endedAt: null,
    durationMs: 30_000,
    cost: 0.0305,
    amount: 0.2196,
    burnPerHour: 3.66,
    amountPerHour: 26.352,
    uncachedInputTokens: 1000,
    cacheReadTokens: 0,
    outputTokens: 0,
    messages: 2,
    attempts: 0,
    models: ["deepseek-flash"],
    series: [
      { atMs: 5_000, amountPerHour: 12 },
      { atMs: 15_000, amountPerHour: 48 },
    ],
  },
  turns: [
    { turn: 1, endedAt: TURN_START - 60_000, durationMs: 120_000, cost: 0.05, amount: 0.36, burnPerHour: 1.5, amountPerHour: 10.8, messages: 3 },
    { turn: 2, endedAt: TURN_START - 10_000, durationMs: 60_000, cost: 0.5, amount: 3.6, burnPerHour: 30, amountPerHour: 216, messages: 9 },
  ],
  session: { cost: 2.1, amount: 15.12, turns: 4, sessions: 41, descendants: 40, unpricedTurns: 0 },
  recent: { windowMs: 15_000, cost: 2.1, amount: 15.12, costPerHour: 8.4, amountPerHour: 60.48, messages: 12 },
};

test("the panel shows this turn, a live burn and the turn's average burn", async () => {
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: COST } });
  render(component, store);
  await settle();
  const text = textOf(render(component, store).tree);
  assert.match(text, /this turn/, "renamed: the figure is the turn the user is waiting on");
  assert.doesNotMatch(text, /last turn/);
  // The turn's own cost and the conversation total share one row: what this cost
  // against what it all costs is one thought, not two.
  assert.match(text, /\u2248\u00a50\.22 \/ \u00a515\.12 \u00b7 4 turns \u00b7 40 agents/, "turn and session share a row");
  assert.doesNotMatch(text, /session /, "the separate session row is gone");
  assert.match(text, /40 agents/, "the fan-out is still visible");

  // The two rates are separate figures at different resolutions: the window rate
  // is the sudden-loss detector, the turn average is what a task is worth.
  assert.match(text, /live burn \u2248\u00a560\.48\/h/, "the live rate is the windowed one");
  assert.match(text, /average burn \u2248\u00a526\.35\/h/, "the average is the turn's own cost over its time");
  assert.match(text, /0:30/, "the elapsed clock is shown beside the average");
  assert.match(text, /15s/, "the live window is named, because a short window is the point");
});

test("a running turn is marked live; a finished one is not", async () => {  const running = await mount({ state: { ...HOST_STATE, cost: COST } });
  render(running.component, running.store);
  await settle();
  assert.equal(textOf(render(running.component, running.store).tree).includes("\u25cf"), true, "the live dot shows while the turn runs");

  const frozen = {
    ...COST,
    liveBurnPerHour: 0,
    liveAmountPerHour: 0,
    averageBurnPerHour: 17.568,
    averageAmountPerHour: 17.568,
    thisTurn: { ...COST.thisTurn, ended: true, endedAt: TURN_START + 45_000, durationMs: 45_000, amountPerHour: 17.568 },
  };
  const done = await mount({ state: { ...HOST_STATE, cost: frozen } });
  render(done.component, done.store);
  await settle();
  const text = textOf(render(done.component, done.store).tree);
  assert.equal(text.includes("\u25cf"), false, "no heartbeat once the turn closes");
  // A finished turn keeps its average over the exact span it occupied.
  assert.match(text, /average burn \u2248\u00a517\.57\/h/);
  assert.match(text, /0:45/);
  // Nothing settled inside the window, so the live rate is honestly zero.
  assert.match(text, /live burn \u2248\u00a50\.00\/h/);
});

test("the chart draws the turn's burn against its own elapsed time", async () => {
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: COST } });
  render(component, store);
  await settle();
  const tree = render(component, store).tree;

  const chart = findByClass(tree, "dshbw-chart");
  assert.ok(chart, "the chart is drawn");
  assert.equal(chart.type, "svg");
  // The viewBox ratio matches the stylesheet's, so the drawing and its box agree
  // and nothing is letterboxed.
  assert.equal(chart.props.viewBox, "0 0 240 100");
  assert.match(chart.props["aria-label"], /Live burn for this turn in CNY per hour/);
  // The peak is labelled, not just drawn. It is the live head (¥60.48) rather
  // than the last host sample (¥48), because the line always ends at now.
  assert.match(chart.props["aria-label"], /Peak \u00a560/);

  // The line itself, and the x-axis running from 0:00 to the live elapsed time.
  const line = findByClass(tree, "dshbw-chart-live");
  assert.ok(line, "the burn line is drawn");
  const text = textOf(tree);
  assert.match(text, /0:00/);
  assert.match(text, /0:30/, "the axis ends at the turn's elapsed time");
});

test("the chart carries a warn line, and a stop line only once one is set", async () => {
  const armed = {
    ...COST,
    terminateAbovePerHour: 50,
    thisTurn: { ...COST.thisTurn, series: [{ atMs: 5_000, amountPerHour: 12 }] },
  };
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: armed } });
  render(component, store);
  await settle();
  const tree = render(component, store).tree;

  assert.ok(findByClass(tree, "dshbw-chart-warn"), "the warning threshold is drawn");
  assert.ok(findByClass(tree, "dshbw-chart-term"), "the stop threshold is drawn when it is armed");
  assert.match(textOf(tree), /warn \u00a52/);
  assert.match(textOf(tree), /stop \u00a550/);
});

test("no stop line is drawn while terminating is off, which is the default", async () => {
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: COST } });
  render(component, store);
  await settle();
  const tree = render(component, store).tree;

  assert.ok(findByClass(tree, "dshbw-chart-warn"), "warn is always drawn while it is set");
  assert.equal(findByClass(tree, "dshbw-chart-term"), undefined, "0 disables termination, so no red line");
});

test("the threshold labels carry a fill of their own, so they are not black on dark", async () => {
  const armed = { ...COST, terminateAbovePerHour: 50 };
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: armed } });
  render(component, store);
  await settle();
  const tree = render(component, store).tree;
  assert.ok(findByClass(tree, "dshbw-chart-key--warn"), "the warn label has a colour of its own");
  assert.ok(findByClass(tree, "dshbw-chart-key--term"), "and so does the stop label");
});

test("the chart spans the panel and cannot widen it", async () => {
  const { styles } = await mount({ withSidebar: true });
  const css = styles[0].textContent;
  const start = css.indexOf(".dshbw-chart{");
  const rule = css.slice(start, start + 200);
  assert.match(rule, /width:100%/, "full content width, so it lines up with the text rows");
  assert.match(rule, /aspect-ratio:240\/100/, "and the ratio matches the viewBox");
  assert.doesNotMatch(rule, /margin:3px auto/, "left aligned, not floating in the middle");

  // `<svg>` is a replaced element with a 300x150 intrinsic size, and a percentage
  // width counts as `auto` during shrink-to-fit sizing — so without containment the
  // chart's default width became the panel's and pinned it at the 300px cap.
  assert.match(css, /\.dshbw-chart-wrap\{[^}]*contain:inline-size/, "the wrapper must not pass its contents' width up");
  // An SVG text with no fill defaults to black, which is what made the threshold
  // caption unreadable on the dark theme.
  assert.match(css, /\.dshbw-chart-key--warn\{fill:/);
  assert.match(css, /\.dshbw-chart-key--term\{fill:/);
});

test("the burn line starts at the axis origin even if the first step settles later", async () => {
  const late = { ...COST, thisTurn: { ...COST.thisTurn, series: [{ atMs: 20_000, amountPerHour: 40 }] } };
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: late } });
  render(component, store);
  await settle();
  const chart = findByClass(render(component, store).tree, "dshbw-chart");
  const line = findByClass(chart, "dshbw-chart-live");

  // Points are "x,y" pairs, and the first must sit on the axis at zero rather than
  // 20 s along it — otherwise the left of the plot reads as missing data.
  const first = line.props.points.split(" ")[0].split(",");
  assert.equal(Number(first[0]), 24, "the plot's left edge, where the gridlines begin");
  assert.equal(Number(first[1]), 89, "and on the zero line: nothing had been spent yet");
});

test("every gridline on an axis is written to the same precision", async () => {
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: COST } });
  render(component, store);
  await settle();
  const chart = findByClass(render(component, store).tree, "dshbw-chart");
  const axis = textsIn(chart).filter((label) => /^\u00a5/.test(label));

  assert.equal(axis.length > 1, true, `expected several axis labels, got ${JSON.stringify(textsIn(chart))}`);
  // Peak is ¥60.48, so the axis steps by 20 and every line is a whole yuan —
  // not "¥10" above "¥5.00", which reads as three kinds of number.
  assert.equal(axis.every((label) => /^\u00a5\d+$/.test(label)), true, `mixed precision: ${JSON.stringify(axis)}`);
});

test("with no turn the session total keeps a row of its own", async () => {
  const noTurn = { ...COST, thisTurn: null };
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: noTurn } });
  render(component, store);
  await settle();
  const text = textOf(render(component, store).tree);
  assert.match(text, /session/, "nothing to pair it with, so it stands alone");
  assert.match(text, /\u00a515\.12 \u00b7 4 turns \u00b7 40 agents/);
  assert.doesNotMatch(text, /this turn/);
});

test("the chart is left out entirely when the setting is off", async () => {
  const off = { ...COST, graphEnabled: false };
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: off } });
  render(component, store);
  await settle();
  const tree = render(component, store).tree;
  assert.equal(findByClass(tree, "dshbw-chart"), undefined);
  assert.match(textOf(tree), /this turn/, "the figures are still there without the chart");
});

test("the chart is absent when there is no turn to draw", async () => {
  const noTurn = { ...COST, thisTurn: null };
  const { component, store } = await mount({ state: { ...HOST_STATE, cost: noTurn } });
  render(component, store);
  await settle();
  assert.equal(findByClass(render(component, store).tree, "dshbw-chart"), undefined);
});

test("the panel polls every few seconds when idle, so a new prompt is noticed", async () => {
  // The bug this locks out: the client used the host's balance-cache window as its
  // poll interval, so with the default 60 s a prompt sent just after a poll went
  // unnoticed for up to a minute and the panel looked frozen until someone pressed
  // refresh. The two are different things and must not be wired together.
  const idle = await mount({ state: { ...HOST_STATE, cost: { ...COST, thisTurn: null } } });
  render(idle.component, idle.store);
  await settle();
  // A second render is what re-runs the polling effect against the fetched payload.
  render(idle.component, idle.store);
  assert.equal(
    idle.intervalDelays.includes(3000),
    true,
    `idle polling must be seconds, not the 60 s balance window (saw ${JSON.stringify(idle.intervalDelays)})`,
  );
  assert.equal(idle.intervalDelays.includes(60000), false, "and must never adopt the cache window");

  // A high configured cache window must not slow the poll down either.
  const slowCache = await mount({
    state: { ...HOST_STATE, refreshIntervalMs: 600_000, cost: { ...COST, thisTurn: null } },
  });
  render(slowCache.component, slowCache.store);
  await settle();
  render(slowCache.component, slowCache.store);
  assert.equal(slowCache.intervalDelays.includes(3000), true, "a 10-minute cache does not mean a 10-minute poll");
  assert.equal(slowCache.intervalDelays.includes(600_000), false);
});

test("the poll tightens while a turn is running", async () => {
  const running = await mount({ state: { ...HOST_STATE, cost: COST } });
  render(running.component, running.store);
  await settle();
  render(running.component, running.store);
  assert.equal(
    running.intervalDelays.includes(2000),
    true,
    `a running turn polls fastest (saw ${JSON.stringify(running.intervalDelays)})`,
  );
});

test("a burning session is called out, and the pill keeps the warning when collapsed", async () => {
  const warnCost = { ...COST, warn: true };
  const expanded = await mount({ state: { ...HOST_STATE, cost: warnCost } });
  render(expanded.component, expanded.store);
  await settle();
  const tree = render(expanded.component, expanded.store).tree;
  const burn = JSON.stringify(tree).includes("dshbw-burn--warn");
  assert.equal(burn, true, "the burn row is tinted when the projection crosses the threshold");

  const collapsed = await mount({
    state: { ...HOST_STATE, cost: warnCost },
    storage: { [`${PACKAGE_NAME}:collapsed`]: "1" },
  });
  render(collapsed.component, collapsed.store);
  await settle();
  const pill = render(collapsed.component, collapsed.store).tree;
  assert.equal(pill.props.className.includes("dshbw-pill"), true);
  assert.equal(JSON.stringify(pill).includes("dshbw-dot--warn"), true, "the dot survives collapsing");
});

test("a model with no published rate is reported instead of costed at zero", async () => {
  const cost = { ...COST, session: { ...COST.session, usd: 0, amount: 0, unpricedTurns: 2 } };
  const { component, store } = await mount({ state: { ...HOST_STATE, cost } });
  render(component, store);
  await settle();
  assert.match(textOf(render(component, store).tree), /2 turn\(s\) unpriced/);
});

test("the unpriced row says why, from the pricing provenance", async () => {
  const base = { ...COST, session: { ...COST.session, usd: 0, amount: 0, unpricedTurns: 2 } };

  // No rate card at all: a network problem, not a naming problem.
  const noList = { ...base, pricing: { thirdPartyModels: 0, thirdPartyFetchedAt: null, usdToCny: null, usdToCnySource: null, usdToCnyDate: null } };
  const list = await mount({ state: { ...HOST_STATE, cost: noList } });
  render(list.component, list.store);
  await settle();
  assert.match(textOf(render(list.component, list.store).tree), /2 turn\(s\) unpriced \u00b7 rate list unavailable/);

  // A card, but no rate to convert USD prices into the CNY total.
  const noRate = { ...base, pricing: { thirdPartyModels: 459, thirdPartyFetchedAt: "2026-10-05T10:00:00.000Z", usdToCny: null, usdToCnySource: null, usdToCnyDate: null } };
  const rate = await mount({ state: { ...HOST_STATE, cost: noRate } });
  render(rate.component, rate.store);
  await settle();
  assert.match(textOf(render(rate.component, rate.store).tree), /2 turn\(s\) unpriced \u00b7 no USD\u2192CNY rate/);

  // A card and a rate, so the model itself is what the list does not name.
  const unknown = { ...base, pricing: { thirdPartyModels: 459, thirdPartyFetchedAt: "2026-10-05T10:00:00.000Z", usdToCny: 7.18, usdToCnySource: "ecb", usdToCnyDate: "2026-10-02" } };
  const named = await mount({ state: { ...HOST_STATE, cost: unknown } });
  render(named.component, named.store);
  await settle();
  assert.match(textOf(render(named.component, named.store).tree), /2 turn\(s\) unpriced \u00b7 model not in the rate list/);

  // The tooltip carries the provenance the row condenses.
  const row = JSON.stringify(render(named.component, named.store).tree);
  assert.match(row, /459 third-party models/);
  assert.match(row, /7\.18 \(ecb 2026-10-02\)/);
});

test("a profile with no cost data renders exactly as before", async () => {
  const { component, store } = await mount();
  render(component, store);
  await settle();
  const text = textOf(render(component, store).tree);
  assert.doesNotMatch(text, /last turn/);
  assert.doesNotMatch(text, /burn /);
  assert.match(text, /\u00a5110\.00 CNY/);
});

// --- dragging -------------------------------------------------------------

test("the expanded panel is draggable from anywhere, not just its header", async () => {
  const { component, store } = await mount();
  render(component, store);
  await settle();
  const { tree } = render(component, store);

  assert.equal(tree.props.className.includes("dshbw-panel"), true);
  for (const handler of ["onPointerDown", "onPointerMove", "onPointerUp", "onPointerCancel"]) {
    assert.equal(typeof tree.props[handler], "function", `the panel root carries ${handler}`);
  }

  const header = tree.props.children.find((child) => child?.props?.className === "dshbw-head");
  assert.ok(header, "the header still renders");
  assert.equal(header.props.onPointerDown, undefined, "the header no longer owns the drag");
  assert.equal(typeof header.props.onDoubleClick, "function", "double-click still collapses");
});

test("a pointer press on a control does not start a drag", async () => {
  const { component, store } = await mount();
  render(component, store);
  await settle();
  const { tree } = render(component, store);

  // The harness renders to plain objects, so the component's ref is never
  // committed by a real renderer. Install a stand-in element, which is what the
  // drag maths reads: a rectangle and the two offsets used for clamping.
  tree.props.ref.current = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    offsetWidth: 200,
    offsetHeight: 100,
  };

  const fakeButton = { closest: (selector) => (selector === "button" ? {} : null) };
  let captured = false;
  tree.props.onPointerDown({
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    target: fakeButton,
    currentTarget: { setPointerCapture: () => { captured = true; } },
  });
  assert.equal(captured, false, "clicking collapse or refresh must not become a drag");

  const fakeText = { closest: () => null };
  tree.props.onPointerDown({
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    target: fakeText,
    currentTarget: { setPointerCapture: () => { captured = true; } },
  });
  assert.equal(captured, true, "a press anywhere else does start one");
});

test("the collapsed pill is not draggable", async () => {
  const { component, store } = await mount({ storage: { [`${PACKAGE_NAME}:collapsed`]: "1" } });
  render(component, store);
  await settle();
  const pill = render(component, store).tree;
  assert.equal(pill.props.className.includes("dshbw-pill"), true);
  assert.equal(pill.props.onPointerDown, undefined, "the pill stays put");
  assert.equal(pill.props.onPointerMove, undefined);
});

// --- naming the session ---------------------------------------------------

/** The shipped selector shape: the session the Conversation retains. */
function sessionsKit(byId) {
  return { useSessions: (selector) => selector({ byId }) };
}

test("the panel names the retained session so the host prices the right conversation", async () => {
  const { component, store, fetchCalls } = await mount();
  const props = sessionsKit({
    "session-other": { id: "session-other", retainedBy: {} },
    "session-shown": { id: "session-shown", retainedBy: { mainView: 1, sidebarView: 0 } },
  });
  render(component, store, props);
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url,
    "http://127.0.0.1:19387/dsh-budget-watcher/balance?session=session-shown",
    "the url carries the on-screen session, not the first row",
  );
});

test("a session nobody retains sends no session hint at all", async () => {
  const { component, store, fetchCalls } = await mount();
  const props = sessionsKit({ "session-idle": { id: "session-idle", retainedBy: { sidebarView: 2 } } });
  render(component, store, props);
  await settle();
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:19387/dsh-budget-watcher/balance");
});

test("an entry without the session kit still polls, just without a hint", async () => {
  const { component, store, fetchCalls } = await mount();
  // A profile whose root kit lacks useSessions must not break the panel.
  render(component, store, {});
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.doesNotMatch(fetchCalls[0].url, /session=/);
  assert.match(textOf(render(component, store, {}).tree), /\u00a5110\.00 CNY/);
});

test("an empty byId map is handled without throwing", async () => {
  const { component, store, fetchCalls } = await mount();
  render(component, store, sessionsKit({}));
  await settle();
  assert.doesNotMatch(fetchCalls[0].url, /session=/);
});

test("the first poll asks the host for the route the host registered", async () => {
  const { component, store, fetchCalls } = await mount();
  render(component, store);
  await settle();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "http://127.0.0.1:19387/dsh-budget-watcher/balance");
});

test("a collapsed panel renders as a pill and remembers the choice", async () => {
  const { component, store, storage } = await mount({ storage: { [`${PACKAGE_NAME}:collapsed`]: "1" } });
  render(component, store);
  await settle();
  const { tree, cleanups } = render(component, store);
  const text = textOf(tree);
  assert.match(text, /\u00a5110\.00 CNY/);
  assert.doesNotMatch(text, /granted/, "the pill is the amount and nothing else");
  assert.equal(tree.type, "div");
  assert.equal(tree.props.className.includes("dshbw-pill"), true);
  for (const cleanup of cleanups) cleanup();
  // Storage is written by the toggle, not by rendering, so a fresh reader still
  // sees the value it started with.
  assert.equal(storage.get(`${PACKAGE_NAME}:collapsed`), "1");
});

test("polling stops when the component unmounts", async () => {
  const { component, store } = await mount();
  render(component, store);
  await settle();
  const { cleanups } = render(component, store);
  assert.ok(cleanups.length > 0, "the interval effect must return a cleanup");
  for (const cleanup of cleanups) cleanup();
});

// --- settings tab ---------------------------------------------------------

const SETTINGS = {
  editable: true,
  apiKeySet: true,
  effective: {
    provider: "deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    endpoint: "",
    refreshIntervalMs: 60_000,
    requestTimeoutMs: 10_000,
    currency: "auto",
    allowNonLoopback: false,
    costEnabled: true,
    burnWindowMs: 30_000,
    burnWarnPerHour: 2,
    terminateAbovePerHour: 0,
  },
};

/** Every string an SVG <text> would render, in tree order. */
function textsIn(node, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) textsIn(child, found);
    return found;
  }
  if (node.type === "text") found.push(textOf(node));
  textsIn(node.props?.children, found);
  return found;
}

/** Depth-first search for an element carrying a given class. */
function findByClass(node, className) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByClass(child, className);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const own = node.props?.className;
  if (typeof own === "string" && own.split(/\s+/).includes(className)) return node;
  return findByClass(node.props?.children, className);
}

/** Depth-first search for an element carrying a given aria-label. */
function findByLabel(node, label) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByLabel(child, label);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node.props?.["aria-label"] === label) return node;
  return findByLabel(node.props?.children, label);
}

/** Every button in the tree, for finding Save by its text. */
function findButtons(node, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, found);
    return found;
  }
  if (node.type === "button") found.push(node);
  findButtons(node.props?.children, found);
  return found;
}

/** The `value` of every text/number/password input, in tree order. */
function inputsOf(node, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) inputsOf(child, found);
    return found;
  }
  const type = node.props?.type;
  if (node.type === "input" && type !== "checkbox") found.push(node.props.value);
  inputsOf(node.props?.children, found);
  return found;
}

/** The registered settings-tab body component. */
function tabBody(harness) {
  return harness.entries.find((candidate) => candidate.registration.name === "sidebar.right.pane.tab").component;
}

test("without a right sidebar the panel offers no settings button and registers no tab", async () => {
  const harness = await mount();
  render(harness.component, harness.store);
  await settle();
  const tree = render(harness.component, harness.store).tree;
  assert.equal(findByLabel(tree, "Open budget watcher settings"), undefined, "no control that could not do anything");
  assert.equal(harness.tabEntries.length, 0);
});

test("with a right sidebar the gear opens a tab registered under a kind the host can address", async () => {
  const harness = await mount({ withSidebar: true });
  assert.equal(harness.tabEntries.length, 1, "one tab registered");
  assert.equal(harness.tabEntries[0].definition.kind, "budget-watcher-settings");
  assert.equal(harness.tabEntries[0].definition.id, "dsh-budget-watcher/settings");
  assert.equal(typeof harness.tabEntries[0].definition.title, "function", "the title is a thunk, so it follows the locale");

  // The body and title are keyed slots dispatched by the tab id.
  const names = harness.entries
    .filter((entry) => entry.registration.key !== undefined)
    .map((entry) => entry.registration.name)
    .sort();
  assert.deepEqual(names, ["sidebar.right.pane.tab", "sidebar.right.pane.tab.title"]);

  const props = sessionsKit({ "session-shown": { id: "session-shown", retainedBy: { mainView: 1 } } });
  render(harness.component, harness.store, props);
  await settle();
  const gear = findByLabel(render(harness.component, harness.store, props).tree, "Open budget watcher settings");
  assert.ok(gear, "the gear is offered once a tab exists");
  gear.props.onClick();
  assert.deepEqual(
    harness.openedTab(),
    { sessionId: "session-shown", kind: "budget-watcher-settings" },
    "the tab opens in the conversation on screen",
  );
});

test("the settings tab renders the running configuration as editable fields", async () => {
  const harness = await mount({
    withSidebar: true,
    respond: (url) =>
      url.includes("/config")
        ? Response.json({ ok: true, settings: SETTINGS })
        : Response.json({ ...HOST_STATE, settings: SETTINGS, cost: COST }),
  });
  const body = tabBody(harness);
  render(body, harness.store);
  await settle();
  const text = textOf(render(body, harness.store).tree);

  assert.match(text, /API key reference/);
  assert.match(text, /Estimate what turns cost/);
  assert.match(text, /Live burn window \(seconds\)/);
  // The thresholds are labelled in the currency the balance is held in, which
  // comes from the cost payload rather than being assumed.
  assert.match(text, /Warn above \(CNY\/hour\)/);
  assert.match(text, /Terminate above \(CNY\/hour, 0 = off\)/);
  assert.match(text, /Balance cache \(seconds\)/);
  // The old label said "refresh interval", which invited the reading that it paces
  // the panel. It paces the host's upstream call, and the panel polls on its own.
  assert.doesNotMatch(text, /Refresh interval \(seconds\)/);
  assert.match(text, /Save/);
  // The currency is a closed set, because DeepSeek only publishes rates in two.
  // The exchange rate is back, as one field with two modes: `auto` fetches a
  // central-bank rate, a number uses that instead and stops asking anyone. It
  // stopped being "not needed" the moment third-party models arrived, because
  // only DeepSeek publishes CNY prices.
  assert.match(text, /USD \u2192 CNY rate \(auto, or a number\)/, "the rate is offered, and says both modes");

  // Durations are shown in the units a person thinks in, and the values live in
  // the inputs rather than in the text.
  const values = inputsOf(render(body, harness.store).tree);
  assert.equal(values[0], "DEEPSEEK_API_KEY", "the credential reference is prefilled");
  assert.ok(values.includes("60"), `the 60000 ms refresh reads as 60 seconds (got ${values.join(", ")})`);
  assert.ok(values.includes("30"), "the 30000 ms live window reads as 30 seconds");
  assert.ok(values.includes("10"), "the 10000 ms timeout reads as 10 seconds");
  assert.ok(values.includes("2"), "the warning threshold is prefilled");
  assert.ok(values.includes("0"), "termination is prefilled as off");
});

test("saving posts a patch to the host and reports what came back", async () => {
  const harness = await mount({
    withSidebar: true,
    respond: (url) =>
      url.includes("/config")
        ? Response.json({ ok: true, settings: SETTINGS, note: "Saved to the profile patch." })
        : Response.json({ ...HOST_STATE, settings: SETTINGS, cost: COST }),
  });
  const body = tabBody(harness);
  render(body, harness.store);
  await settle();
  render(body, harness.store);

  const save = findButtons(render(body, harness.store).tree).find((button) => textOf(button) === "Save");
  assert.ok(save, "a Save button is rendered");
  save.props.onClick();
  await settle();

  const post = harness.fetchCalls.find((call) => call.url.includes("/dsh-budget-watcher/config"));
  assert.ok(post, "the save reached the config route");
  assert.equal(post.init.method, "POST");
  assert.match(post.init.headers["content-type"], /application\/json/, "the fence requires a JSON body");
  const sent = JSON.parse(post.init.body);
  assert.equal(sent.patch.refreshIntervalMs, 60_000, "seconds are converted back to milliseconds");
  assert.equal(sent.patch.burnWindowMs, 30_000, "seconds are converted back for the live window");
  assert.equal(sent.patch.burnWarnPerHour, 2);
  assert.equal(sent.patch.terminateAbovePerHour, 0);
  assert.equal(sent.patch.costEnabled, true);
  assert.equal("apiKey" in sent.patch, false, "an untouched password field is not posted, so it cannot clear the key");

  assert.match(textOf(render(body, harness.store).tree), /Saved to the profile patch\./);
});

test("a profile whose row cannot be edited says so and disables Save", async () => {
  const readOnly = { editable: false, reason: "no-config-editor", apiKeySet: false, effective: SETTINGS.effective };
  const harness = await mount({ withSidebar: true, respond: () => Response.json({ ...HOST_STATE, settings: readOnly }) });
  const body = tabBody(harness);
  render(body, harness.store);
  await settle();
  const tree = render(body, harness.store).tree;
  assert.match(textOf(tree), /Read-only: no-config-editor/);
  const save = findButtons(tree).find((button) => textOf(button) === "Save");
  assert.equal(save.props.disabled, true, "a write that would fail is not offered");
});

test("disposing the plugin withdraws the tab and the gear", async () => {
  const harness = await mount({ withSidebar: true });
  assert.equal(harness.serviceDisposers.length, 1);
  harness.serviceDisposers[0]();
  render(harness.component, harness.store);
  await settle();
  const tree = render(harness.component, harness.store).tree;
  assert.equal(findByLabel(tree, "Open budget watcher settings"), undefined, "the gear goes away with the tab");
});

test("the settings tab ranks recent turns by burn, so tasks can be compared", async () => {
  const harness = await mount({
    withSidebar: true,
    respond: (url) =>
      url.includes("/config")
        ? Response.json({ ok: true, settings: SETTINGS })
        : Response.json({ ...HOST_STATE, settings: SETTINGS, cost: COST }),
  });
  const body = tabBody(harness);
  render(body, harness.store);
  await settle();
  const text = textOf(render(body, harness.store).tree);

  assert.match(text, /Recent turns \(hottest first\)/);
  // Turn 2 burned ¥216/h over 1:00; turn 1 burned ¥10.80/h over 2:00.
  const hot = text.indexOf("216.00");
  const cool = text.indexOf("10.80");
  assert.equal(hot >= 0 && cool >= 0 && hot < cool, true, `hottest turn should come first, got: ${text}`);
  assert.match(text, /2:00/, "each turn carries its duration");
  assert.match(text, /1:00/);
});
