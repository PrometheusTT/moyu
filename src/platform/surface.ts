import type { PixelTarget } from '../render/target.ts';
import { fitRow } from '../render/text.ts';
import type { Arcade } from './arcade.ts';

// One composition path for inline, protected bottom strip, standalone, and visual fixtures.
export class PlaySurface {
  private lastPanel = '';
  private lastMode = '';
  render(game: Arcade, target: PixelTarget, top: number, cols: number, rows: number): string {
    game.setDisplay(rows, target.tier);
    const help = game.showingInstructions;
    const width = Math.min(cols - 1, 80);
    const mode = [top, cols, rows, help].join(':');
    let clear = '';
    if (mode !== this.lastMode) {
      for (let row = 0; row < rows; row++) clear += `\x1b[m\x1b[${top + row};1H${' '.repeat(width)}`;
      target.invalidate(); this.lastPanel = ''; this.lastMode = mode;
    }
    if (help) target.fill(0x090a0e);
    else game.render(target, rows <= 2 ? 'micro' : 'standard');
    // An opaque Kitty image would cover text instructions even if those bytes follow the image.
    // Help owns plain text cells, not a blank image placement.
    const body = help && target.tier === 'graphics' ? target.disposeSeq() : target.encode(top);
    const lines = game.panel();
    const left = help ? 1 : target.cols + 3;
    const available = Math.max(0, width - left + 1);
    if (!help && available < 30) lines[1] = '?帮助 Esc退';
    // Controls are text, not pixels. Clear previous text with padded rows on every content change.
    const panel = available === 0 ? '' : lines.map((line, i) =>
      `\x1b[m\x1b[${top + i};${left}H${fitRow(line.replace(/[\x00-\x1f\x7f-\x9f]/g, ''), '', available)}`).join('');
    const changed = panel !== this.lastPanel || body !== '' || clear !== '';
    this.lastPanel = panel;
    return clear + body + (changed ? panel : '');
  }
}
