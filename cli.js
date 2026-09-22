#!/usr/bin/env node
'use strict';
/**
 * X-Downloader CLI
 *   交互模式:  node cli.js
 *   直接模式:  node cli.js <推文链接> [选项]
 */
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { analyze, downloadSelection } = require('./lib/download');
const { humanSize, humanDuration } = require('./lib/util');
const convert = require('./lib/convert');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', magenta: '\x1b[35m',
};
const paint = (c, s) => C[c] + s + C.reset;

/** 限流：进度回调会被调用上千次，不节流会刷屏 */
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

function parseArgs(argv) {
  const o = { urls: [], outDir: null, gif: null, audio: null, quality: null, yes: false, list: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') o.outDir = argv[++i];
    else if (a === '--gif') { const n = argv[i + 1]; o.gif = (n && !n.startsWith('-')) ? argv[++i] : 'medium'; }
    else if (a === '--audio') { const n = argv[i + 1]; o.audio = (n && !n.startsWith('-')) ? argv[++i] : 'm4a'; }
    else if (a === '-q' || a === '--quality') o.quality = argv[++i];
    else if (a === '-y' || a === '--yes') o.yes = true;
    else if (a === '-l' || a === '--list') o.list = true;
    else if (a === '--all') o.all = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!a.startsWith('-')) o.urls.push(a);
  }
  return o;
}

const HELP = `
${C.bold}X-Downloader${C.reset} — 输入 X 推文链接，提取视频 / GIF / 图片 / 音频

${C.bold}用法${C.reset}
  node cli.js                             交互模式（推荐）
  node cli.js <链接> [链接2 ...] [选项]    直接下载

${C.bold}选项${C.reset}
  -o, --out <目录>      输出目录（默认 ./downloads）
  -q, --quality <档>    画质：最高 / 1080 / 720 / 480 / 320 / 或列表序号
      --gif [预设]      转成 GIF。预设：small | medium | large | original | max
      --audio [格式]    只提取音频。格式：m4a | mp3 | wav | opus
      --all             下载全部媒体（默认只下每一项的最高画质）
  -l, --list            只列出媒体与画质，不下载
  -y, --yes             不询问，直接按默认值下载
  -h, --help            显示帮助

${C.bold}例子${C.reset}
  node cli.js https://x.com/user/status/123
  node cli.js https://x.com/user/status/123 --gif medium -o D:\\videos
  node cli.js https://x.com/user/status/123 --audio mp3
  node cli.js https://x.com/user/status/123 -q 720
`;

function rl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}
function ask(iface, q) {
  return new Promise((res) => iface.question(q, (a) => res(a.trim())));
}

/** 展示分析结果 */
function renderAnalysis(a) {
  console.log('');
  console.log(paint('cyan', '═'.repeat(64)));
  console.log(` ${paint('bold', '@' + (a.screenName || '?'))}  ${paint('dim', '推文 ' + a.id)}`);
  if (a.text) console.log(' ' + paint('dim', a.text.replace(/\s+/g, ' ').slice(0, 200)));
  console.log(paint('cyan', '═'.repeat(64)));

  if (!a.media.length) {
    console.log(paint('yellow', ' 这条推文里没有找到任何媒体。'));
    return;
  }

  a.media.forEach((m, i) => {
    const tag = m.kind === 'image' ? paint('green', '图片')
      : (m.isGif ? paint('magenta', 'GIF(动图)') : paint('yellow', '视频'));
    const dim = m.width && m.height ? ` ${paint('dim', m.width + 'x' + m.height)}` : '';
    const dur = m.durationMs ? ` ${paint('dim', humanDuration(m.durationMs))}` : '';
    console.log(`\n ${paint('bold', '[' + (i + 1) + ']')} ${tag}${dim}${dur}`);
    m.qualities.forEach((q, qi) => {
      const star = q.isDefault ? paint('green', ' ← 最高') : '';
      const br = q.bitrate ? paint('dim', (q.bitrate / 1000).toFixed(0) + ' kbps') : '';
      const w = q.width && q.height ? String(q.width + 'x' + q.height).padEnd(11) : String(q.label).padEnd(11);
      console.log(`      ${String(qi + 1).padStart(2)}. ${w} ${br}${star}`);
    });
  });
  console.log('');
}

