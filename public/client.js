const statusEl = document.getElementById("status");
const roomEl = document.getElementById("room");
const inviteEl = document.getElementById("invite");
const debugEl = document.getElementById("debugInfo");
const readyBtn = document.getElementById("readyBtn");
const newRoomBtn = document.getElementById("newRoomBtn");
const aboutBtn = document.getElementById("aboutBtn");
const aboutModal = document.getElementById("aboutModal");
const aboutClose = document.getElementById("aboutClose");

const VIRTUAL_WIDTH = 960;
const VIRTUAL_HEIGHT = 540;

const config = {
  type: Phaser.AUTO,
  parent: "game",
  width: VIRTUAL_WIDTH,
  height: VIRTUAL_HEIGHT,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH
  },
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
let roomId = null;
let localReady = false;
let serverState = null;
let predictedPlayer = null;
let lastInputSent = 0;
let maxFullness = 100;
let texturesEnabled = true;
let reconnectTimer = null;
let reconnectAttempts = 0;

const MOVE_SPEED = 220;
const MAX_ANGULAR_SPEED = 4.5;
const BODY_SIZE = 139;
const MOUTH_SIZE = 72;
const RIGHT_MOUTH_SCALE = 0.85;
const RIGHT_MOUTH_OFFSET_MULT = 0.48;
const MOUTH_OPEN_SCALE = 1.4;
const CHOPSTICK_LENGTH = 181;
const CHOPSTICK_DISPLAY_SCALE = 1.3;
const CONE_RADIUS = 162;
const CONE_HALF_ANGLE = Math.PI / 3;
const MOUTH_RADIUS = 26;
const BACKGROUND_ALPHA = 0.35;
const TIP_MARKER_RADIUS = 7;

const PLAYER_TEXTURE_KEYS = {
  left: {
    body: "player_left_body",
    chopstick: "player_left_chopstick",
    mouthClosed: "player_left_mouth_closed",
    mouthOpen: "player_left_mouth_open"
  },
  right: {
    body: "player_right_body",
    chopstick: "player_right_chopstick",
    mouthClosed: "player_right_mouth_closed",
    mouthOpen: "player_right_mouth_open"
  }
};

const FOOD_VALUE_TO_KEY = new Map([
  [6, "food_01"],
  [7, "food_03"],
  [8, "food_04"],
  [9, "food_05"],
  [10, "food_06"],
  [11, "food_08"],
  [12, "food_09"],
  [13, "food_10"]
]);

const FOOD_VALUE_TO_SCALE = new Map([
  [6, 1.6],
  [7, 1.7],
  [8, 1.8],
  [9, 1.9],
  [10, 2.0],
  [11, 2.1],
  [12, 2.2],
  [13, 2.3]
]);
const FOOD_BASE_SIZE = 22;

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
  const offsetMult =
    player.side === "right" ? RIGHT_MOUTH_OFFSET_MULT : 0.6;
  return { x: player.x, y: player.y - BODY_SIZE * offsetMult };
}

function initRoom() {
  const url = new URL(window.location.href);
  roomId = url.searchParams.get("room");
  if (!roomId) {
    roomId = Math.random().toString(36).slice(2, 8);
    url.searchParams.set("room", roomId);
    window.history.replaceState(null, "", url.toString());
  }
  roomEl.textContent = `房间：${roomId}`;
  inviteEl.textContent = `邀请链接：${url.toString()}`;
}

function switchRoom() {
  const url = new URL(window.location.href);
  const newRoomId = Math.random().toString(36).slice(2, 8);
  url.searchParams.set("room", newRoomId);
  window.location.replace(url.toString());
}

function updateReadyButton() {
  if (serverState?.gameOver) {
    readyBtn.textContent = localReady ? "取消再来一局" : "再来一局(就绪)";
    return;
  }
  readyBtn.textContent = localReady ? "取消就绪" : "点击就绪";
}

function getScale() {
  const scaleX = config.width / VIRTUAL_WIDTH;
  const scaleY = config.height / VIRTUAL_HEIGHT;
  return Math.max(scaleX, scaleY);
}

