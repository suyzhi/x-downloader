'use strict';
/**
 * 转换模块：把下载到的媒体转成 GIF / 提取音频 / 转封装，
 * 以及把视频的静止画面转成 GIF 的高质量两步法（调色板）。
 * 全部依赖 ffmpeg / ffprobe，缺失时给出明确提示而不是静默失败。
 */
const path = require('path');
const fs = require('fs');
const { whichExe, run, uniquePath } = require('./util');

let _ffmpeg = undefined;
let _ffprobe = undefined;

async function findFfmpeg() {
  if (_ffmpeg === undefined) _ffmpeg = await whichExe('ffmpeg');
  return _ffmpeg;
}
async function findFfprobe() {
  if (_ffprobe === undefined) _ffprobe = await whichExe('ffprobe');
  return _ffprobe;
}

async function requireFfmpeg() {
  const ff = await findFfmpeg();
  if (!ff) {
    throw new Error('未找到 ffmpeg。GIF 转换 / 音频提取 / 转封装都需要它。\n' +
      '  安装方式（任选其一）：\n' +
      '    winget install Gyan.FFmpeg\n' +
      '    scoop install ffmpeg\n' +
      '    choco install ffmpeg\n' +
      '  安装后重开终端，或把 ffmpeg.exe 所在目录加进 PATH。');
  }
  return ff;
}

/** 用 ffprobe 读媒体信息 */
async function probe(file) {
  const fp = await findFfprobe();
  const ff = await findFfmpeg();
  const bin = fp || ff;
  if (!bin) return null;
  const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file];
  const exe = fp ? bin : bin;
  const r = await run(fp ? fp : ff, args);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    return {
      duration: j.format && j.format.duration ? Number(j.format.duration) : null,
      size: j.format && j.format.size ? Number(j.format.size) : null,
      width: v ? v.width : null,
      height: v ? v.height : null,
      vcodec: v ? v.codec_name : null,
      acodec: a ? a.codec_name : null,
      fps: v && v.avg_frame_rate ? evalFps(v.avg_frame_rate) : null,
      hasAudio: !!a,
      hasVideo: !!v,
    };
  } catch { return null; }
}

function evalFps(s) {
  const m = String(s).match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  const d = Number(m[2]);
  return d ? Number(m[1]) / d : null;
}

/** GIF 转换预设：兼顾体积与观感 */
const GIF_PRESETS = {
  small:   { width: 320, fps: 10, dither: 'bayer', colors: 128, label: '小体积 (320px)' },
  medium:  { width: 480, fps: 12, dither: 'bayer', colors: 256, label: '均衡 (480px)' },
  large:   { width: 540, fps: 15, dither: 'bayer', colors: 256, label: '较清晰 (540px)' },
  original:{ width: 0,   fps: 15, dither: 'bayer', colors: 256, label: '原始宽度 (15fps)' },
  max:     { width: 0,   fps: 0,  dither: 'sierra2_4a', colors: 256, label: '最高质量 (原帧率)' },
};

/**
 * 视频转 GIF：两遍法（先统计最优调色板，再套用）。
 * 相比 ffmpeg 默认的单遍输出，色带与噪点明显更少。
 */
async function videoToGif(input, output, opts) {
  opts = opts || {};
  const ff = await requireFfmpeg();
  const preset = GIF_PRESETS[opts.preset] || GIF_PRESETS.medium;

  const width = opts.width != null ? opts.width : preset.width;
  const fps = opts.fps != null ? opts.fps : preset.fps;
  const colors = opts.colors != null ? opts.colors : preset.colors;
  const dither = opts.dither || preset.dither;

  const scale = width > 0 ? `scale=${width}:-1:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos';
  const fpsFilter = fps > 0 ? `fps=${fps},` : '';

  const palette = path.join(path.dirname(output), '.palette-' + process.pid + '-' + Date.now() + '.png');
  const vfPalette = `${fpsFilter}${scale},palettegen=max_colors=${colors}:stats_mode=diff`;
  const vfUse = `${fpsFilter}${scale}[x];[x][1:v]paletteuse=dither=${dither}:diff_mode=rectangle`;

  try {
    if (opts.onStatus) opts.onStatus('生成调色板（第一遍）');
    let r = await run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vfPalette, palette]);
    if (r.code !== 0) throw new Error('调色板生成失败: ' + r.stderr.trim().split('\n').slice(-3).join(' '));

    if (opts.onStatus) opts.onStatus('写入 GIF（第二遍）');
    r = await run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-i', palette,
      '-lavfi', vfUse, '-loop', '0', output]);
    if (r.code !== 0) throw new Error('GIF 写入失败: ' + r.stderr.trim().split('\n').slice(-3).join(' '));
  } finally {
    try { if (fs.existsSync(palette)) fs.unlinkSync(palette); } catch { /* 忽略 */ }
  }
  return { path: output, bytes: fs.statSync(output).size };
}

/** 从视频里提取音频 */
async function extractAudio(input, output, opts) {
  opts = opts || {};
  const ff = await requireFfmpeg();
  const format = opts.format || 'm4a';
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn'];
  if (opts.start != null) args.splice(args.indexOf('-i'), 0, '-ss', String(opts.start));
  if (opts.duration != null) args.push('-t', String(opts.duration));

  if (format === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', String(opts.quality != null ? opts.quality : 2));
  else if (format === 'm4a') args.push('-c:a', 'aac', '-b:a', opts.bitrate || '192k');
  else if (format === 'wav') args.push('-c:a', 'pcm_s16le');
  else if (format === 'opus') args.push('-c:a', 'libopus', '-b:a', opts.bitrate || '128k');
  else args.push('-c:a', 'copy');
  args.push(output);

  if (opts.onStatus) opts.onStatus('提取音频 (' + format + ')');
  const r = await run(ff, args);
  if (r.code !== 0) throw new Error('音频提取失败: ' + r.stderr.trim().split('\n').slice(-3).join(' '));
  return { path: output, bytes: fs.statSync(output).size };
}

/** 只下载音频轨（无 ffmpeg 时的兜底路径不可用，这里仍需 ffmpeg 分离） */
async function remux(input, output, opts) {
  opts = opts || {};
  const ff = await requireFfmpeg();
  if (opts.onStatus) opts.onStatus('转封装');
  const r = await run(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-c', 'copy', output]);
  if (r.code !== 0) throw new Error('转封装失败: ' + r.stderr.trim().split('\n').slice(-3).join(' '));
  return { path: output, bytes: fs.statSync(output).size };
}

module.exports = { videoToGif, extractAudio, remux, probe, requireFfmpeg, findFfmpeg, GIF_PRESETS };
