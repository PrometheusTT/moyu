/**
 * 把任务信号 hook 装进 coding CLI 的配置里 —— `moyu install`。
 *
 * ## 为什么两个 CLI 能共用一份代码
 *
 * Codex 0.153+ 的 hooks 是**照 Claude Code 抄的**（它自己的 feature 描述就写着
 * "Enable Claude-style lifecycle hooks"）。落到字节上两边一模一样：
 *
 * ```json
 * { "hooks": { "<事件名>": [ { "hooks": [ { "type": "command", "command": "…",
 *                                          "async": false, "timeout": 5 } ] } ] } }
 * ```
 *
 * 区别只有三处，都参数化掉了：
 *
 *   | | Claude Code | Codex |
 *   |---|---|---|
 *   | 文件 | `~/.claude/settings.json`（那个大 JSON 的一个键）| `~/.codex/hooks.json`（专用文件）|
 *   | 事件 | UserPromptSubmit / Stop / Notification | UserPromptSubmit / Stop |
 *   | 生效 | 立刻 | **要用户在下次启动时点一次 "Trust all and continue"** |
 *
 * Codex 没有 `Notification` 这个事件（它那份是 PreToolUse / PermissionRequest / PostToolUse /
 * Pre|PostCompact / Session{Start,End} / UserPromptSubmit / Subagent{Start,Stop} / Stop / Interrupt）。
 * 语义最接近的是 `PermissionRequest`，但那是条**决策**事件（hook 的输出能左右批不批），
 * 往上挂一个写文件命令是拿正确性换一个横幅，不值得 —— 所以 Codex 只装 start/done。
 *
 * ## 为什么不碰 Codex 的 `notify`
 *
 * `notify` 是 config.toml 里**只有一个槽**的配置项，而它经常已经被别的东西占了
 * （这台机器上就是 Codex Computer Use）。写进去等于把人家的通知踢掉。hooks.json 是可叠加的，
 * 而且是 Codex 自己推荐的表达方式。
 *
 * ## 三条硬规则
 *
 *   1. **合并，不覆盖**：只动 `hooks` 这一个键，用户的 permissions/env/model 原样留着。
 *   2. **可撤销**：每条命令末尾带 `# moyu-signal:<kind>` 归属标记，`--uninstall` 照它精确摘除，
 *      重复安装也照它先摘再装（所以幂等，改了事件文件路径也不会留下两条）。
 *   3. **默认干跑**：`moyu install` 只打印会改什么，`--write` 才真写，写之前留带时间戳的备份。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { eventsPath } from "./signal.js";
/**
 * 命令末尾的归属标记。
 *
 * 用 shell 注释而不是另存一份清单：清单会和真实配置漂移（用户手改了配置我们就不知道了），
 * 而标记跟着命令本体一起存在，`grep` 能看见，卸载时摘的就是它。两个 CLI 都是把命令交给
 * `$SHELL -lc` 跑的（Codex 的 command_runner 也是 `-lc`），所以行尾注释一定安全。
 */
