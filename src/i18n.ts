import { SWORD_ARTS, SWORD_FORMS, FULL_ART_NAMES, ART_IDS, type SwordArt } from './core/martial.ts';

export type GameLanguage = 'zh' | 'en';
const SYSTEM_LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

export function resolveGameLanguage(env: NodeJS.ProcessEnv = process.env,
  systemLocale?: string): GameLanguage {
  const locale = [env.MOYU_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]
    .find(value => value && !/^(?:C|POSIX)(?:\.|$)/i.test(value)) ?? systemLocale ?? SYSTEM_LOCALE;
  return /^zh(?:[_-]|$)/i.test(locale) ? 'zh' : 'en';
}

export const isEnglish = (): boolean => resolveGameLanguage() === 'en';

const ART_EN: Record<SwordArt, [string, string, string]> = {
  dugu: ['Dugu Nine Swords', 'Dugu Nine', 'Nine Swords United'],
  liumai: ['Six Meridian Divine Sword', 'Six Meridian', 'Six Meridians Unleashed'],
  taiji: ['Taiji Sword', 'Taiji', 'Infinite Taiji'],
  feixian: ['Heavenly Flying Fairy', 'Flying Fairy', 'Sunder the Heavens'],
  wanjian: ['Myriad Swords Return to the Source', 'Myriad Swords', 'Myriad Swords Return'],
  getsuga: ['Getsuga Tenshō', 'Getsuga', 'Final Getsuga'],
  hinokami: ['Sun Breathing', 'Sun', 'Sunfire Dance'],
};

const FORM_EN: Record<SwordArt, readonly string[]> = {
  dugu: ['Opening Form', 'Sword Breaker', 'Blade Breaker', 'Spear Breaker', 'Whip Breaker',
    'Rope Breaker', 'Palm Breaker', 'Arrow Breaker', 'Qi Breaker'],
  liumai: ['Shaoshang', 'Shangyang', 'Zhongchong', 'Guanchong', 'Shaochong', 'Shaoze'],
  taiji: ['Gathering Flow', 'White Crane', 'Breeze and Moon', 'Drifting Snow', 'Sea Dragon',
    'Yin and Yang', 'Cloud Peaks', 'Twin Principles', 'Taiji Origin'],
  feixian: ['Cloud Step', 'Sunset Glow', 'Swallow Turn', 'Startled Swan', 'White Rainbow',
    'Falling Wing', 'Heavenly Flight', 'Inverted Stars', 'Sunder the Heavens'],
  wanjian: ['Sword Array', 'Guarding Swords', 'Three Paths', 'Hundred Swords', 'Return to Sheath',
    'Swords from Heaven', 'Star Array', 'Cloud Piercer', 'Ten Thousand Swords'],
  getsuga: ['First Crescent', 'Cross Moon', 'Returning Moon', 'Full Moon', 'Sky Cleaver',
    'Twin Crescents', 'Getsuga Tenshō', 'Falling Moon', 'Final Getsuga'],
  hinokami: ['Round Dance', 'Clear Blue Sky', 'Burning Mirror', 'Fire Wheel', 'Solar Rainbow',
    'Sunflower Thrust', 'Blazing Wheel', 'Setting Sun', 'Flame Dance'],
};

export function artName(art: SwordArt, short = false): string {
  return isEnglish() ? ART_EN[art][short ? 1 : 0] : SWORD_ARTS[art][short ? 'short' : 'name'];
}
export function formName(art: SwordArt, index: number): string {
  return isEnglish() ? FORM_EN[art][index] ?? 'Sword Form' : SWORD_FORMS[art][index]?.name ?? '';
}
export function fullArtName(art: SwordArt): string {
  return isEnglish() ? ART_EN[art][2] : FULL_ART_NAMES[art];
}

const CHAPTER_EN = ['Rain in the Bamboo Sea', 'Bridge Beneath the Crescent Moon', 'Demons at the Gate',
  'Desert Smoke', 'Swords on the Snow Ridge', 'The Haunted Tower', 'Shadows in the Bamboo',
  'Night Crossing', 'The Snow Mountain Lair', 'Dawn at Heaven\'s Gate'] as const;
