const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ─── Rol tərifləri ────────────────────────────────────────
const ROLES = {
  mafia:         { name: "Mafia",         team: "mafia",   group: "bad"     },
  detective:     { name: "Dedektiv",      team: "town",    group: "good"    },
  doctor:        { name: "Həkim",         team: "town",    group: "good"    },
  citizen:       { name: "Vətəndaş",      team: "town",    group: "good"    },
  mayor:         { name: "Mayor",         team: "town",    group: "good"    },
  maniac:        { name: "Manyak",        team: "maniac",  group: "neutral" },
  serialkiller:  { name: "Serial Killer", team: "sk",      group: "neutral" },
  thief:         { name: "Oğru",          team: "dynamic", group: "neutral" },
};

// Default rol paylanması (host konfiqurasiya etməsə)
function getDefaultDistribution(count) {
  if (count <= 4)  return { mafia:1, detective:1, doctor:1, citizen:1 };
  if (count <= 6)  return { mafia:2, detective:1, doctor:1, citizen: count-4 };
  if (count <= 9)  return { mafia:2, detective:1, doctor:1, citizen: count-4 };
  return           { mafia:3, detective:1, doctor:1, citizen: count-5 };
}

// Konfiqurasiyanı validate et — ümumi say oyunçu sayına bərabər olmalıdır
function validateConfig(config, playerCount) {
  // Moderator oyunçu sayına daxildir amma rol almır (sadəcə müşahidəçi deyil, rol alır)
  const total = Object.values(config).reduce((s, v) => s + (parseInt(v) || 0), 0);
  if (total !== playerCount) return { ok: false, error: `Rol sayı (${total}) oyunçu sayına (${playerCount}) bərabər olmalıdır` };
  if ((config.mafia || 0) < 1) return { ok: false, error: "Minimum 1 Mafia olmalıdır" };
  return { ok: true };
}

