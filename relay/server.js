/**
 * Claude Code remote — relay (runs on Fly.io).
 *
 * A tiny, stateless WebSocket hub. Two roles connect to it and are paired into
 * one "room" by a shared token:
 *   - "runner" : the local Agent SDK process on the user's PC (has the files)
 *   - "device" : the ESP32 hardware remote
 *
 * The relay holds no API key and no files — it only forwards JSON messages
 * between the two members of a room. This mirrors how Claude Code's own Remote
 * Control works (local stays local, dials out, a relay in the middle), except
 * we own this relay and the runner uses the Agent SDK so physical approve/deny
 * actually works.
 *
 * First message from each client must be a hello:
 *   { "type": "hello", "role": "runner"|"device", "token": "<shared secret>" }
 * Everything after that is forwarded verbatim to the peer.
 *
 * Relay -> client control messages:
 *   { "type": "relay", "event": "paired",       "role": "...", "peer": bool }
 *   { "type": "relay", "event": "peer-online",  "role": "..." }
 *   { "type": "relay", "event": "peer-offline", "role": "..." }
 *   { "type": "relay", "event": "error",        "text": "..." }
 */

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.RELAY_TOKEN || "";

if (!TOKEN) {
  console.warn("WARNING: RELAY_TOKEN is empty — set it as a Fly secret.");
}

const other = (role) => (role === "runner" ? "device" : "runner");
const mask = (t) => (t ? t.slice(0, 3) + "…" : "?");

/** token -> { runner: ws|null, device: ws|null } */
const rooms = new Map();
function room(token) {
  if (!rooms.has(token)) rooms.set(token, { runner: null, device: null });
  return rooms.get(token);
}
function jsend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  // Plain HTTP is only used for Fly health checks.
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("relay ok\n");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  let bound = false;

  ws.on("message", (raw) => {
    const text = raw.toString();

    if (!bound) {
      let hello;
      try {
        hello = JSON.parse(text);
      } catch {
        jsend(ws, { type: "relay", event: "error", text: "bad hello" });
        ws.close();
        return;
      }
      if (
        !hello ||
        hello.type !== "hello" ||
        hello.token !== TOKEN ||
        (hello.role !== "runner" && hello.role !== "device")
      ) {
        jsend(ws, { type: "relay", event: "error", text: "auth failed" });
        ws.close();
        return;
      }

      bound = true;
      ws._role = hello.role;
      ws._token = hello.token;

      const r = room(hello.token);
      // Newest connection of a role wins (matches the single-client model).
      if (r[ws._role] && r[ws._role] !== ws) {
        try {
          r[ws._role].close();
        } catch {}
      }
      r[ws._role] = ws;

      const peer = r[other(ws._role)];
      const peerOnline = !!(peer && peer.readyState === peer.OPEN);
      jsend(ws, { type: "relay", event: "paired", role: ws._role, peer: peerOnline });
      jsend(peer, { type: "relay", event: "peer-online", role: ws._role });
      console.log(`+ ${ws._role} joined room ${mask(ws._token)} (peer=${peerOnline})`);
      return;
    }

    // Forward everything else to the peer in the same room.
    const dst = room(ws._token)[other(ws._role)];
    if (dst && dst.readyState === dst.OPEN) dst.send(text);
  });

  ws.on("close", () => {
    if (!bound) return;
    const r = rooms.get(ws._token);
    if (!r) return;
    if (r[ws._role] === ws) r[ws._role] = null;
    jsend(r[other(ws._role)], { type: "relay", event: "peer-offline", role: ws._role });
    console.log(`- ${ws._role} left room ${mask(ws._token)}`);
  });
});

// Keepalive: drop dead sockets, ping the rest. Fly and NAT both idle-timeout
// long-lived connections, so this keeps the runner<->device pipe healthy.
const PING_MS = 30000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  });
}, PING_MS);

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
