import { BrailleTarget } from "../render/braille.js";
import { fitRow } from "../render/text.js";
import { Teardown } from "../shell/teardown.js";
import { Arcade } from "./arcade.js";
import { loadGameModules } from "./registry.js";
import { PlaySurface } from "./surface.js";
import { fieldColsFor } from "../shell/regions.js";
function oneLine(value) { return value.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim() || '未知错误'; }
function reported(value) {
    return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : null;
}
export function playGeometry(columns, terminalRows, expanded) {
    const reportedCols = reported(columns), reportedRows = reported(terminalRows);
    // Numeric zero means the PTY has not reported geometry yet; a positive tiny size is real and
    // must wait for resize rather than addressing rows or columns that do not exist.
    const cols = reportedCols ?? 80, physicalRows = reportedRows ?? 24;
    const usable = (reportedCols === null || reportedCols >= 2)
        && (reportedRows === null || reportedRows >= 3);
    const availableRows = Math.max(1, physicalRows - 2);
    return Object.freeze({ cols, rows: Math.min(expanded ? 6 : 2, availableRows),
        targetCols: fieldColsFor(cols), usable });
}
export function preparePlay(modules, id) {
    if (id !== undefined && !modules.some((m) => m.manifest.id === id))
        return { error: `找不到游戏 ${id}` };
    const arcade = new Arcade(undefined, modules, id);
    if (id !== undefined) {
        const failure = arcade.failureFor(id);
        if (failure !== undefined)
            return { error: `游戏 ${id} 启动失败：${oneLine(failure)}` };
    }
    if (arcade.available === 0)
        return { error: '没有可用游戏：请检查已安装 Cartridge' };
    return { arcade };
}
export async function cmdPlay(id) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write('moyu play 需要真终端\n');
        return 2;
    }
    const modules = await loadGameModules();
    const prepared = preparePlay(modules, id);
    if (prepared.error !== undefined) {
        process.stderr.write(`${prepared.error}\n`);
        return 2;
    }
    const arcade = prepared.arcade;
    const wasRaw = process.stdin.isRaw;
    const teardown = new Teardown(() => ({}));
    let expanded = true;
    const geometry = () => playGeometry(process.stdout.columns, process.stdout.rows, expanded);
    let size = geometry();
    const target = new BrailleTarget(size.targetCols, size.rows, { defaultBackground: true, defaultForeground: 0xecf0f8 });
    const surface = new PlaySurface();
    let done = false, timer = null, active = false;
    const layout = () => {
        size = geometry();
        target.resize(size.targetCols, size.rows);
        arcade.setDisplay(size.rows, 'braille');
        target.invalidate();
        if (size.usable) {
            if (!active)
                arcade.resume();
            active = true;
            process.stdout.write('\x1b[2J');
        }
        else {
            active = false;
            arcade.pause();
            process.stdout.write('\x1b[H\x1b[2J\x1b[38;2;120;126;140m终端太小，放大后继续\x1b[0m');
        }
    };
    const finish = async () => {
        if (done)
            return;
        done = true;
        if (timer !== null)
            clearInterval(timer);
        arcade.pause();
        teardown.run();
        try {
            await teardown.released();
        }
        catch { /* 本地同步还原已经完成 */ }
    };
    teardown.install();
    teardown.onRestore(() => { if (timer !== null)
        clearInterval(timer); });
    teardown.onRestore(() => {
        process.stdin.removeAllListeners('data');
        process.stdout.removeListener('resize', layout);
        try {
            process.stdin.setRawMode(wasRaw);
        }
        catch { /* terminal disappeared */ }
        process.stdin.pause();
    });
    await teardown.acquire({});
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?7l\x1b[?25l');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    if (size.usable) {
        active = true;
        arcade.resume();
        arcade.enter();
    }
    else
        layout();
    return new Promise((resolve) => {
        process.stdin.on('data', (b) => {
            const f12 = b.length === 5 && b.toString('latin1') === '\x1b[24~';
            const oneKeyClose = b.length === 1 && (b[0] === 0x1d || b[0] === 0x1b);
            if (b.includes(0x03) || f12 || oneKeyClose || arcade.feed(b)) {
                void finish().finally(() => { resolve(0); });
            }
            else if (arcade.takeViewToggle()) {
                expanded = !expanded;
                layout();
            }
        });
        process.stdout.on('resize', layout);
        timer = setInterval(() => {
            if (done || !active || !size.usable)
                return;
            const now = Date.now();
            arcade.setDisplay(size.rows, 'braille');
            arcade.advance(now);
            const row = `\x1b[1;1H\x1b[38;2;196;202;218m\x1b[48;2;24;26;36m${fitRow(arcade.name, '? 帮助', size.targetCols)}\x1b[0m`;
            process.stdout.write(row + surface.render(arcade, target, 2, size.cols, size.rows));
        }, 1000 / 30);
        timer.unref();
    });
}
