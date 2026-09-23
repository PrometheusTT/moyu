export const MAX_QI = 300;
export const BOSS_HIT_QI = 12;
export const SWORD_ARTS = {
    dugu: { name: '独孤九剑', short: '九剑', keys: 'S+U', cost: 10, unlock: 0, color: 0xecc778 },
    liumai: { name: '六脉神剑', short: '六脉', keys: 'S+I', cost: 15, unlock: 12, color: 0x73dfe3 },
    taiji: { name: '太极剑', short: '太极', keys: 'W+I', cost: 15, unlock: 36, color: 0xc3b0ee },
    feixian: { name: '天外飞仙', short: '飞仙', keys: 'S>D>U', cost: 20, unlock: 60, color: 0xb4e7ff },
    wanjian: { name: '万剑归宗', short: '万剑', keys: 'S>A>I', cost: 20, unlock: 100, color: 0xf1d789 },
    getsuga: { name: '月牙天冲', short: '月牙', keys: 'W>D>J', cost: 20, unlock: 48, color: 0x8bc6ff },
    hinokami: { name: '日之呼吸', short: '日轮', keys: 'W>A>J', cost: 20, unlock: 80, color: 0xff955c },
};
const form = (name, qi, reach, shape, radial = false) => ({ name, qi, reach, shape, radial });
/** 游戏化简式；太极、飞仙、归宗和彩蛋支式为本游戏编排，不声称复刻完整原作招式表。 */
export const SWORD_FORMS = {
    dugu: [form('总诀式', 10, 1.8, 'fan'), form('破剑式', 10, 2, 'thrust'), form('破刀式', 10, 2.2, 'sweep'),
        form('破枪式', 60, 3.1, 'thrust'), form('破鞭式', 60, 2.5, 'ring', true), form('破索式', 60, 2.8, 'fan'),
        form('破掌式', 100, 2.6, 'sweep', true), form('破箭式', 100, 3.4, 'rain', true), form('破气式', 100, 4, 'crescent')],
    liumai: [form('少商剑', 15, 4, 'thrust'), form('商阳剑', 15, 4.3, 'thrust'),
        form('中冲剑', 60, 5, 'thrust'), form('关冲剑', 60, 3.2, 'fan'),
        form('少冲剑', 100, 2.8, 'ring', true), form('少泽剑', 100, 3.5, 'rain', true)],
    taiji: [form('起势引流', 15, 2, 'ring', true), form('白鹤舒翼', 15, 2.2, 'fan'), form('清风揽月', 15, 2.4, 'sweep', true),
        form('回雪流云', 60, 2.6, 'ring', true), form('游龙探海', 60, 3, 'thrust'), form('阴阳合璧', 60, 2.9, 'sweep', true),
        form('云卷千峰', 100, 3.2, 'rain', true), form('两仪回转', 100, 3, 'ring', true), form('太极归元', 100, 3.2, 'crescent')],
    feixian: [form('踏云起剑', 20, 2.5, 'fan'), form('流霞出岫', 20, 2.8, 'thrust'), form('飞燕回身', 20, 2, 'sweep', true),
        form('一剑惊鸿', 60, 3.5, 'thrust'), form('白虹落日', 60, 3, 'rain'), form('凌空折翼', 60, 3, 'crescent'),
        form('天外飞仙', 100, 4, 'rain'), form('星河倒悬', 100, 3.6, 'fan'), form('一剑开天', 100, 4.5, 'thrust')],
    wanjian: [form('引剑成阵', 20, 2.5, 'ring', true), form('游剑护身', 20, 2, 'sweep', true), form('三才问路', 20, 3, 'fan'),
        form('百剑朝宗', 60, 4, 'fan'), form('回锋归鞘', 60, 3, 'ring', true), form('剑落九天', 60, 3.5, 'rain', true),
        form('星斗剑阵', 100, 3.5, 'ring', true), form('千锋破云', 100, 4.5, 'thrust'), form('万剑朝宗', 100, 4, 'rain', true)],
    getsuga: [form('月牙·初弦', 20, 2.8, 'crescent'), form('月牙·横弦', 20, 2.5, 'sweep'), form('月牙·回弦', 20, 2, 'ring', true),
        form('月牙·满月', 60, 3.6, 'crescent'), form('月牙·裂空', 60, 3.8, 'thrust'), form('月牙·双弦', 60, 3, 'fan'),
        form('月牙·天冲', 100, 4.2, 'crescent'), form('月牙·落月', 100, 3.5, 'rain'), form('终式·月牙', 100, 4, 'sweep')],
    hinokami: [form('圆舞', 20, 2.4, 'ring', true), form('碧罗之天', 20, 2.5, 'crescent'), form('烈日红镜', 20, 2.6, 'sweep', true),
        form('火车', 60, 3, 'ring', true), form('幻日虹', 60, 3.5, 'fan'), form('阳华突', 60, 3.8, 'thrust'),
        form('飞轮阳炎', 100, 3.4, 'crescent'), form('斜阳转身', 100, 3.2, 'rain'), form('炎舞', 100, 3.6, 'sweep', true)],
};
export const FULL_ART_NAMES = {
    dugu: '九剑归一', liumai: '六脉齐发', taiji: '太极无极', feixian: '一剑开天', wanjian: '万剑朝宗',
    getsuga: '终式·月牙', hinokami: '日轮炎舞',
};
export const freshFormProgress = () => Object.fromEntries(Object.keys(SWORD_ARTS).map(art => [art, [0, 0, 0]]));
export function parseFormProgress(value) {
    const result = freshFormProgress();
    if (!value || typeof value !== 'object')
        return result;
    for (const art of Object.keys(result)) {
        const row = value[art];
        if (Array.isArray(row) && row.length === 3 && row.every(n => Number.isSafeInteger(n) && n >= 0))
            result[art] = row.map(n => n % (SWORD_FORMS[art].length / 3));
    }
    return result;
}
/** qi 是档位门槛，不是消费额；每档独立轮换，只有高档最后一式带收势。 */
export function selectSwordForm(art, qi, progress = [0, 0, 0]) {
    if (!Number.isFinite(qi) || qi < SWORD_ARTS[art].cost)
        return null;
    const tier = qi >= 100 ? 2 : qi >= 60 ? 1 : 0;
    const count = SWORD_FORMS[art].length / 3, offset = (progress[tier] ?? 0) % count;
    return { index: tier * count + offset, tier, full: tier === 2 && offset === count - 1,
        cost: SWORD_ARTS[art].cost + tier * 3 };
}
export const swordFormIndex = (cast) => cast.formIndex ?? (cast.full ? SWORD_FORMS[cast.art].length - 1 : 0);
export const currentSwordForm = (cast) => SWORD_FORMS[cast.art][swordFormIndex(cast)];
export const ART_IDS = Object.keys(SWORD_ARTS);
export const SECRET_ARTS = ['getsuga', 'hinokami'];
export const isSecretArt = (art) => SECRET_ARTS.includes(art);
export const artDuration = (_art, full = false) => full ? 1.2 : 0.65;
/** 尾光仍可消散，但最后一次伤害后就允许接招。敌方蓄势/出招时序不加速。 */
export const artRecovery = (full = false) => full ? 0.9 : 0.42;
export const GROWTH_INSIGHT = [0, 20, 60, 120, 220, 360, 540];
/** 永久成长从已有阅历派生，旧存档不用迁移，也不保存可漂移的属性副本。 */
export function playerGrowth(insight) {
    const earned = Number.isFinite(insight) ? Math.max(0, insight) : 0;
    let tier = 0;
    while (tier + 1 < GROWTH_INSIGHT.length && earned >= GROWTH_INSIGHT[tier + 1])
        tier++;
    return { level: tier + 1, maxHp: 4 + Math.floor(tier / 2), skillCooldown: 1 - tier * 0.03,
        armorDuration: 0.8 + tier * 0.04, armorCooldown: 6 - tier * 0.25, nextInsight: GROWTH_INSIGHT[tier + 1] ?? null };
}
export const freshCultivation = () => ({ insight: 0,
    mastery: { dugu: 0, liumai: 0, taiji: 0, feixian: 0, wanjian: 0, getsuga: 0, hinokami: 0 } });
export function artLevel(progress, art) {
    return Math.min(5, 1 + Math.floor(Math.sqrt(progress.mastery[art] / 6)));
}
export function parseCultivation(value) {
    try {
        if (typeof value !== 'object' || value === null)
            return null;
        const { insight, mastery } = value;
        const valid = (n) => Number.isSafeInteger(n) && n >= 0;
        if (!valid(insight) || typeof mastery !== 'object' || mastery === null)
            return null;
        const result = freshCultivation();
        result.insight = insight;
        for (const art of ART_IDS) {
            const count = mastery[art];
            // 旧剑谱的三项必须完整；新增项允许缺省为零。
            if (count === undefined && !['dugu', 'liumai', 'taiji'].includes(art))
                continue;
            if (!valid(count))
                return null;
            result.mastery[art] = count;
        }
        return result;
    }
    catch {
        return null;
    }
}
