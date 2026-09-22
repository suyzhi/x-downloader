'use strict';
/**
 * 核心提取库：给定一条 X/Twitter 推文链接，解析出其中的
 * 视频 / GIF / 图片 / 音频，并给出画质选项。
 *
 * 原理：X 的推文页在服务端渲染时会把完整媒体信息内联进 HTML
 * （RSC 序列化数据，含 media_entities 与 video_info.variants）。
 * 无需登录、无需 API key，直接解析这段内联数据即可拿到直链。
 */
const { httpText, httpGet } = require('./util');

const UA_REFERER = { referer: 'https://x.com/' };

/** 从各种形态的 X/Twitter 链接里取出 { screenName, id } */
function parseTweetUrl(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/(?:twitter\.com|x\.com|mobile\.twitter\.com|mobile\.x\.com)\/([^/?#]+)\/status(?:es)?\/(\d+)/i);
  if (m) return { screenName: m[1], id: m[2] };
  const m2 = raw.match(/^\s*(\d{15,25})\s*$/);
  if (m2) return { screenName: null, id: m2[1] };
  return null;
}

/** 把 X 的 JS 字面量（布尔 !0 / !1）转成可求值形式 */
function normalizeJs(s) {
  return s.replace(/:!0(?=[,}\]])/g, ':true').replace(/:!1(?=[,}\]])/g, ':false');
}

/** 把 RSC 序列化数据的 $R[n]= 定义抽出来，并支持 __ref / __refs 解引用 */
let keyIndexOf = () => null;

function makeResolver(html) {
  const store = new Map();
  const defRe = /\$R\[(\d+)\]\s*=\s*/g;
  let m;
  while ((m = defRe.exec(html)) !== null) {
    const id = Number(m[1]);
    // 关键：不能用「下一个定义的位置」来截断——嵌套对象定义在父对象之后，
    // 那样会把父对象切碎。这里按括号配平扫描，精确取出这一段字面量。
    store.set(id, readBalanced(html, m));
  }
  // 建立 __id 字符串 -> 定义下标 的索引，供引用展开使用
  const keyToIdx = new Map();
  for (const [idx, raw] of store) {
    const k = raw.match(/^\{\s*__id:"((?:[^"\\]|\\.)*)"/);
    if (k) keyToIdx.set(k[1], idx);
  }
  keyIndexOf = (key) => {
    const idx = keyToIdx.get(key);
    if (idx == null) return null;
    return (d) => resolve(idx, d);
  };
  // 记忆化：同一个 $R 定义在整页里会被反复引用（父对象、兄弟对象、
  // 以及多处列表都指向它）。不缓存的话每次引用都要重新求值并展开整棵
  // 子树——实测 476 个定义会产生 12000+ 次求值，约 25 倍冗余。
  const memo = new Map();
  // 求值函数也缓存：new Function 的编译开销远大于执行开销，
  // 同一个定义在整页里只应编译一次。
  const compiled = new Map();

  const resolve = (id, depth) => {
    depth = depth || 0;
    if (depth > 16) return null;
    if (memo.has(id)) return memo.get(id);
    const raw = store.get(id);
    if (raw == null) return null;
    let val;
    try {
      let fn = compiled.get(id);
      if (!fn) {
        // eslint-disable-next-line no-new-func
        fn = new Function('$R', 'return (' + normalizeJs(raw) + ')');
        compiled.set(id, fn);
      }
      val = fn((x) => resolve(x, depth + 1));
    } catch { val = null; }
    const out = val == null ? null : materialize(val, resolve, depth);
    memo.set(id, out);
    return out;
  };
  // 暴露原始文本读取（粗筛用）：避免为了「看看有没有媒体」而先求值整棵对象
  resolve.rawDef = (id) => store.get(id);
  return resolve;
}

