/**
 * Claude Code remote — relay (runs on Fly.io).
 *
 * A small stateless hub. Within one token "account" there can be many
 * **runners** (each PC running the Agent SDK) and one or more **devices**
 * (ESP32 remotes). Each runner reports a list of **sessions** it can drive
 * (its own "live" session plus resumable local Claude Code sessions). The relay
 * merges those into one list, a device picks one, and is then routed to the
 * owning runner.
 *
 * Holds no API key and no files — it only forwards JSON.
 *
 * hello (first message):
 *   { "type":"hello", "role":"runner", "token":"…", "name":"my-pc" }
 *   { "type":"hello", "role":"device", "token":"…" }
 *
 * Runner -> relay:
 *   { "type":"sessions", "items":[{ "id":"live", "name":"my-pc (live)" }, …] }
 *   …plus presets/status/tool/text/result for its attached device(s)
 *
 * Relay -> device:
 *   { "type":"sessions", "items":[{ "id":"2:live", "name":"…", "online":true }] }
 *   { "type":"relay", "event":"session-offline" }   // selected runner left
 *   …plus everything the selected runner sends
 *
 * Device -> relay:
 *   { "type":"select", "id":"2:live" }   // <runnerId>:<sessionRef>
 *   { "type":"list" }
 *   …plus launch/approve/mode/interrupt -> forwarded to the selected runner
 *
 * Relay -> runner:
 *   { "type":"relay", "event":"paired", "id":"2" }
 *   { "type":"relay", "event":"device-attached", "session":"<sessionRef>" }
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
  const items = [];
  for (const [rid, ws] of r.runners) {
    for (const s of ws._sessions || []) {
      items.push({ id: rid + ":" + s.id, name: s.name, online: true });
    }
  }
  return { type: "sessions", items };
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
        ws._name = String(h.name || ("runner " + ws._id)).slice(0, 40);
        ws._sessions = [];
        r.runners.set(ws._id, ws);
        jsend(ws, { type: "relay", event: "paired", id: ws._id });
        broadcastSessions(r);
        console.log(`+ runner ${ws._id} "${ws._name}" room ${mask(h.token)}`);
      } else {
        ws._boundId = null;
        r.devices.add(ws);
        jsend(ws, sessionList(r));
        console.log(`+ device room ${mask(h.token)}`);
      }
      return;
    }

    const r = room(ws._token);

    if (ws._role === "device") {
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (m.type === "select") {
        const raw2 = String(m.id);
        const i = raw2.indexOf(":");
        const rid = i >= 0 ? raw2.slice(0, i) : raw2;
        const sref = i >= 0 ? raw2.slice(i + 1) : "live";
        ws._boundId = rid;
        const runner = r.runners.get(rid);
        if (runner) jsend(runner, { type: "relay", event: "device-attached", session: sref });
        else jsend(ws, { type: "relay", event: "session-offline" });
        return;
      }
      if (m.type === "list") { jsend(ws, sessionList(r)); return; }
      const runner = ws._boundId ? r.runners.get(ws._boundId) : null;
      if (runner && runner.readyState === runner.OPEN) runner.send(text);
      return;
    }

    // runner -> relay
    let m = null;
    try { m = JSON.parse(text); } catch {}
    if (m && m.type === "sessions") {
      ws._sessions = Array.isArray(m.items) ? m.items : [];
      broadcastSessions(r);
      return;
    }
    // anything else: forward to the devices that selected this runner
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

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
