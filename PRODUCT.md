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

- Standby is one non-animated row at the bottom of the terminal.
- `Ctrl+]` toggles play over local terminals and SSH without colliding with common IME shortcuts.
  F12 is a compatibility alias. `Ctrl+Space` is never owned by Moyu. `Esc` and `q` leave play.
- `Ctrl+G` is never owned by Moyu. It is forwarded to Codex, Claude, or any other wrapped CLI.
- In Codex, play occupies exactly two character rows immediately above the composer. The host
  discovers that anchor from Codex output without terminal-specific APIs or a screen daemon.
- Two rows are the default, not a universal game resolution. E explicitly opens six protected
  bottom rows (four when space is limited), and returns to micro mode. Esc always leaves play.
- First entry and cartridge switches show controls until a gameplay input; ? reopens help.
  Hidden play, help, and unsupported display sizes pause simulation while host events keep polling.
- If a wrapped CLI exposes no recognizable composer, play safely falls back to a two-row bottom
  strip while preserving at least ten rows for the coding CLI.
- Task completion silently saves the game, returns focus to the CLI, and marks the standby row.
- Paste, Ctrl+C, terminal replies, alternate screens, resize, and teardown favor the inner CLI.

## Rendering contract

- Actual image rendering is the high-quality path. Text compatibility is playable fallback,
  not a promise of Kitty-like image quality. No companion client or mandatory font is required.
- Phase 1 implements native-pixel Kitty rendering and deterministic visual acceptance samples.
  iTerm2/Sixel and adaptive output scheduling follow only after native visual acceptance.
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

## Platform contract

- The first release supports macOS, Linux, and Windows through WSL.
- First run is playable without hooks, an account, a daemon, or network access.
- Local third-party JavaScript cartridges are explicitly trusted code. The installer must say so.
- Built-in cartridges prove three different workloads: action, grid movement, and falling blocks.
- The host uses Node built-ins wherever practical and keeps install-time compilation at zero.

## Visual system

The standby row and console chrome use a restrained charcoal surface, quiet cool text, amber for
attention, and red only for urgent state. Cartridges may declare a limited palette. Motion exists
to explain input, impact, or state change; it is never ambient decoration in the host interface.
