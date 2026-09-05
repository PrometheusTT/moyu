import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 把 `src/` 下每一个模块都 import 一遍。
 *
 * 这是在**没有 tsc** 的情况下唯一能覆盖全部源文件的类型语法检查。Node 的类型剥离是
 * 纯删除、不做代码生成，所以 `enum` / `namespace` / 参数属性 / 装饰器 会在加载时直接
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。而"加载时"意味着：**没被任何测试 import 的文件
 * 永远不会暴露这个错**，只会在真正运行到那条命令的时候炸在用户脸上。
 *
 * 这个坑已经踩到两次（`teardown.ts` 和这个目录下另一个测试文件的参数属性），两次都是
 * 因为文件没人 import。所以这条测试的价值不是"检查语法"，是"保证覆盖到每个文件"。
 *
 * 顺带一个必要条件：`main.ts` 被 import 时**不能**把外壳跑起来。它底部的
 * `import.meta.url === pathToFileURL(process.argv[1])` 守卫就是为此存在的，
 * 在 `node --test` 下 argv[1] 是测试文件，所以 main() 不会执行 —— 这条测试也顺带守住了它。
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const root = new URL('../', import.meta.url).pathname;
const files = walk(join(root, 'src')).sort();

test('src/ 下的每个模块都能被 Node 的类型剥离加载', async () => {
  assert.ok(files.length > 0, '一个源文件都没找到 —— 这条测试自己坏了');
  const broken: string[] = [];
  for (const f of files) {
    try {
      await import(pathToFileURL(f).href);
    } catch (e) {
      broken.push(`${relative(root, f)}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  assert.deepEqual(broken, [], `这些模块加载失败：\n${broken.join('\n')}`);
});

test('没有参数属性（strip-only 模式不支持，但只在加载时才会炸）', () => {
  // 冗余于上面那条，但它给出的错误信息更直接：上面那条只会说"加载失败"，
  // 这条会指着文件名和行号说"这里有个参数属性"。测试文件也一起扫 —— 它们同样是被剥离加载的，
  // 而一个加载不了的测试文件在 node --test 里表现为"整个文件被跳过"，比失败更容易被忽略。
  const bad: string[] = [];
  for (const f of [...files, ...walk(join(root, 'test'))]) {
    // 先把注释抹掉，否则"不要用参数属性"这条注释本身会被当成一个参数属性命中。
    // 抹块注释时把非换行字符换成空格 —— 行号必须保持准确，报错才有用。
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const lines = src.split('\n').map((l) => { const at = l.indexOf('//'); return at < 0 ? l : l.slice(0, at); });
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i]!.indexOf('constructor(');
      if (at < 0) continue;
      // 参数表可能跨行，往后扫到右括号为止。
      let text = lines[i]!.slice(at + 'constructor('.length);
      for (let j = i + 1; j < lines.length && !text.includes(')'); j++) text += lines[j]!;
      const params = text.slice(0, text.indexOf(')'));
      if (/\b(private|public|protected|readonly)\s+\w/.test(params)) {
        bad.push(`${relative(root, f)}:${i + 1}: ${params.trim()}`);
      }
    }
  }
  assert.deepEqual(bad, [], `参数属性要改成显式字段 + 构造函数里赋值：\n${bad.join('\n')}`);
});
