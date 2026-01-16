const statusEl = document.getElementById("status");

const config = {
  type: Phaser.AUTO,
  parent: "game",
  width: 960,
  height: 540,
  backgroundColor: "#111820",
  physics: {
    default: "matter",
    matter: {
      gravity: { y: 0 }
    }
  },
  scene: {
    preload,
    create,
    update
  }
};

let game;
let socket;
let localId = null;
let localSide = null;
let serverState = null;
let predictedPlayer = null;
let lastInputSent = 0;
let maxFullness = 100;

const MOVE_SPEED = 220;
const MAX_ANGULAR_SPEED = 4.5;
const CHOPSTICK_LENGTH = 80;
const CONE_RADIUS = 90;
const CONE_HALF_ANGLE = Math.PI / 5;
const MOUTH_RADIUS = 22;

const BODY_SIZE = 36;
const MOUTH_SIZE = 44;
const CHOPSTICK_WIDTH = 80;
const CHOPSTICK_HEIGHT = 12;

const PLAYER_TEXTURE_KEYS = {
  left: {
    body: "player_left_body",
    chopstick: "player_left_chopstick",
    mouth: "player_left_mouth"
  },
  right: {
    body: "player_right_body",
    chopstick: "player_right_chopstick",
    mouth: "player_right_mouth"
  }
};

const FOOD_VALUE_TO_KEY = new Map([
  [4, "food_01"],
  [6, "food_02"],
  [8, "food_03"],
  [10, "food_04"],
  [12, "food_05"],
  [14, "food_06"],
  [16, "food_07"],
  [18, "food_08"],
  [20, "food_09"],
  [22, "food_10"]
]);

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

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener("open", () => {
    statusEl.textContent = "等待玩家加入...";
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "welcome") {
      localId = msg.id;
      localSide = msg.side;
      maxFullness = msg.config.maxFullness;
      if (!game) {
        config.width = msg.config.width;
        config.height = msg.config.height;
        game = new Phaser.Game(config);
      }
    }
    if (msg.type === "state") {
      serverState = msg;
      if (msg.gameOver) {
        const winText =
          msg.loserId === localId ? "你被吃撑了！" : "对手被吃撑了！";
        statusEl.textContent = `比赛结束：${winText}`;
      } else {
        const hasOpponent =
          msg.players.filter((player) => player.id !== localId).length > 0;
        statusEl.textContent = hasOpponent ? "战斗中" : "等待玩家加入...";
      }
    }
    if (msg.type === "full") {
      statusEl.textContent = "房间已满";
    }
  });
}

function preload() {
  this.load.image("player_left_body", "/assets/players/left_body.png");
  this.load.image("player_right_body", "/assets/players/right_body.png");
  this.load.image("player_left_chopstick", "/assets/players/left_chopstick.png");
  this.load.image("player_right_chopstick", "/assets/players/right_chopstick.png");
  this.load.image("player_left_mouth", "/assets/players/left_mouth.png");
  this.load.image("player_right_mouth", "/assets/players/right_mouth.png");
  for (let i = 1; i <= 10; i += 1) {
    const id = String(i).padStart(2, "0");
    this.load.image(`food_${id}`, `/assets/foods/food_${id}.png`);
  }
}

function create() {
  this.graphics = this.add.graphics();
  this.foodSprites = new Map();
  this.playerSprites = new Map();
  this.chopstickSprites = new Map();
  this.mouthSprites = new Map();
  this.uiText = this.add.text(16, 80, "", {
    fontSize: "14px",
    color: "#f2e9d8"
  });
  this.cursors = this.input.keyboard.addKeys({
    up: "W",
    down: "S",
    left: "A",
    right: "D",
    release: "SPACE"
  });
  this.input.on("pointermove", () => {});
}

function update(time, delta) {
  if (!serverState || !localId) return;
  const dt = delta / 1000;
  const player = serverState.players.find((p) => p.id === localId);
  if (!player) return;

  if (!predictedPlayer) {
    predictedPlayer = { ...player };
  }

  const moveInput = getMoveInput(this.cursors);
  const targetAim = getAimAngle(this, predictedPlayer);

  predictedPlayer.angle = rotateTowards(
    predictedPlayer.angle,
    targetAim,
    MAX_ANGULAR_SPEED * dt
  );
  predictedPlayer.x += moveInput.x * MOVE_SPEED * dt;
  predictedPlayer.y += moveInput.y * MOVE_SPEED * dt;
  predictedPlayer.x = Phaser.Math.Clamp(predictedPlayer.x, 60, config.width - 60);
  predictedPlayer.y = Phaser.Math.Clamp(predictedPlayer.y, 80, config.height - 60);

  const serverPlayer = player;
  const distance = Phaser.Math.Distance.Between(
    predictedPlayer.x,
    predictedPlayer.y,
    serverPlayer.x,
    serverPlayer.y
  );
  const angleDiff = Math.abs(wrapAngle(serverPlayer.angle - predictedPlayer.angle));
  if (distance > 40 || angleDiff > 0.9) {
    predictedPlayer.x = serverPlayer.x;
    predictedPlayer.y = serverPlayer.y;
    predictedPlayer.angle = serverPlayer.angle;
  } else {
    predictedPlayer.x = Phaser.Math.Linear(
      predictedPlayer.x,
      serverPlayer.x,
      0.1
    );
    predictedPlayer.y = Phaser.Math.Linear(
      predictedPlayer.y,
      serverPlayer.y,
      0.1
    );
    predictedPlayer.angle = rotateTowards(
      predictedPlayer.angle,
      serverPlayer.angle,
      MAX_ANGULAR_SPEED * dt
    );
  }

  const release = Phaser.Input.Keyboard.JustDown(this.cursors.release);
  sendInput(time, moveInput, targetAim, release);

  renderScene(this, predictedPlayer, serverState);
}

