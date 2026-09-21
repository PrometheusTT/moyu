/** 剑谱是永久养成；剑气是战斗资源。没有文件 I/O，存档交给宿主。 */
export type SwordArt = 'dugu' | 'liumai' | 'taiji' | 'feixian' | 'wanjian' | 'getsuga' | 'hinokami';
export const MAX_QI = 300;
export const BOSS_HIT_QI = 12;
export const SWORD_ARTS = {
  dugu: { name: '独孤九剑', short: '九剑', keys: 'S+U', cost: 10, unlock: 0, color: 0xecc778 },
  liumai: { name: '六脉神剑', short: '六脉', keys: 'S+I', cost: 15, unlock: 12, color: 0x73dfe3 },
  taiji: { name: '太极剑', short: '太极', keys: 'W+I', cost: 15, unlock: 36, color: 0xc3b0ee },
  feixian: { name: '天外飞仙', short: '飞仙', keys: 'S>D>U', cost: 30, unlock: 60, color: 0xb4e7ff },
  wanjian: { name: '万剑归宗', short: '万剑', keys: 'S>A>I', cost: 30, unlock: 100, color: 0xf1d789 },
  getsuga: { name: '月牙天冲', short: '月牙', keys: 'W>D>J', cost: 30, unlock: 48, color: 0x8bc6ff },
  hinokami: { name: '日之呼吸', short: '日轮', keys: 'W>A>J', cost: 30, unlock: 80, color: 0xff955c },
} as const;
export type SwordForm = { name: string; qi: number; reach: number; radial: boolean; shape: 'thrust' | 'fan' | 'sweep' | 'rain' | 'ring' | 'crescent' };
const form = (name: string, qi: number, reach: number, shape: SwordForm['shape'], radial = false): SwordForm =>
  ({ name, qi, reach, shape, radial });
/** 游戏化简式；太极、飞仙、归宗和彩蛋支式为本游戏编排，不声称复刻完整原作招式表。 */
export const SWORD_FORMS: Record<SwordArt, readonly SwordForm[]> = {
  dugu: [form('破剑式', 10, 1.8, 'thrust'), form('破气式', 60, 3.2, 'thrust')],
  liumai: [form('少商剑', 15, 4, 'thrust'), form('三脉并发', 60, 5, 'thrust')],
  taiji: [form('清风揽月', 15, 2, 'ring', true), form('阴阳合璧', 60, 2.9, 'ring', true)],
  feixian: [form('一剑惊鸿', 30, 2.5, 'thrust'), form('天外飞仙', 60, 4, 'thrust')],
  wanjian: [form('引剑成阵', 30, 2.5, 'rain', true), form('剑落九天', 60, 4.5, 'rain', true)],
  getsuga: [form('月牙·初弦', 30, 2.8, 'crescent'), form('月牙·天冲', 60, 4.2, 'crescent')],
  hinokami: [form('圆舞', 30, 2.4, 'sweep', true), form('烈日', 60, 3.4, 'sweep', true)],
};
export const FULL_ART_NAMES: Record<SwordArt, string> = {
  dugu: '九剑归一', liumai: '六脉齐发', taiji: '太极无极', feixian: '一剑开天', wanjian: '万剑朝宗',
  getsuga: '终式·月牙', hinokami: '日轮炎舞',
};
export function selectSwordForm(art: SwordArt, qi: number): { index: number; full: boolean; cost: number } | null {
  if (!Number.isFinite(qi) || qi < SWORD_ARTS[art].cost) return null;
  if (qi >= 100) return { index: 0, full: true, cost: 100 };
  const index = SWORD_FORMS[art].findLastIndex(f => qi >= f.qi);
  return index < 0 ? null : { index, full: false, cost: SWORD_FORMS[art][index]!.qi };
}
export const swordFormIndex = (cast: SwordCast): number => cast.full
  ? SWORD_FORMS[cast.art].length - 1
  : cast.formIndex ?? 0;
export const currentSwordForm = (cast: SwordCast): SwordForm => SWORD_FORMS[cast.art][swordFormIndex(cast)]!;
export const ART_IDS = Object.keys(SWORD_ARTS) as SwordArt[];
export const SECRET_ARTS: readonly SwordArt[] = ['getsuga', 'hinokami'];
export const isSecretArt = (art: SwordArt): boolean => SECRET_ARTS.includes(art);
export const artDuration = (_art: SwordArt, full = false): number => full ? 1.2 : 0.65;
export type Cultivation = { insight: number; mastery: Record<SwordArt, number> };
export const freshCultivation = (): Cultivation => ({ insight: 0,
  mastery: { dugu: 0, liumai: 0, taiji: 0, feixian: 0, wanjian: 0, getsuga: 0, hinokami: 0 } });
export function artLevel(progress: Cultivation, art: SwordArt): number {
  return Math.min(5, 1 + Math.floor(Math.sqrt(progress.mastery[art] / 6)));
}
export function parseCultivation(value: unknown): Cultivation | null {
  try {
    if (typeof value !== 'object' || value === null) return null;
    const { insight, mastery } = value as Cultivation;
    const valid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
    if (!valid(insight) || typeof mastery !== 'object' || mastery === null) return null;
    const result = freshCultivation(); result.insight = insight;
    for (const art of ART_IDS) {
      const count = mastery[art];
      // 旧剑谱的三项必须完整；新增项允许缺省为零。
      if (count === undefined && !['dugu', 'liumai', 'taiji'].includes(art)) continue;
      if (!valid(count)) return null;
      result.mastery[art] = count;
    }
    return result;
  } catch { return null; }
}
export type SwordCast = { art: SwordArt; x: number; y: number; face: 1 | -1; age: number; pulse: number; level: number;
  formIndex?: number; full?: boolean };
