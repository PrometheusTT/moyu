/**
 * 假内层 CLI。给 PTY-in-PTY 端到端测试当被包裹的那个程序用。
 *
 * 为什么要自己写一个而不是直接跑真的 `claude`：我们需要内层**精确地**发出某几条转义序列
 * （故意越界的定位、故意过大的滚动区、故意在字符中间切断的 chunk），真实程序不听指挥。
 * 而这些恰好是外壳最容易出错的输入。
 *
 * 协议：从 stdin 读单个字符当命令，每条命令发一段已知字节。测试据此断言外壳的输出。
 * 例外是**转义序列**：那不是命令，是外壳回给我们的答复（`CSI ... t` 尺寸报告），
 * 原样转述成一行 `SIZEREP` 好让测试断言。不这么分开的话回复末尾那个 `t`
 * 会被当成命令字符，而 `t` 恰好就是"问尺寸"那条命令 —— 自己把自己喂成死循环。
 */
import { spawn } from 'node:child_process';

const out = (s: string): void => { process.stdout.write(s); };

process.stdin.setRawMode?.(true);
process.stdin.resume();

/** 半截转义序列。外壳的回复真的可能被切成两个 chunk，和它自己的透传层同一个道理。 */
let pend = '';
let composer = false;
const redrawComposer = (): void => {
  out('\x1b[10;1HORIGINAL-CONTEXT\x1b[11;1HORIGINAL-SEPARATOR\x1b[12;1H› Ask Codex');
};

process.stdin.on('data', (buf: Buffer) => {
  const s = pend + buf.toString('latin1');
  pend = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      let j = i + 1;
      if (s[j] === '[') { j++; while (j < s.length && !/[A-Za-z]/.test(s[j]!)) j++; }
      if (j >= s.length || !/[A-Za-z]/.test(s[j]!)) { pend = s.slice(i); return; }
      const seq = s.slice(i, j + 1);
      const m = /^\x1b\[(\d+(?:;\d+)*)t$/.exec(seq);
      out(m ? `SIZEREP ${m[1]}\r\n` : `OTHERSEQ ${JSON.stringify(seq)}\r\n`);
      i = j + 1;
      continue;
    }
    command(s[i]!);
    i++;
  }
});

function command(ch: string): void {
  switch (ch) {
    case 'p':
      // 普通输出。跟一条 CPR 风格的自报位置，方便测试知道内层认为自己在哪。
      out('INNER-HELLO\r\n');
      break;
    case 's':
      // 自报 ioctl 尺寸。这是 TIOCSWINSZ 是否真的生效的唯一可信证据。
      out(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
      break;
    case 'e':
      out(`EVENTS ${process.env.MOYU_EVENTS ?? ''}\r\n`);
      break;
    case 'x': {
      // 启一个明确忽略 SIGHUP 的孙进程。外壳退出必须杀 PTY 的整个进程组，不能只 HUP 首进程。
      const child = spawn(process.execPath, ['-e',
        "process.on('SIGHUP',()=>{}); console.log('HUP-CHILD '+process.pid); setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'inherit', 'inherit'] });
      child.unref();
      break;
    }
    case 'm':
      // 故意设一个覆盖整屏的滚动区。外壳必须把底边夹到内层区域内。
      out('\x1b[1;999r');
      break;
    case 'g':
      // 故意往游戏区里定位。外壳必须把行号夹回来。
      out('\x1b[999;7HOUT-OF-RANGE');
      break;
    case 'a':
      out('\x1b[?1049hALT-SCREEN');
      break;
    case 'd':
      // 当前 Codex 是 inline TUI：回到界面顶端后用裸 CSI J（ED 0）向屏幕末尾清除。
      // 滚动区挡不住 ED，因此它会连 Moyu 的最底栏一起擦掉。
      out('\x1b[H\x1b[JCODEX-INLINE-CLEAR');
      break;
    case 'i':
      // Codex composer 的最小可识别形态：左侧 `›` 是宿主的锚点，游戏应落在 10..11 行。
      composer = true; redrawComposer();
      break;
    case 'A':
      out('\x1b[?1049l');
      break;
    case 'k':
      // push kitty 键盘标志（1|4 = 消歧 + 备用键码），真实 claude 启动时就发这条。
      // 发完之后终端把 ctrl+key 一律编成 `CSI u` —— 外壳的热键必须在那种编码下照样成立。
      out('\x1b[>5uKITTY-ON\r\n');
      break;
    case 'K':
      out('\x1b[<uKITTY-OFF\r\n');
      break;
    case 'c':
      // 把一条序列切成两半分两次写，中间隔一个 tick —— 跨 chunk 切断的真实版本。
      out('\x1b[');
      setTimeout(() => { out('31mSPLIT\x1b[0m\r\n'); }, 20);
      break;
    case 't':
      // 问尺寸。三条一起问，好断言回复的顺序和内容都对。
      // 真实程序问这个是为了排版和给图算尺寸 —— 答成整屏它就会溢进游戏区。
      out('\x1b[18t\x1b[16t\x1b[14t');
      break;
    case 'q':
      out('BYE\r\n');
      process.exit(7);
    default:
      break;
  }
}

// 自报新尺寸，让测试能断言 resize 真的传到了内层。
//
// 用 stdout 的 'resize' 事件而**不是** `process.on('SIGWINCH')`：SIGWINCH 的监听器顺序不保证在
// Node 自己刷新 `process.stdout.rows` 之后，直接在信号里读会读到**上一次**的尺寸。
// 'resize' 是文档承诺"columns/rows 已经变了"之后才发的，是唯一可靠的时机。
// （这个坑真的踩到了：内层报的一直是 resize 之前的行数，看起来像外壳没转发 resize。）
process.stdout.on('resize', () => { out(`WINCH ${process.stdout.columns}x${process.stdout.rows}\r\n`); });
// overlay 退出使用同尺寸 SIGWINCH 请求 TUI 重绘；尺寸没变时 stdout resize 不一定触发，
// 单独记录原始信号才能验证恢复请求确实送到了内层进程组。
process.on('SIGWINCH', () => { out('SIGWINCH\r\n'); if (composer) redrawComposer(); });

out('INNER-READY\r\n');