function getMoveInput(keys) {
  const x = (keys.right.isDown ? 1 : 0) - (keys.left.isDown ? 1 : 0);
  const y = (keys.down.isDown ? 1 : 0) - (keys.up.isDown ? 1 : 0);
  return normalize(x, y);
}

function getAimAngle(scene, player) {
  const pointer = scene.input.activePointer;
  return Math.atan2(pointer.worldY - player.y, pointer.worldX - player.x);
}

function sendInput(time, move, aim, release) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (time - lastInputSent < 16) return;
  lastInputSent = time;
  socket.send(
    JSON.stringify({
      type: "input",
      move: { x: move.x, y: move.y },
      aim,
      release
    })
  );
}

function renderScene(scene, localPlayer, state) {
  const g = scene.graphics;
  g.clear();
  g.fillStyle(0x111820, 1);
  g.fillRect(0, 0, config.width, config.height);

  const players = state.players.map((player) => {
    if (player.id === localId) {
      return { ...localPlayer, side: player.side, fullness: player.fullness };
    }
    return player;
  });

  renderPlayers(scene, g, players);

  renderFoods(scene, g, players, state.foods);

  scene.uiText.setText(buildHud(players, state));
}

function renderFoods(scene, graphics, players, foods) {
  const seen = new Set();
  for (const food of foods) {
    seen.add(food.id);
    const textureKey = getFoodTextureKey(food.value);
    if (scene.textures.exists(textureKey)) {
      let sprite = scene.foodSprites.get(food.id);
      if (!sprite) {
        sprite = scene.add.image(food.x, food.y, textureKey);
        sprite.setDisplaySize(22, 22);
        sprite.setDepth(2);
        scene.foodSprites.set(food.id, sprite);
      } else if (sprite.texture.key !== textureKey) {
        sprite.setTexture(textureKey);
      }
      sprite.setPosition(food.x, food.y);
    } else {
      const sprite = scene.foodSprites.get(food.id);
      if (sprite) {
        sprite.destroy();
        scene.foodSprites.delete(food.id);
      }
      let color = 0xf5d76e;
      if (food.state === "held") {
        const holder = players.find((p) => p.id === food.heldBy);
        color = holder?.side === "left" ? 0x4fc3f7 : 0xff7043;
      }
      graphics.fillStyle(color, 1);
      graphics.fillCircle(food.x, food.y, 10);
    }
  }
  for (const [id, sprite] of scene.foodSprites.entries()) {
    if (!seen.has(id)) {
      sprite.destroy();
      scene.foodSprites.delete(id);
    }
  }
}