function buildRoleArray(config) {
  const arr = [];
  for (const [role, count] of Object.entries(config)) {
    for (let i = 0; i < (parseInt(count) || 0); i++) arr.push(role);
  }
  return arr;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Otaqlar ──────────────────────────────────────────────
const rooms = {};

function createRoom(code, ownerSocketId) {
  rooms[code] = {
    code,
    owner: ownerSocketId,
    phase: "lobby",
    players: {},        // socketId → PlayerObj
    roleConfig: null,   // host tərəfindən təyin edilir
    nominations: {},
    nightActions: {},
    thiefStolen: {},    // { thiefId: { targetId, stolenRole } }
    mayorIds: new Set(),
    timer: null,
    roundNum: 0,
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code]; }

function addPlayer(room, socket, name) {
  room.players[socket.id] = {
    id:        socket.id,
    name,
    role:      null,
    alive:     true,
    protected: false,
    connected: true,
    joinedAt:  Date.now(),
  };
}

function removePlayer(room, socketId) {
  delete room.players[socketId];
}

function roomPlayerList(room) {
  return Object.values(room.players).map(p => ({
    id:        p.id,
    name:      p.name,
    alive:     p.alive,
    connected: p.connected,
  }));
}

function alivePlayers(room) {
  return Object.values(room.players).filter(p => p.alive);
}

// ─── Qalib yoxlaması ──────────────────────────────────────
function checkWin(room) {
  const alive = alivePlayers(room);

  // Serial Killer tək qalıbsa qalib
  const skAlive = alive.filter(p => p.role === "serialkiller");
  if (skAlive.length > 0 && alive.length === skAlive.length) return "sk";

  // Manyak tək qalıbsa qalib
  const maniacAlive = alive.filter(p => p.role === "maniac");
  if (maniacAlive.length > 0 && alive.length === maniacAlive.length) return "maniac";

  const mafiaAlive = alive.filter(p => {
    const effectiveTeam = getEffectiveTeam(room, p);
    return effectiveTeam === "mafia";
  }).length;

  const townAlive = alive.filter(p => {
    const effectiveTeam = getEffectiveTeam(room, p);
    return effectiveTeam === "town";
  }).length;

  // Bütün Mafia + SK + Manyak ölübsə şəhər qazanır
  const threatsAlive = alive.filter(p => {
    const t = getEffectiveTeam(room, p);
    return t === "mafia" || p.role === "serialkiller" || p.role === "maniac";
  }).length;
  if (threatsAlive === 0) return "town";

  if (mafiaAlive >= townAlive && skAlive.length === 0 && maniacAlive.length === 0) return "mafia";

  return null;
}

// Oğrunun effektiv tərəfi oğurladığı rola görə
function getEffectiveTeam(room, player) {
  if (player.role === "thief") {
    const stolen = room.thiefStolen[player.id];
    if (stolen) return ROLES[stolen.stolenRole]?.team || "town";
    return "town"; // hələ oğurlamamış
  }
  return ROLES[player.role]?.team || "town";
}

function emitToRoom(room, event, data) {
  io.to(room.code).emit(event, data);
}

// ─── Oyunu başlat ─────────────────────────────────────────
function startGame(room) {
  const players = Object.values(room.players);
  if (players.length < 4) return { error: "Minimum 4 oyunçu lazımdır" };

  let roleArr;
  if (room.roleConfig) {
    const v = validateConfig(room.roleConfig, players.length);
    if (!v.ok) return { error: v.error };
    roleArr = buildRoleArray(room.roleConfig);
  } else {
    const dist = getDefaultDistribution(players.length);
    roleArr = buildRoleArray(dist);
  }

  const shuffledRoles = shuffle(roleArr);
  players.forEach((p, i) => {
    p.role      = shuffledRoles[i];
    p.alive     = true;
    p.protected = false;
  });

  room.phase       = "night";
  room.roundNum    = 1;
  room.nightActions = {};
  room.nominations  = {};
  room.thiefStolen  = {};
  room.mayorIds     = new Set(
    Object.values(room.players).filter(p => p.role === "mayor").map(p => p.id)
  );

  // Hər oyunçuya rolunu göndər
  players.forEach(p => {
    const mafiaTeam = p.role === "mafia"
      ? Object.values(room.players)
          .filter(x => x.role === "mafia" && x.id !== p.id)
          .map(x => x.name)
      : [];

    io.to(p.id).emit("game:role", {
      role:      p.role,
      roleName:  ROLES[p.role].name,
      mafiaTeam,
    });
  });

  emitToRoom(room, "game:started", { playerCount: players.length });
  startNight(room);
}

// ─── GECƏ ─────────────────────────────────────────────────
function startNight(room) {
  room.phase        = "night";
  room.nightActions = {};
  Object.values(room.players).forEach(p => { p.protected = false; });

  emitToRoom(room, "phase:night", {
    players:  roomPlayerList(room),
    roundNum: room.roundNum,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveNight(room), 40_000);
}

function resolveNight(room) {
  clearTimeout(room.timer);
  const actions = room.nightActions;

  // 1. Oğru — əvvəlcə rolu oğurlasın
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "thief" || !actor.alive) return;
    const target = room.players[targetId];
    if (!target || target.role === "thief") return;

    const stolenRole = target.role;
    room.thiefStolen[actorId] = { targetId, stolenRole };
    target.role = "citizen"; // hədəf adi vətəndaş olur

    io.to(actorId).emit("thief:result", {
      targetName: target.name,
      stolenRole,
      stolenRoleName: ROLES[stolenRole]?.name,
    });
    io.to(targetId).emit("thief:stolen", {
      message: "Rolunuz oğurlanıb! Artıq Vətəndaşsınız.",
    });
  });

  // 2. Həkim qoruması
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    const effectiveRole = getEffectiveRoleForAction(room, actorId);
    if (effectiveRole !== "doctor" || !actor?.alive) return;
    if (room.players[targetId]) room.players[targetId].protected = true;
  });

  // 3. Mafia hədəfi
  const mafiaVotes = {};
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    const effectiveTeam = getEffectiveTeam(room, actor);
    if (effectiveTeam !== "mafia" || !actor?.alive) return;
    mafiaVotes[targetId] = (mafiaVotes[targetId] || 0) + 1;
  });

  let mafiaKillId = null;
  if (Object.keys(mafiaVotes).length) {
    mafiaKillId = Object.entries(mafiaVotes).sort((a, b) => b[1] - a[1])[0][0];
  }

  // 4. Serial Killer hədəfi (ayrıca öldürür)
  let skKillId = null;
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "serialkiller" || !actor.alive) return;
    skKillId = targetId;
  });

  // 5. Manyak hədəfi (öldürür)
  let maniacKillId = null;
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "maniac" || !actor.alive) return;
    maniacKillId = targetId;
  });

  // 6. Dedektiv nəticəsi
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    const effectiveRole = getEffectiveRoleForAction(room, actorId);
    if (effectiveRole !== "detective" || !actor?.alive) return;
    const target = room.players[targetId];
    if (!target) return;
    const effectiveTeam = getEffectiveTeam(room, target);
    io.to(actorId).emit("detective:result", {
      targetName: target.name,
      isMafia: effectiveTeam === "mafia",
      team: effectiveTeam,
    });
  });

  // 7. Öldürmələri tətbiq et
  const killed = [];

  function tryKill(id, source) {
    const p = room.players[id];
    if (!p || !p.alive) return;
    if (p.protected) { killed.push({ name: p.name, saved: true, source }); return; }
    p.alive = false;
    killed.push({ name: p.name, saved: false, source });
  }

  if (mafiaKillId)  tryKill(mafiaKillId,  "mafia");
  if (skKillId)     tryKill(skKillId,     "sk");
  if (maniacKillId) tryKill(maniacKillId, "maniac");

  const winner = checkWin(room);
  if (winner) return endGame(room, winner);

  startDay(room, killed);
}

// Oğru oğurladıqdan sonra əsas rolu ilə hərəkət edir
function getEffectiveRoleForAction(room, actorId) {
  const player = room.players[actorId];
  if (!player) return null;
  if (player.role === "thief") {
    const stolen = room.thiefStolen[actorId];
    return stolen ? stolen.stolenRole : "thief";
  }
  return player.role;
}

// ─── GÜNDÜZ ───────────────────────────────────────────────
function startDay(room, killed) {
  room.phase       = "day";
  room.nominations = {};
  room.roundNum++;

  emitToRoom(room, "phase:day", {
    killed,
    players:  roomPlayerList(room),
    roundNum: room.roundNum,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => startVote(room), 60_000);
}

// ─── SƏSVERMƏs ────────────────────────────────────────────
function startVote(room) {
  room.phase        = "vote";
  room.nominations  = {};

  emitToRoom(room, "phase:vote", { players: roomPlayerList(room) });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveVote(room), 30_000);
}

