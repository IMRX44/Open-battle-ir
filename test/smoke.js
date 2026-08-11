/*
 * Headless smoke test for the page-world code.
 *
 * Builds a mock GameView with the same surface the real one exposes, loads
 * bridge.js + bot.js into a VM sandbox, and drives a short match to check that
 * each subsystem emits the intents it should.
 *
 *   node test/smoke.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

/* ------------------------------------------------------------------ *
 * Mock world                                                          *
 * ------------------------------------------------------------------ */
const W = 160;
const H = 100;

// Land on the left two thirds, ocean on the right, plus a lake and a
// mountain ridge so terrain predicates get exercised.
const LAND = new Uint8Array(W * H);
const OCEAN = new Uint8Array(W * H);
const IMPASSABLE = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const isLand = x < 104 + Math.round(6 * Math.sin(y / 7));
    const inLake = x > 20 && x < 30 && y > 40 && y < 50;
    if (isLand && !inLake) {
      LAND[i] = 1;
      if (x > 60 && x < 64 && y > 10 && y < 30) IMPASSABLE[i] = 1;
    } else if (!inLake) {
      OCEAN[i] = 1;
    }
  }
}

const owner = new Int32Array(W * H); // 0 = TerraNullius

const UnitType = {
  City: "City",
  Port: "Port",
  Factory: "Factory",
  DefensePost: "Defense Post",
  MissileSilo: "Missile Silo",
  SAMLauncher: "SAM Launcher",
  Warship: "Warship",
  AtomBomb: "Atom Bomb",
  HydrogenBomb: "Hydrogen Bomb",
};

const sent = [];

function makePlayer(game, smallID, id, opts) {
  const p = {
    _units: [],
    _out: [],
    _in: [],
    _gold: opts.gold || 0,
    _troops: opts.troops || 0,
    _type: opts.type || "HUMAN",
    _spawned: opts.spawned !== false,
    smallID: () => smallID,
    id: () => id,
    name: () => id,
    displayName: () => id,
    isPlayer: () => true,
    isAlive: () => true,
    hasSpawned: () => p._spawned,
    type: () => p._type,
    troops: () => p._troops,
    gold: () => BigInt(Math.round(p._gold)),
    numTilesOwned: () => {
      let n = 0;
      for (let i = 0; i < owner.length; i++) if (owner[i] === smallID) n++;
      return n;
    },
    units: (...types) =>
      types.length === 0
        ? p._units
        : p._units.filter((u) => types.includes(u.type())),
    outgoingAttacks: () => p._out,
    incomingAttacks: () => p._in,
    allies: () => [],
    _friends: {}, // smallID -> true
    isFriendly: (o) => !!(o && p._friends[o.smallID()]),
    isTraitor: () => false,
    betrayals: () => opts.betrayals || 0,
    team: () => (opts.team === undefined ? null : opts.team),
    isRequestingAllianceWith: () => false,
    borderTiles: async () => {
      const set = new Set();
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] !== smallID) continue;
        const x = i % W,
          y = (i / W) | 0;
        let border = false;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (owner[ny * W + nx] !== smallID) border = true;
        }
        if (border) set.add(i);
      }
      return { borderTiles: set };
    },
    // The real implementation runs in the sim worker; this mirrors the parts
    // the bot depends on: legality plus price.
    actions: async (tile, types) => {
      const list = (types || []).map((t) => {
        const canPlace =
          LAND[tile] === 1 && !IMPASSABLE[tile] && owner[tile] === smallID;
        const needsShore = t === UnitType.Port;
        const needsWater = t === UnitType.Warship;
        let ok = canPlace;
        if (needsShore) ok = canPlace && game.isOceanShore(tile);
        if (needsWater) ok = game.isOcean(tile);
        if (t === UnitType.AtomBomb || t === UnitType.HydrogenBomb) ok = true;
        // A structure of this type standing on this tile is upgradable.
        const standing = p._units.find((u) => u.type() === t && u.tile() === tile);
        const cost = BigInt(COSTS[t] || 100000);
        return {
          type: t,
          canBuild: ok && !standing ? tile : false,
          canUpgrade: standing ? standing.id() : false,
          cost: cost,
          upgradeCosts: standing ? [cost * 2n] : undefined,
          overlappingRailroads: [],
          ghostRailPaths: [],
        };
      });
      return { canAttack: true, buildableUnits: list, canSendEmojiAllPlayers: true };
    },
    bestTransportShipSpawn: async () => 1,
  };
  return p;
}

const COSTS = {
  City: 125000,
  Port: 125000,
  Factory: 200000,
  "Defense Post": 50000,
  "Missile Silo": 1000000,
  "SAM Launcher": 1500000,
  Warship: 250000,
  "Atom Bomb": 750000,
  "Hydrogen Bomb": 5000000,
};

let unitSeq = 1;
function makeUnit(type, tile, ownerPlayer, level, queued) {
  const u = {
    _id: unitSeq++,
    _level: level || 1,
    _queue: [],
    type: () => type,
    tile: () => tile,
    owner: () => ownerPlayer,
    isActive: () => true,
    isUnderConstruction: () => false,
    id: () => u._id,
    level: () => u._level,
    // A silo of level N can hold N missiles; the queue is what is already up.
    missileTimerQueue: () => u._queue,
  };
  for (let i = 0; i < (queued || 0); i++) u._queue.push(0);
  return u;
}

const game = {
  _ticks: 0,
  _spawn: true,
  _players: [],
  ticks: () => game._ticks,
  inSpawnPhase: () => game._spawn,
  width: () => W,
  height: () => H,
  ref: (x, y) => y * W + x,
  x: (t) => t % W,
  y: (t) => (t / W) | 0,
  isValidCoord: (x, y) => x >= 0 && y >= 0 && x < W && y < H,
  isLand: (t) => LAND[t] === 1,
  isImpassable: (t) => IMPASSABLE[t] === 1,
  isOcean: (t) => OCEAN[t] === 1,
  isOceanShore: (t) => {
    if (LAND[t] !== 1) return false;
    const x = t % W,
      y = (t / W) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (OCEAN[ny * W + nx] === 1) return true;
    }
    return false;
  },
  hasOwner: (t) => owner[t] !== 0,
  ownerID: (t) => owner[t],
  isBorder: (t) => {
    const sid = owner[t];
    const x = t % W,
      y = (t / W) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (owner[ny * W + nx] !== sid) return true;
    }
    return false;
  },
  neighbors: (t) => {
    const x = t % W,
      y = (t / W) | 0;
    const out = [];
    if (x > 0) out.push(t - 1);
    if (x < W - 1) out.push(t + 1);
    if (y > 0) out.push(t - W);
    if (y < H - 1) out.push(t + W);
    return out;
  },
  euclideanDistSquared: (a, b) => {
    const dx = (a % W) - (b % W);
    const dy = ((a / W) | 0) - ((b / W) | 0);
    return dx * dx + dy * dy;
  },
  players: () => game._players,
  playerBySmallID: (sid) =>
    game._players.find((p) => p.smallID() === sid) || {
      isPlayer: () => false,
      smallID: () => 0,
    },
  myPlayer: () => game._players[0],
  units: (...types) => {
    const all = [];
    for (const p of game._players) all.push(...p.units(...types));
    return all;
  },
  numLandTiles: () => {
    let n = 0;
    for (let i = 0; i < LAND.length; i++) if (LAND[i]) n++;
    return n;
  },
  config: () => ({
    maxTroops: (p) => 2 * (Math.pow(p.numTilesOwned(), 0.6) * 1000 + 50000),
    structureMinDist: () => 15,
  }),
};

