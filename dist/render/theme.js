/**
 * 每章的**氛围主题**：把剧情落到画面上。纯数据 + 纯函数，`sceneForChapter(n)` 由章节号
 * 确定性派生一套「天空/地面/敌人**微调色** + 几片静态剪影布景」，绝不碰 `world.rng`、
 * 不进 World、不参与战斗/计分 —— 渲染层拿到就画，拿不到（`undefined`）就退回今日的裸画面。
 *
 * ## 为什么只是"微调色"而不是换整套调色板
 *
 * 可读性合同（见 `legibility.test.ts`）钉死三件事：**最暗必须是描边 KEY**、**最亮 ≥ 玩家 BONE**、
 * **BONE 描边隔离**。所以每章的色相只能往基色里**掺一点**（`skyMix/groundMix` 都很小），
 * 让巷口冷灰、雨夜偏蓝、霓虹偏紫各有辨识度，但天空仍比 KEY 亮、玩家仍是全场最亮。
 * 剪影布景一律**暗于或接近 KEY**（`shade` 小）且画在人身后，既不抢最暗名额，也进不了
 * BONE 的四邻（人自带一圈 KEY 描边挡着）。
 *
 * ## 布景为什么是"比例"而不是像素
 *
 * 世界会随终端尺寸缩放（`world.w/ground` 是虚拟像素）。布景用 0..1 的比例描述位置和大小，
 * 两档渲染器各自乘上自己的坐标系，窄屏宽屏都落在同一处。
 */
// 十章的色相与布景。色相是"掺一点"的目标色，比例克制（见文件头的可读性合同）。
// 布景刻意少而稳：每章一两片，逐帧不变 —— 半块档零帧差、像素档 deflate 几乎免费。
// 十章的色相与布景。色相是"掺一点"的目标色，比例克制（见文件头的可读性合同）。
// 布景刻意少而**矮**：远景剪影贴着地平线的一带，不做通天大柱 —— 高柱会打断像素档
// 逐设备行的平滑天空渐变、把每帧字节顶出预算并分块（实测），矮剪影几乎免费。
const THEMES = [
    {
        skyTint: 0x3a4658, skyMix: 0.18, groundTint: 0x2a2f3a, groundMix: 0.2, foeTint: 0x8a9bb0, foeMix: 0.12,
        props: [{ cx: 0.1, top: 0.34, w: 0.1, shade: 0.1 }, { cx: 0.9, top: 0.28, w: 0.12, shade: 0.12 }],
    },
    {
        skyTint: 0x394a66, skyMix: 0.2, groundTint: 0x28303f, groundMix: 0.2, foeTint: 0x7f96b8, foeMix: 0.12,
        props: [{ cx: 0.5, top: 0.26, w: 0.5, shade: 0.14, dome: true }],
    },
    {
        skyTint: 0x4a3f28, skyMix: 0.22, groundTint: 0x332b1c, groundMix: 0.22, foeTint: 0xb09050, foeMix: 0.14,
        props: [{ cx: 0.22, top: 0.5, w: 0.07, shade: 0.08 }, { cx: 0.8, top: 0.26, w: 0.16, shade: 0.1 }],
    },
    {
        skyTint: 0x2e3f5c, skyMix: 0.24, groundTint: 0x232b3a, groundMix: 0.2, foeTint: 0x7890b4, foeMix: 0.14,
        props: [{ cx: 0.22, top: 0.3, w: 0.1, shade: 0.1 }, { cx: 0.82, top: 0.24, w: 0.11, shade: 0.11 }],
    },
    {
        skyTint: 0x28324f, skyMix: 0.24, groundTint: 0x222838, groundMix: 0.18, foeTint: 0x8494bc, foeMix: 0.12,
        props: [{ cx: 0.5, top: 0.12, w: 1.0, shade: 0.12 }, { cx: 0.8, top: 0.32, w: 0.08, shade: 0.1, dome: true }],
    },
    {
        skyTint: 0x3c4250, skyMix: 0.2, groundTint: 0x2b2e38, groundMix: 0.2, foeTint: 0x9aa2b4, foeMix: 0.12,
        props: [{ cx: 0.5, top: 0.44, w: 0.16, shade: 0.13, dome: true }],
    },
    {
        skyTint: 0x1f4640, skyMix: 0.22, groundTint: 0x1f2e2b, groundMix: 0.22, foeTint: 0x6fb0a0, foeMix: 0.14,
        props: [{ cx: 0.32, top: 0.28, w: 0.44, shade: 0.12 }],
    },
    {
        skyTint: 0x4a2a55, skyMix: 0.24, groundTint: 0x2f2338, groundMix: 0.22, foeTint: 0xb884c4, foeMix: 0.14,
        props: [{ cx: 0.12, top: 0.4, w: 0.06, shade: 0.14 }, { cx: 0.88, top: 0.36, w: 0.06, shade: 0.14 }],
    },
    {
        skyTint: 0x2c4636, skyMix: 0.22, groundTint: 0x24302a, groundMix: 0.22, foeTint: 0x86b48e, foeMix: 0.14,
        props: [{ cx: 0.5, top: 0.34, w: 0.2, shade: 0.13 }],
    },
    {
        skyTint: 0x5a4020, skyMix: 0.22, groundTint: 0x352a1e, groundMix: 0.2, foeTint: 0xc09858, foeMix: 0.12,
        props: [{ cx: 0.24, top: 0.24, w: 0.12, shade: 0.12 }, { cx: 0.72, top: 0.3, w: 0.14, shade: 0.1 }],
    },
];
/** 章节号（1..10）→ 氛围主题。越界回落到第 1 章，绝不返回 undefined。 */
export function sceneForChapter(chapter) {
    const i = Math.trunc(chapter) - 1;
    return THEMES[i] ?? THEMES[0];
}
