import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputRouter } from '../../src/shell/focus.ts';

const enc = new TextEncoder();
const b = (s: string): Uint8Array => enc.encode(s);
const kinds = (r: InputRouter, value: Uint8Array): string[] => r.route(value).map((a) => a.kind);

function routed(r: InputRouter, chunks: Uint8Array[]): { forwarded: Uint8Array; kinds: string[] } {
  const actions = chunks.flatMap((chunk) => r.route(chunk));
  return {
    forwarded: Uint8Array.from(actions.flatMap((a) => a.kind === 'forward' ? [...a.bytes] : [])),
    kinds: actions.map((a) => a.kind),
  };
}

function allNonAmbiguousSplits(raw: Uint8Array): Uint8Array[][] {
  // A chunk containing only ESC is intentionally a real Esc key. The input API has no timer/flush
  // signal with which to distinguish that key from the first byte of a later escape sequence.
  return [[raw], ...Array.from({ length: raw.length - 2 }, (_, i) => i + 2)
    .map((cut) => [raw.subarray(0, cut), raw.subarray(cut)])];
}

test('Ctrl+] toggles in legacy and Kitty keyboard protocols', () => {
  const r = new InputRouter();
  assert.deepEqual(kinds(r, Uint8Array.of(0x1d)), ['toggle-focus']);
  assert.deepEqual(kinds(r, b('\x1b[93;5u')), ['toggle-focus']);
  assert.deepEqual(kinds(r, b('\x1b[93;5:2u')), []);
  assert.deepEqual(kinds(r, b('\x1b[93;5:3u')), []);
});

test('only Moyu-owned Kitty keys consume release events', () => {
  const cases = ['\x1b[97;1:3u', '\x1b[103;5:3u', '\x1b[99;5:3u'];
  for (const seq of cases) {
    const result = routed(new InputRouter(), [b(seq)]);
    assert.deepEqual(result.kinds, ['forward'], JSON.stringify(seq));
    assert.deepEqual(result.forwarded, b(seq), JSON.stringify(seq));
  }
});

test('Ctrl+Space is never owned by Moyu, including while the game has focus', () => {
  for (const focus of ['cli', 'game'] as const) {
    const legacy = new InputRouter({ focus }).route(Uint8Array.of(0));
    assert.equal(legacy[0]?.kind, 'forward');
    assert.deepEqual([...('bytes' in legacy[0]! ? legacy[0].bytes : [])], [0]);
    assert.deepEqual(kinds(new InputRouter({ focus }), b('\x1b[32;5u')), ['forward']);
  }
});

test('F12 is a one-key compatibility alias', () => {
  assert.deepEqual(kinds(new InputRouter(), b('\x1b[24~')), ['toggle-focus']);
  assert.deepEqual(kinds(new InputRouter(), b('\x1b[57375;1:2u')), []);
  assert.deepEqual(kinds(new InputRouter(), b('\x1b[57375;1:3u')), []);
});

test('Ctrl+G is always forwarded, including game focus and CSI-u', () => {
  const r = new InputRouter({ focus: 'game' });
  const actions = r.route(Uint8Array.of(7));
  assert.equal(actions[0]?.kind, 'forward');
  assert.deepEqual([...('bytes' in actions[0]! ? actions[0].bytes : [])], [7]);
  assert.equal(r.route(b('\x1b[103;5u'))[0]?.kind, 'forward');
});

test('bare Esc leaves play but arrows remain game input', () => {
  const r = new InputRouter({ focus: 'game' });
  assert.deepEqual(kinds(r, Uint8Array.of(27)), ['toggle-focus']);
  assert.deepEqual(kinds(r, b('\x1b[A')), ['game']);
});

test('Kitty protocol arrows are normalized for cartridges', () => {
  const r = new InputRouter({ focus: 'game' });
  const actions = r.route(b('\x1b[57352u'));
  assert.equal(actions[0]?.kind, 'game');
  assert.equal(Buffer.from('bytes' in actions[0]! ? actions[0].bytes : []).toString('latin1'), '\x1b[A');
});

test('terminal strings remain byte-exact CLI input across PTY chunk boundaries', () => {
  const strings = [
    '\x1b]52;c;payload\x07',
    '\x1bP1;2|payload\x1b\\',
    '\x1bXpayload\x1b\\',
    '\x1b^payload\x1b\\',
    '\x1b_payload\x1b\\',
  ];
  for (const seq of strings) {
    const raw = b(seq);
    for (const chunks of allNonAmbiguousSplits(raw)) {
      const result = routed(new InputRouter({ focus: 'game' }), chunks);
      assert.deepEqual(result.forwarded, raw, `${JSON.stringify(seq)} chunks=${chunks.map((c) => c.length)}`);
      assert.ok(result.kinds.every((kind) => kind === 'forward'), `${JSON.stringify(seq)}: ${result.kinds}`);
    }
  }
});

test('CAN and SUB terminate terminal strings without stealing later game input', () => {
  for (const cancel of ['\x18', '\x1a']) {
    const prefix = b(`\x1b]52;c;payload${cancel}`);
    const r = new InputRouter({ focus: 'game' });
    const before = routed(r, [prefix]);
    assert.deepEqual(before.forwarded, prefix);
    assert.ok(before.kinds.every((kind) => kind === 'forward'));
    assert.deepEqual(kinds(r, b('j')), ['game']);
  }
});

test('ESC interrupting a terminal string is parsed as a fresh sequence', () => {
  const prefix = b('\x1b]unterminated');
  const fresh = b('\x1b[103;5:3u');
  for (const chunks of [[prefix, fresh], [prefix, fresh.subarray(0, 1), fresh.subarray(1)]]) {
    const result = routed(new InputRouter({ focus: 'game' }), chunks);
    assert.deepEqual(result.forwarded, Uint8Array.from([...prefix, ...fresh]));
    assert.ok(result.kinds.every((kind) => kind === 'forward'));
  }
});

test('bracketed paste bypasses every Moyu shortcut', () => {
  const r = new InputRouter({ focus: 'game' });
  const raw = Uint8Array.from([...b('\x1b[200~a'), 0, ...b('\x1b[24~'), 7, ...b('z\x1b[201~')]);
  const actions = r.route(raw);
  assert.ok(actions.every((a) => a.kind === 'forward'));
  const got = Uint8Array.from(actions.flatMap((a) => a.kind === 'forward' ? [...a.bytes] : []));
  assert.deepEqual(got, raw);
});
