const express = require("express");
const { WebSocketServer } = require("ws");
const { EditableNetworkedDOM } = require("@mml-io/networked-dom-server");
const fs = require("fs");
const path = require("path");
const http = require("http");

const app = express();

app.get("/", (req, res) => {
  res.send("MML Arcade Server is running!");
});

const server = http.createServer(app);

const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: false
});

const arcadePath = path.join(__dirname, "arcade.html");

const mmlDocument = new EditableNetworkedDOM(
  "http://localhost/arcade.html",
  () => fs.readFileSync(arcadePath, "utf8")
);

wss.on("connection", (ws, req) => {
  console.log("Client connected from:", req.headers.origin || "unknown");
  mmlDocument.addWebSocket(ws);

  ws.on("close", () => {
    console.log("Client disconnected");
    mmlDocument.removeWebSocket(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
});

// Handle upgrade explicitly
server.on("upgrade", (request, socket, head) => {
  console.log("WebSocket upgrade request received");
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`MML server running on port ${PORT}`);
});
