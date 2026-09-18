export const PREFIX = 0x07; // Kept public as the explicit statement that Ctrl+G is passthrough.
const EMPTY = new Uint8Array(0);
const MAX_HOLD = 24;
function join(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}
function subParam(params, index, sub) {
    const value = params.split(';')[index]?.split(':')[sub];
    return value === undefined || value === '' ? undefined : Number(value);
}
function parseKitty(params) {
    const code = subParam(params, 0, 0);
    if (code === undefined)
        return null;
    const mods = subParam(params, 1, 0) ?? 1;
    return { code, ctrl: ((mods - 1) & 4) !== 0, alt: ((mods - 1) & 2) !== 0,
        event: subParam(params, 1, 1) ?? 1 };
}
function scanEscTail(buf, tailAt) {
    const next = buf[tailAt];
    if (next === undefined || next < 0x20)
        return null;
    if (next !== 0x5b) {
        if (next === 0x4f && buf[tailAt + 1] !== undefined) {
            return { end: tailAt + 2, key: null, reply: false };
        }
        return { end: tailAt + 1, key: null, reply: false };
    }
    let j = tailAt + 1;
    while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f)
        j++;
    const paramEnd = j;
    while (j < buf.length && buf[j] >= 0x20 && buf[j] <= 0x2f)
        j++;
    if (j >= buf.length)
        return j - tailAt + 1 <= MAX_HOLD ? 'partial' : null;
    const end = j + 1;
    const params = Buffer.from(buf.subarray(tailAt + 1, paramEnd)).toString('latin1');
    const inter = Buffer.from(buf.subarray(paramEnd, j)).toString('latin1');
    const final = String.fromCharCode(buf[j]);
    const reply = (final === 'c' && /^[?>]/.test(params))
        || (final === 'R' && /^\d+;\d+$/.test(params))
        || (final === 't' && /^(?:4|5|6|8|9);/.test(params))
        || (final === 'u' && params.startsWith('?'))
        || (final === 'y' && inter.includes('$'));
    if (final !== 'u' || /[<=>?]/.test(params))
        return { end, key: null, reply };
    return { end, key: parseKitty(params), reply: false };
}
function scanEsc(buf, at) {
    // A lone Escape is a real key, not an indefinitely buffered sequence.
    return scanEscTail(buf, at + 1);
}
function kittyAction(key, reply, focus, bytes) {
    if (reply)
        return { kind: 'forward', bytes };
    if (key === null)
        return 'pass';
    // Moyu owns every phase of its two focus gestures so repeat/release cannot leak into
    // the wrapped CLI. Event filtering for every other key happens only after ownership.
    if (key.ctrl && !key.alt && key.code === 93) {
        return key.event === 1 ? { kind: 'toggle-focus' } : 'drop';
    }
    if (key.code === 57375 && !key.ctrl && !key.alt) {
        return key.event === 1 ? { kind: 'toggle-focus' } : 'drop';
    }
    if (focus === 'cli')
        return 'pass';
    if (key.alt || key.ctrl)
        return { kind: 'forward', bytes };
    if (key.event === 3)
        return 'drop';
    if (key.code === 27)
        return { kind: 'toggle-focus' };
    const arrow = key.code === 57350 ? '\x1b[D' : key.code === 57351 ? '\x1b[C'
        : key.code === 57352 ? '\x1b[A' : key.code === 57353 ? '\x1b[B' : null;
    if (arrow !== null)
        return { kind: 'game', bytes: Buffer.from(arrow, 'latin1') };
    if (key.code >= 0x20 && key.code <= 0x7e)
        return { kind: 'game', bytes: Uint8Array.of(key.code) };
    return 'pass';
}
export class InputRouter {
    focus;
    held = EMPTY;
    pasting = false;
    terminalString = 'normal';
    csiOverflow = false;
    kittyEscapeOwner = null;
    constructor(opts = {}) { this.focus = opts.focus ?? 'cli'; }
    get heldBytes() {
        return this.held.length + (this.terminalString.endsWith('-esc') ? 1 : 0);
    }
    kittyEscapeAction(key, bytes) {
        if (key.event === 1) {
            this.kittyEscapeOwner = this.focus;
            return this.focus === 'game' ? { kind: 'toggle-focus' } : { kind: 'forward', bytes };
        }
        const owner = this.kittyEscapeOwner;
        if (key.event === 3)
            this.kittyEscapeOwner = null;
        if (owner === 'cli')
            return { kind: 'forward', bytes };
        if (owner === 'game')
            return 'drop';
        return this.focus === 'cli' ? { kind: 'forward', bytes } : 'drop';
    }
    route(chunk, onAction) {
        const pendingStringEsc = this.terminalString.endsWith('-esc') && chunk.length > 0;
        const completedString = pendingStringEsc && chunk[0] === 0x5c;
        const cancelledString = pendingStringEsc && (chunk[0] === 0x18 || chunk[0] === 0x1a);
        const doubledStringEsc = pendingStringEsc && chunk[0] === 0x1b;
        const interruptedString = pendingStringEsc && !completedString && !cancelledString && !doubledStringEsc;
        const heldEsc = this.held.length === 1 && this.held[0] === 0x1b;
        if (pendingStringEsc)
            this.terminalString = 'normal';
        const buf = interruptedString ? join(Uint8Array.of(0x1b), chunk)
            : this.held.length === 0 ? chunk : join(this.held, chunk);
        const heldFreshEsc = heldEsc && this.terminalString === 'normal' && !interruptedString;
        const causalStringEsc = interruptedString || doubledStringEsc || heldFreshEsc;
        this.held = EMPTY;
        const actions = [];
        const emit = (action) => {
            if (onAction === undefined)
                actions.push(action);
            else
                onAction(action);
        };
        let runStart = -1;
        const pushRun = (bytes) => {
            emit(this.pasting || this.focus === 'cli' ? { kind: 'forward', bytes } : { kind: 'game', bytes });
        };
        const flush = (end) => {
            if (runStart < 0 || end <= runStart) {
                runStart = -1;
                return;
            }
            pushRun(buf.subarray(runStart, end));
            runStart = -1;
        };
        let i = 0;
        // An ESC that interrupted a terminal string is a sequence introducer, even when the
        // resulting two-byte opener happens to occupy an otherwise ambiguous whole chunk.
        let causalEscAt = causalStringEsc ? 0 : -1;
        if (this.csiOverflow) {
            let j = 0;
            while (j < buf.length && !(buf[j] >= 0x40 && buf[j] <= 0x7e))
                j++;
            const end = Math.min(buf.length, j + 1);
            if (end > 0)
                emit({ kind: 'forward', bytes: buf.subarray(0, end) });
            if (j >= buf.length)
                return actions;
            this.csiOverflow = false;
            i = end;
        }
        if (completedString || cancelledString) {
            emit({ kind: 'forward', bytes: Uint8Array.of(0x1b, chunk[0]) });
            i = 1;
        }
        else if (doubledStringEsc) {
            emit({ kind: 'forward', bytes: Uint8Array.of(0x1b) });
            if (chunk.length === 1) {
                // The string-ending ESC established that this second ESC starts a fresh sequence.
                // Keep it across one more PTY split instead of reinterpreting it as a bare key.
                this.held = chunk.slice();
                return actions;
            }
        }
        while (i < buf.length) {
            if (i >= buf.length)
                break;
            const b = buf[i];
            if (this.terminalString === 'osc' || this.terminalString === 'st') {
                let end = i;
                while (end < buf.length && buf[end] !== 0x18 && buf[end] !== 0x1a
                    && buf[end] !== 0x1b && !(this.terminalString === 'osc' && buf[end] === 0x07))
                    end++;
                if (end > i)
                    emit({ kind: 'forward', bytes: buf.subarray(i, end) });
                i = end;
                if (i >= buf.length)
                    continue;
                const special = buf[i];
                if (special === 0x1b) {
                    if (i + 1 >= buf.length) {
                        this.terminalString = this.terminalString === 'osc' ? 'osc-esc' : 'st-esc';
                        break;
                    }
                    if (buf[i + 1] === 0x5c) {
                        emit({ kind: 'forward', bytes: buf.subarray(i, i + 2) });
                        this.terminalString = 'normal';
                        i += 2;
                        continue;
                    }
                    if (buf[i + 1] === 0x1b) {
                        emit({ kind: 'forward', bytes: buf.subarray(i, i + 1) });
                        this.terminalString = 'normal';
                        i++;
                        // This Escape is not an ambiguous standalone key: the preceding string Escape
                        // established that it begins a fresh sequence. Retain it if its tail was split.
                        if (i + 1 >= buf.length) {
                            this.held = buf.slice(i);
                            return actions;
                        }
                        continue;
                    }
                    if (buf[i + 1] === 0x18 || buf[i + 1] === 0x1a) {
                        emit({ kind: 'forward', bytes: buf.subarray(i, i + 2) });
                        this.terminalString = 'normal';
                        i += 2;
                        continue;
                    }
                    this.terminalString = 'normal';
                    causalEscAt = i;
                    continue;
                }
                emit({ kind: 'forward', bytes: buf.subarray(i, i + 1) });
                this.terminalString = 'normal';
                i++;
                continue;
            }
            if (!this.pasting && b === 0x1b) {
                const next = buf[i + 1];
                const kind = next === 0x5d ? 'osc' : next === 0x50 || next === 0x58
                    || next === 0x5e || next === 0x5f ? 'st' : null;
                if (kind !== null && (causalEscAt === i || i + 2 < buf.length || i > 0)) {
                    flush(i);
                    emit({ kind: 'forward', bytes: buf.subarray(i, i + 2) });
                    this.terminalString = kind;
                    i += 2;
                    continue;
                }
                if (kind !== null && i === 0 && buf.length === 2) {
                    flush(i);
                    emit({ kind: 'forward', bytes: buf });
                    return actions;
                }
            }
            if (b === 0x1b) {
                const scan = scanEsc(buf, i);
                if (scan === 'partial') {
                    flush(i);
                    this.held = buf.slice(i);
                    return actions;
                }
                if (scan !== null && scan.end - i > MAX_HOLD) {
                    flush(i);
                    emit({ kind: 'forward', bytes: buf.subarray(i, scan.end) });
                    i = scan.end;
                    continue;
                }
                if (scan === null && buf[i + 1] === 0x5b && buf.length - i > MAX_HOLD) {
                    flush(i);
                    // Once the bounded parser gives up, conservatively forward the whole CSI through
                    // its final byte. That keeps an eventual terminal reply on one destination without
                    // retaining an attacker-controlled parameter body.
                    emit({ kind: 'forward', bytes: buf.subarray(i) });
                    this.csiOverflow = true;
                    return actions;
                }
                if (scan !== null) {
                    const bytes = buf.subarray(i, scan.end);
                    const seq = Buffer.from(bytes).toString('latin1');
                    if (seq === '\x1b[200~' || seq === '\x1b[201~') {
                        flush(i);
                        emit({ kind: 'forward', bytes });
                        this.pasting = seq === '\x1b[200~';
                        i = scan.end;
                        continue;
                    }
                    if (this.pasting) {
                        if (runStart < 0)
                            runStart = i;
                        i = scan.end;
                        continue;
                    }
                    if (seq === '\x1b[24~') {
                        flush(i);
                        emit({ kind: 'toggle-focus' });
                        i = scan.end;
                        continue;
                    }
                    const escapePhase = scan.key?.code === 27 && !scan.reply;
                    if (escapePhase && scan.key.event === 1 && (scan.key.ctrl || scan.key.alt)) {
                        // A modified Escape press belongs to the wrapped CLI. Modifiers may be released
                        // before Escape, so remember that ownership for later unmodified repeat/release phases.
                        this.kittyEscapeOwner = 'cli';
                    }
                    const action = escapePhase
                        && ((scan.key.event !== 1 && this.kittyEscapeOwner !== null)
                            || (!scan.key.ctrl && !scan.key.alt))
                        ? this.kittyEscapeAction(scan.key, bytes)
                        : kittyAction(scan.key, scan.reply, this.focus, bytes);
                    if (action === 'pass') {
                        if (runStart < 0)
                            runStart = i;
                    }
                    else {
                        flush(i);
                        if (action !== 'drop')
                            emit(action);
                    }
                    i = scan.end;
                    continue;
                }
            }
            if (this.pasting) {
                if (runStart < 0)
                    runStart = i;
                i++;
                continue;
            }
            if (b === 0x1d) {
                flush(i);
                emit({ kind: 'toggle-focus' });
                i++;
                continue;
            }
            // Legacy terminals encode Ctrl+Space as NUL. Preserve it for the wrapped CLI even
            // while the game has focus; swallowing it here still breaks terminal-side IME setups.
            if (b === 0x00) {
                flush(i);
                emit({ kind: 'forward', bytes: Uint8Array.of(b) });
                i++;
                continue;
            }
            if (b === 0x1b && this.focus === 'game') {
                flush(i);
                emit({ kind: 'toggle-focus' });
                i++;
                continue;
            }
            if ((b === PREFIX || b === 0x03) && this.focus === 'game') {
                flush(i);
                emit({ kind: 'forward', bytes: Uint8Array.of(b) });
                i++;
                continue;
            }
            if (runStart < 0)
                runStart = i;
            i++;
        }
        flush(buf.length);
        return actions;
    }
}
export function hotkeyHint(focus) {
    return focus === 'game' ? 'J 动作 · WASD 移动 · Esc 返回' : 'Ctrl+] 摸鱼';
}