function resolveVote(room) {
  clearTimeout(room.timer);

  // Mayor səsi 2 sayılır
  const voteCount = {};
  Object.entries(room.nominations).forEach(([targetId, voters]) => {
    let total = 0;
    voters.forEach(vid => {
      total += room.mayorIds.has(vid) ? 2 : 1;
    });
    voteCount[targetId] = total;
  });

  let maxVotes = 0;
  let eliminatedId = null;
  Object.entries(voteCount).forEach(([tid, count]) => {
    if (count > maxVotes) { maxVotes = count; eliminatedId = tid; }
  });

  // Bərabər səs — heç kim xaric edilmir
  const maxCount = Object.values(voteCount).filter(v => v === maxVotes).length;
  if (maxCount > 1) eliminatedId = null;

  let eliminatedName = null;
  let eliminatedRole = null;
  if (eliminatedId && room.players[eliminatedId]) {
    room.players[eliminatedId].alive = false;
    eliminatedName = room.players[eliminatedId].name;
    eliminatedRole = room.players[eliminatedId].role;
  }

  const winner = checkWin(room);
  if (winner) return endGame(room, winner);

  emitToRoom(room, "vote:result", {
    eliminatedName,
    eliminatedRole,
    eliminatedRoleName: eliminatedRole ? ROLES[eliminatedRole]?.name : null,
    tie: maxCount > 1,
  });

  setTimeout(() => startNight(room), 4000);
}

// ─── OYUN SONU ────────────────────────────────────────────
function endGame(room, winner) {
  clearTimeout(room.timer);
  room.phase = "ended";

  const rolesReveal = Object.values(room.players).map(p => {
    const stolen = room.thiefStolen[p.id];
    return {
      name:          p.name,
      role:          p.role,
      roleName:      ROLES[p.role]?.name ?? p.role,
      alive:         p.alive,
      stolenRole:    stolen ? stolen.stolenRole : null,
      stolenRoleName:stolen ? ROLES[stolen.stolenRole]?.name : null,
    };
  });

  emitToRoom(room, "game:ended", { winner, rolesReveal });
}

// ─── Yardımçılar ──────────────────────────────────────────
function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function findRoomOf(socketId) {
  for (const [, room] of Object.entries(rooms)) {
    if (room.players[socketId]) return room.code;
  }
  return null;
}

// ─── Socket.IO ────────────────────────────────────────────
io.on("connection", socket => {
  console.log("Qoşuldu:", socket.id);

  // Otaq yarat
  socket.on("room:create", ({ name }, cb) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const room = createRoom(code, socket.id);
    addPlayer(room, socket, name);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name     = name;

    cb({ ok: true, code });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  // Otağa qoşul
  socket.on("room:join", ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room)                                  return cb({ ok: false, error: "Otaq tapılmadı" });
    if (room.phase !== "lobby")                 return cb({ ok: false, error: "Oyun artıq başlayıb" });
    if (Object.keys(room.players).length >= 15) return cb({ ok: false, error: "Otaq doludur" });

    addPlayer(room, socket, name);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name     = name;

    cb({ ok: true, code });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  // Sessiya bərpası — reconnect
  socket.on("room:rejoin", ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ ok: false, error: "Otaq tapılmadı" });

    // Eyni adlı oyunçunu tap
    const existing = Object.values(room.players).find(p => p.name === name);
    if (existing) {
      // Köhnə socketId-ni sil, yenisini əlavə et
      delete room.players[existing.id];
      existing.id = socket.id;
      room.players[socket.id] = existing;
      existing.connected = true;

      // Otaq sahibi idisə yenilə
      if (room.owner === existing.id || !room.players[room.owner]) {
        room.owner = socket.id;
      }
    } else {
      if (room.phase !== "lobby") return cb({ ok: false, error: "Oyun başlayıb, qoşulmaq olmaz" });
      addPlayer(room, socket, name);
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name     = name;

    const myPlayer = room.players[socket.id];

    cb({
      ok:         true,
      phase:      room.phase,
      owner:      room.owner,
      players:    roomPlayerList(room),
      myRole:     myPlayer?.role,
      myRoleName: myPlayer?.role ? ROLES[myPlayer.role]?.name : null,
      roleConfig: room.roleConfig,
      roundNum:   room.roundNum,
      mafiaTeam:  myPlayer?.role === "mafia"
        ? Object.values(room.players)
            .filter(x => x.role === "mafia" && x.id !== socket.id)
            .map(x => x.name)
        : [],
    });

    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  // Host rol konfiqurasiyasını təyin edir
  socket.on("room:setConfig", ({ config }, cb) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room)                    return cb?.({ ok: false, error: "Otaq yoxdur" });
    if (room.owner !== socket.id) return cb?.({ ok: false, error: "Yalnız sahibi edə bilər" });
    if (room.phase !== "lobby")   return cb?.({ ok: false, error: "Oyun başlayıb" });

    const playerCount = Object.keys(room.players).length;
    const v = validateConfig(config, playerCount);
    if (!v.ok) return cb?.({ ok: false, error: v.error });

    room.roleConfig = config;
    emitToRoom(room, "room:configUpdated", { config });
    cb?.({ ok: true });
  });

  // Oyunu başlat
  socket.on("game:start", (_, cb) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room)                    return cb?.({ ok: false, error: "Otaq yoxdur" });
    if (room.owner !== socket.id) return cb?.({ ok: false, error: "Yalnız sahibi başlada bilər" });

    const result = startGame(room);
    if (result?.error) return cb?.({ ok: false, error: result.error });
    cb?.({ ok: true });
  });

  // Gecə aksiyası
  socket.on("night:action", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "night") return;
    const actor = room.players[socket.id];
    if (!actor?.alive) return;
    room.nightActions[socket.id] = targetId;
  });

  // Gündüz nominasiya
  socket.on("day:nominate", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "day") return;
    if (!room.players[socket.id]?.alive) return;

    emitToRoom(room, "day:nominated", {
      nominator:  room.players[socket.id].name,
      targetId,
      targetName: room.players[targetId]?.name,
    });

    clearTimeout(room.timer);
    startVote(room);
  });

  // Səsvermə
  socket.on("vote:cast", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "vote") return;
    if (!room.players[socket.id]?.alive) return;

    if (!room.nominations[targetId]) room.nominations[targetId] = [];
    if (!room.nominations[targetId].includes(socket.id)) {
      room.nominations[targetId].push(socket.id);
    }

    // Mayor səsi 2 sayılır ama göstərilmir (gizli)
    const displayVotes = {};
    Object.entries(room.nominations).forEach(([tid, voters]) => {
      let total = 0;
      voters.forEach(vid => { total += room.mayorIds.has(vid) ? 2 : 1; });
      displayVotes[tid] = total;
    });

    emitToRoom(room, "vote:update", { nominations: displayVotes });
  });

  // Moderator — növbəti fazaya keç (manual override)
  socket.on("mod:nextPhase", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.owner !== socket.id) return;

    clearTimeout(room.timer);
    if (room.phase === "night") resolveNight(room);
    else if (room.phase === "day") startVote(room);
    else if (room.phase === "vote") resolveVote(room);
  });

  // Moderator — oyunçunu xaric et
  socket.on("mod:eliminate", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.owner !== socket.id) return;
    const target = room.players[targetId];
    if (!target || !target.alive) return;

    target.alive = false;
    emitToRoom(room, "mod:eliminated", { name: target.name });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });

    const winner = checkWin(room);
    if (winner) endGame(room, winner);
  });

  // Disconnect
  socket.on("disconnect", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    if (room.phase === "lobby") {
      // Lobidədirsə tamamilə çıxart
      removePlayer(room, socket.id);
      if (Object.keys(room.players).length === 0) {
        clearTimeout(room.timer); delete rooms[code]; return;
      }
    } else {
      // Oyun gedərkən sadəcə offline işarələ (reconnect üçün saxla)
      player.connected = false;
    }

    if (room.owner === socket.id) {
      const next = Object.values(room.players).find(p => p.id !== socket.id);
      if (next) room.owner = next.id;
    }

    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
    if (room.phase !== "lobby") {
      emitToRoom(room, "player:disconnected", { name: player.name });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));  if ((config.mafia || 0) < 1) return { ok: false, error: "Minimum 1 Mafia olmalıdır" };
  return { ok: true };
}

