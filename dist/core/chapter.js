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
            const interval = 180 - pressure * 15;
            const offset = step - OPENING_END;
            if (offset % interval === 0)
                world.spawnFormation({ kind: 'single', side: this.side(offset / interval) });
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
