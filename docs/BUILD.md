# Build your own Claude Code Remote

This guide takes you from parts to a working handheld remote. For how the system
works end-to-end, see the [main README](../README.md).

Rough time: **1–2 hours** (plus print time). Skill level: beginner-friendly
soldering (4 buttons) + flashing a dev board.

---

## 1. Bill of materials

| # | Part | Qty | ~Cost | Notes |
|---|------|-----|-------|-------|
| 1 | **ESP32 dev board** (DevKitC / WROOM-32, 38-pin) | 1 | $5–8 | Any ESP32 with a USB-serial chip (CP2102/CH340). |
| 2 | **1.3" ST7789 IPS display**, 240×240, SPI, **7-pin (no CS)** | 1 | $5–7 | Pin order `GND VCC SCL SDA RES DC BLK`. 3.3V board. |
| 3 | **6×6 mm tactile push buttons** | 4 | ~$1 | Through-hole, ~5 mm plunger. |
| 4 | **Jumper wires** (female–female) | ~12 | ~$2 | To connect display + buttons to the header pins. |
| 5 | **M2 × 6 mm self-tapping screws** | 2 | ~$1 | Hold the lid to the base. |
| 6 | **USB data cable** | 1 | — | Match your board (micro-USB or USB-C). **Data**, not charge-only. |
| 7 | **3D-printed case** (base + lid) | 1 set | filament | See [`hardware/case`](../hardware/case). |
| 8 | Foam pad / double-sided tape | a little | — | Optional: pad the ESP32 in the tray, hold the screen. |

You also need a **2.4 GHz WiFi** network (ESP32 has no 5 GHz) and a PC that runs
Claude Code, plus a [Fly.io](https://fly.io) account (free tier is fine) for the
relay.

### Tools
- Soldering iron + solder (to attach wires to the 4 buttons)
- 3D printer (or a print service)
- Small Phillips screwdriver
- A computer with [PlatformIO](https://platformio.org) and [Node 18+](https://nodejs.org)

---

## 2. Wiring

All display power is **3.3V** (not 5V). All grounds are common.

### Display (ST7789) → ESP32

| ST7789 | ESP32 |
|--------|-------|
| VCC | 3V3 |
| GND | GND |
| SCL | GPIO18 |
| SDA | GPIO23 |
| RES | GPIO4 |
| DC  | GPIO2 |
| BLK | GPIO32 |

> No CS pin — the firmware sets `TFT_CS=-1`. Leave it unconnected.
> BLK is on GPIO32 (not 3V3) so the firmware can sleep the backlight after 60s
> idle and wake on a button/approval. Wire BLK to 3V3 instead if you want it
> always on.

### Buttons → ESP32

Each button: one leg to its GPIO, the other leg to **GND** (all four GND legs can
share one ground wire). Internal pull-ups are enabled, so no resistors.

| Button | ESP32 |
|--------|-------|
| ▲ UP | GPIO25 |
| ▼ DOWN | GPIO26 |
| ✓ OK (green) | GPIO27 |
| ✗ BACK (red) | GPIO33 |

---

## 3. Print the case

In [`hardware/case`](../hardware/case):

1. **Print `fit-test.stl` first** and check your screen + buttons drop into it.
   Adjust the `CONFIG` block in the `.scad` and re-render if anything is off.
2. Print `base.stl` and `lid.stl` (print the lid **front-face-down**).

Print settings: PLA/PETG, 0.2 mm layers, 3 walls, 20% infill, no supports.

![case preview](../hardware/case/case-preview.png)

---

## 4. Assemble

1. **Buttons:** solder a wire to each button (signal + ground). Press the four
   buttons into the wells on the inside of the lid (▲▼ left column, ✓✗ right).
2. **Screen:** seat the display into the recess behind the lid window, active area
   facing out. Hold it with a dab of hot glue or tape on the PCB edges.
3. **Wire it up** per section 2 — display and buttons to the ESP32 header.
4. **ESP32:** place it in the base with the USB port lined up to the cutout. Pad
   with foam/tape so it doesn't rattle.
5. Close the lid onto the base and fasten the **2 M2 screws** at the bottom.

---

## 5. Flash the firmware

```bash
cd firmware
cp include/secrets.h.example include/secrets.h
# edit secrets.h: WIFI_SSID/PASS (2.4GHz), RELAY_HOST, RELAY_TOKEN
pio run -t upload
pio device monitor          # watch it boot, join WiFi, connect to the relay
```

You generate `RELAY_TOKEN` and deploy the relay in the next step — come back and
fill it in.

---

## 6. Software: relay + runner

Do this once. Full detail is in the [README](../README.md#setup); the short version:

```bash
# pick a shared secret used by the relay, runner, and firmware
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"

# relay (Fly.io) — edit the app name in relay/fly.toml first
cd relay
fly apps create your-relay-name
fly secrets set RELAY_TOKEN=<token> --app your-relay-name --stage
fly deploy --app your-relay-name --ha=false

# runner (your PC, where Claude Code is logged in)
cd ../bridge
npm install
cp .env.example .env        # RELAY_URL=wss://your-relay-name.fly.dev/  +  RELAY_TOKEN=<token>
npm start
```

Put the same `RELAY_HOST` (`your-relay-name.fly.dev`) and `RELAY_TOKEN` into
`firmware/include/secrets.h` and re-flash.

---

## 7. First run

1. Runner terminal shows `Paired with relay (device online: true)`.
2. The device screen shows the menu: `MODE: ask` + your presets.
3. Highlight a preset with ▲/▼, press ✓ to launch.
4. In **ask** mode each tool call shows on screen — press ✓ to allow, ✗ to deny.
5. It finishes on a green **DONE** screen with the run cost.

Point the runner at any local folder (or a cloned repo) via `defaultCwd` / per-preset
`cwd` in `bridge/presets.json`.

---

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| **Screen lit but blank** | A loose/wrong data wire (DC, RES, SDA, SCL) — re-seat them. If on long jumpers, lower `SPI_FREQUENCY` in `platformio.ini` (try 10 MHz). |
| **Screen totally dark** | No backlight — check BLK→3V3, VCC→3V3, common GND. |
| **Screen garbled / wrong colors** | SPI integrity (shorten/reseat wires, lower SPI freq) or driver flags. |
| **Won't connect to WiFi** | Must be **2.4 GHz**; check SSID/pass in `secrets.h`. |
| **`Waiting for runner`** | The runner isn't connected — start it (`npm start`) and check `RELAY_TOKEN` matches in all three places. |
| **`auth failed` on screen** | Token mismatch between firmware, runner `.env`, and the Fly secret. |
| **Upload "chip stopped responding"** | Hold the **BOOT** button during upload, or unplug/replug and retry. |
| **Buttons do the wrong thing** | Check each button's GPIO matches section 2. |
