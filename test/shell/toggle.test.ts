import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputRouter } from '../../src/shell/focus.ts';

const enc = new TextEncoder();
const b = (s: string): Uint8Array => enc.encode(s);
const kinds = (r: InputRouter, value: Uint8Array): string[] => r.route(value).map((a) => a.kind);

test('Ctrl+] toggles in legacy and Kitty keyboard protocols', () => {
  const r = new InputRouter();
  assert.deepEqual(kinds(r, Uint8Array.of(0x1d)), ['toggle-focus']);
  assert.deepEqual(kinds(r, b('\x1b[93;5u')), ['toggle-focus']);
  assert.deepEqual(kinds(r, b('\x1b[93;5:2u')), []);
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

test('bracketed paste bypasses every Moyu shortcut', () => {
  const r = new InputRouter({ focus: 'game' });
  const raw = Uint8Array.from([...b('\x1b[200~a'), 0, ...b('\x1b[24~'), 7, ...b('z\x1b[201~')]);
  const actions = r.route(raw);
  assert.ok(actions.every((a) => a.kind === 'forward'));
  const got = Uint8Array.from(actions.flatMap((a) => a.kind === 'forward' ? [...a.bytes] : []));
  assert.deepEqual(got, raw);
});
