import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Supervisor } from '../../src/app/supervisor.ts';
import {
  SUPERVISION_VERSION,
  validSupervisorMessage,
  validWorkerMessage,
  mergeRestoreOptions,
  scrubInternalEnv,
  type SupervisorLeaseMessage,
  type WorkerLeaseMessage,
} from '../../src/shell/supervision.ts';

const TOKEN = 'test-token';

class FakeChild extends EventEmitter {
  connected = true;
  sent: SupervisorLeaseMessage[] = [];
  killed: NodeJS.Signals[] = [];
  sendError: Error | null = null;

  send(message: SupervisorLeaseMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(this.sendError);
    return this.sendError === null;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal);
    return true;
  }
}

function worker(type: WorkerLeaseMessage['type'], seq: number): WorkerLeaseMessage {
  if (type === 'takeover') {
    return { moyu: SUPERVISION_VERSION, token: TOKEN, type, seq,
      options: { homeRow: 9 }, rawBaseline: false };
  }
  if (type === 'update' || type === 'restored') {
    return { moyu: SUPERVISION_VERSION, token: TOKEN, type, seq,
      options: { homeRow: 10, deleteImage: true } };
  }
  return { moyu: SUPERVISION_VERSION, token: TOKEN, type, seq };
}

function install(child: FakeChild, fd = 1): void {
  new Supervisor(child as unknown as ChildProcess, TOKEN, fd, () => {}, false).install();
}

function fixture(): { child: FakeChild; fd: number; output: string; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-supervision-'));
  const output = path.join(dir, 'recovery.bin');
  const fd = fs.openSync(output, 'w');
  return { child: new FakeChild(), fd, output, close: () => {
    fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true });
  } };
}

test('supervision validates exact authenticated protocol shapes', () => {
  assert.equal(validWorkerMessage(worker('takeover', 1), TOKEN), true);
  assert.equal(validWorkerMessage({ ...worker('takeover', 1), extra: true }, TOKEN), false);
  assert.equal(validWorkerMessage({ ...worker('takeover', 1), token: 'wrong' }, TOKEN), false);
  assert.equal(validWorkerMessage({ ...worker('update', 2), seq: 0 }, TOKEN), false);
  assert.equal(validWorkerMessage({ ...worker('restored', 2), options: undefined }, TOKEN), false);
  assert.equal(validWorkerMessage(worker('complete', 3), TOKEN), true);
  assert.equal(validSupervisorMessage({ moyu: SUPERVISION_VERSION, token: TOKEN,
    type: 'ack', seq: 2 }, TOKEN), true);
  assert.equal(validSupervisorMessage({ moyu: SUPERVISION_VERSION, token: TOKEN,
    type: 'terminate', signal: 'SIGKILL' }, TOKEN), false);
});

test('restore updates preserve irreversible ownership and scrub private authority', () => {
  assert.deepEqual(mergeRestoreOptions(
    { deleteImage: true, kittyHardReset: true, kittyPops: 1 },
    { deleteImage: false, kittyHardReset: false, kittyPops: 2 },
  ), { deleteImage: true, kittyHardReset: true, kittyPops: 2 });
  const clean = scrubInternalEnv({
    PATH: '/bin', MOYU_EVENTS: '/events', MOYU_SHELL: '1',
    MOYU_INTERNAL_SUPERVISION_TOKEN: 'secret', MOYU_INTERNAL_FUTURE: 'secret',
    MOYU_TAKEOVER_FLAG: '/tmp/old', NODE_CHANNEL_FD: '4', NODE_CHANNEL_SERIALIZATION_MODE: 'json',
  });
  assert.deepEqual(clean, { PATH: '/bin', MOYU_EVENTS: '/events', MOYU_SHELL: '1' });
});

test('supervisor ACKs only contiguous valid transitions and authenticated completion', () => {
  const child = new FakeChild();
  install(child);
  child.emit('message', worker('takeover', 1));
  child.emit('message', worker('update', 2));
  child.emit('message', worker('restored', 3));
  child.emit('message', worker('complete', 4));
  child.emit('disconnect');
  assert.deepEqual(child.sent.map((message) => [message.type, message.seq]), [
    ['ack', 1], ['ack', 2], ['ack', 3], ['ack', 4],
  ]);
  assert.deepEqual(child.killed, []);
});

test('supervisor accepts idle authenticated completion without killing clean worker', () => {
  const child = new FakeChild();
  install(child);
  child.emit('message', worker('complete', 1));
  child.emit('disconnect');
  assert.deepEqual(child.sent.map((message) => [message.type, message.seq]), [['ack', 1]]);
  assert.deepEqual(child.killed, []);
});

test('supervisor kills malformed, stale, or gapped workers', () => {
  for (const message of [worker('update', 1), worker('takeover', 2),
    { ...worker('takeover', 1), token: 'wrong' }]) {
    const child = new FakeChild();
    install(child);
    child.emit('message', message);
    assert.deepEqual(child.killed, ['SIGKILL']);
  }
});

test('protocol failure never restores until the killed worker is quiescent', () => {
  const f = fixture();
  try {
    install(f.child, f.fd);
    f.child.emit('message', worker('takeover', 1));
    f.child.emit('message', worker('update', 3));
    assert.deepEqual(f.child.killed, ['SIGKILL']);
    assert.equal(fs.readFileSync(f.output).length, 0,
      '发出 SIGKILL 不代表 worker 已停，不能抢先还原');
    f.child.emit('exit', null, 'SIGKILL');
    assert.ok(fs.readFileSync(f.output).length > 0,
      'worker 静止以后才能写最后一段还原');
  } finally { f.close(); }
});

test('restored receipt remains committed when its ACK cannot be delivered', () => {
  const f = fixture();
  try {
    install(f.child, f.fd);
    f.child.emit('message', worker('takeover', 1));
    f.child.sendError = new Error('channel closed');
    f.child.emit('message', worker('restored', 2));
    const committed = fs.readFileSync(f.output).length;
    f.child.emit('disconnect');
    assert.deepEqual(f.child.killed, ['SIGKILL']);
    assert.equal(fs.readFileSync(f.output).length, committed,
      'ACK 丢失与断线不能再写第二遍');
  } finally { f.close(); }
});

test('authenticated channel loss fails closed and restores only an active lease', () => {
  const idle = fixture();
  try {
    install(idle.child, idle.fd);
    idle.child.emit('disconnect');
    assert.deepEqual(idle.child.killed, ['SIGKILL']);
    assert.equal(fs.readFileSync(idle.output).length, 0);
  } finally { idle.close(); }

  const taken = fixture();
  try {
    install(taken.child, taken.fd);
    taken.child.emit('message', worker('takeover', 1));
    taken.child.emit('disconnect');
    assert.deepEqual(taken.child.killed, ['SIGKILL']);
    assert.equal(fs.readFileSync(taken.output).length, 0,
      'worker 仍可能输出，必须等 exit/close 后再由 supervisor 写最后一段还原字节');
    taken.child.emit('exit', null, 'SIGKILL');
    assert.ok(fs.readFileSync(taken.output).length > 0,
      'worker 静止后 taken lease 必须由 supervisor 还原');
  } finally { taken.close(); }
});