/** 按名字/序号挑画质 */
function pickQuality(media, spec) {
  if (spec == null) {
    let qi = media.qualities.findIndex((q) => q.isDefault);
    if (qi < 0) qi = media.qualities.length - 1;
    return qi;
  }
  const s = String(spec).trim().toLowerCase();
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= media.qualities.length) return n - 1;

  if (s === '最高' || s === 'max' || s === 'best' || s === 'highest') {
    let qi = media.qualities.findIndex((q) => q.isDefault);
    return qi < 0 ? media.qualities.length - 1 : qi;
  }
  if (s === '最低' || s === 'min' || s === 'worst') return 0;

  const want = s.match(/^(\d{3,4})[pP]?$/);
  if (want) {
    const target = Number(want[1]);
    // 注意：竖屏视频的 "720p" 指的是「短边 720」，即 720x1280，
    // 它的 height 是 1280 而不是 720。所以要比的是长短边中较小的那个。
    const shortSide = (q) => {
      const w = q.width || Number((q.label || '').split('x')[0]) || 0;
      const h = q.height || Number((q.label || '').split('x')[1]) || 0;
      if (!w || !h) return 0;
      return Math.min(w, h);
    };
    // 优先精确命中；否则取不超过目标的最高档；都比目标大就取最低档。
    const exact = media.qualities.findIndex((q) => shortSide(q) === target);
    if (exact >= 0) return exact;

    let best = -1;
    let bestSide = 0;
    for (let i = 0; i < media.qualities.length; i++) {
      const side = shortSide(media.qualities[i]);
      if (!side) continue;
      if (side <= target && side > bestSide) { bestSide = side; best = i; }
    }
    if (best >= 0) return best;
    return 0;
  }
  // 直接匹配 label
  const hit = media.qualities.findIndex((q) => q.label === s);
  return hit >= 0 ? hit : media.qualities.length - 1;
}

async function runOne(url, opts) {
  console.log(paint('dim', '\n 解析中: ' + url));
  let a;
  try {
    a = await analyze(url, { onStatus: (s) => console.log(paint('dim', '   · ' + s)) });
  } catch (e) {
    console.log(paint('red', ' ✗ 解析失败: ' + e.message));
    return null;
  }
  renderAnalysis(a);

  if (!a.media.length) return null;
  if (opts.list) return { analysis: a, download: null };

  const iface = opts.yes ? null : rl();
  let selection = [];

  try {
    for (let i = 0; i < a.media.length; i++) {
      const m = a.media[i];
      let spec = opts.quality;
      if (!opts.all && !opts.quality && i === 0 && iface && a.media.length === 1) {
        // 单媒体且没指定，问一次
        const ans = await ask(iface, ` 选择画质 [默认 ${pickQuality(m, null) + 1}]: `);
        if (ans) spec = ans;
      }
      if (iface && a.media.length > 1) {
        const ans = await ask(iface, ` 媒体 [${i + 1}] 选择画质 [默认 ${pickQuality(m, null) + 1}]: `);
        if (ans) spec = ans;
      }
      selection.push({ mediaIndex: i, qualityIndex: pickQuality(m, spec) });
    }
  } finally {
    if (iface) iface.close();
  }

  const outDir = opts.outDir || path.join(process.cwd(), 'downloads');
  if (opts.gif && !(await convert.findFfmpeg())) {
    console.log(paint('yellow', ' ⚠ 未找到 ffmpeg，无法转 GIF。请先安装 ffmpeg。'));
    return null;
  }

  console.log(paint('dim', `\n 下载到: ${outDir}`));
  const r = await downloadSelection(a, selection, {
    outDir,
    gif: opts.gif,
    audio: opts.audio,
    onStatus: (s) => console.log(paint('dim', '   · ' + s)),
    onProgress: throttle((p) => {
      if (p.totalBytes) {
        const pct = Math.floor((p.got / p.totalBytes) * 100);
        process.stdout.write(`\r   ↓ ${pct}% (${humanSize(p.got)} / ${humanSize(p.totalBytes)})   `);
      } else {
        process.stdout.write(`\r   ↓ ${humanSize(p.got)}   `);
      }
    }, 100),
  });
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  for (const x of r.results) {
    const kind = { video: paint('yellow', '视频'), gif: paint('magenta', 'GIF'), image: paint('green', '图片'), audio: paint('cyan', '音频') }[x.kind] || x.kind;
    console.log(` ${paint('green', '✓')} ${kind}  ${path.basename(x.path)}  ${paint('dim', '(' + humanSize(x.bytes) + ')')}`);
  }
  for (const w of r.warns) console.log(paint('yellow', ' ⚠ ' + w));
  return { analysis: a, download: r };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.help) { console.log(HELP); return; }

  if (opts.urls.length) {
    for (const u of opts.urls) await runOne(u, opts);
    console.log('');
    return;
  }

  // 交互模式
  console.log(HELP);
  const iface = rl();
  for (;;) {
    const ans = await ask(iface, paint('bold', '\n 推文链接（直接回车退出）: '));
    if (!ans) break;
    iface.pause();
    await runOne(ans, { ...opts, yes: false });
    iface.resume();
    const more = await ask(iface, paint('dim', ' 继续下一条？(y/N): '));
    if (more.toLowerCase() !== 'y') break;
  }
  iface.close();
}

main().catch((e) => { console.error(paint('red', '出错: ' + e.message)); process.exit(1); });
