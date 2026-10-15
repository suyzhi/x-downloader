#!/usr/bin/env node
'use strict';
/**
 * 本地 Web UI：node server.js  →  浏览器打开 http://127.0.0.1:8788
 * 只监听本机回环地址，不对外暴露。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { analyze, downloadSelection } = require('./lib/download');
const { humanSize } = require('./lib/util');
const convert = require('./lib/convert');

const BASE_PORT = Number(process.env.PORT || 8788);
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

/** 限流工具 */
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, headers) {
  // 不回任何 CORS 头：别的网站既读不到响应，也过不了预检
  res.writeHead(code, Object.assign({
    'cache-control': 'no-store',
  }, headers || {}));
  res.end(body);
}
function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
}

/**
 * 跨站请求防护：带副作用的 API（POST）只接受本页面自己发起的请求。
 *
 * 服务虽然只监听 127.0.0.1，但用户浏览的任何网站都能让浏览器往这里发请求：
 * text/plain 的 POST 属于「简单请求」，不触发 CORS 预检，照样会被执行，
 * 从而触发下载、写到请求里指定的任意目录。所以这里：
 *   - Host 必须是本机回环名，挡住 DNS 重绑定（否则恶意域名解析到 127.0.0.1 后，
 *     Origin 与 Host 会「一致」）；
 *   - Origin 存在时必须等于本服务自己的源（http://<Host 头>）；
 *   - Sec-Fetch-Site 存在时只接受 same-origin / none；
 *   - Content-Type 必须是 application/json——跨站的简单请求发不出这种类型，
 *     要发就得先过预检，而本服务不回 CORS 头，预检必然失败。
 * 放行返回 null，否则返回 [状态码, 错误信息]。
 */
function checkApiPost(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return [403, '拒绝的 Host: ' + host];
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'http://' + host) return [403, '拒绝跨站请求'];
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return [403, '拒绝跨站请求'];
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return [415, '请求体必须是 application/json'];
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST + ':' + (server.address() ? server.address().port : BASE_PORT));

  try {
    // ---- 静态资源 ----
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      let rel = u.pathname === '/' ? '/index.html' : u.pathname;
      const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not Found');
      return send(res, 200, fs.readFileSync(file), { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    }

    // ---- 带副作用的 API：先过跨站检查，再读请求体 ----
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      const bad = checkApiPost(req);
      if (bad) return sendJson(res, bad[0], { ok: false, error: bad[1] });
    }

    // ---- 环境自检 ----
    if (u.pathname === '/api/env' && req.method === 'GET') {
      const ff = await convert.findFfmpeg();
      const ffp = await convert.findFfprobe ? await convert.findFfprobe() : null;
      return sendJson(res, 200, { hasFfmpeg: !!ff, ffmpegPath: ff, ok: true });
    }

    // ---- 解析推文 ----
    if (u.pathname === '/api/analyze' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.url) return sendJson(res, 400, { ok: false, error: '缺少 url 参数' });
      try {
        const a = await analyze(body.url, { onStatus: () => {} });
        return sendJson(res, 200, { ok: true, analysis: a });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message });
      }
    }

    // ---- 下载（SSE 流式进度） ----
    if (u.pathname === '/api/download' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.url) return sendJson(res, 400, { ok: false, error: '缺少 url 参数' });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const emit = (ev, data) => {
        try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端断开 */ }
      };

      try {
        emit('status', { message: '解析推文…' });
        const a = await analyze(body.url, { onStatus: (s) => emit('status', { message: s }) });
        emit('analysis', a);

        if (!a.media.length) {
          emit('error', { message: '这条推文里没有找到媒体' });
          return res.end();
        }

        // 前端传回的 selection；没传就用默认最高画质
        let selection = body.selection;
        if (!Array.isArray(selection) || !selection.length) {
          selection = a.media.map((m, i) => {
            let qi = m.qualities.findIndex((q) => q.isDefault);
            if (qi < 0) qi = m.qualities.length - 1;
            return { mediaIndex: i, qualityIndex: qi };
          });
        }

        const outDir = body.outDir && String(body.outDir).trim()
          ? String(body.outDir).trim()
          : path.join(ROOT, 'downloads');

        emit('status', { message: '开始下载到 ' + outDir });
        const r = await downloadSelection(a, selection, {
          outDir,
          gif: body.gif || null,
          audio: body.audio || null,
          onStatus: (s) => emit('status', { message: s }),
          // 限流：下载一个文件会触发上千次回调，全部推给浏览器会拖慢页面
          onProgress: throttle((p) => emit('progress', {
            got: p.got, total: p.totalBytes, index: p.index, total_items: p.total,
            kind: p.item ? p.item.kind : null,
          }), 120),
        });

        emit('done', {
          results: r.results.map((x) => ({ ...x, sizeText: humanSize(x.bytes) })),
          warns: r.warns,
          outDir: r.outDir,
        });
      } catch (e) {
        emit('error', { message: e.message });
      }
      return res.end();
    }

    return send(res, 404, 'Not Found');
  } catch (e) {
    try { sendJson(res, 500, { ok: false, error: e.message }); } catch { /* 已发送 */ }
  }
});

/**
 * 端口被占用时自动往后找一个可用端口，而不是直接崩掉。
 * 很多人本机已经跑着别的服务，硬编码端口很容易撞车。
 */
function listen(port, attemptsLeft) {
  if (attemptsLeft <= 0) {
    console.error('找不到可用端口，请用 PORT=xxxx node server.js 手动指定。');
    process.exit(1);
  }
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('  端口 ' + port + ' 被占用，尝试 ' + (port + 1) + ' …');
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('服务启动失败: ' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    console.log('');
    console.log('  X-Downloader 已启动');
    console.log('  在浏览器打开:  http://' + HOST + ':' + port);
    console.log('  (按 Ctrl+C 停止)');
    console.log('');
  });
}
listen(BASE_PORT, 20);
