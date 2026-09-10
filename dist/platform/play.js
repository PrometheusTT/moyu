import { BrailleTarget } from "../render/braille.js";
import { fitRow } from "../render/text.js";
import { Teardown } from "../shell/teardown.js";
import { Arcade } from "./arcade.js";
import { loadGameModules } from "./registry.js";
import { PlaySurface } from "./surface.js";
function oneLine(value) { return value.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim() || '未知错误'; }
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
    const teardown = new Teardown(() => ({}));
    let expanded = true;
    const rows = () => expanded ? Math.min(6, Math.max(2, (process.stdout.rows ?? 24) - 2)) : 2;
    const target = new BrailleTarget(Math.min(40, Math.max(12, (process.stdout.columns ?? 80) - 1)), rows(), { defaultBackground: true, defaultForeground: 0xecf0f8 });
    const surface = new PlaySurface();
    let done = false, timer = null;
    const layout = () => {
        target.resize(Math.min(40, Math.max(12, (process.stdout.columns ?? 80) - 1)), rows());
        arcade.setDisplay(rows(), 'braille');
        target.invalidate();
        process.stdout.write('\x1b[2J');
    };
    return new Promise((resolve) => {
        const finish = () => {
            if (done)
                return;
            done = true;
            if (timer !== null)
                clearInterval(timer);
            teardown.run();
            resolve(0);
        };
        teardown.install();
        teardown.onRestore(() => { if (timer !== null)
            clearInterval(timer); });
        teardown.onRestore(() => { try {
            process.stdin.setRawMode(false);
        }
        catch { /* terminal disappeared */ } });
        process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?7l\x1b[?25l');
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (b) => {
            const f12 = b.length === 5 && b.toString('latin1') === '\x1b[24~';
            const oneKeyClose = b.length === 1 && (b[0] === 0x1d || b[0] === 0x1b);
            if (b.includes(0x03) || f12 || oneKeyClose || arcade.feed(b))
                finish();
            else if (arcade.takeViewToggle()) {
                expanded = !expanded;
                layout();
            }
        });
        process.stdout.on('resize', layout);
        timer = setInterval(() => {
            if (done)
                return;
            arcade.setDisplay(rows(), 'braille');
            arcade.advance(Date.now());
            const h = arcade.hud();
            const row = `\x1b[1;1H\x1b[38;2;196;202;218m\x1b[48;2;24;26;36m${fitRow(h.left, h.right, target.cols)}\x1b[0m`;
            process.stdout.write(row + surface.render(arcade, target, 2, process.stdout.columns ?? 80, rows()));
        }, 1000 / 30);
        timer.unref();
    });
}
