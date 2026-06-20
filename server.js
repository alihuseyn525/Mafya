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
  // Yaxşılar
  police:       { name: "Polis",          team: "town",    group: "good"    },
  lookout:      { name: "Gözətçi",        team: "town",    group: "good"    },
  trapper:      { name: "Tələçi",         team: "town",    group: "good"    },
  snitch:       { name: "Xəbərçi",        team: "town",    group: "good"    },
  provoker:     { name: "Provokatçı",     team: "town",    group: "good"    },
  tracker:      { name: "İzləyici",       team: "town",    group: "good"    },
  doctor:       { name: "Həkim",          team: "town",    group: "good"    },
  citizen:      { name: "Vətəndaş",       team: "town",    group: "good"    },
  // Pislər
  mafia:        { name: "Mafiya Üzvü",    team: "mafia",   group: "bad"     },
  cleaner:      { name: "Təmizçi",        team: "mafia",   group: "bad"     },
  blame:        { name: "İttihamçı",      team: "mafia",   group: "bad"     },
  roleblocker:  { name: "Blokçu",         team: "mafia",   group: "bad"     },
  // Neytral
  serialkiller: { name: "Serial Killer",  team: "sk",      group: "neutral" },
  bomber:       { name: "Bombacı",        team: "bomber",  group: "neutral" },
  thief:        { name: "Oğru",           team: "dynamic", group: "neutral" },
  haunter:      { name: "Ruh",            team: "haunter", group: "neutral" },
  survivor:     { name: "Sağqalan",       team: "survivor",group: "neutral" },
};

// Default rol paylanması
function getDefaultDistribution(count) {
  if (count <= 4)  return { mafia:1, police:1, doctor:1, citizen:1 };
  if (count <= 6)  return { mafia:2, police:1, doctor:1, citizen: count-4 };
  if (count <= 9)  return { mafia:2, police:1, doctor:1, citizen: count-4 };
  return           { mafia:3, police:1, doctor:1, citizen: count-5 };
}

function validateConfig(config, playerCount) {
  const total = Object.values(config).reduce((s, v) => s + (parseInt(v) || 0), 0);
  if (total !== playerCount) return { ok: false, error: `Rol sayı (${total}) oyunçu sayına (${playerCount}) bərabər olmalıdır` };
  const mafiaTotal = (config.mafia||0) + (config.cleaner||0) + (config.blame||0) + (config.roleblocker||0);
  if (mafiaTotal < 1) return { ok: false, error: "Minimum 1 Pis oyunçu olmalıdır" };
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
    players: {},
    roleConfig: null,
    nominations: {},
    nightActions: {},
    thiefStolen: {},
    trapSet: {},       // { trapperId: targetId } - Tələçinin qoyduğu tələlər
    trapCaught: {},    // { targetId: caughtId } - Tələyə düşənlər
    bombPlaced: {},    // { bomberId: targetId }
    snitchUsed: {},    // { snitchId: true }
    survivorSaved: {}, // { survivorId: true }
    provokePenalty:{}, // { targetId: +2 votes }
    blockedPlayers:[], // bu gecə bloklanmış socketId-lər
    cleanerHid: {},    // { deadId: true } - Təmizçi gizlətdi
    blameTargets: {},  // { deadId: true } - İttihamçı "mafiya" göstərdi
    haunterId: null,   // haunter öldükdən sonra aktiv
    haunterActive: false,
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
    diedAt:    p.diedAt ?? null,
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

  // Bomber tək qalıbsa qalib
  const bomberAlive = alive.filter(p => p.role === "bomber");
  if (bomberAlive.length > 0 && alive.length === bomberAlive.length) return "bomber";

  const mafiaAlive = alive.filter(p => {
    const effectiveTeam = getEffectiveTeam(room, p);
    return effectiveTeam === "mafia";
  }).length;

  const townAlive = alive.filter(p => {
    const effectiveTeam = getEffectiveTeam(room, p);
    return effectiveTeam === "town";
  }).length;

  // Bütün təhdidlər ölübsə şəhər qazanır
  const threatsAlive = alive.filter(p => {
    const t = getEffectiveTeam(room, p);
    return t === "mafia" || p.role === "serialkiller" || p.role === "bomber";
  }).length;
  if (threatsAlive === 0) return "town";

  if (mafiaAlive >= townAlive && skAlive.length === 0 && bomberAlive.length === 0) return "mafia";

  // Haunter qalib şərti: şəhər qalib gəlsin (haunter şəhərlə qalib gəlir)
  // Survivor - sonda sağ qalsa qalib (oyun bitəndə yoxlanılır)

  return null;
}

