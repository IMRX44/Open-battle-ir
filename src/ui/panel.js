/*
 * OpenBattle Assistant — in-page control panel (isolated world).
 *
 * Everything lives inside a shadow root attached to <html>, so the game's own
 * stylesheet cannot reach in and ours cannot leak out.
 */
(function () {
  "use strict";

  if (window.OBA_PANEL) return;
  var S = window.OBA_UI;

  var CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }

:host {
  --bg: rgba(12, 16, 27, 0.94);
  --bg-soft: rgba(255, 255, 255, 0.04);
  --bg-soft-2: rgba(255, 255, 255, 0.07);
  --line: rgba(255, 255, 255, 0.09);
  --txt: #e7ecf6;
  --muted: #8e9ab1;
  --accent: #7c5cff;
  --accent-2: #22d3ee;
  --good: #34d399;
  --warn: #fbbf24;
  --bad: #f87171;
  --radius: 14px;
  --font: "Vazirmatn", "IRANSansX", "IRANSans", "Segoe UI", Tahoma, system-ui, sans-serif;
}

.wrap {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-family: var(--font);
  direction: rtl;
}
.wrap > * { pointer-events: auto; }

/* ------------------------------- FAB ------------------------------- */
.fab {
  position: absolute;
  left: 18px;
  bottom: 18px;
  width: 52px; height: 52px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  color: #fff;
  font-size: 22px;
  display: grid; place-items: center;
  cursor: pointer;
  box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 0 rgba(124,92,255,.5);
  transition: transform .18s ease, box-shadow .18s ease;
}
.fab:hover { transform: translateY(-2px) scale(1.04); }
.fab.on { box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 6px rgba(124,92,255,.18); }
.fab .pulse {
  position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid var(--good); opacity: 0;
}
.fab.botting .pulse { opacity: 1; animation: pulse 1.6s ease-out infinite; }
@keyframes pulse {
  0% { transform: scale(.9); opacity: .8; }
  100% { transform: scale(1.35); opacity: 0; }
}

/* ------------------------------ panel ------------------------------ */
.panel {
  position: absolute;
  left: 18px; bottom: 84px;
  width: 344px;
  max-height: min(76vh, 660px);
  display: flex; flex-direction: column;
  background: var(--bg);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0,0,0,.55);
  color: var(--txt);
  overflow: hidden;
  opacity: 0; transform: translateY(8px) scale(.98);
  transition: opacity .16s ease, transform .16s ease;
}
.panel.open { opacity: 1; transform: none; }
.panel.hidden { display: none; }

.head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(120deg, rgba(124,92,255,.16), rgba(34,211,238,.08));
  cursor: grab;
  user-select: none;
}
.head:active { cursor: grabbing; }
.head .mark {
  width: 28px; height: 28px; border-radius: 9px;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  display: grid; place-items: center; font-size: 15px;
  flex: none;
}
.head h1 { font-size: 13.5px; font-weight: 700; letter-spacing: .2px; }
.head .sub { font-size: 10.5px; color: var(--muted); margin-top: 1px; }
.head .spacer { flex: 1; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); flex: none; }
.dot.ok { background: var(--good); box-shadow: 0 0 8px var(--good); }
.dot.wait { background: var(--warn); }
.iconbtn {
  width: 26px; height: 26px; border-radius: 8px; flex: none;
  border: 1px solid var(--line); background: var(--bg-soft);
  color: var(--muted); cursor: pointer; font-size: 14px;
  display: grid; place-items: center;
}
.iconbtn:hover { background: var(--bg-soft-2); color: var(--txt); }

/* ------------------------------- tabs ------------------------------ */
.tabs { display: flex; gap: 4px; padding: 8px 10px 0; }
.tab {
  flex: 1; padding: 7px 0; text-align: center;
  font-size: 12px; font-weight: 600; color: var(--muted);
  background: transparent; border: 0; border-radius: 9px;
  cursor: pointer; position: relative;
}
.tab:hover { color: var(--txt); }
.tab.active { color: #fff; background: var(--bg-soft-2); }
.tab.active::after {
  content: ""; position: absolute; left: 22%; right: 22%; bottom: -1px; height: 2px;
  border-radius: 2px; background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.body { overflow-y: auto; padding: 12px 12px 14px; flex: 1; }
.body::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; }
.pane { display: none; }
.pane.active { display: block; }

.note { font-size: 11px; color: var(--muted); line-height: 1.7; margin-bottom: 10px; }

/* ------------------------------ rows ------------------------------- */
.row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: 11px;
  background: var(--bg-soft); border: 1px solid transparent;
  margin-bottom: 6px;
}
.row:hover { border-color: var(--line); }
.row .ico { font-size: 16px; width: 22px; text-align: center; flex: none; }
.row .name { font-size: 12.5px; flex: 1; }
.row .hint { font-size: 10px; color: var(--muted); }