function buildRoleArray(config) {
  const arr = [];
  for (const [role, count] of Object.entries(config)) {
    for (let i = 0; i < (parseInt(count) || 0); i++) arr.push(role);
  }
  return arr;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Otaqlar ──────────────────────────────────────────────
const rooms = {};

function createRoom(code, ownerSocketId) {
  rooms[code] = {
    code,
    owner: ownerSocketId,
    phase: "lobby",
    players: {},        // socketId → PlayerObj
    roleConfig: null,   // host tərəfindən təyin edilir
    nominations: {},
    nightActions: {},
    thiefStolen: {},    // { thiefId: { targetId, stolenRole } }
    mayorIds: new Set(),
    timer: null,
    roundNum: 0,
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code]; }

function addPlayer(room, socket, name) {
  room.players[socket.id] = {
    id:        socket.id,
    name,
    role:      null,
    alive:     true,
    protected: false,
    connected: true,
    joinedAt:  Date.now(),
  };
}

function removePlayer(room, socketId) {
  delete room.players[socketId];
}

function roomPlayerList(room) {
  return Object.values(room.players).map(p => ({
    id:        p.id,
    name:      p.name,
    alive:     p.alive,
    connected: p.connected,
  }));
}

function alivePlayers(room) {
  return Object.values(room.players).filter(p => p.alive);
}

// ─── Qalib yoxlaması ──────────────────────────────────────
function checkWin(room) {
  const alive = alivePlayers(room);

  // Serial Killer tək qalıbsa qalib
  const skAlive = alive.filter(p => p.role === "serialkiller");
  if (skAlive.length > 0 && alive.length === skAlive.length) return "sk";

  // Manyak tək qalıbsa qalib
  const maniacAlive = alive.filter(p => p.role === "maniac");
  if (maniacAlive.length > 0 && alive.length === maniacAlive.length) return "maniac";

  const mafiaAlive = alive.filter(p => {
    const effectiveTeam = getEffectiveTeam(room, p);
    return effectiveTeam === "mafia";
  }).length;

  const townAlive = alive.filter(p => {
    const effectiveTeam = getEffectiveTeam(room, p);
    return effectiveTeam === "town";
  }).length;

  // Bütün Mafia + SK + Manyak ölübsə şəhər qazanır
  const threatsAlive = alive.filter(p => {
    const t = getEffectiveTeam(room, p);
    return t === "mafia" || p.role === "serialkiller" || p.role === "maniac";
  }).length;
  if (threatsAlive === 0) return "town";

  if (mafiaAlive >= townAlive && skAlive.length === 0 && maniacAlive.length === 0) return "mafia";

  return null;
}

// Oğrunun effektiv tərəfi oğurladığı rola görə
function getEffectiveTeam(room, player) {
  if (player.role === "thief") {
    const stolen = room.thiefStolen[player.id];
    if (stolen) return ROLES[stolen.stolenRole]?.team || "town";
    return "town"; // hələ oğurlamamış
  }
  return ROLES[player.role]?.team || "town";
}

function emitToRoom(room, event, data) {
  io.to(room.code).emit(event, data);
}

// ─── Oyunu başlat ─────────────────────────────────────────
function startGame(room) {
  const players = Object.values(room.players);
  if (players.length < 4) return { error: "Minimum 4 oyunçu lazımdır" };

  let roleArr;
  if (room.roleConfig) {
    const v = validateConfig(room.roleConfig, players.length);
    if (!v.ok) return { error: v.error };
    roleArr = buildRoleArray(room.roleConfig);
  } else {
    const dist = getDefaultDistribution(players.length);
    roleArr = buildRoleArray(dist);
  }

  const shuffledRoles = shuffle(roleArr);
  players.forEach((p, i) => {
    p.role      = shuffledRoles[i];
    p.alive     = true;
    p.protected = false;
  });

  room.phase       = "night";
  room.roundNum    = 1;
  room.nightActions = {};
  room.nominations  = {};
  room.thiefStolen  = {};
  room.mayorIds     = new Set(
    Object.values(room.players).filter(p => p.role === "mayor").map(p => p.id)
  );

  // Hər oyunçuya rolunu göndər
  players.forEach(p => {
    const mafiaTeam = p.role === "mafia"
      ? Object.values(room.players)
          .filter(x => x.role === "mafia" && x.id !== p.id)
          .map(x => x.name)
      : [];

    io.to(p.id).emit("game:role", {
      role:      p.role,
      roleName:  ROLES[p.role].name,
      mafiaTeam,
    });
  });

  emitToRoom(room, "game:started", { playerCount: players.length });
  startNight(room);
}

// ─── GECƏ ─────────────────────────────────────────────────
function startNight(room) {
  room.phase        = "night";
  room.nightActions = {};
  Object.values(room.players).forEach(p => { p.protected = false; });

  emitToRoom(room, "phase:night", {
    players:  roomPlayerList(room),
    roundNum: room.roundNum,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveNight(room), 40_000);
}

function resolveNight(room) {
  clearTimeout(room.timer);
  const actions = room.nightActions;

  // 1. Oğru — əvvəlcə rolu oğurlasın
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "thief" || !actor.alive) return;
    const target = room.players[targetId];
    if (!target || target.role === "thief") return;

    const stolenRole = target.role;
    room.thiefStolen[actorId] = { targetId, stolenRole };
    target.role = "citizen"; // hədəf adi vətəndaş olur

    io.to(actorId).emit("thief:result", {
      targetName: target.name,
      stolenRole,
      stolenRoleName: ROLES[stolenRole]?.name,
    });
    io.to(targetId).emit("thief:stolen", {
      message: "Rolunuz oğurlanıb! Artıq Vətəndaşsınız.",
    });
  });

  // 2. Həkim qoruması
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    const effectiveRole = getEffectiveRoleForAction(room, actorId);
    if (effectiveRole !== "doctor" || !actor?.alive) return;
    if (room.players[targetId]) room.players[targetId].protected = true;
  });

  // 3. Mafia hədəfi
  const mafiaVotes = {};
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    const effectiveTeam = getEffectiveTeam(room, actor);
    if (effectiveTeam !== "mafia" || !actor?.alive) return;
    mafiaVotes[targetId] = (mafiaVotes[targetId] || 0) + 1;
  });

  let mafiaKillId = null;
  if (Object.keys(mafiaVotes).length) {
    mafiaKillId = Object.entries(mafiaVotes).sort((a, b) => b[1] - a[1])[0][0];
  }

  // 4. Serial Killer hədəfi (ayrıca öldürür)
  let skKillId = null;
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "serialkiller" || !actor.alive) return;
    skKillId = targetId;
  });

  // 5. Manyak hədəfi (öldürür)
  let maniacKillId = null;
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "maniac" || !actor.alive) return;
    maniacKillId = targetId;
  });

  // 6. Dedektiv nəticəsi
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    const effectiveRole = getEffectiveRoleForAction(room, actorId);
    if (effectiveRole !== "detective" || !actor?.alive) return;
    const target = room.players[targetId];
    if (!target) return;
    const effectiveTeam = getEffectiveTeam(room, target);
    io.to(actorId).emit("detective:result", {
      targetName: target.name,
      isMafia: effectiveTeam === "mafia",
      team: effectiveTeam,
    });
  });

  // 7. Öldürmələri tətbiq et
  const killed = [];

  function tryKill(id, source) {
    const p = room.players[id];
    if (!p || !p.alive) return;
    if (p.protected) { killed.push({ name: p.name, saved: true, source }); return; }
    p.alive = false;
    killed.push({ name: p.name, saved: false, source });
  }

  if (mafiaKillId)  tryKill(mafiaKillId,  "mafia");
  if (skKillId)     tryKill(skKillId,     "sk");
  if (maniacKillId) tryKill(maniacKillId, "maniac");

  const winner = checkWin(room);
  if (winner) return endGame(room, winner);

  startDay(room, killed);
}

