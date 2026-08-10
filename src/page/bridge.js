/*
 * OpenBattle Assistant — page-world bridge.
 *
 * Runs in the MAIN world at document_start, before the game bundle evaluates,
 * so it can wrap `Worker` and `WebSocket.prototype.send` before the game ever
 * touches them.
 *
 * Two things live here:
 *
 *  1. READING the game. The game mounts its HUD as light-DOM custom elements
 *     (`<build-menu>`, `<control-panel>`, ...) and assigns the live `GameView`,
 *     `EventBus` and `TransformHandler` onto them as plain public properties.
 *     Grabbing `document.querySelector("build-menu").game` therefore hands us
 *     the exact object the game itself renders from — full map, players, units,
 *     gold, troops, terrain.
 *
 *  2. WRITING to the game. Player actions are "intents" that travel over the
 *     wire. There are two transports depending on the game mode:
 *       - Multiplayer (private lobby): a WebSocket carrying
 *         {"type":"intent","intent":{...}}. We send on the very same socket.
 *       - Singleplayer: there is no socket at all; a LocalServer batches
 *         intents into turns and posts them to the simulation Worker as
 *         {"type":"turn","turn":{turnNumber,intents,hash}}. We append our
 *         intents to the next outgoing turn.
 *     Either way the intent reaches the simulation through the game's own
 *     channel, so nothing desyncs.
 */
