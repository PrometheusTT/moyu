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
import { execFileSync, spawnSync } from 'node:child_process';
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

test('终端接管标记用 mktemp 原子创建，不用可预测的 $$ 路径', () => {
  const sh = fs.readFileSync(path.join(root, 'bin/moyu'), 'utf8');
  assert.match(sh, /mktemp/);
  assert.doesNotMatch(sh, /moyu-takeover\.\$\$/);
});

test('无 TTY 退化路径保留真实信号退出码', () => {
  const { status } = spawnSync(path.join(root, 'bin/moyu'), [
    '--', process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')",
  ], { encoding: 'utf8' });
  assert.equal(status, 143, 'SIGTERM 应映射成 128+15，而不是把所有信号都写死成 129');
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
 * 分发渠道是 `npm i -g github:<slug>`，不是 npm registry。而这条路上有个 npm 自己的坑
 * （10.9.2 实测，一路查到它的 debug log）：npm 派子进程去"准备"那个克隆时，子进程从环境里
 * 继承了 `global=true` / `prefix`，于是它把克隆当成**全局装的根包**处理 —— 不在克隆里装
 * devDependencies，就直接跑 `prepare`。于是 `tsc: command not found`，安装整个失败。
 *
 * 讽刺的是**非全局**的 `npm i git+…` 一切正常，所以这个坑本地怎么试都试不出来，
 * 只在别人 `-g` 装的时候炸。结论只能是：**安装路径上一个构建步骤都不能有**，
 * 编译产物直接进版本库。下面三条盯着这个结论的三个前提。
 */

test('脚本名一个都不许落在 pacote 的「要准备」名单上（这是 -g 装得成的唯一条件）', () => {
  const scripts = pkg.scripts as Record<string, string>;
  // 名单抄自 pacote/lib/git.js 的 #prepareDir：命中任意一个，npm 拉 git 依赖时就会先派一个
  // 子进程去「准备」那个克隆。而那个子进程继承了 global=true，会把克隆当全局装的根包处理：
  // 先前是不装 devDependencies 就跑 prepare（tsc: command not found），删掉 prepare 之后
  // 变成把 _cacache/tmp 里的克隆**软链**进全局 node_modules，装完克隆就被删 —— 死软链。
  // 注意 build **不是** npm 的生命周期钩子，它只是被写进了那张名单，所以 `npm run build`
  // 这个再普通不过的名字会静默毁掉整条安装渠道。构建脚本因此叫 compile。
  for (const name of ['postinstall', 'build', 'preinstall', 'install', 'prepack', 'prepare']) {
    assert.equal(scripts[name], undefined,
      `scripts.${name} 一存在，npm i -g github:… 就装出一条死软链（pacote/lib/git.js #prepareDir）`);
  }
  // 发布前的那次构建挪到 prepublishOnly：它不在名单上，只有 npm publish 会跑它。
  assert.match(scripts.prepublishOnly ?? '', /compile/, '发布前得重新编一遍，否则可能发出旧 dist');
  assert.match(scripts.compile ?? '', /tsconfig\.build\.json/, 'compile 必须走会 emit 的那份 tsconfig');
});

test('dist/ 必须真的在版本库里（装的人拿到的就是它，没有第二次机会）', () => {
  assert.ok(fs.existsSync(path.join(root, 'dist', 'app', 'main.js')), 'dist/app/main.js 不在，bin/moyu 会直接报错退出');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.doesNotMatch(gitignore, /^\s*\/?dist\/?\s*$/m, '把 dist/ 加回 .gitignore = 从 GitHub 装出来是个空壳');
  if (!fs.existsSync(path.join(root, '.git'))) return; // 从 tarball 跑测试时没有 .git
  const tracked = execFileSync('git', ['ls-files', 'dist'], { cwd: root, encoding: 'utf8' }).trim();
  assert.ok(tracked.length > 0, 'dist/ 在本地但没提交 —— 克隆的人拿不到');
});

/**
 * 编译产物进了版本库就多一个失败模式：改了 src 忘了重编，装的人跑的是旧代码。
 * 所以这里重新编一遍到临时目录，和 dist/ 逐字节比。红了就 `npm run build` 再提交。
 */
test('dist/ 必须和 src/ 同步（漂移是编译产物进版本库带来的新失败模式）', (t) => {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) { t.skip('没装 typescript，跳过漂移检查'); return; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-dist-'));
  try {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', out], { cwd: root, stdio: 'pipe' });
    const walk = (dir: string, base = ''): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : e.name.endsWith('.js') ? [`${base}${e.name}`] : []);
    const fresh = walk(out).sort();
    assert.deepEqual(walk(path.join(root, 'dist')).sort(), fresh, 'dist/ 的文件清单和现在编出来的不一样 —— 跑 npm run compile');
    for (const rel of fresh) {
      assert.equal(fs.readFileSync(path.join(root, 'dist', rel), 'utf8'), fs.readFileSync(path.join(out, rel), 'utf8'),
        `dist/${rel} 和 src/ 不同步 —— 跑 npm run compile 再提交`);
    }
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('typescript 必须在 devDependencies 里（构建和上面那条漂移检查都要用）', () => {
  const dev = pkg.devDependencies as Record<string, string>;
  assert.ok(dev.typescript !== undefined, '干净克隆里 npm run build 得有 tsc，别人机器上没有全局的');
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