// Oğru oğurladıqdan sonra əsas rolu ilə hərəkət edir
function getEffectiveRoleForAction(room, actorId) {
  const player = room.players[actorId];
  if (!player) return null;
  if (player.role === "thief") {
    const stolen = room.thiefStolen[actorId];
    return stolen ? stolen.stolenRole : "thief";
  }
  return player.role;
}

// ─── GÜNDÜZ ───────────────────────────────────────────────
function startDay(room, killed) {
  room.phase       = "day";
  room.nominations = {};
  room.roundNum++;

  emitToRoom(room, "phase:day", {
    killed,
    players:  roomPlayerList(room),
    roundNum: room.roundNum,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => startVote(room), 60_000);
}

// ─── SƏSVERMƏs ────────────────────────────────────────────
function startVote(room) {
  room.phase        = "vote";
  room.nominations  = {};

  emitToRoom(room, "phase:vote", { players: roomPlayerList(room) });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveVote(room), 30_000);
}

function resolveVote(room) {
  clearTimeout(room.timer);

  // Mayor səsi 2 sayılır
  const voteCount = {};
  Object.entries(room.nominations).forEach(([targetId, voters]) => {
    let total = 0;
    voters.forEach(vid => {
      total += room.mayorIds.has(vid) ? 2 : 1;
    });
    voteCount[targetId] = total;
  });

  let maxVotes = 0;
  let eliminatedId = null;
  Object.entries(voteCount).forEach(([tid, count]) => {
    if (count > maxVotes) { maxVotes = count; eliminatedId = tid; }
  });

  // Bərabər səs — heç kim xaric edilmir
  const maxCount = Object.values(voteCount).filter(v => v === maxVotes).length;
  if (maxCount > 1) eliminatedId = null;

  let eliminatedName = null;
  let eliminatedRole = null;
  if (eliminatedId && room.players[eliminatedId]) {
    room.players[eliminatedId].alive = false;
    eliminatedName = room.players[eliminatedId].name;
    eliminatedRole = room.players[eliminatedId].role;
  }

  const winner = checkWin(room);
  if (winner) return endGame(room, winner);

  emitToRoom(room, "vote:result", {
    eliminatedName,
    eliminatedRole,
    eliminatedRoleName: eliminatedRole ? ROLES[eliminatedRole]?.name : null,
    tie: maxCount > 1,
  });

  setTimeout(() => startNight(room), 4000);
}

