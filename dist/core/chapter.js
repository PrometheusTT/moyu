import { NO_INTENT } from "./world.js";
export const CHAPTER_STEPS = 1800;
export const CHAPTER_COUNT = 10;
/** 每章一句剧情标题，在该章的"完成屏"上亮出（按 J 进下一章前的剧情节拍）。第 3/6/9 章是 boss 章。 */
export const CHAPTER_TITLES = [
    '巷口的第一刀',
    '桥头的伏兵',
    '断电的工厂', // boss
    '雨夜的追逐',
    '天台上的风',
    '钟楼的守卫', // boss
    '末班地铁',
    '霓虹长街',
    '老板的走廊', // boss
    '加班的尽头',
];
/**
 * 每章一句收尾旁白，在该章"完成屏"上跟在标题后面亮出 —— 把"下班路被加班堵死、
 * 一路劈到老板走廊"的剧情落到文字上（第 3/6/9 章打 boss，旁白也对上那三场硬仗）。
 */
export const CHAPTER_STORY = [
    '下班的路被堵死了，那就自己劈开一条。',
    '他们从加班群里追出来，桥这头没一个是熟人。',
    '拉闸的是主管，黑暗里他比谁都怕挨这一刀。', // boss
    '雨把霓虹冲成一片红，跑在前头的还是那张考勤表。',
    '站得越高，越看得清这座城把人熬成了什么样。',
    '钟敲十二下，守夜的老规矩今晚被砍停了。', // boss
    '末班车不等人，可今晚它得等我把这节车厢清空。',
    '招牌一个接一个灭掉，长街尽头只剩那间还亮着的办公室。',
    '走廊尽头那扇门后，坐着让所有人加班的那个人。', // boss
    '打完这最后一个，卡钟停了，天也亮了。',
];
export const OPENING_END = 180;
export const ORDINARY_END = 720;
export const PINCER_END = 1320;
export function chapterBand(step) {
    if (!Number.isInteger(step) || step < 0 || step >= CHAPTER_STEPS) {
        throw new RangeError(`章节帧超出范围：${step}`);
    }
    if (step < OPENING_END)
        return 'opening';
    if (step < ORDINARY_END)
        return 'ordinary';
    if (step < PINCER_END)
        return 'pincer';
    return 'closing';
}
/** 难度只在前三章加压；之后十章共享同一个上限。 */
export function chapterPressure(chapter) {
    return Math.min(3, Math.max(0, Math.trunc(chapter) - 1));
}
export class ChapterDirector {
    seedValue;
    chapterKills = 0;
    chapterBest = 0;
    saved = null;
    chapter = 1;
    activeStep = 0;
    result = null;
    constructor(seed) {
        this.seedValue = seed >>> 0;
    }
    get runSeed() { return this.seedValue; }
    /** 当前章的剧情标题（供 HUD 开场横幅用）。 */
    chapterTitle() { return CHAPTER_TITLES[this.chapter - 1] ?? ''; }
    /** 当前章的收尾旁白（供 HUD 完成屏用）。 */
    chapterStory() { return CHAPTER_STORY[this.chapter - 1] ?? ''; }
    start(world) {
        this.chapter = 1;
        this.saved = null;
        this.begin(world);
    }
    step(world, dt, input) {
        // 外部任务完成的清屏技先走完；它不能被章节结果冻结，也不能消耗章节帧。
        // 暂停态也不接受 J：只有 task-start 能把被任务事件打断的章节交还给导演。
        if (world.phase !== 'fight') {
            world.step(dt, NO_INTENT);
            return false;
        }
        if (this.result !== null)
            return false;
        this.schedule(world);
        const killsBefore = world.kills;
        world.step(dt, input);
        this.chapterKills += Math.max(0, world.kills - killsBefore);
        // World records the peak before a later hit/combo timeout can reset it in the same fixed step.
        this.chapterBest = Math.max(this.chapterBest, world.stepComboPeak);
        this.activeStep++;
        if (this.activeStep === CHAPTER_STEPS)
            this.finish(world);
        return true;
    }
    nextChapter(world) {
        if (this.result === null || this.chapter >= CHAPTER_COUNT || world.phase !== 'fight')
            return false;
        this.chapter++;
        this.begin(world);
        return true;
    }
    /**
     * 通关第 10 章后按 J **再来一局**：回到第 1 章、清掉存档检查点重开。
     * 只在"末章已结算"这个终局屏上生效（否则交给 nextChapter 进下一章）。
     * 终身战绩（World 的 kills/bestCombo）由 `begin→beginChapter` 保留，不清零。
     */
    restartRun(world) {
        if (this.result === null || this.chapter < CHAPTER_COUNT || world.phase !== 'fight')
            return false;
        this.start(world);
        return true;
    }
    checkpoint() {
        return this.saved;
    }
    restore(world, value) {
        const checkpoint = parseChapterCheckpoint(value);
        if (checkpoint === null)
            return false;
        this.seedValue = checkpoint.runSeed;
        this.chapter = checkpoint.completed;
        this.activeStep = CHAPTER_STEPS;
        this.result = checkpoint.result;
        this.saved = checkpoint;
        world.beginChapter();
        world.rng.restore(checkpoint.rngState);
        this.chapterKills = checkpoint.result.kills;
        this.chapterBest = checkpoint.result.bestCombo;
        return true;
    }
    begin(world) {
        world.beginChapter();
        this.activeStep = 0;
        this.result = null;
        this.chapterKills = 0;
        this.chapterBest = 0;
        // 第一刀面前直接放两人：不是等 AI 偶然挤在一起，而是一开始就明确给一次多杀机会。
        world.spawnFormation({ kind: 'pair', side: 'right' });
    }
    schedule(world) {
        const step = this.activeStep;
        const pressure = chapterPressure(this.chapter);
        if (step >= OPENING_END && step < ORDINARY_END) {
            // 收紧间隔、隔一波来一记两面夹击：普通段不再是"一个一个慢慢挪过来、砍两下就没了"，
            // 而是时不时左右各压上一个，逼出走位与连击，让每关中段真的像"打一场"。
            // pincer 从两侧边缘走入（不贴身刷），满场则整队落空、绝不只刷一半（≤3 恒成立）。
            const interval = 140 - pressure * 12;
            const offset = step - OPENING_END;
            if (offset % interval !== 0)
                return;
            const slot = offset / interval;
            world.spawnFormation(slot % 2 === 0
                ? { kind: 'pincer' }
                : { kind: 'single', side: this.side(slot) });
            return;
        }
        if (step >= ORDINARY_END && step < PINCER_END) {
            const interval = 240 - pressure * 20;
            const offset = step - ORDINARY_END;
            if (offset % interval !== 0)
                return;
            const slot = offset / interval;
            const formation = slot % 2 === 0
                ? { kind: 'pincer' }
                : { kind: 'single', side: this.side(slot + 11) };
            world.spawnFormation(formation);
            return;
        }
        if (step >= PINCER_END) {
            const offset = step - PINCER_END;
            // 每 3 章（第 3/6/9 章）的收尾段是 boss 战：开头挤出一个 boss（spawnBoss 满场会腾位，
            // 保证一定出现），之后不再刷 fill —— 让玩家专心打 boss。第 1/4 章 %3≠0，日程断言不受影响。
            if (this.chapter % 3 === 0) {
                if (offset === 0)
                    world.spawnBoss(this.side(this.chapter));
                return;
            }
            const interval = 150 - pressure * 15;
            if (offset % interval === 0)
                world.spawnFormation({ kind: 'fill', side: this.side(offset / interval + 23) });
        }
    }
    side(slot) {
        let x = (this.seedValue ^ Math.imul(this.chapter, 0x9e3779b1) ^ Math.imul(slot + 1, 0x85ebca6b)) >>> 0;
        x ^= x >>> 16;
        x = Math.imul(x, 0x7feb352d);
        x ^= x >>> 15;
        return (x >>> 0) % 2 === 0 ? 'left' : 'right';
    }
    finish(world) {
        const result = freezeResult({ chapter: this.chapter, kills: this.chapterKills,
            bestCombo: this.chapterBest, score: chapterScore(this.chapterKills, this.chapterBest) });
        const previous = this.saved;
        const score = (previous?.score ?? 0) + result.score;
        const kills = (previous?.kills ?? 0) + result.kills;
        const bestCombo = Math.max(previous?.bestCombo ?? 0, result.bestCombo);
        this.result = result;
        this.saved = Object.freeze({ version: 1, runSeed: this.seedValue, completed: this.chapter,
            score, kills, bestCombo, rngState: world.rng.snapshot(), result });
    }
}
function chapterScore(kills, bestCombo) {
    return kills * 100 + bestCombo * 50;
}
function freezeResult(result) {
    return Object.freeze({ ...result });
}
function natural(value, max = Number.MAX_SAFE_INTEGER) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
export function parseChapterCheckpoint(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    let version;
    let runSeed;
    let completed;
    let score;
    let kills;
    let bestCombo;
    let rngState;
    let resultValue;
    try {
        const v = value;
        ({ version, runSeed, completed, score, kills, bestCombo, rngState, result: resultValue } = v);
    }
    catch {
        return null;
    }
    if (version !== 1 || !natural(runSeed, 0xffffffff) || !natural(completed, CHAPTER_COUNT)
        || completed < 1 || !natural(score) || !natural(kills) || !natural(bestCombo)
        || !natural(rngState, 0xffffffff) || rngState === 0)
        return null;
    if (typeof resultValue !== 'object' || resultValue === null || Array.isArray(resultValue))
        return null;
    let chapter;
    let resultScore;
    let resultKills;
    let resultBest;
    try {
        ({ chapter, score: resultScore, kills: resultKills, bestCombo: resultBest }
            = resultValue);
    }
    catch {
        return null;
    }
    if (!natural(chapter, CHAPTER_COUNT) || chapter !== completed || !natural(resultScore)
        || !natural(resultKills) || !natural(resultBest) || resultBest > resultKills
        || (resultKills > 0 && resultBest === 0)
        || resultScore !== chapterScore(resultKills, resultBest)
        || bestCombo > kills || (kills > 0 && bestCombo === 0) || score % 50 !== 0
        || score < kills * 100 || score > kills * 150
        || (kills === 0 && score !== 0)
        || score < resultScore || kills < resultKills || bestCombo < resultBest)
        return null;
    const priorChapters = completed - 1;
    const priorKills = kills - resultKills;
    const priorBonus = (score - resultScore - priorKills * 100) / 50;
    if (!natural(priorKills) || !natural(priorBonus) || priorBonus > priorKills
        || (priorKills > 0 && priorBonus === 0)
        || (priorChapters === 0
            ? priorKills !== 0 || priorBonus !== 0 || bestCombo !== resultBest
            : priorBonus > priorChapters * bestCombo || (bestCombo > resultBest && priorBonus < bestCombo)))
        return null;
    const result = freezeResult({ chapter, score: resultScore, kills: resultKills, bestCombo: resultBest });
    return Object.freeze({ version: 1, runSeed, completed, score, kills, bestCombo, rngState, result });
}
