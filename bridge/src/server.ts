/**
 * Claude Code remote — local runner.
 *
 * Runs on YOUR PC (where Claude Code is authed and your files live). It drives
 * Claude Code headlessly via the Agent SDK and **dials out** to the Fly relay,
 * registering as the "runner" half of a token-paired room. The ESP32 connects
 * to the same relay as the "device" half. The relay forwards JSON between them.
 *
 * Outbound-only, just like Claude Code's own Remote Control — no inbound ports,
 * your machine and files stay local — but here the Agent SDK's canUseTool gate
 * gives us the physical approve/deny the official remote control can't.
 *
 * Device -> runner (relayed):
 *   { "type": "launch",    "id": <presetIndex>, "mode"?: "ask"|"auto" }
 *   { "type": "approve",   "id": "<toolUseId>", "allow": true|false }
 *   { "type": "mode",      "mode": "ask"|"auto" }
 *   { "type": "interrupt" }
 *
 * Runner -> device (relayed):
 *   { "type": "presets", "items": [...], "mode": "ask" }
 *   { "type": "status",  "state": "idle"|"thinking"|"running"|"busy", "text", "mode" }
 *   { "type": "tool",    "name", "summary", "id", "needsApproval" }
 *   { "type": "text",    "text" }
 *   { "type": "result",  "ok", "cost", "text" }
 */

import { WebSocket } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// Load RELAY_URL / RELAY_TOKEN from bridge/.env if present (Node 22+).
try {
  (process as any).loadEnvFile?.();
} catch {
  /* no .env — rely on real env vars */
}

