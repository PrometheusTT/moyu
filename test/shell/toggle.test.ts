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
  // A chunk containing only ESC is intentionally a real Esc key, and an exact ESC plus
  // string introducer is intentionally one legacy Alt key. There is no timer/flush signal
  // with which to reinterpret either call when more bytes arrive later.
  return [[raw], ...Array.from({ length: raw.length - 3 }, (_, i) => i + 3)
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

test('legacy Alt string-introducer pairs stay one key and leave no parser state', () => {
  for (const focus of ['cli', 'game'] as const) for (const suffix of [']', 'P', 'X', '^', '_']) {
    const r = new InputRouter({ focus });
    const alt = b(`\x1b${suffix}`);
    const first = routed(r, [alt]);
    assert.deepEqual(first.forwarded, alt, `${focus} Alt+${suffix}`);
    assert.deepEqual(first.kinds, ['forward'], `${focus} Alt+${suffix}`);
    assert.deepEqual(kinds(r, b('j')), [focus === 'cli' ? 'forward' : 'game']);
    assert.deepEqual(kinds(r, Uint8Array.of(0x1d)), ['toggle-focus']);
  }
});

test('Kitty Escape ownership follows the gesture across focus and modifier changes', () => {
  const game = new InputRouter({ focus: 'game' });
  assert.deepEqual(kinds(game, b('\x1b[27;1:1u')), ['toggle-focus']);
  game.focus = 'cli';
  assert.deepEqual(kinds(game, b('\x1b[27;3:2u')), []);
  assert.deepEqual(kinds(game, b('\x1b[27;3:3u')), []);

  const cli = new InputRouter({ focus: 'cli' });
  assert.deepEqual(kinds(cli, b('\x1b[27;1:1u')), ['forward']);
  cli.focus = 'game';
  assert.deepEqual(kinds(cli, b('\x1b[27;3:2u')), ['forward']);
  assert.deepEqual(kinds(cli, b('\x1b[27;3:3u')), ['forward']);
  assert.deepEqual(kinds(cli, b('\x1b[27;1:1u')), ['toggle-focus'], 'new press replaces stale ownership');
});

test('a fresh modified Kitty Escape press replaces stale gesture ownership', () => {
  const r = new InputRouter({ focus: 'game' });
  assert.deepEqual(kinds(r, b('\x1b[27;1:1u')), ['toggle-focus']);
  r.focus = 'cli';
  assert.deepEqual(kinds(r, Uint8Array.of(0x1d)), ['toggle-focus']);
  r.focus = 'game';
  for (const seq of ['\x1b[27;3:1u', '\x1b[27;3:2u', '\x1b[27;3:3u']) {
    const result = routed(r, [b(seq)]);
    assert.deepEqual(result.kinds, ['forward'], JSON.stringify(seq));
    assert.deepEqual(result.forwarded, b(seq), JSON.stringify(seq));
  }
});

test('a fresh modified Kitty Escape press owns later unmodified phases', () => {
  const r = new InputRouter({ focus: 'game' });
  for (const seq of ['\x1b[27;3:1u', '\x1b[27;1:2u', '\x1b[27;1:3u']) {
    const result = routed(r, [b(seq)]);
    assert.deepEqual(result.kinds, ['forward'], JSON.stringify(seq));
    assert.deepEqual(result.forwarded, b(seq), JSON.stringify(seq));
  }
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

test('terminal-string openers after prior bytes survive a chunk boundary', () => {
  for (const opener of [']', 'P', 'X', '^', '_']) {
    const terminator = opener === ']' ? '\x07' : '\x1b\\';
    const raw = b(`x\x1b${opener}payload${terminator}j`);
    const cut = 3;
    for (const chunks of [[raw], [raw.subarray(0, cut), raw.subarray(cut)]]) {
      const result = routed(new InputRouter({ focus: 'game' }), chunks);
      assert.deepEqual(result.kinds.at(0), 'game', opener);
      assert.deepEqual(result.forwarded, raw.subarray(1, raw.length - 1), opener);
      assert.equal(result.kinds.at(-1), 'game', opener);
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

test('a string ESC interruption is invariant across chunk boundaries', () => {
  const cases = [
    b('\x1b]unterminated\x1b\x1b[103;5:3u'),
    Uint8Array.from([...b('\x1b]unterminated\x1b'), 0x18, 0x6a]),
    Uint8Array.from([...b('\x1b]unterminated\x1b'), 0x1a, 0x6a]),
  ];
  for (const raw of cases) {
    const expected = routed(new InputRouter({ focus: 'game' }), [raw]);
    for (let cut = 3; cut < raw.length; cut++) {
      const actual = routed(new InputRouter({ focus: 'game' }), [raw.subarray(0, cut), raw.subarray(cut)]);
      const label = `cut=${cut} raw=${JSON.stringify(Buffer.from(raw).toString('latin1'))}`;
      assert.deepEqual(actual.forwarded, expected.forwarded, label);
      assert.deepEqual(actual.kinds.filter((kind) => kind !== 'forward'),
        expected.kinds.filter((kind) => kind !== 'forward'), label);
    }
  }
  const triple = b('\x1b]unterminated\x1b\x1b[103;5:3u');
  const firstEsc = b('\x1b]unterminated\x1b').length;
  const actual = routed(new InputRouter({ focus: 'game' }), [
    triple.subarray(0, firstEsc), triple.subarray(firstEsc, firstEsc + 1), triple.subarray(firstEsc + 1),
  ]);
  assert.deepEqual(actual.forwarded, triple);
  assert.ok(actual.kinds.every((kind) => kind === 'forward'));
});

test('a direct nested terminal-string opener stays causal when isolated in a chunk', () => {
  for (const opener of [']', 'P', 'X', '^', '_']) {
    const terminator = opener === ']' ? '\x07' : '\x1b\\';
    const raw = b(`\x1b]old\x1b${opener}new${terminator}j`);
    const nested = b('\x1b]old').length;
    const expected = routed(new InputRouter({ focus: 'game' }), [raw]);
    for (const chunks of [
      [raw.subarray(0, nested), raw.subarray(nested)],
      [raw.subarray(0, nested), raw.subarray(nested, nested + 2), raw.subarray(nested + 2)],
      [raw.subarray(0, nested + 1), raw.subarray(nested + 1, nested + 2), raw.subarray(nested + 2)],
    ]) {
      const actual = routed(new InputRouter({ focus: 'game' }), chunks);
      const label = `${opener}: chunks=${chunks.map((chunk) => chunk.length)}`;
      assert.deepEqual(actual.forwarded, expected.forwarded, label);
      assert.deepEqual(actual.kinds.filter((kind) => kind !== 'forward'),
        expected.kinds.filter((kind) => kind !== 'forward'), label);
    }
  }
});

test('a doubled string ESC can start another terminal string across PTY splits', () => {
  for (const opener of [']', 'P', 'X', '^', '_']) {
    const terminator = opener === ']' ? '\x07' : '\x1b\\';
    const raw = b(`\x1b]old\x1b\x1b${opener}new${terminator}`);
    const secondEsc = b('\x1b]old\x1b').length;
    const expected = routed(new InputRouter({ focus: 'game' }), [raw]);
    for (const chunks of [
      [raw.subarray(0, secondEsc), raw.subarray(secondEsc)],
      [raw.subarray(0, secondEsc), raw.subarray(secondEsc, secondEsc + 1), raw.subarray(secondEsc + 1)],
      [raw.subarray(0, secondEsc), raw.subarray(secondEsc, secondEsc + 2), raw.subarray(secondEsc + 2)],
      [raw.subarray(0, secondEsc + 1), raw.subarray(secondEsc + 1)],
    ]) {
      const actual = routed(new InputRouter({ focus: 'game' }), chunks);
      const label = `${opener}: chunks=${chunks.map((chunk) => chunk.length)}`;
      assert.deepEqual(actual.forwarded, expected.forwarded, label);
      assert.deepEqual(actual.kinds.filter((kind) => kind !== 'forward'),
        expected.kinds.filter((kind) => kind !== 'forward'), label);
    }
  }
});

test('action callbacks observe focus changes before classifying later bytes', () => {
  for (const [focus, expected] of [
    ['game', ['toggle-focus', 'forward']],
    ['cli', ['toggle-focus', 'game']],
  ] as const) {
    const r = new InputRouter({ focus });
    const seen: string[] = [];
    r.route(Uint8Array.from([0x1d, 0x6a]), (action) => {
      seen.push(action.kind);
      if (action.kind === 'toggle-focus') r.focus = r.focus === 'game' ? 'cli' : 'game';
    });
    assert.deepEqual(seen, expected, focus);
  }
});

test('OSC accepts BEL or ST while ST-only strings ignore BEL', () => {
  for (const seq of ['\x1b]title\x07', '\x1b]title\x1b\\']) {
    const raw = b(seq);
    for (const cut of Array.from({ length: raw.length - 3 }, (_, i) => i + 3)) {
      const result = routed(new InputRouter({ focus: 'game' }), [raw.subarray(0, cut), raw.subarray(cut)]);
      assert.deepEqual(result.forwarded, raw, `${JSON.stringify(seq)} cut=${cut}`);
      assert.ok(result.kinds.every((kind) => kind === 'forward'));
    }
  }
  for (const opener of ['P', 'X', '^', '_']) {
    const r = new InputRouter({ focus: 'game' });
    const prefix = b(`\x1b${opener}before\x07after`);
    assert.deepEqual(routed(r, [prefix]).forwarded, prefix);
    assert.deepEqual(kinds(r, b('j')), ['forward'], `${opener}: BEL ended ST-only string`);
    assert.deepEqual(routed(r, [b('\x1b'), b('\\')]).forwarded, b('\x1b\\'));
    assert.deepEqual(kinds(r, b('j')), ['game']);
  }
});

test('interrupted terminal-string stress input remains iterative', () => {
  const raw = b('\x1b]x'.repeat(12_000));
  const r = new InputRouter({ focus: 'game' });
  assert.doesNotThrow(() => r.route(raw));
  assert.equal(r.heldBytes, 0);
});

test('overlong CSI routing is invariant when the final byte is split', () => {
  for (const final of ['A', 'c']) {
    const raw = b(`\x1b[?${'1'.repeat(22)}${final}`);
    const expected = routed(new InputRouter({ focus: 'game' }), [raw]);
    assert.deepEqual(expected.forwarded, raw, final);
    assert.ok(expected.kinds.every((kind) => kind === 'forward'), final);
    for (const cut of [raw.length - 1, 10]) {
      const result = routed(new InputRouter({ focus: 'game' }), [raw.subarray(0, cut), raw.subarray(cut)]);
      assert.deepEqual(result.forwarded, expected.forwarded, `${final}: cut=${cut}`);
      assert.deepEqual(result.kinds.filter((kind) => kind !== 'forward'), [], `${final}: cut=${cut}`);
    }
    const r = new InputRouter({ focus: 'game' });
    routed(r, [raw]);
    assert.deepEqual(kinds(r, b('j')), ['game']);
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
