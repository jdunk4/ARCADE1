const express = require("express");
const { WebSocketServer } = require("ws");
const { EditableNetworkedDOM } = require("@mml-io/networked-dom-server");
const fs = require("fs");
const path = require("path");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "10mb" }));

// ─── MML Document ────────────────────────────────────────────────────────────

const arcadePath = path.join(__dirname, "arcade.html");

const mmlDocument = new EditableNetworkedDOM(
  "http://localhost/arcade.html",
  () => fs.readFileSync(arcadePath, "utf8")
);

wss.on("connection", (ws) => {
  console.log("Client connected");
  mmlDocument.addWebSocket(ws);
  ws.on("close", () => {
    console.log("Client disconnected");
    mmlDocument.removeWebSocket(ws);
  });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
// NOTE: origin can be null when requests come from Puppeteer headless Chrome
// In that case we fall back to * to allow ROM and save state fetches to work

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) {
    // Puppeteer / headless — allow everything
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Browser request — echo origin back (allows all browser origins too)
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── Data Storage ─────────────────────────────────────────────────────────────

const DATA_PATH = path.join(__dirname, "data");
if (!fs.existsSync(DATA_PATH)) fs.mkdirSync(DATA_PATH);

function getPlayerPath(wallet) {
  const safe = wallet.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(DATA_PATH, `${safe}.json`);
}

function loadPlayer(wallet) {
  const p = getPlayerPath(wallet);
  if (!fs.existsSync(p)) return { wallet, saves: {}, completions: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function savePlayer(data) {
  fs.writeFileSync(getPlayerPath(data.wallet), JSON.stringify(data, null, 2));
}

function loadCompletions() {
  const p = path.join(DATA_PATH, "completions.json");
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveCompletions(data) {
  fs.writeFileSync(
    path.join(DATA_PATH, "completions.json"),
    JSON.stringify(data, null, 2)
  );
}

// ─── ROM Endpoint ─────────────────────────────────────────────────────────────

app.get("/rom/:filename", (req, res) => {
  const secret = req.query.token;
  const expectedSecret = process.env.ROM_SECRET;

  if (!secret || secret !== expectedSecret) {
    return res.status(403).json({ error: "Access denied" });
  }

  const filename = decodeURIComponent(req.params.filename);
  const romPath = path.join(__dirname, "rom", filename);

  if (!fs.existsSync(romPath)) {
    return res.status(404).json({ error: "ROM not found" });
  }

  console.log(`Serving ROM: ${filename}`);
  res.setHeader("Content-Type", "application/octet-stream");
  res.sendFile(romPath);
});

// ─── Save State Endpoints ─────────────────────────────────────────────────────

app.post("/save", (req, res) => {
  const { wallet, rom, state } = req.body;
  if (!wallet || !rom || !state) {
    return res.status(400).json({ error: "wallet, rom, and state required" });
  }
  const player = loadPlayer(wallet);
  player.saves[rom] = state;
  savePlayer(player);
  console.log(`Save state written: ${wallet} / ${rom}`);
  res.json({ ok: true });
});

app.get("/save", (req, res) => {
  const { wallet, rom } = req.query;
  if (!wallet || !rom) {
    return res.status(400).json({ error: "wallet and rom required" });
  }
  const player = loadPlayer(wallet);
  const state = player.saves[rom] || null;
  res.json({ state });
});

// ─── Completion Endpoints ─────────────────────────────────────────────────────

app.post("/complete", (req, res) => {
  const { wallet, rom } = req.body;
  if (!wallet || !rom) {
    return res.status(400).json({ error: "wallet and rom required" });
  }
  const player = loadPlayer(wallet);
  if (!player.completions.includes(rom)) {
    player.completions.push(rom);
    savePlayer(player);
    console.log(`Completion logged: ${wallet} finished ${rom}`);
  }
  const completions = loadCompletions();
  if (!completions[rom]) completions[rom] = [];
  if (!completions[rom].includes(wallet)) {
    completions[rom].push(wallet);
    saveCompletions(completions);
  }
  res.json({ ok: true, totalCompletions: (completions[rom] || []).length });
});

app.get("/completions/:rom", (req, res) => {
  const completions = loadCompletions();
  const wallets = completions[req.params.rom] || [];
  res.json({ rom: req.params.rom, count: wallets.length });
});

app.get("/leaderboard", (req, res) => {
  const dataFiles = fs
    .readdirSync(DATA_PATH)
    .filter((f) => f !== "completions.json");
  const rankings = [];
  for (const file of dataFiles) {
    try {
      const player = JSON.parse(
        fs.readFileSync(path.join(DATA_PATH, file), "utf8")
      );
      rankings.push({
        wallet: player.wallet,
        completions: player.completions.length,
        completed: player.completions,
      });
    } catch (e) {}
  }
  rankings.sort((a, b) => b.completions - a.completions);
  res.json({ leaderboard: rankings.slice(0, 50) });
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send("MML Arcade Server is running!");
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`MML server running on port ${PORT}`);
});
