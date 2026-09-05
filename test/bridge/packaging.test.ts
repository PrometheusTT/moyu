/**
 * 分发这一层的守卫。这里每一条都是**只在别人安装之后才会炸**的那类问题 ——
 * 本地开发全都碰不到（源码在手边、路径是真路径、node_modules 是软链），
 * 所以只能靠测试替我们站在陌生人的位置上看一眼。
 *
 * 真实踩到过的那条：`npm i -g` 之后 `$0` 是 `<prefix>/bin/moyu` 这个软链，
 * `bin/moyu` 拿它算包根 → 算成 npm 的 prefix → `dist/app/main.js` 找不到 →
 * **装完的包每条命令都直接报错**。第一条测试就是它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, any>;

/** `PrometheusTT/moyu` —— 从 repository.url 抠出来。所有安装命令都得和它一致，否则装不成。 */
function repoSlug(): string {
  const url = (pkg.repository as { url?: string } | undefined)?.url ?? '';
  const m = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  assert.notEqual(m, null, `repository.url 不像个 GitHub 地址：${url}`);
  return m?.[1] ?? '';
}

test('通过软链调用也能找到包根（npm i -g / npx 就是这么调的）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-pack-'));
  const direct = path.join(dir, 'moyu');                 // 绝对目标
  const relayed = path.join(dir, 'relay');               // 软链指软链（npx 会这样）
  fs.symlinkSync(path.join(root, 'bin/moyu'), direct);
  fs.symlinkSync('moyu', relayed);                        // 相对目标，要相对软链所在目录解析
  for (const entry of [direct, relayed]) {
    const out = execFileSync(entry, ['--help'], { encoding: 'utf8' });
    assert.match(out, /^摸鱼/, `${entry} 找不到包根 —— 装到别人机器上会每条命令都炸`);
  }
});

test('包目录本身在软链下面也要能跑（macOS 的 /tmp 就是 /private/tmp 的软链）', () => {
  // Node 加载模块时解析软链，argv[1] 不解析 —— 入口判断拿两者直接比就会不相等，
  // 于是 main() 根本不跑：什么都不打印、退出码 0。装在 /tmp、/var、或任何
  // 带软链的 prefix 下的包都是这个下场，所以这条单独立一个 case。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-slink-'));
  const alias = path.join(dir, 'pkg');
  fs.symlinkSync(root, alias);
  const out = execFileSync(path.join(alias, 'bin/moyu'), ['--help'], { encoding: 'utf8' });
  assert.match(out, /^摸鱼/, '入口判断被软链骗了 —— 装完的包会静默什么都不做');
});

test('bin 指的文件存在且可执行', () => {
  const bin = path.join(root, pkg.bin.moyu as string);
  assert.ok(fs.existsSync(bin));
  assert.ok((fs.statSync(bin).mode & 0o111) !== 0, '+x 掉了，npm 装完会 EACCES');
  assert.match(fs.readFileSync(bin, 'utf8'), /^#!\/bin\/sh\n/, 'shebang 必须是 /bin/sh');
});

test('files 白名单必须把 bin 和 dist 都带上，且不带 src/vendor/test', () => {
  const files = pkg.files as string[];
  assert.ok(files.some((f) => f.startsWith('bin')), 'bin/ 没进包 = 装了没有命令');
  assert.ok(files.some((f) => f.startsWith('dist')), 'dist/ 没进包 = 装了跑不起来');
  for (const bad of ['src', 'vendor', 'test', 'scripts']) {
    assert.ok(!files.some((f) => f.startsWith(bad)), `${bad}/ 不该进发布包`);
  }
});

test('不许有 postinstall —— 它会在别人机器上跑，而 vendor/ 不在包里', () => {
  assert.equal((pkg.scripts as Record<string, string>).postinstall, undefined);
});

test('PTY 必须是正式依赖，不能是 optional/devDependency', () => {
  assert.equal((pkg.dependencies as Record<string, string>)['@lydell/node-pty'], '1.1.0');
  assert.equal(pkg.optionalDependencies, undefined, 'optional 的依赖装不上时是静默的，PTY 装不上要能看出来');
});

test('发布元数据齐全（少一样 npm 页面上就是一片空白）', () => {
  for (const k of ['name', 'version', 'description', 'license', 'keywords', 'engines', 'os', 'repository', 'homepage']) {
    assert.ok(pkg[k] !== undefined && String(pkg[k]).length > 0, `package.json 缺 ${k}`);
  }
  assert.equal(pkg.private, undefined, 'private: true 会让 npm publish 直接拒绝');
  assert.match(pkg.name as string, /^[a-z0-9-]+$/);
  assert.ok(fs.existsSync(path.join(root, 'LICENSE')), 'license 字段写了 MIT 但没有 LICENSE 文件');
  assert.ok(fs.existsSync(path.join(root, 'README.md')), 'npm 页面就是 README');
});

test('README 必须写到 Codex 那个信任步骤 —— 不做这一步 hook 静默不跑', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /Trust all and continue/);
  assert.match(readme, /moyu install --write/);
  assert.match(readme, /~\/\.codex\/hooks\.json/);
  // 这条 hook 到底往外写什么，是别人愿不愿意装的前提。承诺没了就等于没承诺。
  assert.match(readme, /不写.*错误文本|错误文本/);
});