function getEffectiveTeam(room, player) {
  if (player.role === "thief") {
    const stolen = room.thiefStolen[player.id];
    if (stolen) return ROLES[stolen.stolenRole]?.team || "town";
    return "town";
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

  room.phase            = "night";
  room.roundNum         = 1;
  room.nightActions     = {};
  room.nominations      = {};
  room.thiefStolen      = {};
  room.trapSet          = {};
  room.trapCaught       = {};
  room.bombPlaced       = {};
  room.snitchUsed       = {};
  room.survivorSaved    = {};
  room.provokePenalty   = {};
  room.blockedPlayers   = [];
  room.cleanerHid       = {};
  room.blameTargets     = {};
  room.haunterId        = null;
  room.haunterActive    = false;

  // Mafiya komandası kimdir?
  const mafiaSide = ["mafia","cleaner","blame","roleblocker"];

  // Hər oyunçuya rolunu göndər
  players.forEach(p => {
    const mafiaTeam = mafiaSide.includes(p.role)
      ? Object.values(room.players)
          .filter(x => mafiaSide.includes(x.role) && x.id !== p.id)
          .map(x => ({ name: x.name, role: x.role, roleName: ROLES[x.role]?.name }))
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
  room.phase          = "night";
  room.nightActions   = {};
  room.blockedPlayers = [];
  Object.values(room.players).forEach(p => { p.protected = false; });

  // Gecəyə başlayarkən neçə aksiya gözləniləcəyini hesabla
  const actionRoles = ["mafia","cleaner","blame","roleblocker","police","lookout","trapper","snitch","tracker","doctor","serialkiller","bomber","thief"];
  const expectedActors = Object.values(room.players).filter(p =>
    p.alive && actionRoles.includes(p.role)
  );
  room.nightExpected = expectedActors.length;
  room.nightActed    = 0;

  emitToRoom(room, "phase:night", {
    players:  roomPlayerList(room),
    roundNum: room.roundNum,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveNight(room), 60_000);
}

function checkNightComplete(room) {
  // Bütün aktiv oyunçular aksiya göndərdisə gecəni bitir
  room.nightActed++;
  if (room.nightActed >= room.nightExpected) {
    clearTimeout(room.timer);
    setTimeout(() => resolveNight(room), 800); // qısa gecikmə
  }
}

function resolveNight(room) {
  clearTimeout(room.timer);
  if (room.phase !== "night") return;
  const actions = room.nightActions;

  // 1. Roleblocker — əvvəlcə kimləri bloklayacağını müəyyən et
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "roleblocker" || !actor.alive) return;
    if (!room.blockedPlayers.includes(targetId)) {
      room.blockedPlayers.push(targetId);
    }
    io.to(actorId).emit("ability:result", {
      type: "roleblocker",
      message: `${room.players[targetId]?.name || "Hədəf"} bloklandı.`
    });
  });

  // Police da bloklayır
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "police" || !actor.alive) return;
    if (!room.blockedPlayers.includes(targetId)) {
      room.blockedPlayers.push(targetId);
    }
    io.to(actorId).emit("ability:result", {
      type: "police",
      message: `${room.players[targetId]?.name || "Hədəf"} bloklandı — bu gecə öz qabiliyyətindən istifadə edə bilməyəcək.`
    });
  });

  // 2. Oğru — rolu oğurlasın (bloklanmamışsa)
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "thief" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    const target = room.players[targetId];
    if (!target || target.role === "thief") return;

    const stolenRole = target.role;
    room.thiefStolen[actorId] = { targetId, stolenRole };
    target.alive = false; // oğurlandıqda hədəf öldürülür
    target.diedAt = room.roundNum;
    target.role  = stolenRole; // rolu göstərmək üçün saxla

    io.to(actorId).emit("ability:result", {
      type: "thief",
      targetName: target.name,
      stolenRole,
      stolenRoleName: ROLES[stolenRole]?.name,
      message: `${target.name}-dən "${ROLES[stolenRole]?.name}" rolunu oğurladın! Hədəf öldürüldü.`
    });
    io.to(targetId).emit("thief:stolen", {
      message: "Rolunuz oğurlanıb! Siz öldürüldünüz.",
    });
  });

  // 3. Tələçi — tələ qoyur
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "trapper" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    room.trapSet[actorId] = targetId;
    io.to(actorId).emit("ability:result", {
      type: "trapper",
      message: `${room.players[targetId]?.name || "Hədəf"} üçün tələ quruldu.`
    });
  });

  // Tələ yoxlaması: bu gecə kimə gəldi?
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (!actor?.alive) return;
    // Tələyə gəldi mi?
    Object.entries(room.trapSet).forEach(([trapperId, trappedTarget]) => {
      if (trappedTarget === targetId && actorId !== trapperId) {
        room.trapCaught[actorId] = true;
        if (!room.blockedPlayers.includes(actorId)) {
          room.blockedPlayers.push(actorId);
        }
        const trapper = room.players[trapperId];
        if (trapper) {
          io.to(trapperId).emit("ability:result", {
            type: "trap_caught",
            message: `${actor.name} tələyə düşdü! Bloklandı.`
          });
        }
      }
    });
  });

  // 4. Həkim qoruması (bloklanmamışsa)
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "doctor" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    if (room.players[targetId]) room.players[targetId].protected = true;
  });

  // 5. Mafia kill (bloklanmamış mafia üzvlərinin əksəriyyət seçimi)
  const mafiaVotes = {};
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (!["mafia","cleaner","blame","roleblocker"].includes(actor?.role) || !actor?.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    mafiaVotes[targetId] = (mafiaVotes[targetId] || 0) + 1;
  });

  let mafiaKillId = null;
  if (Object.keys(mafiaVotes).length) {
    mafiaKillId = Object.entries(mafiaVotes).sort((a, b) => b[1] - a[1])[0][0];
  }

  // 6. Serial Killer
  let skKillId = null;
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "serialkiller" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    skKillId = targetId;
  });

  // 7. Snitch — bir oyunçunun rolunu öyrənir (1 dəfəlik)
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "snitch" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    if (room.snitchUsed[actorId]) {
      io.to(actorId).emit("ability:result", {
        type: "snitch_used",
        message: "Xəbərçi qabiliyyətini artıq istifadə etmisən."
      });
      return;
    }
    room.snitchUsed[actorId] = true;
    const target = room.players[targetId];
    if (target) {
      io.to(actorId).emit("ability:result", {
        type: "snitch",
        targetName: target.name,
        role: target.role,
        roleName: ROLES[target.role]?.name,
        message: `${target.name}-in rolu: ${ROLES[target.role]?.name || "?"} (sabah açıqlanacaq)`
      });
    }
  });

  // 8. Lookout — seçdiyi oyunçuya kimin getdiyini görür
  Object.entries(actions).forEach(([actorId, watchedId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "lookout" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;

    const visitors = [];
    Object.entries(actions).forEach(([otherId, otherTarget]) => {
      if (otherTarget === watchedId && otherId !== actorId) {
        const other = room.players[otherId];
        if (other) visitors.push(other.name);
      }
    });
    const watched = room.players[watchedId];
    io.to(actorId).emit("ability:result", {
      type: "lookout",
      message: visitors.length > 0
        ? `${watched?.name || "Hədəf"} yanına bu gecə gələnlər: ${visitors.join(", ")}`
        : `${watched?.name || "Hədəf"} yanına bu gecə heç kim getmədi.`
    });
  });

  // 9. Tracker — seçdiyi oyunçunun hara getdiyini görür
  Object.entries(actions).forEach(([actorId, trackedId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "tracker" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;

    const trackedAction = actions[trackedId];
    const tracked = room.players[trackedId];
    const target = trackedAction ? room.players[trackedAction] : null;
    io.to(actorId).emit("ability:result", {
      type: "tracker",
      message: target
        ? `${tracked?.name || "Hədəf"} bu gecə ${target.name}-ə getdi.`
        : `${tracked?.name || "Hədəf"} bu gecə heç yerə getmədi.`
    });
  });

  // 10. Provoker — +2 vote verir (sabahkı səsvermədə)
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "provoker" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    room.provokePenalty[targetId] = (room.provokePenalty[targetId] || 0) + 2;
    io.to(actorId).emit("ability:result", {
      type: "provoker",
      message: `${room.players[targetId]?.name || "Hədəf"} sabah +2 əlavə səs alacaq.`
    });
  });

  // 11. Bomber — bomba qoyur (partlatmır hələ)
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "bomber" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    if (!room.bombPlaced[actorId]) {
      room.bombPlaced[actorId] = targetId;
      io.to(actorId).emit("ability:result", {
        type: "bomber_placed",
        targetName: room.players[targetId]?.name,
        message: `💣 ${room.players[targetId]?.name || "Hədəf"} üçün bomba qoyuldu. Partlatmaq üçün gündüz "Bomba Partlat" düyməsini basın.`
      });
    }
  });

  // 12. Haunter — öldükdən sonra aktiv olur (gündüz əlavə vote verir)
  // Haunter öldüyündə haunterActive = true olur (aşağıda idarə edilir)

  // 13. Cleaner — seçdiyi ölünün rolunu gizlədir
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "cleaner" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    room.cleanerHid[targetId] = true;
  });

  // 14. Blame — seçdiyi ölünü "Mafiya" kimi göstərir
  Object.entries(actions).forEach(([actorId, targetId]) => {
    const actor = room.players[actorId];
    if (actor?.role !== "blame" || !actor.alive) return;
    if (room.blockedPlayers.includes(actorId)) return;
    room.blameTargets[targetId] = true;
  });

  // 15. Öldürmələri tətbiq et
  const killed = [];

  function tryKill(id, source) {
    const p = room.players[id];
    if (!p || !p.alive) return;
    if (p.protected) { killed.push({ name: p.name, saved: true, source }); return; }
    // Survivor özünü 1 dəfə xilas edə bilər
    if (p.role === "survivor" && !room.survivorSaved[p.id]) {
      room.survivorSaved[p.id] = true;
      killed.push({ name: p.name, saved: true, source });
      io.to(p.id).emit("ability:result", {
        type: "survivor_save",
        message: "Özünüzü xilas etdiniz! (1 dəfəlik hüquq istifadə edildi)"
      });
      return;
    }
    p.alive = false;
    p.diedAt = room.roundNum;
    killed.push({ name: p.name, saved: false, source, role: p.role });

    // Haunter öldüsə aktiv ol
    if (p.role === "haunter") {
      room.haunterId     = p.id;
      room.haunterActive = true;
    }
  }

  if (mafiaKillId)  tryKill(mafiaKillId,  "mafia");
  if (skKillId)     tryKill(skKillId,      "sk");

  const winner = checkWin(room);
  if (winner) return endGame(room, winner);

  startDay(room, killed);
}

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
  room.phase        = "day";
  room.nominations  = {};
  room.provokePenalty = room.provokePenalty || {};
  room.roundNum++;

  emitToRoom(room, "phase:day", {
    killed,
    players:  roomPlayerList(room),
    roundNum: room.roundNum,
    bombInfo: getBombInfo(room),
    haunterActive: room.haunterActive,
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => startVote(room), 90_000);
}

