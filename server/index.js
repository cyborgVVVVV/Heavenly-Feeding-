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
const CHOPSTICK_LENGTH = 80;
const CONE_RADIUS = 90;
const CONE_HALF_ANGLE = Math.PI / 5;
const MOUTH_RADIUS = 22;
const EAT_TIME = 0.4;
const MAX_FOOD = 8;
const SPAWN_INTERVAL = 2.0;
const GRAVITY = 170;
const MAX_FULLNESS = 100;

const FOOD_TYPES = [
  { name: "food_01", value: 4 },
  { name: "food_02", value: 6 },
  { name: "food_03", value: 8 },
  { name: "food_04", value: 10 },
  { name: "food_05", value: 12 },
  { name: "food_06", value: 14 },
  { name: "food_07", value: 16 },
  { name: "food_08", value: 18 },
  { name: "food_09", value: 20 },
  { name: "food_10", value: 22 }
];

const app = express();
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const room = {
  players: new Map(),
  foods: [],
  nextFoodId: 1,
  lastSpawnTime: 0,
  time: 0,
  gameOver: false,
  winnerId: null,
  loserId: null
};

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

function spawnFood() {
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
  const offset = player.side === "left" ? 22 : -22;
  return { x: player.x + offset, y: player.y - 8 };
}

function isInCone(player, food) {
  const tip = tipPosition(player);
  const dx = food.x - tip.x;
  const dy = food.y - tip.y;
  const dist = Math.hypot(dx, dy);
  if (dist > CONE_RADIUS) return false;
  const angleToFood = Math.atan2(dy, dx);
  const delta = Math.abs(wrapAngle(angleToFood - player.angle));
  return delta <= CONE_HALF_ANGLE;
}

function tryPickup(player) {
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

function releaseFood(player) {
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

function updateFoods(dt) {
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

function updateHeldFoods() {
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

function handleEating(dt) {
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
        }
        return;
      }
    }
  }
}

function updatePlayers(dt) {
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
    if (input.release) releaseFood(player);
    player.input.release = false;
  }
}

function tick() {
  if (room.gameOver) return;
  updatePlayers(DT);
  for (const player of room.players.values()) {
    tryPickup(player);
  }
  updateHeldFoods();
  updateFoods(DT);
  handleEating(DT);
  room.time += DT;
  room.lastSpawnTime += DT;
  if (room.lastSpawnTime >= SPAWN_INTERVAL) {
    room.lastSpawnTime = 0;
    spawnFood();
  }
}

function broadcastState() {
  const payload = {
    type: "state",
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

function resetGameIfNeeded() {
  if (room.players.size < 2) {
    room.gameOver = false;
    room.winnerId = null;
    room.loserId = null;
    room.time = 0;
    room.foods = [];
    room.nextFoodId = 1;
  }
}

function assignSide() {
  const sides = Array.from(room.players.values()).map((p) => p.side);
  if (!sides.includes("left")) return "left";
  if (!sides.includes("right")) return "right";
  return null;
}

wss.on("connection", (ws) => {
  if (room.players.size >= 2) {
    ws.send(JSON.stringify({ type: "full" }));
    ws.close();
    return;
  }
  const side = assignSide();
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
    input: {
      moveX: 0,
      moveY: 0,
      aim: side === "left" ? 0 : Math.PI,
      release: false
    }
  };
  room.players.set(player.id, player);
  resetGameIfNeeded();
  ws.send(
    JSON.stringify({
      type: "welcome",
      id: player.id,
      side: player.side,
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
      player.input.moveX = Number(msg.move?.x) || 0;
      player.input.moveY = Number(msg.move?.y) || 0;
      player.input.aim = Number(msg.aim) || player.input.aim;
      player.input.release = Boolean(msg.release);
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
    resetGameIfNeeded();
  });
});

setInterval(() => {
  for (let i = 0; i < 1; i += 1) {
    tick();
  }
}, 1000 / TICK_RATE);

setInterval(() => {
  broadcastState();
}, 1000 / STATE_RATE);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