(function () {
  "use strict";

  if (window.__OBA__) return;

  var NS = "__OBA__";
  var PROTO = "oba:";

  /* ------------------------------------------------------------------ *
   * Unit types (mirrors core/game/Game.ts UnitType)                     *
   * ------------------------------------------------------------------ */
  var UnitType = {
    TransportShip: "Transport",
    Warship: "Warship",
    Shell: "Shell",
    SAMMissile: "SAMMissile",
    Port: "Port",
    AtomBomb: "Atom Bomb",
    HydrogenBomb: "Hydrogen Bomb",
    TradeShip: "Trade Ship",
    MissileSilo: "Missile Silo",
    DefensePost: "Defense Post",
    SAMLauncher: "SAM Launcher",
    City: "City",
    MIRV: "MIRV",
    MIRVWarhead: "MIRV Warhead",
    Train: "Train",
    Factory: "Factory",
  };

  var PlayerType = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };

  /* ------------------------------------------------------------------ *
   * Internal state                                                      *
   * ------------------------------------------------------------------ */
  var state = {
    gameSocket: null, // WebSocket carrying the in-game transport
    gameWorker: null, // simulation Worker
    clientID: null, // our clientID, read off the worker init message
    gameType: null, // "Singleplayer" | "Private" | "Public"
    pendingIntents: [], // queued for the next turn (singleplayer path)
    sentIntents: 0,
    lastTransport: null, // "ws" | "local" | null
    workerSeen: false,
    missing: [], // GameView methods this build does not provide
  };

  var listeners = { log: [] };

  function log(level, text, extra) {
    var entry = { level: level, text: text, extra: extra || null, t: Date.now() };
    for (var i = 0; i < listeners.log.length; i++) {
      try {
        listeners.log[i](entry);
      } catch (e) {
        /* a bad listener must not break the game loop */
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Hook 1 — the simulation Worker                                      *
   *                                                                     *
   * Vite inlines the worker and instantiates it via a subclass of the   *
   * global `Worker`, so subclassing (rather than wrapping in a plain    *
   * function) is what keeps `class X extends Worker` working.           *
   * ------------------------------------------------------------------ */
  var NativeWorker = window.Worker;
  if (typeof NativeWorker === "function") {
    var HookedWorker = function OBAWorker(scriptURL, options) {
      var self = Reflect.construct(
        NativeWorker,
        arguments,
        new.target || HookedWorker,
      );
      try {
        attachWorker(self);
      } catch (e) {
        /* never break worker creation */
      }
      return self;
    };
    HookedWorker.prototype = NativeWorker.prototype;
    Object.setPrototypeOf(HookedWorker, NativeWorker);
    try {
      window.Worker = HookedWorker;
    } catch (e) {
      /* if the property is locked down we simply lose singleplayer injection */
    }
  }

  function attachWorker(worker) {
    var nativePost = NativeWorker.prototype.postMessage;

    worker.postMessage = function (message, transferOrOptions) {
      var out = message;
      try {
        if (message && typeof message === "object") {
          if (message.type === "init") {
            // The game's own simulation worker announces itself here, which is
            // also the moment a new match begins: forget any socket latched
            // during the previous game or in the lobby, and let this match's
            // own traffic re-identify the transport.
            state.gameWorker = worker;
            state.workerSeen = true;
            state.gameSocket = null;
            if (message.clientID) state.clientID = message.clientID;
            state.gameType =
              (message.gameStartInfo &&
                message.gameStartInfo.config &&
                message.gameStartInfo.config.gameType) ||
              null;
            state.pendingIntents.length = 0;
            log(
              "info",
              "sim-worker attached" +
                (state.gameType ? " (" + state.gameType + ")" : ""),
            );
          } else if (
            message.type === "turn" &&
            state.pendingIntents.length > 0 &&
            worker === state.gameWorker &&
            message.turn &&
            Array.isArray(message.turn.intents)
          ) {
            // Singleplayer path: ride along on the turn the LocalServer just
            // produced. Cloning keeps the game's own object untouched.
            var mine = state.pendingIntents.splice(0, state.pendingIntents.length);
            out = {
              type: "turn",
              turn: {
                turnNumber: message.turn.turnNumber,
                intents: message.turn.intents.concat(mine),
                hash: message.turn.hash,
              },
            };
          }
        }
      } catch (e) {
        out = message;
      }
      return arguments.length > 1
        ? nativePost.call(this, out, transferOrOptions)
        : nativePost.call(this, out);
    };
  }

  /* ------------------------------------------------------------------ *
   * Hook 2 — the game WebSocket                                         *
   *                                                                     *
   * We don't replace the constructor (that would break `instanceof`);   *
   * we wrap `send` and identify the in-game transport by the shape of   *
   * the messages the client puts on it.                                 *
   * ------------------------------------------------------------------ */
  if (window.WebSocket && window.WebSocket.prototype) {
    var nativeSend = window.WebSocket.prototype.send;
    window.WebSocket.prototype.send = function (data) {
      try {
        if (typeof data === "string" && data.length < 200000) {
          var msg = JSON.parse(data);
          if (msg && typeof msg === "object") {
            // `intent` and `hash` come only from the in-game Transport, so
            // they identify it outright. `join`/`rejoin` with a gameID are a
            // weaker hint — the matchmaking socket sends a `join` too (without
            // a gameID), and a singleplayer game has no transport socket at
            // all, so never let one be latched for it.
            var sure = msg.type === "intent" || msg.type === "hash";
            var hint =
              (msg.type === "join" || msg.type === "rejoin") &&
              !!msg.gameID &&
              state.gameType !== "Singleplayer";
            if (sure || hint) {
              if (state.gameSocket !== this) {
                state.gameSocket = this;
                log("info", "game socket attached");
              }
            }
          }
        }
      } catch (e) {
        /* non-JSON frames are not ours */
      }
      return nativeSend.call(this, data);
    };
  }

  /* ------------------------------------------------------------------ *
   * Reaching the live GameView                                          *
   * ------------------------------------------------------------------ */
  var HOST_TAGS = [
    "build-menu",
    "control-panel",
    "game-left-sidebar",
    "unit-display",
    "player-panel",
    "events-display",
    "attacks-display",
    "emoji-table",
  ];

  function findHost(prop) {
    for (var i = 0; i < HOST_TAGS.length; i++) {
      var el = document.querySelector(HOST_TAGS[i]);
      if (el && el[prop]) return el;
    }
    return null;
  }

  function getGame() {
    var host = findHost("game");
    return host ? host.game : null;
  }

  function getTransform() {
    var host = findHost("transformHandler");
    return host ? host.transformHandler : null;
  }

  function getUiState() {
    var host = findHost("uiState");
    return host ? host.uiState : null;
  }

  function myPlayer() {
    var g = getGame();
    if (!g) return null;
    try {
      return g.myPlayer();
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Compatibility view                                                  *
   *                                                                     *
   * Deployments lag upstream, and a GameView from an older build is      *
   * missing some of the terrain and geometry helpers. Rather than let a  *
   * single absent method throw and take a whole subsystem down, we bind  *
   * what exists once and derive the rest from primitives that have been  *
   * there all along (`isLand`, `ownerID`, `x`/`y`, `width`/`height`).     *
   * ------------------------------------------------------------------ */
  var VIEW_METHODS = [
    "width", "height", "ref", "x", "y", "cell",
    "isValidCoord", "isValidRef",
    "isLand", "isWater", "isOcean", "isShore", "isShoreline", "isOceanShore",
    "isImpassable", "terrainType", "magnitude",
    "ownerID", "hasOwner", "owner", "isBorder", "neighbors",
    "manhattanDist", "euclideanDistSquared",
    "players", "playerBySmallID", "player", "myPlayer",
    "ticks", "inSpawnPhase", "config", "units", "unitsOwnedBy",
    "numLandTiles",
  ];

  var TERRAIN_IMPASSABLE = 4; // TerrainType.Impassable
  var IMPASSABLE_MAGNITUDE = 31;

  var cachedView = null;

  function view() {
    var game = getGame();
    if (!game) return null;
    if (cachedView && cachedView.raw === game) return cachedView;
    cachedView = buildView(game);
    return cachedView;
  }

  function buildView(game) {
    var v = { raw: game };
    var missing = [];
    for (var i = 0; i < VIEW_METHODS.length; i++) {
      var name = VIEW_METHODS[i];
      if (typeof game[name] === "function") {
        v[name] = game[name].bind(game);
      } else {
        missing.push(name);
      }
    }

    // TileRefs index the terrain buffers row-major, so x/y arithmetic is
    // enough to rebuild the geometry helpers.
    if (!v.neighbors) {
      v.neighbors = function (t) {
        var w = v.width(),
          h = v.height(),
          x = v.x(t),
          y = v.y(t),
          out = [];
        if (x > 0) out.push(t - 1);
        if (x < w - 1) out.push(t + 1);
        if (y > 0) out.push(t - w);
        if (y < h - 1) out.push(t + w);
        return out;
      };
    }
    if (!v.isValidRef) {
      v.isValidRef = function (t) {
        return t >= 0 && t < v.width() * v.height();
      };
    }
    if (!v.isWater) {
      v.isWater = function (t) {
        return !v.isLand(t);
      };
    }
    if (!v.isOcean) {
      // Without the ocean bit a lake reads as ocean. Harmless: every build
      // that depends on it is re-validated by the game before it is sent.
      v.isOcean = function (t) {
        return !v.isLand(t);
      };
    }
    if (!v.isImpassable) {
      if (v.terrainType) {
        v.isImpassable = function (t) {
          return v.terrainType(t) === TERRAIN_IMPASSABLE;
        };
      } else if (v.magnitude) {
        v.isImpassable = function (t) {
          return v.isLand(t) && v.magnitude(t) === IMPASSABLE_MAGNITUDE;
        };
      } else {
        v.isImpassable = function () {
          return false;
        };
      }
    }
    if (!v.isOceanShore) {
      v.isOceanShore = function (t) {
        if (!v.isLand(t)) return false;
        var nb = v.neighbors(t);
        for (var k = 0; k < nb.length; k++) if (v.isOcean(nb[k])) return true;
        return false;
      };
    }
    if (!v.isShore) {
      v.isShore = function (t) {
        if (!v.isLand(t)) return false;
        var nb = v.neighbors(t);
        for (var k = 0; k < nb.length; k++) if (!v.isLand(nb[k])) return true;
        return false;
      };
    }
    if (!v.hasOwner) {
      v.hasOwner = function (t) {
        return v.ownerID(t) !== 0;
      };
    }
    if (!v.isBorder) {
      v.isBorder = function (t) {
        var o = v.ownerID(t);
        var nb = v.neighbors(t);
        for (var k = 0; k < nb.length; k++)
          if (v.ownerID(nb[k]) !== o) return true;
        return false;
      };
    }
    if (!v.euclideanDistSquared) {
      v.euclideanDistSquared = function (a, b) {
        var dx = v.x(a) - v.x(b),
          dy = v.y(a) - v.y(b);
        return dx * dx + dy * dy;
      };
    }
    if (!v.manhattanDist) {
      v.manhattanDist = function (a, b) {
        return Math.abs(v.x(a) - v.x(b)) + Math.abs(v.y(a) - v.y(b));
      };
    }
    var TERRA_NULLIUS = {
      isPlayer: function () {
        return false;
      },
      smallID: function () {
        return 0;
      },
    };
    if (!v.playerBySmallID) {
      v.playerBySmallID = function (sid) {
        var list = v.players ? v.players() : [];
        for (var k = 0; k < list.length; k++)
          if (list[k].smallID() === sid) return list[k];
        return TERRA_NULLIUS;
      };
    }
    if (!v.owner) {
      v.owner = function (t) {
        return v.playerBySmallID(v.ownerID(t));
      };
    }
    if (!v.players) {
      v.players = function () {
        return [];
      };
    }
    if (!v.units) {
      v.units = function () {
        return [];
      };
    }
    if (!v.isValidCoord) {
      v.isValidCoord = function (x, y) {
        return x >= 0 && y >= 0 && x < v.width() && y < v.height();
      };
    }

    state.missing = missing;
    if (missing.length) {
      log(
        "warn",
        "این نسخه‌ی بازی " +
          missing.length +
          " متد ندارد؛ جایگزین شد: " +
          missing.join(", "),
      );
    }
    return v;
  }

  /* ------------------------------------------------------------------ *
   * Sending intents                                                     *
   * ------------------------------------------------------------------ */
  function sendIntent(intent) {
    // A singleplayer match is simulated entirely in the worker and has no
    // transport socket, so never let a stray socket swallow the intent.
    var localOnly = state.gameType === "Singleplayer" && state.gameWorker;
    var ws = localOnly ? null : state.gameSocket;
    if (ws && ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(JSON.stringify({ type: "intent", intent: intent }));
        state.sentIntents++;
        state.lastTransport = "ws";
        return "ws";
      } catch (e) {
        log("warn", "socket send failed, falling back to local", String(e));
      }
    }
    if (state.gameWorker) {
      var stamped = Object.assign({}, intent);
      if (state.clientID) stamped.clientID = state.clientID;
      // Guard against unbounded growth if turns ever stop flowing.
      if (state.pendingIntents.length < 256) state.pendingIntents.push(stamped);
      state.sentIntents++;
      state.lastTransport = "local";
      return "local";
    }
    log("warn", "no transport available for intent " + intent.type);
    return null;
  }

  /* ------------------------------------------------------------------ *
   * High level actions                                                  *
   * ------------------------------------------------------------------ */
  var NUKE_TYPES = [UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.MIRV];

  /**
   * Place `unitType` at the tile under the given screen point, in one step —
   * no ghost to arm, no second click. Validity and price come from the game's
   * own worker (`player.actions`), which is the same source the build menu
   * uses, so we never send an intent the game would reject.
   */
  function quickBuild(unitType, screenX, screenY, opts) {
    opts = opts || {};
    var game = view();
    var th = getTransform();
    var me = myPlayer();
    if (!game || !th) return Promise.resolve({ ok: false, reason: "no_game" });
    if (!me || !me.isAlive())
      return Promise.resolve({ ok: false, reason: "no_player" });

    var cell;
    try {
      cell = th.screenToWorldCoordinates(screenX, screenY);
    } catch (e) {
      return Promise.resolve({ ok: false, reason: "no_transform" });
    }
    if (!game.isValidCoord(cell.x, cell.y))
      return Promise.resolve({ ok: false, reason: "off_map" });

    var tile = game.ref(cell.x, cell.y);

    return me
      .actions(tile, [unitType])
      .then(function (actions) {
        var list = (actions && actions.buildableUnits) || [];
        var bu = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].type === unitType) {
            bu = list[i];
            break;
          }
        }
        if (!bu) return { ok: false, reason: "unavailable", unit: unitType };

        var gold = 0;
        try {
          gold = Number(me.gold());
        } catch (e) {}
        var cost = Number(bu.cost);

        if (bu.canBuild !== false) {
          var intent = {
            type: "build_unit",
            unit: unitType,
            tile: bu.canBuild,
          };
          if (NUKE_TYPES.indexOf(unitType) !== -1) {
            intent.rocketDirectionUp =
              opts.rocketDirectionUp !== undefined
                ? !!opts.rocketDirectionUp
                : true;
          }
          // A queued-but-undelivered intent is not a placed building; say so
          // rather than flashing a success the player will never see happen.
          if (!sendIntent(intent))
            return { ok: false, reason: "no_transport", unit: unitType };
          return { ok: true, mode: "build", unit: unitType, cost: cost };
        }

        if (opts.upgrade !== false && bu.canUpgrade !== false) {
          if (
            !sendIntent({
              type: "upgrade_structure",
              unit: unitType,
              unitId: bu.canUpgrade,
              amount: 1,
            })
          )
            return { ok: false, reason: "no_transport", unit: unitType };
          return { ok: true, mode: "upgrade", unit: unitType, cost: cost };
        }

        return {
          ok: false,
          reason: cost > gold ? "no_gold" : "bad_spot",
          unit: unitType,
          cost: cost,
          gold: gold,
        };
      })
      .catch(function (e) {
        return { ok: false, reason: "error", detail: String(e) };
      });
  }

  /* ------------------------------------------------------------------ *
   * Snapshot for the UI                                                 *
   * ------------------------------------------------------------------ */
  function snapshot() {
    var game = getGame();
    if (!game) {
      return { attached: false, inGame: false, transport: state.lastTransport };
    }
    var me = null;
    try {
      me = game.myPlayer();
    } catch (e) {}

    var out = {
      attached: true,
      inGame: true,
      transport: state.lastTransport,
      hasSocket: !!(state.gameSocket && state.gameSocket.readyState === 1),
      hasWorker: !!state.gameWorker,
      pending: state.pendingIntents.length,
      sent: state.sentIntents,
      spawnPhase: false,
      ticks: 0,
      me: null,
    };
    try {
      out.spawnPhase = game.inSpawnPhase();
      out.ticks = game.ticks();
    } catch (e) {}

    if (me) {
      try {
        out.me = {
          name: me.displayName ? me.displayName() : me.name(),
          alive: me.isAlive(),
          spawned: me.hasSpawned(),
          gold: Number(me.gold()),
          troops: Math.round(me.troops()),
          maxTroops: Math.round(game.config().maxTroops(me)),
          tiles: me.numTilesOwned(),
          cities: countUnits(game, me, UnitType.City),
          ports: countUnits(game, me, UnitType.Port),
          factories: countUnits(game, me, UnitType.Factory),
          silos: countUnits(game, me, UnitType.MissileSilo),
          sams: countUnits(game, me, UnitType.SAMLauncher),
          defenses: countUnits(game, me, UnitType.DefensePost),
          warships: countUnits(game, me, UnitType.Warship),
          incoming: (me.incomingAttacks() || []).length,
          outgoing: (me.outgoingAttacks() || []).length,
          allies: (me.allies() || []).length,
        };
      } catch (e) {
        out.me = null;
      }
    }
    return out;
  }

  function countUnits(game, player, type) {
    try {
      return player.units(type).length;
    } catch (e) {
      return 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * Public surface                                                      *
   * ------------------------------------------------------------------ */
  window[NS] = {
    PROTO: PROTO,
    UnitType: UnitType,
    PlayerType: PlayerType,
    state: state,
    log: log,
    onLog: function (fn) {
      listeners.log.push(fn);
    },
    getGame: getGame,
    view: view,
    getTransform: getTransform,
    getUiState: getUiState,
    myPlayer: myPlayer,
    sendIntent: sendIntent,
    quickBuild: quickBuild,
    snapshot: snapshot,
  };
})();