// ─── OYUN SONU ────────────────────────────────────────────
function endGame(room, winner) {
  clearTimeout(room.timer);
  room.phase = "ended";

  const rolesReveal = Object.values(room.players).map(p => {
    const stolen = room.thiefStolen[p.id];
    return {
      name:          p.name,
      role:          p.role,
      roleName:      ROLES[p.role]?.name ?? p.role,
      alive:         p.alive,
      stolenRole:    stolen ? stolen.stolenRole : null,
      stolenRoleName:stolen ? ROLES[stolen.stolenRole]?.name : null,
    };
  });

  emitToRoom(room, "game:ended", { winner, rolesReveal });
}

// ─── Yardımçılar ──────────────────────────────────────────
function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function findRoomOf(socketId) {
  for (const [, room] of Object.entries(rooms)) {
    if (room.players[socketId]) return room.code;
  }
  return null;
}

// ─── Socket.IO ────────────────────────────────────────────
io.on("connection", socket => {
  console.log("Qoşuldu:", socket.id);

  // Otaq yarat
  socket.on("room:create", ({ name }, cb) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const room = createRoom(code, socket.id);
    addPlayer(room, socket, name);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name     = name;

    cb({ ok: true, code });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  // Otağa qoşul
  socket.on("room:join", ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room)                                  return cb({ ok: false, error: "Otaq tapılmadı" });
    if (room.phase !== "lobby")                 return cb({ ok: false, error: "Oyun artıq başlayıb" });
    if (Object.keys(room.players).length >= 15) return cb({ ok: false, error: "Otaq doludur" });

    addPlayer(room, socket, name);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name     = name;

    cb({ ok: true, code });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  // Sessiya bərpası — reconnect
  socket.on("room:rejoin", ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ ok: false, error: "Otaq tapılmadı" });

    // Eyni adlı oyunçunu tap
    const existing = Object.values(room.players).find(p => p.name === name);
    if (existing) {
      // Köhnə socketId-ni sil, yenisini əlavə et
      delete room.players[existing.id];
      existing.id = socket.id;
      room.players[socket.id] = existing;
      existing.connected = true;

      // Otaq sahibi idisə yenilə
      if (room.owner === existing.id || !room.players[room.owner]) {
        room.owner = socket.id;
      }
    } else {
      if (room.phase !== "lobby") return cb({ ok: false, error: "Oyun başlayıb, qoşulmaq olmaz" });
      addPlayer(room, socket, name);
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name     = name;

    const myPlayer = room.players[socket.id];

    cb({
      ok:         true,
      phase:      room.phase,
      owner:      room.owner,
      players:    roomPlayerList(room),
      myRole:     myPlayer?.role,
      myRoleName: myPlayer?.role ? ROLES[myPlayer.role]?.name : null,
      roleConfig: room.roleConfig,
      roundNum:   room.roundNum,
      mafiaTeam:  myPlayer?.role === "mafia"
        ? Object.values(room.players)
            .filter(x => x.role === "mafia" && x.id !== socket.id)
            .map(x => x.name)
        : [],
    });

    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  // Host rol konfiqurasiyasını təyin edir
  socket.on("room:setConfig", ({ config }, cb) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room)                    return cb?.({ ok: false, error: "Otaq yoxdur" });
    if (room.owner !== socket.id) return cb?.({ ok: false, error: "Yalnız sahibi edə bilər" });
    if (room.phase !== "lobby")   return cb?.({ ok: false, error: "Oyun başlayıb" });

    const playerCount = Object.keys(room.players).length;
    const v = validateConfig(config, playerCount);
    if (!v.ok) return cb?.({ ok: false, error: v.error });

    room.roleConfig = config;
    emitToRoom(room, "room:configUpdated", { config });
    cb?.({ ok: true });
  });

  // Oyunu başlat
  socket.on("game:start", (_, cb) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room)                    return cb?.({ ok: false, error: "Otaq yoxdur" });
    if (room.owner !== socket.id) return cb?.({ ok: false, error: "Yalnız sahibi başlada bilər" });

    const result = startGame(room);
    if (result?.error) return cb?.({ ok: false, error: result.error });
    cb?.({ ok: true });
  });

  // Gecə aksiyası
  socket.on("night:action", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "night") return;
    const actor = room.players[socket.id];
    if (!actor?.alive) return;
    room.nightActions[socket.id] = targetId;
  });

  // Gündüz nominasiya
  socket.on("day:nominate", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "day") return;
    if (!room.players[socket.id]?.alive) return;

    emitToRoom(room, "day:nominated", {
      nominator:  room.players[socket.id].name,
      targetId,
      targetName: room.players[targetId]?.name,
    });

    clearTimeout(room.timer);
    startVote(room);
  });

  // Səsvermə
  socket.on("vote:cast", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "vote") return;
    if (!room.players[socket.id]?.alive) return;

    if (!room.nominations[targetId]) room.nominations[targetId] = [];
    if (!room.nominations[targetId].includes(socket.id)) {
      room.nominations[targetId].push(socket.id);
    }

    // Mayor səsi 2 sayılır ama göstərilmir (gizli)
    const displayVotes = {};
    Object.entries(room.nominations).forEach(([tid, voters]) => {
      let total = 0;
      voters.forEach(vid => { total += room.mayorIds.has(vid) ? 2 : 1; });
      displayVotes[tid] = total;
    });

    emitToRoom(room, "vote:update", { nominations: displayVotes });
  });

  // Moderator — növbəti fazaya keç (manual override)
  socket.on("mod:nextPhase", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.owner !== socket.id) return;

    clearTimeout(room.timer);
    if (room.phase === "night") resolveNight(room);
    else if (room.phase === "day") startVote(room);
    else if (room.phase === "vote") resolveVote(room);
  });

  // Moderator — oyunçunu xaric et
  socket.on("mod:eliminate", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.owner !== socket.id) return;
    const target = room.players[targetId];
    if (!target || !target.alive) return;

    target.alive = false;
    emitToRoom(room, "mod:eliminated", { name: target.name });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });

    const winner = checkWin(room);
    if (winner) endGame(room, winner);
  });

  // Disconnect
  socket.on("disconnect", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    if (room.phase === "lobby") {
      // Lobidədirsə tamamilə çıxart
      removePlayer(room, socket.id);
      if (Object.keys(room.players).length === 0) {
        clearTimeout(room.timer); delete rooms[code]; return;
      }
    } else {
      // Oyun gedərkən sadəcə offline işarələ (reconnect üçün saxla)
      player.connected = false;
    }

    if (room.owner === socket.id) {
      const next = Object.values(room.players).find(p => p.id !== socket.id);
      if (next) room.owner = next.id;
    }

    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
    if (room.phase !== "lobby") {
      emitToRoom(room, "player:disconnected", { name: player.name });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));  return a;

