# Changelog

All notable changes to this project are documented in this file, together with the
[README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry records what changed, why, and — where a change narrows or widens what the plugin can do — which
section of the README's [Known limitations](README.md#known-limitations) it moves.

## [Unreleased]

### Fixed

- **A model is no longer unpriced because of how its name is spelled.** The OpenRouter list writes
  versions with dots (`claude-sonnet-4.6`), while sessions record hyphens (`claude-sonnet-4-6`),
  dated snapshot suffixes (`claude-sonnet-4-5-20250929`), differently spelled vendor prefixes
  (`zai/glm-5.3-flash` against `z-ai/glm-5.3-flash`), and occasionally underscores. All of these
  fell through the exact match and landed in `N turn(s) unpriced` — measured against the live list,
  flagship Anthropic turns priced at zero cost while the panel claimed coverage. Both sides of the
  lookup now fold onto one canonical spelling (dots and underscores to hyphens, a trailing
  `-YYYYMMDD` date dropped), so `gpt-5-20250101` and `vendor2/claude-sonnet-5-5` reach the models
  they name. A name still resolves only to a model the list actually carries — dropping the date
  cannot conjure a row that was never listed — and the `:batch` twin keeps its colon, so a batch
  price never serves an interactive turn.
- **The first panel you see is priced.** The rate card and the model list were fetched on the first
  poll but deliberately not awaited, so a fresh fiber reported third-party turns as unpriced for a
  poll or two before correcting itself — and a panel that was never expanded left them unpriced
  until the fifteen-minute tick. The fiber's very first poll now waits for both fetches, once; every
  later poll stays fire-and-forget, and the backoff inside each cache keeps a dead endpoint from
  costing more than that single wait.

### Changed

- **The `N turn(s) unpriced` row says why.** The payload's `cost.pricing` provenance existed since
  0.7.0 but the panel never rendered it, so "no change" was indistinguishable from "broken". The row
  now distinguishes the three cases a user can act on: `rate list unavailable` (the fetch failed —
  network, not naming), `no USD→CNY rate` (a CNY account waiting on the exchange rate; pin one with
  `usdToCny` to skip the wait), and `model not in the rate list` (the model is genuinely absent from
  the list under every spelling it answers to). The full provenance — model count, fetch time, rate
  and its source — moved into the row's tooltip.

## [0.7.0] — 2026-10-03

Pricing for models that are not DeepSeek's.

### Added

- **Models that are not DeepSeek's can now be priced.** `lib/pricing.js` reads OpenRouter's public model
  list — free, no key, and its `prompt` / `completion` / `input_cache_read` / `input_cache_write` buckets map
  exactly onto the cache miss / cache hit / output the plugin already prices. OpenRouter covers every provider
  worth naming here: GLM (20 models), Kimi (9), Qwen (54), MiMo (5), plus OpenAI, Anthropic and Google.
- **`lib/fx.js`, and a `usdToCny` setting that defaults to `"auto"`.** DeepSeek publishes its prices in both
  CNY and USD; nobody else publishes CNY at all, so a CNY account needs a rate to see a third-party cost in its
  own total. `auto` fetches the European Central Bank's daily reference file — 1.5 KB, no key, no auth — and a
  number in that field means use it and make no network request, which is the older behaviour and still the
  right answer behind a proxy or when you want the rate you were actually billed at.
- Pricing provenance in the payload: the rate in force and where it came from, and the age of the third-party
  model list. A cost figure is only as trustworthy as its rate card, and "the rate is unknown" is a state worth
  showing rather than hiding.
- **Both fetches also run on a fifteen-minute timer**, with the interval cleared when the plugin unloads and
  `unref`'d so it cannot hold DSH open. A timer rather than only the request path, because a collapsed panel
  stops polling — a request-driven refresh would let the rate go stale for as long as the pill stayed collapsed —
  and because the first poll after a TTL expires would otherwise answer from the old rate. The tick is shorter
  than either TTL, so it is a no-op almost always; the caches decide, not the timer.

### Changed

- **`pricedMessages` now carries `provider`**, so a turn that spanned two providers is distinguishable from a
  model with no published price.
- **The ledger refolds when the prices change.** Folds are cached per session, so a fold done against
  yesterday's rate would otherwise keep being served because the log itself had not moved. The cache key now
  includes a pricing key derived from the rate and the model list.

### Fixed

- **`usdToCny: 7.2` in the profile stopped the plugin activating entirely.** The schema said `Schema.string()`, a
  YAML number is not a string, and cordis therefore refused the fiber — so the route was never registered and the
  panel reported that it could not reach dsh. The blast radius is what makes this worth recording: a config
  validation failure does not degrade one feature, it removes the plugin, and the symptom points at the network
  rather than at the config. The field is now `Schema.any()` and `parseFxSetting` is the real gate — `auto` or a
  positive number, anything else falls back to `auto` — because a loose type is the right trade when the failure
  mode is "the plugin disappears". Three tests, one of which asserts the declaration in the source: the schema
  cannot be exercised from the test suite, since schemastery is a peer dependency the plugin does not install.
- **A failed price fetch no longer retries on every poll.** The panel polls every few seconds and a failure
  caches nothing, so a dead endpoint would have been hammered indefinitely; attempts now back off. Joining an
  in-flight attempt is checked *before* the backoff, or concurrent callers would mistake the attempt they were
  waiting on for a recent failure and give up instead of joining it.
- **Float noise in the per-token to per-million conversion.** `0.0000002 * 1e6` is `0.19999999999999998`, which
  would have surfaced in the panel as `≈¥14.000000000001`.

### Notes on what this deliberately does not do

- **DeepSeek is never priced from the fetched list.** OpenRouter lists `deepseek/deepseek-v4.1-flash` at
  $0.003/M input where DeepSeek's own published off-peak rate is $0.15/M — 50× apart. The provider whose invoice
  the user pays wins, and a test asserts the book is not even consulted for a model DeepSeek publishes.
- **Chinese providers are not scraped.** GLM's pricing page is a JavaScript shell with 127 characters of visible
  text, and Kimi's numbers are not in its static HTML either. The fetched list covers those models in USD, and
  the rate converts them — a native-CNY snapshot would be a hand-copied table that goes stale silently.

### Documentation

- **The main screenshot is renamed `docs/screenshotnew.png`.** GitHub kept serving the previous image from its cache
  under the old `docs/screenshot.png` URL, so the repo page still showed a superseded panel after the file was
  replaced. A new filename is the only reliable cache-bust for a committed image; `docs/screenshot.png` is deleted
  and both READMEs point at the new name. The Files table says why the name is odd, so nobody "tidies" it back.
- **`README.zh-CN.md` rewritten in a human voice.** The first pass read as translated rather than written —
  compressed four-character compounds and literal English calques ("天生抖动", "取短窗口"). It now reads as
  Chinese prose: 烧 is still the term for burn, introduced once as 成本燃烧率, but the explanations run as
  sentences instead of stacked noun phrases. Same content and all 55 limitations; only the register changed.

### Documentation

- **The main screenshot is renamed `docs/screenshotnew.png`.** GitHub kept serving the previous image from its
  cache under the old `docs/screenshot.png` URL, so the repo page still showed a superseded panel after the file
  was replaced. A new filename is the only reliable cache-bust for a committed image; `docs/screenshot.png` is
  deleted and both READMEs point at the new name. The Files table says why the name is odd, so nobody "tidies"
  it back.
- **`README.zh-CN.md` rewritten in a human voice.** The first pass read as translated rather than written —
  compressed four-character compounds and literal English calques ("天生抖动", "取短窗口"). It now reads as
  Chinese prose: 烧 is still the term for burn, introduced once as 成本燃烧率, but the explanations run as
  sentences instead of stacked noun phrases. Same content and all 55 limitations; only the register changed.

## [0.6.3] — 2026-10-03

The panel looked frozen until you pressed refresh.

### Fixed

- **The client was polling on the host's balance-cache window.** `refreshIntervalMs` (60 s by default) says how
  long the *host* reuses one balance answer before calling DeepSeek again; the client had adopted it as its own
  poll interval. So a prompt sent just after a poll went unnoticed for up to a minute, and because the first
  tightened poll only happened after that, the figures appeared to need a manual refresh — even though the host
  was folding the ledger correctly the whole time and would have answered instantly. The two intervals are now
  separate: **the panel polls its own local route every 2 s while a turn runs and every 3 s when idle**, and
  `refreshIntervalMs` paces only the upstream API call. The host route is cheap to poll because the ledger
  reuses folds it has already done and the balance comes from the cache.
- **The setting is relabelled `Balance cache (seconds)`** in the settings tab. Its old label, "Refresh
  interval", is what invited the conflation in the first place.
- A troubleshooting row for the symptom, and limitation 6 rewritten to state both intervals and keep them
  distinct.

### Added

- **`README.zh-CN.md`, a Simplified Chinese README.** It introduces the burn concept in Chinese — 「烧」 for burn,
  defined on first use as **成本燃烧率** (cost burn rate, i.e. money per unit time) — and then uses 烧 throughout
  for `live burn`, `average burn` and burn rate. Linked both ways from the two files, and added to `files` so it
  ships with the package. The English README remains authoritative where the two differ.
- The client test harness now records `setInterval` delays instead of discarding them, which is what makes the
  cadence testable. Three assertions: idle polling is seconds and never the 60 s window, a 10-minute cache does
  not mean a 10-minute poll, and a running turn polls fastest.

### Documentation

Carried in from the previous round, which was never committed — it lands with this version.

- **Both screenshots in `docs/` are replaced with captures of `0.6.2`**: the expanded panel and, new, the
  collapsed pill. The stale-capture warning is gone, and the pill is now shown in the README rather than only
  described.
- **"What it shows" is rewritten from the screenshot's own numbers** — `¥51.33 CNY`, `this turn ≈¥0.12 /
  ¥13.93 · 22 turns`, `live burn ≈¥0.00/h`, `average burn ≈¥6.40/h · 1:09`, `1 turn(s) unpriced` — so every
  example in the table is a real reading rather than an invented one.
- **Two claims in the introduction were false and are corrected.** It said the balance shown is
  `topped_up_balance` "the money you actually paid in", and that the granted/topped-up split lives behind the
  gear button. Neither is true: the headline is `total_balance`, and the split is not rendered anywhere. The
  same wrong claim in a `lib/client.cjs` comment is fixed too.
- **"Verified against" records the third screenshot round**, which confirmed the `0.6.2` fixes, and narrows what
  remains unseen to the settings tab's scrolling and pinned Save (`0.5.1`) and the red stop line.

## [0.6.2] — 2026-10-03

The panel was wide because the chart was setting its width, not the text.

### Fixed

- **The chart was pinning the panel at its 300px cap.** `<svg>` is a replaced element with a default intrinsic
  size of 300×150, and a percentage width counts as `auto` while a shrink-to-fit container works out its width —
  so `width:50%` did not shrink the chart's contribution, the SVG's 300 px default became the panel's width, and
  the panel sat at its maximum. The chart now sits in a wrapper with `contain:inline-size`, which makes its
  width independent of its contents, so **the longest text row decides the panel's width again**. Measured from
  the screenshot against the CSS: the content box was 276 px and the chart 138 px, exactly 50% of it.
- **The burn line did not start at the axis.** It began wherever the first step settled — around `0:20` in the
  screenshot — which made the left of the plot look like missing data. The series is now anchored to a zero
  point at `t=0`, which is also the honest reading: nothing had been spent yet.

### Changed

- **The chart spans the panel's full content width and is left aligned**, so it lines up exactly with the
  `this turn` row rather than floating in the middle at half width. The ratio is now 240:100 (was 4:3 at half
  width), chosen so the height stays what it was and one unit stays near one CSS pixel — the 9-unit axis labels
  do not shrink with the box.

### Added

- Two tests: the chart's rule is full width with the containment that stops it widening the panel, and the
  polyline's first point sits on the axis origin at zero.

### Verified, and how

- Found by **measuring a second screenshot against the CSS**, not by a test — the same way the previous round's
  three defects were found. The arithmetic is recorded above so the reasoning is checkable rather than asserted.

## [0.6.1] — 2026-10-03

The chart, fixed against a screenshot of it actually running.

### Fixed

- **The threshold caption was black on the dark theme.** An SVG `<text>` with no `fill` defaults to black, and
  `dshbw-chart-key` set only a font size — so `warn ¥15 ▲` was very nearly invisible. Each caption now takes the
  colour of the line it annotates, which is both readable and the obvious pairing to look at.
- **The axis mixed three kinds of number.** `compactAmount` chose its own precision per value, producing `¥10`
  above `¥5.00` above `¥0.00`. The precision now comes from the gridline step, so one axis reads `¥0 / ¥20 /
  ¥40`, and threshold captions use the precision the value itself needs (`¥2`, not `¥2.00`).
- **The axis was coarser than intended.** Aiming at three intervals made a ¥60.48 peak step by 50, giving
  `¥0 / ¥50 / ¥100`; aiming at four gives `¥0 / ¥20 / ¥40 / ¥60 / ¥80`.

### Changed

- **The chart is a sparkline-sized card: half the panel's content width, centred, at 4:3** (was full width at
  2:1). It was taking more of the panel than the figures it illustrates. The SVG's viewBox moved to 120×90 to
  match, so one unit stays near one CSS pixel and the 9-unit labels do not shrink with the box.
- **`this turn` and `session` are now one row:** `this turn ≈¥0.78 / ¥13.05 · 19 turns`. What this turn cost
  against what the conversation has cost is one thought; splitting it over two rows spent a line on nothing. The
  session total keeps a row of its own only when there is no turn to pair it with.

### Added

- Four tests: the caption fills exist, the chart rule is 50% at 4:3, every gridline on an axis shares one
  precision, and the standalone session row still appears with no turn.

### Verified, and how

- Found by a **screenshot of the running panel**, not by a test. Full-width chart, invisible caption and
  mixed-precision axis were all live defects that 124 passing tests did not and could not catch. The README's
  "Verified against" section now records the screenshot as evidence, and says plainly which fixes have still
  not been seen running.

## [0.6.0] — 2026-10-03

The burn chart, drawn in the panel.

### Added

- **A live-burn chart in the panel**, below the figures and above the refresh row: this
  turn's burn rate against its own elapsed time, as an inline SVG with no dependencies.
  `graphEnabled`, on by default, turns it off without touching any figure.
- **The x-axis is the turn, not a window.** It grows one second at a time while the turn
  runs and stops when the turn does, so the chart shows one task start-to-finish instead
  of a sliding window that forgets what it saw. A frozen chart is a finished turn's
  history.
- **The y-axis only ever grows**, and only when a new high-water mark is set, so a
  falling rate never rescales the frame down under the line. Gridlines land on 1, 2 or 5
  times a power of ten, and the peak is named in the SVG's accessible description.
- **Blue is the rate, amber is `burnWarnPerHour`, red is `terminateAbovePerHour`** — the
  red line drawn only when that is above `0`, since a stop line at "off" would claim
  something that cannot happen.
- **The burn series is computed host-side** (`thisTurn.series`): the trailing-window rate
  evaluated at each settled step, thinned to at most 240 samples. Computing it once in
  Node rather than twice, in two languages, is what keeps the drawn line and the
  `live burn` row the same number.

### Decisions worth recording

- **Sampled at billing events, not on a clock.** Between two settled steps nothing has
  been spent, so the rate is an average of an unchanged total and there is no new fact to
  draw. The panel extends the line from the last sample to now, once a second, using the
  same figure the row shows.
- **A series that steps down is correct.** It is a 15-second window, so a quiet stretch
  longer than that drops the line back towards zero. That is the measurement being
  honest, and hiding it would misrepresent the rate.
- **A threshold above the data range is pinned to the top edge, dashed and marked `▲`**
  rather than omitted. Dropping the line the user set would be worse than showing it out
  of scale; the label still carries the real number.
- **The chart is called, not mounted** (`BurnChart({…})` rather than
  `React.createElement(BurnChart, …)`). It holds no hooks, and inlining it keeps the chart
  in the same element tree the panel returns — which is the difference between the tests
  being able to see it and not.

### Known limitations at this version

The README list gains 48–53: the chart needs a turn and is not persisted of its own; the
line steps down as well as up; the y-axis latches to the high-water mark, so later detail
can look flat behind an early spike; a pinned threshold cannot be read off; the series is
thinned past 240 samples; and gridlines are round numbers rather than exact fractions of
the peak.

## [0.5.2] — 2026-10-03

The `currency` setting was ignored.

### Fixed

- **Choosing `CNY` or `USD` now actually changes the currency of the cost figures and
  both thresholds.** It previously expressed only a *wallet preference*, while the
  cost currency followed the featured wallet — so on an account holding only CNY,
  setting USD did nothing and the COST ESTIMATE section kept reading `CNY/hour`. A
  currency choice is a display decision, not a claim about which wallets exist.
- `auto` still follows the featured wallet. The settings tab now says so in a line
  under the thresholds when the cost currency differs from the balance's, since the
  two sections then show different currency symbols.
- Two tests: one asserts that an explicit currency prices from that currency's rate
  card (`$0.15`, not `¥1.00`), the other keeps `auto` pinned to the featured wallet.

### Documentation

- README: the `currency` row now says it sets the currency of the figures *and* the
  thresholds; limitation 18 reworded to "whichever you select, or `auto`"; unknowns
  **46–47** record that the balance row cannot follow the setting, and that every cost
  figure moves together so the comparison table stays comparable.

## [0.5.1] — 2026-10-03

The settings tab could not be scrolled, which made Save unreachable.

### Fixed

- **The settings form had no scroll container, so everything below the fold was
  unreachable — including Save, once the recent-turns list was populated.** The
  sidebar pane gives a tab a bounded height and does not scroll it, so the tab has to
  scroll itself. `.dshbw-form` is now a scroll container (`height`/`max-height` with
  `min-height: 0` — the load-bearing part, because a flex child refuses to shrink
  below its content by default and overflows instead of scrolling). Save is pinned to
  the bottom of that container with `position: sticky` and its own background, so it
  stays reachable however long the form grows.
- **The recent-turns list is capped and scrolls separately.** It grows with the
  conversation, so leaving it unbounded would have pushed Save out of reach again even
  once the form scrolled.
- Two tests lock the arrangement in: one asserts the injected CSS still declares the
  scroll container, the sticky Save and the bounded turn list; the other asserts the
  rows are wrapped in that bounded container and that Save is still rendered beside a
  populated list.

### Documentation

- The README is brought up to date for 0.5.0 as well: the element table now lists
  `live burn`, `average burn` and the red dot; "What it costs you" explains the two
  rates and the two thresholds; the configuration table drops
  `usdToCny`/`costCurrency` for `burnWarnPerHour`/`terminateAbovePerHour` and the 15 s
  window; the exchange-rate limitation is rewritten as the two-published-tables rule;
  and unknowns **39–45** cover termination and the settings layout.

## [0.5.0] — 2026-10-03

Burn split into two rates, the rate card made two-currency, and a spend limit that
stops the turn.

### Changed

- **One burn row became two.** `live burn` is what the last window cost, projected
  per hour — the figure that catches a sudden loss, and the one the thresholds act
  on. `average burn` is the turn's own cost over its elapsed time, frozen at its
  end. They answer different questions, and collapsing them into one number hid
  both: a short window is jumpy but immediate, a cumulative average smooth but late.
- **The live window defaults to 15 seconds**, down from 15 minutes. Sensitivity is
  the point of a live figure. The consequence is real and documented: it reads 0
  whenever nothing has settled inside the window, which is true rather than broken.
- **Cost is no longer converted.** `usdToCny` and `costCurrency` are gone. DeepSeek
  publishes its rate card in **both** CNY and USD, so the plugin carries both tables
  and prices in whichever currency the featured balance is held in. The published
  figures are not a clean multiple of one another — flash off-peak output is $0.60
  or ¥4, an implied ~6.67, against a spot rate nearer 7.2 — so converting was both
  unnecessary and slightly wrong. Thresholds are now expressed in the balance's own
  currency, and the currency setting became a closed drop-down of the only three
  meaningful values: `auto`, `CNY`, `USD`.
- `burnWarnUsdPerHour` → `burnWarnPerHour`, since the units are no longer USD.

### Added

- **`terminateAbovePerHour`** — when the live burn crosses it, the plugin
  **interrupts the running turn**, exactly as the stop button does, and the status
  dot turns red. **Off by default (0)**: stopping a task is destructive and the rate
  is an estimate, so it has to be asked for. The stop is latched per turn number, so
  one runaway turn is interrupted once rather than once per poll, and it uses the
  same primitive the UI uses — `agent.cancel({kind: "hook", reason}, {keepInbox: true})`
  — with `hook` provenance, so the session log records *why* the turn ended.
- **Three tests for the stop path**: it fires once and only once, it is inert at 0,
  and it does nothing when no turn is actually open.
- `liveBurnPerHour`, `averageBurnPerHour`, `burnWindowMs`, `overTerminate`,
  `terminateAbovePerHour` and a top-level `terminated` record in the payload, plus a
  `normalizeCostCurrency` helper and a `COST_CURRENCIES` list.

### Decisions worth recording

- **The turn guard is advisory, and says so.** An `Agent` outlives any one turn, so a
  reference identifies the agent, not the turn; there is a real window between
  reading the burn and calling `cancel` in which the turn can end and a successor
  begin. Nothing in the API can cancel "turn N". The open-turn boundary is therefore
  sampled immediately before and after the call, which cannot prevent a wrong-turn
  abort but does convert it from a silent one into a logged `raced-next-turn`.
- **`keepInbox: true`.** Stopping a runaway must not also discard input the user has
  already typed.
- **The termination fires from the read route.** That is a side effect on a GET,
  which is not lovely, but the burn rate is only computed there; the alternative was
  a second timer recomputing the same ledger. Being off by default is what keeps the
  compromise acceptable.

### Fixed

- The currency refactor renamed the cost model's `usd` fields to `cost` throughout,
  including the ledger's accumulators, so an amount in CNY can no longer be read
  under a name claiming it is dollars.

## [0.4.0] — 2026-10-02

Burn tracking overhauled into a per-turn figure. Cost prediction was considered and abandoned.

### Changed

- **`last turn` is now `this turn`.** The figure is the turn the user is waiting on, and "last" made it read as
  something already finished — it took a clarifying question to establish what it meant, which is the label's
  fault.
- **`burn` is now the turn's own rate, not a rolling window.** It is that turn's cost divided by its elapsed
  time, recomputed once a second while the turn runs and **frozen** when it ends. A rolling window describes
  the profile's recent mood; a frozen per-turn rate is a fact about a task, which is what makes two tasks
  comparable.
- **A turn's cost and burn now include the agents it spawned.** Attribution is by time window rather than by
  turn number, because a subagent has its own private turn sequence and a fan-out bills almost entirely in the
  children. Summing only the conversation's own turns reported a calm rate while sixty agents burned — the
  exact case the number exists for.
- **The warning follows the figure on screen.** It previously tracked the rolling window alone, so an expensive
  turn stopped being flagged the moment it stopped spending.
- The panel now tightens its poll to 2 s while a turn is running, up from the configured interval.

### Added

- **A live per-second rate.** The host sends cost, the turn's start and its own clock; the panel ticks elapsed
  time locally at 1 Hz and recomputes, so the figure moves every second without a request per second. A pulsing
  dot marks a turn still in flight, so a number that is still growing is visibly still growing.
- **A turn-comparison table** in the settings tab: recent closed turns, **hottest first**, with cost, rate and
  duration. This is the "which tasks are expensive" view; the panel deliberately shows only the turn in hand.
- **`serverNow`, `startedAt`, `endedAt`, `durationMs`, `burnPerHour` and a `turns` history** in the cost
  payload.
- Tests for the live-versus-frozen distinction, the duration arithmetic, the fan-out attribution change and the
  hottest-first ordering — 108 total.

### Fixed

- **The gear button never appeared, so 0.3.0's settings tab was unreachable in a real profile.** `apply` guarded
  the tab registration with `ctx.get("sidebarRight") !== undefined`, and `ctx.get` only sees services that are
  *already* provided — the right sidebar is often provided after this plugin materializes, so the guard skipped
  the registration permanently. Found by opening the panel in a browser and noticing the button was absent; the
  test suite had passed because its fake context always reported the services. The registration is now
  unconditional and `ctx.inject` fires whenever they arrive.

### Decisions worth recording

- **Cost prediction was evaluated and dropped.** A turn's LLM cost is roughly *quadratic* in its step count,
  because each step re-sends the whole conversation: input ≈ `N·B + g·N²/2`. The unpredictable variable is
  therefore `N` — how many steps an autonomous agent decides to take and how wide it fans out — not the prompt
  size, which `ctx.tokenMeter.measure()` already prices exactly. Output tokens are not predictable at all, and
  a naive token-count predictor would badly over-estimate long turns because the cached prefix dominates the
  token count while costing little. Rate tracking answers the same question — "is this running away?" — with a
  measurement instead of a guess.
- **Cumulative average, not an instantaneous rate.** Cost arrives in lumps as steps settle; an instantaneous
  rate would spike at every step and read zero between them. Cost-so-far over time-so-far is stable and settles
  on the turn's true average.
- **History is capped at 10 turns and not persisted.** It is a panel figure for comparing the tasks in front of
  you, not an analytics store.

### Known limitations at this version

The README list gains 32–38. Highlights: the rate decays between steps (the numerator only moves when a step
settles); the live figure is computed in the browser against the host's clock; a turn's window can absorb an
earlier subagent's late calls but not work that outlives the turn; the frozen rate lingers, so an amber dot is a
record of the last task rather than a claim about now; and the comparison table is capped, root-scoped and
in-memory.

## [0.3.0] — 2026-10-02

A compact panel and an editable settings tab.

### Changed

- **The panel lost two rows.** The headline is now `total_balance` — topped-up money plus granted credit — and
  the `topped up` caption and `total … granted …` line are gone. The header already names the figure, so the
  caption was repeating it, and the total *is* the balance: leading with only the topped-up part reads as zero
  on an account living on granted credit. The granted/topped-up split moves into the settings tab, and the
  pill's label lost the same words.
- README limitation 14 rewritten: it covered a **new** install needing a restart, but not the case that
  actually bit — **editing** an already-loaded host half. Troubleshooting gained a row pointing at
  `pluginVersion` and `cost.reason`.

### Added

- **A settings tab.** A gear button on the panel opens a *Budget* tab in the right sidebar with every option as
  an editable field. Durations are shown in seconds and minutes and converted back on save. The API key field
  is write-only and tri-state — absent leaves it, empty clears it — so an untouched password box cannot delete
  the user's key. The gear is rendered only when a tab could actually be registered.
- **`POST /dsh-budget-watcher/config`**, writing through DSH's own `configEditor` service so the change lands
  in the profile's `cordis.patch.yml` and is applied by the normal loader path. A value set back to its default
  is removed rather than written, so the row returns to inheriting.
- **Request validation before the write.** An allow-list of editable keys, per-key type checks, an 8 KiB body
  cap, and a required `application/json` content type — the last is what stops a cross-site form from reaching
  the write path at all. Validation runs before the profile patch is opened, so a mistyped field is refused
  without touching the user's config file.
- **`@deepseek-ai/schemastery` as a peer dependency.** Its absence was a real defect: `Config` was silently
  `undefined`, so the plugin's schema never reached the runtime and config was never validated. Declaring the
  peer is what lets DSH resolve it from the installation. Deliberately *not* a `@deepseek-ai/dsh*` peer, whose
  ranges the compatibility gate checks and can skip the whole row over.
- **`pluginVersion` in every payload.** A host module is imported once and cached for the life of the DSH
  process, so an edited plugin keeps serving its old code until that process restarts; a version marker makes
  that visible instead of something to deduce from process start times.
- **`cost.reason` when there are no cost figures** (`disabled`, `no-live-sessions`, `failed`). An omitted key
  is indistinguishable from a bug; the payload now says which it is.

### Fixed

- **`total_balance` is no longer assumed present.** It is reconstructed from its parts, in integer hundredths so
  the sum carries no float error; a wallet reporting only its parts would otherwise render as `0.00`.
- **Config was never validated**, because the schema never loaded. See the peer-dependency note.

### Decisions worth recording

- **The settings transport is the plugin's own route, not `remote.settings`.** The generated path needs a
  schemastery `Config` with every field `.volatile()` plus a client form built on `configForms`. The route is
  smaller, is testable without a live page, and was verified writing a real profile patch. Migrating is the
  natural next step if the plugin grows more settings.
- **Ordinary config over volatile fields.** Volatile fields avoid a fiber reload, but arrive as live getter
  objects that must be dereferenced on every read. A reload on save measured as a blip and is easier to reason
  about.

### Known limitations at this version

The README list gains 26–31. Highlights: the gear needs a right sidebar and the write needs `configEditor`,
both optional; saving reloads the plugin's fiber and clears its in-memory cost ledger; a home patch or
`--patch` overlay on the same row makes it unwritable; and the settings transport is bespoke rather than the
generated one.

## [0.2.0] — 2026-10-02

Adds cost estimates, and makes the expanded panel draggable from anywhere.

The motivating case: a deep-research skill fanned 64 target sites out to subagents and burned ¥15 in twenty
minutes. The conversation showed one turn, still open, with no answer yet. Balance alone says *that* you are
spending; it cannot say *how fast*, which is the number that decides whether to stop.

### Added

- **`lib/cost.js`** — DeepSeek's published rate card, peak/off-peak selection from the call timestamp, a
  usage→USD function, and a fold from session events to per-turn token and cost totals. Pure: no DSH imports,
  no `fetch`, so it is directly testable.
- **`lib/ledger.js`** — decides which sessions count as one conversation's spend. It folds the selected session
  **and every subagent session beneath it**, because a fan-out bills in the children. A finished subagent keeps
  contributing, so the total never falls — the one direction a spend counter must not move.
- **Three figures in the panel**: `last turn` (updates while the turn is still running), `session` with an
  `N agents` suffix, and `burn` — spend over the last window projected per hour. This is the early warning: it
  moves within a minute of a fan-out starting, long before the turn finishes.
- **A burn warning**: `burnWarnUsdPerHour` tints the burn figure and turns the dot amber. The dot survives
  collapsing the panel, so a runaway is visible from the pill.
- **Session handshake**: the client names the conversation it is showing, read from the root slot kit's
  `useSessions` the same way DSH's own title bar reads it, and sends it as `?session=`. The host falls back to
  the newest live root session, so an older client still gets an answer.
- **Config**: `costEnabled`, `burnWindowMs`, `burnWarnUsdPerHour`, `usdToCny`, `costCurrency`.
- **Tests**: 90 total, up from 39 — the rate card and fold arithmetic, the ledger tree (fan-out, descendants,
  finish-must-not-subtract, sibling isolation, unpriced models), the route's cost payload, and the client's
  cost rendering, drag scoping and session handshake.

### Changed

- **The expanded panel drags from anywhere on it**, not only its title bar. A press that lands on a control is
  left alone, so collapse and refresh still work. The collapsed pill deliberately installs no drag handling at
  all: a pill you can nudge by accident is a pill you cannot click.
- `docs/screenshot.png` recaptured against the new panel.

### Fixed

- **Cached input was priced wrongly.** The first cut subtracted `cacheReadTokens` from `inputTokens`, which
  looks like the obvious arithmetic and is wrong: DSH's `inputTokens` is the **uncached** half and the cache
  buckets are separate. On a well-cached turn the subtraction collapsed the uncached half to zero and
  under-reported exactly the turns worth watching. `dsh-llm-deepseek` states the identity outright —
  `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` — and there is now a test
  that fails if a large cached prefix is allowed to cancel a smaller uncached remainder. The turn and session
  fields were renamed `uncachedInputTokens` so the distinction cannot be lost again.
- **Retried attempts were free.** A failed attempt settles as `assistant/attempt`, which carries no `usage`
  field at all; its numbers survive only in the last `usage` chunk of its stream. Reading just `usage` dropped
  the cost of every retry. Both event kinds are now folded, using the same two-tier read DSH's own token meter
  performs.

### Decisions worth recording

- **No tokens are spent to produce an estimate.** The feature was asked for as "using a small amount of tokens
  to take a crude estimate"; the usage DeepSeek already reports on every assistant message is exact, already
  logged, and free. Paying a model to guess at a number that is already on disk would be strictly worse —
  costlier, slower, and less accurate.
- **The recent burn rate, not the last turn, is the warning.** A fanned-out turn does not finish, so a "cost of
  the last completed turn" would stay silent through the entire runaway. Cost is accumulated per assistant
  message with its own timestamp, and the warning comes from a short window projected per hour.
- **Descendants are counted, and a finished one keeps counting.** Counting only the session on screen reports
  the calm, not the fire; letting a finished subagent drop out would make the total fall as work completes.
- **An unpriced model is reported, never estimated.** A silent zero reads as "that turn was free".
- **The DSH deprecation is accepted knowingly.** `ownEvents()` / `snapshotEvents()` are the only whole-log
  reads a plugin has, and DSH's own README prohibits new production calls to them. Every call is wrapped, so if
  a future release removes them the cost section disappears and the balance keeps working.

### Known limitations at this version

The full list lives in the [README](README.md#known-limitations); the cost feature adds limitations 16–25.
Highlights: the rate card is a dated snapshot rather than a feed; Chinese public holidays are not modelled, so
a holiday weekday is priced at the peak rate (an overestimate); the USD→CNY rate is configured, not fetched;
and only spend observed while the plugin is loaded is counted, so a fan-out that finished before it loaded is
missing from the session total.

## [0.1.0] — 2026-10-02

First release. A floating window over the conversation showing the topped-up balance left on the DeepSeek API
account, collapsed to a pill on demand and draggable anywhere in the frame.

### Added

- **Host half** (`index.js`): resolves the API key at every refresh through `ctx.credentials` (falling back to
  `apiKey` in config, then the launch environment), calls `GET https://api.deepseek.com/user/balance`, and
  serves a normalized snapshot from `GET /dsh-budget-watcher/balance`.
- **Client half** (`lib/client.cjs`): registers into the frame-wide `shell.overlay` slot and draws the balance
  with `React.createElement` against the `--dsw-*` theme tokens. Hand-written in the loader's classic-script
  lazy-CJS format — no bundler, no JSX, no runtime dependencies.
- **Caching with single flight**: one upstream answer is reused for `refreshIntervalMs`, and concurrent requests
  share one in-flight call, so several open windows cost one request.
- **Stale-but-visible failures**: a failed refresh keeps the last known number on screen and labels it, instead
  of blanking the panel. An unreadable body is reported as a protocol error, never rendered as `0.00`.
- **Same-origin fence** on the plugin's route: loopback `Host`, `Origin` matching `Host`, and
  `sec-fetch-site: cross-site` refused. `allowNonLoopback` opts out of the loopback requirement only.
- **Pure, testable core** (`lib/balance.js`): payload normalization, currency selection and HTTP-failure
  messaging, free of DSH and `fetch` imports.
- **Config**: `provider`, `apiKey`, `apiKeyEnv`, `endpoint`, `refreshIntervalMs`, `requestTimeoutMs`,
  `currency`, `allowNonLoopback`.
- **Tests** (`node --test`, 39 tests): the normalizer's accepted and rejected shapes, the route against a
  stubbed API (caching, `?refresh=1`, every failure mode, the fence), and the client bundle loaded in a VM with
  a stubbed module loader (registration id, exported service set, slot mounting, rendering per host state,
  unmount cleanup).
- **Docs**: `README.md` with install, configuration, the key-resolution order, how it works, troubleshooting
  and a known-limitations list; `docs/screenshot.png` captured from a real browser.

### Decisions worth recording

- **`topped_up_balance` is the headline, not `total_balance`.** The feature was asked for as "the topped-up
  balance left". `total_balance` includes promotional credit that expires, so leading with it would overstate
  what the user paid for. The split appears underneath when the two differ.
- **The public API, not DSH's account service.** DSH already exposes `ctx.deepseekAccount.getBalance()`, but it
  authenticates with a signed-in Platform OAuth grant and returns a different figure with no `is_available`.
  Reading it would have made the widget disagree with the API key the profile actually bills against. This is
  recorded as limitation 2.
- **A plugin-owned route rather than a Typert `@Remote` service.** The Remote path needs a build-time generator
  that is not shipped in a DSH installation; hand-authoring its reflection artifacts is a large amount of
  scaffolding for one read-only number. The web-server route is the pattern a shipped third-party plugin in
  this build already uses.
- **No schemastery import at module scope.** A static import of a package that a given installation does not
  carry would stop the whole profile from loading. The import is dynamic and its absence only costs config
  validation. Recorded as limitation 8.
- **No `@deepseek-ai/dsh*` peer dependencies.** The compatibility gate only inspects those names, so declaring
  none means it can never refuse the plugin. Recorded as limitation 13.
- **The client half uses `setInterval` inside a component effect, not `ctx.timer`.** The component's own
  lifetime is the right scope: collapsing to a pill must stop the poll even though the plugin's fiber lives on.
- **`inject = ["slots"]` and nothing else.** On the web boot path a declared service the profile does not
  provide leaves the fiber pending and fails the *entire page*, so the hard dependency set is kept to the one
  service that is always present wherever `shell.overlay` exists.

### Known limitations at this version

The full list lives in the [README](README.md#known-limitations). Highlights: DeepSeek is the only provider; the
API-key balance is not the signed-in Platform account balance; the route is loopback-only unless
`allowNonLoopback` is set; polling rather than push, with a 15 s floor; and a new install requires a profile
restart.

[Unreleased]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NeutronStar714/dsh-budget-watcher/releases/tag/v0.1.0
