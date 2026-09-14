#!/usr/bin/env node
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as osConstants } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { restoreSeq, writeAllSync, type RestoreOptions } from '../shell/teardown.ts';
import {
  SUPERVISION_TOKEN_ENV,
  SUPERVISION_VERSION,
  SUPERVISED_SIGNALS,
  scrubInternalEnv,
  validWorkerMessage,
  type SupportedSignal,
  type SupervisorLeaseMessage,
  type WorkerLeaseMessage,
} from '../shell/supervision.ts';

type SupervisorPhase = 'idle' | 'taken' | 'restored' | 'completed' | 'recovered';
type WorkerOutcome = Readonly<{ kind: 'code'; code: number } | { kind: 'signal'; signal: NodeJS.Signals }>;
type FinishOutcome = (outcome: WorkerOutcome) => void;

const SIGNAL_GRACE_MS = 2_500;

export class Supervisor {
  private readonly child: ChildProcess;
  private readonly token: string;
  private readonly recoveryFd: number;
  private readonly finishOutcome: FinishOutcome;
  private readonly superviseSignals: boolean;
  private phase: SupervisorPhase = 'idle';
  private seq = 0;
  private options: RestoreOptions = {};
  private rawBaseline = false;
  private recoveryDone = false;
  private protocolFailed = false;
  private outcome: WorkerOutcome | null = null;
  private fallback: NodeJS.Timeout | null = null;
  private finalized = false;
  private childStopRequested = false;

  constructor(child: ChildProcess, token: string, recoveryFd = 1,
    finishOutcome: FinishOutcome = defaultFinishOutcome, superviseSignals = true) {
    this.child = child;
    this.token = token;
    this.recoveryFd = recoveryFd;
    this.finishOutcome = finishOutcome;
    this.superviseSignals = superviseSignals;
  }

  install(): void {
    this.child.on('message', (value: unknown) => { this.onMessage(value); });
    this.child.on('error', () => { this.stopChild(); });
    this.child.on('disconnect', () => { this.onDisconnect(); });
    this.child.on('exit', (code, signal) => {
      this.outcome = signal === null ? { kind: 'code', code: code ?? 1 } : { kind: 'signal', signal };
      this.onChildQuiescent();
    });
    this.child.on('close', (code, signal) => {
      if (this.outcome === null) {
        this.outcome = signal === null ? { kind: 'code', code: code ?? 1 } : { kind: 'signal', signal };
      }
      this.onChildQuiescent();
      this.finalize();
    });
    if (this.superviseSignals) {
      for (const signal of SUPERVISED_SIGNALS) process.on(signal, () => { this.requestTermination(signal); });
    }
  }

  private onMessage(value: unknown): void {
    if (!validWorkerMessage(value, this.token) || value.seq !== this.seq + 1) {
      this.failProtocol();
      return;
    }
    if (!this.accept(value)) {
      this.failProtocol();
      return;
    }
    this.seq = value.seq;
    this.ack(value.seq);
  }

  private accept(message: WorkerLeaseMessage): boolean {
    if (message.type === 'takeover') {
      if (this.phase !== 'idle') return false;
      this.options = { ...message.options };
      this.rawBaseline = message.rawBaseline;
      this.phase = 'taken';
      return true;
    }
    if (message.type === 'update') {
      if (this.phase !== 'taken') return false;
      this.options = { ...message.options };
      return true;
    }
    if (message.type === 'restored') {
      if (this.phase !== 'taken') return false;
      this.options = { ...message.options };
      this.restoreOnce('restored');
      return true;
    }
    if (this.phase === 'taken' || this.phase === 'completed' || this.phase === 'recovered') return false;
    this.phase = 'completed';
    return true;
  }

  private ack(seq: number): void {
    const message: SupervisorLeaseMessage = {
      moyu: SUPERVISION_VERSION,
      token: this.token,
      type: 'ack',
      seq,
    };
    try {
      this.child.send(message, (error) => {
        if (error !== null) this.stopChild();
      });
    } catch {
      this.stopChild();
    }
  }

  private failProtocol(): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    this.stopChild();
  }

  private stopChild(): void {
    if (this.childStopRequested) return;
    this.childStopRequested = true;
    try { this.child.kill('SIGKILL'); } catch { /* child already gone */ }
  }

  private onChildQuiescent(): void {
    if (this.phase === 'taken') this.restoreOnce();
  }

  private onDisconnect(): void {
    if (this.phase === 'completed' || this.outcome !== null || this.finalized) return;
    this.stopChild();
  }

  private restoreOnce(nextPhase: 'restored' | 'recovered' = 'recovered'): void {
    if (this.recoveryDone) return;
    this.recoveryDone = true;
    this.phase = nextPhase;
    writeAllSync(this.recoveryFd, restoreSeq(this.options));
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(this.rawBaseline);
    } catch { /* controlling terminal disappeared */ }
  }

  private requestTermination(signal: SupportedSignal): void {
    if (this.finalized) return;
    if (this.fallback !== null) {
      clearTimeout(this.fallback);
      this.fallback = null;
      try { this.child.kill('SIGKILL'); } catch { /* child already gone */ }
      return;
    }
    const message: SupervisorLeaseMessage = {
      moyu: SUPERVISION_VERSION,
      token: this.token,
      type: 'terminate',
      signal,
    };
    try {
      if (this.child.connected) this.child.send(message, () => {});
      else this.child.kill(signal);
    } catch { /* shared process-group delivery may already have stopped it */ }
    this.fallback = setTimeout(() => {
      this.fallback = null;
      try { this.child.kill('SIGKILL'); } catch { /* child already gone */ }
    }, SIGNAL_GRACE_MS);
    this.fallback.unref();
  }

  private finalize(): void {
    if (this.finalized || this.outcome === null) return;
    this.finalized = true;
    if (this.fallback !== null) clearTimeout(this.fallback);
    this.onChildQuiescent();
    this.finishOutcome(this.outcome);
  }
}

function defaultFinishOutcome(outcome: WorkerOutcome): void {
  if (outcome.kind === 'code') {
    process.exit(outcome.code);
    return;
  }
  for (const signal of SUPERVISED_SIGNALS) process.removeAllListeners(signal);
  try { process.kill(process.pid, outcome.signal); }
  catch {
    const signo = osConstants.signals[outcome.signal];
    process.exit(signo === undefined ? 1 : 128 + signo);
  }
}

export function runSupervisor(worker: string, args: string[]): void {
  const token = randomBytes(32).toString('hex');
  const env = scrubInternalEnv();
  env[SUPERVISION_TOKEN_ENV] = token;
  let child: ChildProcess;
  try {
    child = fork(path.resolve(worker), args, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env,
      execArgv: process.execArgv,
    });
  } catch (error) {
    process.stderr.write(`moyu: ${oneLine(error, 'worker 启动失败')}\n`);
    process.exit(1);
  }
  new Supervisor(child, token).install();
}

function oneLine(value: unknown, fallback: string): string {
  try {
    const detail = value instanceof Error ? value.message : String(value);
    return detail.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim() || fallback;
  } catch { return fallback; }
}

function isEntry(entry: string): boolean {
  const here = fileURLToPath(import.meta.url);
  if (path.resolve(entry) === here) return true;
  try { return fs.realpathSync(entry) === fs.realpathSync(here); } catch { return false; }
}

const entry = process.argv[1];
if (entry !== undefined && isEntry(entry)) {
  const worker = process.argv[2];
  if (worker === undefined) {
    process.stderr.write('moyu: supervisor 缺少 worker 入口\n');
    process.exit(1);
  }
  runSupervisor(worker, process.argv.slice(3));
}
