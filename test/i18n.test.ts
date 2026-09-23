import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveGameLanguage, englishBattleNotice, artName, formName, chapterName } from '../src/i18n.ts';
import { Arcade } from '../src/platform/arcade.ts';
import { ART_IDS, SWORD_FORMS } from '../src/core/martial.ts';

test('game language follows locale and permits an explicit override', () => {
  assert.equal(resolveGameLanguage({ LANG: 'zh_CN.UTF-8' }, 'en-US'), 'zh');
  assert.equal(resolveGameLanguage({ LANG: 'en_US.UTF-8' }, 'zh-CN'), 'en');
  assert.equal(resolveGameLanguage({ LANG: 'C.UTF-8' }, 'zh-CN'), 'zh');
  assert.equal(resolveGameLanguage({ MOYU_LANG: 'en', LANG: 'zh_CN.UTF-8' }, 'zh-CN'), 'en');
  assert.equal(resolveGameLanguage({ MOYU_LANG: 'zh', LANG: 'en_US.UTF-8' }, 'en-US'), 'zh');
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
