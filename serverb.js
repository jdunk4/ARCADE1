const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const fs = require("fs");
const { createCanvas } = require("canvas");

// SNES emulator — snes9x compiled to WASM, wrapped for Node
// npm install snes9x-wasm
const Snes9x = require("snes9x-wasm");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const ROM_DIR = path.join(__dirname, "rom");
const DATA_DIR = path.join(__dirname, "data");
const BACKEND_URL = process.env.BACKEND_URL || "https://gamer-production.up.railway.app";
const ROM_SECRET = process.env.ROM_SECRET;

// Target frame rate — 30fps is a good balance of smoothness vs bandwidth
// 60fps doubles bandwidth, consider per-ROM config
const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;

// SNES native resolution
const SNES_W = 256;
const SNES_H = 224;

// ── CORS ──────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
if (req.method === "OPTIONS") return res.sendStatus(200);
next();
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
res.send("SNES streaming server running");
});

// ── Session manager ───────────────────────────────────────────────────────────
// Each WebSocket connection = one player session with its own emulator instance
// This is memory-intensive — each session loads a full emulator + ROM into RAM
// For 260 machines at scale you'll want session pooling or Akash multi-node

const sessions = new Map(); // ws -> session

async function createSession(ws, romId, wallet) {
console.log(`Creating session: rom=${romId} wallet=${wallet}`);

// ── Load ROM ────────────────────────────────────────────────────────────
const romFiles = fs.readdirSync(ROM_DIR);
// Match rom file by ID slug (e.g. "kaizo-mario-world-1" matches "Kaizo Mario (English).sfc")
const romFile = romFiles.find(f =>
f.toLowerCase().replace(/[^a-z0-9]/g, "-").includes(romId.replace(/_/g, "-"))
);

if (!romFile) {
ws.send(JSON.stringify({ type: "error", message: "ROM not found: " + romId }));
ws.close();
return;
}

const romData = fs.readFileSync(path.join(ROM_DIR, romFile));

// ── Init emulator ───────────────────────────────────────────────────────
const snes = await Snes9x.create();
snes.loadROM(romData);

// ── Load save state if player has one ───────────────────────────────────
if (wallet !== "anonymous") {
try {
const res = await fetch(`${BACKEND_URL}/save?wallet=${wallet}&rom=${romId}`);
const data = await res.json();
if (data.state) {
const bytes = Buffer.from(data.state, "base64");
snes.loadState(bytes);
console.log(`Save state loaded for ${wallet}`);
}
} catch (e) {
console.warn("Could not load save state:", e.message);
}
}

// ── Canvas for frame rendering ──────────────────────────────────────────
const canvas = createCanvas(SNES_W, SNES_H);
const ctx = canvas.getContext("2d");

// ── Completion tracking ─────────────────────────────────────────────────
let completed = false;

// SNES end-sequence memory address — adjust per ROM hack
// Read from emulator RAM every N frames
const COMPLETION_ADDR = 0x1F28;

// ── Frame loop ──────────────────────────────────────────────────────────
let frameCount = 0;
const frameInterval = setInterval(() => {
if (ws.readyState !== ws.OPEN) {
clearInterval(frameInterval);
return;
}

// Run one SNES frame
snes.runFrame();
frameCount++;

// Get pixel data from emulator framebuffer
const pixels = snes.getFrameBuffer(); // Uint8ClampedArray RGBA
const imageData = ctx.createImageData(SNES_W, SNES_H);
imageData.data.set(pixels);
ctx.putImageData(imageData, 0, 0);

// Encode frame as base64 PNG
// Mirrors Gameboy blueprint: sends { image, audio } JSON each frame
const imageBase64 = canvas.toDataURL("image/png");

const payload = { image: imageBase64 };

// Check completion every 90 frames (~3 seconds at 30fps)
if (!completed && frameCount % 90 === 0) {
try {
const val = snes.readMemory(COMPLETION_ADDR);
if (val === 1) {
completed = true;
payload.type = "completion";
// Log to backend
fetch(`${BACKEND_URL}/complete`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ wallet, rom: romId })
}).catch(() => {});
}
} catch (e) {}
}

ws.send(JSON.stringify(payload));
}, FRAME_MS);

// ── Auto-save every 60 seconds ──────────────────────────────────────────
const saveInterval = setInterval(async () => {
if (wallet === "anonymous") return;
try {
const stateBytes = snes.saveState();
const base64 = Buffer.from(stateBytes).toString("base64");
await fetch(`${BACKEND_URL}/save`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ wallet, rom: romId, state: base64 })
});
console.log(`Auto-saved: ${wallet} / ${romId}`);
} catch (e) {
console.warn("Auto-save failed:", e.message);
}
}, 60000);

const session = { snes, frameInterval, saveInterval, wallet, romId };
sessions.set(ws, session);
}

async function destroySession(ws) {
const session = sessions.get(ws);
if (!session) return;

clearInterval(session.frameInterval);
clearInterval(session.saveInterval);

// Final save on disconnect
if (session.wallet !== "anonymous") {
try {
const stateBytes = session.snes.saveState();
const base64 = Buffer.from(stateBytes).toString("base64");
await fetch(`${BACKEND_URL}/save`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
wallet: session.wallet,
rom: session.romId,
state: base64
})
});
console.log(`Final save written: ${session.wallet}`);
} catch (e) {}
}

session.snes.destroy();
sessions.delete(ws);
console.log(`Session destroyed: ${session.wallet} / ${session.romId}`);
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

wss.on("connection", async (ws, req) => {
// Parse rom and wallet from query string
// arcade-b.html connects as: wss://server/tunnel?rom=kaizo-mario-world-1&wallet=0xABC
const url = new URL(req.url, "http://localhost");
const romId = url.searchParams.get("rom") || "kaizo-mario-world-1";
const wallet = url.searchParams.get("wallet") || "anonymous";

console.log(`Client connected: rom=${romId} wallet=${wallet}`);

await createSession(ws, romId, wallet);

// ── Input handling — mirrors Gameboy blueprint sendKey exactly ────────────
// Client sends { type: "keyDown", key: "left" } / { type: "keyUp", key: "left" }
ws.on("message", (data) => {
const session = sessions.get(ws);
if (!session) return;

try {
const msg = JSON.parse(data);

// Map key names to snes9x-wasm button constants
const buttonMap = {
up: "UP",
down: "DOWN",
left: "LEFT",
right: "RIGHT",
a: "A",
b: "B",
x: "X",
y: "Y",
start: "START",
select: "SELECT",
l: "L",
r: "R"
};

const button = buttonMap[msg.key];
if (!button) return;

if (msg.type === "keyDown") {
session.snes.pressButton(button, true);
} else if (msg.type === "keyUp") {
session.snes.pressButton(button, false);
}
} catch (e) {}
});

ws.on("close", () => {
console.log(`Client disconnected: ${wallet}`);
destroySession(ws);
});

ws.on("error", (e) => {
console.error("WebSocket error:", e.message);
destroySession(ws);
});
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8081;
server.listen(PORT, () => {
console.log(`SNES streaming server running on port ${PORT}`);
console.log(`Target FPS: ${TARGET_FPS} | Frame interval: ${FRAME_MS}ms`);
});
