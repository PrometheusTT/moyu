import { fitRow } from "../render/text.js";
// One composition path for inline, protected bottom strip, standalone, and visual fixtures.
export class PlaySurface {
    lastPanel = '';
    lastMode = '';
    render(game, target, top, cols, rows) {
        const screenTop = Number.isSafeInteger(top) && top > 0 ? top : 1;
        const screenCols = Number.isSafeInteger(cols) && cols > 0 ? cols : 1;
        const displayRows = Number.isSafeInteger(rows) && rows > 0 ? rows : 1;
        game.setDisplay(displayRows, target.tier);
        const help = game.showingInstructions;
        const width = Math.max(0, screenCols - 1);
        if (width === 0)
            return '';
        if (target.cols > width || target.rows > displayRows)
            target.resize(Math.min(target.cols, width), Math.min(target.rows, displayRows));
        const gameLeft = 1;
        const mode = [screenTop, screenCols, displayRows, target.cols, target.rows, help].join(':');
        let clear = '';
        if (mode !== this.lastMode) {
            for (let row = 0; row < displayRows; row++)
                clear += `\x1b[m\x1b[${screenTop + row};1H${' '.repeat(width)}`;
            target.invalidate();
            this.lastPanel = '';
            this.lastMode = mode;
        }
        game.configureViewport(target);
        if (help)
            target.fill(0x090a0e);
        else
            game.render(target, displayRows <= 2 ? 'micro' : 'standard');
        // An opaque Kitty image would cover text instructions even if those bytes follow the image.
        // Help owns plain text cells, not a blank image placement.
        const body = help ? (target.tier === 'graphics' ? target.disposeSeq() : '') : target.encode(screenTop, gameLeft);
        const left = help ? 1 : target.cols + 3;
        const available = help ? width : Math.max(0, Math.min(28, target.cols, width - left + 1));
        const lines = game.panelRows(available, displayRows);
        // Controls are text, not pixels. Clear previous text with padded rows on every content change.
        const panel = available === 0 ? '' : Array.from({ length: displayRows }, (_, i) => lines[i] ?? '').map((line, i) => `\x1b[m\x1b[${screenTop + i};${left}H${fitRow(line.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), '', available)}`).join('');
        const changed = panel !== this.lastPanel || body !== '' || clear !== '';
        this.lastPanel = panel;
        return clear + body + (changed ? panel : '');
    }
}
