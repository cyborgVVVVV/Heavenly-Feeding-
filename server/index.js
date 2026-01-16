import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const PORT = process.env.PORT || 3000;
const WIDTH = 960;
const HEIGHT = 540;
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const STATE_RATE = 30;

const MOVE_SPEED = 220;
const MAX_ANGULAR_SPEED = 4.5;
const CHOPSTICK_LENGTH = 181;
const CONE_RADIUS = 180;
const CONE_HALF_ANGLE = Math.PI / 3;
const PICKUP_CLOSE_RADIUS = 26;
const MOUTH_RADIUS = 30;
const MOUTH_OFFSET_X = 0;
const MOUTH_OFFSET_Y_LEFT = 84;
const MOUTH_OFFSET_Y_RIGHT = 67;
const EAT_TIME = 0.4;
const MAX_FOOD = 8;
const SPAWN_INTERVAL = 2.0;
const GRAVITY = 170;
const MAX_FULLNESS = 100;

const FOOD_TYPES = [
  { name: "food_01", value: 6 },
  { name: "food_02", value: 6 },
  { name: "food_03", value: 7 },
  { name: "food_04", value: 8 },
  { name: "food_05", value: 9 },
  { name: "food_06", value: 10 },
  { name: "food_07", value: 10 },
  { name: "food_08", value: 11 },
  { name: "food_09", value: 12 },
  { name: "food_10", value: 13 }
];

const app = express();
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

