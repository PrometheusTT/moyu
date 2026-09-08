/** Byte-exact input routing for the coding CLI and the foreground cartridge. */
import type { Focus } from './regions.ts';

export const PREFIX = 0x07; // Kept public as the explicit statement that Ctrl+G is passthrough.

export type Action =
  | { kind: 'forward'; bytes: Uint8Array }
  | { kind: 'game'; bytes: Uint8Array }
  | { kind: 'toggle-focus' };

type KittyKey = { code: number; ctrl: boolean; alt: boolean; event: number };
type Scan = { end: number; key: KittyKey | null; reply: boolean } | 'partial' | null;
const EMPTY = new Uint8Array(0);
const MAX_HOLD = 24;

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length); return out;
}

function subParam(params: string, index: number, sub: number): number | undefined {
  const value = params.split(';')[index]?.split(':')[sub];
  return value === undefined || value === '' ? undefined : Number(value);
}

function parseKitty(params: string): KittyKey | null {
  const code = subParam(params, 0, 0);
  if (code === undefined) return null;
  const mods = subParam(params, 1, 0) ?? 1;
  return { code, ctrl: ((mods - 1) & 4) !== 0, alt: ((mods - 1) & 2) !== 0,
    event: subParam(params, 1, 1) ?? 1 };
}

function scanEsc(buf: Uint8Array, at: number): Scan {
  const next = buf[at + 1];
  // A lone Escape is a real key, not an indefinitely buffered sequence.
  if (next === undefined || next < 0x20) return null;
  if (next !== 0x5b) {
    if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
      for (let j = at + 2; j < buf.length; j++) {
        if (buf[j] === 0x07) return { end: j + 1, key: null, reply: true };
        if (buf[j] === 0x1b && buf[j + 1] === 0x5c) return { end: j + 2, key: null, reply: true };
      }
    }
    if (next === 0x4f && buf[at + 2] !== undefined) return { end: at + 3, key: null, reply: false };
    return { end: at + 2, key: null, reply: false };
  }
  let j = at + 2;
  while (j < buf.length && buf[j]! >= 0x30 && buf[j]! <= 0x3f) j++;
  const paramEnd = j;
  while (j < buf.length && buf[j]! >= 0x20 && buf[j]! <= 0x2f) j++;
  if (j >= buf.length) return j - at <= MAX_HOLD ? 'partial' : null;
  const end = j + 1;
  const params = Buffer.from(buf.subarray(at + 2, paramEnd)).toString('latin1');
  const inter = Buffer.from(buf.subarray(paramEnd, j)).toString('latin1');
  const final = String.fromCharCode(buf[j]!);
  const reply = (final === 'c' && /^[?>]/.test(params))
    || (final === 'R' && /^\d+;\d+$/.test(params))
    || (final === 't' && /^(?:4|5|6|8|9);/.test(params))
    || (final === 'u' && params.startsWith('?'))
    || (final === 'y' && inter.includes('$'));
  if (final !== 'u' || /[<=>?]/.test(params)) return { end, key: null, reply };
  return { end, key: parseKitty(params), reply: false };
}

function kittyAction(key: KittyKey | null, reply: boolean, focus: Focus, bytes: Uint8Array): Action | 'pass' | 'drop' {
  if (reply) return { kind: 'forward', bytes };
  if (key === null) return 'pass';

  // Moyu owns every phase of its two focus gestures so repeat/release cannot leak into
  // the wrapped CLI. Event filtering for every other key happens only after ownership.
  if (key.ctrl && !key.alt && key.code === 93) {
    return key.event === 1 ? { kind: 'toggle-focus' } : 'drop';
  }
  if (key.code === 57375 && !key.ctrl && !key.alt) {
    return key.event === 1 ? { kind: 'toggle-focus' } : 'drop';
  }
  if (focus === 'cli') return 'pass';
  if (key.alt || key.ctrl) return { kind: 'forward', bytes };
  if (key.event === 3) return 'drop';
  if (key.code === 27) return { kind: 'toggle-focus' };

  const arrow = key.code === 57350 ? '\x1b[D' : key.code === 57351 ? '\x1b[C'
    : key.code === 57352 ? '\x1b[A' : key.code === 57353 ? '\x1b[B' : null;
  if (arrow !== null) return { kind: 'game', bytes: Buffer.from(arrow, 'latin1') };
  if (key.code >= 0x20 && key.code <= 0x7e) return { kind: 'game', bytes: Uint8Array.of(key.code) };
  return 'pass';
}

export class InputRouter {
  focus: Focus;
  private held: Uint8Array = EMPTY;
  private pasting = false;
  /** 0=普通输入，1=OSC/DCS/SOS/PM/APC 载荷，2=载荷中待判定 ST 的 ESC。 */
  private terminalString: 0 | 1 | 2 = 0;

