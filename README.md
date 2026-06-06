# Claude Code Remote

A physical remote control for [Claude Code](https://www.claude.com/product/claude-code).
An ESP32 with a 1.3" screen and **four buttons** lets you **launch prompts**,
**approve or deny every tool call with a button**, **scroll Claude's output**, and
**interrupt a run** — from anywhere, while Claude runs on your own PC against your
own files.

```
┌─────────────────────────┐   wss/TLS   ┌──────────────┐   wss (outbound)   ┌────────────────────────────┐
│ ESP32                   │ ──────────▶ │  Fly.io relay │ ◀───────────────── │  runner (Node, your PC)    │
│ ST7789 240x240          │             │  token-paired │                    │   → Claude Agent SDK       │
│ 4 buttons  ▲ ▼ ✓ ✗     │ ◀────────── │   WS hub      │ ─────────────────▶ │   → Claude Code + your fs  │
└─────────────────────────┘             └──────────────┘                    └────────────────────────────┘
        approve / deny / launch / interrupt              status / tool / text / result
```

Claude Code can't run on an ESP32 (it needs Node + a filesystem), so the ESP32 is
a thin client. This mirrors Claude Code's own **Remote Control** model — the
machine that owns the files dials *outbound* to a relay, nothing inbound — except
here the runner uses the **Agent SDK**, whose `canUseTool` callback gives you the
physical **approve/deny** that the official remote control can't do.

Three components, one per folder:

| Folder | Runs on | What it is |
|--------|---------|------------|
| `relay/` | Fly.io (or any host) | A tiny stateless WebSocket hub. Pairs one device to one runner by a shared token and forwards JSON. Holds no API key, no files. |
| `bridge/` | Your PC | The "runner". Dials out to the relay, drives Claude Code via the Agent SDK against your local files. |
| `firmware/` | ESP32 | The handheld remote (PlatformIO). |

## Two modes (toggle on-device — top menu row, press ✓)

- **ask**  — the SDK `canUseTool` callback *blocks* on each tool call; the screen
  shows the command and waits: **✓ = allow, ✗ = deny**.
- **auto** — `permissionMode: bypassPermissions` runs unattended, but a
  `PreToolUse` hook still streams every tool call to the screen so you *see* every
  action. Hit **✗ while running to interrupt**.

---

## Setup

A shared **token** ties all three pieces together. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

### 1. Relay (Fly.io)

```bash
cd relay
fly apps create your-relay-name
fly secrets set RELAY_TOKEN=<token> --app your-relay-name --stage
fly deploy --app your-relay-name --ha=false   # edit app name in fly.toml first
```

Your relay is now at `wss://your-relay-name.fly.dev/`.

### 2. Runner (your PC)

Requires Node 18+ and Claude Code authenticated on this machine (the Agent SDK
reuses your existing Claude Code auth).

```bash
cd bridge
npm install
cp .env.example .env        # set RELAY_URL=wss://your-relay-name.fly.dev/ and RELAY_TOKEN=<token>
npm start
```

Edit `presets.json` to change the menu and which folder Claude operates in
(`defaultCwd`, or per-preset `cwd`).

### 3. Firmware (ESP32)

```bash
cd firmware
cp include/secrets.h.example include/secrets.h   # set WiFi (2.4GHz), RELAY_HOST, RELAY_TOKEN
pio run -t upload
pio device monitor
```

---

## Wiring (ESP32 devkit → ST7789 240×240)

| ST7789 | ESP32 | | Button | ESP32 |
|--------|-------|-|--------|-------|
| VCC    | 3V3   | | ▲ UP   | GPIO25 → GND |
| GND    | GND   | | ▼ DOWN | GPIO26 → GND |
| SCL/SCLK | GPIO18 | | ✓ OK (green) | GPIO27 → GND |
| SDA/MOSI | GPIO23 | | ✗ BACK (red) | GPIO33 → GND |
| RES/RST | GPIO4 | | | |
| DC     | GPIO2 | | | |
| BLK    | 3V3   | | | |

- **No CS pin** — these 7-pin boards have CS tied active internally; `platformio.ini`
  sets `TFT_CS=-1`. Leave it unconnected.
- **VCC = 3.3V, not 5V** (the panel logic is 3.3V; no onboard regulator).
- Buttons are bare tactile switches, one leg to the GPIO and one to GND — internal
  pull-ups, no resistors.
- SPI is set to 27 MHz in `platformio.ini`; drop it (e.g. 10 MHz) if a long/cheap
  jumper run gives a blank screen.

TFT pins live in `platformio.ini` `build_flags`; button pins at the top of
`firmware/src/main.cpp`.

## Controls

| Screen | ▲ UP | ▼ DOWN | ✓ OK | ✗ BACK |
|--------|------|--------|------|--------|
| Menu     | prev row | next row | activate row¹ | — |
| Approval | scroll cmd ↑ | scroll cmd ↓ | **ALLOW** | **DENY** |
| Running  | scroll log ↑ | scroll log ↓ | — | **interrupt run** |
| Result   | scroll ↑ | scroll ↓ | back to menu | back to menu |

¹ The menu's top row is `Mode: ask/auto` — ✓ toggles the mode; ✓ on any other row
launches that preset.

## Security

The relay is reachable on the public internet, so it's **token-gated**: a client
must present the shared `RELAY_TOKEN` to be paired into a room. Keep it secret —
it (and your WiFi password) live in gitignored files (`bridge/.env`,
`firmware/include/secrets.h`); `.example` templates are committed. In `auto` mode
the runner uses `bypassPermissions`, so treat the token like a key to your shell.

## 3D-printed enclosure

A handheld case with a window for the 1.3" panel and four button holes is an easy
print. Lay out **▲/▼** as a vertical rocker on the left and **✓(green)/✗(red)**
along the bottom, so the approve/deny pair is reachable by thumb without looking.

## Notes & extensions

- Single device + single runner per token; newest connection of each role wins.
- Output is buffered on-device into a scrollable log; ▲/▼ scroll, the running log
  auto-follows the newest line until you scroll up.
- Interrupt: ✗ while running sends `{type:"interrupt"}`; the runner aborts the run.
- Want free-form prompts without a keyboard? The ESP32 pairs well with an INMP441
  mic — capture audio, send to the runner, transcribe, feed as a prompt.
