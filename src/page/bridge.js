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
    pendingIntents: [], // queued for the next turn (singleplayer path)
    sentIntents: 0,
    lastTransport: null, // "ws" | "local" | null
    workerSeen: false,
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
            // The game's own simulation worker announces itself here.
            state.gameWorker = worker;
            state.workerSeen = true;
            if (message.clientID) state.clientID = message.clientID;
            state.pendingIntents.length = 0;
            log("info", "sim-worker attached");
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
            // `intent` and `hash` are only ever produced by the in-game
            // Transport; `join`/`rejoin` carry a gameID and confirm it too.
            if (
              msg.type === "intent" ||
              msg.type === "hash" ||
              ((msg.type === "join" || msg.type === "rejoin") && msg.gameID)
            ) {
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
   * Sending intents                                                     *
   * ------------------------------------------------------------------ */
  function sendIntent(intent) {
    var ws = state.gameSocket;
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
    var game = getGame();
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
    getTransform: getTransform,
    getUiState: getUiState,
    myPlayer: myPlayer,
    sendIntent: sendIntent,
    quickBuild: quickBuild,
    snapshot: snapshot,
  };
})();
