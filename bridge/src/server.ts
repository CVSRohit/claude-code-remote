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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load RELAY_URL / RELAY_TOKEN from bridge/.env if present (Node 22+).
try {
  (process as any).loadEnvFile?.();
} catch {
  /* no .env — rely on real env vars */
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8080";
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? "";

type Preset = { label: string; prompt: string; cwd?: string };
type PresetFile = { defaultCwd: string; items: Preset[] };

const presets: PresetFile = JSON.parse(
  readFileSync(join(__dirname, "..", "presets.json"), "utf8"),
);

let sock: WebSocket | null = null;
let deviceOnline = false;
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
  const cwd = preset.cwd ?? presets.defaultCwd;
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
    send({ type: "hello", role: "runner", token: RELAY_TOKEN });
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
          deviceOnline = !!msg.peer;
          console.log(`Paired with relay (device online: ${deviceOnline}).`);
          if (deviceOnline) sendPresets();
          break;
        case "peer-online":
          if (msg.role === "device") {
            deviceOnline = true;
            console.log("Device came online — sending presets.");
            sendPresets();
          }
          break;
        case "peer-offline":
          if (msg.role === "device") {
            deviceOnline = false;
            console.log("Device went offline.");
          }
          break;
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
    deviceOnline = false;
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
