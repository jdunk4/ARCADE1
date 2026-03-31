const express    = require("express");
const http       = require("http");
const { WebSocketServer } = require("ws");
const path       = require("path");
const fs         = require("fs");
const { createCanvas } = require("canvas");
const jsnes      = require("jsnes");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const ROM_DIR      = path.join(__dirname, "rom");
const BACKEND_URL  = process.env.BACKEND_URL || "https://gamer-production.up.railway.app";

// 30fps — good balance of smoothness vs bandwidth for streaming over WebSocket
// Each PNG frame is ~15-40KB, so 30fps = ~450KB-1.2MB/s per session
const TARGET_FPS = 30;
const FRAME_MS   = 1000 / TARGET_FPS;

// NES native resolution
const NES_W = 256;
const NES_H = 240;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("NES streaming server running ✅"));

// ── Button map — client sends these string names ──────────────────────────────
const BUTTON_MAP = {
  up:     jsnes.Controller.BUTTON_UP,
  down:   jsnes.Controller.BUTTON_DOWN,
  left:   jsnes.Controller.BUTTON_LEFT,
  right:  jsnes.Controller.BUTTON_RIGHT,
  a:      jsnes.Controller.BUTTON_A,
  b:      jsnes.Controller.BUTTON_B,
  start:  jsnes.Controller.BUTTON_START,
  select: jsnes.Controller.BUTTON_SELECT,
};

// ── Session manager ───────────────────────────────────────────────────────────
const sessions = new Map(); // ws → session

function createSession(ws, romId, wallet) {
  console.log(`[session] creating: rom=${romId} wallet=${wallet}`);

  // ── Find ROM file ──────────────────────────────────────────────────────
  // Matches slug like "super-mario-bros" against filenames in /rom
  const romFiles = fs.readdirSync(ROM_DIR).filter(f =>
    f.toLowerCase().endsWith(".nes")
  );
  const romFile = romFiles.find(f =>
    f.toLowerCase().replace(/[^a-z0-9]/g, "-").includes(
      romId.toLowerCase().replace(/[^a-z0-9]/g, "-")
    )
  );

  if (!romFile) {
    console.error(`[session] ROM not found for id: ${romId}`);
    console.error(`[session] Available ROMs: ${romFiles.join(", ")}`);
    ws.send(JSON.stringify({ type: "error", message: "ROM not found: " + romId }));
    ws.close();
    return;
  }

  console.log(`[session] loading ROM: ${romFile}`);

  // ── Canvas for frame rendering ─────────────────────────────────────────
  const canvas = createCanvas(NES_W, NES_H);
  const ctx    = canvas.getContext("2d");
  const imageData = ctx.createImageData(NES_W, NES_H);

  // ── Latest framebuffer — written by onFrame, read by interval ─────────
  let latestFrameBuffer = null;
  let frameCount = 0;
  let frameInterval = null;

  // ── Init jsnes ─────────────────────────────────────────────────────────
  const nes = new jsnes.NES({
    onFrame: function(frameBuffer) {
      // frameBuffer is Int32Array of ARGB — convert to RGBA Uint8ClampedArray
      // jsnes gives us one frame worth of pixels here
      latestFrameBuffer = frameBuffer;
    },
    onAudioSample: function(_left, _right) {
      // Audio streaming is a future enhancement
      // For now we skip it — video-only pipeline
    }
  });

  // Load ROM — jsnes wants a binary string (encoding: 'binary')
  const romData = fs.readFileSync(path.join(ROM_DIR, romFile), { encoding: "binary" });
  nes.loadROM(romData);
  console.log(`[session] ROM loaded: ${romFile}`);

  // ── Frame loop ─────────────────────────────────────────────────────────
  frameInterval = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(frameInterval);
      return;
    }

    // Run one NES frame — this triggers onFrame callback above
    nes.frame();
    frameCount++;

    if (!latestFrameBuffer) return;

    // Convert ARGB Int32Array → RGBA Uint8ClampedArray for canvas
    for (let i = 0; i < NES_W * NES_H; i++) {
      const argb = latestFrameBuffer[i];
      imageData.data[i * 4 + 0] = (argb >> 16) & 0xff; // R
      imageData.data[i * 4 + 1] = (argb >>  8) & 0xff; // G
      imageData.data[i * 4 + 2] = (argb >>  0) & 0xff; // B
      imageData.data[i * 4 + 3] = 0xff;                 // A — always opaque
    }

    ctx.putImageData(imageData, 0, 0);

    // Encode as JPEG for smaller payload — PNG is ~3x larger
    // Quality 0.7 gives good balance of file size vs visual quality
    const imageBase64 = canvas.toDataURL("image/jpeg", 0.7);

    ws.send(JSON.stringify({ image: imageBase64 }), (err) => {
      if (err) console.warn("[session] send error:", err.message);
    });

  }, FRAME_MS);

  // ── Auto-save every 60s ────────────────────────────────────────────────
  // jsnes doesn't have built-in save state — skip for NES test
  // Will add with SNES emulator that supports it

  const session = { nes, frameInterval, wallet, romId };
  sessions.set(ws, session);
  console.log(`[session] started: ${wallet} / ${romId}`);
}

function destroySession(ws) {
  const session = sessions.get(ws);
  if (!session) return;
  clearInterval(session.frameInterval);
  sessions.delete(ws);
  console.log(`[session] destroyed: ${session.wallet} / ${session.romId}`);
}

// ── WebSocket handler ─────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const url    = new URL(req.url, "http://localhost");
  const romId  = url.searchParams.get("rom")    || "super-mario-bros";
  const wallet = url.searchParams.get("wallet") || "anonymous";

  console.log(`[ws] client connected: rom=${romId} wallet=${wallet}`);

  createSession(ws, romId, wallet);

  // ── Input ─────────────────────────────────────────────────────────────
  ws.on("message", (data) => {
    const session = sessions.get(ws);
    if (!session) return;

    try {
      const msg = JSON.parse(data);
      const button = BUTTON_MAP[msg.key];
      if (button === undefined) return;

      if (msg.type === "keyDown") {
        session.nes.buttonDown(1, button); // player 1
      } else if (msg.type === "keyUp") {
        session.nes.buttonUp(1, button);
      }
    } catch (e) {
      console.warn("[ws] bad message:", e.message);
    }
  });

  ws.on("close", () => {
    console.log(`[ws] client disconnected: ${wallet}`);
    destroySession(ws);
  });

  ws.on("error", (e) => {
    console.error("[ws] error:", e.message);
    destroySession(ws);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
  console.log(`NES streaming server on port ${PORT}`);
  console.log(`Target: ${TARGET_FPS}fps / ${FRAME_MS}ms per frame`);
  console.log(`ROM directory: ${ROM_DIR}`);
});
