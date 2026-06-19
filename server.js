const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ─── Oyun sabitləri ───────────────────────────────────────
const ROLES = {
  mafia:     { name: "Mafia",     team: "mafia" },
  detective: { name: "Dedektiv",  team: "town"  },
  doctor:    { name: "Həkim",     team: "town"  },
  citizen:   { name: "Vətəndaş", team: "town"  },
};

function getRoleDistribution(count) {
  if (count <= 4)  return ["mafia", "detective", "doctor", "citizen"];
  if (count <= 6)  return ["mafia", "mafia", "detective", "doctor", "citizen", "citizen"];
  if (count <= 9)  return ["mafia", "mafia", "detective", "doctor", "citizen", "citizen", "citizen", "citizen", "citizen"];
  return [
    "mafia", "mafia", "mafia",
    "detective", "doctor",
    ...Array(count - 5).fill("citizen"),
  ];
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
