/**
 * Claude Code remote — relay (runs on Fly.io).
 *
 * A small stateless hub. Within one token "account" there can be many
 * **runners** (each = a session: a machine/folder running the Agent SDK) and
 * one or more **devices** (the ESP32 remotes). On boot a device gets the list
 * of sessions, picks one, and is then routed to that runner.
 *
 * Holds no API key and no files — it only forwards JSON.
 *
 * hello (first message from each client):
 *   { "type":"hello", "role":"runner", "token":"…", "name":"my-repo" }
 *   { "type":"hello", "role":"device", "token":"…" }
 *
 * Relay -> device:
 *   { "type":"sessions", "items":[{ "id":"1", "name":"my-repo", "online":true }] }
 *   { "type":"relay", "event":"session-offline" }   // your selected runner left
 *   { "type":"relay", "event":"error", "text":"…" }
 *   …plus everything the selected runner sends (presets/status/tool/text/result)
 *
 * Device -> relay:
 *   { "type":"select", "id":"1" }   // choose a session to control
 *   { "type":"list" }               // re-request the session list
 *   …plus launch/approve/mode/interrupt -> forwarded to the selected runner
 *
 * Relay -> runner:
 *   { "type":"relay", "event":"paired", "id":"1" }
 *   { "type":"relay", "event":"device-attached" }   // a device selected you -> send presets
 */

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.RELAY_TOKEN || "";
if (!TOKEN) console.warn("WARNING: RELAY_TOKEN is empty — set it as a Fly secret.");

const mask = (t) => (t ? t.slice(0, 3) + "…" : "?");
let nextId = 1;

/** token -> { runners: Map<id, ws>, devices: Set<ws> } */
const rooms = new Map();
function room(t) {
  if (!rooms.has(t)) rooms.set(t, { runners: new Map(), devices: new Set() });
  return rooms.get(t);
}
function jsend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function sessionList(r) {
  return {
    type: "sessions",
    items: [...r.runners.entries()].map(([id, ws]) => ({ id, name: ws._name, online: true })),
  };
}
function broadcastSessions(r) {
  const msg = sessionList(r);
  for (const d of r.devices) jsend(d, msg);
}

const server = http.createServer((req, res) => {
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
  ws.on("pong", () => { ws.isAlive = true; });
  let bound = false;

  ws.on("message", (raw) => {
    const text = raw.toString();

    if (!bound) {
      let h;
      try { h = JSON.parse(text); } catch { jsend(ws, { type: "relay", event: "error", text: "bad hello" }); ws.close(); return; }
      if (!h || h.type !== "hello" || h.token !== TOKEN || (h.role !== "runner" && h.role !== "device")) {
        jsend(ws, { type: "relay", event: "error", text: "auth failed" });
        ws.close();
        return;
      }
      bound = true;
      ws._role = h.role;
      ws._token = h.token;
      const r = room(h.token);

      if (ws._role === "runner") {
        ws._id = String(nextId++);
        ws._name = String(h.name || ("session " + ws._id)).slice(0, 40);
        r.runners.set(ws._id, ws);
        jsend(ws, { type: "relay", event: "paired", id: ws._id });
        broadcastSessions(r);
        console.log(`+ runner ${ws._id} "${ws._name}" room ${mask(h.token)} (${r.runners.size} sessions)`);
      } else {
        ws._boundId = null;
        r.devices.add(ws);
        jsend(ws, sessionList(r));
        console.log(`+ device room ${mask(h.token)} (${r.runners.size} sessions)`);
      }
      return;
    }

    const r = room(ws._token);

    if (ws._role === "device") {
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (m.type === "select") {
        ws._boundId = String(m.id);
        const runner = r.runners.get(ws._boundId);
        if (runner) jsend(runner, { type: "relay", event: "device-attached" });
        else jsend(ws, { type: "relay", event: "session-offline" });
        return;
      }
      if (m.type === "list") {
        jsend(ws, sessionList(r));
        return;
      }
      // forward control messages to the selected runner
      const runner = ws._boundId ? r.runners.get(ws._boundId) : null;
      if (runner && runner.readyState === runner.OPEN) runner.send(text);
      return;
    }

    // runner -> forward to every device that selected it
    for (const d of r.devices) {
      if (d._boundId === ws._id && d.readyState === d.OPEN) d.send(text);
    }
  });

  ws.on("close", () => {
    if (!bound) return;
    const r = rooms.get(ws._token);
    if (!r) return;
    if (ws._role === "runner") {
      r.runners.delete(ws._id);
      for (const d of r.devices) {
        if (d._boundId === ws._id) {
          d._boundId = null;
          jsend(d, { type: "relay", event: "session-offline" });
        }
      }
      broadcastSessions(r);
      console.log(`- runner ${ws._id} left room ${mask(ws._token)}`);
    } else {
      r.devices.delete(ws);
      console.log(`- device left room ${mask(ws._token)}`);
    }
  });
});

// keepalive — drop dead sockets, ping the rest
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
