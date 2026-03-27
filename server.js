const express = require("express");
const { WebSocketServer } = require("ws");
const { EditableNetworkedDOM } = require("@mml-io/networked-dom-server");
const fs = require("fs");
const path = require("path");
const http = require("http");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Use path.join to find arcade.html relative to this file
const arcadePath = path.join(__dirname, "arcade.html");
const arcadeContent = fs.readFileSync(arcadePath, "utf8");

const mmlDocument = new EditableNetworkedDOM(
  "http://localhost/arcade.html",
  () => arcadeContent
);

// Handle WebSocket connections
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`MML server running on port ${PORT}`);
});
