import { NO_INTENT } from "./world.js";
export const CHAPTER_STEPS = 1800;
export const CHAPTER_COUNT = 10;
// CHAPTER_COUNT 是场景循环长度，不再是通关上限。老存档保持 v1 可读。
/** 每章一句剧情标题，在该章的"完成屏"上亮出（按 J 进下一章前的剧情节拍）。第 3/6/9 章是 boss 章。 */
export const CHAPTER_TITLES = [
    '竹海听雨', '残月石桥', '山门妖踪', '大漠孤烟', '雪岭问剑',
    '古塔镇妖', '竹影迷踪', '长桥夜渡', '雪山魔窟', '天门破晓',
];
/**
 * 每章一句收尾旁白，在该章"完成屏"上跟在标题后面亮出 —— 把"下班路被加班堵死、
 * 一路劈到老板走廊"的剧情落到文字上（第 3/6/9 章打 boss，旁白也对上那三场硬仗）。
 */
export const CHAPTER_STORY = [
    '竹叶落尽，剑意初生。', '桥下寒水，照见来时路。', '山门钟响，群妖退散。',
    '黄沙埋骨，长剑犹鸣。', '雪落无声，剑过留痕。', '古塔灯灭，江湖未歇。',
    '深林之外，还有深林。', '月下独行，一剑渡江。', '寒风吹散了最后一声嘶鸣。',
    '天光初现，前方又是一重江湖。',
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
/** 无限增长的关数，有限的同屏压力，避免后期刷怪把终端拖垮。 */
export function chapterPressure(chapter) {
    return Math.min(7, Math.max(0, Math.floor((Math.trunc(chapter) - 1) / 3)));
}
export class ChapterDirector {
    seedValue;
    chapterKills = 0;
    chapterBest = 0;
    saved = null;
    encounterSpawned = false;
    chapter = 1;
    activeStep = 0;
    result = null;
    constructor(seed) {
        this.seedValue = seed >>> 0;
    }
    get runSeed() { return this.seedValue; }
    /** 当前章的剧情标题（供 HUD 开场横幅用）。 */
    chapterTitle() { return CHAPTER_TITLES[(this.chapter - 1) % CHAPTER_COUNT] ?? ''; }
    /** 当前章的收尾旁白（供 HUD 完成屏用）。 */
    chapterStory() { return CHAPTER_STORY[(this.chapter - 1) % CHAPTER_COUNT] ?? ''; }
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
        if (this.activeStep >= PINCER_END && !this.encounterSpawned) {
            if (this.chapter % 9 === 0)
                this.encounterSpawned = world.spawnDuelist(this.side(this.chapter), this.chapter, true);
            else if (this.chapter % 3 === 0)
                this.encounterSpawned = world.spawnBoss(this.side(this.chapter), this.chapter);
            else if (this.chapter % 5 === 0)
                this.encounterSpawned = world.spawnDuelist(this.side(this.chapter), this.chapter);
            else
                this.encounterSpawned = true;
        }
        if (this.activeStep < CHAPTER_STEPS)
            this.schedule(world);
        const killsBefore = world.kills;
        world.step(dt, input);
        this.chapterKills += Math.max(0, world.kills - killsBefore);
        // World records the peak before a later hit/combo timeout can reset it in the same fixed step.
        this.chapterBest = Math.max(this.chapterBest, world.stepComboPeak);
        this.activeStep = Math.min(CHAPTER_STEPS, this.activeStep + 1);
        // 三十秒是出怪日程的终点。加时清场仍模拟、仍计分，绝不移除幸存敌人。
        if (this.activeStep === CHAPTER_STEPS && this.encounterSpawned && world.enemies.length === 0 && world.respawn <= 0
            && world.swordCast === null)
            this.finish(world);
        return true;
    }
    nextChapter(world) {
        if (this.result === null || this.chapter >= Number.MAX_SAFE_INTEGER || world.phase !== 'fight')
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
        this.encounterSpawned = true;
        this.saved = checkpoint;
        world.biome = (this.chapter - 1) % CHAPTER_COUNT;
        world.beginChapter();
        world.rng.restore(checkpoint.rngState);
        this.chapterKills = checkpoint.result.kills;
        this.chapterBest = checkpoint.result.bestCombo;
        return true;
    }
    begin(world) {
        world.biome = (this.chapter - 1) % CHAPTER_COUNT;
        world.beginChapter();
        if (this.saved)
            world.rng.restore(this.saved.rngState);
        this.activeStep = 0;
        this.result = null;
        this.encounterSpawned = false;
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
            // 收尾对决交由 step 等待空位；停止普通刷怪，战斗本身不限时。
            if (this.chapter % 3 === 0 || this.chapter % 5 === 0) {
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
    if (version !== 1 || !natural(runSeed, 0xffffffff) || !natural(completed)
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
    if (!natural(chapter) || chapter !== completed || !natural(resultScore)
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