/** 从 pos 处的定义起点开始，读出一个配平的 JS 字面量（对象/数组/标量） */
function readBalanced(html, defMatch) {
  let i = defMatch.index + defMatch[0].length;
  // 跳过空白
  while (i < html.length && /\s/.test(html[i])) i++;
  const c = html[i];

  if (c === '{' || c === '[') {
    const open = c;
    const close = c === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let quote = '';
    for (let j = i; j < html.length; j++) {
      const ch = html[j];
      if (inStr) {
        if (ch === '\\') { j++; continue; }
        if (ch === quote) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; quote = ch; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return html.slice(i, j + 1);
      }
    }
    return html.slice(i);
  }

  // 标量：读到下一个逗号或右括号为止
  let j = i;
  while (j < html.length && !/[,\}\]]/.test(html[j])) j++;
  return html.slice(i, j);
}

/**
 * 把 {__ref:"..."} / {__refs:[...]} 形式的引用就地展开成真实对象。
 * X 的数据是图结构：父对象的字段常常只是指向另一个 $R 定义的引用。
 */
function materialize(val, resolve, depth) {
  if (val == null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map((v) => materialize(v, resolve, depth));
  if (typeof val.__ref === 'string') return resolveByKey(val.__ref, depth);
  if (Array.isArray(val.__refs)) return val.__refs.map((r) => resolveByKey(r, depth));
  const out = {};
  for (const k of Object.keys(val)) {
    if (k === '__id' || k === '__typename') { out[k] = val[k]; continue; }
    out[k] = materialize(val[k], resolve, depth);
  }
  return out;
}

/** 按 __id 字符串反查定义：resolve 只认数字下标，这里补一层字符串索引 */
function resolveByKey(key, depth) {
  if (depth > 16) return null;
  const id = keyIndexOf(key);
  return id == null ? null : id(depth);
}

/** 兜底：直接从 HTML 正则刮出全部 video variant 直链 */
function scrapeVariantsFromHtml(html) {
  const out = [];
  const seen = new Set();
  const re = /bitrate:(\d+|null),content_type:"([^"]+)",url:"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u = m[3].replace(/\\u002F/g, '/');
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ bitrate: m[1] === 'null' ? null : Number(m[1]), contentType: m[2], url: u });
  }
  return out;
}

/** 兜底：抓取 tweet_video/ 形式的直链（老式 GIF / 短视频，无 video_info） */
function scrapeTweetVideos(html) {
  const out = [];
  const seen = new Set();
  const re = /https:\/\/video\.twimg\.com\/tweet_video\/([A-Za-z0-9_-]+)\.mp4/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[0];
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ stem: m[1], url: u });
  }
  return out;
}