/* ------------------------------------------------------------------ *
 * Sandbox                                                             *
 * ------------------------------------------------------------------ */
const buildMenu = { game: game, eventBus: {}, uiState: {}, transformHandler: null };

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  JSON,
  Promise,
  Reflect,
  Object,
  Array,
  Number,
  String,
  BigInt,
  Float32Array,
  Float64Array,
  Int32Array,
  Uint8Array,
  Set,
  Map,
  Error,
  isNaN,
  document: {
    querySelector: (sel) => (sel === "build-menu" ? buildMenu : null),
  },
  location: { origin: "https://openbattle.ir" },
};
sandbox.window = sandbox;

// Record what actually reaches the "native" transports, so the tests can
// assert on the bytes the game would really have seen.
const workerCalls = [];
const socketCalls = [];
sandbox.Worker = class {
  constructor(url) {
    this.url = url;
  }
};
sandbox.Worker.prototype.postMessage = function (msg) {
  workerCalls.push(msg);
};
sandbox.WebSocket = class {
  constructor() {
    this.readyState = 1;
  }
};
sandbox.WebSocket.prototype.send = function (data) {
  socketCalls.push(data);
};

vm.createContext(sandbox);
for (const f of ["src/page/bridge.js", "src/page/bot.js", "src/page/planner.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, {
    filename: f,
  });
}

const OBA = sandbox.__OBA__;
const realSendIntent = OBA.sendIntent;
// Capture instead of transmitting — there is no real game to talk to.
OBA.sendIntent = (intent) => {
  sent.push(intent);
  return "test";
};
OBA.onLog((e) => logs.push(e));
const logs = [];

