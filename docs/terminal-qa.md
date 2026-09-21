# Terminal compatibility and visual QA

Moyu targets a readable, safely owned terminal game rather than identical raster output in every client.
The default micro view uses two game rows while standby reserves one row and paints one safe-edge cell.
Games without a playable micro composition yield input to the wrapped CLI instead of running invisibly.

## Wuxia revision (2026-09-21)

Sword-form follow-up: seven schools now cast by qi tier — opener, 60-qi empowered form, and a
single 100-qi finisher (about 1.2 s, no cycling through every form); reserves are capped separately
at 300, and leftover qi is saved. The hero wears a conical hat and red scarf in every render tier,
casts open with a shared draw-flash, and finishers push a ground shockwave.
Tests cover all threshold edges, every form's distinct drawing commands, finisher movement,
single mastery award, four-hit Boss budget, and delayed chapter settlement until the finisher ends.
The playing field takes the right two-thirds of the terminal (HUD on the left), growing with width.
Generate a school's production-render contact sheet with
`node --experimental-strip-types scripts/wuxia-qa.mjs /tmp/moyu-nine-forms dugu`.

Follow-up verification (2026-09-22): the fixed 1,800-frame benchmark is followed by actual combat
cleanup (93 additional steps for the reference seed), then the result freeze is checked. Time alone
cannot produce a checkpoint. All eight native scenarios still pass the existing 15% gates without
relaxing them: combined p95 0.384–0.447 ms at 320×34 and 1.386–1.413 ms at 640×68.
The contact sheet now covers nine habitat-specific creatures, seven sword arts, Boss hit flash,
ground-warning/eruption frames and expanded character rendering. Automated tests also check late
enemy/Boss kills, three-key input timing, old sword-manual migration, CJK wrapping and sidebar paging
at 18/37/77 columns. Native-terminal manual acceptance remains pending.

The same 1,800-step production fixture now includes recognizable bamboo scenery, articulated geometric
creatures, 320 ms attacks, and persistent sword cultivation. The following measurements intentionally
replace the native-pixel performance gate; the older evidence below remains for comparison.

| Device pixels | Theme / motion | Combined p95 (ms) | Encode p95 (ms) | Average / peak bytes |
| --- | --- | ---: | ---: | ---: |
| 320×34 | dark / normal | 0.426 | 0.202 | 3,278 / 4,429 |
| 320×34 | dark / reduced | 0.413 | 0.214 | 3,219 / 4,325 |
| 320×34 | light / normal | 0.398 | 0.199 | 3,305 / 4,549 |
| 320×34 | light / reduced | 0.359 | 0.197 | 3,248 / 4,313 |
| 640×68 | dark / normal | 1.393 | 0.652 | 7,086 / 9,654 |
| 640×68 | dark / reduced | 1.369 | 0.661 | 6,958 / 9,430 |
| 640×68 | light / normal | 1.412 | 0.656 | 7,376 / 9,690 |
| 640×68 | light / reduced | 1.349 | 0.653 | 7,251 / 9,686 |

Richer silhouettes roughly double native-image payload relative to the September 11 fixture. Rendering
plus encoding still takes less than 1.5 ms at p95 in this fixture, within the local 33 ms frame budget;
this is a local measurement, not a remote-latency guarantee. Native frames use at most three APC records,
still written together. The Braille SSH gate remains unchanged: average <250 B/frame, peak <600 B.
The new baseline keeps the existing 15% regression allowance. `measurements.json` is emitted even on gate
failure so future changes can be reviewed. `scripts/wuxia-qa.mjs` additionally renders a contact sheet of
six landmarks, all seven sword arts, Boss effects and the expanded character view, with a six-enemy stress sample.

## Previous reference evidence (2026-09-11)

### Native-pixel fixture

The reference run used Darwin arm64 on an Apple M4 (10 logical CPUs), Node v25.8.2. It exercised the
production built-in Stick Slash cartridge and `GraphicsTarget`, using seed `0x1234abcd` for exactly 1,800
fixed 60 Hz updates: one complete 30-second chapter. The checkpoint was 11 kills, best combo 3, score
1,250, and RNG state 3,913,948,090.