const STORY_EN = ['The leaves fall. A sword awakens.', 'Cold water remembers the road behind.',
  'The temple bell sends the demons fleeing.', 'The blade still sings beneath the sand.',
  'Snow falls silently where the sword has passed.', 'The tower goes dark; the road goes on.',
  'Beyond the forest lies another forest.', 'One sword crosses the river by moonlight.',
  'The last cry fades into the mountain wind.', 'At first light, another road begins.'] as const;
export function chapterName(chapter: number, chinese: string): string {
  return isEnglish() ? CHAPTER_EN[(chapter - 1) % CHAPTER_EN.length] ?? chinese : chinese;
}
export function chapterStory(chapter: number, chinese: string): string {
  return isEnglish() ? STORY_EN[(chapter - 1) % STORY_EN.length] ?? chinese : chinese;
}

const UI_NAMES: Record<string, string> = {
  '火柴快斩': 'Stick Slash', '贪吃蛇': 'Snake', '落块': 'Blocks', '摸鱼': 'Moyu',
  '移动': 'Move', '方向': 'Direction', '砍': 'Slash', '跳': 'Jump', '冲刺斩': 'Dash Slash',
  '旋斩': 'Spin Slash', '解控霸体': 'Guard Break', '方向键': 'Arrows', '空格': 'Space',
  '旋转': 'Rotate', '下落': 'Drop', '直落': 'Hard Drop',
  '蛛王': 'Spider King', '螳螂王': 'Mantis King', '金甲虫王': 'Scarab King',
  '冰晶王': 'Crystal King', '青锋': 'Azure Blade', '玄衣': 'Dark Robe',
};
export function uiName(name: string): string { return isEnglish() ? UI_NAMES[name] ?? name : name; }

const NAMED_EN = new Map<string, string>();
for (const art of ART_IDS) {
  NAMED_EN.set(SWORD_ARTS[art].name, ART_EN[art][0]);
  NAMED_EN.set(SWORD_ARTS[art].short, ART_EN[art][1]);
  NAMED_EN.set(FULL_ART_NAMES[art], ART_EN[art][2]);
  SWORD_FORMS[art].forEach((form, index) => NAMED_EN.set(form.name, FORM_EN[art][index]!));
}

export function englishBattleNotice(notice: string): string {
  const growth = /^修为(\d+)重 · 体魄(\d+) · 技能周转提升$/.exec(notice);
  if (growth) return `Cultivation ${growth[1]} · Max HP ${growth[2]} · Faster skills`;
  const cooldown = /^护体未就绪 (\d+)秒$/.exec(notice);
  if (cooldown) return `Guard ready in ${cooldown[1]}s`;
  const locked = /^(.+)未悟 · 阅历(\d+)\/(\d+)$/.exec(notice);
  if (locked) return `${NAMED_EN.get(locked[1]!) ?? 'Art'} locked · Insight ${locked[2]}/${locked[3]}`;
  const qi = /^剑气不足 (\d+)\/(\d+)$/.exec(notice);
  if (qi) return `Not enough qi ${qi[1]}/${qi[2]}`;
  if (notice === '护体罡气 · 霸体') return 'Iron Guard · Control immunity';
  if (notice === '铮！拼剑 · 剑招 / 绕背破守') return 'Blades clash! Use an art or attack from behind';
  if (notice === '铮！截剑成功 +6气') return 'Parry! +6 qi';
  const encounter = /^(剑宗临阵|剑客问剑) · (青锋|玄衣)$/.exec(notice);
  if (encounter) return `${encounter[1] === '剑宗临阵' ? 'Sword master appears' : 'Duelist challenges you'} · ${uiName(encounter[2]!)}`;
  const cast = /^(悟得秘技！)?(.+?) · (.+)$/.exec(notice);
  if (cast) return `${cast[1] ? 'Secret art learned! ' : ''}${NAMED_EN.get(cast[2]!) ?? 'Sword Art'} · ${NAMED_EN.get(cast[3]!) ?? 'Sword Form'}`;
  return /[\u3400-\u9fff]/.test(notice) ? 'Battle update' : notice;
}
