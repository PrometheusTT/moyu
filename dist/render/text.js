/** 文本行的宽度对齐。HUD 和横幅都是**文本行**而不是像素 —— 中文在半块画布上画不出来。 */
import { stringWidth } from "../shell/wcwidth.js";
/** 按**显示列宽**截断，不是按码元 —— CJK 一个字占两列。 */
export function clipWidth(s, max) {
    if (max <= 0)
        return '';
    let w = 0;
    let out = '';
    for (const ch of s) {
        const cw = stringWidth(ch);
        if (w + cw > max)
            break;
        out += ch;
        w += cw;
    }
    return out;
}
/** 左对齐 + 右对齐，填满恰好 cols 列。塞不下就丢掉右边那段。 */
export function fitRow(left, right, cols) {
    const lw = stringWidth(left);
    const rw = stringWidth(right);
    if (lw + 2 + rw <= cols)
        return `${left}${' '.repeat(cols - lw - rw)}${right}`;
    const clipped = clipWidth(left, cols);
    return clipped + ' '.repeat(Math.max(0, cols - stringWidth(clipped)));
}
/** 居中，两边填空格到恰好 cols 列。 */
export function centerRow(s, cols) {
    const t = clipWidth(s, cols);
    const pad = cols - stringWidth(t);
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + t + ' '.repeat(pad - l);
}