/* ------------------------------------------------------------------ *
 * Assertions                                                          *
 * ------------------------------------------------------------------ */
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  \x1b[32mPASS\x1b[0m " + name);
  } else {
    failures++;
    console.log("  \x1b[31mFAIL\x1b[0m " + name + (detail ? " — " + detail : ""));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pump(ticks) {
  for (let i = 0; i < ticks; i++) {
    game._ticks++;
    OBA.Bot.step();
    await sleep(0); // let the mocked worker promises settle
  }
}

(async function run() {
  const bot = OBA.Bot;

  console.log("\n1. bridge wiring");
  check("GameView reachable through the HUD element", OBA.getGame() === game);
  const snap = OBA.snapshot();
  check("snapshot reports attached", snap.attached === true);

  console.log("\n2. spawn selection");
  const me = makePlayer(game, 1, "me", { gold: 0, troops: 0, spawned: false });
  game._players = [me];
  bot.setConfig({ preset: "balanced" });
  bot.running = true;
  await pump(12);

  const spawn = sent.find((i) => i.type === "spawn");
  check("emits a spawn intent", !!spawn, JSON.stringify(sent.slice(0, 3)));
  if (spawn) {
    const t = spawn.tile;
    check("spawn tile is land", LAND[t] === 1);
    check("spawn tile is passable", IMPASSABLE[t] !== 1);
    check("spawn tile is unclaimed", owner[t] === 0);
    check(
      "spawn tile is on the coast (ports are the strongest opening)",
      game.isOceanShore(t),
      "x=" + game.x(t) + " y=" + game.y(t),
    );
    // The scorer should avoid the impassable ridge and the lake.
    check("spawn avoids the lake pocket", !(game.x(t) > 20 && game.x(t) < 30 && game.y(t) > 40 && game.y(t) < 50));
  }

  console.log("\n3. expansion");
  // Give ourselves a blob of territory that reaches the coast, plus troops.
  const cx = 104,
    cy = 50;
  for (let y = cy - 8; y <= cy + 8; y++)
    for (let x = cx - 8; x <= cx + 8; x++)
      if (LAND[y * W + x]) owner[y * W + x] = 1;
  me._troops = 90000;
  me._spawned = true;
  game._spawn = false;
  sent.length = 0;
  bot.next = {};
  await pump(40);

  const expand = sent.find((i) => i.type === "attack" && i.targetID === null);
  check("attacks unclaimed land while it is available", !!expand);
  check(
    "commits a large share of troops to the land grab",
    !!expand && expand.troops > me._troops * 0.5,
    expand ? "troops=" + expand.troops : "",
  );

  console.log("\n4. economy");
  me._gold = 3000000;
  sent.length = 0;
  bot.next = {};
  await pump(60);
  const builds = sent.filter((i) => i.type === "build_unit");
  check("builds structures once gold allows", builds.length > 0);
  check(
    "opens with a port on the coast",
    builds.some((b) => b.unit === UnitType.Port),
    builds.map((b) => b.unit).join(","),
  );

  console.log("\n5. attacking a weaker neighbour");
  const foe = makePlayer(game, 2, "foe", { gold: 0, troops: 5000, type: "BOT" });
  game._players.push(foe);
  // Claim the tiles directly west of us for the enemy so we share a border.
  for (let y = cy - 6; y <= cy + 6; y++)
    for (let x = cx - 18; x < cx - 8; x++)
      if (LAND[y * W + x]) owner[y * W + x] = 2;
  // Close off the neutral frontier so the bot prefers war over expansion.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (LAND[y * W + x] && owner[y * W + x] === 0) owner[y * W + x] = 3;
  const filler = makePlayer(game, 3, "filler", { troops: 10000000 });
  game._players.push(filler);

  sent.length = 0;
  bot.next = {};
  bot.territory = null;
  await pump(60);
  const strike = sent.find((i) => i.type === "attack" && i.targetID === "foe");
  check("opens an attack on the weak neighbour", !!strike);
  check(
    "leaves the much stronger neighbour alone",
    !sent.some((i) => i.type === "attack" && i.targetID === "filler"),
  );

  console.log("\n6. nukes");
  me._gold = 12000000;
  me._units.push(makeUnit(UnitType.MissileSilo, cy * W + cx, me));
  for (let k = 0; k < 6; k++)
    foe._units.push(makeUnit(UnitType.City, (cy + k) * W + (cx - 12), foe));
  sent.length = 0;
  bot.next = {};
  await pump(60);
  check(
    "fires a warhead at the enemy structure cluster",
    sent.some(
      (i) =>
        i.type === "build_unit" &&
        (i.unit === UnitType.AtomBomb || i.unit === UnitType.HydrogenBomb),
    ),
    sent.map((s) => s.type + ":" + (s.unit || "")).join(" "),
  );

  console.log("\n7. lifecycle");
  bot.stop();
  sent.length = 0;
  await pump(20);
  check("stops emitting once halted, including in-flight builds", sent.length === 0,
    JSON.stringify(sent));

  console.log("\n8. intent transports");
  OBA.sendIntent = realSendIntent;
  OBA.state.gameSocket = null;
  OBA.state.gameWorker = null;
  OBA.state.pendingIntents.length = 0;

  // Singleplayer: no socket, so the intent must ride the next turn message.
  const worker = vm.runInContext("new Worker('blob:sim')", sandbox);
  worker.postMessage({ type: "init", clientID: "me-client" });
  check("worker init is recognised", OBA.state.gameWorker === worker);

  const route = OBA.sendIntent({ type: "spawn", tile: 42 });
  check("routes to the local turn queue when there is no socket", route === "local");

  workerCalls.length = 0;
  worker.postMessage({ type: "turn", turn: { turnNumber: 7, intents: [], hash: null } });
  const forwarded = workerCalls[workerCalls.length - 1];
  check(
    "injects the queued intent into the outgoing turn",
    forwarded &&
      forwarded.type === "turn" &&
      forwarded.turn.intents.length === 1 &&
      forwarded.turn.intents[0].type === "spawn" &&
      forwarded.turn.intents[0].clientID === "me-client",
    JSON.stringify(forwarded),
  );
  check("preserves the turn number", forwarded && forwarded.turn.turnNumber === 7);
  check("drains the queue after forwarding", OBA.state.pendingIntents.length === 0);

  // Multiplayer: once the game socket announces itself, intents go over it.
  const ws = vm.runInContext("new WebSocket('wss://openbattle.ir/w0/game')", sandbox);
  ws.send(JSON.stringify({ type: "join", gameID: "abc123", username: "me" }));
  check("game socket is identified from its join frame", OBA.state.gameSocket === ws);

  socketCalls.length = 0;
  const route2 = OBA.sendIntent({ type: "attack", targetID: "foe", troops: 10 });
  check("prefers the socket when one is open", route2 === "ws");
  const frame = JSON.parse(socketCalls[socketCalls.length - 1]);
  check(
    "sends the wire shape the server expects",
    frame.type === "intent" && frame.intent.type === "attack" && frame.intent.troops === 10,
    JSON.stringify(frame),
  );
  check("does not double-queue on the local path", OBA.state.pendingIntents.length === 0);

  console.log("\n9. one-key building under the cursor");
  // Identity transform keeps screen coordinates equal to tile coordinates.
  buildMenu.transformHandler = {
    screenToWorldCoordinates: (sx, sy) => ({ x: sx, y: sy }),
  };
  me._gold = 5000000;

  socketCalls.length = 0;
  const good = await OBA.quickBuild(UnitType.City, cx, cy, {});
  check("places a structure at the cursor tile", good.ok === true, JSON.stringify(good));
  check("reports it as a build, not an upgrade", good.mode === "build");
  const placed = JSON.parse(socketCalls[socketCalls.length - 1] || "null");
  check(
    "sends a build_unit intent for the tile under the cursor",
    placed &&
      placed.intent.type === "build_unit" &&
      placed.intent.unit === UnitType.City &&
      placed.intent.tile === cy * W + cx,
    JSON.stringify(placed),
  );

  socketCalls.length = 0;
  const onWater = await OBA.quickBuild(UnitType.City, 150, 50, {});
  check("refuses a spot the game would reject", onWater.ok === false, JSON.stringify(onWater));
  check("sends nothing when it refuses", socketCalls.length === 0);

  const offMap = await OBA.quickBuild(UnitType.City, 9999, 9999, {});
  check("refuses coordinates off the map", offMap.ok === false && offMap.reason === "off_map");

  // With every transport gone the player must be told, not shown a fake success.
  OBA.state.gameSocket = null;
  OBA.state.gameWorker = null;
  const orphan = await OBA.quickBuild(UnitType.City, cx, cy + 1, {});
  check(
    "reports no_transport instead of a false success",
    orphan.ok === false && orphan.reason === "no_transport",
    JSON.stringify(orphan),
  );

  console.log("\n10. older deployments with a thinner GameView");
  // openbattle.ir lags upstream and its GameView lacks some helpers. Strip
  // them and confirm the compatibility view derives equivalents rather than
  // letting a subsystem die on a missing method.
  const REMOVED = [
    "isImpassable",
    "isOceanShore",
    "isBorder",
    "hasOwner",
    "euclideanDistSquared",
    "isOcean",
  ];
  const stripped = Object.create(null);
  for (const k of Object.keys(game)) stripped[k] = game[k];
  for (const gone of REMOVED) delete stripped[gone];
  buildMenu.game = stripped;

  const v = OBA.view();
  check("compatibility view is built for the stripped GameView", !!v && v.raw === stripped);
  check(
    "reports every method it had to replace",
    REMOVED.every((m) => OBA.state.missing.includes(m)),
    OBA.state.missing.join(","),
  );
  const landTile = cy * W + 40;
  const shoreTile = (() => {
    for (let x = W - 1; x >= 0; x--) if (game.isOceanShore(cy * W + x)) return cy * W + x;
    return -1;
  })();
  check("derived isImpassable matches the real one", v.isImpassable(landTile) === game.isImpassable(landTile));
  check("derived isOceanShore finds the coast", shoreTile >= 0 && v.isOceanShore(shoreTile) === true);
  check("derived isOceanShore rejects the interior", v.isOceanShore(landTile) === false);
  check("derived hasOwner matches", v.hasOwner(cy * W + cx) === game.hasOwner(cy * W + cx));
  check("derived isBorder matches", v.isBorder(shoreTile) === game.isBorder(shoreTile));
  check(
    "derived euclideanDistSquared matches",
    v.euclideanDistSquared(landTile, shoreTile) ===
      game.euclideanDistSquared(landTile, shoreTile),
  );

  // The whole point: a spawn scan must now complete instead of throwing.
  // Hand back an unclaimed map so there is something to spawn onto.
  const savedOwner = Int32Array.from(owner);
  owner.fill(0);
  OBA.state.gameSocket = null;
  OBA.state.gameWorker = worker;
  OBA.state.gameType = "Singleplayer";
  OBA.state.pendingIntents.length = 0;
  me._spawned = false;
  game._spawn = true;
  bot.spawnEvals = 0;
  bot.spawnPicked = null;
  bot.next = {};
  bot.running = true;
  await pump(12);
  check(
    "spawn scan survives the missing helpers",
    OBA.state.pendingIntents.some((i) => i.type === "spawn"),
    JSON.stringify(OBA.state.pendingIntents),
  );
  check(
    "no error was logged during the scan",
    !logs.some((l) => l.level === "error"),
    logs.filter((l) => l.level === "error").map((l) => l.text).join(" | "),
  );
  bot.stop();
  buildMenu.game = game;
  owner.set(savedOwner);

  console.log("\n11. a singleplayer game never routes through a stray socket");
  // A lobby or matchmaking socket can be open when a singleplayer match
  // starts; its intents must still go to the local worker.
  OBA.state.gameType = null;
  const stray = vm.runInContext("new WebSocket('wss://openbattle.ir/lobby')", sandbox);
  stray.send(JSON.stringify({ type: "join", gameID: "lobby1", username: "me" }));
  check("a pre-game socket can latch before the match type is known", OBA.state.gameSocket === stray);

  workerCalls.length = 0;
  OBA.state.pendingIntents.length = 0;
  worker.postMessage({
    type: "init",
    clientID: "me-client",
    gameStartInfo: { config: { gameType: "Singleplayer" } },
  });
  check("starting a match clears the previously latched socket", OBA.state.gameSocket === null);
  check("the match type is recorded", OBA.state.gameType === "Singleplayer");

  socketCalls.length = 0;
  const spRoute = OBA.sendIntent({ type: "spawn", tile: 77 });
  check("singleplayer intents go to the worker, not the socket", spRoute === "local");
  check("nothing was written to the stray socket", socketCalls.length === 0);

  // Even if the stray socket re-announces itself mid-match, singleplayer wins.
  stray.send(JSON.stringify({ type: "join", gameID: "lobby1", username: "me" }));
  check(
    "a singleplayer match refuses to latch a join-only socket",
    OBA.state.gameSocket === null,
  );
  socketCalls.length = 0;
  check("still local", OBA.sendIntent({ type: "spawn", tile: 78 }) === "local");
  check("still nothing on the socket", socketCalls.length === 0);

  console.log("\n12. a build without borderTiles");
  // Territory analysis must fall back to scanning the map itself.
  buildMenu.game = game;
  const savedBorderTiles = me.borderTiles;
  delete me.borderTiles;
  me._spawned = true;
  game._spawn = false;
  me._troops = 90000;
  bot.territory = null;
  bot.next = {};
  bot.running = true;
  OBA.state.pendingIntents.length = 0;
  await pump(40);
  check("territory is rebuilt without borderTiles", !!bot.territory);
  check(
    "and the bot still acts on it",
    !!bot.territory && bot.territory.border.length > 0 && OBA.state.pendingIntents.length > 0,
    JSON.stringify(bot.territory && bot.territory.border.length),
  );
  bot.stop();
  me.borderTiles = savedBorderTiles;

  console.log("\n13. god mode — attrition maths");
  // Per tile the attacker pays within(D/T, 0.6, 2) * mag * 0.8, so an attack
  // launched below ~1.7x the defender's whole army costs multiples of the
  // troops for the same ground. God mode must refuse those fights outright
  // and size the ones it takes to the target, not to its own barracks.
  buildMenu.game = game;
  OBA.sendIntent = (intent) => {
    sent.push(intent);
    return "test";
  };
  bot.setConfig({ preset: "god" });
  check("god preset uses the attrition gate", bot.cfg.attackEfficiency >= 1.6);

  me._spawned = true;
  game._spawn = false;
  bot.territory = null;
  bot.next = {};
  bot.running = true;

  // A neighbour just out of reach: we hold 90k, they hold 70k. The old
  // threshold (1.35) would have attacked; the maths says wait.
  foe._troops = 70000;
  me._troops = 90000;
  me._in = [];
  me._out = [];
  sent.length = 0;
  await pump(50);
  const rash = sent.filter((i) => i.type === "attack" && i.targetID === "foe");
  check(
    "refuses a fight it cannot win cheaply",
    rash.length === 0,
    JSON.stringify(rash),
  );

  // Now they are weak enough that the attack is efficient.
  foe._troops = 12000;
  me._troops = 200000;
  bot.next = {};
  bot.territory = null;
  sent.length = 0;
  await pump(50);
  const strike2 = sent.find((i) => i.type === "attack" && i.targetID === "foe");
  check("attacks once the maths clears", !!strike2, JSON.stringify(sent.slice(0, 4)));
  if (strike2) {
    check(
      "commits enough to sit at minimum attrition",
      strike2.troops >= foe._troops * 1.6,
      "sent " + strike2.troops + " vs needed " + foe._troops * 1.7,
    );
    check(
      "but does not empty the barracks for a small target",
      strike2.troops < me._troops * 0.5,
      "sent " + strike2.troops + " of " + me._troops,
    );
  }

  console.log("\n14. god mode — garrison and pressure");
  // Troops under an incoming attack must stay home.
  me._troops = 200000;
  me._in = [{ attackerID: 2, targetID: 1, troops: 150000, id: "a", retreating: false }];
  const guarded = bot.spendable(bot.lastView || OBA.view(), me);
  check(
    "a large incoming attack locks down the budget",
    guarded < 200000 * 0.4,
    "spendable " + Math.round(guarded),
  );
  me._in = [];
  const relaxed = bot.spendable(OBA.view(), me);
  check("and frees it again once the threat passes", relaxed > guarded);

  console.log("\n15. god mode — island hunting");
  // Carve an unclaimed island into the ocean, well clear of the mainland.
  const isleX = 135,
    isleY = 25;
  for (let y = isleY - 5; y <= isleY + 5; y++)
    for (let x = isleX - 5; x <= isleX + 5; x++) {
      const i = y * W + x;
      LAND[i] = 1;
      OCEAN[i] = 0;
    }
  me._troops = 300000;
  me._out = [];
  bot.next = {};
  bot.territory = null;
  sent.length = 0;
  bot.running = true;
  await pump(60);
  check(
    "spots the unclaimed landmass",
    !!bot.islands && bot.islands.targets.length > 0,
    JSON.stringify(bot.islands && bot.islands.targets.length),
  );
  const landing = sent.find((i) => i.type === "boat");
  check("sends a transport to it", !!landing, JSON.stringify(sent.map((s) => s.type)));
  if (landing) {
    const lx = landing.dst % W,
      ly = (landing.dst / W) | 0;
    check(
      "lands on the island, not back home",
      Math.abs(lx - isleX) <= 6 && Math.abs(ly - isleY) <= 6,
      "dst " + lx + "," + ly,
    );
    check(
      "does not ship the whole army out",
      landing.troops < me._troops * 0.35,
      "sent " + landing.troops + " of " + me._troops,
    );
  }
  bot.stop();

  console.log("\n16. growth bands");
  // Growth is (10 + t^0.73/4) * (1 - t/max); maximising t^0.73 * (1 - t) gives
  // 0.73(1-u) = u, so the peak sits at u = 0.73/1.73 = 42.2% of the cap. That
  // is the number the community guides quote, and it is what the bands are
  // built around.
  const V = OBA.view();
  const peakCheck = (() => {
    const max = 1_000_000;
    const rate = (t) => (10 + Math.pow(t, 0.73) / 4) * (1 - t / max);
    let bestT = 0,
      bestR = -1;
    for (let t = 1000; t < max; t += 1000) {
      const r = rate(t);
      if (r > bestR) {
        bestR = r;
        bestT = t;
      }
    }
    return bestT / max;
  })();
  check(
    "the growth peak really is ~42% of the cap",
    Math.abs(peakCheck - 0.422) < 0.01,
    "peak at " + (peakCheck * 100).toFixed(1) + "%",
  );

  me._in = [];
  me._out = [];
  const maxT = game.config().maxTroops(me);
  const bandAt = (frac) => {
    me._troops = maxT * frac;
    return bot.assess(V, me).band;
  };
  check("a starved army is 'critical'", bandAt(0.2) === "critical");
  check("an army on the peak is 'growth'", bandAt(0.42) === "growth");
  check("a rested army is 'ready'", bandAt(0.6) === "ready");
  check("a full army is 'wasting'", bandAt(0.9) === "wasting");

  console.log("\n17. never everything on one front");
  me._troops = maxT * 0.9;
  bot.territory = null;
  bot.next = {};
  bot.running = true;
  await pump(30);
  const twoFront = bot.assess(V, me);
  check(
    "two hostile neighbours are counted",
    twoFront.fronts >= 2,
    "fronts " + twoFront.fronts,
  );
  check(
    "so no single operation may take the whole free force",
    twoFront.perAttackCap < twoFront.budget * 0.6,
    "cap " + Math.round(twoFront.perAttackCap) + " of budget " + Math.round(twoFront.budget),
  );
  check(
    "and a garrison is always withheld",
    twoFront.garrison > 0 && twoFront.budget < twoFront.troops,
  );

  sent.length = 0;
  bot.next = {};
  await pump(30);
  const anyAttack = sent.filter((i) => i.type === "attack");
  check(
    "every attack respects the single-operation cap",
    anyAttack.every((a) => a.troops <= twoFront.perAttackCap * 1.35),
    anyAttack.map((a) => a.troops).join(","),
  );

  console.log("\n18. recall only when there is no choice");
  me._troops = maxT * 0.9;
  me._in = [];
  me._out = [{ attackerID: 1, targetID: 2, troops: 60000, id: "atk-1", retreating: false }];
  bot.next = {};
  sent.length = 0;
  bot.assess(V, me);
  bot.doRetreat(V, me);
  check("a calm front never recalls an attack", sent.length === 0);

  // Now more is coming at us than is standing at home.
  me._troops = 30000;
  me._in = [{ attackerID: 2, targetID: 1, troops: 90000, id: "in-1", retreating: false }];
  sent.length = 0;
  bot.assess(V, me);
  bot.doRetreat(V, me);
  const recall = sent.find((i) => i.type === "cancel_attack");
  check("but an overwhelming attack pulls troops home", !!recall, JSON.stringify(sent));
  check("and it recalls the right one", !!recall && recall.attackID === "atk-1");

  console.log("\n19. structures go in good places");
  me._in = [];
  me._out = [];
  me._troops = maxT * 0.5;
  bot.territory = null;
  bot.next = {};
  await pump(30);
  check("hostile frontage is identified", !!bot.territory && bot.territory.hostile.length > 0);

  const interiorRanked = bot.rankSafe(V, bot.territory.interior, 8);
  const distToTrouble = (t) => {
    let best = Infinity;
    for (const ht of bot.territory.hostile)
      best = Math.min(best, V.euclideanDistSquared(t, ht));
    return best;
  };
  const avgRanked =
    interiorRanked.reduce((a, t) => a + distToTrouble(t), 0) / interiorRanked.length;
  const avgAll =
    bot.territory.interior.reduce((a, t) => a + distToTrouble(t), 0) /
    bot.territory.interior.length;
  check(
    "cities are steered away from contested borders",
    avgRanked > avgAll,
    "ranked " + Math.round(avgRanked) + " vs pool average " + Math.round(avgAll),
  );

  // Ports want distance from our other ports: trade income is
  // 75000/(1+e^(-0.03(d-300))) + 50d, so a short route earns almost nothing.
  const existingPort = bot.territory.shore[0];
  const portRanked = bot.rankSpread(V, bot.territory.shore, [existingPort], 6);
  check(
    "ports are spread out rather than clustered",
    V.euclideanDistSquared(portRanked[0], existingPort) >
      V.euclideanDistSquared(bot.territory.shore[1], existingPort),
    "best " + V.euclideanDistSquared(portRanked[0], existingPort),
  );
  bot.stop();

  console.log("\n20. the planner does several things at once");
  // The complaint the planner exists to fix: the old code either bought one
  // building or moved troops, never both.
  // The game keeps every structure 15 tiles from every other, so a cramped
  // territory can only take one building per cycle no matter how rich we are.
  // Give ourselves room for several.
  for (let y = 20; y <= 80; y++)
    for (let x = 96; x <= 112; x++) if (LAND[y * W + x]) owner[y * W + x] = 1;
  me._in = [];
  me._out = [];
  me._units.length = 0;
  me._gold = 30000000;
  me._troops = maxT * 0.9;
  foe._troops = 8000;
  bot.setConfig({ preset: "god" });
  bot.territory = null;
  bot.next = {};
  bot.running = true;
  sent.length = 0;
  await pump(60);

  const kinds = new Set(sent.map((i) => i.type));
  const builds20 = sent.filter((i) => i.type === "build_unit" && i.unit !== UnitType.AtomBomb && i.unit !== UnitType.HydrogenBomb);
  const distinctTypes = new Set(builds20.map((b) => b.unit));
  check(
    "buys more than one kind of structure",
    distinctTypes.size >= 2,
    [...distinctTypes].join(","),
  );
  check(
    "and moves troops in the same window",
    kinds.has("attack"),
    [...kinds].join(","),
  );
  check(
    "several purchases land per planning pass",
    builds20.length >= 3,
    "builds " + builds20.length,
  );

  console.log("\n21. gold buys the best value first");
  // The whole point of ranking by score per unit cost: a 50k defence post
  // that seals a contested front must outrank a 3M SAM we have no use for.
  bot.world = {
    nukeThreat: 0,
    leader: null,
    leaderIsThreat: false,
    collapsing: {},
    progress: 0.2,
  };
  bot.territory.hostile = bot.territory.border.slice(0, 60);
  me._gold = 400000;
  sent.length = 0;
  const survey = [
    {
      tile: bot.territory.interior[0],
      actions: {
        buildableUnits: [
          { type: UnitType.DefensePost, canBuild: bot.territory.interior[0], canUpgrade: false, cost: 50000n },
          { type: UnitType.SAMLauncher, canBuild: bot.territory.interior[0], canUpgrade: false, cost: 1500000n },
          { type: UnitType.Factory, canBuild: bot.territory.interior[0], canUpgrade: false, cost: 200000n },
        ],
      },
    },
  ];
  bot.spendGold(OBA.view(), me, survey);
  const firstBuy = sent.find((i) => i.type === "build_unit");
  check(
    "the cheap high-value option is taken first",
    !!firstBuy && firstBuy.unit === UnitType.DefensePost,
    JSON.stringify(sent.map((s) => s.unit)),
  );
  check(
    "nothing unaffordable is ordered",
    !sent.some((i) => i.unit === UnitType.SAMLauncher),
  );

  console.log("\n22. warheads at scale");
  // A level-N silo holds N missiles at once, so three level-three silos can
  // put nine in the air. Firing one every forty ticks is not the same game.
  me._units.length = 0;
  me._gold = 40000000;
  for (let k = 0; k < 3; k++)
    me._units.push(makeUnit(UnitType.MissileSilo, cy * W + (cx + k), me, 3, 0));
  foe._units.length = 0;
  for (let k = 0; k < 10; k++)
    foe._units.push(makeUnit(UnitType.City, (cy + (k % 5)) * W + (cx - 12 - ((k / 5) | 0)), foe));
  // A launcher over the cluster: one warhead would be intercepted, a salvo
  // gets through while it reloads.
  foe._units.push(makeUnit(UnitType.SAMLauncher, cy * W + (cx - 12), foe, 1, 0));
  bot.survey(OBA.view(), me);
  sent.length = 0;
  bot.busy.nuke = false;
  bot.planNukes(OBA.view(), me);
  await sleep(5);
  const salvo = sent.filter(
    (i) => i.type === "build_unit" && (i.unit === UnitType.AtomBomb || i.unit === UnitType.HydrogenBomb),
  );
  check("fires a salvo, not a single missile", salvo.length >= 2, "fired " + salvo.length);
  check(
    "saturates a launcher-covered cluster instead of feeding it one at a time",
    salvo.filter((s) => s.tile === salvo[0].tile).length >= 2,
    JSON.stringify(salvo.map((s) => s.tile)),
  );

  console.log("\n23. it upgrades its own silos and launchers");
  // SAM level is interception range (70 tiles at level 1, 118 at level 10)
  // and silo level is concurrent missiles — both matter more than another
  // building once an opponent starts throwing warheads.
  me._units.length = 0;
  const samTile = bot.territory.interior[0];
  const siloTile = bot.territory.interior[1];
  me._units.push(makeUnit(UnitType.SAMLauncher, samTile, me, 1, 0));
  me._units.push(makeUnit(UnitType.MissileSilo, siloTile, me, 1, 0));
  // Three enemy silos and a quiet land border: warheads are the threat, so
  // interception range is what the gold should be buying.
  foe._units.length = 0;
  for (let k = 0; k < 3; k++)
    foe._units.push(makeUnit(UnitType.MissileSilo, (cy + k) * W + (cx - 12), foe, 1, 0));
  bot.territory.hostile = [];
  me._gold = 40000000;
  bot.survey(OBA.view(), me);
  sent.length = 0;
  bot.busy.plan = false;
  bot.planEconomy(OBA.view(), me);
  await sleep(20);
  const air = sent.filter(
    (i) =>
      i.unit === UnitType.SAMLauncher &&
      (i.type === "build_unit" || i.type === "upgrade_structure"),
  );
  check(
    "puts gold into air defence once the enemy has silos",
    air.length > 0,
    JSON.stringify(sent.map((s) => s.type + ":" + s.unit)),
  );

  // Coverage first, depth second. Once launchers blanket the territory a new
  // one adds nothing, so the remaining value is in range — level 1 intercepts
  // at 70 tiles, level 10 at 118 — and the gold should go into levels.
  for (let k = 0; k < 12; k++)
    me._units.push(makeUnit(UnitType.SAMLauncher, samTile + k, me, 1, 0));
  bot.survey(OBA.view(), me);
  sent.length = 0;
  bot.spendGold(OBA.view(), me, [
    {
      tile: samTile,
      actions: {
        buildableUnits: [
          {
            type: UnitType.SAMLauncher,
            canBuild: samTile + 99,
            canUpgrade: 1,
            cost: 1500000n,
            upgradeCosts: [3000000n],
          },
        ],
      },
    },
  ]);
  const samMove = sent.find((i) => i.unit === UnitType.SAMLauncher);
  check(
    "and switches to upgrading once coverage is there",
    !!samMove && samMove.type === "upgrade_structure",
    JSON.stringify(sent.map((s) => s.type + ":" + s.unit)),
  );

  console.log("\n24. piling onto a collapsing player");
  // Someone whose incoming attacks outweigh their army is being taken apart.
  // If we do not take that ground, whoever is already eating them does.
  me._units.length = 0;
  foe._units.length = 0;
  me._gold = 0;
  me._troops = maxT * 0.42; // the growth peak — normally no optional war
  // A real neighbour, not a rump state: big enough that none of the
  // "already finished" shortcuts fire, small enough to be affordable.
  for (let y = 20; y < 80; y++)
    for (let x = 80; x < 96; x++)
      if (LAND[y * W + x] && owner[y * W + x] === 3) owner[y * W + x] = 2;
  foe._troops = 5000;
  foe._in = [];
  bot.territory = null;
  bot.next = {};
  sent.length = 0;
  await pump(50);
  const calm = sent.filter((i) => i.type === "attack" && i.targetID === "foe");
  check("on the growth peak it holds off", calm.length === 0, JSON.stringify(calm));

  foe._in = [{ attackerID: 3, targetID: 2, troops: 90000, id: "x", retreating: false }];
  bot.next = {};
  bot.territory = null;
  sent.length = 0;
  await pump(50);
  const pileOn = sent.find((i) => i.type === "attack" && i.targetID === "foe");
  check("but joins in once they are collapsing", !!pileOn, JSON.stringify(sent));

  console.log("\n25. an alliance ends when the ally does");
  me._friends[foe.smallID()] = true;
  foe._friends[me.smallID()] = true;
  bot.broke = {};
  bot.territory = null;
  bot.next = {};
  sent.length = 0;
  await pump(60);
  const broke = sent.find((i) => i.type === "breakAlliance");
  check("breaks the pact rather than watch a rival absorb them", !!broke,
    JSON.stringify(sent.map((s) => s.type)));
  check("and targets the right ally", !!broke && broke.recipient === "foe");
  check(
    "it never sends an attack the game would reject",
    !sent.some((i) => i.type === "attack" && i.targetID === "foe"),
  );
  delete me._friends[foe.smallID()];
  delete foe._friends[me.smallID()];
  foe._in = [];

  console.log("\n26. all three transports work");
  for (const [ix, iy] of [
    [135, 25],
    [140, 70],
    [125, 88],
  ]) {
    for (let y = iy - 4; y <= iy + 4; y++)
      for (let x = ix - 4; x <= ix + 4; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        LAND[y * W + x] = 1;
        OCEAN[y * W + x] = 0;
      }
  }
  me._troops = maxT * 0.95;
  me._units.length = 0; // no transports afloat
  bot.islands = null;
  bot.territory = null;
  bot.next = {};
  bot.running = true;
  await pump(60); // let the territory and island scans settle

  // Measure a single dispatch: the mock never actually floats a transport, so
  // repeated cycles would keep finding three free slots.
  sent.length = 0;
  bot.busy.boats = false;
  bot.doIslands(OBA.view(), me);
  await sleep(10);
  const boats = sent.filter((i) => i.type === "boat");
  check("launches more than one landing at a time", boats.length >= 2, "boats " + boats.length);
  check("never more than the three the game allows", boats.length <= 3);
  const beaches = new Set(boats.map((b) => b.dst));
  check("each transport goes somewhere different", beaches.size === boats.length);
  bot.stop();

  console.log("\n27. team games spawn with the team");
  const mate = makePlayer(game, 7, "mate", { troops: 1000, team: "A" });
  const rival = makePlayer(game, 8, "rival", { troops: 1000, team: "B" });
  game._players = [me, mate, rival];
  Object.defineProperty(me, "team", { value: () => "A", configurable: true });
  owner.fill(0);
  // The team holds the far north-west; a rival holds the south.
  for (let y = 4; y < 14; y++) for (let x = 4; x < 16; x++) owner[y * W + x] = 7;
  for (let y = 86; y < 96; y++) for (let x = 4; x < 16; x++) owner[y * W + x] = 8;
  me._spawned = false;
  game._spawn = true;
  bot.spawnEvals = 0;
  bot.spawnPicked = null;
  bot.next = {};
  bot.running = true;
  sent.length = 0;
  await pump(12);
  const teamSpawn = sent.find((i) => i.type === "spawn");
  check("still picks a spawn", !!teamSpawn);
  if (teamSpawn) {
    const sx = teamSpawn.tile % W,
      sy = (teamSpawn.tile / W) | 0;
    const dMate = Math.hypot(sx - 10, sy - 9);
    const dRival = Math.hypot(sx - 10, sy - 91);
    check(
      "and lands on the team's side of the map",
      dMate < dRival,
      "spawn " + sx + "," + sy + " — team " + Math.round(dMate) + " rival " + Math.round(dRival),
    );
  }
  bot.stop();

  console.log("\n28. the opening is about income, not cities");
  // A city raises the troop ceiling by 250,000, which is worth nothing while
  // the army sits at a quarter of the ceiling it already has. The reported
  // failure was five million gold turned into seven cities and one port.
  const V2 = OBA.view();
  bot.world = {
    nukeThreat: 0,
    leader: null,
    leaderIsThreat: false,
    collapsing: {},
    progress: 0.1,
  };
  bot.territory.hostile = []; // quiet borders, so defence is not the answer
  // Far enough apart that the game's 15-tile rule is not what is being tested.
  const quay = bot.territory.shore[0];
  let inland = bot.territory.interior[0];
  for (const t of bot.territory.interior)
    if (V2.euclideanDistSquared(t, quay) > 30 * 30) {
      inland = t;
      break;
    }
  const openingSurvey = [
    {
      tile: quay,
      actions: {
        buildableUnits: [
          { type: UnitType.Port, canBuild: quay, canUpgrade: false, cost: 125000n },
        ],
      },
    },
    {
      tile: inland,
      actions: {
        buildableUnits: [
          { type: UnitType.City, canBuild: inland, canUpgrade: false, cost: 125000n },
        ],
      },
    },
  ];

  me._units.length = 0;
  me._gold = 5000000;
  me._troops = maxT * 0.25; // a fresh spawn: nowhere near the ceiling
  bot.assess(V2, me);
  sent.length = 0;
  bot.spendGold(V2, me, openingSurvey);
  const opening = sent.filter((i) => i.type === "build_unit");
  check(
    "the first thing bought is a port, not a city",
    opening.length > 0 && opening[0].unit === UnitType.Port,
    JSON.stringify(opening.map((o) => o.unit)),
  );

  // Same board, but now the army is pressed against its ceiling — that is
  // when raising the ceiling is finally worth the gold.
  me._units.length = 0;
  me._troops = maxT * 0.85;
  bot.assess(V2, me);
  sent.length = 0;
  bot.spendGold(V2, me, openingSurvey);
  const late = sent.filter((i) => i.type === "build_unit");
  check(
    "but a capped army does buy the city",
    late.some((b) => b.unit === UnitType.City),
    JSON.stringify(late.map((o) => o.unit)),
  );

  console.log("\n29. saving beats buying badly");
  // With nothing worth its price on offer, gold should stay in the bank.
  me._units.length = 0;
  me._troops = maxT * 0.25;
  bot.assess(V2, me);
  sent.length = 0;
  bot.spendGold(V2, me, [
    {
      tile: inland,
      actions: {
        buildableUnits: [
          // The fourth city onward costs a million, and the ceiling it raises
          // is one we are nowhere near.
          { type: UnitType.City, canBuild: inland, canUpgrade: false, cost: 1000000n },
        ],
      },
    },
  ]);
  check(
    "a million-gold city is refused while the ceiling is slack",
    sent.length === 0,
    JSON.stringify(sent.map((s) => s.unit)),
  );

  console.log("\n30. launchers stand over the cluster");
  // "Put a SAM wherever five things are built" — and not on empty ground.
  me._units.length = 0;
  const hub = bot.territory.interior[0];
  for (let k = 0; k < 6; k++)
    me._units.push(makeUnit(UnitType.City, hub + k * W, me, 1, 0));
  const samPicks = bot.samSites(V2, me, bot.territory.interior, 3);
  check("finds somewhere to shelter", samPicks.length > 0);
  if (samPicks.length) {
    const coverCount = (t) =>
      me._units.filter((u) => V2.euclideanDistSquared(t, u.tile()) <= 70 * 70).length;
    const poolAvg =
      bot.territory.interior.reduce((a, t) => a + coverCount(t), 0) /
      bot.territory.interior.length;
    check(
      "and the spot it picks covers more than an average one",
      coverCount(samPicks[0]) >= Math.max(3, poolAvg),
      "covers " + coverCount(samPicks[0]) + " vs average " + poolAvg.toFixed(1),
    );
  }

  // "Wherever more than five things are built, put a launcher over them" —
  // even with nobody holding a silo yet, that much investment in one place is
  // worth covering.
  me._units.length = 0;
  for (let k = 0; k < 6; k++)
    me._units.push(makeUnit(UnitType.City, hub + k * W, me, 1, 0));
  foe._units.length = 0; // nobody can nuke us at all
  bot.survey(V2, me);
  me._gold = 20000000;
  sent.length = 0;
  const cover = bot.territory.interior.find(
    (t) => V2.euclideanDistSquared(t, hub) > 40 * 40,
  );
  bot.spendGold(V2, me, [
    {
      tile: cover,
      actions: {
        buildableUnits: [
          { type: UnitType.SAMLauncher, canBuild: cover, canUpgrade: false, cost: 1500000n },
        ],
      },
    },
  ]);
  check(
    "a cluster of six structures earns a launcher even with no enemy silos",
    sent.some((i) => i.unit === UnitType.SAMLauncher),
    JSON.stringify(sent.map((s) => s.type + ":" + s.unit)),
  );

  console.log("\n31. structures spread out");
  // Seven cities in one pocket is one warhead away from no cities.
  me._units.length = 0;
  const cluster = bot.territory.interior[0];
  for (let k = 0; k < 5; k++)
    me._units.push(makeUnit(UnitType.City, cluster + k, me, 1, 0));
  const sites = bot.rankSites(V2, me, bot.territory.interior, 5);
  const distFromCluster = (t) => Math.sqrt(V2.euclideanDistSquared(t, cluster));
  const pickedAvg = sites.reduce((a, t) => a + distFromCluster(t), 0) / sites.length;
  const poolAvg2 =
    bot.territory.interior.reduce((a, t) => a + distFromCluster(t), 0) /
    bot.territory.interior.length;
  check(
    "new sites are pushed away from what we already built",
    pickedAvg > poolAvg2,
    "picked " + Math.round(pickedAvg) + " vs pool " + Math.round(poolAvg2),
  );

  console.log("\n32. infinite gold");
  // With every price at zero the trade-off disappears: build out to the caps.
  me._units.length = 0;
  me._gold = 0; // the lobby option zeroes prices, not the wallet
  bot._announcedFree = false;
  const freeSurvey = [];
  // Explicitly spread sites, so the 15-tile rule is not what limits the count.
  for (const [fx, fy] of [
    [85, 20],
    [105, 25],
    [85, 50],
    [105, 55],
    [85, 80],
    [105, 85],
  ]) {
    const t = game.ref(fx, fy);
    freeSurvey.push({
      tile: t,
      actions: {
        buildableUnits: [
          { type: UnitType.City, canBuild: t, canUpgrade: false, cost: 0n },
          { type: UnitType.MissileSilo, canBuild: t, canUpgrade: false, cost: 0n },
          { type: UnitType.SAMLauncher, canBuild: t, canUpgrade: false, cost: 0n },
        ],
      },
    });
  }
  bot.assess(V2, me);
  sent.length = 0;
  bot.spendGold(V2, me, freeSurvey);
  const freeBuys = sent.filter((i) => i.type === "build_unit");
  check(
    "buys far more per cycle when nothing costs anything",
    freeBuys.length >= 4,
    "bought " + freeBuys.length,
  );
  check(
    "and still spaces them 15 tiles apart as the game requires",
    freeBuys.every((a, i) =>
      freeBuys.every(
        (b, j) => i === j || V2.euclideanDistSquared(a.tile, b.tile) >= 15 * 15,
      ),
    ),
  );
  check("it notices the free board by itself", bot._announcedFree === true);

  console.log("\n33. it expands from the very first tick");
  // A human spawns with 25,000 troops against a cap of ~102,000 — 24%, which
  // the band table calls "critical". Refusing to expand there meant never
  // starting at all, which is exactly what was reported.
  owner.fill(0);
  for (let y = 48; y <= 52; y++)
    for (let x = 100; x <= 104; x++) if (LAND[y * W + x]) owner[y * W + x] = 1;
  game._players = [me];
  me._units.length = 0;
  me._in = [];
  me._out = [];
  me._gold = 0;
  me._troops = 25000;
  me._spawned = true;
  game._spawn = false;
  bot.territory = null;
  bot.islands = null;
  bot.next = {};
  bot.running = true;
  sent.length = 0;
  await pump(40);
  const opener = sent.find((i) => i.type === "attack" && i.targetID === null);
  check(
    "a fresh spawn attacks neutral ground immediately",
    !!opener,
    JSON.stringify(sent.map((s) => s.type)),
  );
  check(
    "and commits a real share of a 25k army",
    !!opener && opener.troops > 8000,
    opener ? "sent " + opener.troops : "",
  );
  bot.stop();

  console.log(
    "\n" +
      (failures === 0
        ? "\x1b[32mall checks passed\x1b[0m"
        : "\x1b[31m" + failures + " check(s) failed\x1b[0m"),
  );
  process.exit(failures === 0 ? 0 : 1);
})();
