'use strict';
/**
 * 下载编排：把「提取到的媒体 + 用户选择」变成磁盘上的文件。
 * 统一负责命名、目录、画质挑选、GIF 转换、音频提取。
 */
const path = require('path');
const fs = require('fs');
const { download, safeName, uniquePath, humanSize } = require('./util');
const { fetchTweet, resolveQualityLadder, isAnimatedGif } = require('./tweet');
const convert = require('./convert');

/** 一条推文 → 带画质档位的完整清单（供 UI / CLI 展示） */
async function analyze(url, opts) {
  opts = opts || {};
  const tweet = await fetchTweet(url, { onStatus: opts.onStatus });
  const media = [];

  for (const item of tweet.items) {
    if (item.kind === 'video') {
      const ladder = await resolveQualityLadder(item, { onStatus: opts.onStatus });
      media.push({
        kind: 'video',
        mediaId: item.mediaId,
        isGif: isAnimatedGif(item),
        width: item.width,
        height: item.height,
        durationMs: item.durationMs,
        thumb: item.thumb,
        qualities: ladder.map((q) => ({
          label: q.label,
          width: q.width,
          height: q.height,
          bitrate: q.bitrate,
          url: q.url,
          hlsUrl: q.hlsUrl,
          needsRemux: !!q.needsRemux,
          isDefault: !!q.isDefault,
        })),
      });
    } else {
      media.push({
        kind: 'image',
        mediaId: item.mediaId,
        width: item.width,
        height: item.height,
        thumb: item.thumb,
        qualities: (item.variants || []).map((v) => ({
          label: v.label,
          url: v.url,
          contentType: v.contentType,
          isDefault: v.label === 'orig',
        })),
      });
    }
  }

  return {
    id: tweet.id,
    screenName: tweet.screenName,
    authorName: tweet.authorName,
    text: tweet.text,
    sourceUrl: tweet.sourceUrl,
    requestedUrl: tweet.requestedUrl,
    media,
  };
}

/**
 * 执行下载。
 * selection: [{ mediaIndex, qualityIndex }]
 * options: { outDir, gif: 'preset'|null, audio: 'm4a'|'mp3'|null, onProgress }
 */
async function downloadSelection(analysis, selection, options) {
  options = options || {};
  const outDir = options.outDir || path.join(process.cwd(), 'downloads');
  fs.mkdirSync(outDir, { recursive: true });

  const stem = safeName(
    (analysis.screenName || 'x') + '_' + analysis.id,
    'x_' + analysis.id
  );

  const results = [];
  const warns = [];

  for (let si = 0; si < selection.length; si++) {
    const sel = selection[si];
    const media = analysis.media[sel.mediaIndex];
    if (!media) { warns.push('选择项 #' + sel.mediaIndex + ' 不存在，已跳过'); continue; }

    const q = media.qualities[sel.qualityIndex] || media.qualities[media.qualities.length - 1];
    if (!q || !q.url) {
      if (q && q.hlsUrl) {
        warns.push('该画质只有 HLS 流，暂不支持直接下载（' + q.label + '）');
      } else {
        warns.push('该媒体没有可用的直链，已跳过');
      }
      continue;
    }

    const idxSuffix = analysis.media.length > 1 ? '_' + (sel.mediaIndex + 1) : '';
    const tag = options.onProgress ? (n) => options.onProgress({
      stage: 'download', index: si, total: selection.length, item: media, got: n.got, totalBytes: n.total,
    }) : null;

    if (media.kind === 'image') {
      const ext = q.contentType === 'image/png' ? '.png' : '.jpg';
      const dest = uniquePath(outDir, stem + idxSuffix + (q.label !== 'orig' ? '_' + q.label : ''), ext);
      const r = await download(q.url, dest, {
        onProgress: tag ? (got, total) => tag({ got, total }) : undefined,
      });
      results.push({ kind: 'image', path: dest, bytes: r.bytes, label: q.label });
      continue;
    }

    // ---- 视频 ----
    const tmpMp4 = path.join(outDir, '.' + stem + idxSuffix + '.src' + (process.pid) + '.mp4');
    let srcPath = tmpMp4;
    try {
      const r = await download(q.url, srcPath, {
        onProgress: tag ? (got, total) => tag({ got, total }) : undefined,
      });

      // 老式 tweet_video 直链其实常常是无声的，但只要用户要音频就统一处理
      if (options.gif) {
        const gifName = stem + idxSuffix + (options.gifSuffix || '') + '.gif';
        const dest = uniquePath(outDir, gifName.replace(/\.gif$/, ''), '.gif');
        if (options.onStatus) options.onStatus('转换 GIF');
        const g = await convert.videoToGif(srcPath, dest, {
          preset: options.gif, onStatus: options.onStatus,
        });
        results.push({ kind: 'gif', path: g.path, bytes: g.bytes });
      } else if (options.audio) {
        // 只要音频
        const fmt = options.audio;
        const dest = uniquePath(outDir, stem + idxSuffix, '.' + fmt);
        if (options.onStatus) options.onStatus('提取音频');
        const a = await convert.extractAudio(srcPath, dest, { format: fmt, onStatus: options.onStatus });
        results.push({ kind: 'audio', path: a.path, bytes: a.bytes, format: fmt });
      } else {
        const dest = uniquePath(outDir, stem + idxSuffix, '.mp4');
        if (options.onStatus) options.onStatus('保存视频');
        fs.renameSync(srcPath, dest);
        srcPath = dest;
        results.push({ kind: 'video', path: dest, bytes: r.bytes, quality: q.label });
      }
    } catch (e) {
      warns.push('处理失败: ' + e.message);
    } finally {
      // 清理临时文件：成功时它已被 rename / 转码消耗掉，失败时留下来会变成垃圾
      try {
        if (fs.existsSync(tmpMp4)) fs.unlinkSync(tmpMp4);
      } catch { /* 忽略清理失败 */ }
    }
  }

  return { results, warns, outDir };
}

/** 便捷入口：一步到位，返回分析 + 下载结果 */
async function grab(url, selection, options) {
  const analysis = await analyze(url, options);
  if (!selection || !selection.length) {
    // 默认：每个媒体取默认（最高）画质。findIndex 返回 -1 时退化为最后一档。
    selection = analysis.media.map((m, i) => {
      let qi = m.qualities.findIndex((q) => q.isDefault);
      if (qi < 0) qi = m.qualities.length - 1;
      return { mediaIndex: i, qualityIndex: qi };
    });
  }
  const down = await downloadSelection(analysis, selection, options);
  return { analysis, download: down };
}

module.exports = { analyze, downloadSelection, grab, humanSize };
