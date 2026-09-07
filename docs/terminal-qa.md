# Terminal compatibility and visual QA

Moyu's portable target is a readable terminal game, not identical image resolution in every client.
Two rows are the default micro view. E opens six protected rows (four if space is limited).
Games that need a complete board show an expansion entry instead of running invisibly in two rows.

## Evidence from this environment (2026-09-07)

### Native-pixel upgrade: phase 1

The action cartridge now draws directly into the device framebuffer. It uses a height-driven
camera, capsule distance coverage in linear light, and fixed-step motion interpolation. Existing
text renderers and older cartridges keep their previous paths. Instructions remove the Kitty
image instead of putting text beneath an opaque blank image.

`moyu doctor --visual` probes Kitty support before showing the actual two-row scene. Tab switches
old/new rendering of the same simulation; Space pauses, r restarts, e changes two/six rows,
l changes the new renderer's palette, and Esc exits. It does not submit prompts or write saves.
PTY checks cover negotiation, pause, switching, resizing the view, cleanup, and unsupported clients.
They do not certify a native GUI terminal. This phase awaits user visual acceptance before
iTerm2/Sixel, adaptive frame scheduling, and the sprite/tile API are implemented.

Generate source-picture comparisons with:

```sh
node --experimental-strip-types scripts/pixel-qa.mjs
```

`/tmp/moyu-pixel-qa/preview.html` has a shared timeline, 15/30fps playback, 1:1 device-pixel view,
Retina CSS-size view and magnification. PNGs are decoded from actual Kitty RGB payloads, not drawn
again in the browser. Old frames deliberately preserve the old dark palette. `contact.png` has
old frames on the left and new frames on the right. `metrics.json` records the export fixture.

In this Linux environment, the 180-frame action sample measured about 1,273 / 2,521 / 2,549 /
5,878 bytes per frame for 320×34 dark / 640×68 dark / 640×68 light / 640×204 dark. Peaks were
1,696 / 3,308 / 3,344 / 8,307 bytes. Mean render + encode + test decode was approximately
0.35 / 0.74 / 0.77 / 1.94 ms. These are local fixture measurements, not network latency or FPS
guarantees. Production SSH cadence remains 15fps until the next scheduling phase.

Native source PNGs were visually inspected for continuous contours and jump headroom. macOS
Termius, Kitty, and other GUI terminals are unavailable here; their native acceptance remains open.

| Check | Result | What this proves |
| --- | --- | --- |
| Linux PTY + Codex 0.153.4 | Passed automated smoke | Standby, instructions, play, expansion and composer reappearance after exit |
| Controlled CLI in nested PTYs | Automated regression | Keyboard ownership, help, resizing, original-content repaint and teardown |
| DejaVu Sans Mono SVG contact sheet | Visually inspected | Actual emitted glyphs at 16×34 character cells; coherent dot strokes for fighters and blocks for boards |
| Firefox headless preview | Initial controls and dark/light gameplay visually inspected | Actual ANSI-derived glyphs and text; this is not native-terminal certification |

A PTY has no font rasterizer. These checks do **not** certify the appearance of a terminal application.
The portable weapon color has 4.60:1 contrast on the tested dark background and 3.50:1 on the light one;
enemy color has 4.92:1 and 3.27:1 respectively. Primary text and player color inherit terminal foreground.

## Client matrix

| Terminal | Client / OS / font tested | Native visual status |
| --- | --- | --- |
| Termius | Not available in this environment | Pending |
| Windows Terminal | Not available in this environment | Pending |
| macOS Terminal | Not available in this environment | Pending |
| iTerm2 | Not available in this environment | Pending |
| Kitty | Not available in this environment | Pending |
| Ghostty | Not available in this environment | Pending |
| WezTerm | Not available in this environment | Pending |
| VS Code integrated terminal | Not available in this environment | Pending |

The protocol selection and 15fps input behavior are covered by tests. Real SSH latency, tmux
rendering, client-specific line spacing and font fallback still need client verification.
No untested terminal is labeled as certified. Kitty image encoding has protocol unit tests;
native Kitty image placement remains a separate client check. Additional image protocols are not enabled.

## Reproduce

```sh
npm run typecheck
npm run compile
npm test
node --experimental-strip-types scripts/visual-qa.mjs
node --experimental-strip-types scripts/codex-smoke.mjs
MOYU_TIER=braille ./bin/moyu -- codex
```

The preview generator prints its output directory, by default `/tmp/moyu-visual-qa`.
Open `preview.html` in a browser for a frame slider, theme switch and local font choices.
`frames.json` contains the actual ANSI output. `contact.svg` shows gameplay glyphs, without
invented solid pixels between the font's dots. Optional development-only PNG export:

```sh
convert /tmp/moyu-visual-qa/contact.svg /tmp/moyu-visual-qa/contact.png
```

The Codex smoke test starts the installed Codex CLI without submitting a prompt. It uses a
dedicated temporary Moyu state directory, responds to terminal capability queries, and closes
the child after the checks. If startup needs manual interaction it reports the blocked stage.

## Acceptance procedure on each client

Record terminal version, OS, font, font size, line height, connection and selected backend.
At normal zoom, check the following with both dark and light terminal themes:

- Recognize the player's head, separate feet, facing direction and weapon.
- Distinguish walking, airborne, windup, strike and hurt without relying on enlarged stills.
- Read initial controls, use J to start, ? for help, E for size, Tab for cartridge, Esc to exit.
- Watch the snake's direction and food; see the full falling-block board and landing ghost.
- Hide for ten seconds and return: the simulation must not advance while hidden.
- Resize and stream CLI output during play; verify clean exit and restored composer content.
- Check that Ctrl+G, Ctrl+Space, Ctrl+C and paste retain their CLI behavior.

## Runtime cost

The visual scenario (64 frames per game at 15fps, including first help and scene transitions)
measured approximately 149 / 272 / 98 / 48 bytes per frame for stick micro / stick expanded /
snake expanded / blocks expanded. The largest frame in that sample was 1,135 bytes.
These are fixture measurements, not bandwidth promises under continuous CLI repainting.

The renderer adds no production dependency. Preview and smoke scripts are development tools
and are not included in the published package.