// An OAuth token (sk-ant-oat…) wrongly placed in ANTHROPIC_API_KEY makes Claude
// Code report "Invalid API key · Fix external API key" and exit 1. Drop it so the
// Agent SDK falls back to your normal Claude Code login (subscription/OAuth).
if (process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-oat")) {
  console.warn("Ignoring ANTHROPIC_API_KEY (looks like an OAuth token) — using Claude Code login.");
  delete process.env.ANTHROPIC_API_KEY;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8080";
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";

type Preset = { label: string; prompt: string; cwd?: string };
type PresetFile = { defaultCwd: string; items: Preset[] };

const presets: PresetFile = JSON.parse(
  readFileSync(join(__dirname, "..", "presets.json"), "utf8"),
);

// Name shown in the device's session picker. Defaults to the working folder.
const SESSION_NAME = process.env.SESSION_NAME ?? basename(presets.defaultCwd);

// ---- session enumeration (your real Claude Code sessions, resumable) ----
type SessionInfo = { id: string; name: string; cwd: string; kind: "live" | "monitor"; path?: string };
const sessionMap = new Map<string, SessionInfo>();
let activeSession: SessionInfo | null = null;
let monitorState: { path: string; pos: number; timer: ReturnType<typeof setInterval> } | null = null;

function readHead(path: string, bytes = 16384): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

// Recent local Claude Code sessions (newest first), excluding subagent transcripts.
function listLocalSessions(max = 10): SessionInfo[] {
  const root = join(homedir(), ".claude", "projects");
  const files: { path: string; mtime: number }[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return []; }
  for (const d of dirs) {
    let entries: string[] = [];
    try { entries = readdirSync(join(root, d)); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl") || f.startsWith("agent-")) continue;
      const p = join(root, d, f);
      try { files.push({ path: p, mtime: statSync(p).mtimeMs }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionInfo[] = [];
  for (const { path } of files.slice(0, max)) {
    const id = basename(path, ".jsonl");
    let cwd = "";
    let label = "";
    try {
      for (const line of readHead(path).split("\n")) {
        if (!line.trim()) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (!cwd && o.cwd) cwd = o.cwd;
        if (!label && o.type === "user" && o.message?.content) {
          const c = o.message.content;
          label = typeof c === "string"
            ? c
            : Array.isArray(c) ? (c.find((b: any) => b.type === "text")?.text ?? "") : "";
        }
        if (cwd && label) break;
      }
    } catch {}
    if (!cwd) cwd = presets.defaultCwd;
    const name = (basename(cwd) + (label ? " · " + label.replace(/\s+/g, " ") : "")).slice(0, 38);
    out.push({ id, name, cwd, kind: "monitor", path });
  }
  return out;
}

// ---- read-only live monitor: tail a session transcript, stream it out ----
function fmtEntry(o: any): string | null {
  try {
    if (o.type === "user" && o.message?.content) {
      const c = o.message.content;
      if (Array.isArray(c) && c.some((b: any) => b.type === "tool_result")) return null;
      const t = typeof c === "string"
        ? c
        : Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ") : "";
      return t.trim() ? "> " + t.trim() : null;
    }
    if (o.type === "assistant" && Array.isArray(o.message?.content)) {
      const parts: string[] = [];
      for (const b of o.message.content) {
        if (b.type === "text" && b.text?.trim()) parts.push(b.text.trim());
        else if (b.type === "tool_use") parts.push("[" + b.name + "] " + summarizeTool(b.name, b.input ?? {}));
      }
      return parts.length ? parts.join("\n") : null;
    }
  } catch {}
  return null;
}

function readRegion(path: string, from: number, to: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

function pumpMonitor(): void {
  if (!monitorState) return;
  let size = 0;
  try { size = statSync(monitorState.path).size; } catch { return; }
  if (size <= monitorState.pos) return;
  const chunk = readRegion(monitorState.path, monitorState.pos, size);
  monitorState.pos = size;
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const s = fmtEntry(o);
    if (s) send({ type: "text", text: s.slice(0, 380) });
  }
}

function startMonitor(sess: SessionInfo): void {
  stopMonitor();
  const path = sess.path!;
  let size = 0;
  try { size = statSync(path).size; } catch {}
  monitorState = { path, pos: Math.max(0, size - 8000), timer: setInterval(pumpMonitor, 700) };
  send({ type: "monitor", name: sess.name });
  pumpMonitor(); // flush recent context immediately
}

function stopMonitor(): void {
  if (monitorState) { clearInterval(monitorState.timer); monitorState = null; }
}

let sock: WebSocket | null = null;
let mode: "ask" | "auto" = "ask";
let busy = false;
/** Set while a query runs so an "interrupt" message can abort it. */
let currentAbort: AbortController | null = null;
/** toolUseId -> resolver, so an incoming "approve" message unblocks canUseTool. */
const pending = new Map<string, (allow: boolean) => void>();

function send(obj: unknown): void {
  if (sock && sock.readyState === WebSocket.OPEN) {
    sock.send(JSON.stringify(obj));
  }
}

function sendPresets(): void {
  send({
    type: "presets",
    items: presets.items.map((p, i) => ({ id: i, label: p.label })),
    mode,
  });
  send({ type: "status", state: busy ? "running" : "idle", text: "Idle", mode });
}

// "live" session + recent resumable Claude Code sessions, reported to the relay.
function sendSessionList(): void {
  const live: SessionInfo = { id: "live", name: SESSION_NAME + " (live)", cwd: presets.defaultCwd, kind: "live" };
  const items = [live, ...listLocalSessions(10)];
  sessionMap.clear();
  for (const s of items) sessionMap.set(s.id, s);
  send({ type: "sessions", items: items.map((s) => ({ id: s.id, name: s.name })) });
}

/** One-line, screen-friendly description of what a tool is about to do. */
function summarizeTool(name: string, input: Record<string, unknown>): string {
  const clip = (s: unknown, n = 90) => {
    const str = String(s ?? "");
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  };
  switch (name) {
    case "Bash":
      return clip(input.command);
    case "Edit":
      return "edit " + clip(input.file_path, 80);
    case "Write":
      return "write " + clip(input.file_path, 80);
    case "Read":
      return "read " + clip(input.file_path, 80);
    case "Glob":
    case "Grep":
      return clip(input.pattern, 80);
    default:
      return clip(JSON.stringify(input));
  }
}

/** ASK mode: block on the ESP32 button for every tool call. */
const canUseTool = async (
  toolName: string,
  input: Record<string, unknown>,
  { toolUseID, signal }: { toolUseID: string; signal: AbortSignal },
) => {
  send({
    type: "tool",
    name: toolName,
    summary: summarizeTool(toolName, input),
    id: toolUseID,
    needsApproval: true,
  });
  send({ type: "status", state: "running", text: "Waiting for approval…", mode });

  const allow = await new Promise<boolean>((resolve) => {
    pending.set(toolUseID, resolve);
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  pending.delete(toolUseID);

  return allow
    ? { behavior: "allow" as const, updatedInput: input }
    : { behavior: "deny" as const, message: "Denied via ESP32 button." };
};

/** AUTO mode: never block, but surface every tool call to the screen. */
const observeHook = async (
  input: { tool_name: string; tool_input?: Record<string, unknown> },
  toolUseID: string,
) => {
  send({
    type: "tool",
    name: input.tool_name,
    summary: summarizeTool(input.tool_name, input.tool_input ?? {}),
    id: toolUseID,
    needsApproval: false,
  });
  return {};
};

async function runPrompt(
  preset: Preset,
  runMode: "ask" | "auto" = mode,
): Promise<void> {
  if (busy) {
    send({ type: "status", state: "busy", text: "Already running", mode });
    return;
  }
  busy = true;
  const cwd = preset.cwd ?? activeSession?.cwd ?? presets.defaultCwd;
  send({ type: "status", state: "thinking", text: preset.label, mode });

  // The abort controller lets an "interrupt" message stop the run mid-flight.
  const abort = new AbortController();
  currentAbort = abort;
  const options: Record<string, unknown> = { cwd, abortController: abort };
  if (runMode === "ask") {
    options.permissionMode = "default";
    options.canUseTool = canUseTool;
  } else {
    options.permissionMode = "bypassPermissions";
    options.hooks = { PreToolUse: [{ hooks: [observeHook] }] };
  }

  try {
    for await (const message of query({ prompt: preset.prompt, options }) as AsyncIterable<any>) {
      switch (message.type) {
        case "system":
          if (message.subtype === "init") {
            send({ type: "status", state: "thinking", text: "Session ready", mode });
          }
          break;

        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) {
              send({ type: "text", text: block.text.slice(0, 400) });
            }
          }
          break;

        case "result": {
          const ok = message.subtype === "success";
          send({
            type: "result",
            ok,
            cost: message.total_cost_usd ?? 0,
            text: ok ? String(message.result ?? "").slice(0, 400) : "Run ended without success",
          });
          break;
        }
      }
    }
  } catch (err: any) {
    const aborted = abort.signal.aborted || err?.name === "AbortError";
    send({
      type: "result",
      ok: false,
      cost: 0,
      text: aborted ? "Interrupted." : String(err?.message ?? err).slice(0, 200),
    });
  } finally {
    busy = false;
    currentAbort = null;
    send({ type: "status", state: "idle", text: "Idle", mode });
  }
}

function handleDeviceMessage(msg: any): void {
  switch (msg.type) {
    case "launch": {
      const preset = presets.items[msg.id];
      if (preset) {
        const runMode =
          msg.mode === "auto" || msg.mode === "ask" ? msg.mode : mode;
        runPrompt(preset, runMode);
      }
      break;
    }
    case "approve": {
      const resolve = pending.get(String(msg.id));
      if (resolve) resolve(Boolean(msg.allow));
      break;
    }
    case "mode": {
      if (!busy) {
        mode = msg.mode === "auto" ? "auto" : "ask";
        send({ type: "status", state: "idle", text: "Idle", mode });
        console.log(`Mode set to ${mode}`);
      }
      break;
    }
    case "interrupt": {
      if (monitorState) {
        stopMonitor();
        console.log("Stopped monitoring.");
        break;
      }
      if (currentAbort) {
        for (const resolve of pending.values()) resolve(false);
        pending.clear();
        currentAbort.abort();
        send({ type: "status", state: "running", text: "Interrupting…", mode });
        console.log("Run interrupted by device");
      }
      break;
    }
  }
}

function connect(): void {
  console.log(`Connecting to relay ${RELAY_URL} …`);
  sock = new WebSocket(RELAY_URL);

  sock.on("open", () => {
    console.log("Relay connected — registering as runner.");
    send({ type: "hello", role: "runner", token: RELAY_TOKEN, name: SESSION_NAME });
    sendSessionList();
  });

  sock.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "relay") {
      switch (msg.event) {
        case "paired":
          console.log(`Paired with relay as session "${SESSION_NAME}" (id ${msg.id}).`);
          break;
        case "device-attached": {
          const sref = String(msg.session ?? "live");
          const sess = sessionMap.get(sref) ?? sessionMap.get("live") ?? null;
          stopMonitor();
          if (sess && sess.kind === "monitor" && sess.path) {
            activeSession = null;
            console.log(`Monitoring session "${sess.name}".`);
            startMonitor(sess);
          } else {
            activeSession = sess;
            console.log(`Controlling session "${sess?.name ?? sref}".`);
            sendPresets();
          }
          break;
        }
        case "error":
          console.error(`Relay rejected us: ${msg.text}`);
          break;
      }
      return;
    }

    handleDeviceMessage(msg);
  });

  sock.on("close", () => {
    console.log("Relay disconnected — reconnecting in 3s.");
    sock = null;
    // Unblock any pending approvals so a hung query can unwind.
    for (const resolve of pending.values()) resolve(false);
    pending.clear();
    setTimeout(connect, 3000);
  });

  sock.on("error", (err: any) => {
    console.error("Relay socket error:", err?.message ?? err);
  });
}

console.log(`Claude Code remote runner. Presets: ${presets.items.map((p) => p.label).join(", ")}`);
if (!RELAY_TOKEN) console.warn("WARNING: RELAY_TOKEN is empty — set it in bridge/.env");
connect();

// Refresh the session list periodically so newly-used sessions appear.
setInterval(() => {
  if (sock && sock.readyState === WebSocket.OPEN) sendSessionList();
}, 30000);