function getBombInfo(room) {
  // Bombacıya bomba kimin üstündə olduğunu bildir
  const result = {};
  Object.entries(room.bombPlaced).forEach(([bomberId, targetId]) => {
    const bomber = room.players[bomberId];
    if (bomber?.alive) {
      result[bomberId] = {
        targetId,
        targetName: room.players[targetId]?.name
      };
    }
  });
  return result;
}

// ─── SƏSVERMƏs ────────────────────────────────────────────
function startVote(room) {
  room.phase       = "vote";
  room.nominations = {};

  const aliveCount = alivePlayers(room).length;
  room.voteExpected = aliveCount;
  room.voteReceived = 0;

  emitToRoom(room, "phase:vote", { players: roomPlayerList(room) });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolveVote(room), 60_000);
}

function resolveVote(room) {
  clearTimeout(room.timer);
  if (room.phase !== "vote") return;

  const voteCount = {};
  Object.entries(room.nominations).forEach(([targetId, voters]) => {
    let total = 0;
    voters.forEach(vid => {
      total += 1;
    });
    // Provoker cəzası əlavə et
    if (room.provokePenalty[targetId]) {
      total += room.provokePenalty[targetId];
    }
    // Haunter aktiv olduqda əlavə vote verir (3 əlavə vote)
    if (room.haunterActive && room.haunterId) {
      // Haunter öz vote-unu gündüz verir — avtomatik olaraq ən çox səs alana
      // (bu sadə implementasiya üçün heç nə etmirik, haunter əlavə sessiyada idarə edilə bilər)
    }
    voteCount[targetId] = total;
  });

  let maxVotes = 0;
  let eliminatedId = null;
  Object.entries(voteCount).forEach(([tid, count]) => {
    if (count > maxVotes) { maxVotes = count; eliminatedId = tid; }
  });

  const maxCount = Object.values(voteCount).filter(v => v === maxVotes).length;
  if (maxCount > 1) eliminatedId = null;

  let eliminatedName = null;
  let eliminatedRole = null;
  let showRole       = true;

  if (eliminatedId && room.players[eliminatedId]) {
    room.players[eliminatedId].alive = false;
    room.players[eliminatedId].diedAt = room.roundNum;
    eliminatedName = room.players[eliminatedId].name;
    eliminatedRole = room.players[eliminatedId].role;

    // Cleaner gizlətdibsə rolu göstərmə
    if (room.cleanerHid[eliminatedId]) showRole = false;
    // Blame "mafiya" göstərir
    if (room.blameTargets[eliminatedId]) eliminatedRole = "mafia";

    // Haunter öldüsə aktiv ol
    if (room.players[eliminatedId]?.role === "haunter") {
      room.haunterId     = eliminatedId;
      room.haunterActive = true;
    }
  }

  // Provoker cəzasını sıfırla
  room.provokePenalty = {};

  const winner = checkWin(room);
  if (winner) {
    // Survivor sağ qaldısa əlavə qalib
    const survivors = alivePlayers(room).filter(p => p.role === "survivor");
    return endGame(room, winner, survivors);
  }

  emitToRoom(room, "vote:result", {
    eliminatedName,
    eliminatedRole: showRole ? eliminatedRole : null,
    eliminatedRoleName: showRole ? (eliminatedRole ? ROLES[eliminatedRole]?.name : null) : "Gizli",
    tie: maxCount > 1,
    roleHidden: !showRole,
  });

  setTimeout(() => startNight(room), 5000);
}

