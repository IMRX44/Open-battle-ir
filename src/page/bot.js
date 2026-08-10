/*
 * OpenBattle Assistant — autonomous play engine.
 *
 * Runs in the page world next to the game and drives a full match: spawn
 * choice, land grab, economy, defence, navy, nukes and diplomacy.
 *
 * It reads the live `GameView` (the same object the renderer draws from) and
 * writes through the bridge's intent transport, so every action it takes is an
 * action a human could have taken through the UI — validated by the game's own
 * worker before it is sent.
 *
 * Subsystems run on independent tick budgets so a single game tick never does
 * more than one expensive thing.
 */
(function () {
  "use strict";

  var OBA = window.__OBA__;
  if (!OBA || OBA.Bot) return;

  var U = OBA.UnitType;
  var PT = OBA.PlayerType;

  /* ------------------------------------------------------------------ *
   * Tunables                                                            *
   * ------------------------------------------------------------------ */
  var DEFAULTS = {
    preset: "balanced",

    // Combat
    aggression: 0.6, //  0..1 — willingness to open fights
    attackThreshold: 1.35, //  troop ratio required before attacking a player
    attackRatio: 0.55, //  share of troops committed to a player attack
    expandRatio: 0.85, //  share of troops committed to neutral land
    reserve: 0.12, //  share of troops never committed
    maxConcurrentAttacks: 2,

    // Toggles
    autoSpawn: true,
    economy: true,
    defense: true,
    warships: true,
    nukes: true,
    boats: true,
    diplomacy: true,
    betray: false, //  break alliances of opportunity

    // Economy caps
    maxCities: 60,
    maxPorts: 12,
    maxFactories: 14,
    maxSilos: 4,
    maxSams: 8,
    maxDefensePosts: 14,
    maxWarships: 8,
  };

  var PRESETS = {
    balanced: {},
    aggressive: {
      aggression: 0.9,
      attackThreshold: 1.12,
      attackRatio: 0.7,
      expandRatio: 0.9,
      reserve: 0.06,
      maxConcurrentAttacks: 3,
      betray: false,
    },
    economic: {
      aggression: 0.35,
      attackThreshold: 1.75,
      attackRatio: 0.45,
      expandRatio: 0.8,
      reserve: 0.2,
      maxCities: 80,
      maxPorts: 16,
      maxFactories: 20,
      maxConcurrentAttacks: 1,
    },
    turtle: {
      aggression: 0.2,
      attackThreshold: 2.2,
      attackRatio: 0.4,
      expandRatio: 0.75,
      reserve: 0.3,
      maxDefensePosts: 24,
      maxSams: 12,
      maxConcurrentAttacks: 1,
    },
  };

  // Cadence, in game ticks (1 tick = 100 ms).
  var EVERY = {
    spawn: 8,
    territory: 25,
    expand: 10,
    attack: 12,
    economy: 18,
    defense: 45,
    navy: 40,
    boats: 50,
    nuke: 45,
    diplomacy: 55,
  };

  /* ------------------------------------------------------------------ *
   * Small helpers                                                       *
   * ------------------------------------------------------------------ */
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function num(v) {
    try {
      return Number(v);
    } catch (e) {
      return 0;
    }
  }

  function shuffle(arr, rnd) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0;
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // Deterministic-ish cheap RNG so candidate picking spreads out over time
  // without pulling in Math.random's clustering.
  function makeRng(seed) {
    var s = seed >>> 0 || 12345;
    return function () {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }

  /* ------------------------------------------------------------------ *
   * Bot                                                                 *
   * ------------------------------------------------------------------ */
  function Bot() {
    this.cfg = Object.assign({}, DEFAULTS);
    this.running = false;
    this.timer = null;
    this.rng = makeRng(Date.now() & 0xffff);

    this.lastTick = -1;
    this.next = {}; // subsystem -> next tick it may run
    this.busy = {}; // subsystem -> in-flight async guard

    this.territory = null; // { border, interior, shore, enemyEdge, bbox, at }
    this.spawnEvals = 0;
    this.spawnPicked = null;
    this.spawnScore = 0;
    this.allianceAsked = {}; // playerID -> tick
    this.stats = { actions: 0, builds: 0, attacks: 0, nukes: 0 };
  }

  Bot.prototype.setConfig = function (patch) {
    if (patch && patch.preset && PRESETS[patch.preset]) {
      this.cfg = Object.assign({}, DEFAULTS, PRESETS[patch.preset], patch);
    } else {
      this.cfg = Object.assign({}, this.cfg, patch || {});
    }
    return this.cfg;
  };

  Bot.prototype.start = function (patch) {
    if (patch) this.setConfig(patch);
    if (this.running) return;
    this.running = true;
    this.next = {};
    this.spawnEvals = 0;
    this.spawnPicked = null;
    this.spawnScore = 0;
    this.territory = null;
    var self = this;
    this.timer = setInterval(function () {
      try {
        self.step();
      } catch (e) {
        OBA.log("error", "bot step failed: " + (e && e.message ? e.message : e));
      }
    }, 100);
    OBA.log("good", "ربات فعال شد — " + this.cfg.preset);
  };

  Bot.prototype.stop = function () {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    OBA.log("info", "ربات متوقف شد");
  };

  Bot.prototype.due = function (key, tick) {
    if ((this.next[key] || 0) > tick) return false;
    this.next[key] = tick + EVERY[key];
    return true;
  };

  /* ---------------------------- main step --------------------------- */
  Bot.prototype.step = function () {
    if (!this.running) return;
    // The compatibility view fills in whatever this deployment's GameView is
    // missing, so a subsystem never dies on an absent helper.
    var g = OBA.view();
    if (!g) return;

    var tick;
    try {
      tick = g.ticks();
    } catch (e) {
      return;
    }
    if (tick === this.lastTick) return;
    this.lastTick = tick;

    var me = OBA.myPlayer();
    if (!me) return;

    // Spawn phase: nothing else matters until we are on the map.
    var inSpawn = false;
    try {
      inSpawn = g.inSpawnPhase();
    } catch (e) {}

    if (inSpawn || !me.hasSpawned()) {
      if (this.cfg.autoSpawn && this.due("spawn", tick)) this.doSpawn(g, me);
      return;
    }
    if (!me.isAlive()) return;

    if (this.due("territory", tick)) this.refreshTerritory(g, me);
    if (!this.territory) return;

    if (this.due("expand", tick)) this.doExpand(g, me);
    if (this.due("attack", tick)) this.doAttack(g, me);
    if (this.cfg.economy && this.due("economy", tick)) this.doEconomy(g, me);
    if (this.cfg.defense && this.due("defense", tick)) this.doDefense(g, me);
    if (this.cfg.warships && this.due("navy", tick)) this.doNavy(g, me);
    if (this.cfg.nukes && this.due("nuke", tick)) this.doNukes(g, me);
    if (this.cfg.boats && this.due("boats", tick)) this.doBoats(g, me);
    if (this.cfg.diplomacy && this.due("diplomacy", tick))
      this.doDiplomacy(g, me, tick);
  };

  /* ------------------------------------------------------------------ *
   * Spawn selection                                                     *
   *                                                                     *
   * A good opening tile has three properties, in this order: a large    *
   * body of unclaimed land within expansion range, ocean access (ports  *
   * are the strongest gold engine in the game), and distance from       *
   * whoever has already claimed ground.                                 *
   *                                                                     *
   * Scoring every tile against every other tile is far too slow on a    *
   * 2M-tile map, so the map is reduced to a coarse grid once, summed    *
   * areas give the neighbourhood totals in O(1) per cell, and a         *
   * multi-source BFS from claimed cells gives the distance field.       *
   * ------------------------------------------------------------------ */
  Bot.prototype.doSpawn = function (g, me) {
    if (this.spawnEvals >= 3) return;
    // First evaluation immediately; later ones once rivals have committed,
    // which is when the distance term actually carries information.
    if (this.spawnEvals > 0 && this.spawnPicked === null) return;

    var pick;
    try {
      pick = this.scoreSpawns(g, me);
    } catch (e) {
      OBA.log("error", "spawn scan failed: " + e);
      this.spawnEvals = 3;
      return;
    }
    this.spawnEvals++;
    if (!pick) return;

    // Only relocate if the new spot is meaningfully better.
    if (this.spawnPicked !== null && pick.score < this.spawnScore * 1.15) return;

    this.spawnPicked = pick.tile;
    this.spawnScore = pick.score;
    OBA.sendIntent({ type: "spawn", tile: pick.tile });
    this.stats.actions++;
    OBA.log(
      "good",
      "نقطه شروع انتخاب شد (" +
        g.x(pick.tile) +
        "," +
        g.y(pick.tile) +
        ")" +
        (pick.coastal ? " — ساحلی" : "") +
        " امتیاز " +
        Math.round(pick.score),
    );
  };

  Bot.prototype.scoreSpawns = function (g, me) {
    var w = g.width(),
      h = g.height();
    var C = 6; // coarse cell edge, in tiles
    var gw = Math.ceil(w / C),
      gh = Math.ceil(h / C);
    var n = gw * gh;

    var land = new Float32Array(n);
    var ocean = new Float32Array(n);
    var claimed = new Uint8Array(n);
    var freeTile = new Int32Array(n);
    var shoreTile = new Int32Array(n);
    freeTile.fill(-1);
    shoreTile.fill(-1);

    // Sample every other tile on very large maps — the coarse grid absorbs
    // the loss and it halves the scan.
    var step = w * h > 1200000 ? 2 : 1;

    for (var y = 0; y < h; y += step) {
      var row = ((y / C) | 0) * gw;
      for (var x = 0; x < w; x += step) {
        var t = g.ref(x, y);
        var ci = row + ((x / C) | 0);
        if (g.isLand(t)) {
          if (g.isImpassable(t)) continue;
          land[ci]++;
          if (g.hasOwner(t)) {
            claimed[ci] = 1;
            continue;
          }
          if (freeTile[ci] < 0) freeTile[ci] = t;
          if (shoreTile[ci] < 0 && g.isOceanShore(t)) shoreTile[ci] = t;
        } else if (g.isOcean(t)) {
          ocean[ci]++;
        }
      }
    }

    var sumLand = summedArea(land, gw, gh);
    var sumOcean = summedArea(ocean, gw, gh);

    // Distance (in coarse cells) to the nearest already-claimed cell.
    var dist = new Int32Array(n);
    dist.fill(-1);
    var queue = [];
    for (var i = 0; i < n; i++)
      if (claimed[i]) {
        dist[i] = 0;
        queue.push(i);
      }
    var qi = 0;
    while (qi < queue.length) {
      var ci2 = queue[qi++];
      var d = dist[ci2] + 1;
      if (d > 30) continue;
      var cx = ci2 % gw,
        cy = (ci2 / gw) | 0;
      if (cx > 0 && dist[ci2 - 1] === -1) {
        dist[ci2 - 1] = d;
        queue.push(ci2 - 1);
      }
      if (cx < gw - 1 && dist[ci2 + 1] === -1) {
        dist[ci2 + 1] = d;
        queue.push(ci2 + 1);
      }
      if (cy > 0 && dist[ci2 - gw] === -1) {
        dist[ci2 - gw] = d;
        queue.push(ci2 - gw);
      }
      if (cy < gh - 1 && dist[ci2 + gw] === -1) {
        dist[ci2 + gw] = d;
        queue.push(ci2 + gw);
      }
    }
    var noRivals = queue.length === 0;

    var NEAR = 5; // ~30 tiles — the land we can realistically take early
    var WIDE = 14; // ~84 tiles — is this a continent or a sandbar?
    var WET = 3; // ocean within ~18 tiles

    // Every term is normalised to 0..1 against the most it could possibly be,
    // then saturated. Raw counts would make the map's interior win every time
    // simply by having more land in frame — but past "enough room to expand"
    // extra land is worth far less than a coastline, and a coastline is what
    // pays for ports, trade income and amphibious reach.
    var per = (C / step) * (C / step); // sampled tiles per coarse cell
    var maxNear = (2 * NEAR + 1) * (2 * NEAR + 1) * per;
    var maxWide = (2 * WIDE + 1) * (2 * WIDE + 1) * per;
    var maxWet = (2 * WET + 1) * (2 * WET + 1) * per;

    var best = null;
    for (var ci3 = 0; ci3 < n; ci3++) {
      if (freeTile[ci3] < 0) continue;
      var gx = ci3 % gw,
        gy = (ci3 / gw) | 0;

      var nearLand = boxSum(sumLand, gw, gh, gx, gy, NEAR);
      var roomFrac = nearLand / maxNear;
      if (roomFrac < 0.05 && nearLand < 40) continue; // islet — no room to grow

      var wideLand = boxSum(sumLand, gw, gh, gx, gy, WIDE);
      var nearOcean = boxSum(sumOcean, gw, gh, gx, gy, WET);
      var coastal = shoreTile[ci3] >= 0;
      var d = noRivals ? -1 : dist[ci3];

      var room = Math.min(roomFrac, 0.55) / 0.55;
      var wide = Math.min(wideLand / maxWide, 0.45) / 0.45;
      var wet = Math.min(nearOcean / maxWet, 0.28) / 0.28;
      var away = noRivals ? 0.5 : Math.min(d < 0 ? 30 : d, 26) / 26;

      var score = room * 100 + wide * 45 + wet * 50 + (coastal ? 38 : 0) + away * 95;

      // Being jammed right up against a claimed cell is a losing opening.
      if (!noRivals && d >= 0 && d <= 2) score -= 160;

      if (!best || score > best.score) {
        best = {
          score: score,
          tile: coastal ? shoreTile[ci3] : freeTile[ci3],
          coastal: coastal,
        };
      }
    }
    return best;
  };

  function summedArea(src, gw, gh) {
    var out = new Float64Array((gw + 1) * (gh + 1));
    for (var y = 0; y < gh; y++) {
      var rowAcc = 0;
      for (var x = 0; x < gw; x++) {
        rowAcc += src[y * gw + x];
        out[(y + 1) * (gw + 1) + (x + 1)] = out[y * (gw + 1) + (x + 1)] + rowAcc;
      }
    }
    return out;
  }

  function boxSum(sat, gw, gh, cx, cy, r) {
    var x0 = clamp(cx - r, 0, gw),
      x1 = clamp(cx + r + 1, 0, gw);
    var y0 = clamp(cy - r, 0, gh),
      y1 = clamp(cy + r + 1, 0, gh);
    var W = gw + 1;
    return (
      sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0]
    );
  }

  /* ------------------------------------------------------------------ *
   * Territory cache                                                     *
   *                                                                     *
   * `borderTiles()` is an exact set from the worker; it also gives us a *
   * bounding box, which lets the interior/shore scan stay proportional  *
   * to the empire instead of to the map.                                *
   * ------------------------------------------------------------------ */
  Bot.prototype.refreshTerritory = function (g, me) {
    if (this.busy.territory) return;
    this.busy.territory = true;
    var self = this;

    var pending = null;
    try {
      if (typeof me.borderTiles === "function") pending = me.borderTiles();
    } catch (e) {
      pending = null;
    }

    // Older builds may not expose borderTiles; scanning for it ourselves is
    // slower but keeps every downstream subsystem alive.
    if (!pending || typeof pending.then !== "function") {
      try {
        self.analyzeTerritory(g, me, self.scanBorder(g, me));
      } catch (e) {
        OBA.log("error", "territory scan failed: " + e);
      }
      self.busy.territory = false;
      return;
    }

    pending
      .then(function (res) {
        var set = res && res.borderTiles ? res.borderTiles : null;
        if (!set) return;
        var border = [];
        set.forEach(function (t) {
          border.push(t);
        });
        self.analyzeTerritory(g, me, border);
      })
      .catch(function (e) {
        OBA.log("warn", "borderTiles failed: " + e);
      })
      .then(function () {
        self.busy.territory = false;
      });
  };

  /** Locate our own border tiles by sweeping the map, coarse to fine. */
  Bot.prototype.scanBorder = function (g, me) {
    var w = g.width(),
      h = g.height(),
      sid = me.smallID();
    var stride = Math.max(1, Math.round(Math.sqrt((w * h) / 40000)));
    for (var pass = 0; pass < 5; pass++) {
      var border = [];
      for (var y = 0; y < h; y += stride) {
        for (var x = 0; x < w; x += stride) {
          var t = g.ref(x, y);
          if (g.ownerID(t) !== sid) continue;
          if (g.isBorder(t)) border.push(t);
        }
      }
      if (border.length) return border;
      if (stride === 1) break;
      stride = Math.max(1, stride >> 1); // a small empire slips through a coarse net
    }
    return [];
  };

  Bot.prototype.analyzeTerritory = function (g, me, border) {
    if (!border || !border.length) return;
    var sid = me.smallID();
    var minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (var b = 0; b < border.length; b++) {
      var x0 = g.x(border[b]),
        y0 = g.y(border[b]);
      if (x0 < minX) minX = x0;
      if (x0 > maxX) maxX = x0;
      if (y0 < minY) minY = y0;
      if (y0 > maxY) maxY = y0;
    }

    // Who are we actually touching, and how much of our edge faces them?
    var neutralEdge = 0;
    var enemyEdge = Object.create(null);
    var enemyTile = Object.create(null);
    var sample = border.length > 20000 ? (border.length / 20000) | 0 : 1;
    for (var i = 0; i < border.length; i += sample) {
      var t = border[i];
      var nb = g.neighbors(t);
      for (var k = 0; k < nb.length; k++) {
        var nt = nb[k];
        if (!g.isLand(nt) || g.isImpassable(nt)) continue;
        var o = g.ownerID(nt);
        if (o === sid) continue;
        if (!g.hasOwner(nt)) {
          neutralEdge++;
        } else {
          enemyEdge[o] = (enemyEdge[o] || 0) + 1;
          if (enemyTile[o] === undefined) enemyTile[o] = t;
        }
      }
    }

    // Interior / shore candidates for construction.
    var bw = maxX - minX + 1,
      bh = maxY - minY + 1;
    var stride = Math.max(1, Math.round(Math.sqrt((bw * bh) / 24000)));
    var interior = [],
      shore = [];
    for (var y2 = minY; y2 <= maxY; y2 += stride) {
      for (var x2 = minX; x2 <= maxX; x2 += stride) {
        var tt = g.ref(x2, y2);
        if (g.ownerID(tt) !== sid) continue;
        if (g.isOceanShore(tt)) shore.push(tt);
        else if (!g.isBorder(tt)) interior.push(tt);
      }
    }
    // Tiny empires: the strided scan can miss everything, so fall back to
    // the border tiles themselves.
    if (!interior.length && !shore.length) {
      for (var j = 0; j < border.length; j++) {
        if (g.isOceanShore(border[j])) shore.push(border[j]);
        else interior.push(border[j]);
      }
    }

    this.territory = {
      at: Date.now(),
      border: border,
      interior: shuffle(interior, this.rng),
      shore: shuffle(shore, this.rng),
      neutralEdge: neutralEdge,
      enemyEdge: enemyEdge,
      enemyTile: enemyTile,
      bbox: [minX, minY, maxX, maxY],
    };
  };

  /* ------------------------------------------------------------------ *
   * Expansion into unclaimed land                                       *
   *                                                                     *
   * Neutral tiles cost a flat, tiny amount of troops, so as long as      *
   * there is free land on our border, taking it beats everything else:   *
   * tiles raise the troop ceiling, which compounds.                      *
   * ------------------------------------------------------------------ */
  Bot.prototype.doExpand = function (g, me) {
    var terr = this.territory;
    if (!terr || terr.neutralEdge <= 0) return;

    var troops = me.troops();
    var max = 1;
    try {
      max = g.config().maxTroops(me);
    } catch (e) {}
    if (troops < max * 0.18) return; // let the army rebuild

    // Don't pile a second wave on top of a healthy ongoing land grab.
    var out = me.outgoingAttacks() || [];
    for (var i = 0; i < out.length; i++) {
      var target = g.playerBySmallID(out[i].targetID);
      var isNeutral = !target || !target.isPlayer || !target.isPlayer();
      if (isNeutral && out[i].troops > troops * 0.12) return;
    }

    var send = Math.floor(troops * this.cfg.expandRatio);
    if (send < 1) return;
    OBA.sendIntent({ type: "attack", targetID: null, troops: send });
    this.stats.actions++;
    this.stats.attacks++;
  };

  /* ------------------------------------------------------------------ *
   * Attacking players                                                   *
   * ------------------------------------------------------------------ */
  Bot.prototype.doAttack = function (g, me) {
    var terr = this.territory;
    if (!terr) return;
    var cfg = this.cfg;
    var troops = me.troops();

    var out = me.outgoingAttacks() || [];
    var activeOnPlayers = 0;
    var attacking = Object.create(null);
    for (var i = 0; i < out.length; i++) {
      var tp = g.playerBySmallID(out[i].targetID);
      if (tp && tp.isPlayer && tp.isPlayer()) {
        activeOnPlayers++;
        attacking[out[i].targetID] = true;
      }
    }

    // Retaliation comes first: a live incoming attack is the cheapest kill in
    // the game, since the attacker's troops are already out of their stack.
    var inc = me.incomingAttacks() || [];
    if (inc.length) {
      var worst = null;
      for (var j = 0; j < inc.length; j++)
        if (!worst || inc[j].troops > worst.troops) worst = inc[j];
      if (worst && !attacking[worst.attackerID]) {
        var attacker = g.playerBySmallID(worst.attackerID);
        if (attacker && attacker.isPlayer && attacker.isPlayer()) {
          var counter = Math.floor(
            Math.min(worst.troops * 1.2, troops * cfg.attackRatio),
          );
          if (counter > 0) {
            OBA.sendIntent({
              type: "attack",
              targetID: attacker.id(),
              troops: counter,
            });
            this.stats.actions++;
            this.stats.attacks++;
            OBA.log("warn", "پاتک به " + safeName(attacker));
            return;
          }
        }
      }
    }

    if (activeOnPlayers >= cfg.maxConcurrentAttacks) return;
    // While there is still free land, prefer taking it over starting a war.
    if (terr.neutralEdge > 40 && cfg.aggression < 0.8) return;

    var best = null;
    for (var sidStr in terr.enemyEdge) {
      var sid = +sidStr;
      if (attacking[sid]) continue;
      var p = g.playerBySmallID(sid);
      if (!p || !p.isPlayer || !p.isPlayer() || !p.isAlive()) continue;

      var friendly = false;
      try {
        friendly = me.isFriendly(p) || p.isFriendly(me);
      } catch (e) {}
      if (friendly && !(cfg.betray && p.troops() * 2.5 < troops)) continue;

      var theirTroops = Math.max(1, p.troops());
      var ratio = troops / theirTroops;
      // Aggression relaxes the bar we require before committing.
      var bar = cfg.attackThreshold * (1 - cfg.aggression * 0.25);
      if (ratio < bar) continue;

      var edge = terr.enemyEdge[sid];
      var score =
        ratio * 2 +
        Math.min(edge, 400) * 0.02 +
        (p.type() === PT.Bot ? 1.5 : 0) +
        (p.isTraitor && p.isTraitor() ? 1.0 : 0) +
        Math.min(p.numTilesOwned(), 40000) * 0.00004;

      if (!best || score > best.score) best = { p: p, score: score };
    }
    if (!best) return;

    var send = Math.floor(troops * this.cfg.attackRatio);
    if (send < 1) return;
    OBA.sendIntent({ type: "attack", targetID: best.p.id(), troops: send });
    this.stats.actions++;
    this.stats.attacks++;
    OBA.log("info", "حمله به " + safeName(best.p));
  };

  function safeName(p) {
    try {
      return p.displayName ? p.displayName() : p.name();
    } catch (e) {
      return "?";
    }
  }

  /* ------------------------------------------------------------------ *
   * Economy                                                             *
   *                                                                     *
   * One build attempt per pass. The wanted list is ordered by marginal   *
   * value: ports (trade income) first while we have none, then cities    *
   * (troop ceiling), then more ports, then factories.                    *
   * ------------------------------------------------------------------ */
  Bot.prototype.doEconomy = function (g, me) {
    if (this.busy.economy) return;
    var terr = this.territory;
    if (!terr) return;

    var cfg = this.cfg;
    var tiles = me.numTilesOwned();
    var gold = num(me.gold());

    var cities = liveCount(me, U.City);
    var ports = liveCount(me, U.Port);
    var factories = liveCount(me, U.Factory);
    var silos = liveCount(me, U.MissileSilo);

    var hasShore = terr.shore.length > 0;
    var cityTarget = clamp(2 + Math.floor(tiles / 700), 2, cfg.maxCities);
    var portTarget = hasShore
      ? clamp(1 + Math.floor(tiles / 1600), 1, cfg.maxPorts)
      : 0;
    var factoryTarget = clamp(Math.floor(tiles / 1500), 0, cfg.maxFactories);
    var siloTarget = cfg.nukes
      ? clamp(Math.floor(tiles / 4000), tiles > 2500 ? 1 : 0, cfg.maxSilos)
      : 0;

    // Keep a war chest once nukes are a real option.
    var reserve = cfg.nukes && silos > 0 && tiles > 2500 ? 900000 : 0;
    var spendable = gold - reserve;

    var want = [];
    if (ports < Math.min(2, portTarget)) want.push([U.Port, terr.shore]);
    if (cities < cityTarget) want.push([U.City, terr.interior]);
    if (ports < portTarget) want.push([U.Port, terr.shore]);
    if (factories < factoryTarget) want.push([U.Factory, terr.interior]);
    if (silos < siloTarget) want.push([U.MissileSilo, terr.interior]);
    // Everything capped and gold still piling up — pour it into upgrades.
    if (!want.length || gold > 4000000)
      want.push([U.City, terr.interior], [U.Port, terr.shore]);

    if (!want.length) return;
    var choice = want[0];
    this.tryBuild(g, me, choice[0], choice[1], spendable, "economy");
  };

  function liveCount(player, type) {
    try {
      return player.units(type).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Try up to 4 candidate tiles for `type`. The game's worker answers both
   * "may I build here" and "what does it cost", so we never guess.
   */
  Bot.prototype.tryBuild = function (g, me, type, pool, budget, tag, onDone) {
    if (!pool || !pool.length) {
      if (onDone) onDone(false);
      return;
    }
    if (this.busy[tag]) return;
    this.busy[tag] = true;

    var self = this;
    var tried = 0;
    var MAX_TRIES = 4;

    function attempt() {
      if (tried >= MAX_TRIES || !pool.length) return finish(false);
      tried++;
      var tile = pool[(self.rng() * pool.length) | 0];
      return me
        .actions(tile, [type])
        .then(function (actions) {
          // The worker round-trip can outlive a stop request.
          if (!self.running) return finish(false);
          var list = (actions && actions.buildableUnits) || [];
          var bu = null;
          for (var i = 0; i < list.length; i++)
            if (list[i].type === type) bu = list[i];
          if (!bu) return finish(false);

          var cost = num(bu.cost);
          if (bu.canBuild !== false) {
            if (cost > budget) return finish(false); // cannot afford it yet
            OBA.sendIntent({
              type: "build_unit",
              unit: type,
              tile: bu.canBuild,
            });
            self.stats.actions++;
            self.stats.builds++;
            OBA.log("good", "ساخت " + type);
            return finish(true);
          }
          if (bu.canUpgrade !== false) {
            var upCost =
              bu.upgradeCosts && bu.upgradeCosts.length
                ? num(bu.upgradeCosts[0])
                : cost;
            if (upCost <= budget) {
              OBA.sendIntent({
                type: "upgrade_structure",
                unit: type,
                unitId: bu.canUpgrade,
                amount: 1,
              });
              self.stats.actions++;
              self.stats.builds++;
              OBA.log("good", "ارتقای " + type);
              return finish(true);
            }
          }
          return attempt();
        })
        .catch(function () {
          return finish(false);
        });
    }

    function finish(ok) {
      self.busy[tag] = false;
      if (onDone) onDone(ok);
      return ok;
    }

    attempt();
  };

  /* ------------------------------------------------------------------ *
   * Defence                                                             *
   * ------------------------------------------------------------------ */
  Bot.prototype.doDefense = function (g, me) {
    var terr = this.territory;
    if (!terr) return;
    var cfg = this.cfg;
    var gold = num(me.gold());

    var posts = liveCount(me, U.DefensePost);
    var sams = liveCount(me, U.SAMLauncher);

    // How much of our border faces someone we are not friendly with?
    var hot = 0;
    var hotTiles = [];
    for (var sidStr in terr.enemyEdge) {
      var p = g.playerBySmallID(+sidStr);
      if (!p || !p.isPlayer || !p.isPlayer()) continue;
      var friendly = false;
      try {
        friendly = me.isFriendly(p);
      } catch (e) {}
      if (friendly) continue;
      hot += terr.enemyEdge[sidStr];
      if (terr.enemyTile[sidStr] !== undefined)
        hotTiles.push(terr.enemyTile[sidStr]);
    }

    var postTarget = clamp(Math.floor(hot / 70), 0, cfg.maxDefensePosts);
    if (posts < postTarget && hotTiles.length) {
      // Defence posts belong on the contested edge, not in the interior.
      var pool = hotTiles.concat(terr.border.slice(0, 400));
      this.tryBuild(g, me, U.DefensePost, pool, gold, "defense");
      return;
    }

    // SAMs only pay for themselves once someone can actually shoot at us.
    var enemyHasNukes = false;
    try {
      var silos = g.units(U.MissileSilo);
      for (var i = 0; i < silos.length; i++) {
        var o = silos[i].owner();
        if (o && o.smallID() !== me.smallID() && !me.isFriendly(o)) {
          enemyHasNukes = true;
          break;
        }
      }
    } catch (e) {}
    var samTarget = enemyHasNukes
      ? clamp(1 + Math.floor(me.numTilesOwned() / 4500), 1, cfg.maxSams)
      : 0;
    if (sams < samTarget) {
      this.tryBuild(g, me, U.SAMLauncher, terr.interior, gold, "defense");
    }
  };

  /* ------------------------------------------------------------------ *
   * Navy                                                                *
   * ------------------------------------------------------------------ */
  Bot.prototype.doNavy = function (g, me) {
    var terr = this.territory;
    if (!terr || !terr.shore.length) return;
    var cfg = this.cfg;
    var gold = num(me.gold());

    var ports = liveCount(me, U.Port);
    if (ports < 1) return;
    var ships = liveCount(me, U.Warship);
    var target = clamp(Math.ceil(ports * 1.5), 1, cfg.maxWarships);
    if (ships >= target) return;
    if (gold < 400000) return;

    // Warships spawn on water; collect ocean tiles just off our own coast.
    var pool = [];
    for (var i = 0; i < terr.shore.length && pool.length < 40; i++) {
      var nb = g.neighbors(terr.shore[i]);
      for (var k = 0; k < nb.length; k++)
        if (g.isOcean(nb[k])) {
          pool.push(nb[k]);
          break;
        }
    }
    if (!pool.length) return;
    this.tryBuild(g, me, U.Warship, pool, gold, "navy");
  };

  /* ------------------------------------------------------------------ *
   * Amphibious expansion                                                *
   *                                                                     *
   * Only relevant when we are boxed in — an island start, or every land  *
   * border already closed off by an ally.                                *
   * ------------------------------------------------------------------ */
  Bot.prototype.doBoats = function (g, me) {
    if (this.busy.boats) return;
    var terr = this.territory;
    if (!terr || !terr.shore.length) return;
    if (terr.neutralEdge > 12) return; // still room on foot

    var troops = me.troops();
    var max = 1;
    try {
      max = g.config().maxTroops(me);
    } catch (e) {}
    if (troops < max * 0.45) return;

    var sid = me.smallID();
    var w = g.width(),
      h = g.height();
    var origin = terr.shore[(this.rng() * terr.shore.length) | 0];
    var ox = g.x(origin),
      oy = g.y(origin);

    // Ring search outward from our coast for a landing site: unclaimed coast
    // first, hostile coast second.
    var best = null;
    for (var r = 12; r <= 160 && !best; r += 8) {
      for (var a = 0; a < 24; a++) {
        var ang = (a / 24) * Math.PI * 2;
        var x = Math.round(ox + Math.cos(ang) * r);
        var y = Math.round(oy + Math.sin(ang) * r);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        var t = g.ref(x, y);
        if (!g.isLand(t) || g.isImpassable(t)) continue;
        if (!g.isOceanShore(t)) continue;
        var owner = g.ownerID(t);
        if (owner === sid) continue;
        if (g.hasOwner(t)) {
          var p = g.playerBySmallID(owner);
          if (!p || !p.isPlayer || !p.isPlayer()) continue;
          var friendly = false;
          try {
            friendly = me.isFriendly(p);
          } catch (e) {}
          if (friendly) continue;
          if (p.troops() > troops * 0.8) continue; // not worth a beachhead
        }
        best = t;
        break;
      }
    }
    if (best === null) return;

    this.busy.boats = true;
    var self = this;
    me.bestTransportShipSpawn(best)
      .then(function (spawn) {
        if (!self.running) return;
        if (spawn === false || spawn === undefined || spawn === null) return;
        var send = Math.floor(troops * 0.22);
        if (send < 1) return;
        OBA.sendIntent({ type: "boat", troops: send, dst: best });
        self.stats.actions++;
        OBA.log("info", "حمله دریایی");
      })
      .catch(function () {})
      .then(function () {
        self.busy.boats = false;
      });
  };

  /* ------------------------------------------------------------------ *
   * Nukes                                                               *
   *                                                                     *
   * Warheads are only worth their price on a dense cluster of enemy      *
   * infrastructure, so we pick the tile with the most hostile structures *
   * around it and let the worker confirm the shot is legal.              *
   * ------------------------------------------------------------------ */
  Bot.prototype.doNukes = function (g, me) {
    if (this.busy.nuke) return;
    var gold = num(me.gold());
    if (gold < 900000) return;
    if (liveCount(me, U.MissileSilo) < 1) return;

    var sid = me.smallID();
    var structures;
    try {
      structures = g.units(
        U.City,
        U.Port,
        U.Factory,
        U.MissileSilo,
        U.SAMLauncher,
        U.DefensePost,
      );
    } catch (e) {
      return;
    }

    var hostile = [];
    for (var i = 0; i < structures.length; i++) {
      var u = structures[i];
      var o;
      try {
        o = u.owner();
      } catch (e) {
        continue;
      }
      if (!o || o.smallID() === sid) continue;
      var friendly = false;
      try {
        friendly = me.isFriendly(o);
      } catch (e) {}
      if (friendly) continue;
      hostile.push(u);
    }
    if (hostile.length < 3) return;

    // Cluster count within the blast footprint (~25 tiles).
    var R2 = 25 * 25;
    var best = null;
    var limit = Math.min(hostile.length, 220);
    for (var a = 0; a < limit; a++) {
      var ta = hostile[a].tile();
      var count = 0;
      for (var b = 0; b < limit; b++) {
        if (g.euclideanDistSquared(ta, hostile[b].tile()) <= R2) count++;
      }
      if (!best || count > best.count) best = { tile: ta, count: count };
    }
    if (!best || best.count < 3) return;

    var wanted = gold > 6000000 && best.count >= 6 ? U.HydrogenBomb : U.AtomBomb;
    var self = this;
    this.busy.nuke = true;
    me.actions(best.tile, [wanted])
      .then(function (actions) {
        if (!self.running) return;
        var list = (actions && actions.buildableUnits) || [];
        for (var i = 0; i < list.length; i++) {
          var bu = list[i];
          if (bu.type !== wanted) continue;
          if (bu.canBuild === false) return;
          if (num(bu.cost) > gold) return;
          OBA.sendIntent({
            type: "build_unit",
            unit: wanted,
            tile: bu.canBuild,
            rocketDirectionUp: true,
          });
          self.stats.actions++;
          self.stats.nukes++;
          OBA.log("good", "شلیک " + wanted + " روی " + best.count + " سازه");
          return;
        }
      })
      .catch(function () {})
      .then(function () {
        self.busy.nuke = false;
      });
  };

  /* ------------------------------------------------------------------ *
   * Diplomacy                                                           *
   *                                                                     *
   * Sending an alliance request to somebody who already asked us counts  *
   * as accepting theirs, so one intent covers both cases.                *
   * ------------------------------------------------------------------ */
  Bot.prototype.doDiplomacy = function (g, me, tick) {
    var cfg = this.cfg;
    var players;
    try {
      players = g.players();
    } catch (e) {
      return;
    }
    var troops = me.troops();
    var terr = this.territory;

    var pending = null;
    var proactive = null;

    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (!p || p.smallID() === me.smallID() || !p.isAlive()) continue;
      var friendly = false;
      try {
        friendly = me.isFriendly(p);
      } catch (e) {}
      if (friendly) continue;

      var asked = this.allianceAsked[p.id()];
      if (asked !== undefined && tick - asked < 300) continue;

      // They asked us — accepting costs nothing and removes a front.
      var theyWant = false;
      try {
        theyWant = p.isRequestingAllianceWith(me);
      } catch (e) {}
      if (theyWant) {
        // Unless we are already mid-invasion of them.
        var busyWith = false;
        var out = me.outgoingAttacks() || [];
        for (var k = 0; k < out.length; k++)
          if (out[k].targetID === p.smallID()) busyWith = true;
        if (!busyWith && !pending) pending = p;
        continue;
      }

      // Nobody worth courting unless they border us and outgun us.
      if (!terr || !terr.enemyEdge[p.smallID()]) continue;
      if (p.troops() > troops * 1.5 && !proactive) proactive = p;
    }

    var target = pending || proactive;
    if (!target) return;
    this.allianceAsked[target.id()] = tick;
    OBA.sendIntent({ type: "allianceRequest", recipient: target.id() });
    this.stats.actions++;
    OBA.log(
      "info",
      (pending ? "پذیرش اتحاد با " : "درخواست اتحاد از ") + safeName(target),
    );
  };

  /* ------------------------------------------------------------------ */
  OBA.Bot = new Bot();
  OBA.BotPresets = Object.keys(PRESETS);
  OBA.BotDefaults = DEFAULTS;
})();