.keycap {
  min-width: 76px; padding: 5px 9px; flex: none;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 11px; font-weight: 700; letter-spacing: .3px;
  color: var(--txt); text-align: center;
  background: rgba(255,255,255,.06);
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 8px; cursor: pointer;
  direction: ltr;
}
.keycap:hover { background: rgba(255,255,255,.1); }
.keycap.listening {
  color: #fff; border-color: var(--accent);
  background: rgba(124,92,255,.22);
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink { 50% { opacity: .55; } }

/* ----------------------------- switch ------------------------------ */
.sw {
  position: relative; width: 38px; height: 21px; flex: none;
  border-radius: 999px; background: rgba(255,255,255,.13);
  border: 1px solid var(--line); cursor: pointer; transition: background .16s;
}
.sw::after {
  content: ""; position: absolute; top: 2px; right: 2px;
  width: 15px; height: 15px; border-radius: 50%;
  background: #fff; transition: transform .18s ease;
}
.sw.on { background: linear-gradient(120deg, var(--accent), var(--accent-2)); }
.sw.on::after { transform: translateX(-17px); }

/* ----------------------------- slider ------------------------------ */
.slider { margin-bottom: 12px; }
.slider .lbl { display: flex; justify-content: space-between; font-size: 11.5px; margin-bottom: 6px; }
.slider .lbl b { color: var(--accent-2); font-weight: 700; direction: ltr; }
.slider input[type=range] {
  -webkit-appearance: none; appearance: none; width: 100%; height: 4px;
  border-radius: 4px; background: rgba(255,255,255,.14); outline: none;
}
.slider input[type=range]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  cursor: pointer; border: 2px solid #0d1120;
}
.slider input[type=range]::-moz-range-thumb {
  width: 14px; height: 14px; border-radius: 50%; border: 2px solid #0d1120;
  background: var(--accent); cursor: pointer;
}

/* ----------------------------- chips ------------------------------- */
.chips { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-bottom: 8px; }
.chip.god { grid-column: 1 / -1; letter-spacing: .4px; }
.chip.god::before { content: "★ "; }
.chip.god.active {
  border-color: rgba(251,191,36,.6);
  background: linear-gradient(130deg, rgba(251,191,36,.26), rgba(244,63,94,.2));
  color: #ffe7b0;
}
.hint {
  font-size: 10.5px; line-height: 1.75; color: var(--muted);
  background: var(--bg-soft); border: 1px solid var(--line);
  border-radius: 10px; padding: 8px 10px; margin-bottom: 12px;
}
.chip {
  padding: 7px 0; text-align: center; font-size: 11.5px; font-weight: 600;
  border-radius: 9px; cursor: pointer; color: var(--muted);
  background: var(--bg-soft); border: 1px solid transparent;
}
.chip:hover { color: var(--txt); }
.chip.active {
  color: #fff; border-color: rgba(124,92,255,.55);
  background: linear-gradient(130deg, rgba(124,92,255,.3), rgba(34,211,238,.16));
}

/* --------------------------- big button ---------------------------- */
.bigbtn {
  width: 100%; padding: 13px; border-radius: 13px; border: 0;
  font-family: var(--font); font-size: 14px; font-weight: 800; color: #fff;
  cursor: pointer; margin-bottom: 12px;
  background: linear-gradient(130deg, var(--accent), var(--accent-2));
  box-shadow: 0 8px 22px rgba(124,92,255,.32);
  transition: transform .12s ease, filter .12s ease;
}
.bigbtn:hover { filter: brightness(1.08); }
.bigbtn:active { transform: scale(.985); }
.bigbtn.stop {
  background: linear-gradient(130deg, #f43f5e, #f97316);
  box-shadow: 0 8px 22px rgba(244,63,94,.3);
}
.bigbtn:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }

.sec { font-size: 10.5px; font-weight: 700; color: var(--muted);
  letter-spacing: .5px; margin: 14px 2px 8px; }

/* ----------------------------- stats ------------------------------- */
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; }
.stat {
  background: var(--bg-soft); border: 1px solid var(--line);
  border-radius: 11px; padding: 9px 8px; text-align: center;
}
.stat .v { font-size: 14px; font-weight: 800; direction: ltr; }
.stat .k { font-size: 9.5px; color: var(--muted); margin-top: 2px; }
.bar { height: 5px; border-radius: 5px; background: rgba(255,255,255,.1); overflow: hidden; margin-top: 6px; }
.bar > i { display: block; height: 100%; border-radius: 5px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .3s ease; }

/* Newest first, so the latest action is always visible without scrolling. */
.log { display: flex; flex-direction: column; gap: 3px; max-height: 210px; overflow-y: auto; }
.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 8px; }
.log .li {
  font-size: 11px; line-height: 1.6; padding: 5px 8px; border-radius: 8px;
  background: var(--bg-soft); border-right: 2px solid var(--muted); color: var(--muted);
}
.log .li.good { border-color: var(--good); color: #cfe9dc; }
.log .li.warn { border-color: var(--warn); color: #f2e3c0; }
.log .li.error { border-color: var(--bad); color: #f3cdcd; }
.log .li.info { border-color: var(--accent-2); color: #cfe4ee; }
.log .li i { font-style: normal; opacity: .5; font-size: 9.5px; direction: ltr; float: left; }

.empty { text-align: center; color: var(--muted); font-size: 11.5px; padding: 22px 0; }

/* ----------------------------- toast ------------------------------- */
.toast {
  position: absolute; transform: translate(50%, -140%);
  padding: 6px 11px; border-radius: 10px;
  font-size: 12px; font-weight: 700; white-space: nowrap;
  background: rgba(12,16,27,.94); border: 1px solid var(--line);
  color: var(--txt); box-shadow: 0 8px 22px rgba(0,0,0,.45);
  animation: rise .9s ease forwards; pointer-events: none;
}
.toast.ok { border-color: rgba(52,211,153,.6); color: #b8f0dc; }
.toast.err { border-color: rgba(248,113,113,.6); color: #fac9c9; }
@keyframes rise {
  0% { opacity: 0; transform: translate(50%, -110%); }
  18% { opacity: 1; transform: translate(50%, -150%); }
  75% { opacity: 1; }
  100% { opacity: 0; transform: translate(50%, -195%); }
}
`;

  var HTML = `
<div class="wrap">
  <div class="panel hidden" id="panel">
    <div class="head" id="head">
      <div class="mark">⚔️</div>
      <div>
        <h1>دستیار اوپن‌بتل</h1>
        <div class="sub" id="sub">در انتظار بازی…</div>
      </div>
      <div class="spacer"></div>
      <div class="dot" id="dot"></div>
      <button class="iconbtn" id="close" title="بستن">✕</button>
    </div>

    <div class="tabs">
      <button class="tab active" data-tab="keys">میانبرها</button>
      <button class="tab" data-tab="bot">ربات</button>
      <button class="tab" data-tab="stats">آمار</button>
    </div>

    <div class="body">
      <!-- ---------------------------- keys --------------------------- -->
      <div class="pane active" data-pane="keys">
        <p class="note">
          کلید را بزن تا همان لحظه، هرجا که نشانگر ماوس است، ساختمان ساخته شود.
          نه انتخاب، نه کلیک دوم، نه کشیدن و رها کردن.
          برای تغییر کلید روی آن بزن و کلید جدید را فشار بده.
        </p>
        <div class="row">
          <div class="ico">⚡</div>
          <div class="name">فعال بودن میانبرها</div>
          <div class="sw on" id="sw-shortcuts"></div>
        </div>
        <div class="row">
          <div class="ico">⬆️</div>
          <div class="name">ارتقا در صورت وجود سازه
            <div class="hint">اگر همان‌جا سازه‌ای باشد، ارتقا می‌شود</div>
          </div>
          <div class="sw on" id="sw-upgrade"></div>
        </div>
        <div class="row">
          <div class="ico">💬</div>
          <div class="name">نمایش پیام کنار نشانگر</div>
          <div class="sw on" id="sw-toasts"></div>
        </div>
        <div class="sec">ساختمان‌ها و کلیدها</div>
        <div id="keylist"></div>
      </div>

      <!-- ---------------------------- bot ---------------------------- -->
      <div class="pane" data-pane="bot">
        <button class="bigbtn" id="botbtn">▶  شروع بازی خودکار</button>
        <p class="note" id="botnote">
          ربات خودش نقطه شروع را انتخاب می‌کند (زمین باز، کنار آب، دور از حریف)،
          سرزمین می‌گیرد، اقتصاد می‌سازد و می‌جنگد.
          فقط در تک‌نفره و لابی خصوصی استفاده کن.
        </p>

        <div class="sec">سبک بازی</div>
        <div class="chips" id="presets"></div>
        <div class="hint" id="presetHint"></div>

        <div class="sec">تنظیم دقیق</div>
        <div class="slider" data-key="aggression">
          <div class="lbl"><span>میزان تهاجم</span><b>0.60</b></div>
          <input type="range" min="0" max="1" step="0.05">
        </div>
        <div class="slider" data-key="attackEfficiency">
          <div class="lbl"><span>برتری لازم برای حمله (کمترین تلفات)</span><b>1.70</b></div>
          <input type="range" min="1.2" max="3" step="0.05">
        </div>
        <div class="slider" data-key="attackThreshold">
          <div class="lbl"><span>حداقل برتری برای حمله (حالت ساده)</span><b>1.35</b></div>
          <input type="range" min="1" max="3" step="0.05">
        </div>
        <div class="slider" data-key="attackRatio">
          <div class="lbl"><span>سهم نیرو در هر حمله</span><b>0.55</b></div>
          <input type="range" min="0.1" max="0.95" step="0.05">
        </div>
        <div class="slider" data-key="expandRatio">
          <div class="lbl"><span>سهم نیرو در گسترش</span><b>0.85</b></div>
          <input type="range" min="0.2" max="0.98" step="0.02">
        </div>
        <div class="slider" data-key="reserve">
          <div class="lbl"><span>ذخیره نیرو</span><b>0.12</b></div>
          <input type="range" min="0" max="0.5" step="0.02">
        </div>

        <div class="sec">بخش‌های فعال</div>
        <div id="bottoggles"></div>
      </div>

      <!-- --------------------------- stats --------------------------- -->
      <div class="pane" data-pane="stats">
        <div id="statwrap"><div class="empty">هنوز وارد بازی نشده‌ای</div></div>
        <div class="sec">گزارش زنده</div>
        <div class="log" id="log"></div>
      </div>
    </div>
  </div>

  <button class="fab" id="fab" title="دستیار اوپن‌بتل">
    <span class="pulse"></span><span>⚔️</span>
  </button>
</div>`;

  var BOT_TOGGLES = [
    { key: "autoSpawn", fa: "انتخاب خودکار نقطه شروع", icon: "📍" },
    { key: "economy", fa: "اقتصاد (شهر، بندر، کارخانه)", icon: "🏙️" },
    { key: "defense", fa: "دفاع (پاسگاه، پدافند)", icon: "🛡️" },
    { key: "warships", fa: "ناوگان جنگی", icon: "🚢" },
    { key: "boats", fa: "حمله دریایی", icon: "⛵" },
    { key: "islands", fa: "گرفتن جزیره‌های بی‌صاحب", icon: "🏝️" },
    { key: "nukes", fa: "سلاح هسته‌ای", icon: "☢️" },
    { key: "diplomacy", fa: "اتحاد و دیپلماسی", icon: "🤝" },
    { key: "distrust", fa: "اتحاد بله، اعتماد نه", icon: "🕵️" },
    { key: "freeBuild", fa: "خرید نامحدود (طلای بی‌نهایت)", icon: "♾️" },
    { key: "betray", fa: "شکستن اتحاد در فرصت مناسب", icon: "🗡️" },
  ];

  var root, shadow, el = {}, api = {}, listening = null, lastSnap = null;

  function $(sel) {
    return shadow.querySelector(sel);
  }

  function mount(callbacks) {
    api = callbacks || {};
    root = document.createElement("div");
    root.id = "oba-root";
    root.style.cssText = "all:initial";
    shadow = root.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    var holder = document.createElement("div");
    holder.innerHTML = HTML;
    while (holder.firstChild) shadow.appendChild(holder.firstChild);
    (document.body || document.documentElement).appendChild(root);

    el.panel = $("#panel");
    el.fab = $("#fab");
    el.dot = $("#dot");
    el.sub = $("#sub");
    el.wrap = shadow.querySelector(".wrap");

    buildKeyList();
    buildPresets();
    buildBotToggles();
    wire();
    syncFromSettings();
    return root;
  }

  /* ----------------------------- building ---------------------------- */
  function buildKeyList() {
    var host = $("#keylist");
    host.innerHTML = "";
    S.UNITS.forEach(function (u) {
      var row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        '<div class="ico">' +
        u.icon +
        '</div><div class="name">' +
        u.fa +
        '<div class="hint">کلید بازی: ' +
        u.slot +
        "</div></div>" +
        '<button class="keycap" data-unit="' +
        u.type.replace(/"/g, "&quot;") +
        '"></button>';
      host.appendChild(row);
    });
  }

  function buildPresets() {
    var host = $("#presets");
    host.innerHTML = "";
    S.PRESETS.forEach(function (p) {
      var b = document.createElement("div");
      b.className = "chip" + (p === "god" ? " god" : "");
      b.dataset.preset = p;
      b.textContent = S.PRESET_FA[p] || p;
      host.appendChild(b);
    });
  }

  function buildBotToggles() {
    var host = $("#bottoggles");
    host.innerHTML = "";
    BOT_TOGGLES.forEach(function (t) {
      var row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        '<div class="ico">' +
        t.icon +
        '</div><div class="name">' +
        t.fa +
        '</div><div class="sw" data-bot="' +
        t.key +
        '"></div>';
      host.appendChild(row);
    });
  }

  /* ------------------------------ wiring ----------------------------- */
  function wire() {
    el.fab.addEventListener("click", function () {
      toggle();
    });
    $("#close").addEventListener("click", function () {
      toggle(false);
    });

    shadow.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        selectTab(tab.dataset.tab);
      });
    });

    // Simple toggles
    bindSwitch("#sw-shortcuts", "shortcutsEnabled");
    bindSwitch("#sw-upgrade", "allowUpgrade");
    bindSwitch("#sw-toasts", "toasts");

    // Key capture
    shadow.querySelectorAll(".keycap").forEach(function (cap) {
      cap.addEventListener("click", function (e) {
        e.stopPropagation();
        startListening(cap);
      });
    });

    // Bot controls
    $("#botbtn").addEventListener("click", function () {
      var running = lastSnap && lastSnap.bot && lastSnap.bot.running;
      if (running) api.botStop && api.botStop();
      else api.botStart && api.botStart();
    });

    shadow.querySelectorAll(".chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var s = S.get();
        s.bot.preset = chip.dataset.preset;
        S.save();
        syncFromSettings();
        api.botConfig && api.botConfig({ preset: s.bot.preset });
        // The preset rewrites the fine-tuning values; pull them back for display.
        setTimeout(pullBotCfg, 60);
      });
    });

    shadow.querySelectorAll(".slider").forEach(function (sl) {
      var input = sl.querySelector("input");
      var out = sl.querySelector("b");
      input.addEventListener("input", function () {
        out.textContent = Number(input.value).toFixed(2);
      });
      input.addEventListener("change", function () {
        var s = S.get();
        var patch = {};
        patch[sl.dataset.key] = Number(input.value);
        s.bot[sl.dataset.key] = Number(input.value);
        S.save();
        api.botConfig && api.botConfig(patch);
      });
    });

    shadow.querySelectorAll("[data-bot]").forEach(function (sw) {
      sw.addEventListener("click", function () {
        var s = S.get();
        var key = sw.dataset.bot;
        s.bot[key] = !s.bot[key];
        sw.classList.toggle("on", s.bot[key]);
        S.save();
        var patch = {};
        patch[key] = s.bot[key];
        api.botConfig && api.botConfig(patch);
      });
    });

    makeDraggable($("#head"), el.panel);
  }

  function bindSwitch(sel, key) {
    var sw = $(sel);
    sw.addEventListener("click", function () {
      var s = S.get();
      s[key] = !s[key];
      sw.classList.toggle("on", s[key]);
      S.save();
    });
  }

  function makeDraggable(handle, target) {
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener("mousedown", function (e) {
      if (e.target.closest(".iconbtn")) return;
      dragging = true;
      var r = target.getBoundingClientRect();
      sx = e.clientX;
      sy = e.clientY;
      ox = r.left;
      oy = r.top;
      target.style.bottom = "auto";
      target.style.left = ox + "px";
      target.style.top = oy + "px";
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var nx = Math.max(4, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
      var ny = Math.max(4, Math.min(window.innerHeight - 60, oy + e.clientY - sy));
      target.style.left = nx + "px";
      target.style.top = ny + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      var s = S.get();
      s.panel.x = parseInt(target.style.left, 10);
      s.panel.y = parseInt(target.style.top, 10);
      S.save();
    });
  }

  /* ------------------------- key capture mode ------------------------ */
  function startListening(cap) {
    if (listening) listening.classList.remove("listening");
    listening = cap;
    cap.classList.add("listening");
    cap.textContent = "…";
  }

  /** Called by content.js on every keydown while the panel is capturing. */
  function captureKey(e) {
    if (!listening) return false;
    if (e.code === "Escape") {
      stopListening();
      return true;
    }
    var combo = S.comboFromEvent(e);
    if (!combo) return true; // bare modifier — keep waiting
    var s = S.get();
    var unit = listening.dataset.unit;
    // A binding can only belong to one unit.
    Object.keys(s.shortcuts).forEach(function (k) {
      if (k !== unit && s.shortcuts[k] === combo) s.shortcuts[k] = "";
    });
    s.shortcuts[unit] = combo;
    S.save();
    stopListening();
    syncFromSettings();
    return true;
  }

  function stopListening() {
    if (listening) listening.classList.remove("listening");
    listening = null;
    syncFromSettings();
  }

  function isListening() {
    return !!listening;
  }

  /* ---------------------------- rendering ---------------------------- */
  function syncFromSettings() {
    if (!shadow) return;
    var s = S.get();
    $("#sw-shortcuts").classList.toggle("on", !!s.shortcutsEnabled);
    $("#sw-upgrade").classList.toggle("on", !!s.allowUpgrade);
    $("#sw-toasts").classList.toggle("on", !!s.toasts);

    shadow.querySelectorAll(".keycap").forEach(function (cap) {
      if (cap === listening) return;
      cap.textContent = S.comboLabel(s.shortcuts[cap.dataset.unit]) || "—";
    });

    shadow.querySelectorAll(".chip").forEach(function (c) {
      c.classList.toggle("active", c.dataset.preset === s.bot.preset);
    });
    $("#presetHint").textContent = S.PRESET_HINT[s.bot.preset] || "";
    shadow.querySelectorAll("[data-bot]").forEach(function (sw) {
      sw.classList.toggle("on", !!s.bot[sw.dataset.bot]);
    });
    shadow.querySelectorAll(".slider").forEach(function (sl) {
      var v = s.bot[sl.dataset.key];
      if (typeof v !== "number") return;
      sl.querySelector("input").value = v;
      sl.querySelector("b").textContent = v.toFixed(2);
    });

    if (s.panel.x !== null && s.panel.y !== null) {
      el.panel.style.left = s.panel.x + "px";
      el.panel.style.top = s.panel.y + "px";
      el.panel.style.bottom = "auto";
    }
    selectTab(s.panel.tab || "keys");
    toggle(!!s.panel.open, true);
  }

  function pullBotCfg() {
    if (!api.botGetConfig) return;
    api.botGetConfig(function (cfg) {
      if (!cfg) return;
      var s = S.get();
      Object.keys(s.bot).forEach(function (k) {
        if (cfg[k] !== undefined) s.bot[k] = cfg[k];
      });
      S.save();
      syncFromSettings();
    });
  }

  function selectTab(name) {
    if (!shadow) return;
    shadow.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    shadow.querySelectorAll(".pane").forEach(function (p) {
      p.classList.toggle("active", p.dataset.pane === name);
    });
    var s = S.get();
    if (s.panel.tab !== name) {
      s.panel.tab = name;
      S.save();
    }
  }

  function toggle(force, silent) {
    var open = force === undefined ? el.panel.classList.contains("hidden") : force;
    el.panel.classList.toggle("hidden", !open);
    el.fab.classList.toggle("on", open);
    if (open) requestAnimationFrame(function () { el.panel.classList.add("open"); });
    else el.panel.classList.remove("open");
    if (!silent) {
      var s = S.get();
      s.panel.open = open;
      S.save();
    }
  }

  function fmt(n) {
    if (n === undefined || n === null) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }

  function setState(snap) {
    if (!shadow) return;
    lastSnap = snap;

    var connected = snap && snap.attached;
    el.dot.className = "dot" + (connected ? " ok" : snap ? " wait" : "");
    el.sub.textContent = !connected
      ? "در انتظار بازی…"
      : snap.me
        ? snap.me.name +
          (snap.spawnPhase ? " — مرحله انتخاب نقطه" : "") +
          (snap.transport === "local" ? " · تک‌نفره" : snap.transport === "ws" ? " · آنلاین" : "")
        : "متصل — بازیکن پیدا نشد";

    var running = !!(snap && snap.bot && snap.bot.running);
    var btn = $("#botbtn");
    btn.textContent = running ? "■  توقف ربات" : "▶  شروع بازی خودکار";
    btn.classList.toggle("stop", running);
    btn.disabled = !connected;
    el.fab.classList.toggle("botting", running);

    var wrap = $("#statwrap");
    if (!snap || !snap.me) {
      if (!wrap.querySelector(".empty"))
        wrap.innerHTML = '<div class="empty">هنوز وارد بازی نشده‌ای</div>';
      return;
    }
    var m = snap.me;
    var pct = m.maxTroops > 0 ? Math.min(100, (m.troops / m.maxTroops) * 100) : 0;
    wrap.innerHTML =
      '<div class="grid">' +
      stat(fmt(m.gold), "طلا") +
      stat(fmt(m.troops), "نیرو") +
      stat(fmt(m.tiles), "سرزمین") +
      stat(m.cities, "شهر") +
      stat(m.ports, "بندر") +
      stat(m.factories, "کارخانه") +
      stat(m.silos, "سیلو") +
      stat(m.sams, "پدافند") +
      stat(m.warships, "ناو") +
      stat(m.incoming, "حمله ورودی") +
      stat(m.outgoing, "حمله خروجی") +
      stat(m.allies, "متحد") +
      "</div>" +
      '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="note" style="margin-top:6px">' +
      "ظرفیت نیرو: " + fmt(m.troops) + " از " + fmt(m.maxTroops) +
      (snap.bot ? " · اقدامات ربات: " + snap.bot.stats.actions : "") +
      "</div>";
  }

  function stat(v, k) {
    return '<div class="stat"><div class="v">' + v + '</div><div class="k">' + k + "</div></div>";
  }

  var logCount = 0;
  function pushLog(entry) {
    if (!shadow) return;
    var host = $("#log");
    var li = document.createElement("div");
    li.className = "li " + (entry.level || "info");
    var d = new Date(entry.t || Date.now());
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    li.innerHTML = "<i>" + hh + ":" + mm + ":" + ss + "</i>";
    li.appendChild(document.createTextNode(entry.text || ""));
    host.insertBefore(li, host.firstChild);
    if (++logCount > 120) {
      host.removeChild(host.lastChild);
      logCount--;
    }
  }

  function toast(text, kind, x, y) {
    if (!shadow) return;
    var t = document.createElement("div");
    t.className = "toast" + (kind ? " " + kind : "");
    t.textContent = text;
    // RTL: `right` is measured from the right edge of the viewport.
    t.style.right = window.innerWidth - x + "px";
    t.style.top = y + "px";
    el.wrap.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 950);
  }

  window.OBA_PANEL = {
    mount: mount,
    setState: setState,
    pushLog: pushLog,
    toast: toast,
    toggle: toggle,
    captureKey: captureKey,
    isListening: isListening,
    syncFromSettings: syncFromSettings,
    pullBotCfg: pullBotCfg,
  };
})();
