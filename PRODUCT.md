# Moyu product contract

Moyu is a tiny handheld game console that lives under a coding CLI while an agent works.
The coding session is always the primary task. The game must be instantly available without
stealing input, damaging terminal state, or making users wait through setup.

## Product hierarchy

1. Preserve every byte, screen state, signal, and exit code that belongs to the wrapped CLI.
2. Let the user enter or leave play with one gesture and keep the game state between visits.
3. Make characters, direction, and actions readable on ordinary UTF-8 terminals over SSH.
4. Keep the host quiet and consistent; cartridges own their palette and personality.
5. Grow through a small, versioned, local-first cartridge API before adding a network service.

## Interaction contract

- Standby reserves one non-animated row at the bottom of the terminal but paints exactly one safe-edge
  cell: a low-contrast `·` while idle and `•` while a task event remains unacknowledged. It contains no
  Moyu name or shortcut prose, and an unchanged standby performs no game render or terminal write.
- `Ctrl+]` toggles play over local terminals and SSH without colliding with common IME shortcuts.
  F12 is a compatibility alias. `Ctrl+Space` is never owned by Moyu. `Esc` and `q` leave play.
- `Ctrl+G` is never owned by Moyu. It is forwarded to Codex, Claude, or any other wrapped CLI.
- In Codex, play occupies exactly two character rows immediately above the composer. The host
  discovers that anchor from Codex output without terminal-specific APIs or a screen daemon.
- Two rows are the default, not a universal game resolution. E explicitly opens six protected
  bottom rows (four when space is limited), and returns to micro mode only when the cartridge supports
  it; an unsupported or too-small view hands input back to the wrapped CLI. Esc always leaves play.
- First entry starts live play; cartridge switches show controls until a gameplay input. ? reopens help.
  Ordinary hide/resume returns directly to the preserved scene. Hidden play, help, and unsupported
  display sizes pause simulation while host events keep polling.
- If a wrapped CLI exposes no recognizable composer, play safely falls back to a two-row bottom
  strip while preserving at least ten rows for the coding CLI.
- Task completion silently saves the game, returns focus to the CLI, and changes the standby cell to `•`.
  The marker remains until explicit game entry acknowledges it.
- Stick Slash persists only completed-chapter campaign boundaries, including the exact gameplay RNG state.
  Transient physics after the latest checkpoint may roll back after restart; lifetime records never roll back.
  Ten bounded 30-second chapters form one run, and live enemy count never exceeds three.
- Paste, Ctrl+C, terminal replies, alternate screens, resize, and teardown favor the inner CLI.

## Rendering contract

- Actual image rendering is the high-quality path. Text compatibility is playable fallback,
  not a promise of Kitty-like image quality. No companion client or mandatory font is required.
- Native-pixel Kitty rendering and deterministic visual/performance acceptance fixtures are implemented.
  iTerm2 inline images and Sixel are not implemented. Existing output backpressure always prioritizes the
  wrapped CLI and may drop optional game frames; adaptive link-aware frame scheduling remains future work.
- Unicode Braille with ANSI color is the normal portable renderer, including SSH and Termius.
- Half-block output is the last-resort renderer for limited terminals.
- Games draw into a logical framebuffer and never emit terminal escape sequences.
- An optional `renderPixels(canvas, context)` draws directly at device resolution; its camera
  never changes simulation dimensions. Older cartridges retain the logical-framebuffer path.
- Cartridges may provide an optional 80×8 `renderMicro` composition. It shares simulation state
  with the full view, but redraws silhouettes for two rows instead of destructively shrinking them.
- Cartridges explicitly declare micro playability, minimum expanded rows, and dots/blocks style.
  Unsupported views show an expansion entry. Native pictures never magnify an eight-dot micro sprite.
- Portable quality is the baseline. Every supported terminal must have readable characters and
  actions, even when detail differs. Protocol tests alone do not certify native visual quality.
- Reduced-motion mode keeps gameplay state legible without shake, flash, or decorative animation.
- Pixel themes are explicitly dark (default) or `MOYU_THEME=light` until reliable theme negotiation
  is implemented; do not claim the image automatically inherits the terminal background.
- Reference QA uses one complete deterministic 1,800-step chapter across dark/light and normal/reduced
  motion. Native p95 encode time and average/peak payload may grow at most 15% against a comparable
  baseline unless an intentional visual change records a new baseline. The first resumed frame gates at
  50 ms local / 100 ms SSH; hidden host events gate at 150 ms. Braille micro output gates below 250 B/frame
  average and 600 B peak, and stable standby/result frames emit no repeated bytes.

## Platform contract

- The release supports macOS, Linux, native Windows, and Windows through WSL.
- First run is playable without hooks, an account, a daemon, or network access.
- Local third-party JavaScript cartridges are explicitly trusted code. The installer must say so.
- Built-in cartridges prove three different workloads: action, grid movement, and falling blocks.
- The host uses Node built-ins wherever practical and keeps install-time compilation at zero.

## Visual system

The one-cell standby and console chrome use a restrained quiet-cool foreground, with a slightly brighter
neutral dot for unacknowledged task attention; neither uses a background block. Cartridges may declare a
limited palette. Motion exists to explain input, impact, or state change; it is never ambient decoration in
the host interface.
