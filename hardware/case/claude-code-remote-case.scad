/* ============================================================
   Claude Code Remote — handheld enclosure (parametric)

   Two printed parts:
     - base : tray holding the ESP32 dev board (USB cutout + 4 screw posts)
     - lid  : front plate with the screen window + 4 button wells

   IMPORTANT: dimensions are NOMINAL. ESP32 dev boards and 1.3" ST7789
   modules vary a few mm between vendors. Print the FIT-TEST first, check
   it against YOUR boards, then tweak the CONFIG block and re-render.

   Render:
     openscad -o base.stl     -D 'part="base"'    claude-code-remote-case.scad
     openscad -o lid.stl      -D 'part="lid"'     claude-code-remote-case.scad
     openscad -o fit-test.stl -D 'part="fittest"' claude-code-remote-case.scad
   ============================================================ */

part = "both";   // "base" | "lid" | "both" | "fittest"

/* ---------------- CONFIG (measure & adjust) ---------------- */
inner_w   = 31;     // cavity width  (ESP32 PCB width + clearance; 38-pin ~28.5)
inner_l   = 82;     // cavity length (screen on top + button cluster below)
inner_d   = 22;     // cavity depth  (screen + jumpers + ESP32 stack)

wall      = 2.4;    // wall thickness
gap       = 0.4;    // tolerance between base cavity and lid lip
fillet    = 3;      // outer corner radius

// Screen (1.3" ST7789 240x240): active ~23.4mm, PCB ~26 x 38
screen_win   = 24;      // square window for the active area
screen_pcb_w = 26.5;    // PCB width  (recess)
screen_pcb_l = 38.5;    // PCB length (recess)
screen_y     = 19;      // window centre from inner CENTRE, toward the top
ledge        = 1.4;     // front ledge the screen rests behind

// Buttons (6x6 mm tactile, loose-wired): ▲▼ on left, ✓✗ on right
btn_body   = 6.6;       // square well for the switch body
btn_hole   = 4.0;       // plunger hole through the face
btn_dx     = 9;         // horizontal spacing from cluster centre
btn_dy     = 8;         // vertical spacing from cluster centre
btn_y      = -21;       // button cluster centre, from inner centre (toward bottom)

// Screws — M2 self-tapping into printed posts
screw_pilot = 1.7;      // pilot hole in the post (M2 self-tap)
screw_clear = 2.4;      // clearance hole in the lid
screw_head  = 4.2;      // countersink dia
post_d      = 5.5;
post_inset  = 4.0;      // post centre inset from inner corner

$fn = 56;

/* ---------------- DERIVED ---------------- */
out_w  = inner_w + 2*wall;
out_l  = inner_l + 2*wall;
base_d = inner_d + wall;     // total base height (floor + walls)
lid_t  = wall;               // face-plate thickness
lip_h  = 4;                  // lid lip nesting depth
lip_wall = 1.6;              // lid lip wall (thin frame, clears posts)

/* ---------------- HELPERS ---------------- */
module rbox(w, l, h, r) {            // rounded rectangular prism (XY fillet)
  hull() for (x=[-1,1], y=[-1,1])
    translate([x*(w/2-r), y*(l/2-r), 0]) cylinder(h=h, r=r);
}
module post_xy() {                   // 2 screw posts at the BOTTOM corners
  for (x=[-1,1])                     // (top edge is held by the lid lip; the
    translate([x*(inner_w/2-post_inset), -(inner_l/2-post_inset), 0]) children();  // wide screen leaves no room for top posts)
}
btns = [[-btn_dx, btn_y+btn_dy],     // UP    (left, upper)
        [-btn_dx, btn_y-btn_dy],     // DOWN  (left, lower)
        [ btn_dx, btn_y+btn_dy],     // OK    (right, upper)
        [ btn_dx, btn_y-btn_dy]];    // BACK  (right, lower)

/* ---------------- BASE ---------------- */
module base() {
  difference() {
    rbox(out_w, out_l, base_d, fillet);
    translate([0,0,wall]) rbox(inner_w, inner_l, base_d, max(0.6, fillet-wall));
    // USB cutout, centred on one short end wall
    translate([0, -out_l/2, wall+3]) cube([13, 3*wall, 8], center=true);
  }
  // corner posts with pilot holes (overlap floor by 1mm so they fuse cleanly)
  translate([0,0,wall-1]) difference() {
    post_xy() cylinder(h=base_d-wall+1, d=post_d);
    post_xy() translate([0,0,-1]) cylinder(h=base_d+2, d=screw_pilot);
  }
}

/* ---------------- LID ---------------- */
module lid() {
  difference() {
    union() {
      rbox(out_w, out_l, lid_t, fillet);                  // face plate
      // nesting lip as a thin perimeter frame (clears the posts)
      translate([0,0,lid_t-0.5]) difference() {       // overlap plate so it fuses
        rbox(inner_w-2*gap, inner_l-2*gap, lip_h+0.5, max(0.6, fillet-wall));
        translate([0,0,-1]) rbox(inner_w-2*gap-2*lip_wall, inner_l-2*gap-2*lip_wall, lip_h+2.5, 1);
      }
    }
    // screen PCB recess from the inside (leaves a front bezel of `ledge`)
    translate([-screen_pcb_w/2, screen_y-screen_pcb_l/2, ledge])
      cube([screen_pcb_w, screen_pcb_l, lid_t+lip_h+2]);
    // screen window through the ledge
    translate([0, screen_y, -1])
      linear_extrude(lid_t+lip_h+2) square([screen_win, screen_win], center=true);
    // button plunger holes through the face
    for (b=btns) translate([b[0], b[1], -1]) cylinder(h=lid_t+2, d=btn_hole);
    // button body wells (pockets on the inside)
    for (b=btns) translate([b[0], b[1], lid_t])
      linear_extrude(lip_h+1) square([btn_body, btn_body], center=true);
    // screw clearance holes + front countersink
    post_xy() translate([0,0,-1]) cylinder(h=lid_t+lip_h+2, d=screw_clear);
    post_xy() translate([0,0,-0.01]) cylinder(h=1.8, d=screw_head);
  }
}

/* ---------------- FIT-TEST (fast, cheap) ----------------
   Just the screen window + 4 button holes in a thin strip, to verify
   the screen fit and button spacing before printing the whole case. */
module fittest() {
  difference() {
    rbox(screen_pcb_w+8, out_l, lid_t, fillet);
    translate([0, screen_y, -1]) linear_extrude(lid_t+2) square([screen_win, screen_win], center=true);
    for (b=btns) translate([b[0], b[1], -1]) cylinder(h=lid_t+2, d=btn_hole);
  }
}

/* ---------------- RENDER ----------------
   GUI: set `part` above. CLI: pass a numeric `pn` (no shell-quoting issues):
     openscad -o base.stl     -D pn=1 claude-code-remote-case.scad
     openscad -o lid.stl      -D pn=2 claude-code-remote-case.scad
     openscad -o fit-test.stl -D pn=3 claude-code-remote-case.scad */
pn = -1;   // CLI override: 0=both 1=base 2=lid 3=fittest ; -1 = use `part`
sel = pn==0 ? "both" : pn==1 ? "base" : pn==2 ? "lid" : pn==3 ? "fittest" : part;

if      (sel=="base")    base();
else if (sel=="lid")     lid();
else if (sel=="fittest") fittest();
else { base(); translate([out_w+10,0,0]) lid(); }   // "both" preview