// ─── Otaqlar ──────────────────────────────────────────────
const rooms = {};

function createRoom(code, ownerName, ownerSocket) {
  rooms[code] = {
    code,
    owner: ownerSocket,
    phase: "lobby",
    players: {},
    nominations: {},
    nightActions: {},
    timer: null,
  };
  return rooms[code];
}

function getRoom(code) { return rooms[code]; }

function addPlayer(room, socket, name) {
  room.players[socket.id] = {
    id: socket.id,
    name,
    role: null,
    alive: true,
    protected: false,
  };
}

function removePlayer(room, socketId) {
  delete room.players[socketId];
}

function roomPlayerList(room) {
  return Object.values(room.players).map((p) => ({
    id:    p.id,
    name:  p.name,
    alive: p.alive,
  }));
}

function alivePlayers(room) {
  return Object.values(room.players).filter((p) => p.alive);
}

function checkWin(room) {
  const alive = alivePlayers(room);
  const mafiaAlive = alive.filter((p) => p.role === "mafia").length;
  const townAlive  = alive.filter((p) => p.role !== "mafia").length;
  if (mafiaAlive === 0) return "town";
  if (mafiaAlive >= townAlive) return "mafia";
  return null;
}

function emitToRoom(room, event, data) {
  io.to(room.code).emit(event, data);
}

// ─── Faza idarəsi ─────────────────────────────────────────
function startGame(room) {
  const players = Object.values(room.players);
  if (players.length < 4) return { error: "Minimum 4 oyunçu lazımdır" };

  const roles = shuffle(getRoleDistribution(players.length));
  players.forEach((p, i) => {
    p.role  = roles[i];
    p.alive = true;
    p.protected = false;
  });

  room.phase = "night";
  room.nightActions = {};
  room.nominations = {};

  players.forEach((p) => {
    const mafiaTeam = p.role === "mafia"
      ? Object.values(room.players)
          .filter((x) => x.role === "mafia" && x.id !== p.id)
          .map((x) => x.name)
      : [];

    io.to(p.id).emit("game:role", {
      role:      p.role,
      roleName:  ROLES[p.role].name,
      mafiaTeam,
    });
  });

  emitToRoom(room, "game:started", { playerCount: players.length });
  startNight(room);
}

function startNight(room) {
  room.phase = "night";
  room.nightActions = {};
  Object.values(room.players).forEach((p) => { p.protected = false; });

  emitToRoom(room, "phase:night", { players: roomPlayerList(room) });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveNight(room), 40_000);
}

function resolveNight(room) {
  clearTimeout(room.timer);

  const actions = room.nightActions;
  let killedId = null;

  const mafiaVotes = {};
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role === "mafia") {
      mafiaVotes[targetId] = (mafiaVotes[targetId] || 0) + 1;
    }
  });

  if (Object.keys(mafiaVotes).length) {
    killedId = Object.entries(mafiaVotes).sort((a, b) => b[1] - a[1])[0][0];
  }

  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role === "doctor" && room.players[targetId]) {
      room.players[targetId].protected = true;
    }
  });

  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role === "detective" && room.players[targetId]) {
      const isMafia = room.players[targetId].role === "mafia";
      io.to(actorId).emit("detective:result", {
        targetName: room.players[targetId].name,
        isMafia,
      });
    }
  });

  let killedName = null;
  if (killedId && room.players[killedId]) {
    if (room.players[killedId].protected) {
      killedName = null;
    } else {
      room.players[killedId].alive = false;
      killedName = room.players[killedId].name;
    }
  }

  const winner = checkWin(room);
  if (winner) return endGame(room, winner);
  startDay(room, killedName);
}

