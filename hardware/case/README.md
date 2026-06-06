# Enclosure — 3D printed case

A handheld two-part case for the Claude Code Remote.

| File | Print | Notes |
|------|-------|-------|
| `base.stl` | 1× | Tray holding the ESP32; USB cutout on one end; 4 screw posts. |
| `lid.stl` | 1× | Front plate: screen window + 4 button wells. Print **face-down** for a clean front. |
| `fit-test.stl` | 1× (first!) | A thin strip with just the screen window + 4 button holes. **Print this first** to verify your screen and button spacing before committing to the full case. |
| `claude-code-remote-case.scad` | — | Parametric source. Edit and re-render if your boards differ. |

## ⚠️ Read before printing

The model is built to **nominal** dimensions. ESP32 dev boards and 1.3" ST7789
modules vary by a few millimetres between vendors. **Print `fit-test.stl` first**,
offer up your screen and buttons, and if anything is tight/loose, edit the
`CONFIG` block at the top of the `.scad` and re-render.

## Print settings (starting point)

- Material: PLA or PETG
- Layer height: 0.2 mm
- Walls/perimeters: 3
- Infill: 20%
- Supports: **none** needed (USB cutout bridges fine; print lid face-down)
- Orientation: base floor-down, lid front-face-down

## Re-rendering after edits

Install [OpenSCAD](https://openscad.org), then:

```bash
openscad -o base.stl     -D pn=1 claude-code-remote-case.scad
openscad -o lid.stl      -D pn=2 claude-code-remote-case.scad
openscad -o fit-test.stl -D pn=3 claude-code-remote-case.scad
```

(`pn` selects the part: 1=base, 2=lid, 3=fit-test, 0=both for preview.)

## Hardware to assemble it

- 4× **M2 × 6 mm** self-tapping screws (into the base posts)
- 4× **6×6 mm** tactile buttons (press-fit into the lid wells)
- The 1.3" ST7789 sits behind the lid window; the ESP32 sits in the base.

See [`../../docs/BUILD.md`](../../docs/BUILD.md) for the full build.
