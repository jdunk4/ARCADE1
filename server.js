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

app.get("/", (req, res) => {
  res.send("MML Arcade Server is running!");
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`MML server running on port ${PORT}`);
});
