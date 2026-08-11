/*
 * OpenBattle Assistant — the god-mode planner.
 *
 * The other presets are a chain of "if it is time to build, build one thing;
 * if it is time to attack, attack" — which is why they only ever do one thing
 * at a time. This is a utility agent instead.
 *
 * Every cycle it takes one reading of the position, generates every action it
 * could take right now, prices each one, scores each one against the only
 * thing that actually wins the game (territory, and the ability to take and
 * hold more of it), and then spends down two independent budgets — gold and
 * troops — buying the best value first until neither can afford anything
 * more. Building a city, upgrading a SAM, launching four warheads and opening
 * an invasion all happen in the same tick if the numbers say they should.
 *
 * Scores are expressed on a common 0..150 scale of "how much closer does this
 * get us to owning 80% of the map", then divided by cost to rank. The weights
 * encode the doctrine; the costs and the legality come from the game itself.
 */
(function () {
  "use strict";

  var OBA = window.__OBA__;
  if (!OBA || !OBA.Bot || OBA.Bot.__planner) return;

  var Bot = OBA.Bot.constructor.prototype;
  var U = OBA.UnitType;
  var PT = OBA.PlayerType;

  // One actions() call answers for every type at once, so a handful of
  // candidate tiles gives the planner the whole board of options.
  var SURVEY_TYPES = [
    U.City,
    U.Port,
    U.Factory,
    U.DefensePost,
    U.MissileSilo,
    U.SAMLauncher,
  ];

  // The game's own hardest nations upgrade silos to level 5. A silo's level is
  // how many missiles it can have in the air at once, so that is also the
  // ceiling on how fast a player can throw warheads.
  var SILO_TARGET_LEVEL = 5;
  var SAM_TARGET_LEVEL = 4;

  function num(v) {
    try {
      return Number(v);
    } catch (e) {
      return 0;
    }
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function safeName(p) {
    try {
      return p.displayName ? p.displayName() : p.name();
    } catch (e) {
      return "?";
    }
  }

  /* ------------------------------------------------------------------ *
   * Reading the wider position                                          *
   * ------------------------------------------------------------------ */

  /**
   * Everything the planner needs that is not already in `assess`: how close
   * anyone is to the win threshold, who is collapsing, and how badly we are
   * about to be nuked.
   */
  Bot.survey = function (g, me) {
    var sit = this.sit;
    var players = [];
    try {
      players = g.players() || [];
    } catch (e) {}

    var totalLand = 1;
    try {
      totalLand = g.numLandTiles ? g.numLandTiles() || 1 : 1;
    } catch (e) {}

    var mySid = me.smallID();
    var myTiles = me.numTilesOwned();
    var leader = null;
    var leaderTiles = 0;
    var enemySilos = 0;
    var enemySams = 0;
    var collapsing = {};
    var alliesInTrouble = [];

    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (!p || !p.isAlive || !p.isAlive()) continue;
      var sid = p.smallID();
      if (sid === mySid) continue;

      var tiles = p.numTilesOwned();
      if (tiles > leaderTiles) {
        leaderTiles = tiles;
        leader = p;
      }

      var friendly = false;
      try {
        friendly = me.isFriendly(p);
      } catch (e) {}

      // A player whose incoming attacks outweigh their standing army is being
      // taken apart. Their troops are already spoken for, so their ground is
      // the cheapest on the board — and if we do not take it, whoever is
      // already eating them will.
      var inc = 0;
      try {
        var ia = p.incomingAttacks() || [];
        for (var k = 0; k < ia.length; k++) inc += ia[k].troops || 0;
      } catch (e) {}
      var doomed = inc > Math.max(1, p.troops()) * 0.5;
      if (doomed) {
        collapsing[sid] = true;
        if (friendly) alliesInTrouble.push(p);
      }

      if (!friendly) {
        try {
          enemySilos += p.units(U.MissileSilo).length;
          enemySams += p.units(U.SAMLauncher).length;
        } catch (e) {}
      }
    }

    var myShare = myTiles / totalLand;
    var winAt = 0.8; // percentageTilesOwnedToWin, minus team modes
    var leaderShare = leaderTiles / totalLand;

    this.world = {
      totalLand: totalLand,
      myShare: myShare,
      winAt: winAt,
      // 0 at the start, 1 when we are on the threshold.
      progress: clamp(myShare / winAt, 0, 1),
      leader: leader,
      leaderShare: leaderShare,
      // Somebody else is running away with it.
      leaderIsThreat: !!leader && leaderShare > myShare * 1.15 && leaderShare > 0.12,
      enemySilos: enemySilos,
      enemySams: enemySams,
      // How much we should fear a warhead landing on our infrastructure.
      nukeThreat: clamp(enemySilos / 3, 0, 1),
      collapsing: collapsing,
      alliesInTrouble: alliesInTrouble,
      sit: sit,
    };
    return this.world;
  };

  /* ------------------------------------------------------------------ *
   * Proposing gold actions                                              *
   * ------------------------------------------------------------------ */

  /**
   * Surveys a handful of well-chosen tiles in parallel and turns the result
   * into priced, scored options. One round-trip per tile covers every
   * structure type and every available upgrade at that tile.
   */
  Bot.planEconomy = function (g, me) {
    if (this.busy.plan) return;
    var terr = this.territory;
    if (!terr) return;

    var self = this;
    var world = this.world;
    if (!world) return;

    var safe = this.rankSafe(g, terr.interior, 4);
    var spread = this.rankSpread(g, terr.shore, this.unitTiles(me, U.Port), 3);
    var choke = this.rankChoke(
      g,
      (terr.hostile && terr.hostile.length ? terr.hostile : []).concat(
        terr.border.slice(0, 200),
      ),
      3,
    );
    // Existing structures are surveyed too — that is where upgrades live, and
    // an upgraded SAM or silo is usually better value than a new one.
    var owned = this.unitTiles(me, U.SAMLauncher)
      .concat(this.unitTiles(me, U.MissileSilo))
      .concat(this.unitTiles(me, U.City).slice(0, 3))
      .concat(this.unitTiles(me, U.Port).slice(0, 2));

    var tiles = [];
    function add(list) {
      for (var i = 0; i < list.length; i++)
        if (list[i] !== undefined && tiles.indexOf(list[i]) === -1)
          tiles.push(list[i]);
    }
    add(safe);
    add(spread);
    add(choke);
    add(owned);
    if (!tiles.length) return;
    tiles = tiles.slice(0, 14);

    this.busy.plan = true;
    var queries = [];
    for (var i = 0; i < tiles.length; i++) {
      queries.push(
        (function (tile) {
          return me
            .actions(tile, SURVEY_TYPES)
            .then(function (a) {
              return { tile: tile, actions: a };
            })
            .catch(function () {
              return null;
            });
        })(tiles[i]),
      );
    }

    Promise.all(queries)
      .then(function (results) {
        if (!self.running) return;
        self.spendGold(g, me, results);
      })
      .catch(function (e) {
        OBA.log("error", "plan failed: " + e);
      })
      .then(function () {
        self.busy.plan = false;
      });
  };

  /**
   * The gold knapsack. Options are ranked by score per unit of cost, so a
   * 50,000 defence post that seals a front outranks a 1,000,000 city we do
   * not need yet, and gold stops being dribbled away on whatever happened to
   * come up first.
   */
  Bot.spendGold = function (g, me, results) {
    var world = this.world;
    var terr = this.territory;
    var cfg = this.cfg;
    var gold = num(me.gold());
    var tiles = me.numTilesOwned();

    var have = {
      city: this.liveCount(me, U.City),
      port: this.liveCount(me, U.Port),
      factory: this.liveCount(me, U.Factory),
      post: this.liveCount(me, U.DefensePost),
      silo: this.liveCount(me, U.MissileSilo),
      sam: this.liveCount(me, U.SAMLauncher),
    };

    var hasShore = terr.shore.length > 0;
    var threat = clamp((terr.hostile ? terr.hostile.length : 0) / 60, 0, 1);
    var nukeThreat = world.nukeThreat;

    // Wants, expressed as 0..1 "how much do we still need one of these".
    var want = {
      city: clamp((2 + tiles / 700 - have.city) / 6, 0, 1),
      port: hasShore ? clamp((1 + tiles / 1600 - have.port) / 4, 0, 1) : 0,
      factory: clamp((tiles / 1500 - have.factory) / 4, 0, 1),
      post: clamp(threat * 3 - have.post / 8, 0, 1),
      // Warheads are how a stalled game gets unstuck, and the only answer to
      // an opponent who has already built a wall of defence posts.
      silo: cfg.nukes ? clamp((1 + tiles / 4000 - have.silo) / 3, 0, 1) : 0,
      sam: clamp(nukeThreat * 2 - have.sam / 6, 0, 1),
    };

    var options = [];

    for (var r = 0; r < results.length; r++) {
      var res = results[r];
      if (!res || !res.actions) continue;
      var list = res.actions.buildableUnits || [];
      for (var i = 0; i < list.length; i++) {
        var bu = list[i];
        // Wanting no more of something is precisely when deepening what we
        // already have becomes the best use of gold, so the two paths are
        // scored independently.
        var base = this.baseValue(bu.type, want, world);
        if (base > 0 && bu.canBuild !== false) {
          options.push({
            kind: "build",
            type: bu.type,
            tile: bu.canBuild,
            cost: num(bu.cost),
            score: base,
          });
        }
        if (bu.canUpgrade !== false) {
          var upCost =
            bu.upgradeCosts && bu.upgradeCosts.length
              ? num(bu.upgradeCosts[0])
              : num(bu.cost);
          var upScore = this.upgradeValue(bu.type, want, world, me);
          if (upScore > 0)
            options.push({
              kind: "upgrade",
              type: bu.type,
              unitId: bu.canUpgrade,
              cost: upCost,
              score: upScore,
            });
        }
      }
    }
    if (!options.length) return;

    // Value density. Costs are divided by 250k so the numbers stay legible.
    options.sort(function (a, b) {
      return (
        b.score / Math.max(0.2, b.cost / 250000) -
        a.score / Math.max(0.2, a.cost / 250000)
      );
    });

    // Keep enough back to keep the missiles flying once silos exist; an idle
    // silo is a million gold doing nothing.
    var reserve = have.silo > 0 && cfg.nukes ? 800000 * Math.min(have.silo, 3) : 0;
    var purse = gold - reserve;

    var bought = 0;
    var seen = {};
    for (var o = 0; o < options.length && bought < 4; o++) {
      var opt = options[o];
      if (opt.cost > purse) continue;
      // One of each type per cycle: the cost curve doubles as we buy, so the
      // second one this tick would be priced from stale numbers.
      var key = opt.kind + ":" + opt.type;
      if (seen[key]) continue;
      seen[key] = true;

      if (opt.kind === "build") {
        OBA.sendIntent({
          type: "build_unit",
          unit: opt.type,
          tile: opt.tile,
        });
        OBA.log("good", "ساخت " + opt.type);
      } else {
        OBA.sendIntent({
          type: "upgrade_structure",
          unit: opt.type,
          unitId: opt.unitId,
          amount: 1,
        });
        OBA.log("good", "ارتقای " + opt.type);
      }
      purse -= opt.cost;
      bought++;
      this.stats.actions++;
      this.stats.builds++;
    }
  };

  /** What a new structure of this type is worth right now. */
  Bot.baseValue = function (type, want, world) {
    switch (type) {
      case U.City:
        // +250,000 troop cap per level, and the cost stops doubling at a
        // million. Nothing else converts gold into army this efficiently.
        return 95 * want.city;
      case U.Port:
        // Trade income dominates the mid game, and it compounds into
        // everything else.
        return 100 * want.port;
      case U.Factory:
        return 55 * want.factory;
      case U.DefensePost:
        // x5 defence over a 30-tile radius, capped at 250k. The cheapest
        // territory insurance in the game.
        return 125 * want.post;
      case U.MissileSilo:
        return 85 * want.silo;
      case U.SAMLauncher:
        return 115 * want.sam;
      default:
        return 0;
    }
  };

  /**
   * What upgrading an existing one is worth.
   *
   * Silo level is how many warheads it can have in the air simultaneously,
   * and SAM level is interception range (70 tiles at level 1, 118 at level
   * 10). Against an opponent who answers a defence line with fifty warheads,
   * both of those matter more than another building.
   */
  Bot.upgradeValue = function (type, want, world, me) {
    switch (type) {
      case U.MissileSilo:
        return this.avgLevel(me, U.MissileSilo) < SILO_TARGET_LEVEL ? 105 : 25;
      case U.SAMLauncher:
        return (
          (this.avgLevel(me, U.SAMLauncher) < SAM_TARGET_LEVEL ? 120 : 40) *
          Math.max(0.35, world.nukeThreat)
        );
      case U.City:
        return 80 * Math.max(want.city, 0.4);
      case U.Port:
        return 70 * Math.max(want.port, 0.3);
      case U.Factory:
        return 45 * Math.max(want.factory, 0.2);
      default:
        return 0;
    }
  };

  Bot.avgLevel = function (me, type) {
    try {
      var us = me.units(type);
      if (!us.length) return 0;
      var sum = 0;
      for (var i = 0; i < us.length; i++)
        sum += us[i].level ? us[i].level() : 1;
      return sum / us.length;
    } catch (e) {
      return 0;
    }
  };

  Bot.liveCount = function (me, type) {
    try {
      return me.units(type).length;
    } catch (e) {
      return 0;
    }
  };

  /* ------------------------------------------------------------------ *
   * Warheads                                                            *
   * ------------------------------------------------------------------ */

  /**
   * Fires one warhead per free silo slot, every cycle.
   *
   * A silo of level N holds N missiles, each reloading 90 ticks after launch,
   * so a player with four level-five silos can keep twenty in the air. That
   * is the scale real games are decided at, and firing one every forty ticks
   * — which is what the old code did — is not playing the same game.
   */
  Bot.planNukes = function (g, me) {
    if (this.busy.nuke) return;
    var cfg = this.cfg;
    if (!cfg.nukes) return;
    var world = this.world;
    if (!world) return;

    var silos = [];
    try {
      silos = me.units(U.MissileSilo);
    } catch (e) {
      return;
    }
    var slots = 0;
    for (var i = 0; i < silos.length; i++) {
      var s = silos[i];
      try {
        if (s.isUnderConstruction && s.isUnderConstruction()) continue;
        var lvl = s.level ? s.level() : 1;
        var queued = s.missileTimerQueue ? s.missileTimerQueue().length : 0;
        slots += Math.max(0, lvl - queued);
      } catch (e) {
        slots += 1;
      }
    }
    if (slots < 1) return;

    var gold = num(me.gold());
    if (gold < 800000) return;

    var clusters = this.nukeTargets(g, me);
    if (!clusters.length) return;

    // Never fire more than the gold covers, and leave the economy alive.
    var affordable = Math.floor(gold / 800000);
    var salvo = Math.min(slots, affordable, 6);
    if (salvo < 1) return;

    // Expand each cluster by how many warheads it needs to actually land.
    var picks = [];
    for (var c = 0; c < clusters.length && picks.length < salvo; c++) {
      var need = clusters[c].need || 1;
      for (var k = 0; k < need && picks.length < salvo; k++)
        picks.push(clusters[c]);
    }
    if (!picks.length) return;

    var self = this;
    this.busy.nuke = true;
    var wanted = gold > 12000000 ? U.HydrogenBomb : U.AtomBomb;

    Promise.all(
      picks.map(function (c) {
        return me
          .actions(c.tile, [wanted])
          .then(function (a) {
            return { c: c, a: a };
          })
          .catch(function () {
            return null;
          });
      }),
    )
      .then(function (rs) {
        if (!self.running) return;
        var purse = num(me.gold());
        var fired = 0;
        for (var i = 0; i < rs.length; i++) {
          if (!rs[i] || !rs[i].a) continue;
          var list = rs[i].a.buildableUnits || [];
          for (var k = 0; k < list.length; k++) {
            var bu = list[k];
            if (bu.type !== wanted || bu.canBuild === false) continue;
            var cost = num(bu.cost);
            if (cost > purse) break;
            OBA.sendIntent({
              type: "build_unit",
              unit: wanted,
              tile: bu.canBuild,
              rocketDirectionUp: true,
            });
            purse -= cost;
            fired++;
            self.stats.actions++;
            self.stats.nukes++;
          }
        }
        if (fired)
          OBA.log("good", "شلیک " + fired + " موشک " + wanted);
      })
      .catch(function () {})
      .then(function () {
        self.busy.nuke = false;
      });
  };

  /**
   * Ranks enemy structure clusters.
   *
   * Density first — a warhead that takes out six buildings is worth six times
   * one that takes out a single outpost. Clusters sitting under an enemy SAM
   * are not skipped but demoted: a launcher engages one missile at a time and
   * then reloads for ninety ticks, so a salvo gets through where a single
   * shot would not.
   */
  Bot.nukeTargets = function (g, me) {
    var mySid = me.smallID();
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
      return [];
    }

    var hostile = [];
    var enemySams = [];
    for (var i = 0; i < structures.length; i++) {
      var u = structures[i];
      var o;
      try {
        o = u.owner();
      } catch (e) {
        continue;
      }
      if (!o || o.smallID() === mySid) continue;
      var friendly = false;
      try {
        friendly = me.isFriendly(o);
      } catch (e) {}
      if (friendly) continue;
      hostile.push(u);
      if (u.type() === U.SAMLauncher) enemySams.push(u);
    }
    if (hostile.length < 2) return [];

    var world = this.world;
    var R2 = 25 * 25;
    var limit = Math.min(hostile.length, 240);
    var scored = [];
    for (var a = 0; a < limit; a++) {
      var ta = hostile[a].tile();
      var count = 0;
      for (var b = 0; b < limit; b++)
        if (g.euclideanDistSquared(ta, hostile[b].tile()) <= R2) count++;
      if (count < 2) continue;

      // Sitting under a launcher makes the shot less likely to land, not
      // worthless — and knocking the launcher out opens everything behind it.
      var covered = false;
      for (var s = 0; s < enemySams.length; s++) {
        var range = 70 + 12 * ((enemySams[s].level ? enemySams[s].level() : 1) - 1);
        if (g.euclideanDistSquared(ta, enemySams[s].tile()) <= range * range) {
          covered = true;
          break;
        }
      }

      // Whoever is closest to winning is the one worth setting back.
      var owner = null;
      try {
        owner = hostile[a].owner();
      } catch (e) {}
      var leaderBonus =
        world && world.leader && owner && owner.smallID() === world.leader.smallID()
          ? 4
          : 0;

      scored.push({
        tile: ta,
        count: count,
        covered: covered,
        // A launcher engages one missile at a time and then reloads for
        // ninety ticks. One warhead into that is a wasted warhead; three
        // arriving together are not — which is why real games are decided by
        // salvos rather than single shots.
        need: covered ? 3 : 1,
        score: count + leaderBonus - (covered ? 2.5 : 0),
      });
    }
    scored.sort(function (x, y) {
      return y.score - x.score;
    });

    // Spread the salvo: two warheads on the same twenty-five tiles is one
    // wasted warhead.
    var picked = [];
    for (var p = 0; p < scored.length && picked.length < 6; p++) {
      var ok = true;
      for (var q = 0; q < picked.length; q++) {
        if (g.euclideanDistSquared(scored[p].tile, picked[q].tile) < 30 * 30) {
          ok = false;
          break;
        }
      }
      if (ok) picked.push(scored[p]);
    }
    return picked;
  };

  OBA.Bot.__planner = true;
})();
