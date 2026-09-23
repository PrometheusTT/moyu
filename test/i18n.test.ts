import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveGameLanguage, englishBattleNotice, artName, formName, chapterName } from '../src/i18n.ts';
import { parseLanguageArgs } from '../src/app/main.ts';
import { Arcade } from '../src/platform/arcade.ts';
import { ART_IDS, SWORD_FORMS } from '../src/core/martial.ts';

test('game language follows locale and permits an explicit override', () => {
  assert.equal(resolveGameLanguage({ LANG: 'zh_CN.UTF-8' }, 'en-US'), 'zh');
  assert.equal(resolveGameLanguage({ LANG: 'en_US.UTF-8' }, 'zh-CN'), 'en');
  assert.equal(resolveGameLanguage({ LANG: 'C.UTF-8' }, 'zh-CN'), 'zh');
  assert.equal(resolveGameLanguage({ MOYU_LANG: 'en', LANG: 'zh_CN.UTF-8' }, 'zh-CN'), 'en');
  assert.equal(resolveGameLanguage({ MOYU_LANG: 'zh', LANG: 'en_US.UTF-8' }, 'en-US'), 'zh');
});

test('--lang selects a run without consuming wrapped CLI arguments', () => {
  assert.deepEqual(parseLanguageArgs(['--lang', 'en', 'play', 'stick-slash']),
    { argv: ['play', 'stick-slash'], language: 'en' });
  assert.deepEqual(parseLanguageArgs(['play', 'stick-slash', '--lang=zh']),
    { argv: ['play', 'stick-slash'], language: 'zh' });
  assert.deepEqual(parseLanguageArgs(['--lang', 'en', '--', 'codex', '--lang', 'zh']),
    { argv: ['--', 'codex', '--lang', 'zh'], language: 'en' });
  assert.deepEqual(parseLanguageArgs(['--', 'codex', '--lang', 'zh']),
    { argv: ['--', 'codex', '--lang', 'zh'] });
  assert.match(parseLanguageArgs(['--lang', 'fr', 'play']).error ?? '', /en or zh/);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = path.join(root, 'bin', 'moyu.mjs');
  const help = spawnSync(process.execPath, [entry, '--lang', 'en', '--help'], {
    cwd: root, env: { ...process.env, MOYU_LANG: 'zh' }, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Moyu —/);
  const script = 'process.stdout.write(JSON.stringify({ language: process.env.MOYU_LANG, args: process.argv.slice(1) }))';
  const wrapped = spawnSync(process.execPath, [entry, '--lang=zh', '--', process.execPath,
    '-e', script, '--', '--lang', 'en'], { cwd: root, env: { ...process.env, MOYU_LANG: 'en' }, encoding: 'utf8' });
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.deepEqual(JSON.parse(wrapped.stdout), { language: 'zh', args: ['--lang', 'en'] });
});

test('English sword-art names use the selected public translations', () => {
  const old = process.env.MOYU_LANG;
  process.env.MOYU_LANG = 'en';
  try {
    assert.deepEqual(ART_IDS.map(art => artName(art)), [
      'Dugu Nine Swords', 'Six Meridian Divine Sword', 'Taiji Sword', 'Heavenly Flying Fairy',
      'Myriad Swords Return to the Source', 'Getsuga Tenshō', 'Sun Breathing',
    ]);
  } finally {
    if (old === undefined) delete process.env.MOYU_LANG; else process.env.MOYU_LANG = old;
  }
});

test('English built-in game HUD, help, chapter and sword names contain no Chinese', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moyu-en-'));
  const oldLang = process.env.MOYU_LANG, oldHome = process.env.MOYU_HOME;
  process.env.MOYU_LANG = 'en'; process.env.MOYU_HOME = home;
  try {
    const noChinese = (text: string): void => assert.doesNotMatch(text, /[\u3400-\u9fff]/);
    for (const id of ['stick-slash', 'snake', 'blocks']) {
      const arcade = new Arcade(undefined, undefined, id);
      arcade.setDisplay(6, 'braille');
      noChinese(arcade.name);
      noChinese(arcade.hud().left);
      noChinese(arcade.panel().join('\n'));
      arcade.enter();
      noChinese(arcade.panel().join('\n'));
      noChinese(arcade.panelRows(80, 6).join('\n'));
      arcade.feed(Buffer.from('?'));
      noChinese(arcade.panel().join('\n'));
    }
    for (const art of ART_IDS) {
      noChinese(artName(art));
      for (let i = 0; i < SWORD_FORMS[art].length; i++) noChinese(formName(art, i));
    }
    noChinese(chapterName(3, '山门妖踪'));
    for (const notice of ['护体罡气 · 霸体', '剑气不足 8/10', '九剑未悟 · 阅历3/12',
      '悟得秘技！独孤九剑 · 总诀式', '剑宗临阵 · 青锋']) noChinese(englishBattleNotice(notice));
  } finally {
    if (oldLang === undefined) delete process.env.MOYU_LANG; else process.env.MOYU_LANG = oldLang;
    if (oldHome === undefined) delete process.env.MOYU_HOME; else process.env.MOYU_HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