function scrapeMediaIds(html) {
  const ids = new Set();
  const re = /amplify_video(?:_thumb)?\/(\d{15,25})/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

/**
 * 单遍扫描：把页面上所有「兜底用」的媒体线索一次性收集齐。
 *
 * 原先是在几个不同位置分别调用 scrapeVariantsFromHtml / scrapeMediaIds /
 * scrapeTweetVideos，每个都从头到尾扫一遍近 200KB 的 HTML，同一段文本被
 * 反复走 7 次。这里合并成一次遍历，把三类线索一起抓出来。
 */
function scanMediaHints(html) {
  const variants = [];
  const variantSeen = new Set();
  const mediaIds = new Set();
  const tweetVideos = [];
  const tweetVideoSeen = new Set();
  const thumbRe = /https:\/\/pbs\.twimg\.com\/amplify_video_thumb\/\d+\/img\/[A-Za-z0-9_-]+/;

  const varRe = /bitrate:(\d+|null),content_type:"([^"]+)",url:"([^"]+)"/g;
  let m;
  while ((m = varRe.exec(html)) !== null) {
    const u = m[3].replace(/\\u002F/g, '/');
    if (variantSeen.has(u)) continue;
    variantSeen.add(u);
    variants.push({ bitrate: m[1] === 'null' ? null : Number(m[1]), contentType: m[2], url: u });
  }

  const idRe = /amplify_video(?:_thumb)?\/(\d{15,25})/g;
  while ((m = idRe.exec(html)) !== null) mediaIds.add(m[1]);

  const tvRe = /https:\/\/video\.twimg\.com\/tweet_video\/([A-Za-z0-9_-]+)\.mp4/g;
  while ((m = tvRe.exec(html)) !== null) {
    if (tweetVideoSeen.has(m[0])) continue;
    tweetVideoSeen.add(m[0]);
    tweetVideos.push({ stem: m[1], url: m[0] });
  }

  const thumb = html.match(thumbRe);
  return {
    variants,
    mediaIds: Array.from(mediaIds),
    tweetVideos,
    firstThumb: thumb ? thumb[0] : null,
  };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}


/** 抓推文页（多镜像回退） */
async function fetchTweetHtml(inputUrl, onStatus) {
  const parsed = parseTweetUrl(inputUrl);
  if (!parsed) throw new Error('无法识别的推文链接: ' + inputUrl);
  const candidates = [];
  if (parsed.screenName) {
    candidates.push('https://x.com/' + parsed.screenName + '/status/' + parsed.id);
    candidates.push('https://twitter.com/' + parsed.screenName + '/status/' + parsed.id);
  }
  candidates.push('https://x.com/i/status/' + parsed.id);
  candidates.push('https://mobile.x.com/i/status/' + parsed.id);

  let fallback = null;
  let lastErr = null;
  for (const u of candidates) {
    try {
      if (onStatus) onStatus('抓取 ' + u);
      const res = await httpGet(u, { headers: Object.assign({ accept: 'text/html,application/xhtml+xml' }, UA_REFERER) });
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
      const text = await res.text();
      if (text.includes('amplify_video') || text.includes('pbs.twimg.com/media')) {
        return { html: text, url: u, parsed };
      }
      if (!fallback) fallback = { html: text, url: u, parsed };
    } catch (e) { lastErr = e; }
  }
  if (fallback) return fallback;
  throw new Error('推文抓取失败: ' + (lastErr ? lastErr.message : '所有镜像均无响应'));
}


/** 把 pbs 图片 base url 展开为多档尺寸 */
function photoVariantsFrom(base) {
  const clean = String(base).split('?')[0];
  return [
    { label: 'orig', contentType: 'image/jpeg', url: clean + '?format=jpg&name=orig' },
    { label: 'large', contentType: 'image/jpeg', url: clean + '?format=jpg&name=large' },
    { label: 'medium', contentType: 'image/jpeg', url: clean + '?format=jpg&name=medium' },
    { label: 'small', contentType: 'image/jpeg', url: clean + '?format=jpg&name=small' },
    { label: 'png', contentType: 'image/png', url: clean + '?format=png&name=orig' },
  ];
}

function resolutionOf(url) {
  const m = String(url).match(/\/avc1\/(\d+)x(\d+)\//) || String(url).match(/\/(\d+)x(\d+)\//);
  return m ? m[1] + 'x' + m[2] : null;
}

/** 从已拿到的 HTML 中抽出结构化推文信息 */
function extractFromHtml(html, id) {
  const resolve = makeResolver(html);
  const rawDef = resolve.rawDef;
  const storeKeys = [];
  {
    const re = /\$R\[(\d+)\]\s*=/g;
    let m;
    while ((m = re.exec(html)) !== null) storeKeys.push(Number(m[1]));
  }

  // X 的推文页里除了目标推文，还会内联「引用的推文」「相关推文」等数据。
  // media 数据的 __id 形如 "client:VHdlZXQ6<base64(tweet:rest_id)>:media_entities2:0"，
  // 其中 VHdlZXQ6 后面那段 base64 解码后就是 "Tweet:<id>"，用它精确锁定目标推文。
  const tweetB64 = Buffer.from('Tweet:' + id, 'utf8').toString('base64');
  const scopedPredicate = (v) => {
    const key = String(v.__id || '');
    if (!key) return false;
    // 归属未知时（兜底/旧结构）也接受
    const owner = key.match(/client:([A-Za-z0-9+/=]+):/);
    if (!owner) return true;
    return owner[1] === tweetB64;
  };

  const media = [];
  const seenMedia = new Set();
  const legacy = [];
  for (const key of storeKeys) {
    let v = null;
    try { v = resolve(key); } catch { continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (v.__typename === 'ApiMediaEntity' || (v.type && v.media_url_https && v.id_str)) {
      if (!scopedPredicate(v)) continue;
      const mid = v.id_str || v.media_key;
      if (mid && seenMedia.has(mid)) continue;
      if (mid) seenMedia.add(mid);
      media.push(v);
    } else if (v.__typename === 'LegacyTweet' || typeof v.full_text === 'string') {
      if (!scopedPredicate(v)) continue;
      legacy.push(v);
    }
  }

  // 作者 / 正文
  let screenName = null;
  let authorName = null;
  let text = null;
  {
    const m = html.match(/"(?:screen_name|screenName)":"([A-Za-z0-9_]+)"/);
    if (m) screenName = m[1];
    const mn = html.match(/<meta property="og:title" content="([^"]*)"/);
    if (mn) authorName = decodeEntities(mn[1]);
    for (const l of legacy) {
      if (typeof l.full_text === 'string' && l.full_text.trim()) { text = l.full_text; break; }
    }
    if (text != null) text = decodeEntities(text);
    if (text == null) {
      const mt = html.match(/<meta property="og:description" content="([^"]*)"/);
      if (mt) {
        const d = decodeEntities(mt[1]);
        const mm = d.match(/on X:\s*"([\s\S]*)"\s*$/);
        text = mm ? mm[1] : (d.indexOf(' on X') >= 0 ? '' : d);
      }
    }
    if (text == null) text = '';
  }

  const hints = scanMediaHints(html);
  const scraped = hints.variants;

  // 没有任何结构化媒体时，用正则兜底
  if (media.length === 0) {
    for (const mid of hints.mediaIds) media.push({ id_str: mid, type: 'video', __scraped: true });
  }

  const items = [];
  const pushImage = (m) => {
    const thumb = m.media_url_https;
    if (!thumb) return;
    items.push({
      kind: 'image', mediaId: m.id_str || 'photo', type: 'photo',
      thumb, width: m.original_info && m.original_info.width,
      height: m.original_info && m.original_info.height,
      variants: photoVariantsFrom(thumb),
    });
  };

  for (const m of media) {
    const vi = m.video_info || null;
    let variants = [];
    if (vi && Array.isArray(vi.variants)) {
      variants = vi.variants.map((v) => ({
        bitrate: v.bitrate == null ? null : Number(v.bitrate),
        contentType: v.content_type,
        url: String(v.url).replace(/\\u002F/g, '/'),
      }));
    }
    const isVideo = m.type === 'video' || m.type === 'animated_gif' || (vi && variants.length);
    if (!isVideo) { pushImage(m); continue; }
    items.push({
      kind: 'video', mediaId: m.id_str || 'video', type: m.type || 'video',
      thumb: m.media_url_https || null,
      durationMs: vi && vi.duration_millis ? vi.duration_millis : null,
      width: m.original_info && m.original_info.width,
      height: m.original_info && m.original_info.height,
      variants,
    });
  }

  // 老式 tweet_video/ 直链（GIF / 短视频）：没有 video_info，单独作为视频项收进来。
  // 但要避免和已有的结构化视频重复（同一推文可能两者都有）。
  {
    const tvs = hints.tweetVideos;
    const already = new Set(items.filter((i) => i.kind === 'video').map((i) => i.mediaId));
    // 预先把所有已存在的 variant 直链收进 Set，避免对每个候选都线性扫一遍 items
    const knownUrls = new Set();
    for (const it of items) {
      for (const v of (it.variants || [])) knownUrls.add(v.url);
    }
    for (const tv of tvs) {
      if (already.has(tv.stem)) continue;
      if (knownUrls.has(tv.url)) continue;
      items.push({
        kind: 'video', mediaId: tv.stem, type: 'animated_gif',
        thumb: null, durationMs: null, width: null, height: null,
        isLegacyGif: true,
        variants: [{ bitrate: null, contentType: 'video/mp4', url: tv.url }],
      });
    }
  }

  // 结构化数据没给出 variants 时，用全量刮取补齐
  if (scraped.length) {
    let vids = items.filter((i) => i.kind === 'video');
    if (!vids.length) {
      items.push({
        kind: 'video', mediaId: hints.mediaIds[0] || 'video', type: 'video',
        thumb: hints.firstThumb, durationMs: null,
        width: null, height: null, variants: scraped,
      });
    } else {
      for (const v of vids) {
        if (!v.variants.length) { v.variants = scraped; break; }
      }
    }
  }

  return { id, screenName, authorName, text, items, html };
}

/** 一站式：抓取 + 解析 */
async function fetchTweet(inputUrl, opts) {
  opts = opts || {};
  const { html, url, parsed } = await fetchTweetHtml(inputUrl, opts.onStatus);
  const t = extractFromHtml(html, parsed.id);
  t.sourceUrl = url;
  t.requestedUrl = inputUrl;
  if (parsed.screenName) t.screenName = parsed.screenName;
  delete t.html; // 不要把整页 HTML 传给调用方
  return t;
}

/** 解析 HLS master playlist，得到权威画质档位 */
function parseMasterPlaylist(text, baseUrl) {
  const levels = [];
  const lines = String(text).split(/\r?\n/);
  const base = new URL(baseUrl);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
    const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
    const bw = line.match(/BANDWIDTH=(\d+)/);
    const abw = line.match(/AVERAGE-BANDWIDTH=(\d+)/);
    const codecs = line.match(/CODECS="([^"]+)"/);
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l || l.charAt(0) === '#') continue;
      try { uri = new URL(l, base).toString(); } catch { uri = l; }
      break;
    }
    levels.push({
      width: res ? Number(res[1]) : null,
      height: res ? Number(res[2]) : null,
      resolution: res ? res[1] + 'x' + res[2] : null,
      bandwidth: bw ? Number(bw[1]) : null,
      avgBandwidth: abw ? Number(abw[1]) : null,
      codecs: codecs ? codecs[1] : null,
      url: uri,
    });
  }
  return { levels };
}