Timing covers only `renderPixels()` and `GraphicsTarget.encode()`. Kitty parsing, Base64 decoding,
inflation, hashing, PNG generation, and browser-preview work run after the timed boundary. Percentiles
use nearest rank. Payload values are complete host-frame writes, including CUP and every Kitty APC chunk;
zero-byte unchanged frames remain in the 1,800-frame distribution.

| Device pixels | Theme / motion | Combined p50 / p95 / p99 / max (ms) | Encode p95 (ms) | Average / peak bytes | Max APC chunks | Unchanged p50 / p95 / p99 / max (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 320×34 | dark / normal | 0.163 / 0.229 / 0.265 / 1.497 | 0.127 | 1,510 / 2,612 | 1 | 0.030 / 0.031 / 0.034 / 0.036 |
| 320×34 | dark / reduced | 0.157 / 0.213 / 0.241 / 0.298 | 0.127 | 1,481 / 2,612 | 1 | 0.029 / 0.030 / 0.030 / 0.035 |
| 320×34 | light / normal | 0.159 / 0.221 / 0.252 / 0.299 | 0.126 | 1,535 / 2,608 | 1 | 0.029 / 0.030 / 0.030 / 0.037 |
| 320×34 | light / reduced | 0.157 / 0.208 / 0.235 / 0.270 | 0.127 | 1,506 / 2,608 | 1 | 0.029 / 0.030 / 0.031 / 0.032 |
| 640×68 | dark / normal | 0.523 / 0.752 / 0.855 / 1.012 | 0.393 | 3,354 / 6,049 | 2 | 0.099 / 0.118 / 0.122 / 0.127 |
| 640×68 | dark / reduced | 0.533 / 0.731 / 0.805 / 0.899 | 0.398 | 3,291 / 6,049 | 2 | 0.099 / 0.119 / 0.124 / 0.127 |
| 640×68 | light / normal | 0.543 / 0.757 / 0.850 / 0.930 | 0.397 | 3,498 / 6,193 | 2 | 0.098 / 0.118 / 0.121 / 0.121 |
| 640×68 | light / reduced | 0.540 / 0.751 / 0.833 / 0.942 | 0.400 | 3,433 / 6,193 | 2 | 0.098 / 0.118 / 0.118 / 0.121 |

This is the intentional full-chapter baseline. It is stricter than the earlier 180-frame focused sample:
it includes sustained movement, four formation bands, stains, debris, effects, and the frozen result screen.
A 640×68 frame can require two Kitty APC records; the host still delivers the complete frame in one write.
Future comparable native fixtures gate p95 encode time and average/peak payload at no more than 15% above
this baseline unless an intentional visual-quality change records a new reference.

### Hide and resume

The lifecycle fixture renders a live production frame, hides for 10 seconds, verifies that game state and the
exact decoded RGB framebuffer do not change, deletes the owned Kitty image, then resumes without catch-up.

| Device pixels | Delete bytes | First resumed frame | Immediate repeat |
| --- | ---: | ---: | ---: |
| 320×34 | 24 | 0.138 ms, 980 B, one APC | 0.065 ms, 0 B |
| 640×68 | 24 | 0.333 ms, 2,136 B, one APC | 0.186 ms, 0 B |

Both are below the 50 ms local and 100 ms SSH first-frame gates. Stable result frames and immediate repeats
produce zero terminal bytes. These timings measure local rendering, not SSH transport latency.

### Automated host evidence

| Boundary | Automated evidence |
| --- | --- |
| Capability startup | Successful Kitty reply, DA-only unsupported response, silent timeout, known-terminal path, forced tier, tmux/screen and non-TTY skips |
| Probe budget | 400 ms local and 1,200 ms SSH caps; delayed SSH and DA-before-graphics replies covered |
| Standby | Exactly `·` or `•` at `cols - 1`; no branding and no periodic bytes while stable |
| Input and focus | CLI owns hidden/yielded input; help, unsupported geometry, alternate screen, resize, and ordinary hide are covered in nested PTYs |
| Host events | Active and yielded task events are polled independently and observed within the 150 ms test gate |
| Graphics ownership | Kitty deletion precedes CLI handoff; no hidden APC frames; terminal regions and cursor are restored |
| Character budget | Braille micro samples enforce less than 250 B/frame average and 600 B peak |
| Backpressure | Inner CLI output is forwarded first; a false stdout write pauses the child PTY until drain, while active game frames above 48 KiB queued output are skipped |

The host keeps a 30 fps local and 15 fps SSH cadence. Existing backpressure is not adaptive scheduling:
it protects wrapped-CLI throughput and drops optional game work when output is congested. A stable standby has
no game-render timer at all.

## Generated artifacts

Run:

```sh
node --experimental-strip-types scripts/pixel-qa.mjs /tmp/moyu-pixel-qa
node --experimental-strip-types scripts/visual-qa.mjs /tmp/moyu-visual-qa
```

`pixel-qa` writes `metrics.json`, decoded production Kitty PNG captures, and `preview.html` for the two sizes,
two themes, normal/reduced motion, chapter bands, and result state. Browser scaling is for inspection only.
`visual-qa` writes actual ANSI frames, `contact.svg`, and browser previews for character renderers. A browser
or SVG font rasterizer does not certify a native terminal.

## Client matrix

No untested client is labeled certified. Protocol tests establish byte-level behavior, not font, line-height,
image placement, theme contrast, or remote latency on a particular terminal.

| Terminal / path | Automated coverage | Native visual status |
| --- | --- | --- |
| macOS Terminal | Character fallback selection and PTY ownership paths | Manual client check pending |
| iTerm2 | Safe fallback; iTerm2 inline images are not implemented | Manual client check pending |
| Kitty | Graphics negotiation, chunking, replacement, and deletion | Manual image placement check pending |
| Ghostty | Kitty-protocol path and full-frame replacement | Manual image placement check pending |
| WezTerm | Capability and fallback paths | Manual client check pending |
| VS Code integrated terminal | Character fallback and PTY ownership paths | Manual client check pending |
| Windows Terminal / WSL | Character fallback and Node/PTY platform target | Manual WSL check pending |
| Termius / SSH | SSH 15 fps path, probe budget, and character fallback | Real remote latency/font check pending |
| tmux | Graphics probing is skipped; character fallback remains | Manual pane/resize check pending |

## Manual acceptance procedure

Record terminal version, OS, font, size, line height, local/SSH/tmux path, theme, and selected backend. Then:

- Confirm glyph continuity and two-row placement in dark and light themes.
- Recognize player/enemy silhouettes, facing, jump, windup, slash, hurt, task wave, and result state.
- Check `MOYU_REDUCE_MOTION=1`: action remains legible without shake or flash.
- Enter, hide for 10 seconds, and return; state must not advance and the first frame must appear promptly.
- Resize while hidden and visible; resize must never recapture game focus automatically.
- Enter/leave alternate screen and force task done/notify; the image must be deleted before CLI handoff.
- Stream CLI output during play and verify ordering, responsiveness, clean teardown, and composer repaint.
- Check Ctrl+], F12, Esc, Ctrl+G, Ctrl+Space, Ctrl+C, arrows, paste, and terminal replies.
- For Kitty graphics, inspect clipping, device-pixel scale, theme contrast, chunked frames, and image deletion.

## Reproduce

```sh
npm run typecheck
npm test
node --experimental-strip-types scripts/pixel-qa.mjs /tmp/moyu-pixel-qa
node --experimental-strip-types scripts/visual-qa.mjs /tmp/moyu-visual-qa
node --experimental-strip-types scripts/codex-smoke.mjs
MOYU_TIER=braille ./bin/moyu -- codex
```

The Codex smoke submits no prompt and never approves a directory-trust chooser. If Codex requires trust or
another interactive startup decision, the script records local ANSI diagnostics and reports a manual block.
Preview and smoke scripts are development tools and are not included in the published package.
