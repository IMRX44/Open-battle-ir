/*
 * OpenBattle Assistant — settings model (isolated world).
 *
 * Shared by the panel, the hotkey handler and the popup. Content scripts from
 * the same extension share one isolated-world global scope, so this simply
 * publishes onto `window`.
 */
(function () {
  "use strict";

  if (window.OBA_UI) return;

  /**
   * The buildable set, in the same order the game numbers them, so a player
   * who already knows the game's 1..0 keys keeps the same muscle memory —
   * the only difference is holding Shift to place instantly at the cursor.
   *
   * `type` values are the exact wire strings from core/game/Game.ts UnitType.
   */
  var UNITS = [
    { type: "City", fa: "شهر", icon: "🏙️", slot: "1" },
    { type: "Factory", fa: "کارخانه", icon: "🏭", slot: "2" },
    { type: "Port", fa: "بندر", icon: "⚓", slot: "3" },
    { type: "Defense Post", fa: "پاسگاه دفاعی", icon: "🛡️", slot: "4" },
    { type: "Missile Silo", fa: "سیلوی موشک", icon: "🚀", slot: "5" },
    { type: "SAM Launcher", fa: "پدافند SAM", icon: "🛰️", slot: "6" },
    { type: "Warship", fa: "ناو جنگی", icon: "🚢", slot: "7" },
    { type: "Atom Bomb", fa: "بمب اتم", icon: "☢️", slot: "8" },
    { type: "Hydrogen Bomb", fa: "بمب هیدروژنی", icon: "💥", slot: "9" },
    { type: "MIRV", fa: "موشک MIRV", icon: "🛸", slot: "0" },
  ];

  // Shift + the game's own digit keeps every default free of collisions:
  // the game requires shiftKey to be false for its plain-digit binds.
  var DEFAULT_SHORTCUTS = {
    City: "Shift+Digit1",
    Factory: "Shift+Digit2",
    Port: "Shift+Digit3",
    "Defense Post": "Shift+Digit4",
    "Missile Silo": "Shift+Digit5",
    "SAM Launcher": "Shift+Digit6",
    Warship: "Shift+Digit7",
    "Atom Bomb": "Shift+Digit8",
    "Hydrogen Bomb": "Shift+Digit9",
    MIRV: "Shift+Digit0",
  };

  var DEFAULTS = {
    enabled: true,
    shortcutsEnabled: true,
    allowUpgrade: true, // pressing the key on an existing structure upgrades it
    toasts: true,
    shortcuts: DEFAULT_SHORTCUTS,
    panel: { open: true, tab: "keys", x: null, y: null },
    bot: {
      preset: "god",
      aggression: 0.85,
      attackThreshold: 1.35,
      attackEfficiency: 1.7,
      attackRatio: 0.9,
      expandRatio: 0.92,
      reserve: 0.1,
      autoSpawn: true,
      economy: true,
      defense: true,
      warships: true,
      nukes: true,
      boats: true,
      islands: true,
      distrust: true,
      diplomacy: true,
      betray: true,
      freeBuild: false,
    },
  };

  var PRESETS = ["god", "balanced", "aggressive", "economic", "turtle"];

  var PRESET_FA = {
    god: "خدایی",
    balanced: "متعادل",
    aggressive: "تهاجمی",
    economic: "اقتصادی",
    turtle: "دفاعی",
  };

  var PRESET_HINT = {
    god:
      "قوی‌ترین حالت — هدفش بردن است، نه زنده ماندن. هر لحظه همه‌ی کارهای ممکن را " +
      "قیمت‌گذاری و امتیازدهی می‌کند و هم‌زمان می‌سازد، ارتقا می‌دهد، موشک می‌زند و حمله " +
      "می‌کند. طلا را از گران‌ترین به ارزان‌ترین خرج نمی‌کند؛ از بیشترین ارزش به ازای هر " +
      "سکه. سیلو و پدافند را لول‌آپ می‌کند (سطح سیلو = تعداد موشک هم‌زمان)، رگبار موشک " +
      "می‌زند تا پدافند حریف اشباع شود، همه‌ی سربازها را یک جا نمی‌ریزد، جزیره می‌گیرد، " +
      "و به کسی که دارد نابود می‌شود حمله می‌کند — حتی اگر متحدمان باشد.",
    balanced: "گسترش، اقتصاد و جنگ متوازن.",
    aggressive: "زودتر و با نیروی بیشتر حمله می‌کند.",
    economic: "بیشتر می‌سازد، دیرتر می‌جنگد.",
    turtle: "ذخیره‌ی نیروی بالا، پاسگاه و پدافند زیاد.",
  };

  var state = null;
  var watchers = [];

  function deepMerge(base, patch) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var v = patch[k];
      if (v && typeof v === "object" && !Array.isArray(v) && base && base[k]) {
        out[k] = deepMerge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function load() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get("settings", function (res) {
          var stored = (res && res.settings) || {};
          state = deepMerge(clone(DEFAULTS), stored);
          // A shortcut for a unit that no longer exists is dead weight.
          var clean = {};
          UNITS.forEach(function (u) {
            clean[u.type] =
              state.shortcuts[u.type] !== undefined
                ? state.shortcuts[u.type]
                : DEFAULT_SHORTCUTS[u.type];
          });
          state.shortcuts = clean;
          resolve(state);
        });
      } catch (e) {
        state = clone(DEFAULTS);
        resolve(state);
      }
    });
  }

  function save() {
    try {
      chrome.storage.local.set({ settings: state });
    } catch (e) {
      /* storage can be unavailable during extension reloads */
    }
    watchers.forEach(function (fn) {
      try {
        fn(state);
      } catch (e) {}
    });
  }

  function get() {
    return state || (state = clone(DEFAULTS));
  }

  /* --------------------------- key handling -------------------------- */

  /** Canonical binding string for a keyboard event, e.g. "Shift+Digit1". */
  function comboFromEvent(e) {
    if (!e.code) return null;
    if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code)) return null;
    var parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(e.code);
    return parts.join("+");
  }

  /** Human-readable label for a binding string. */
  function comboLabel(combo) {
    if (!combo) return "—";
    return combo
      .split("+")
      .map(function (part) {
        if (part.indexOf("Digit") === 0) return part.slice(5);
        if (part.indexOf("Numpad") === 0) return "Num" + part.slice(6);
        if (part.indexOf("Key") === 0) return part.slice(3);
        if (part === "Ctrl") return "Ctrl";
        if (part === "Alt") return "Alt";
        if (part === "Shift") return "⇧";
        if (part === "Meta") return "⌘";
        return part;
      })
      .join(" + ");
  }

  window.OBA_UI = {
    UNITS: UNITS,
    DEFAULTS: DEFAULTS,
    DEFAULT_SHORTCUTS: DEFAULT_SHORTCUTS,
    PRESETS: PRESETS,
    PRESET_FA: PRESET_FA,
    PRESET_HINT: PRESET_HINT,
    load: load,
    save: save,
    get: get,
    onChange: function (fn) {
      watchers.push(fn);
    },
    comboFromEvent: comboFromEvent,
    comboLabel: comboLabel,
  };
})();