function updateCameraViewport(scene) {
  const scale = getScale();
  scene.cameras.main.setViewport(0, 0, config.width, config.height);
  scene.cameras.main.setBounds(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
  scene.cameras.main.setZoom(scale);
  scene.cameras.main.centerOn(VIRTUAL_WIDTH / 2, VIRTUAL_HEIGHT / 2);
}

function updateDebugInfo() {
  if (!debugEl) return;
  const stateMap = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
  const socketState = socket
    ? stateMap[socket.readyState] || String(socket.readyState)
    : "NONE";
  const socketUrl = socket?.url || "未连接";
  const playerCount = serverState?.players?.length || 0;
  const playerList =
    serverState?.players
      ?.map((player) => `${player.id}:${player.side}`)
      .join(", ") || "-";
  debugEl.textContent =
    `WS: ${socketUrl}\n` +
    `状态: ${socketState}\n` +
    `房间: ${roomId || "-"} | 本地ID: ${localId || "-"}\n` +
    `玩家: ${playerCount} (${playerList})`;
}

function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(
    `${protocol}://${window.location.host}?room=${roomId}`
  );
  readyBtn.disabled = true;
  updateDebugInfo();

  socket.addEventListener("open", () => {
    statusEl.textContent = "等待玩家加入...";
    readyBtn.disabled = false;
    reconnectAttempts = 0;
    updateDebugInfo();
  });

  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "welcome") {
      localId = msg.id;
      localSide = msg.side;
      predictedPlayer = null;
      if (msg.roomId) {
        roomId = msg.roomId;
        roomEl.textContent = `房间：${roomId}`;
      }
      if (Number.isFinite(msg.config?.maxFullness)) {
        maxFullness = msg.config.maxFullness;
      }
      if (!game) {
        config.width = window.innerWidth;
        config.height = window.innerHeight;
        game = new Phaser.Game(config);
      }
      updateDebugInfo();
    }
    if (msg.type === "state") {
      serverState = msg;
      if (typeof msg.texturesEnabled === "boolean") {
        texturesEnabled = msg.texturesEnabled;
      }
      if (msg.gameOver) {
        const winText =
          msg.loserId === localId ? "你被吃撑了！" : "对手被吃撑了！";
        statusEl.textContent = `比赛结束：${winText}`;
        localReady = false;
        updateReadyButton();
      } else {
        const readyCount = msg.players.filter((p) => p.ready).length;
        const hasOpponent =
          msg.players.filter((player) => player.id !== localId).length > 0;
        if (!hasOpponent) {
          statusEl.textContent = "等待玩家加入...";
        } else if (!msg.started) {
          statusEl.textContent = `等待就绪 (${readyCount}/2)`;
        } else {
          statusEl.textContent = "战斗中";
        }
      }
      updateDebugInfo();
    }
    if (msg.type === "full") {
      statusEl.textContent = "房间已满";
      updateDebugInfo();
    }
  });

  socket.addEventListener("close", () => {
    statusEl.textContent = "连接已断开";
    updateDebugInfo();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    statusEl.textContent = "连接异常";
    updateDebugInfo();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (document.hidden) {
    reconnectTimer = setTimeout(scheduleReconnect, 1000);
    return;
  }
  const delay = Math.min(5000, 800 + reconnectAttempts * 400);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function preload() {
  this.load.image("bg_wave", "/assets/backgrounds/wave.jpg");
  this.load.image("player_left_body", "/assets/players/left_body.png");
  this.load.image("player_right_body", "/assets/players/right_body.png");
  this.load.image("player_left_chopstick", "/assets/players/left_chopstick.png");
  this.load.image("player_right_chopstick", "/assets/players/right_chopstick.png");
  this.load.image("player_left_mouth_closed", "/assets/players/left_mouth.png");
  this.load.image("player_right_mouth_closed", "/assets/players/right_mouth.png");
  this.load.image(
    "player_left_mouth_open",
    "/assets/players/left_mouth_open.png"
  );
  this.load.image(
    "player_right_mouth_open",
    "/assets/players/right_mouth_open.png"
  );
  for (let i = 1; i <= 10; i += 1) {
    const id = String(i).padStart(2, "0");
    this.load.image(`food_${id}`, `/assets/foods/food_${id}.png`);
  }
}

function create() {
  this.graphics = this.add.graphics();
  this.overlayGraphics = this.add.graphics();
  this.backgroundSprite = null;
  this.foodSprites = new Map();
  this.playerSprites = new Map();
  this.chopstickSprites = new Map();
  this.mouthSprites = new Map();
  if (this.textures.exists("bg_wave")) {
    this.backgroundSprite = this.add.image(0, 0, "bg_wave");
    this.backgroundSprite.setOrigin(0, 0);
    this.backgroundSprite.setDisplaySize(VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    this.backgroundSprite.setAlpha(BACKGROUND_ALPHA);
    this.backgroundSprite.setDepth(0);
  }
  this.uiText = this.add.text(16, 80, "", {
    fontSize: "12px",
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
  const resizeToWindow = () => {
    this.scale.resize(window.innerWidth, window.innerHeight);
    config.width = window.innerWidth;
    config.height = window.innerHeight;
    updateCameraViewport(this);
    if (this.backgroundSprite) {
      this.backgroundSprite.setDisplaySize(VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
    }
  };
  resizeToWindow();
  window.addEventListener("resize", resizeToWindow);
  this.scale.on("resize", (gameSize) => {
    config.width = gameSize.width;
    config.height = gameSize.height;
    updateCameraViewport(this);
  });
}

function update(time, delta) {
  if (!serverState || !localId) return;
  if (!serverState.started) {
    renderScene(this, predictedPlayer || null, serverState);
    return;
  }
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
  predictedPlayer.x = Phaser.Math.Clamp(predictedPlayer.x, 60, VIRTUAL_WIDTH - 60);
  predictedPlayer.y = Phaser.Math.Clamp(predictedPlayer.y, 80, VIRTUAL_HEIGHT - 60);

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
  const worldPoint = scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
  return Math.atan2(worldPoint.y - player.y, worldPoint.x - player.x);
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

function sendReady() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type: "ready",
      ready: localReady
    })
  );
}

function renderScene(scene, localPlayer, state) {
  const g = scene.graphics;
  const overlay = scene.overlayGraphics;
  g.clear();
  overlay.clear();
  if (!scene.backgroundSprite || !texturesEnabled) {
    g.fillStyle(0x111820, 1);
    g.fillRect(0, 0, VIRTUAL_WIDTH, VIRTUAL_HEIGHT);
  }

  const players = state.players.map((player) => {
    if (localPlayer && player.id === localId) {
      return {
        ...localPlayer,
        side: player.side,
        fullness: player.fullness,
        mouthOpen: player.mouthOpen
      };
    }
    return player;
  });

  renderPlayers(scene, g, overlay, players);

  renderFoods(scene, g, players, state.foods);

  scene.uiText.setText(buildHud(players, state));
}

function renderFoods(scene, graphics, players, foods) {
  const seen = new Set();
  for (const food of foods) {
    seen.add(food.id);
    const textureKey = getFoodTextureKey(food.value);
    if (texturesEnabled && scene.textures.exists(textureKey)) {
      let sprite = scene.foodSprites.get(food.id);
      if (!sprite) {
        sprite = scene.add.image(food.x, food.y, textureKey);
        const size = FOOD_BASE_SIZE * getFoodScale(food.value);
        sprite.setDisplaySize(size, size);
        sprite.setDepth(2);
        scene.foodSprites.set(food.id, sprite);
      } else if (sprite.texture.key !== textureKey) {
        sprite.setTexture(textureKey);
        const size = FOOD_BASE_SIZE * getFoodScale(food.value);
        sprite.setDisplaySize(size, size);
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

function renderPlayers(scene, graphics, overlay, players) {
  const seen = new Set();
  for (const player of players) {
    seen.add(player.id);
    const keys = PLAYER_TEXTURE_KEYS[player.side];
    const facingRight = Math.cos(player.angle) >= 0;
    const bodyKey = keys?.body;
    const chopstickKey = keys?.chopstick;
    const mouthKey = player.mouthOpen ? keys?.mouthOpen : keys?.mouthClosed;
    const canUseTextures = texturesEnabled && Boolean(keys);
    const hasBody = canUseTextures && bodyKey && scene.textures.exists(bodyKey);
    const hasChopstick =
      canUseTextures && chopstickKey && scene.textures.exists(chopstickKey);
    const hasMouth = canUseTextures && mouthKey && scene.textures.exists(mouthKey);

    if (hasBody) {
      let body = scene.playerSprites.get(player.id);
      if (!body) {
        body = scene.add.image(player.x, player.y, bodyKey);
        body.setDisplaySize(BODY_SIZE, BODY_SIZE);
        body.setDepth(1);
        scene.playerSprites.set(player.id, body);
      } else if (body.texture.key !== bodyKey) {
        body.setTexture(bodyKey);
        body.setDisplaySize(BODY_SIZE, BODY_SIZE);
      }
      body.setPosition(player.x, player.y);
      body.setFlipX(!facingRight);
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
        const desiredLength = BODY_SIZE * CHOPSTICK_DISPLAY_SCALE;
        const baseWidth = chopstick.width || 1;
        chopstick.setData("baseWidth", baseWidth);
        const localScale = desiredLength / baseWidth;
        chopstick.setScale(localScale);
        chopstick.setDepth(3);
        scene.chopstickSprites.set(player.id, chopstick);
      } else if (chopstick.texture.key !== chopstickKey) {
        chopstick.setTexture(chopstickKey);
        const baseWidth =
          chopstick.getData("baseWidth") || chopstick.width || 1;
        const desiredLength = BODY_SIZE * CHOPSTICK_DISPLAY_SCALE;
        const localScale = desiredLength / baseWidth;
        chopstick.setScale(localScale);
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
      const prevOpen = mouthSprite?.getData("mouthOpen");
      const baseSize =
        player.side === "right" ? MOUTH_SIZE * RIGHT_MOUTH_SCALE : MOUTH_SIZE;
      const size = player.mouthOpen
        ? baseSize * MOUTH_OPEN_SCALE
        : baseSize;
      if (!mouthSprite) {
        mouthSprite = scene.add.image(
          mouth.x,
          mouth.y,
          mouthKey
        );
        mouthSprite.setDisplaySize(size, size);
        mouthSprite.setDepth(1);
        scene.mouthSprites.set(player.id, mouthSprite);
      } else if (mouthSprite.texture.key !== mouthKey) {
        mouthSprite.setTexture(mouthKey);
        mouthSprite.setDisplaySize(size, size);
      } else if (prevOpen !== player.mouthOpen) {
        mouthSprite.setDisplaySize(size, size);
      }
      mouthSprite.setPosition(mouth.x, mouth.y);
      mouthSprite.setData("mouthOpen", player.mouthOpen);
      mouthSprite.setFlipX(!facingRight);
    } else {
      const mouthSprite = scene.mouthSprites.get(player.id);
      if (mouthSprite) {
        mouthSprite.destroy();
        scene.mouthSprites.delete(player.id);
      }
      graphics.fillStyle(0xffd86b, 0.35);
      graphics.fillCircle(mouth.x, mouth.y, MOUTH_RADIUS);
      graphics.lineStyle(2, 0xffd86b, 0.9);
      graphics.strokeCircle(
        mouth.x,
        mouth.y,
        MOUTH_RADIUS
      );
    }

    // Debug overlays removed for clean presentation.
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

function getFoodScale(value) {
  return FOOD_VALUE_TO_SCALE.get(value) || 2.0;
}

function buildHud(players, state) {
  const left = players.find((p) => p.side === "left");
  const right = players.find((p) => p.side === "right");
  const leftValue = left ? Math.min(left.fullness, maxFullness) : 0;
  const rightValue = right ? Math.min(right.fullness, maxFullness) : 0;
  const leftBar = makeBar(leftValue, maxFullness);
  const rightBar = makeBar(rightValue, maxFullness);
  return `左侧饱腹 ${leftBar}  ${leftValue}/${maxFullness}\n右侧饱腹 ${rightBar}  ${rightValue}/${maxFullness}`;
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

initRoom();
updateReadyButton();
readyBtn.addEventListener("click", () => {
  if (readyBtn.disabled) return;
  localReady = !localReady;
  updateReadyButton();
  sendReady();
});

newRoomBtn.addEventListener("click", () => {
  switchRoom();
});

aboutBtn.addEventListener("click", () => {
  aboutModal.classList.remove("hidden");
});

aboutClose.addEventListener("click", () => {
  aboutModal.classList.add("hidden");
});

aboutModal.addEventListener("click", (event) => {
  if (event.target === aboutModal) {
    aboutModal.classList.add("hidden");
  }
});

connect();
