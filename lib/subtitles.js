'use strict';
/**
 * 字幕：把 HLS master 里列出的字幕轨下载下来，整理成 .srt / .vtt。
 *
 * X 的字幕轨是一个 media playlist，里面是若干 WebVTT 分段（实测都只有 1 段），
 * 每段都自带 WEBVTT 头。自动生成的字幕还会把每句包在
 * <X-word-ms ms=... character_ranges=...> 这种逐词计时标签里，
 * 多数播放器会把这种标签原样显示出来。这里统一做：
 *   合并分段（去掉每段的头部块）→ 去标签、解实体 → 排序去重 → 输出。
 * 纯文本处理，不依赖 ffmpeg。
 */
const fs = require('fs');
const { httpText } = require('./util');

// 与抓 HLS 清单时一样带上 x.com 的 Referer
const REFERER = { referer: 'https://x.com/' };

// WebVTT 时间戳：小时可省略（mm:ss.ttt），小时位数不限；顺带容忍逗号小数点
const TS = '(?:(\\d+):)?(\\d{2}):(\\d{2})[.,](\\d{3})';
// 时间行：起止时间之后可以跟 cue 设置（align:start position:10% 等），一并丢掉
const TIMING_RE = new RegExp('^' + TS + '[ \\t]+-->[ \\t]+' + TS + '(?:[ \\t].*)?$');

// 文字相同、前后相接（间隔不超过这么多毫秒）的两条 cue 合并成一条
const JOIN_GAP_MS = 100;

// WebVTT 规范里的具名实体，外加常见的 quot / apos。
// 不可见字符用码位生成，不直接写进源码，免得被编辑器悄悄吞掉或换成空格。
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: String.fromCharCode(0xa0), lrm: String.fromCharCode(0x200e), rlm: String.fromCharCode(0x200f),
};

/** 去掉开头的 BOM（U+FEFF） */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 解 WebVTT 里的字符实体：一遍替换，避免 &amp;lt; 被解两次 */
function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z]+));/g, (all, dec, hex, name) => {
    if (name) return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : all;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  });
}

/**
 * cue 正文 → 纯文本。
 * 先去标签再解实体：&lt;i&gt; 解出来的是正文里的字面量，不能再当标签删掉。
 * 标签一律去掉：<X-word-ms ...>、<c.xxx>、<v 说话人>、<i>/<b>/<u>、<ruby>/<rt>、
 * <lang xx>，以及 <00:00:01.500> 这种卡拉 OK 时间戳标签。
 * 标签不跨行匹配：落单的「<」不会把后面几行正文一起吞掉。
 * 每行去首尾空白，丢掉空行（SRT 里空行就是 cue 的结束）。
 */
function cleanCueText(raw) {
  return raw
    .replace(/<[^>\n]*>/g, '')
    .split('\n')
    .map((l) => decodeEntities(l).trim())
    .filter(Boolean)
    .join('\n');
}

function tsToMs(m, k) {
  return ((Number(m[k] || 0) * 60 + Number(m[k + 1])) * 60 + Number(m[k + 2])) * 1000 + Number(m[k + 3]);
}

/**
 * 解析一段 WebVTT，返回 [{ start, end, text }]（毫秒）。
 * 以空行分块：带 --> 的块是 cue（时间行前面至多一行 cue 标识），
 * 其余的 WEBVTT 头（含 X-TIMESTAMP-MAP）、NOTE / STYLE / REGION 块都跳过。
 * X-TIMESTAMP-MAP 不做换算：X 的字幕时间本来就以视频开头为 0。
 */
function parseVtt(text) {
  const lines = stripBom(String(text == null ? '' : text)).split(/\r\n|\r|\n/);
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const block = [];
    while (i < lines.length && lines[i].trim()) block.push(lines[i++]);
    const t = block.findIndex((l) => l.includes('-->'));
    if (t < 0 || t > 1) continue;
    const m = block[t].trim().match(TIMING_RE);
    if (!m) continue;
    const body = cleanCueText(block.slice(t + 1).join('\n'));
    if (!body) continue;
    cues.push({ start: tsToMs(m, 1), end: tsToMs(m, 5), text: body });
  }
  return cues;
}

/**
 * 合并多段 WebVTT 的 cue：按开始时间排序；
 * HLS 分段边界上的同一条 cue 会在相邻两段里各出现一次，完全相同的只留一条
 * （按「起止 + 文字」去重，同一时刻有几条不同 cue 时也不会漏判）；
 * 文字相同、时间首尾相接的（自动字幕偶尔把一句拆成几条）合并成一条。
 */
function mergeVtt(texts) {
  const all = [];
  for (const t of [].concat(texts)) all.push(...parseVtt(t));
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  const seen = new Set();
  const out = [];
  for (const c of all) {
    const key = c.start + '|' + c.end + '|' + c.text;
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = out[out.length - 1];
    if (prev && prev.text === c.text && c.start <= prev.end + JOIN_GAP_MS) {
      if (c.end > prev.end) prev.end = c.end;
      continue;
    }
    out.push({ start: c.start, end: c.end, text: c.text });
  }
  return out;
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function fmtTime(ms, sep) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + sep + pad(ms % 1000, 3);
}

/** cue → SRT：从 1 编号，时间用逗号小数点 */
function toSrt(cues) {
  return cues.map((c, i) => (i + 1) + '\n'
    + fmtTime(c.start, ',') + ' --> ' + fmtTime(c.end, ',') + '\n'
    + c.text + '\n').join('\n');
}

/** cue → 整理后的 WebVTT：正文是纯文本，& < > 要转回实体 */
function toVtt(cues) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return 'WEBVTT\n\n' + cues.map((c) => fmtTime(c.start, '.') + ' --> ' + fmtTime(c.end, '.') + '\n'
    + esc(c.text) + '\n').join('\n');
}

/** 字幕轨 media playlist → 各分段的绝对地址 */
function parseMediaPlaylist(text, baseUrl) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.charAt(0) === '#') continue;
    try { out.push(new URL(l, baseUrl).toString()); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 下载一条字幕轨的全部分段并合并成 cue 列表；地址直接就是 .vtt 时也能处理 */
async function fetchCues(track) {
  const opts = { headers: REFERER };
  const first = await httpText(track.url, opts);
  if (/^WEBVTT/.test(stripBom(first))) return mergeVtt([first]);
  const segs = parseMediaPlaylist(first, track.url);
  if (!segs.length) throw new Error('字幕清单里没有分段');
  const texts = [];
  // 段数很少（实测 1 段），按顺序取即可
  for (const u of segs) texts.push(await httpText(u, opts));
  return mergeVtt(texts);
}

/**
 * 下载一条字幕轨并写到 dest。
 * options: { format: 'srt' | 'vtt' }，默认 srt。返回 { path, bytes, cues }
 */
async function saveSubtitle(track, dest, options) {
  const format = options && options.format === 'vtt' ? 'vtt' : 'srt';
  const cues = await fetchCues(track);
  if (!cues.length) throw new Error('字幕轨里没有内容');
  const body = format === 'vtt' ? toVtt(cues) : toSrt(cues);
  fs.writeFileSync(dest, body, 'utf8');
  return { path: dest, bytes: Buffer.byteLength(body, 'utf8'), cues: cues.length };
}

module.exports = { parseVtt, mergeVtt, toSrt, toVtt, parseMediaPlaylist, fetchCues, saveSubtitle };