function startDay(room, killedName) {
  room.phase = "day";
  room.nominations = {};

  emitToRoom(room, "phase:day", {
    killedName,
    players: roomPlayerList(room),
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => startVote(room), 60_000);
}

function startVote(room) {
  room.phase = "vote";
  room.nominations = {};

  emitToRoom(room, "phase:vote", { players: roomPlayerList(room) });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveVote(room), 30_000);
}

function resolveVote(room) {
  clearTimeout(room.timer);

  const votes = room.nominations;
  let maxVotes = 0;
  let eliminatedId = null;

  Object.entries(votes).forEach(([targetId, voters]) => {
    if (voters.length > maxVotes) {
      maxVotes     = voters.length;
      eliminatedId = targetId;
    }
  });

  let eliminatedName = null;
  if (eliminatedId && room.players[eliminatedId]) {
    room.players[eliminatedId].alive = false;
    eliminatedName = room.players[eliminatedId].name;
  }

  const winner = checkWin(room);
  if (winner) return endGame(room, winner);

  emitToRoom(room, "vote:result", { eliminatedName });
  setTimeout(() => startNight(room), 3000);
}

function endGame(room, winner) {
  clearTimeout(room.timer);
  room.phase = "ended";

  const rolesReveal = Object.values(room.players).map((p) => ({
    name:     p.name,
    role:     p.role,
    roleName: ROLES[p.role]?.name ?? p.role,
    alive:    p.alive,
  }));

  emitToRoom(room, "game:ended", { winner, rolesReveal });
}

function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function findRoomOf(socketId) {
  for (const [code, room] of Object.entries(rooms)) {
    if (room.players[socketId]) return code;
  }
  return null;
}

// ─── Socket.IO hadisələri ──────────────────────────────────
io.on("connection", (socket) => {
  console.log("Qoşuldu:", socket.id);

  socket.on("room:create", ({ name }, cb) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const room = createRoom(code, name, socket.id);
    addPlayer(room, socket, name);
    socket.join(code);
    socket.data.roomCode = code;

    cb({ ok: true, code });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  socket.on("room:join", ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room)                               return cb({ ok: false, error: "Otaq tapılmadı" });
    if (room.phase !== "lobby")              return cb({ ok: false, error: "Oyun artıq başlayıb" });
    if (Object.keys(room.players).length >= 15) return cb({ ok: false, error: "Otaq doludur" });

    addPlayer(room, socket, name);
    socket.join(code);
    socket.data.roomCode = code;

    cb({ ok: true, code });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  socket.on("room:rejoin", ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ ok: false, error: "Otaq tapılmadı" });

    // Eyni adlı oyunçunu tap (reconnect)
    const existing = Object.values(room.players).find(p => p.name === name);
    if (existing) {
      // Socket id yenilə
      room.players[existing.id] && delete room.players[existing.id];
      existing.id = socket.id;
      room.players[socket.id] = existing;
    } else {
      if (room.phase !== "lobby") return cb({ ok: false, error: "Oyun başlayıb, qoşulmaq olmaz" });
      addPlayer(room, socket, name);
    }

    socket.join(code);
    socket.data.roomCode = code;

    cb({
      ok: true,
      phase: room.phase,
      owner: room.owner,
      players: roomPlayerList(room),
      myRole: room.players[socket.id]?.role,
      myRoleName: ROLES[room.players[socket.id]?.role]?.name,
    });

    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  socket.on("game:start", (_, cb) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room)                    return cb?.({ ok: false, error: "Otaq yoxdur" });
    if (room.owner !== socket.id) return cb?.({ ok: false, error: "Yalnız sahibi başlada bilər" });

    const result = startGame(room);
    if (result?.error) return cb?.({ ok: false, error: result.error });
    cb?.({ ok: true });
  });

  socket.on("night:action", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "night") return;
    const actor = room.players[socket.id];
    if (!actor?.alive) return;
    room.nightActions[socket.id] = targetId;
  });

  socket.on("day:nominate", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "day") return;
    if (!room.players[socket.id]?.alive) return;

    emitToRoom(room, "day:nominated", {
      nominator:  room.players[socket.id].name,
      targetId,
      targetName: room.players[targetId]?.name,
    });

    clearTimeout(room.timer);
    startVote(room);
  });

  socket.on("vote:cast", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "vote") return;
    if (!room.players[socket.id]?.alive) return;

    if (!room.nominations[targetId]) room.nominations[targetId] = [];
    if (!room.nominations[targetId].includes(socket.id)) {
      room.nominations[targetId].push(socket.id);
    }

    emitToRoom(room, "vote:update", {
      nominations: Object.fromEntries(
        Object.entries(room.nominations).map(([tid, voters]) => [tid, voters.length])
      ),
    });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    const name = room.players[socket.id]?.name ?? "?";
    removePlayer(room, socket.id);

    if (Object.keys(room.players).length === 0) {
      clearTimeout(room.timer);
      delete rooms[code];
      return;
    }

    if (room.owner === socket.id) {
      room.owner = Object.keys(room.players)[0];
    }

    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
    emitToRoom(room, "player:left", { name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