export const MARK = '# moyu-signal:';
/** 只有这段描述可以在卸载时和我们创建的专用 Codex 文件一起删除。 */
export const CODEX_DESCRIPTION = '摸鱼（moyu）—— 把任务开始/结束信号写给终端里的游戏';
/** 每个 CLI 装哪几个事件。键是事件名，值是它对应的信号。 */
const EVENTS = {
    claude: [['UserPromptSubmit', 'start'], ['Stop', 'done'], ['Notification', 'notify']],
    codex: [['UserPromptSubmit', 'start'], ['Stop', 'done']],
};
export const TARGET_NAME = { claude: 'Claude Code', codex: 'Codex' };
/** 配置文件路径。`MOYU_CLAUDE_SETTINGS` / `MOYU_CODEX_HOOKS` 只为测试和非常规安装留口子。 */
export function configPath(target, home = os.homedir()) {
    const env = target === 'claude' ? process.env.MOYU_CLAUDE_SETTINGS : process.env.MOYU_CODEX_HOOKS;
    if (env !== undefined && env !== '')
        return env;
    return target === 'claude'
        ? path.join(home, '.claude', 'settings.json')
        : path.join(home, '.codex', 'hooks.json');
}
/** 把家目录换成 `$HOME`。写进配置的路径会被贴到别处、进截图，不该带真实用户名。 */
export function homeVar(p, home = os.homedir()) {
    return p === home || p.startsWith(`${home}/`) ? `$HOME${p.slice(home.length)}` : p;
}
/** 双引号里的转义。事件文件路径可能带空格，也可能（很少见）带 `"` `$` 反引号。 */
function dq(s) {
    return s.replace(/([\\"$`])/g, '\\$1');
}
/** 放进 shell 双引号里的路径表达式，同时保留家目录 `$HOME` 的变量展开。 */
function shellPath(p, home) {
    if (p === home)
        return '$HOME';
    if (p.startsWith(`${home}/`))
        return `$HOME${dq(p.slice(home.length))}`;
    return dq(p);
}
/**
 * 一条信号命令。**一行 shell，绝不起 node** —— 每次工具调用付 40ms 启动成本是不能接受的。
 *
 * `$(date +%s)` 只是给 `cat` 调试用的；读取端取的是每行**最后**一个字段，所以就算
 * `date` 不在 PATH 上（`env_clear` 之后的极端情况）这行退化成 ` start` 也照样读得对。
 */
export function signalCommand(kind, file, home = os.homedir()) {
    const fallback = shellPath(file, home);
    // 外壳给每个实例传独立的 MOYU_EVENTS；直接运行 hook 时回落到安装路径。
    // fallback 放在参数展开 `${…:-word}` 里面会让文件名中的 `}` 提前闭合，所以分两步赋值。
    return `moyu_events="\${MOYU_EVENTS:-}"; if [ -z "$moyu_events" ]; then moyu_events="${fallback}"; fi; mkdir -p "$(dirname "$moyu_events")" && printf '%s ${kind}\\n' "$(date +%s)" >> "$moyu_events" ${MARK}${kind}`;
}
/** 该装进去的那几组 hook。 */
export function hooksFor(target, file = eventsPath(), home = os.homedir()) {
    const out = {};
    for (const [event, kind] of EVENTS[target]) {
        // 写一行很快；同步执行换来 start/done 的顺序保证，异步 hook 在短任务上可能倒序。
        out[event] = [{ hooks: [{ type: 'command', command: signalCommand(kind, file, home), async: false, timeout: 5 }] }];
    }
    return out;
}
function isObj(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** 猜原文的缩进，好让改完的文件看起来还是用户自己的文件。 */
function indentOf(text) {
    const m = /\n([ \t]+)"/.exec(text);
    const s = m?.[1];
    if (s === undefined)
        return 2;
    return s.startsWith('\t') ? 1 : s.length;
}
/** 摘掉所有带归属标记的 handler，顺手把空掉的组和事件删干净。 */
function stripOurs(hooks) {
    let removed = 0;
    for (const event of Object.keys(hooks)) {
        const groups = hooks[event];
        if (!Array.isArray(groups))
            continue;
        const kept = [];
        for (const g of groups) {
            if (!isObj(g) || !Array.isArray(g.hooks)) {
                kept.push(g);
                continue;
            }
            const hs = g.hooks.filter((h) => !(isObj(h) && typeof h.command === 'string' && h.command.includes(MARK)));
            removed += g.hooks.length - hs.length;
            // 只剩空壳的组要一起删掉 —— 留着 `{"hooks": []}` 会让人以为还装着东西。
            if (hs.length === 0 && g.hooks.length > 0 && Object.keys(g).length === 1)
                continue;
            g.hooks = hs;
            kept.push(g);
        }
        if (kept.length === 0)
            delete hooks[event];
        else
            hooks[event] = kept;
    }
    return removed;
}
export function plan(target, opts = {}) {
    const home = opts.home ?? os.homedir();
    const file = opts.file ?? eventsPath();
    const p = opts.config ?? configPath(target, home);
    const base = { target, path: p, existed: false, action: 'unchanged', removed: 0, added: [], after: null, before: null };
    let before = null;
    try {
        before = fs.readFileSync(p, 'utf8');
    }
    catch (e) {
        if (e.code !== 'ENOENT') {
            return { ...base, action: 'error', error: `读不出 ${p}：${e instanceof Error ? e.message : String(e)}—— 没有改动` };
        }
        before = null;
    }
    const existed = before !== null;
    if (!existed && opts.uninstall === true)
        return { ...base, action: 'unchanged' };
    let root = {};
    if (before !== null) {
        let parsed;
        try {
            parsed = JSON.parse(before);
        }
        catch (e) {
            return { ...base, existed, before, action: 'error',
                error: `${p} 不是合法 JSON（${e instanceof Error ? e.message : String(e)}）—— 可能带了注释。用 moyu install --print 手动并进去` };
        }
        if (!isObj(parsed))
            return { ...base, existed, before, action: 'error', error: `${p} 的顶层不是一个对象` };
        root = parsed;
    }
    const rawHooks = root.hooks;
    if (rawHooks !== undefined && !isObj(rawHooks)) {
        return { ...base, existed, before, action: 'error', error: `${p} 里的 hooks 不是一个对象，不敢动它` };
    }
    const hooks = isObj(rawHooks) ? rawHooks : {};
    // 先摘再装：这一条同时买到幂等（重复安装不留两份）和"改了事件路径能就地更新"。
    const removed = stripOurs(hooks);
    const added = [];
    if (opts.uninstall !== true) {
        for (const [event, group] of Object.entries(hooksFor(target, file, home))) {
            const cur = hooks[event];
            hooks[event] = Array.isArray(cur) ? [...cur, ...group] : [...group];
            added.push(event);
        }
        if (target === 'codex' && !existed && root.description === undefined) {
            // Codex 的 HooksFile 是 deny_unknown_fields 的，顶层只认 description 和 hooks。
            root.description = CODEX_DESCRIPTION;
        }
    }
    if (Object.keys(hooks).length === 0)
        delete root.hooks;
    else
        root.hooks = hooks;
    // 卸载后整个文件只剩我们自己留下的壳（Codex 那个专用文件）→ 删掉，别留垃圾。
    // Claude Code 的 settings.json 是**共用**文件，哪怕空了也只写回 `{}`，绝不删。
    const onlyOurDescription = Object.keys(root).length === 1 && root.description === CODEX_DESCRIPTION;
    if (opts.uninstall === true && target === 'codex' && onlyOurDescription) {
        return { ...base, existed, before, action: existed ? 'remove' : 'unchanged', removed, after: null };
    }
    const after = `${JSON.stringify(root, null, before === null ? 2 : indentOf(before))}\n`;
    if (before !== null && after === before)
        return { ...base, existed, before, action: 'unchanged', removed, added, after };
    return { ...base, existed, before, action: existed ? 'update' : 'create', removed, added, after };
}
/** 写盘。返回备份路径（没备份就是 `null`）。 */
export function apply(p, now = new Date()) {
    if (p.action === 'unchanged' || p.action === 'error')
        return null;
    // plan/apply 之间可能有人改了配置；静默覆盖新内容比让用户重跑一次更糟。
    let current = null;
    try {
        current = fs.readFileSync(p.path, 'utf8');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    if (current !== p.before)
        throw new Error(`${p.path} 在干跑之后被别的程序改过了，请重新运行 moyu install`);
    let backup = null;
    if (p.existed && p.before !== null) {
        const t = now.toISOString().replace(/\D/g, '');
        const base = `${p.path}.moyu-bak-${t}`;
        for (let n = 0;; n++) {
            backup = n === 0 ? base : `${base}-${n}`;
            try {
                fs.writeFileSync(backup, p.before, { flag: 'wx', mode: 0o600 });
                break;
            }
            catch (e) {
                if (e.code !== 'EEXIST')
                    throw e;
            }
        }
    }
    if (p.action === 'remove' || p.after === null) {
        fs.rmSync(p.path, { force: true });
        return backup;
    }
    fs.mkdirSync(path.dirname(p.path), { recursive: true });
    // 配置常被软链到 dotfiles 仓库。rename 到软链路径会把链接本身换掉，所以落盘目标必须是实文件。
    const dest = p.existed ? fs.realpathSync(p.path) : p.path;
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.moyu-tmp-${process.pid}-${now.getTime()}`);
    let fd = -1;
    try {
        const mode = p.existed ? fs.statSync(dest).mode & 0o777 : 0o600;
        fd = fs.openSync(tmp, 'wx', mode);
        fs.writeFileSync(fd, p.after);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = -1;
        fs.renameSync(tmp, dest);
    }
    catch (e) {
        if (fd >= 0) {
            try {
                fs.closeSync(fd);
            }
            catch { /* best effort */ }
        }
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch { /* best effort */ }
        throw e;
    }
    return backup;
}
/** 已经装了什么。`stale` = 装着的命令和现在该写的不一样（多半是事件文件路径变了）。 */
export function status(target, opts = {}) {
    const home = opts.home ?? os.homedir();
    const file = opts.file ?? eventsPath();
    const p = opts.config ?? configPath(target, home);
    let text;
    try {
        text = fs.readFileSync(p, 'utf8');
    }
    catch {
        return { path: p, events: [], stale: false, broken: null };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (e) {
        return { path: p, events: [], stale: false, broken: e instanceof Error ? e.message : String(e) };
    }
    const hooks = isObj(parsed) && isObj(parsed.hooks) ? parsed.hooks : {};
    const want = hooksFor(target, file, home);
    const events = [];
    let stale = false;
    for (const [event, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups))
            continue;
        for (const g of groups) {
            if (!isObj(g) || !Array.isArray(g.hooks))
                continue;
            for (const h of g.hooks) {
                if (!isObj(h) || typeof h.command !== 'string' || !h.command.includes(MARK))
                    continue;
                events.push(event);
                if (h.command !== want[event]?.[0]?.hooks[0]?.command)
                    stale = true;
            }
        }
    }
    return { path: p, events, stale, broken: null };
}
/**
 * `moyu install --print` / `moyu hook` 打印的手动版片段。
 *
 * `--write` 能自动合并之后这条还留着，因为它是**唯一在任何情况下都能用**的路径：
 * 配置带注释（JSONC）我们就不敢解析、企业机器上配置是只读的、或者用户单纯不愿意
 * 让别的程序改自己的 settings.json —— 那时候他需要的是一段能贴的字。
 */
export function hookSnippet(file = eventsPath(), target = 'claude', home = os.homedir()) {
    const shown = homeVar(file, home);
    const cfg = { hooks: hooksFor(target, file, home) };
    const where = homeVar(configPath(target, home), home);
    const head = target === 'claude'
        ? `# Claude Code：把下面这段并进 ${where} 的顶层（已有 hooks 就并进 hooks 里）：`
        : `# Codex：把下面这段存成 ${where}（已有就并进 hooks 里）：`;
    if (target === 'codex')
        cfg.description = CODEX_DESCRIPTION;
    const tail = target === 'codex'
        ? ['# 存好之后下次启动 codex 会问 "Hooks need review" —— 选 "Trust all and continue"，不然 hook 不会跑。']
        : [];
    return [
        head,
        JSON.stringify(target === 'codex' ? { description: cfg.description, hooks: cfg.hooks } : cfg, null, 2),
        '',
        `# 事件文件：${shown}`,
        ...tail,
        '# 不装 hook 也能玩：游戏里按 t（任务完成）/ y（下一个任务开始）手动喂信号。',
    ].join('\n');
}
/** 这个 CLI 在这台机器上装了没有 —— 决定 `moyu install` 默认动谁。 */
export function detected(target, home = os.homedir()) {
    const dir = path.join(home, target === 'claude' ? '.claude' : '.codex');
    if (fs.existsSync(dir))
        return true;
    const paths = (process.env.PATH ?? '').split(path.delimiter);
    const exe = target === 'claude' ? 'claude' : 'codex';
    return paths.some((d) => d !== '' && fs.existsSync(path.join(d, exe)));
}
/** 每个 CLI 装哪几个事件、各自对应哪个信号（给 `moyu install` 的输出用）。 */
export function eventSignals(target) {
    return EVENTS[target];
}