function createRoom(roomId) {
  return {
    id: roomId,
    players: new Map(),
    foods: [],
    nextFoodId: 1,
    lastSpawnTime: 0,
    time: 0,
    gameOver: false,
    winnerId: null,
    loserId: null,
    started: false
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  return rooms.get(roomId);
}

function normalize(x, y) {
  const len = Math.hypot(x, y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

function wrapAngle(angle) {
  let a = angle;
  while (a <= -Math.PI) a += Math.PI * 2;
  while (a > Math.PI) a -= Math.PI * 2;
  return a;
}

function rotateTowards(current, target, maxDelta) {
  const delta = wrapAngle(target - current);
  const clamped = Math.max(-maxDelta, Math.min(maxDelta, delta));
  return wrapAngle(current + clamped);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function spawnFood(room) {
  if (room.foods.length >= MAX_FOOD) return;
  const type = FOOD_TYPES[Math.floor(Math.random() * FOOD_TYPES.length)];
  const food = {
    id: room.nextFoodId++,
    x: 80 + Math.random() * (WIDTH - 160),
    y: -20,
    vx: (Math.random() - 0.5) * 16,
    vy: 0,
    value: type.value,
    state: "free",
    heldBy: null,
    mouthTimers: {}
  };
  room.foods.push(food);
}

function tipPosition(player) {
  return {
    x: player.x + Math.cos(player.angle) * CHOPSTICK_LENGTH,
    y: player.y + Math.sin(player.angle) * CHOPSTICK_LENGTH
  };
}

function mouthPosition(player) {
  const offsetY =
    player.side === "right" ? MOUTH_OFFSET_Y_RIGHT : MOUTH_OFFSET_Y_LEFT;
  return {
    x: player.x + MOUTH_OFFSET_X,
    y: player.y - offsetY
  };
}

function isInCone(player, food) {
  const tip = tipPosition(player);
  const dx = food.x - tip.x;
  const dy = food.y - tip.y;
  const dist = Math.hypot(dx, dy);
  if (dist > CONE_RADIUS) return false;
  if (dist <= PICKUP_CLOSE_RADIUS) return true;
  const angleToFood = Math.atan2(dy, dx);
  const delta = Math.abs(wrapAngle(angleToFood - player.angle));
  return delta <= CONE_HALF_ANGLE;
}

function tryPickup(room, player) {
  if (player.holdingFoodId) return;
  const candidate = room.foods.find(
    (food) => food.state === "free" && isInCone(player, food)
  );
  if (!candidate) return;
  candidate.state = "held";
  candidate.heldBy = player.id;
  candidate.mouthTimers = {};
  player.holdingFoodId = candidate.id;
}

function releaseFood(room, player) {
  if (!player.holdingFoodId) return;
  const food = room.foods.find((f) => f.id === player.holdingFoodId);
  if (!food) {
    player.holdingFoodId = null;
    return;
  }
  food.state = "free";
  food.heldBy = null;
  food.vx = Math.cos(player.angle) * 60;
  food.vy = Math.sin(player.angle) * 60;
  player.holdingFoodId = null;
}

function updateFoods(room, dt) {
  for (const food of room.foods) {
    if (food.state === "held") continue;
    food.vy += GRAVITY * dt;
    food.x += food.vx * dt;
    food.y += food.vy * dt;
    if (food.y > HEIGHT + 60) {
      food.x = 80 + Math.random() * (WIDTH - 160);
      food.y = -20;
      food.vx = (Math.random() - 0.5) * 16;
      food.vy = 0;
    }
  }
}

function updateHeldFoods(room) {
  for (const player of room.players.values()) {
    if (!player.holdingFoodId) continue;
    const food = room.foods.find((f) => f.id === player.holdingFoodId);
    if (!food) {
      player.holdingFoodId = null;
      continue;
    }
    const tip = tipPosition(player);
    food.x += (tip.x - food.x) * 0.35;
    food.y += (tip.y - food.y) * 0.35;
    food.vx = 0;
    food.vy = 0;
  }
}

function handleEating(room, dt) {
  for (const food of room.foods) {
    for (const player of room.players.values()) {
      const opponentId = player.id;
      const mouth = mouthPosition(player);
      const dist = Math.hypot(food.x - mouth.x, food.y - mouth.y);
      const inMouth = dist <= MOUTH_RADIUS;
      if (inMouth) {
        food.mouthTimers[opponentId] =
          (food.mouthTimers[opponentId] || 0) + dt;
      } else {
        food.mouthTimers[opponentId] = 0;
      }
      if (food.mouthTimers[opponentId] >= EAT_TIME) {
        const eater = player;
        eater.fullness += food.value;
        eater.mouthOpenUntil = room.time + 0.35;
        if (food.heldBy) {
          const holder = room.players.get(food.heldBy);
          if (holder) holder.holdingFoodId = null;
        }
        room.foods = room.foods.filter((f) => f.id !== food.id);
        if (eater.fullness >= MAX_FULLNESS) {
          room.gameOver = true;
          room.loserId = eater.id;
          const opponent = Array.from(room.players.values()).find(
            (p) => p.id !== eater.id
          );
          room.winnerId = opponent ? opponent.id : null;
          room.started = false;
          for (const p of room.players.values()) {
            p.ready = false;
          }
        }
        return;
      }
    }
  }
}

function updatePlayers(room, dt) {
  for (const player of room.players.values()) {
    const input = player.input;
    const move = normalize(input.moveX, input.moveY);
    player.x += move.x * MOVE_SPEED * dt;
    player.y += move.y * MOVE_SPEED * dt;
    player.x = clamp(player.x, 60, WIDTH - 60);
    player.y = clamp(player.y, 80, HEIGHT - 60);
    player.targetAngle = input.aim;
    player.angle = rotateTowards(
      player.angle,
      player.targetAngle,
      MAX_ANGULAR_SPEED * dt
    );
    if (input.release) releaseFood(room, player);
    player.input.release = false;
  }
}

function tick(room) {
  if (!room.started || room.gameOver) return;
  updatePlayers(room, DT);
  for (const player of room.players.values()) {
    tryPickup(room, player);
  }
  updateHeldFoods(room);
  updateFoods(room, DT);
  handleEating(room, DT);
  room.time += DT;
  room.lastSpawnTime += DT;
  if (room.lastSpawnTime >= SPAWN_INTERVAL) {
    room.lastSpawnTime = 0;
    spawnFood(room);
  }
}

function broadcastState(room) {
  const payload = {
    type: "state",
    roomId: room.id,
    started: room.started,
    gameOver: room.gameOver,
    winnerId: room.winnerId,
    loserId: room.loserId || null,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      side: player.side,
      x: player.x,
      y: player.y,
      angle: player.angle,
      fullness: player.fullness,
      mouthOpen: room.time < (player.mouthOpenUntil || 0),
      ready: Boolean(player.ready),
      holdingFoodId: player.holdingFoodId
    })),
    foods: room.foods.map((food) => ({
      id: food.id,
      x: food.x,
      y: food.y,
      state: food.state,
      heldBy: food.heldBy,
      value: food.value
    }))
  };
  const data = JSON.stringify(payload);
  for (const player of room.players.values()) {
    if (player.ws.readyState === player.ws.OPEN) {
      player.ws.send(data);
    }
  }
}

function resetGameIfNeeded(room) {
  if (room.players.size < 2) {
    room.gameOver = false;
    room.winnerId = null;
    room.loserId = null;
    room.time = 0;
    room.started = false;
    room.foods = [];
    room.nextFoodId = 1;
    for (const player of room.players.values()) {
      player.ready = false;
      player.holdingFoodId = null;
    }
  }
}

function assignSide(room) {
  const sides = Array.from(room.players.values()).map((p) => p.side);
  if (!sides.includes("left")) return "left";
  if (!sides.includes("right")) return "right";
  return null;
}

function allReady(room) {
  if (room.players.size < 2) return false;
  return Array.from(room.players.values()).every((player) => player.ready);
}

function startRoom(room) {
  room.started = true;
  room.gameOver = false;
  room.winnerId = null;
  room.loserId = null;
  room.time = 0;
  room.foods = [];
  room.nextFoodId = 1;
  room.lastSpawnTime = 0;
  for (const player of room.players.values()) {
    player.fullness = 0;
    player.holdingFoodId = null;
    player.mouthOpenUntil = 0;
    player.input.moveX = 0;
    player.input.moveY = 0;
    player.input.release = false;
    if (player.side === "left") {
      player.x = 180;
      player.y = HEIGHT / 2;
      player.angle = 0;
      player.targetAngle = 0;
      player.input.aim = 0;
    } else {
      player.x = WIDTH - 180;
      player.y = HEIGHT / 2;
      player.angle = Math.PI;
      player.targetAngle = Math.PI;
      player.input.aim = Math.PI;
    }
  }
}

wss.on("connection", (ws, req) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const roomId = requestUrl.searchParams.get("room") || "lobby";
  const room = getRoom(roomId);

  if (room.players.size >= 2) {
    ws.send(JSON.stringify({ type: "full" }));
    ws.close();
    return;
  }
  const side = assignSide(room);
  if (!side) {
    ws.close();
    return;
  }
  const player = {
    id: `p_${Math.random().toString(36).slice(2, 9)}`,
    ws,
    side,
    x: side === "left" ? 180 : WIDTH - 180,
    y: HEIGHT / 2,
    angle: side === "left" ? 0 : Math.PI,
    targetAngle: side === "left" ? 0 : Math.PI,
    fullness: 0,
    mouthOpenUntil: 0,
    holdingFoodId: null,
    ready: false,
    input: {
      moveX: 0,
      moveY: 0,
      aim: side === "left" ? 0 : Math.PI,
      release: false
    }
  };
  room.players.set(player.id, player);
  resetGameIfNeeded(room);
  ws.send(
    JSON.stringify({
      type: "welcome",
      id: player.id,
      side: player.side,
      roomId: room.id,
      config: {
        width: WIDTH,
        height: HEIGHT,
        maxFullness: MAX_FULLNESS
      }
    })
  );

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (error) {
      return;
    }
    if (msg.type === "input") {
      if (!room.started) return;
      player.input.moveX = Number(msg.move?.x) || 0;
      player.input.moveY = Number(msg.move?.y) || 0;
      player.input.aim = Number(msg.aim) || player.input.aim;
      player.input.release = Boolean(msg.release);
    }
    if (msg.type === "ready") {
      player.ready = Boolean(msg.ready);
      if (allReady(room)) {
        startRoom(room);
      }
    }
  });

  ws.on("close", () => {
    room.players.delete(player.id);
    if (player.holdingFoodId) {
      const food = room.foods.find((f) => f.id === player.holdingFoodId);
      if (food) {
        food.state = "free";
        food.heldBy = null;
      }
    }
    resetGameIfNeeded(room);
    if (room.players.size === 0) {
      rooms.delete(roomId);
    }
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    tick(room);
  }
}, 1000 / TICK_RATE);

setInterval(() => {
  for (const room of rooms.values()) {
    broadcastState(room);
  }
}, 1000 / STATE_RATE);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
