// dsh-budget-watcher — client half.
//
// A classic script that registers a lazy-CJS factory with the web shell's module
// loader. The loader serves this file as `<package>/client.js` and appends it as
// a `<script>`; running it only registers the factory below, and the factory body
// executes at materialization. There is no bundler and no JSX: `require` accepts
// the shell's static module table (React among it), and elements are built with
// `React.createElement`.
//
// The widget mounts into `shell.overlay` — the frame-wide floating layer above
// every column and outside their scroll containers, which is exactly "a small
// window hovering over the conversation page". That layer is click-through and
// gives each direct child `pointer-events: auto`, so the panel is interactive
// without blocking the app underneath.

window.__ModuleLoader__.load({
  id: "dsh-budget-watcher",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    /** Route the host half registers, resolved against the app's own base URL. */
    var STATE_PATH = "dsh-budget-watcher/balance";

    /** Where the panel remembers that the user moved or collapsed it. */
    var POSITION_KEY = "dsh-budget-watcher:position";
    var COLLAPSED_KEY = "dsh-budget-watcher:collapsed";

    var CURRENCY_SYMBOLS = { CNY: "\u00a5", USD: "$", EUR: "\u20ac", JPY: "\u00a5", GBP: "\u00a3" };

    var CSS = [
      ".dshbw-panel{position:fixed;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;",
      "min-width:172px;max-width:min(300px,calc(100vw - 24px));padding:10px 12px;",
      "color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);",
      "border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);",
      "box-shadow:var(--dsw-elevation-panel);font-family:var(--dsw-font-family);font-size:12px;line-height:1.4;",
      "user-select:none;-webkit-user-select:none;cursor:grab}",
      ".dshbw-panel--dragging{cursor:grabbing}",
      ".dshbw-head{display:flex;align-items:center;gap:6px}",
      ".dshbw-title{flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.02em;",
      "text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshbw-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}",
      ".dshbw-dot--ok{background:var(--dsw-alias-state-success-primary)}",
      ".dshbw-dot--warn{background:var(--dsw-alias-state-warn-primary)}",
      ".dshbw-dot--bad{background:var(--dsw-alias-state-error-primary)}",
      ".dshbw-amount{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".dshbw-amount--muted{color:var(--dsw-alias-label-tertiary);font-size:15px;font-weight:500}",
      ".dshbw-caption{color:var(--dsw-alias-label-tertiary);font-size:11px}",
      ".dshbw-sep{height:.5px;margin:3px 0 1px;background:var(--dsw-alias-border-l1)}",
      ".dshbw-cost{display:flex;flex-direction:column;gap:2px;font-size:11px;font-variant-numeric:tabular-nums}",
      ".dshbw-cost-row{display:flex;gap:6px;align-items:baseline;color:var(--dsw-alias-label-tertiary)}",
      ".dshbw-cost-key{flex:0 0 auto}",
      ".dshbw-cost-value{color:var(--dsw-alias-label-primary);font-weight:500}",
      ".dshbw-burn{color:var(--dsw-alias-label-tertiary)}",
      ".dshbw-burn--warn{color:var(--dsw-alias-state-warn-primary);font-weight:600}",
      // A quiet heartbeat while a turn is running, so a figure that is still
      // growing is visibly still growing.
      ".dshbw-live{color:var(--dsw-alias-state-success-primary);font-size:8px;line-height:1;margin-left:auto;",
      "animation:dshbw-pulse 1.6s ease-in-out infinite}",
      "@keyframes dshbw-pulse{0%,100%{opacity:1}50%{opacity:.2}}",
      ".dshbw-turn-row{display:flex;gap:8px;align-items:baseline;font-size:11px;",
      "font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}",
      // The turn list is capped and scrolls on its own. It grows with the
      // conversation, so an uncapped list would push Save out of reach again
      // even once the form itself scrolls.
      ".dshbw-turns{display:flex;flex-direction:column;gap:4px;max-height:190px;overflow-y:auto;overscroll-behavior:contain}",
      ".dshbw-turn-row .dshbw-cost-value{flex:0 0 auto}",
      ".dshbw-turn-when{flex:1 1 auto;text-align:right}",
      // The wrapper exists to stop the SVG sizing the panel.
      //
      // `<svg>` is a replaced element with a default intrinsic size of 300x150, and
      // a percentage width is treated as `auto` while a shrink-to-fit container
      // works out its width — so the chart's 300px default became the panel's
      // width and pinned it at its 300px cap. `contain:inline-size` makes the
      // wrapper's width independent of its contents, which is what lets the text
      // rows decide the panel's width again.
      ".dshbw-chart-wrap{width:100%;contain:inline-size}",
      // Full width of the content box — and therefore exactly as wide as the
      // `this turn` row, the widest thing in the panel. Left aligned: a chart
      // floating in the middle of its own panel reads as an accident. The ratio
      // keeps the height it had when it was only half as wide.
      ".dshbw-chart{display:block;width:100%;aspect-ratio:240/100;height:auto;margin:3px 0 1px;",
      "font-variant-numeric:tabular-nums;overflow:visible}",
      ".dshbw-chart-grid{stroke:var(--dsw-alias-border-l1);stroke-width:.5}",
      ".dshbw-chart-axis{fill:var(--dsw-alias-label-tertiary);font-size:9px}",
      ".dshbw-chart-line{fill:none;stroke-width:1.2;stroke-linejoin:round;stroke-linecap:round}",
      ".dshbw-chart-live{stroke:var(--dsw-alias-state-business-primary)}",
      ".dshbw-chart-warn{stroke:var(--dsw-alias-state-warn-primary);stroke-width:1;stroke-dasharray:3 2}",
      ".dshbw-chart-term{stroke:var(--dsw-alias-state-error-primary);stroke-width:1;stroke-dasharray:3 2}",
      // An SVG <text> with no fill defaults to black, which is invisible on the
      // dark theme. These take the colour of the line they annotate, so the
      // pairing is obvious in either theme.
      ".dshbw-chart-key{font-size:9px;font-weight:600}",
      ".dshbw-chart-key--warn{fill:var(--dsw-alias-state-warn-primary)}",
      ".dshbw-chart-key--term{fill:var(--dsw-alias-state-error-primary)}",
      ".dshbw-warn{color:var(--dsw-alias-state-warn-primary);font-size:11px}",
      ".dshbw-error{color:var(--dsw-alias-state-error-primary);font-size:11px;word-break:break-word}",
      ".dshbw-actions{display:flex;align-items:center;gap:6px;margin-top:1px}",
      ".dshbw-spacer{flex:1 1 auto}",
      ".dshbw-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);",
      "font:inherit;font-size:11px;padding:2px 6px;border-radius:var(--dsw-radius-sm);cursor:pointer}",
      ".dshbw-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dshbw-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      ".dshbw-btn[disabled]{opacity:.5;cursor:default}",
      // Settings tab.
      //
      // The form owns its own scrolling, and has to: the pane gives it a bounded
      // height and does not scroll for it, so without this the content simply
      // overflows and everything below the fold — including Save — is
      // unreachable. `min-height:0` is load-bearing, because a flex child
      // refuses to shrink below its content by default and would overflow the
      // pane instead of scrolling.
      ".dshbw-form{display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--dsw-alias-label-primary);",
      "box-sizing:border-box;height:100%;max-height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;",
      "padding-bottom:6px}",
      ".dshbw-group{display:flex;flex-direction:column;gap:8px;padding-top:9px;border-top:.5px solid var(--dsw-alias-border-l1)}",
      ".dshbw-group-title{color:var(--dsw-alias-label-tertiary);font-size:10px;letter-spacing:.04em;text-transform:uppercase}",
      ".dshbw-field{display:flex;flex-direction:column;gap:3px}",
      ".dshbw-label{color:var(--dsw-alias-label-secondary);font-size:11px}",
      ".dshbw-input{box-sizing:border-box;width:100%;padding:4px 8px;color:var(--dsw-alias-label-primary);",
      "background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);",
      "border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px}",
      ".dshbw-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
      ".dshbw-check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      // Save is pinned to the bottom of the scroll container so it stays
      // reachable however long the form grows — the point of the bug it fixes.
      // It needs its own background, or the rows scrolling underneath would show
      // through it.
      ".dshbw-actions-row{position:sticky;bottom:0;z-index:1;display:flex;align-items:center;gap:8px;",
      "padding:8px 0 4px;background:var(--dshbw-pane-bg,var(--dsw-alias-bg-layer-1));",
      "box-shadow:0 -6px 8px -6px rgb(0 0 0 / 28%)}",
      ".dshbw-save{appearance:none;border:0;padding:5px 12px;border-radius:var(--dsw-radius-sm);",
      "background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);",
      "font:inherit;font-size:12px;cursor:pointer}",
      ".dshbw-save[disabled]{opacity:.5;cursor:default}",
      ".dshbw-note{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".dshbw-note--ok{color:var(--dsw-alias-state-success-primary)}",
      ".dshbw-note--bad{color:var(--dsw-alias-state-error-primary)}",
      ".dshbw-pill{position:fixed;z-index:30;display:flex;align-items:center;gap:6px;box-sizing:border-box;",
      "padding:5px 10px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);",
      "border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;box-shadow:var(--dsw-elevation-panel);",
      "font-family:var(--dsw-font-family);font-size:12px;font-variant-numeric:tabular-nums;",
      "user-select:none;-webkit-user-select:none}",
      ".dshbw-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshbw-pill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
    ].join("");

    /** One `<style>` tag owned by this plugin id, so the loader removes it on unload. */
    function installStyles() {
      var tagId = "dsh-budget-watcher/panel.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-budget-watcher";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * The headline figure is `total` — topped-up money plus granted credit —
     * because that is the whole balance. Showing only the topped-up part would
     * read as zero on an account living on granted credit, and the panel has no
     * room for a second line to explain that.
     */
    function formatAmount(wallet) {
      if (wallet === null || wallet === undefined) return "\u2014";
      var symbol = CURRENCY_SYMBOLS[wallet.currency] ?? "";
      return symbol + wallet.total + " " + wallet.currency;
    }

    /**
     * A cost estimate. Always prefixed with "≈": these are published rates
     * applied to recorded token counts, converted at the user's own exchange
     * rate, and presenting that as an exact figure would overstate it.
     */
    function formatCost(amount, currency) {
      if (typeof amount !== "number" || !isFinite(amount)) return "\u2014";
      var symbol = CURRENCY_SYMBOLS[currency] ?? "";
      var suffix = CURRENCY_SYMBOLS[currency] === undefined ? " " + currency : "";
      if (amount > 0 && amount < 0.005) return "\u2248" + symbol + "<0.01" + suffix;
      return "\u2248" + symbol + amount.toFixed(2) + suffix;
    }

    /** "just now" / "3 min ago" — enough to judge whether a number is current. */
    function relativeTime(at) {
      if (typeof at !== "number") return "never";
      var seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 45) return "just now";
      var minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + " min ago";
      var hours = Math.round(minutes / 60);
      if (hours < 24) return hours + " h ago";
      return Math.round(hours / 24) + " d ago";
    }

    /** Elapsed time as m:ss, or h:mm:ss past an hour. */
    function formatDuration(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "0:00";
      var total = Math.floor(ms / 1000);
      var seconds = total % 60;
      var minutes = Math.floor(total / 60) % 60;
      var hours = Math.floor(total / 3600);
      var pad = function (value) { return (value < 10 ? "0" : "") + value; };
      return hours > 0 ? hours + ":" + pad(minutes) + ":" + pad(seconds) : minutes + ":" + pad(seconds);
    }

    /**
     * The turn's burn rate as of right now.
     *
     * A finished turn reports the host's frozen value: cost over the exact
     * wall-clock span the turn occupied. A running turn recomputes against the
     * live clock, so the figure moves once a second even though the numerator
     * only changes when a step settles.
     *
     * The host's clock offset comes from the payload rather than being assumed,
     * so a drifted page clock cannot make a turn look longer or shorter than it
     * was.
     */
    function liveBurn(turn, cost, tick) {
      if (turn.ended === true) {
        return { amountPerHour: turn.amountPerHour, elapsedMs: turn.durationMs };
      }
      var skew = typeof cost.serverNow === "number" ? cost.serverNow - Date.now() : 0;
      var elapsedMs = Math.max(0, Date.now() + skew - turn.startedAt);
      // `tick` is not read; it is the dependency that makes this recompute.
      void tick;
      if (elapsedMs <= 0) return { amountPerHour: 0, elapsedMs: 0 };
      return { amountPerHour: turn.amount / (elapsedMs / 3600000), elapsedMs: elapsedMs };
    }

    /**
     * A "nice" ceiling for the y-axis, plus the matching gridline step.
     *
     * Gridlines land on 1, 2 or 5 times a power of ten — the set that stays
     * legible as round numbers at any magnitude, from ¥0.05/hour to ¥50,000/hour.
     * Aiming at four intervals rather than three keeps the axis from jumping
     * straight from ¥0 to ¥50 when the data peaks at ¥60.
     */
    function niceScale(maximum) {
      if (!(maximum > 0) || !isFinite(maximum)) return { max: 1, step: 1 };
      var rough = maximum / 4;
      var magnitude = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
      var step = magnitude * 10;
      var multiples = [1, 2, 5, 10];
      for (var i = 0; i < multiples.length; i += 1) {
        if (magnitude * multiples[i] >= rough) {
          step = magnitude * multiples[i];
          break;
        }
      }
      return { max: Math.ceil(maximum / step) * step, step: step };
    }

    /** How many decimals a value needs to be written exactly. */
    function decimalsFor(value) {
      if (Math.abs(value - Math.round(value)) < 1e-9) return 0;
      if (Math.abs(value * 10 - Math.round(value * 10)) < 1e-9) return 1;
      return 2;
    }

    /**
     * A compact amount for an axis label: no "≈", and k/M past a thousand.
     *
     * `digits` is passed explicitly for gridlines so the whole axis shares one
     * precision. Left to itself, a value-driven choice produced "¥10" above
     * "¥5.00" above "¥0.00" on the same axis, which reads as three different
     * kinds of number.
     */
    function compactAmount(value, currency, digits) {
      var symbol = currency === "CNY" ? "\u00a5" : currency === "USD" ? "$" : "";
      var size = Math.abs(value);
      if (size >= 1000000) return symbol + (value / 1000000).toFixed(1) + "M";
      if (size >= 1000) return symbol + (value / 1000).toFixed(1) + "k";
      return symbol + value.toFixed(typeof digits === "number" ? digits : decimalsFor(value));
    }

    /**
     * The live-burn chart.
     *
     * The x-axis is the turn itself: it grows every second while the turn runs
     * and stops when the turn does, so the picture is one task start-to-finish
     * rather than a sliding window that forgets. The y-axis only ever grows, and
     * only when a new high-water mark is set, so the scale stays readable and
     * never rescales downwards under the line mid-turn.
     */
    function BurnChart(props) {
      var turn = props.turn;
      var cost = props.cost;
      var tick = props.tick;
      var currency = cost.currency;
      var live = liveBurn(turn, cost, tick);

      // The host's samples are the history; the head is now, drawn from the same
      // windowed figure the `live burn` row shows, so the two cannot disagree.
      var points = Array.isArray(turn.series) ? turn.series.slice() : [];
      var lastAt = points.length > 0 ? points[points.length - 1].atMs : 0;
      var elapsedMs = Math.max(live.elapsedMs, lastAt);
      if (elapsedMs > lastAt) points.push({ atMs: elapsedMs, amountPerHour: cost.liveAmountPerHour || 0 });

      // Anchor the line to the axis origin. Nothing had been spent at t=0, so the
      // rate there is honestly zero — and without this the line began wherever the
      // first step happened to settle, leaving the left of the plot looking like
      // missing data rather than a quiet start.
      if (points.length > 0 && points[0].atMs > 0) points.unshift({ atMs: 0, amountPerHour: 0 });

      var highest = 0;
      for (var i = 0; i < points.length; i += 1) highest = Math.max(highest, points[i].amountPerHour);

      // 4:3, matching the stylesheet. The box is 120 units wide whatever the
      // panel measures, so one unit is about one CSS pixel at the default size
      // and the 9-unit labels land near 9px rather than shrinking with the box.
      // 240:100, matching the stylesheet, and about one unit per CSS pixel at the
      // width the text rows give the panel — so the 9-unit labels land near 9px
      // rather than shrinking with the box.
      var W = 240;
      var H = 100;
      var padLeft = 24;
      var padRight = 4;
      var padTop = 9;
      var padBottom = 11;
      var plotW = W - padLeft - padRight;
      var plotH = H - padTop - padBottom;

      var scale = niceScale(highest);
      var yTop = scale.max;
      // One precision for the whole axis, taken from the gridline step.
      var gridDigits = scale.step >= 1 ? 0 : scale.step >= 0.1 ? 1 : 2;
      // A zero-length turn still gets a sane axis rather than a division by zero.
      var xMax = Math.max(elapsedMs, 1000);

      var toX = function (atMs) { return padLeft + (atMs / xMax) * plotW; };
      var toY = function (value) { return padTop + plotH - (Math.max(0, value) / yTop) * plotH; };

      var children = [];
      var value;
      var y;

      for (value = 0; value <= yTop + 1e-9; value += scale.step) {
        y = toY(value);
        children.push(
          React.createElement("line", {
            key: "grid-" + value,
            className: "dshbw-chart-grid",
            x1: padLeft,
            x2: W - padRight,
            y1: y,
            y2: y,
          }),
        );
        children.push(
          React.createElement(
            "text",
            { key: "gridv-" + value, className: "dshbw-chart-axis", x: padLeft - 3, y: y + 2.5, textAnchor: "end" },
            compactAmount(value, currency, gridDigits),
          ),
        );
      }

      // The thresholds. Either can sit above the data range, in which case it is
      // pinned to the top edge and marked, because silently dropping the line the
      // user set would be worse than showing it out of scale.
      var markers = [
        { key: "warn", value: cost.warnPerHour, className: "dshbw-chart-warn", label: "warn" },
        { key: "term", value: cost.terminateAbovePerHour, className: "dshbw-chart-term", label: "stop" },
      ];
      for (var m = 0; m < markers.length; m += 1) {
        var marker = markers[m];
        if (!(marker.value > 0)) continue;
        var clamped = marker.value > yTop;
        var lineY = clamped ? padTop : toY(marker.value);
        children.push(
          React.createElement("line", {
            key: "mark-" + marker.key,
            className: marker.className,
            x1: padLeft,
            x2: W - padRight,
            y1: lineY,
            y2: lineY,
          }),
        );
        children.push(
          React.createElement(
            "text",
            {
              key: "marklabel-" + marker.key,
              // The modifier carries the fill: an un-filled SVG text is black,
              // which is unreadable on the dark theme.
              className: "dshbw-chart-key dshbw-chart-key--" + marker.key,
              x: W - padRight,
              y: lineY - 1.5,
              textAnchor: "end",
            },
            marker.label + " " + compactAmount(marker.value, currency) + (clamped ? " \u25b2" : ""),
          ),
        );
      }

      if (points.length > 0) {
        children.push(
          React.createElement("polyline", {
            key: "live",
            className: "dshbw-chart-line dshbw-chart-live",
            points: points
              .map(function (point) { return toX(point.atMs).toFixed(1) + "," + toY(point.amountPerHour).toFixed(1); })
              .join(" "),
          }),
        );
      } else {
        children.push(
          React.createElement(
            "text",
            { key: "empty", className: "dshbw-chart-axis", x: padLeft + plotW / 2, y: padTop + plotH / 2, textAnchor: "middle" },
            "no spend settled yet",
          ),
        );
      }

      children.push(
        React.createElement("text", { key: "x0", className: "dshbw-chart-axis", x: padLeft, y: H - 2, textAnchor: "start" }, "0:00"),
      );
      children.push(
        React.createElement(
          "text",
          { key: "x1", className: "dshbw-chart-axis", x: W - padRight, y: H - 2, textAnchor: "end" },
          (turn.ended === true ? "" : "\u2192 ") + formatDuration(elapsedMs),
        ),
      );

      return React.createElement(
        "svg",
        {
          className: "dshbw-chart",
          viewBox: "0 0 " + W + " " + H,
          role: "img",
          "aria-label":
            "Live burn for this turn in " + currency + " per hour. Peak " +
            compactAmount(highest, currency) + " over " + formatDuration(elapsedMs) + ".",
        },
        children,
      );
    }

    function readStored(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        // Private mode and some embedded webviews refuse storage. Position and
        // collapse state are conveniences, so losing them is not an error.
        return null;
      }
    }

    function writeStored(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* see readStored */
      }
    }

    function loadPosition() {
      var raw = readStored(POSITION_KEY);
      if (raw === null) return null;
      try {
        var parsed = JSON.parse(raw);
        if (typeof parsed?.x === "number" && typeof parsed?.y === "number") return parsed;
      } catch {
        /* fall through to the default corner */
      }
      return null;
    }

    /**
     * The floating window.
     *
     * State comes from the host route, which owns the credential, the upstream
     * request and the cache. This component only decides what to draw: a poll
     * every `refreshIntervalMs`, one forced refresh on demand, and drag /
     * collapse state that survives a page reload.
     */
    function BudgetWatcher(props) {
      // A root-scoped slot entry receives the frame's standard kit as props, so
      // `useSessions` is the supported way in. The selector is the same one
      // DSH's own title bar uses: the session the Conversation retains. It
      // returns a string, not an object, so it is stable across renders and
      // needs no equality function.
      //
      // The feature test is fixed for the life of this entry, so calling the
      // hook behind it keeps a constant hook order.
      var useSessions = props !== null && props !== undefined ? props.useSessions : undefined;
      var selectedSessionId;
      if (typeof useSessions === "function") {
        selectedSessionId = useSessions(function (state) {
          var rows = state !== null && state !== undefined ? state.byId : null;
          if (rows === null || rows === undefined) return undefined;
          for (var key in rows) {
            var row = rows[key];
            if (row !== null && row !== undefined && ((row.retainedBy ?? {}).mainView ?? 0) > 0) return row.id;
          }
          return undefined;
        });
      }

      var statePair = React.useState({ status: "loading", data: null, error: null });
      var view = statePair[0];
      var setView = statePair[1];

      var refreshingPair = React.useState(false);
      var refreshing = refreshingPair[0];
      var setRefreshing = refreshingPair[1];

      var collapsedPair = React.useState(function () {
        return readStored(COLLAPSED_KEY) === "1";
      });
      var collapsed = collapsedPair[0];
      var setCollapsed = collapsedPair[1];

      var positionPair = React.useState(loadPosition);
      var position = positionPair[0];
      var setPosition = positionPair[1];

      var dragPair = React.useState(null);
      var drag = dragPair[0];
      var setDrag = dragPair[1];

      var rootRef = React.useRef(null);
      var pollRef = React.useRef(null);

      // A once-a-second counter, alive only while a turn is running. The burn
      // rate is cost-over-elapsed, and elapsed changes every second while cost
      // changes only when a step settles — so the clock has to tick locally to
      // make the figure live without turning the host route into a 1 Hz poll.
      var tickPair = React.useState(0);
      var tick = tickPair[0];
      var setTick = tickPair[1];
      var turnRunning = view.data?.cost?.thisTurn?.ended === false;
      React.useEffect(
        function () {
          if (turnRunning !== true) return undefined;
          var id = window.setInterval(function () {
            setTick(function (previous) {
              return previous + 1;
            });
          }, 1000);
          return function () {
            window.clearInterval(id);
          };
        },
        [turnRunning],
      );

      // Reads the host route. `force` asks the host to ignore its freshness
      // window, which is what the refresh button does. Naming the session lets
      // the host price the conversation actually on screen instead of guessing
      // at the busiest one.
      var load = React.useCallback(function (force) {
        var url = new URL(STATE_PATH, document.baseURI);
        if (force === true) url.searchParams.set("refresh", "1");
        if (typeof selectedSessionId === "string" && selectedSessionId !== "") {
          url.searchParams.set("session", selectedSessionId);
        }
        return fetch(url.href, { headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (data) {
            setView({ status: "ready", data: data, error: null });
          })
          .catch(function (error) {
            // A failed poll must not erase the last balance: the previous
            // number with its timestamp is still the most useful thing on
            // screen, and the host reports its own upstream failure in the
            // body when it can.
            setView(function (previous) {
              return { status: previous.data === null ? "error" : "ready", data: previous.data, error: String((error && error.message) || error) };
            });
          });
      }, [selectedSessionId]);

      // Two cadences, and neither of them is the balance cache window.
      //
      // `refreshIntervalMs` says how long the HOST reuses one balance answer
      // before calling DeepSeek again. Using it as the client's poll interval was
      // a conflation, and it made the panel look frozen: a prompt sent just after
      // a poll went unnoticed for up to a minute, so the figures only appeared
      // when someone pressed refresh. The client polls its own host route, which
      // is local and cheap — the ledger reuses folds it has already done and the
      // balance comes from the host's cache — so the only question is how fast we
      // want to notice a turn.
      var POLL_ACTIVE_MS = 2000;
      var POLL_IDLE_MS = 3000;
      var intervalMs = turnRunning === true ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      React.useEffect(
        function () {
          load(false);
          pollRef.current = window.setInterval(function () {
            load(false);
          }, intervalMs);
          return function () {
            if (pollRef.current !== null) window.clearInterval(pollRef.current);
            pollRef.current = null;
          };
        },
        [load, intervalMs],
      );

      // Drag from anywhere on the expanded panel. Pointer capture keeps the
      // panel under the cursor when the pointer leaves the element, and the
      // move is written back to storage only on release so a drag does not
      // thrash localStorage. Clicks that land on a control are left alone, so
      // the collapse and refresh buttons still work while the panel is
      // draggable everywhere. The collapsed pill deliberately installs none of
      // this: it stays put and behaves as a single button.
      var onPointerDown = React.useCallback(
        function (event) {
          if (event.button !== 0) return;
          if (event.target.closest("button") !== null) return;
          var rect = rootRef.current?.getBoundingClientRect();
          if (rect === undefined || rect === null) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ dx: event.clientX - rect.left, dy: event.clientY - rect.top });
        },
        [],
      );

      var onPointerMove = React.useCallback(
        function (event) {
          if (drag === null) return;
          var width = rootRef.current?.offsetWidth ?? 0;
          var height = rootRef.current?.offsetHeight ?? 0;
          var x = Math.min(Math.max(0, event.clientX - drag.dx), Math.max(0, window.innerWidth - width));
          var y = Math.min(Math.max(0, event.clientY - drag.dy), Math.max(0, window.innerHeight - height));
          setPosition({ x: x, y: y });
        },
        [drag],
      );

      var onPointerUp = React.useCallback(
        function (event) {
          if (drag === null) return;
          setDrag(null);
          var target = event.currentTarget;
          if (target.hasPointerCapture?.(event.pointerId) === true) target.releasePointerCapture(event.pointerId);
          setPosition(function (current) {
            if (current !== null) writeStored(POSITION_KEY, JSON.stringify(current));
            return current;
          });
        },
        [drag],
      );

      var toggleCollapsed = React.useCallback(function () {
        setCollapsed(function (previous) {
          writeStored(COLLAPSED_KEY, previous ? "0" : "1");
          return !previous;
        });
      }, []);

      var onRefresh = React.useCallback(
        function () {
          setRefreshing(true);
          load(true).then(
            function () {
              setRefreshing(false);
            },
            function () {
              setRefreshing(false);
            },
          );
        },
        [load],
      );

      var data = view.data;
      // The host keeps the last good answer and marks it stale, so a transport
      // failure and an upstream failure render differently.
      var transportError = view.error !== null && data === null;
      var hostError = data !== null && data.error !== null;
      var stale = data !== null && data.stale === true;

      var dotClass = "dshbw-dot";
      if (transportError || (hostError && data?.featured == null)) dotClass += " dshbw-dot--bad";
      // Red is reserved for one thing: the plugin stopped a turn because the
      // spend rate crossed the limit the user set.
      else if (data?.terminated?.turn !== undefined) dotClass += " dshbw-dot--bad";
      // A burning session turns the dot amber, which is the one signal that
      // survives collapsing the panel to a pill.
      else if (hostError || stale || data?.isAvailable === false || data?.cost?.warn === true) dotClass += " dshbw-dot--warn";
      else if (data !== null) dotClass += " dshbw-dot--ok";

      var amountText = hostError && data?.featured == null ? "\u2014" : formatAmount(data?.featured ?? null);

      var style = position === null ? { right: 16, bottom: 16 } : { left: position.x, top: position.y };

      if (collapsed) {
        return React.createElement(
          "div",
          {
            className: "dshbw-pill",
            style: style,
            role: "button",
            tabIndex: 0,
            title: amountText + " \u2014 click to expand",
            "aria-label": "Budget watcher: " + amountText + ". Click to expand.",
            onClick: function () {
              toggleCollapsed();
            },
            onKeyDown: function (event) {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleCollapsed();
              }
            },
          },
          React.createElement("span", { className: dotClass }),
          React.createElement("span", null, amountText),
        );
      }

      var children = [
        React.createElement(
          "div",
          {
            className: "dshbw-head",
            key: "head",
            onDoubleClick: toggleCollapsed,
            title: "Double-click to collapse",
          },
          React.createElement("span", { className: dotClass }),
          React.createElement("span", { className: "dshbw-title" }, (data?.provider?.label ?? "DeepSeek") + " balance"),
          // Offered only when a tab was actually registered, so the control
          // never appears on a profile where it could not do anything.
          openSettingsTab !== null
            ? React.createElement(
                "button",
                {
                  className: "dshbw-btn",
                  type: "button",
                  onClick: function () {
                    if (selectedSessionId === undefined) return;
                    openSettingsTab(selectedSessionId);
                  },
                  title: "Open settings",
                  "aria-label": "Open budget watcher settings",
                },
                "\u2699\ufe0e",
              )
            : null,
          React.createElement(
            "button",
            {
              className: "dshbw-btn",
              type: "button",
              onClick: toggleCollapsed,
              title: "Collapse to a pill",
              "aria-label": "Collapse budget watcher",
            },
            "\u2013",
          ),
        ),
        React.createElement(
          "div",
          { className: "dshbw-amount" + (hostError && data?.featured == null ? " dshbw-amount--muted" : ""), key: "amount" },
          amountText,
        ),
      ];

      // No caption and no second line under the amount: the header already
      // names what the figure is, and the figure is the whole balance. The
      // granted/topped-up split is deliberately not shown anywhere — one figure
      // is the honest report, and `topped_up_balance` alone would read 0.00 on an
      // account living on granted credit.

      // Cost estimates. Placed under the balance and before the error rows.
      //
      // The turn's figure is attributed across the whole agent tree inside the
      // turn's own time window, so a fan-out lands in the turn that caused it
      // rather than being invisible until the session rollup.
      var cost = data?.cost ?? null;
      if (cost !== null && cost.available === true) {
        var costRows = [];
        var turn = cost.thisTurn ?? null;

        // The conversation's running total, shown beside the turn's own cost
        // rather than on a row of its own: "this turn / session" is one thought —
        // what this cost against what it all costs — and splitting it across two
        // rows cost a line for no extra meaning.
        var sessionParts = [];
        if (cost.session.turns > 0) {
          sessionParts.push(cost.session.turns + (cost.session.turns === 1 ? " turn" : " turns"));
        }
        if (cost.session.descendants > 0) {
          sessionParts.push(cost.session.descendants + " agents");
        }
        var sessionAmount = formatCost(cost.session.amount, cost.currency).replace("\u2248", "");
        var sessionSuffix = sessionParts.length > 0 ? " \u00b7 " + sessionParts.join(" \u00b7 ") : "";

        if (turn !== null) {
          costRows.push(
            React.createElement(
              "div",
              { className: "dshbw-cost-row", key: "turn" },
              React.createElement("span", { className: "dshbw-cost-key" }, "this turn"),
              React.createElement(
                "span",
                { className: "dshbw-cost-value" },
                formatCost(turn.amount, cost.currency) + " / " + sessionAmount + sessionSuffix,
              ),
            ),
          );

          // Two rates, because they answer different questions.
          //
          // `live burn` is what the last window cost, projected to an hour: the
          // sudden-loss detector, and the figure the thresholds act on. It is
          // short and therefore jumpy — it reads 0 whenever nothing has settled
          // recently, which is honest rather than broken.
          //
          // `average burn` is the turn's own cost over its elapsed time, frozen
          // when the turn closes. Stable, and the one worth comparing tasks by.
          var live = liveBurn(turn, cost, tick);
          var windowSeconds = Math.round((cost.burnWindowMs ?? 0) / 1000);
          costRows.push(
            React.createElement(
              "div",
              { className: "dshbw-cost-row", key: "live-burn" },
              React.createElement(
                "span",
                { className: "dshbw-burn" + ((cost.warn === true || cost.overTerminate === true) ? " dshbw-burn--warn" : "") },
                "live burn " + formatCost(cost.liveAmountPerHour, cost.currency) + "/h",
              ),
              React.createElement("span", { className: "dshbw-cost-key" }, windowSeconds + "s"),
              turn.ended === true ? null : React.createElement("span", { className: "dshbw-live" }, "\u25cf"),
            ),
          );
          costRows.push(
            React.createElement(
              "div",
              { className: "dshbw-cost-row", key: "average-burn" },
              React.createElement(
                "span",
                { className: "dshbw-cost-key" },
                "average burn " + formatCost(cost.averageAmountPerHour ?? live.amountPerHour, cost.currency) + "/h",
              ),
              React.createElement("span", { className: "dshbw-cost-key" }, formatDuration(live.elapsedMs)),
            ),
          );
        }

        // With no turn yet in the conversation there is nothing to pair the total
        // with, so it keeps a row of its own rather than vanishing.
        if (turn === null && (cost.session.turns > 0 || cost.session.cost > 0)) {
          costRows.push(
            React.createElement("div", { className: "dshbw-cost-row", key: "session" },
              React.createElement("span", { className: "dshbw-cost-key" }, "session"),
              React.createElement("span", { className: "dshbw-cost-value" }, sessionAmount + sessionSuffix)),
          );
        }

        if (turn === null && cost.recent.messages > 0) {
          // No turn yet in this conversation: the rolling window is the only
          // rate there is.
          var idleWindow = Math.round((cost.burnWindowMs ?? 0) / 1000);
          costRows.push(
            React.createElement(
              "div",
              { className: "dshbw-cost-row", key: "burn-idle" },
              React.createElement(
                "span",
                { className: "dshbw-burn" + (cost.warn === true ? " dshbw-burn--warn" : "") },
                "live burn " + formatCost(cost.liveAmountPerHour, cost.currency) + "/h",
              ),
              React.createElement("span", { className: "dshbw-cost-key" }, idleWindow + "s"),
            ),
          );
        }

        // A model with no published rate is reported rather than costed at a
        // guess; silence would look like "this turn was free". The count alone
        // cannot say whether to wait or to fix something, so the provenance the
        // host already sends narrows it: a rate card that never loaded is a
        // network problem, a missing USD→CNY rate is a wait-or-pin-one problem,
        // and a loaded card that still does not price the turn means the model
        // is not on the list under any spelling it answers to.
        if (cost.session.unpricedTurns > 0) {
          var pricing = cost.pricing;
          var why = "";
          var title;
          if (pricing !== undefined && pricing !== null) {
            if (pricing.thirdPartyModels === 0) {
              why = " \u00b7 rate list unavailable";
            } else if (cost.currency === "CNY" && !pricing.usdToCny) {
              why = " \u00b7 no USD\u2192CNY rate";
            } else {
              why = " \u00b7 model not in the rate list";
            }
            title = (pricing.thirdPartyModels ?? 0) + " third-party models"
              + (pricing.thirdPartyFetchedAt ? ", fetched " + pricing.thirdPartyFetchedAt : "")
              + "; USD\u2192CNY " + (pricing.usdToCny == null ? "unknown" : pricing.usdToCny)
              + (pricing.usdToCnySource ? " (" + pricing.usdToCnySource + (pricing.usdToCnyDate ? " " + pricing.usdToCnyDate : "") + ")" : "");
          }
          costRows.push(
            React.createElement("div", { className: "dshbw-cost-row", key: "unpriced" },
              React.createElement("span", { className: "dshbw-burn", title: title },
                cost.session.unpricedTurns + " turn(s) unpriced" + why)),
          );
        }

        children.push(React.createElement("div", { className: "dshbw-sep", key: "cost-sep" }));

        // The chart sits under the figures it draws, and above the errors and the
        // refresh row. It needs a turn to have a timeline at all.
        //
        // Called rather than mounted as `React.createElement(BurnChart, …)`: it
        // holds no hooks, and inlining it keeps the chart in the same element
        // tree the panel returns, which is what the tests can see.
        if (cost.graphEnabled !== false && turn !== null) {
          children.push(
            React.createElement(
              "div",
              { className: "dshbw-chart-wrap", key: "chart" },
              BurnChart({ turn: turn, cost: cost, tick: tick }),
            ),
          );
        }
        children.push(React.createElement("div", { className: "dshbw-cost", key: "cost" }, costRows));
      }

      if (data !== null && data.isAvailable === false) {
        children.push(
          React.createElement("div", { className: "dshbw-warn", key: "unavailable" }, "Not available for API calls"),
        );
      }
      if (hostError) {
        children.push(
          React.createElement(
            "div",
            { className: "dshbw-error", key: "host-error" },
            (stale ? "Last check failed: " : "") + data.error.message,
          ),
        );
      } else if (transportError) {
        children.push(
          React.createElement("div", { className: "dshbw-error", key: "transport-error" }, "Cannot reach dsh: " + view.error),
        );
      }

      children.push(
        React.createElement(
          "div",
          { className: "dshbw-actions", key: "actions" },
          React.createElement("span", { className: "dshbw-caption" }, relativeTime(data?.fetchedAt ?? null)),
          React.createElement("span", { className: "dshbw-spacer" }),
          React.createElement(
            "button",
            {
              className: "dshbw-btn",
              type: "button",
              disabled: refreshing,
              onClick: onRefresh,
              title: "Check now",
              "aria-label": "Refresh balance now",
            },
            refreshing ? "checking\u2026" : "refresh",
          ),
        ),
      );

      return React.createElement(
        "div",
        {
          className: "dshbw-panel" + (drag !== null ? " dshbw-panel--dragging" : ""),
          style: style,
          ref: rootRef,
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerUp,
        },
        children,
      );
    }

    // --- settings tab ------------------------------------------------------

    /** The plugin's write route. Same origin, JSON body required by the fence. */
    var CONFIG_PATH = "dsh-budget-watcher/config";

    /**
     * Right-sidebar tab identity. `sidebarRight.openTabIn` takes a tab *kind*,
     * and the body and title are keyed slots dispatched by the tab id, which is
     * why this is one stable string used in four places.
     */
    var TAB_KIND = "budget-watcher-settings";
    var TAB_ID = "dsh-budget-watcher/settings";
    var TAB_TITLE = "Budget";
    var TAB_BODY_SLOT = "sidebar.right.pane.tab";
    var TAB_TITLE_SLOT = "sidebar.right.pane.tab.title";

    /**
     * Opens the settings tab for a session, once something has registered one.
     * `null` when this profile has no right sidebar, which is what hides the
     * gear button rather than offering a control that does nothing.
     */
    var openSettingsTab = null;

    /** Milliseconds to a form field the user types in, and back. */
    var msToSeconds = function (ms) { return String(Math.round(ms / 1000)); };
    var secondsToMs = function (text) { return Math.round(Number(text) * 1000); };
    var msToMinutes = function (ms) { return String(Math.round(ms / 60000)); };
    var minutesToMs = function (text) { return Math.round(Number(text) * 60000); };

    /**
     * A closed drop-down.
     *
     * Used for currency because the set is exactly DeepSeek's: they publish
     * rates in CNY and USD, so a free-text field could only ever be wrong.
     */
    function select(label, value, options, onChange, key) {
      return React.createElement(
        "label",
        { className: "dshbw-field", key: key ?? label },
        React.createElement("span", { className: "dshbw-label" }, label),
        React.createElement(
          "select",
          {
            className: "dshbw-input",
            value: value,
            onChange: function (event) { onChange(event.target.value); },
          },
          options.map(function (option) {
            return React.createElement("option", { value: option, key: option }, option);
          }),
        ),
      );
    }

    function field(label, value, onChange, options) {
      var settings = options ?? {};
      return React.createElement(
        "label",
        { className: "dshbw-field", key: settings.key ?? label },
        React.createElement("span", { className: "dshbw-label" }, label),
        React.createElement("input", {
          className: "dshbw-input",
          type: settings.type ?? "text",
          value: value,
          placeholder: settings.placeholder,
          autoComplete: settings.type === "password" ? "new-password" : undefined,
          onChange: function (event) { onChange(event.target.value); },
        }),
      );
    }

    function checkbox(label, checked, onChange, key) {
      return React.createElement(
        "label",
        { className: "dshbw-check", key: key },
        React.createElement("input", {
          type: "checkbox",
          checked: checked === true,
          onChange: function (event) { onChange(event.target.checked); },
        }),
        React.createElement("span", null, label),
      );
    }

    /**
     * The settings surface.
     *
     * It fetches the running configuration itself rather than sharing the
     * panel's poll: the two have different lifetimes, and a settings form that
     * repainted on every balance poll would fight whoever is typing in it.
     *
     * Nothing here is applied locally. Saving posts to the host, which writes
     * the profile patch through the loader's own config editor, so what the form
     * shows afterwards is the value the plugin is actually running with — not
     * what the form hoped it would be.
     */
    function SettingsTab() {
      var statePair = React.useState({ status: "loading", settings: null, error: null });
      var view = statePair[0];
      var setView = statePair[1];
      var formPair = React.useState(null);
      var form = formPair[0];
      var setForm = formPair[1];
      var savePair = React.useState({ status: "idle", text: "" });
      var save = savePair[0];
      var setSave = savePair[1];
      var keyTouchedPair = React.useState(false);
      var keyTouched = keyTouchedPair[0];
      var setKeyTouched = keyTouchedPair[1];

      var adopt = React.useCallback(function (next) {
        if (next === null || next === undefined || next.effective === undefined) return;
        var e = next.effective;
        setForm({
          provider: e.provider,
          apiKeyEnv: e.apiKeyEnv,
          endpoint: e.endpoint ?? "",
          apiKey: "",
          currency: e.currency,
          refreshSeconds: msToSeconds(e.refreshIntervalMs),
          timeoutSeconds: msToSeconds(e.requestTimeoutMs),
          costEnabled: e.costEnabled,
          graphEnabled: e.graphEnabled !== false,
          // Kept as text: the field accepts `auto` or a number, and parseFxSetting
          // is what decides which it is.
          usdToCny: String(e.usdToCny ?? "auto"),
          // Seconds, because a 15 s window is the point and "0.25 minutes" is not
          // a number anyone wants to type.
          burnSeconds: msToSeconds(e.burnWindowMs),
          warnPerHour: String(e.burnWarnPerHour),
          terminatePerHour: String(e.terminateAbovePerHour),
          allowNonLoopback: e.allowNonLoopback,
        });
      }, []);

      var load = React.useCallback(function () {
        return fetch(new URL(STATE_PATH, document.baseURI).href, { headers: { accept: "application/json" } })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
          })
          .then(function (data) {
            setView({
              status: "ready",
              settings: data.settings ?? null,
              error: null,
              cost: data.cost ?? null,
              balanceCurrency: data.featured?.currency ?? null,
            });
            adopt(data.settings);
          })
          .catch(function (error) {
            setView({ status: "error", settings: null, error: String((error && error.message) || error) });
          });
      }, [adopt]);

      React.useEffect(function () { load(); }, [load]);

      var update = React.useCallback(function (key, value) {
        setForm(function (previous) { return Object.assign({}, previous, { [key]: value }); });
        setSave({ status: "idle", text: "" });
      }, []);

      var onSave = React.useCallback(function () {
        if (form === null) return;
        var patch = {
          provider: form.provider,
          apiKeyEnv: form.apiKeyEnv,
          endpoint: form.endpoint,
          currency: form.currency,
          costEnabled: form.costEnabled,
          graphEnabled: form.graphEnabled,
          usdToCny: form.usdToCny,
          allowNonLoopback: form.allowNonLoopback,
          refreshIntervalMs: secondsToMs(form.refreshSeconds),
          requestTimeoutMs: secondsToMs(form.timeoutSeconds),
          burnWindowMs: secondsToMs(form.burnSeconds),
          burnWarnPerHour: Number(form.warnPerHour),
          terminateAbovePerHour: Number(form.terminatePerHour),
        };
        for (var name in patch) {
          if (typeof patch[name] === "number" && !isFinite(patch[name])) {
            setSave({ status: "error", text: name + " must be a number" });
            return;
          }
        }
        // Only sent when the field was actually touched: an untouched password
        // box posts nothing, and an emptied one clears the key.
        if (keyTouched) patch.apiKey = form.apiKey;

        setSave({ status: "saving", text: "saving\u2026" });
        fetch(new URL(CONFIG_PATH, document.baseURI).href, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ patch: patch }),
        })
          .then(function (response) {
            return response.json().then(function (body) { return { ok: response.ok, body: body }; });
          })
          .then(function (result) {
            if (result.body?.settings !== undefined) {
              setView(function (previous) {
                return { status: "ready", settings: result.body.settings, error: null, cost: previous.cost };
              });
              adopt(result.body.settings);
            }
            setKeyTouched(false);
            if (result.ok && result.body?.ok === true) {
              setSave({ status: "saved", text: result.body.note ?? "Saved." });
              // The turn table comes from the same route, so refresh it too.
              load();
            } else {
              setSave({ status: "error", text: result.body?.error ?? "Save failed." });
            }
          })
          .catch(function (error) {
            setSave({ status: "error", text: String((error && error.message) || error) });
          });
      }, [form, keyTouched, adopt]);

      if (view.status === "loading") {
        return React.createElement("div", { className: "dshbw-form dshbw-note" }, "Loading settings\u2026");
      }
      if (view.status === "error") {
        return React.createElement("div", { className: "dshbw-form dshbw-note dshbw-note--bad" }, "Cannot read settings: " + view.error);
      }
      if (form === null) {
        return React.createElement("div", { className: "dshbw-form dshbw-note" }, "No settings reported by the host.");
      }

      var editable = view.settings !== null && view.settings.editable === true;
      var children = [];
      // The thresholds are labelled in the currency the costs are priced in. The
      // cost payload knows it; with cost estimation off, the setting itself is
      // the only source, so it is the fallback rather than a hard-coded USD.
      var costCurrency = view.cost?.currency ?? (form !== null && form.currency !== "auto" ? form.currency : "USD");

      if (!editable) {
        children.push(
          React.createElement("div", { className: "dshbw-note dshbw-note--bad", key: "ro" },
            "Read-only: " + ((view.settings && view.settings.reason) ?? "unknown") +
            ". Edit the profile patch by hand; save the values below for reference."),
        );
      }

      children.push(
        React.createElement("div", { className: "dshbw-group-title", key: "g-bal" }, "Balance"),
        field("API key reference", form.apiKeyEnv, function (v) { update("apiKeyEnv", v); }, { key: "apiKeyEnv" }),
        field("API key", form.apiKey, function (v) { setKeyTouched(true); update("apiKey", v); }, {
          key: "apiKey",
          type: "password",
          placeholder: view.settings?.apiKeySet === true ? "\u2022\u2022\u2022\u2022 set \u2014 type to replace, clear to remove" : "not set",
        }),
        select("Currency", form.currency, ["auto", "CNY", "USD"], function (v) { update("currency", v); }, "currency"),
        field("Advanced: balance endpoint", form.endpoint, function (v) { update("endpoint", v); }, {
          key: "endpoint",
          placeholder: "provider default",
        }),
      );

      children.push(
        React.createElement("div", { className: "dshbw-group", key: "g-cost" },
          React.createElement("div", { className: "dshbw-group-title" }, "Cost estimate"),
          checkbox("Estimate what turns cost", form.costEnabled, function (v) { update("costEnabled", v); }, "costEnabled"),
          checkbox("Draw the live-burn chart", form.graphEnabled, function (v) { update("graphEnabled", v); }, "graphEnabled"),
          // `auto` fetches a central-bank rate; a number means use it and stop
          // asking anyone. One field, because the value you see is the value in force.
          field("USD \u2192 CNY rate (auto, or a number)", form.usdToCny, function (v) { update("usdToCny", v); }, { key: "usdToCny" }),
          field("Live burn window (seconds)", form.burnSeconds, function (v) { update("burnSeconds", v); }, { key: "burnSeconds", type: "number" }),
          field("Warn above (" + costCurrency + "/hour)", form.warnPerHour, function (v) { update("warnPerHour", v); }, { key: "warnPerHour", type: "number" }),
          field("Terminate above (" + costCurrency + "/hour, 0 = off)", form.terminatePerHour, function (v) { update("terminatePerHour", v); }, { key: "terminatePerHour", type: "number" }),
          React.createElement("div", { className: "dshbw-note" },
            "Both thresholds are in the balance's own currency. Terminating interrupts the running turn, exactly as pressing stop does."),
          // Choosing a currency the account does not hold is allowed — the
          // figures are then priced from that currency's rate card — but the
          // mismatch is confusing enough to be worth saying out loud.
          view.balanceCurrency != null && view.balanceCurrency !== costCurrency
            ? React.createElement("div", { className: "dshbw-note" },
                "Costs are shown in " + costCurrency + " while the balance is held in " + view.balanceCurrency +
                  ", so the two sections use different currency symbols.")
            : null,
        ),
      );

      children.push(
        React.createElement("div", { className: "dshbw-group", key: "g-adv" },
          React.createElement("div", { className: "dshbw-group-title" }, "Polling"),
          // Named for what it actually gates. It is the window the host reuses one
          // balance answer for — not how often the panel polls, which it never was
          // and which a label of "refresh interval" made people expect.
          field("Balance cache (seconds)", form.refreshSeconds, function (v) { update("refreshSeconds", v); }, { key: "refreshSeconds", type: "number" }),
          field("Request timeout (seconds)", form.timeoutSeconds, function (v) { update("timeoutSeconds", v); }, { key: "timeoutSeconds", type: "number" }),
          field("Provider", form.provider, function (v) { update("provider", v); }, { key: "provider" }),
          checkbox("Allow the route on a non-loopback address", form.allowNonLoopback, function (v) { update("allowNonLoopback", v); }, "allowNonLoopback"),
        ),
      );

      // Recent turns, so two finished tasks can be compared by what they cost
      // and how fast they burned. This is the "which tasks are expensive" view;
      // the panel deliberately shows only the turn in hand.
      var turns = view.cost?.turns ?? [];
      if (turns.length > 0) {
        var ranked = turns.slice().sort(function (a, b) { return b.amountPerHour - a.amountPerHour; });
        var rows = ranked.map(function (entry) {
          return React.createElement(
            "div",
            { className: "dshbw-turn-row", key: "turn-" + entry.turn },
            React.createElement("span", { className: "dshbw-cost-value" }, formatCost(entry.amount, view.cost.currency)),
            React.createElement("span", null, formatCost(entry.amountPerHour, view.cost.currency) + "/h"),
            React.createElement("span", { className: "dshbw-turn-when" }, formatDuration(entry.durationMs)),
          );
        });
        children.push(
          React.createElement(
            "div",
            { className: "dshbw-group", key: "g-turns" },
            React.createElement("div", { className: "dshbw-group-title" }, "Recent turns (hottest first)"),
            React.createElement("div", { className: "dshbw-note" }, "cost \u00b7 burn rate \u00b7 duration"),
            React.createElement("div", { className: "dshbw-turns" }, rows),
          ),
        );
      }

      children.push(
        React.createElement("div", { className: "dshbw-actions-row", key: "actions" },
          React.createElement("button", {
            className: "dshbw-save",
            type: "button",
            disabled: !editable || save.status === "saving",
            onClick: onSave,
          }, save.status === "saving" ? "Saving\u2026" : "Save"),
          React.createElement("span", {
            className: "dshbw-note" + (save.status === "error" ? " dshbw-note--bad" : save.status === "saved" ? " dshbw-note--ok" : ""),
          }, save.text),
        ),
      );

      return React.createElement("div", { className: "dshbw-form" }, children);
    }

    /**
     * Register the tab, then hand back an opener for the gear button.
     *
     * Everything is wrapped: these are optional services, and a profile without
     * a right sidebar should lose the button, not the panel.
     */
    function registerSettingsTab(host) {
      var disposers = [];
      var dispose = function () {
        openSettingsTab = null;
        for (var index = disposers.length - 1; index >= 0; index -= 1) {
          try { disposers[index](); } catch { /* already gone */ }
        }
        disposers.length = 0;
      };
      try {
        var sidebar = host.get("sidebarRight");
        var tabs = host.get("sidebarRightTabs");
        if (typeof sidebar?.openTabIn !== "function" || typeof tabs?.register !== "function") return function () {};

        disposers.push(host.slots.register({ name: TAB_BODY_SLOT, key: TAB_ID }, SettingsTab));
        disposers.push(host.slots.register({ name: TAB_TITLE_SLOT, key: TAB_ID }, function () {
          return React.createElement("span", null, TAB_TITLE);
        }));
        disposers.push(tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: function () { return TAB_TITLE; },
          guide: [{
            order: 70,
            title: function () { return TAB_TITLE; },
            description: function () { return "Balance, cost estimate and polling settings."; },
          }],
        }));
        openSettingsTab = function (sessionId) {
          try {
            sidebar.openTabIn(sessionId, TAB_KIND);
            return true;
          } catch {
            return false;
          }
        };
      } catch {
        dispose();
        return function () {};
      }
      return dispose;
    }

    // The `slots` service is the only hard dependency: it is always present
    // wherever `shell.overlay` is, and a service declared here that the profile
    // does not provide would leave this fiber pending. Timers are owned by the
    // component instead (see `BudgetWatcher`), and the settings tab registers
    // only when the right sidebar is actually there.
    var inject = ["slots"];

    function apply(ctx) {
      installStyles();

      // Registered unconditionally, and this is load-bearing: `ctx.get` here
      // only sees services that are already provided, and the right sidebar is
      // often provided *after* this plugin materializes. Guarding on `ctx.get`
      // therefore skipped the registration for good and the gear button never
      // appeared. `ctx.inject` fires whenever the services arrive, and
      // `registerSettingsTab` re-checks their shape inside.
      ctx.inject(["sidebarRight", "sidebarRightTabs"], function (injected) {
        return registerSettingsTab(injected);
      });

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          {
            name: "shell.overlay",
            id: "budget-watcher",
            order: 50,
            label: "Budget watcher",
          },
          BudgetWatcher,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