test('bin/moyu 里的重装提示和 repository 对得上（换仓库名时最容易漏的一处）', () => {
  const sh = fs.readFileSync(path.join(root, 'bin/moyu'), 'utf8');
  const m = /npm i -g (github:[\w.-]+\/[\w.-]+|[a-z0-9@/-]+)/.exec(sh);
  assert.notEqual(m, null, 'bin/moyu 的报错里该告诉人怎么重装');
  assert.equal(m?.[1], `github:${repoSlug()}`, 'dist/ 找不到时给的重装命令必须真能装出这个包');
});

/* ── 从 GitHub 装的那条路 ──────────────────────────────────────────────────
 *
 * 这个包的分发渠道是 `npm i -g github:<slug>`，不是 npm registry。两条路差在**构建时机**：
 * npm 克隆仓库 → 装 devDependencies → 跑 `prepare` → 按 files 白名单打包 → 装。
 * 而 dist/ 是 .gitignore 掉的（编译产物不进版本库），所以 `prepare` 是唯一那次构建。
 * 下面三条各盯着这条链上的一个前提 —— 断一个，装出来就是个只有 bin/ 的空壳，
 * 而失败发生在**别人**机器上，我们看不见。
 */

test('prepare 必须构建 —— 这是 git 安装唯一的构建时机', () => {
  const scripts = pkg.scripts as Record<string, string>;
  assert.ok(scripts.prepare !== undefined, '没有 prepare = 从 GitHub 装出来没有 dist/');
  assert.match(scripts.prepare, /build/, 'prepare 得真的构建，不能只是占位');
  assert.match(scripts.build ?? '', /tsconfig\.build\.json/, 'build 必须走会 emit 的那份 tsconfig');
  // prepack 只在 npm pack / publish 时跑，git 安装根本不走 —— 构建放那儿等于没放。
  assert.doesNotMatch(scripts.prepack ?? '', /run build/, '构建挪回 prepack 会让 GitHub 安装静默变空壳');
});

test('typescript 必须在 devDependencies 里（git 安装时 npm 只给你 devDeps）', () => {
  const dev = pkg.devDependencies as Record<string, string>;
  assert.ok(dev.typescript !== undefined, 'prepare 要跑 tsc，而别人机器上没有全局 typescript');
  assert.ok(dev['@types/node'] !== undefined, '缺 @types/node 的话 tsc 在干净克隆里报一屏错');
});

test('README 给的 GitHub 安装命令必须真能装成这个包', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const slug = repoSlug();
  assert.ok(readme.includes(`github:${slug}`), `README 里没有 npm i -g github:${slug}`);
  assert.match(readme, /Node ≥ 20|Node >= 20/, '装的人第一件要知道的事是 Node 版本');
});

/**
 * 真实踩到过的那条（就在把仓库推上去之前）：`npm i -g git+file://…` 报
 * `sh: tsc: command not found`。原因是 lock 里 `@lydell/node-pty` 被记成了
 * `{"resolved": "vendor/node-pty", "link": true}` —— 开发机离线时期靠软链装的痕迹。
 * 别人的克隆里没有 vendor/（它 .gitignore 了），npm 照着 lock 装就散在半路上，
 * devDependencies 一个都没落地，紧接着 prepare 跑 tsc 就找不到人。
 *
 * 第二条是同一类：lock 里的 resolved 主机名如果是某个镜像，换 registry 的人就得
 * 穿墙去拿那个镜像。锁在 registry.npmjs.org 上才是可移植的 —— npm 的
 * `replaceRegistryHost` 默认值恰好是 `npmjs`，所以用镜像的人会被自动改写回自己的镜像。
 */
test('package-lock 必须能在别人机器上复现（不许有本地软链，不许锁在镜像上）', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { resolved?: string; link?: boolean }>;
  };
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    assert.notEqual(entry.link, true, `${key} 在 lock 里是个本地软链 —— 别人的克隆里没有那个目录`);
    assert.ok(!key.startsWith('vendor'), `lock 里不该出现 ${key}：vendor/ 不进版本库`);
    if (entry.resolved !== undefined) {
      assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//,
        `${key} 锁在了 ${entry.resolved} —— 换个 registry 的人装不到`);
    }
  }
});
