export const SUPERVISION_VERSION = 1;
export const SUPERVISION_TOKEN_ENV = 'MOYU_INTERNAL_SUPERVISION_TOKEN';
const ACK_TIMEOUT_MS = 2_000;
const LOCAL_RECOVERY_DELAY_MS = 100;
// Windows has no SIGQUIT delivery. Keep the signal listeners limited to names
// that Node can receive there while retaining the POSIX cleanup behavior.
export const SUPERVISED_SIGNALS = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
function object(value) {
    return typeof value === 'object' && value !== null ? value : null;
}
export function validRestoreOptions(value) {
    const o = object(value);
    if (o === null)
        return false;
    const allowed = new Set(['homeRow', 'kittyPops', 'kittyHardReset', 'deleteImage']);
    if (Object.keys(o).some((key) => !allowed.has(key)))
        return false;
    if (o.homeRow !== undefined && (!Number.isSafeInteger(o.homeRow) || o.homeRow < 1))
        return false;
    if (o.kittyPops !== undefined && (!Number.isSafeInteger(o.kittyPops)
        || o.kittyPops < 0 || o.kittyPops > 64))
        return false;
    if (o.kittyHardReset !== undefined && typeof o.kittyHardReset !== 'boolean')
        return false;
    if (o.deleteImage !== undefined && typeof o.deleteImage !== 'boolean')
        return false;
    return true;
}
export function validWorkerMessage(value, token) {
    const o = object(value);
    if (o === null || o.moyu !== SUPERVISION_VERSION || o.token !== token
        || !Number.isSafeInteger(o.seq) || o.seq < 1)
        return false;
    if (o.type === 'takeover') {
        return Object.keys(o).every((key) => ['moyu', 'token', 'type', 'seq', 'options', 'rawBaseline'].includes(key))
            && validRestoreOptions(o.options) && typeof o.rawBaseline === 'boolean';
    }
    if (o.type === 'update' || o.type === 'restored') {
        return Object.keys(o).every((key) => ['moyu', 'token', 'type', 'seq', 'options'].includes(key))
            && validRestoreOptions(o.options);
    }
    return o.type === 'complete'
        && Object.keys(o).every((key) => ['moyu', 'token', 'type', 'seq'].includes(key));
}
export function validSupervisorMessage(value, token) {
    const o = object(value);
    if (o === null || o.moyu !== SUPERVISION_VERSION || o.token !== token)
        return false;
    if (o.type === 'ack') {
        return Object.keys(o).every((key) => ['moyu', 'token', 'type', 'seq'].includes(key))
            && Number.isSafeInteger(o.seq) && o.seq >= 1;
    }
    return o.type === 'terminate'
        && Object.keys(o).every((key) => ['moyu', 'token', 'type', 'signal'].includes(key))
        && typeof o.signal === 'string' && SUPERVISED_SIGNALS.includes(o.signal);
}
export function mergeRestoreOptions(previous, next) {
    const out = { ...previous, ...next };
    if (previous.deleteImage === true)
        out.deleteImage = true;
    if (previous.kittyHardReset === true)
        out.kittyHardReset = true;
    return out;
}
export function scrubInternalEnv(env = process.env) {
    const clean = { ...env };
    for (const key of Object.keys(clean)) {
        if (key.startsWith('MOYU_INTERNAL_') || key === 'NODE_CHANNEL_FD' || key === 'NODE_CHANNEL_SERIALIZATION_MODE'
            || key === 'MOYU_TAKEOVER_FLAG')
            delete clean[key];
    }
    return clean;
}
class WorkerTerminalLease {
    supervised;
    phase = 'idle';
    seq = 0;
    options = {};
    pending = null;
    queue = Promise.resolve();
    failed = null;
    channelLossRecovery = null;
    channelLossBarrier = null;
    recoveryTimer = null;
    token;
    supervisorPid;
    constructor() {
        this.supervisorPid = process.ppid;
        const claimed = process.env[SUPERVISION_TOKEN_ENV];
        delete process.env[SUPERVISION_TOKEN_ENV];
        delete process.env.NODE_CHANNEL_FD;
        delete process.env.NODE_CHANNEL_SERIALIZATION_MODE;
        this.token = claimed === undefined || claimed === '' ? null : claimed;
        this.supervised = this.token !== null;
        if (this.supervised && (typeof process.send !== 'function' || !process.connected)) {
            this.failed = new Error('moyu: supervision metadata exists without a live IPC channel');
        }
        process.on('message', (value) => { this.onMessage(value); });
        process.on('disconnect', () => { this.onDisconnect(); });
    }
    acquire(options = {}) {
        return this.enqueue(async () => {
            if (this.phase !== 'idle')
                throw new Error('terminal lease is already active');
            if (!validRestoreOptions(options))
                throw new Error('invalid terminal restore options');
            await this.request('takeover', options, process.stdin.isRaw === true);
            this.options = { ...options };
            this.phase = 'taken';
        });
    }
    update(options) {
        return this.enqueue(async () => {
            if (this.phase !== 'taken')
                throw new Error('terminal lease is not active');
            if (!validRestoreOptions(options))
                throw new Error('invalid terminal restore options');
            const merged = mergeRestoreOptions(this.options, options);
            if (sameOptions(this.options, merged))
                return;
            await this.request('update', merged);
            this.options = merged;
        });
    }
    snapshot(options) {
        return this.enqueue(async () => {
            if (this.phase !== 'taken')
                throw new Error('terminal lease is not active');
            if (!validRestoreOptions(options))
                throw new Error('invalid terminal restore options');
            if (sameOptions(this.options, options))
                return;
            await this.request('update', options);
            this.options = { ...options };
        });
    }
    restoring(options) {
        return this.enqueue(async () => {
            if (this.phase === 'restored' || this.phase === 'idle')
                return;
            if (this.phase !== 'taken')
                throw new Error('terminal lease is not active');
            if (!validRestoreOptions(options))
                throw new Error('invalid terminal restore options');
            await this.request('restored', options);
            this.options = { ...options };
            this.phase = 'restored';
        });
    }
    complete() {
        return this.enqueue(async () => {
            if (this.phase === 'taken')
                throw new Error('terminal lease is still active');
            if (this.phase === 'completed')
                return;
            await this.request('complete');
            this.phase = 'completed';
            this.channelLossRecovery = null;
            if (this.recoveryTimer !== null)
                clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
            this.disconnect();
        });
    }
    onChannelLoss(recovery) {
        if (this.channelLossRecovery !== null && this.channelLossRecovery !== recovery) {
            throw new Error('terminal lease already has a recovery owner');
        }
        this.channelLossRecovery = recovery;
        return () => {
            if (this.channelLossRecovery === recovery)
                this.channelLossRecovery = null;
        };
    }
    onDisconnect() {
        if (this.phase === 'completed')
            return;
        const error = new Error('moyu: supervisor channel closed');
        if (!this.supervised || this.phase === 'idle') {
            this.fail(error);
            return;
        }
        const recovery = this.channelLossRecovery;
        if (recovery === null) {
            this.fail(error);
            this.terminateOnChannelLoss();
            return;
        }
        recovery.quiesce();
        this.channelLossBarrier = new Promise((resolve) => {
            const waitForSupervisorExit = () => {
                this.recoveryTimer = setTimeout(() => {
                    this.recoveryTimer = null;
                    if (this.supervisorAlive()) {
                        waitForSupervisorExit();
                        return;
                    }
                    recovery.restore();
                    resolve();
                    this.terminateOnChannelLoss();
                }, LOCAL_RECOVERY_DELAY_MS);
            };
            waitForSupervisorExit();
        });
        this.fail(error);
    }
    supervisorAlive() {
        try {
            process.kill(this.supervisorPid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
    terminateOnChannelLoss() {
        for (const signal of SUPERVISED_SIGNALS)
            process.removeAllListeners(signal);
        try {
            process.kill(process.pid, 'SIGHUP');
        }
        catch {
            process.exit(1);
        }
    }
    disconnect() {
        if (!this.supervised || !process.connected)
            return;
        process.disconnect();
    }
    enqueue(operation) {
        const run = this.queue.then(operation, operation).catch(async (error) => {
            if (this.channelLossBarrier !== null)
                await this.channelLossBarrier;
            throw error;
        });
        this.queue = run.catch(() => { });
        return run;
    }
    async request(type, options, rawBaseline) {
        if (this.failed !== null)
            throw this.failed;
        if (!this.supervised)
            return;
        if (this.pending !== null)
            throw new Error('terminal lease transition already in flight');
        const seq = ++this.seq;
        let message;
        if (type === 'takeover') {
            message = { moyu: SUPERVISION_VERSION, token: this.token, type, seq,
                options: options, rawBaseline: rawBaseline };
        }
        else if (type === 'update' || type === 'restored') {
            message = { moyu: SUPERVISION_VERSION, token: this.token, type, seq, options: options };
        }
        else {
            message = { moyu: SUPERVISION_VERSION, token: this.token, type, seq };
        }
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending = null;
                const error = new Error(`moyu: supervisor did not acknowledge ${type}`);
                this.fail(error);
                reject(error);
            }, ACK_TIMEOUT_MS);
            timer.unref();
            this.pending = { seq, resolve, reject, timer };
            try {
                process.send(message, (error) => {
                    if (error === null || this.pending?.seq !== seq)
                        return;
                    this.pending = null;
                    clearTimeout(timer);
                    this.fail(error);
                    reject(error);
                });
            }
            catch (error) {
                this.pending = null;
                clearTimeout(timer);
                const e = error instanceof Error ? error : new Error(String(error));
                this.fail(e);
                reject(e);
            }
        });
    }
    onMessage(value) {
        if (!this.supervised || !validSupervisorMessage(value, this.token))
            return;
        if (value.type === 'terminate' && value.signal !== undefined) {
            if (process.listenerCount(value.signal) > 0)
                process.emit(value.signal, value.signal);
            else
                process.kill(process.pid, value.signal);
            return;
        }
        const pending = this.pending;
        if (pending === null || value.seq !== pending.seq)
            return;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.resolve();
    }
    fail(error) {
        if (this.failed === null)
            this.failed = error;
        const pending = this.pending;
        if (pending === null)
            return;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.reject(this.failed);
    }
}
function sameOptions(a, b) {
    return a.homeRow === b.homeRow && a.kittyPops === b.kittyPops
        && a.kittyHardReset === b.kittyHardReset && a.deleteImage === b.deleteImage;
}
const terminalLease = new WorkerTerminalLease();
export function leaseTerminal() {
    return terminalLease;
}
/** Finish a supervised worker after its terminal owner, if any, released its lease. */
export function completeSupervision() {
    return terminalLease.complete();
}
