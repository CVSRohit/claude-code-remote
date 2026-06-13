/**
 * Claude Code remote — ESP32 firmware (4-button edition).
 *
 * Hardware: ESP32 + 1.3" ST7789 240x240 IPS LCD + 4 tactile buttons.
 * Talks JSON over WebSocket to the PC bridge (see ../bridge).
 *
 * Buttons (all active-low to GND, internal pull-ups):
 *   UP (▲)  DOWN (▼)  OK (✓, green)  BACK (✗, red)
 *
 * Each button keeps ONE meaning everywhere:
 *   ▲ / ▼  always move the selection or scroll text
 *   ✓      always the affirmative  (launch / allow / continue)
 *   ✗      always the negative     (deny / back / interrupt)
 *
 * Per-screen behaviour:
 *   MENU     : ▲/▼ move, ✓ activate row (row 0 = toggle ask/auto, rest = launch)
 *   RUNNING  : ▲/▼ scroll log, ✗ interrupt the run
 *   APPROVAL : ▲/▼ scroll command, ✓ ALLOW, ✗ DENY
 *   RESULT   : ▲/▼ scroll output, ✓ or ✗ back to menu
 *
 * See README.md for wiring.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <TFT_eSPI.h>

// ---------- USER CONFIG ----------
// Real values live in include/secrets.h (gitignored). The fallbacks below let
// the project compile without it. RELAY_TOKEN must match the runner + Fly secret.
#if defined(__has_include)
#  if __has_include("secrets.h")
#    include "secrets.h"
#  endif
#endif
#ifndef WIFI_SSID
#  define WIFI_SSID "YOUR_WIFI"
#endif
#ifndef WIFI_PASS
#  define WIFI_PASS "YOUR_PASSWORD"
#endif
#ifndef RELAY_HOST
#  define RELAY_HOST "cc-remote-relay-rohit.fly.dev"
#endif
#ifndef RELAY_PORT
#  define RELAY_PORT 443
#endif
#ifndef RELAY_TOKEN
#  define RELAY_TOKEN "PASTE_TOKEN_HERE"
#endif

// ---------- PINS (buttons, active-low) ----------
static const int PIN_UP = 25;   // ▲
static const int PIN_DOWN = 26;  // ▼
static const int PIN_OK = 27;    // ✓ green
static const int PIN_BACK = 33;  // ✗ red
static const int PIN_BL = 32;    // backlight enable (move display BLK here from 3V3)
// TFT pins are set in platformio.ini build flags.

// ---------- GLOBALS ----------
TFT_eSPI tft = TFT_eSPI();
WebSocketsClient ws;

enum UiState { ST_BOOT, ST_SESSIONS, ST_MENU, ST_MONITOR, ST_RUNNING, ST_APPROVAL, ST_RESULT };
UiState state = ST_BOOT;

static const int MAX_PRESETS = 10;
String presetLabels[MAX_PRESETS];
int presetCount = 0;
int selection = 0; // 0 = mode row, 1..presetCount = presets

static const int MAX_SESSIONS = 8;
String sessionNames[MAX_SESSIONS];
String sessionIds[MAX_SESSIONS];
int sessionCount = 0;
int sessionSel = 0;

String currentMode = "ask";
String statusText = "Connecting…";
String toolName = "";
String toolSummary = "";
String pendingToolId = "";
String logBuf = "";   // accumulated tool calls + prose during a run
String resultText = "";
bool resultOk = false;
float resultCost = 0;

int scroll = 0;          // line offset for scrollable views
bool followBottom = true; // auto-stick RUNNING log to the newest line
bool dirty = true;        // redraw flag
bool wsUp = false;        // websocket connected (diagnostics)
bool screenAsleep = false;       // backlight off after idle
uint32_t lastActivity = 0;       // last button / message time
static const uint32_t SLEEP_MS = 60000; // idle timeout before backlight off
void wake();        // forward decls (used in handleMessage, defined near setup)
void sleepScreen();

// ---------- COLORS ----------
#define COL_BG TFT_BLACK
#define COL_ACCENT 0x05D4 // teal
#define COL_DIM 0x7BEF
#define COL_OK 0x07E0
#define COL_BAD 0xF800
#define COL_WARN 0xFD20

// ---------- LAYOUT ----------
#define BODY_Y 30
#define LINE_H 12
static const int CHARS_PER_LINE = 37; // ~224px / 6px (font 1)

// Debounced active-low edge detector.
struct Button {
  int pin;
  bool last = HIGH;
  uint32_t tEdge = 0;
  Button(int p) : pin(p) {}
  bool pressed() {
    bool now = digitalRead(pin);
    if (now != last && (millis() - tEdge) > 40) {
      tEdge = millis();
      last = now;
      if (now == LOW) return true;
    }
    last = now;
    return false;
  }
};
Button btnUp{PIN_UP}, btnDown{PIN_DOWN}, btnOk{PIN_OK}, btnBack{PIN_BACK};

// ---------- TEXT WRAP / SCROLL ----------
static const int MAX_LINES = 90;
String wrapped[MAX_LINES];
int lineCount = 0;

// Word-wrap `s` into the `wrapped` array (honours embedded '\n').
void buildLines(const String &s, int perLine) {
  lineCount = 0;
  int start = 0, lastSpace = -1;
  int len = s.length();
  for (int i = 0; i <= len && lineCount < MAX_LINES; i++) {
    char c = (i < len) ? s[i] : '\n';
    if (c == '\n') {
      wrapped[lineCount++] = s.substring(start, i);
      start = i + 1;
      lastSpace = -1;
      continue;
    }
    if (c == ' ') lastSpace = i;
    if (i - start >= perLine) {
      int brk = (lastSpace > start) ? lastSpace : i;
      wrapped[lineCount++] = s.substring(start, brk);
      start = (lastSpace > start) ? brk + 1 : brk;
      lastSpace = -1;
    }
  }
}

// Draw a scrollable block; returns true if more lines exist than fit.
bool drawBody(const String &content, uint16_t color, int yStart, int visLines) {
  buildLines(content, CHARS_PER_LINE);
  int maxScroll = max(0, lineCount - visLines);
  if (followBottom) scroll = maxScroll;
  scroll = constrain(scroll, 0, maxScroll);

  tft.setTextColor(color, COL_BG);
  tft.setTextDatum(TL_DATUM);
  for (int r = 0; r < visLines; r++) {
    int idx = scroll + r;
    if (idx >= lineCount) break;
    tft.drawString(wrapped[idx], 8, yStart + r * LINE_H, 1);
  }
  // Scrollbar thumb on the right edge.
  if (lineCount > visLines) {
    int trackY = yStart, trackH = visLines * LINE_H;
    int thumbH = max(8, trackH * visLines / lineCount);
    int thumbY = trackY + (trackH - thumbH) * scroll / maxScroll;
    tft.fillRect(236, trackY, 3, trackH, COL_BG);
    tft.fillRect(236, thumbY, 3, thumbH, COL_DIM);
    return true;
  }
  return false;
}

void scrollBy(int d) {
  followBottom = false;
  scroll += d;
  if (scroll < 0) scroll = 0;
  dirty = true;
}

// ---------- DRAW ----------
void header(const char *title, uint16_t col) {
  tft.fillRect(0, 0, 240, 26, col);
  tft.setTextColor(TFT_BLACK, col);
  tft.setTextDatum(ML_DATUM);
  tft.drawString(title, 6, 13, 2);
}

void footer(const char *txt) {
  tft.setTextColor(COL_DIM, COL_BG);
  tft.setTextDatum(MC_DATUM);
  tft.drawString(txt, 120, 230, 1);
}

void draw() {
  tft.fillScreen(COL_BG);
  switch (state) {
    case ST_BOOT:
      header("Claude Remote", COL_ACCENT);
      tft.setTextColor(COL_DIM, COL_BG);
      tft.setTextDatum(MC_DATUM);
      tft.drawString(statusText, 120, 130, 2);
      break;

    case ST_SESSIONS: {
      header("SESSIONS", COL_ACCENT);
      if (sessionCount == 0) {
        tft.setTextColor(COL_DIM, COL_BG);
        tft.setTextDatum(MC_DATUM);
        tft.drawString("No sessions online", 120, 115, 2);
        tft.drawString("start the runner on your PC", 120, 145, 1);
      } else {
        for (int i = 0; i < sessionCount && i < 9; i++) {
          int y = 34 + i * 20;
          bool sel = (i == sessionSel);
          if (sel) tft.fillRect(0, y - 2, 240, 19, COL_ACCENT);
          tft.setTextColor(sel ? TFT_BLACK : TFT_WHITE, sel ? COL_ACCENT : COL_BG);
          tft.setTextDatum(ML_DATUM);
          tft.drawString(sessionNames[i], 8, y + 7, 2);
        }
      }
      footer("UP/DN move   OK = control");
      break;
    }

    case ST_MENU: {
      String h = "MODE: " + currentMode;
      header(h.c_str(), COL_ACCENT);
      int rows = presetCount + 1; // row 0 is the mode toggle
      for (int i = 0; i < rows && i < 9; i++) {
        int y = 34 + i * 20;
        bool sel = (i == selection);
        if (sel) tft.fillRect(0, y - 2, 240, 19, COL_ACCENT);
        tft.setTextColor(sel ? TFT_BLACK : TFT_WHITE, sel ? COL_ACCENT : COL_BG);
        tft.setTextDatum(ML_DATUM);
        String label = (i == 0) ? ("Mode: " + currentMode + "  (toggle)")
                                : presetLabels[i - 1];
        tft.drawString(label, 8, y + 7, 2);
      }
      footer("UP/DN move   OK = select");
      break;
    }

    case ST_RUNNING: {
      header("RUNNING", COL_WARN);
      tft.setTextColor(COL_ACCENT, COL_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(statusText.substring(0, CHARS_PER_LINE), 8, BODY_Y, 1);
      drawBody(logBuf, TFT_WHITE, BODY_Y + 16, 14);
      footer("UP/DN scroll   BACK = interrupt");
      break;
    }

    case ST_MONITOR: {
      header("MONITOR", COL_ACCENT);
      tft.setTextColor(COL_DIM, COL_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(statusText.substring(0, CHARS_PER_LINE), 8, BODY_Y, 1);
      drawBody(logBuf, TFT_WHITE, BODY_Y + 14, 14);
      footer("UP/DN scroll   BACK = sessions");
      break;
    }

    case ST_APPROVAL:
      header("APPROVE?", COL_WARN);
      tft.setTextColor(COL_ACCENT, COL_BG);
      tft.setTextDatum(TL_DATUM);
      tft.drawString(toolName, 8, BODY_Y, 4);
      drawBody(toolSummary, TFT_WHITE, BODY_Y + 30, 11);
      tft.fillRoundRect(8, 196, 108, 30, 6, COL_OK);
      tft.fillRoundRect(124, 196, 108, 30, 6, COL_BAD);
      tft.setTextColor(TFT_BLACK);
      tft.setTextDatum(MC_DATUM);
      tft.drawString("OK = ALLOW", 62, 211, 2);
      tft.drawString("BACK = DENY", 178, 211, 2);
      break;

    case ST_RESULT: {
      header(resultOk ? "DONE" : "FAILED", resultOk ? COL_OK : COL_BAD);
      drawBody(resultText, TFT_WHITE, BODY_Y, 15);
      char buf[48];
      snprintf(buf, sizeof(buf), "$%.4f   OK/BACK = menu", resultCost);
      footer(buf);
      break;
    }
  }
}

// ---------- NETWORK ----------
void sendJson(const JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

// Append a line to the run log (keep it bounded so RAM stays sane).
void logLine(const String &s) {
  logBuf += s;
  logBuf += "\n";
  if (logBuf.length() > 2000) logBuf.remove(0, logBuf.length() - 2000);
  followBottom = true;
}

void handleMessage(const String &payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;
  String type = doc["type"] | "";

  if (type == "relay") {
    String ev = String((const char *)(doc["event"] | ""));
    if (ev == "session-offline") {
      statusText = "Session offline";
      state = ST_SESSIONS;
      JsonDocument d; d["type"] = "list"; sendJson(d); // refresh the picker
    } else if (ev == "error") {
      statusText = String((const char *)(doc["text"] | "relay error"));
    }
    dirty = true;
    return;
  }

  if (type == "sessions") {
    sessionCount = 0;
    for (JsonObject it : doc["items"].as<JsonArray>()) {
      if (sessionCount < MAX_SESSIONS) {
        sessionIds[sessionCount] = String((const char *)(it["id"] | ""));
        sessionNames[sessionCount] = String((const char *)(it["name"] | "session"));
        sessionCount++;
      }
    }
    if (sessionSel >= sessionCount) sessionSel = 0;
    if (state == ST_BOOT || state == ST_SESSIONS) state = ST_SESSIONS;
    dirty = true;
    return;
  }

  if (type == "monitor") {
    statusText = String((const char *)(doc["name"] | "monitor"));
    logBuf = "";
    scroll = 0;
    followBottom = true;
    state = ST_MONITOR;
    wake();
    return;
  }

  if (type == "presets") {
    presetCount = 0;
    for (JsonObject it : doc["items"].as<JsonArray>()) {
      if (presetCount < MAX_PRESETS) presetLabels[presetCount++] = String((const char *)it["label"]);
    }
    currentMode = String((const char *)(doc["mode"] | "ask"));
    selection = 0;
    state = ST_MENU;
  } else if (type == "status") {
    statusText = String((const char *)(doc["text"] | ""));
    if (doc["mode"].is<const char *>()) currentMode = String((const char *)doc["mode"]);
    String st = String((const char *)(doc["state"] | ""));
    if (st == "idle" && state != ST_RESULT) state = ST_MENU;
    else if ((st == "thinking" || st == "running" || st == "busy") && state != ST_APPROVAL) {
      if (state != ST_RUNNING) { logBuf = ""; followBottom = true; }
      state = ST_RUNNING;
    }
  } else if (type == "tool") {
    toolName = String((const char *)(doc["name"] | ""));
    toolSummary = String((const char *)(doc["summary"] | ""));
    if (doc["needsApproval"] | false) {
      pendingToolId = String((const char *)(doc["id"] | ""));
      scroll = 0;
      followBottom = false;
      state = ST_APPROVAL;
    } else {
      logLine("> " + toolName + ": " + toolSummary); // auto mode: just record it
      state = ST_RUNNING;
    }
  } else if (type == "text") {
    logLine(String((const char *)(doc["text"] | "")));
  } else if (type == "result") {
    resultOk = doc["ok"] | false;
    resultCost = doc["cost"] | 0.0;
    resultText = String((const char *)(doc["text"] | ""));
    toolName = "";
    toolSummary = "";
    scroll = 0;
    followBottom = false;
    state = ST_RESULT;
  }
  wake(); // any runner message lights the screen + resets the idle timer
}

void wsEvent(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED: {
      wsUp = true;
      Serial.println("[ws] CONNECTED -> sending hello");
      statusText = "Pairing…";
      JsonDocument h;
      h["type"] = "hello";
      h["role"] = "device";
      h["token"] = RELAY_TOKEN;
      sendJson(h);
      dirty = true;
      break;
    }
    case WStype_DISCONNECTED:
      wsUp = false;
      Serial.println("[ws] DISCONNECTED");
      statusText = "Reconnecting…";
      state = ST_BOOT;
      dirty = true;
      break;
    case WStype_ERROR:
      Serial.printf("[ws] ERROR len=%u: %.*s\n", (unsigned)len, (int)len, (char *)payload);
      break;
    case WStype_TEXT:
      handleMessage(String((char *)payload, len));
      break;
    default:
      break;
  }
}

// ---------- ACTIONS ----------
void selectSession(int idx) {
  JsonDocument d;
  d["type"] = "select";
  d["id"] = sessionIds[idx];
  sendJson(d);
  statusText = "Loading session…";
  state = ST_BOOT;
  dirty = true;
}

void launchPreset(int idx) {
  JsonDocument d;
  d["type"] = "launch";
  d["id"] = idx;
  sendJson(d);
}

void sendApproval(bool allow) {
  JsonDocument d;
  d["type"] = "approve";
  d["id"] = pendingToolId;
  d["allow"] = allow;
  sendJson(d);
  pendingToolId = "";
  followBottom = true;
  state = ST_RUNNING;
  dirty = true;
}

void toggleMode() {
  currentMode = (currentMode == "ask") ? "auto" : "ask";
  JsonDocument d;
  d["type"] = "mode";
  d["mode"] = currentMode;
  sendJson(d);
  dirty = true;
}

void sendInterrupt() {
  JsonDocument d;
  d["type"] = "interrupt";
  sendJson(d);
  statusText = "Interrupting…";
  dirty = true;
}

// ---------- SLEEP ----------
void wake() {
  lastActivity = millis();
  if (screenAsleep) {
    screenAsleep = false;
    digitalWrite(PIN_BL, HIGH); // backlight on; GRAM content is still there
  }
  dirty = true;
}
void sleepScreen() {
  screenAsleep = true;
  digitalWrite(PIN_BL, LOW); // backlight off only; panel keeps its content
}

// ---------- SETUP / LOOP ----------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_UP, INPUT_PULLUP);
  pinMode(PIN_DOWN, INPUT_PULLUP);
  pinMode(PIN_OK, INPUT_PULLUP);
  pinMode(PIN_BACK, INPUT_PULLUP);
  pinMode(PIN_BL, OUTPUT);
  digitalWrite(PIN_BL, HIGH); // backlight on
  lastActivity = millis();

  Serial.println("[tft] init");
  tft.init();
  tft.setRotation(0);
  // --- temporary display self-test: R, G, B, then HELLO ---
  tft.fillScreen(TFT_RED);
  delay(500);
  tft.fillScreen(TFT_GREEN);
  delay(500);
  tft.fillScreen(TFT_BLUE);
  delay(500);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setTextDatum(MC_DATUM);
  tft.drawString("HELLO", 120, 120, 4);
  delay(800);
  Serial.println("[tft] selftest done");
  draw();

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
    Serial.print(".");
  }
  Serial.printf("\nWiFi OK: %s\n", WiFi.localIP().toString().c_str());

  ws.beginSSL(RELAY_HOST, RELAY_PORT, "/");
  ws.onEvent(wsEvent);
  ws.setReconnectInterval(3000);
}

void loop() {
  ws.loop();

  bool up = btnUp.pressed();
  bool down = btnDown.pressed();
  bool ok = btnOk.pressed();
  bool back = btnBack.pressed();

  bool anyBtn = up || down || ok || back;
  if (anyBtn) {
    Serial.printf("[btn] %s%s%s%s (state=%d)\n",
                  up ? "UP " : "", down ? "DOWN " : "",
                  ok ? "OK " : "", back ? "BACK " : "", (int)state);
    lastActivity = millis();
  }

  // While asleep, the first press only wakes the screen — it doesn't act.
  if (screenAsleep) {
    if (anyBtn) wake();
    up = down = ok = back = false;
  }

  switch (state) {
    case ST_SESSIONS:
      if (sessionCount > 0 && (up || down)) {
        sessionSel = (sessionSel + (down ? 1 : -1) + sessionCount) % sessionCount;
        dirty = true;
      }
      if (ok && sessionCount > 0) selectSession(sessionSel);
      break;
    case ST_MENU: {
      int rows = presetCount + 1;
      if (rows > 0 && (up || down)) {
        selection = (selection + (down ? 1 : -1) + rows) % rows;
        dirty = true;
      }
      if (ok) {
        if (selection == 0) toggleMode();
        else launchPreset(selection - 1);
      }
      if (back) { // back to the session picker
        state = ST_SESSIONS;
        JsonDocument d; d["type"] = "list"; sendJson(d);
        dirty = true;
      }
      break;
    }
    case ST_RUNNING:
      if (up) scrollBy(-3);
      if (down) scrollBy(3);
      if (back) sendInterrupt();
      break;
    case ST_MONITOR:
      if (up) scrollBy(-3);
      if (down) scrollBy(3);
      if (back) {
        JsonDocument d; d["type"] = "interrupt"; sendJson(d); // stop tailing
        state = ST_SESSIONS;
        JsonDocument l; l["type"] = "list"; sendJson(l);
        dirty = true;
      }
      break;
    case ST_APPROVAL:
      if (up) scrollBy(-3);
      if (down) scrollBy(3);
      if (ok) sendApproval(true);
      if (back) sendApproval(false);
      break;
    case ST_RESULT:
      if (up) scrollBy(-3);
      if (down) scrollBy(3);
      if (ok || back) { state = ST_MENU; selection = 0; dirty = true; }
      break;
    default:
      break;
  }

  if (!screenAsleep && millis() - lastActivity > SLEEP_MS) sleepScreen();

  static uint32_t lastHb = 0;
  if (millis() - lastHb > 5000) {
    lastHb = millis();
    Serial.printf("[hb] wifi=%d wsUp=%d heap=%u state=%d st=%s\n",
                  WiFi.status() == WL_CONNECTED, wsUp, (unsigned)ESP.getFreeHeap(),
                  (int)state, statusText.c_str());
  }

  if (dirty && !screenAsleep) {
    dirty = false;
    draw();
  }
  delay(5);
}