// ─── OYUN SONU ────────────────────────────────────────────
function endGame(room, winner, survivors) {
  clearTimeout(room.timer);
  room.phase = "ended";

  const rolesReveal = Object.values(room.players).map(p => {
    const stolen = room.thiefStolen[p.id];
    return {
      name:          p.name,
      role:          p.role,
      roleName:      ROLES[p.role]?.name ?? p.role,
      alive:         p.alive,
      diedAt:        p.diedAt ?? null,
      stolenRole:    stolen ? stolen.stolenRole : null,
      stolenRoleName:stolen ? ROLES[stolen.stolenRole]?.name : null,
    };
  });

  const survivorWinners = survivors?.map(p => p.name) || [];

  emitToRoom(room, "game:ended", { winner, rolesReveal, survivorWinners });
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

  socket.on("room:rejoin", ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ ok: false, error: "Otaq tapılmadı" });

    const existing = Object.values(room.players).find(p => p.name === name);
    if (existing) {
      delete room.players[existing.id];
      existing.id = socket.id;
      room.players[socket.id] = existing;
      existing.connected = true;

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
    const mafiaSide = ["mafia","cleaner","blame","roleblocker"];

    cb({
      ok:         true,
      phase:      room.phase,
      owner:      room.owner,
      players:    roomPlayerList(room),
      myRole:     myPlayer?.role,
      myRoleName: myPlayer?.role ? ROLES[myPlayer.role]?.name : null,
      roleConfig: room.roleConfig,
      roundNum:   room.roundNum,
      mafiaTeam:  myPlayer?.role && mafiaSide.includes(myPlayer.role)
        ? Object.values(room.players)
            .filter(x => mafiaSide.includes(x.role) && x.id !== socket.id)
            .map(x => ({ name: x.name, role: x.role, roleName: ROLES[x.role]?.name }))
        : [],
      bombInfo:   getBombInfo(room),
    });

    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });

    // Solo mode: rollar artıq paylaşdırılıb, indi gecəni başlat
    if (room.soloReady && room.owner === socket.id) {
      room.soloReady = false;
      const mafiaSide2 = ["mafia","cleaner","blame","roleblocker"];
      Object.values(room.players).forEach(p => {
        const mafiaTeam = mafiaSide2.includes(p.role)
          ? Object.values(room.players)
              .filter(x => mafiaSide2.includes(x.role) && x.id !== p.id)
              .map(x => ({ name: x.name, role: x.role, roleName: ROLES[x.role]?.name }))
          : [];
        io.to(p.id).emit("game:role", {
          role:     p.role,
          roleName: ROLES[p.role]?.name || p.role,
          mafiaTeam,
        });
      });
      // Reset night state
      room.phase         = "night";
      room.roundNum      = 1;
      room.nightActions  = {};
      room.nominations   = {};
      room.thiefStolen   = {};
      room.trapSet       = {};
      room.trapCaught    = {};
      room.bombPlaced    = {};
      room.snitchUsed    = {};
      room.survivorSaved = {};
      room.provokePenalty= {};
      room.blockedPlayers= [];
      room.cleanerHid    = {};
      room.blameTargets  = {};
      room.haunterId     = null;
      room.haunterActive = false;
      emitToRoom(room, "game:started", { playerCount: Object.keys(room.players).length });
      setTimeout(() => startNight(room), 500);
    }
  });

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

  socket.on("game:start", (_, cb) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room)                    return cb?.({ ok: false, error: "Otaq yoxdur" });
    if (room.owner !== socket.id) return cb?.({ ok: false, error: "Yalnız sahibi başlada bilər" });

    const result = startGame(room);
    if (result?.error) return cb?.({ ok: false, error: result.error });
    cb?.({ ok: true });
  });

  // ── Admin Solo Mode ─────────────────────────────────────────
  // Creates a room with fake bot players for testing
  socket.on("admin:solo", ({ name, roleConfig }, cb) => {
    let code;
    do { code = genCode(); } while (rooms[code]);

    const room = createRoom(code, socket.id);
    addPlayer(room, socket, name + " (Admin)");
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name     = name;

    // Add fake bot players with fake socket-like IDs
    const botNames = ["Anar","Leyla","Murad","Nigar","Elçin","Gülnar",
      "Tural","Sevinc","Kamran","Könül","Rauf","Aytən","Vüsal","Şəbnəm"];
    const totalNeeded = Object.values(roleConfig).reduce((s,v)=>s+(parseInt(v)||0),0);
    const botCount    = Math.max(0, totalNeeded - 1); // admin counts as 1

    for (let i = 0; i < botCount; i++) {
      const botId = `bot_${code}_${i}`;
      room.players[botId] = {
        id: botId, name: botNames[i] || `Bot${i+1}`,
        role: null, alive: true, protected: false,
        connected: true, isBot: true, joinedAt: Date.now(),
      };
    }

    room.roleConfig = roleConfig;
    room.soloReady  = true;  // rejoin-dən sonra startGame çağrılacaq

    // Rolları əvvəlcədən paylaşdır
    const soloPlayers = Object.values(room.players);
    const sv = validateConfig(room.roleConfig, soloPlayers.length);
    if (!sv.ok) { delete rooms[code]; return cb?.({ ok: false, error: sv.error }); }
    const soloRoleArr = buildRoleArray(room.roleConfig);
    const soloShuffled = shuffle(soloRoleArr);
    soloPlayers.forEach((p, i) => { p.role = soloShuffled[i]; p.alive = true; p.protected = false; });

    // Bütün rolları adminə göndər
    const allRoles = Object.values(room.players).map(p => ({
      id:      p.id,
      name:    p.name,
      role:    p.role,
      isBot:   !!p.isBot,
      isAdmin: p.id === socket.id,
    }));

    cb?.({ ok: true, code, allRoles });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });
  });

  // Admin acts as a bot player for a night/vote action
  socket.on("admin:bot_action", ({ botId, action, targetId }, cb) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room) return cb?.({ ok: false });
    if (room.owner !== socket.id) return cb?.({ ok: false });

    const bot = room.players[botId];
    if (!bot || !bot.isBot) return cb?.({ ok: false });

    if (action === "night_action" && room.phase === "night") {
      if (bot.alive && targetId) {
        room.nightActions[botId] = targetId;
        checkNightComplete(room);
      }
    } else if (action === "nominate" && room.phase === "day") {
      if (bot.alive && targetId) {
        const target = room.players[targetId];
        if (target && target.alive) {
          emitToRoom(room, "day:nominated", { nominator: bot.name, targetName: target.name });
        }
      }
    } else if (action === "vote" && room.phase === "vote") {
      if (bot.alive && targetId) {
        if (!room.nominations[targetId]) room.nominations[targetId] = [];
        if (!room.nominations[targetId].includes(botId)) {
          room.nominations[targetId].push(botId);
          room.voteReceived = (room.voteReceived || 0) + 1;
        }
        const displayVotes = {};
        Object.entries(room.nominations).forEach(([tid, voters]) => {
          let total = voters.length;
          if (room.provokePenalty[tid]) total += room.provokePenalty[tid];
          displayVotes[tid] = total;
        });
        emitToRoom(room, "vote:update", { nominations: displayVotes });
        if (room.voteReceived >= room.voteExpected) {
          clearTimeout(room.timer);
          setTimeout(() => resolveVote(room), 1000);
        }
      }
    } else if (action === "skip_night" && room.phase === "night") {
      if (bot.alive) {
        room.nightActions[botId] = null;
        checkNightComplete(room);
      }
    }
    cb?.({ ok: true });
  });

  socket.on("night:action", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "night") return;
    const actor = room.players[socket.id];
    if (!actor?.alive) return;

    // Snitch artıq istifadə etmişsə
    if (actor.role === "snitch" && room.snitchUsed[socket.id]) return;

    room.nightActions[socket.id] = targetId;
    checkNightComplete(room);
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

  // Bomber bombasını partladır
  socket.on("bomber:detonate", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "day") return;
    const actor = room.players[socket.id];
    if (!actor?.alive || actor.role !== "bomber") return;

    const targetId = room.bombPlaced[socket.id];
    if (!targetId) return;

    const target = room.players[targetId];
    if (target && target.alive) {
      target.alive = false;
      target.diedAt = room.roundNum;
      delete room.bombPlaced[socket.id];
      emitToRoom(room, "bomb:exploded", {
        bomberName: actor.name,
        targetName: target.name,
        players: roomPlayerList(room),
      });

      const winner = checkWin(room);
      if (winner) endGame(room, winner);
    }
  });

  socket.on("vote:cast", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.phase !== "vote") return;
    if (!room.players[socket.id]?.alive) return;

    if (!room.nominations[targetId]) room.nominations[targetId] = [];
    if (!room.nominations[targetId].includes(socket.id)) {
      room.nominations[targetId].push(socket.id);
      room.voteReceived = (room.voteReceived || 0) + 1;
    }

    const displayVotes = {};
    Object.entries(room.nominations).forEach(([tid, voters]) => {
      let total = voters.length;
      if (room.provokePenalty[tid]) total += room.provokePenalty[tid];
      displayVotes[tid] = total;
    });

    emitToRoom(room, "vote:update", { nominations: displayVotes });

    // Bütün canlı oyunçular səs verdisə avtomatik bitir
    if (room.voteReceived >= room.voteExpected) {
      clearTimeout(room.timer);
      setTimeout(() => resolveVote(room), 1000);
    }
  });

  socket.on("mod:nextPhase", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.owner !== socket.id) return;

    clearTimeout(room.timer);
    if (room.phase === "night") resolveNight(room);
    else if (room.phase === "day") startVote(room);
    else if (room.phase === "vote") resolveVote(room);
  });

  socket.on("mod:eliminate", ({ targetId }) => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    const room = getRoom(code);
    if (!room || room.owner !== socket.id) return;
    const target = room.players[targetId];
    if (!target || !target.alive) return;

    target.alive = false;
    target.diedAt = room.roundNum;
    emitToRoom(room, "mod:eliminated", { name: target.name });
    emitToRoom(room, "room:update", { players: roomPlayerList(room), owner: room.owner });

    const winner = checkWin(room);
    if (winner) endGame(room, winner);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode || findRoomOf(socket.id);
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    const player = room.players[socket.id];
    if (!player) return;

    if (room.phase === "lobby") {
      removePlayer(room, socket.id);
      if (Object.keys(room.players).length === 0) {
        clearTimeout(room.timer); delete rooms[code]; return;
      }
    } else {
      player.connected = false;
      // Gecə aksiyası gözlənilirsə, disconnected oyunçunu keç
      if (room.phase === "night" && !room.nightActions[socket.id]) {
        room.nightActed = (room.nightActed || 0) + 1;
        if (room.nightActed >= room.nightExpected) {
          clearTimeout(room.timer);
          setTimeout(() => resolveNight(room), 800);
        }
      }
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
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