  constructor(opts: { focus?: Focus } = {}) { this.focus = opts.focus ?? 'cli'; }
  get heldBytes(): number { return this.held.length + (this.terminalString === 2 ? 1 : 0); }

  route(chunk: Uint8Array): Action[] {
    const buf = this.held.length === 0 ? chunk : join(this.held, chunk);
    this.held = EMPTY;
    const actions: Action[] = [];
    let runStart = -1;
    const flush = (end: number): void => {
      if (runStart < 0 || end <= runStart) { runStart = -1; return; }
      const bytes = buf.subarray(runStart, end);
      actions.push(this.pasting || this.focus === 'cli' ? { kind: 'forward', bytes } : { kind: 'game', bytes });
      runStart = -1;
    };

    let i = 0;
    while (i < buf.length) {
      const b = buf[i]!;
      if (this.terminalString === 1) {
        let end = i;
        while (end < buf.length && buf[end] !== 0x07 && buf[end] !== 0x18
          && buf[end] !== 0x1a && buf[end] !== 0x1b) end++;
        if (end > i) actions.push({ kind: 'forward', bytes: buf.subarray(i, end) });
        i = end;
        if (i >= buf.length) continue;
        const special = buf[i]!;
        if (special === 0x1b) { this.terminalString = 2; i++; continue; }
        actions.push({ kind: 'forward', bytes: buf.subarray(i, i + 1) });
        this.terminalString = 0; // BEL terminates; CAN/SUB interrupts.
        i++;
        continue;
      }
      if (this.terminalString === 2) {
        if (b === 0x5c) {
          actions.push({ kind: 'forward', bytes: Uint8Array.of(0x1b, b) });
          this.terminalString = 0;
          i++;
          continue;
        }
        // The preceding ESC did not form ST. Reparse it and the remaining bytes as a
        // fresh escape sequence rather than treating them as string payload.
        this.terminalString = 0;
        const rest = new Uint8Array(1 + buf.length - i);
        rest[0] = 0x1b;
        rest.set(buf.subarray(i), 1);
        actions.push(...this.route(rest));
        return actions;
      }
      if (!this.pasting && b === 0x1b) {
        const next = buf[i + 1];
        if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
          flush(i);
          actions.push({ kind: 'forward', bytes: buf.subarray(i, i + 2) });
          this.terminalString = 1;
          i += 2;
          continue;
        }
      }
      if (b === 0x1b) {
        const scan = scanEsc(buf, i);
        if (scan === 'partial') { flush(i); this.held = buf.slice(i); return actions; }
        if (scan !== null) {
          const bytes = buf.subarray(i, scan.end);
          const seq = Buffer.from(bytes).toString('latin1');
          if (seq === '\x1b[200~' || seq === '\x1b[201~') {
            flush(i); actions.push({ kind: 'forward', bytes }); this.pasting = seq === '\x1b[200~'; i = scan.end; continue;
          }
          if (this.pasting) { if (runStart < 0) runStart = i; i = scan.end; continue; }
          if (seq === '\x1b[24~') { flush(i); actions.push({ kind: 'toggle-focus' }); i = scan.end; continue; }
          const action = kittyAction(scan.key, scan.reply, this.focus, bytes);
          if (action === 'pass') { if (runStart < 0) runStart = i; }
          else { flush(i); if (action !== 'drop') actions.push(action); }
          i = scan.end; continue;
        }
      }
      if (this.pasting) { if (runStart < 0) runStart = i; i++; continue; }
      if (b === 0x1d) { flush(i); actions.push({ kind: 'toggle-focus' }); i++; continue; }
      // Legacy terminals encode Ctrl+Space as NUL. Preserve it for the wrapped CLI even
      // while the game has focus; swallowing it here still breaks terminal-side IME setups.
      if (b === 0x00) { flush(i); actions.push({ kind: 'forward', bytes: Uint8Array.of(b) }); i++; continue; }
      if (b === 0x1b && this.focus === 'game') { flush(i); actions.push({ kind: 'toggle-focus' }); i++; continue; }
      if ((b === PREFIX || b === 0x03) && this.focus === 'game') {
        flush(i); actions.push({ kind: 'forward', bytes: Uint8Array.of(b) }); i++; continue;
      }
      if (runStart < 0) runStart = i;
      i++;
    }
    flush(buf.length);
    return actions;
  }
}

export function hotkeyHint(focus: Focus): string {
  return focus === 'game' ? 'J 动作 · WASD 移动 · Esc 返回' : 'Ctrl+] 摸鱼';
}
