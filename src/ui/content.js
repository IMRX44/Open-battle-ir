/*
 * OpenBattle Assistant — content script (isolated world).
 *
 * Owns the panel, the settings, the cursor position and the hotkeys, and
 * forwards work to the page world over window.postMessage.
 */
(function () {
  "use strict";

  var S = window.OBA_UI;
  var P = window.OBA_PANEL;
  if (!S || !P) return;

  var TAG = "__oba__";
  var seq = 0;
  var waiting = Object.create(null);
  var lastSnap = null;
  var mouse = { x: 0, y: 0, seen: false };
  var panelRoot = null;

  var UNIT_FA = {};
  S.UNITS.forEach(function (u) {
    UNIT_FA[u.type] = u.fa;
  });

  var REASON_FA = {
    no_game: "بازی هنوز آماده نیست",
    no_player: "هنوز وارد بازی نشده‌ای",
    no_transport: "اتصال به بازی برقرار نیست",
    off_map: "خارج از نقشه",
    unavailable: "این مورد در دسترس نیست",
    no_gold: "طلا کافی نیست",
    bad_spot: "اینجا نمی‌شود ساخت",
    error: "خطا",
  };

  /* -------------------------------- RPC ------------------------------ */
  function call(cmd, args) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting[id] = resolve;
      window.postMessage(
        { [TAG]: 1, dir: "req", id: id, cmd: cmd, args: args || {} },
        window.location.origin,
      );
      setTimeout(function () {
        if (waiting[id]) {
          delete waiting[id];
          resolve(null);
        }
      }, 8000);
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d || d[TAG] !== 1) return;

    if (d.dir === "res") {
      var fn = waiting[d.id];
      if (fn) {
        delete waiting[d.id];
        fn(d.ok ? d.result : null);
      }
      return;
    }
    if (d.dir === "evt") {
      if (d.kind === "state") {
        lastSnap = d.payload;
        P.setState(d.payload);
      } else if (d.kind === "log") {
        P.pushLog(d.payload);
      } else if (d.kind === "ready") {
        pushBotConfig();
      }
    }
  });

  /* ------------------------------ hotkeys ---------------------------- */
  function isTypingTarget(t) {
    if (!t) return false;
    var tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function unitForCombo(combo) {
    var s = S.get();
    for (var type in s.shortcuts) {
      if (s.shortcuts[type] && s.shortcuts[type] === combo) return type;
    }
    return null;
  }

  window.addEventListener(
    "keydown",
    function (e) {
      // Panel is waiting for the user to press the new binding.
      if (P.isListening()) {
        if (P.captureKey(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }

      if (isTypingTarget(e.target)) return;

      // Ctrl+Shift+O toggles the panel.
      if (e.ctrlKey && e.shiftKey && e.code === "KeyO") {
        e.preventDefault();
        e.stopImmediatePropagation();
        P.toggle();
        return;
      }

      var s = S.get();
      if (!s.enabled || !s.shortcutsEnabled) return;
      // Outside a live game the keys belong to the site, not to us.
      if (!lastSnap || !lastSnap.attached) return;
      if (!mouse.seen) return;

      var combo = S.comboFromEvent(e);
      if (!combo) return;
      var unit = unitForCombo(combo);
      if (!unit) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      placeAt(unit, mouse.x, mouse.y);
    },
    true,
  );

  function placeAt(unit, x, y) {
    var s = S.get();
    call("quickBuild", {
      unit: unit,
      x: x,
      y: y,
      opts: { upgrade: !!s.allowUpgrade },
    }).then(function (res) {
      if (!s.toasts) return;
      var name = UNIT_FA[unit] || unit;
      if (!res) {
        P.toast("پاسخی از بازی نیامد", "err", x, y);
        return;
      }
      if (res.ok) {
        P.toast(
          res.mode === "upgrade" ? name + " ارتقا یافت" : name + " ساخته شد",
          "ok",
          x,
          y,
        );
      } else {
        var why = REASON_FA[res.reason] || res.reason || "نشد";
        P.toast(name + " — " + why, "err", x, y);
      }
    });
  }

  /* --------------------------- cursor tracking ------------------------ */
  window.addEventListener(
    "mousemove",
    function (e) {
      if (panelRoot && e.target === panelRoot) return; // over our own UI
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      mouse.seen = true;
    },
    { capture: true, passive: true },
  );

  /* ------------------------------ bot glue ---------------------------- */
  function botCfgFromSettings() {
    var b = S.get().bot;
    return {
      preset: b.preset,
      aggression: b.aggression,
      attackThreshold: b.attackThreshold,
      attackEfficiency: b.attackEfficiency,
      attackRatio: b.attackRatio,
      expandRatio: b.expandRatio,
      reserve: b.reserve,
      autoSpawn: b.autoSpawn,
      economy: b.economy,
      defense: b.defense,
      warships: b.warships,
      nukes: b.nukes,
      boats: b.boats,
      islands: b.islands,
      distrust: b.distrust,
      freeBuild: b.freeBuild,
      diplomacy: b.diplomacy,
      betray: b.betray,
    };
  }

  function pushBotConfig() {
    call("botConfig", { cfg: botCfgFromSettings() });
  }

  var callbacks = {
    botStart: function () {
      call("botStart", { cfg: botCfgFromSettings() });
    },
    botStop: function () {
      call("botStop", {});
    },
    botConfig: function (patch) {
      call("botConfig", { cfg: patch });
    },
    botGetConfig: function (cb) {
      call("botConfig", { cfg: {} }).then(function (res) {
        cb(res && res.cfg);
      });
    },
  };

  /* ------------------------------- popup ------------------------------ */
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      if (!msg || !msg.cmd) return;
      if (msg.cmd === "togglePanel") {
        P.toggle();
        respond({ ok: true });
      } else if (msg.cmd === "status") {
        respond({ ok: true, snap: lastSnap });
      } else if (msg.cmd === "botStart") {
        callbacks.botStart();
        respond({ ok: true });
      } else if (msg.cmd === "botStop") {
        callbacks.botStop();
        respond({ ok: true });
      } else if (msg.cmd === "settingsChanged") {
        S.load().then(function () {
          P.syncFromSettings();
          pushBotConfig();
        });
        respond({ ok: true });
      }
      return true;
    });
  } catch (e) {
    /* popup messaging is optional */
  }

  /* -------------------------------- boot ------------------------------ */
  S.load().then(function () {
    panelRoot = P.mount(callbacks);
    pushBotConfig();
  });
})();