/**
 * 把一条视频的 variants 整理成画质档位列表。
 * HLS master 给最权威的档位与真实分辨率，优先展开；
 * 每个档位尽量配上对应的 mp4 直链，没有则保留 HLS 变体地址。
 */
async function resolveQualityLadder(videoItem, opts) {
  opts = opts || {};
  const variants = videoItem.variants || [];
  const master = variants.find((v) => v.contentType === 'application/x-mpegURL');
  const mp4s = variants
    .filter((v) => v.contentType === 'video/mp4')
    .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));

  let ladder = null;
  if (master) {
    try {
      if (opts.onStatus) opts.onStatus('读取 HLS 画质清单');
      const txt = await httpText(master.url, { headers: UA_REFERER });
      ladder = parseMasterPlaylist(txt, master.url);
    } catch { ladder = null; }
  }

  const out = [];
  if (ladder && ladder.levels.length) {
    for (const lv of ladder.levels) {
      const match = mp4s.find((p) => resolutionOf(p.url) === lv.resolution)
        || mp4s.find((p) => lv.bandwidth && Math.abs((p.bitrate || 0) - lv.bandwidth) < lv.bandwidth * 0.4);
      out.push({
        label: lv.resolution || 'unknown',
        width: lv.width, height: lv.height,
        bitrate: match ? match.bitrate : lv.bandwidth,
        avgBandwidth: lv.avgBandwidth,
        url: match ? match.url : null,
        hlsUrl: lv.url,
        codecs: lv.codecs,
        needsRemux: !match,
      });
    }
  }

  for (const p of mp4s) {
    const res = resolutionOf(p.url);
    if (out.some((o) => o.label === res)) continue;
    const wh = res ? res.split('x') : [null, null];
    out.push({
      label: res || String(p.bitrate || 0),
      width: wh[0] ? Number(wh[0]) : null,
      height: wh[1] ? Number(wh[1]) : null,
      bitrate: p.bitrate, url: p.url, hlsUrl: null, needsRemux: false,
    });
  }

  out.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
  out.forEach((o, i) => { o.index = i; o.isDefault = i === out.length - 1; });
  return out;
}

/**
 * 这条媒体是不是「动图」。
 * 判据：X 把上传的 GIF 转码成 mp4 并标成 animated_gif；
 * 另外 HLS 档位里会出现分辨率与时长都异常的极低码率档。
 * 这里以 type 为准，因为它是 X 官方标注，最可靠。
 */
function isAnimatedGif(item) {
  return item.kind === 'video' && item.type === 'animated_gif';
}

module.exports = {
  parseTweetUrl, fetchTweet, fetchTweetHtml, extractFromHtml,
  resolveQualityLadder, parseMasterPlaylist, photoVariantsFrom,
  isAnimatedGif, resolutionOf,
};
