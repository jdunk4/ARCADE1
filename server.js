const express = require("express");
const { WebSocketServer } = require("ws");
const { EditableNetworkedDOM } = require("@mml-io/networked-dom-server");
const fs = require("fs");
const path = require("path");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

// Health check
app.get("/", (req, res) => {
  res.send("MML Arcade Server is running!");
});

// Protected ROM endpoint
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/octet-stream");
  res.sendFile(romPath);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`MML server running on port ${PORT}`);
});
