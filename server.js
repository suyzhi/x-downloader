#!/usr/bin/env node
'use strict';
/**
 * 本地 Web UI：node server.js  →  浏览器打开 http://127.0.0.1:8787
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
  res.writeHead(code, Object.assign({
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  }, headers || {}));
  res.end(body);
}
function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
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
