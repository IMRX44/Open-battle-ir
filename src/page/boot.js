/*
 * OpenBattle Assistant — page/extension message bridge.
 *
 * The panel lives in the extension's isolated world (it needs chrome.storage);
 * the game hooks live here in the page world (they need the game's objects).
 * This file is the only thing that talks across that boundary.
 */
(function () {
  "use strict";

  var OBA = window.__OBA__;
  if (!OBA || OBA.__booted) return;
  OBA.__booted = true;

  var TAG = "__oba__";

  function post(msg) {
    msg[TAG] = 1;
    window.postMessage(msg, window.location.origin);
  }

  function emit(kind, payload) {
    post({ dir: "evt", kind: kind, payload: payload });
  }

  OBA.onLog(function (entry) {
    emit("log", entry);
  });

  /* ------------------------------- RPC ------------------------------ */
  var handlers = {
    ping: function () {
      return { ok: true, version: "1.0.0" };
    },

    snapshot: function () {
      var snap = OBA.snapshot();
      var bot = OBA.Bot;
      snap.bot = bot
        ? {
            running: bot.running,
            preset: bot.cfg.preset,
            stats: bot.stats,
            spawnPicked: bot.spawnPicked,
          }
        : null;
      return snap;
    },

    quickBuild: function (args) {
      return OBA.quickBuild(args.unit, args.x, args.y, args.opts || {});
    },

    botStart: function (args) {
      if (!OBA.Bot) return { ok: false, reason: "no_bot" };
      OBA.Bot.start(args && args.cfg);
      return { ok: true, cfg: OBA.Bot.cfg };
    },

    botStop: function () {
      if (!OBA.Bot) return { ok: false, reason: "no_bot" };
      OBA.Bot.stop();
      return { ok: true };
    },

    botConfig: function (args) {
      if (!OBA.Bot) return { ok: false, reason: "no_bot" };
      return { ok: true, cfg: OBA.Bot.setConfig((args && args.cfg) || {}) };
    },

    botDefaults: function () {
      return { defaults: OBA.BotDefaults, presets: OBA.BotPresets };
    },
  };

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data[TAG] !== 1 || data.dir !== "req") return;

    var fn = handlers[data.cmd];
    if (!fn) {
      post({ dir: "res", id: data.id, ok: false, error: "unknown_cmd" });
      return;
    }
    var out;
    try {
      out = fn(data.args || {});
    } catch (e) {
      post({ dir: "res", id: data.id, ok: false, error: String(e) });
      return;
    }
    if (out && typeof out.then === "function") {
      out.then(
        function (r) {
          post({ dir: "res", id: data.id, ok: true, result: r });
        },
        function (e) {
          post({ dir: "res", id: data.id, ok: false, error: String(e) });
        },
      );
    } else {
      post({ dir: "res", id: data.id, ok: true, result: out });
    }
  });

  // Heartbeat so the panel can show live numbers without polling round-trips.
  setInterval(function () {
    try {
      var snap = OBA.snapshot();
      var bot = OBA.Bot;
      snap.bot = bot
        ? { running: bot.running, preset: bot.cfg.preset, stats: bot.stats }
        : null;
      emit("state", snap);
    } catch (e) {
      /* ignore */
    }
  }, 700);

  emit("ready", { version: "1.0.0" });
})();
