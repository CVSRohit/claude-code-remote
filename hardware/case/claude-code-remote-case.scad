/* ============================================================
   Claude Code Remote — custom handheld case (v3)

   Layout:
     - ESP32 (52x28, USB-C) + ST7789 stacked on the RIGHT side of the case.
     - A LEFT CHANNEL runs alongside the boards; the two SCROLL buttons (▲ ▼)
       stand vertically in it, caps facing OUT the left wall (perpendicular to
       the boards), bodies wedged against the boards' left edges.
     - Screen window at the TOP (over the boards); two ACTION buttons (✓ ✗)
       on the face just below the screen.
     - 2 screws in the left channel (top + bottom), clear of the side buttons.

   Render:
     openscad -o base.stl -D pn=1 claude-code-remote-case.scad
     openscad -o lid.stl  -D pn=2 claude-code-remote-case.scad
   ============================================================ */

part = "both";
pn = -1;  // CLI: 0 both, 1 base, 2 lid

/* ---------------- CONFIG (measure & adjust) ---------------- */
// ESP32
esp_l   = 52;
esp_w   = 28;
esp_h   = 13;     // ESP32 height incl. soldered pins
stack_h = 17;     // ESP32 + ST bolted together (measured)
usb_w   = 9.2;
usb_h   = 3.2;
usb_cz  = 3.0;    // USB-C centre height above floor — CONFIRM

// Screen (ST7789)
scr_pcb_w = 28;
scr_pcb_l = 39;
scr_pcb_t = 1.8;
scr_win_w = 26;   // +1mm wider
scr_win_h = 30;
scr_cy    = 7;    // screen centre toward the TOP
scr_gap   = 6;    // gap ESP32 top -> screen — CONFIRM

// Buttons: 12x12x5 DIP tactile, 7mm round cap
btn       = 12.4; // square body footprint
btn_hole  = 7.6;  // round cap hole
btn_depth = 3;    // switch body depth into the channel
fbtn_y    = -20;  // action buttons centre line, clear of the ST PCB above
fbtn_dx   = 7.5;  // their left/right spacing
sbtn_y1   = 7;    // scroll ▲ (left channel, toward top)
sbtn_y2   = -7;   // scroll ▼ (left channel, toward bottom)

// Case
channel_w  = 6;     // left channel width for the side buttons (3mm switch + room)
right_clear = 1.5;  // clearance on the board (right) side
wall   = 1.6;   // base wall thickness (4 perimeters @ 0.4 nozzle)
gap    = 0.4;
fillet = 3;
lip_h  = 4;
lip_wall = 1.6;
screw_pilot = 1.7;
screw_clear = 2.4;
screw_head  = 4.2;
post_d      = 5.0;
post_inset  = 3.0;

$fn = 56;

/* ---------------- DERIVED ---------------- */
inner_w = esp_w + right_clear + channel_w;          // boards right, channel left
inner_l = esp_l + 3;
inner_d = stack_h + 1.5;                             // fit the bolted ESP32+ST stack
board_cx = inner_w / 2 - right_clear - esp_w / 2;   // board centre, shifted right
sbtn_z  = wall + inner_d / 2;                        // side button centre depth
out_w = inner_w + 2 * wall;
out_l = inner_l + 2 * wall;
base_d = inner_d + wall;
lid_t  = 1.4;   // thin face so 3mm button caps poke through (matches screen bezel)

/* ---------------- HELPERS ---------------- */
module rbox(w, l, h, r) {
  hull() for (x = [-1, 1], y = [-1, 1])
    translate([x * (w / 2 - r), y * (l / 2 - r), 0]) cylinder(h = h, r = r);
}
module post_xy() {  // 2 posts in the LEFT channel (top + bottom)
  for (y = [-1, 1])
    translate([-(inner_w / 2 - post_inset), y * (inner_l / 2 - post_inset), 0]) children();
}

/* ---------------- BASE ---------------- */
module base() {
  difference() {
    rbox(out_w, out_l, base_d, fillet);
    translate([0, 0, wall]) rbox(inner_w, inner_l, base_d, max(0.6, fillet - wall));
    // USB-C on bottom end wall, aligned to the board (shifted right)
    translate([board_cx, -out_l / 2, wall + usb_cz]) cube([usb_w, 3 * wall, usb_h], center = true);
    // scroll buttons: round cap holes through the LEFT (-x) wall only
    for (yy = [sbtn_y1, sbtn_y2])
      translate([-out_w / 2 - 1, yy, sbtn_z]) rotate([0, 90, 0]) cylinder(h = wall + 3, d = btn_hole);
  }
  // (side-button switches glue into the channel; base+lid glue/tape together)
}

/* ---------------- LID ---------------- */
module lid() {
  difference() {
    union() {
      rbox(out_w, out_l, lid_t, fillet);
      translate([0, 0, lid_t - 0.5]) difference() {
        rbox(inner_w - 2 * gap, inner_l - 2 * gap, lip_h + 0.5, max(0.6, fillet - wall));
        translate([0, 0, -1]) rbox(inner_w - 2 * gap - 2 * lip_wall, inner_l - 2 * gap - 2 * lip_wall, lip_h + 2.5, 1);
      }
    }
    // screen PCB recess (bezel ~1.4mm), shifted right over the boards
    translate([board_cx - scr_pcb_w / 2, scr_cy - scr_pcb_l / 2, 1.4])
      cube([scr_pcb_w, scr_pcb_l, lid_t + lip_h + 2]);
    // screen window
    translate([board_cx, scr_cy, -1])
      linear_extrude(lid_t + lip_h + 2) square([scr_win_w, scr_win_h], center = true);
    // action buttons below the screen (cap holes + 12x12 body wells)
    for (x = [-1, 1]) {
      translate([board_cx + x * fbtn_dx, fbtn_y, -1]) cylinder(h = lid_t + 2, d = btn_hole);
      translate([board_cx + x * fbtn_dx, fbtn_y, lid_t]) linear_extrude(lip_h + 1) square([btn, btn], center = true);
    }
  }
}

/* ---------------- RENDER ---------------- */
sel = pn == 0 ? "both" : pn == 1 ? "base" : pn == 2 ? "lid" : part;
if (sel == "base") base();
else if (sel == "lid") lid();
else { base(); translate([out_w + 10, 0, 0]) lid(); }