function renderPlayers(scene, graphics, players) {
  const seen = new Set();
  for (const player of players) {
    seen.add(player.id);
    const keys = PLAYER_TEXTURE_KEYS[player.side];
    const bodyKey = keys?.body;
    const chopstickKey = keys?.chopstick;
    const mouthKey = keys?.mouth;
    const hasBody = bodyKey && scene.textures.exists(bodyKey);
    const hasChopstick = chopstickKey && scene.textures.exists(chopstickKey);
    const hasMouth = mouthKey && scene.textures.exists(mouthKey);

    if (hasBody) {
      let body = scene.playerSprites.get(player.id);
      if (!body) {
        body = scene.add.image(player.x, player.y, bodyKey);
        body.setDisplaySize(BODY_SIZE, BODY_SIZE);
        body.setDepth(1);
        scene.playerSprites.set(player.id, body);
      } else if (body.texture.key !== bodyKey) {
        body.setTexture(bodyKey);
      }
      body.setPosition(player.x, player.y);
    } else {
      const body = scene.playerSprites.get(player.id);
      if (body) {
        body.destroy();
        scene.playerSprites.delete(player.id);
      }
      const color = player.side === "left" ? 0x5aa9e6 : 0xf38ba0;
      graphics.fillStyle(color, 1);
      graphics.fillCircle(player.x, player.y, 18);
    }

    if (hasChopstick) {
      let chopstick = scene.chopstickSprites.get(player.id);
      if (!chopstick) {
        chopstick = scene.add.image(player.x, player.y, chopstickKey);
        chopstick.setOrigin(0.1, 0.5);
        chopstick.setDisplaySize(CHOPSTICK_WIDTH, CHOPSTICK_HEIGHT);
        chopstick.setDepth(1);
        scene.chopstickSprites.set(player.id, chopstick);
      } else if (chopstick.texture.key !== chopstickKey) {
        chopstick.setTexture(chopstickKey);
      }
      chopstick.setPosition(player.x, player.y);
      chopstick.setRotation(player.angle);
    } else {
      const chopstick = scene.chopstickSprites.get(player.id);
      if (chopstick) {
        chopstick.destroy();
        scene.chopstickSprites.delete(player.id);
      }
      const tip = tipPosition(player);
      graphics.lineStyle(4, 0xf2e9d8, 1);
      graphics.beginPath();
      graphics.moveTo(player.x, player.y);
      graphics.lineTo(tip.x, tip.y);
      graphics.strokePath();
    }

    const mouth = mouthPosition(player);
    if (hasMouth) {
      let mouthSprite = scene.mouthSprites.get(player.id);
      if (!mouthSprite) {
        mouthSprite = scene.add.image(mouth.x, mouth.y, mouthKey);
        mouthSprite.setDisplaySize(MOUTH_SIZE, MOUTH_SIZE);
        mouthSprite.setDepth(1);
        scene.mouthSprites.set(player.id, mouthSprite);
      } else if (mouthSprite.texture.key !== mouthKey) {
        mouthSprite.setTexture(mouthKey);
      }
      mouthSprite.setPosition(mouth.x, mouth.y);
    } else {
      const mouthSprite = scene.mouthSprites.get(player.id);
      if (mouthSprite) {
        mouthSprite.destroy();
        scene.mouthSprites.delete(player.id);
      }
      graphics.fillStyle(0xffd86b, 0.35);
      graphics.fillCircle(mouth.x, mouth.y, MOUTH_RADIUS);
      graphics.lineStyle(2, 0xffd86b, 0.9);
      graphics.strokeCircle(mouth.x, mouth.y, MOUTH_RADIUS);
    }

    const tip = tipPosition(player);
    drawCone(graphics, tip, player.angle, CONE_RADIUS, CONE_HALF_ANGLE, 0x4b7867);
  }

  cleanupPlayerSprites(scene.playerSprites, seen);
  cleanupPlayerSprites(scene.chopstickSprites, seen);
  cleanupPlayerSprites(scene.mouthSprites, seen);
}

function cleanupPlayerSprites(map, seen) {
  for (const [id, sprite] of map.entries()) {
    if (!seen.has(id)) {
      sprite.destroy();
      map.delete(id);
    }
  }
}

function getFoodTextureKey(value) {
  return FOOD_VALUE_TO_KEY.get(value) || "food_01";
}

function buildHud(players, state) {
  const left = players.find((p) => p.side === "left");
  const right = players.find((p) => p.side === "right");
  const leftValue = left ? Math.min(left.fullness, maxFullness) : 0;
  const rightValue = right ? Math.min(right.fullness, maxFullness) : 0;
  const leftBar = makeBar(leftValue, maxFullness);
  const rightBar = makeBar(rightValue, maxFullness);
  const status = state.gameOver
    ? state.loserId === localId
      ? "你被吃撑了"
      : "对手被吃撑了"
    : "对战中";
  return `左侧饱腹 ${leftBar}  ${leftValue}/${maxFullness}\n右侧饱腹 ${rightBar}  ${rightValue}/${maxFullness}\n状态：${status}`;
}

function makeBar(value, max) {
  const total = 12;
  const filled = Math.round((value / max) * total);
  return "=".repeat(filled) + ".".repeat(total - filled);
}

function drawCone(graphics, origin, angle, radius, halfAngle, color) {
  const startAngle = angle - halfAngle;
  const endAngle = angle + halfAngle;
  graphics.lineStyle(2, color, 0.6);
  graphics.beginPath();
  graphics.moveTo(origin.x, origin.y);
  graphics.lineTo(
    origin.x + Math.cos(startAngle) * radius,
    origin.y + Math.sin(startAngle) * radius
  );
  graphics.moveTo(origin.x, origin.y);
  graphics.lineTo(
    origin.x + Math.cos(endAngle) * radius,
    origin.y + Math.sin(endAngle) * radius
  );
  graphics.strokePath();
  graphics.lineStyle(1, color, 0.25);
  graphics.strokeCircle(origin.x, origin.y, radius);
}

connect();
