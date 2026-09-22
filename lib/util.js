'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** 允许出现在文件名中的安全字符清洗 */
function safeName(s, fallback = 'file') {
  const cleaned = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, '_')
    .trim();
  return cleaned.slice(0, 80) || fallback;
}

function humanSize(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
}

function humanDuration(ms) {
  if (!ms) return '?';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const r = (s - m * 60);
  return m > 0 ? `${m}分${r.toFixed(1)}秒` : `${r.toFixed(1)}秒`;
}

/** 带 UA / Referer 的抓取；X 对裸请求会 403 */
async function httpGet(url, { headers = {}, redirect = 'follow', timeout = 30000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, {
      redirect,
      signal: ctl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
  } finally {
    clearTimeout(t);
  }
}

async function httpText(url, opts) {
  const res = await httpGet(url, opts);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/** 流式下载到文件，带进度回调。返回 { bytes } */
async function download(url, dest, { onProgress, headers = {}, timeout = 120000 } = {}) {
  const res = await httpGet(url, { headers: { referer: 'https://x.com/', ...headers }, timeout });
  if (!res.ok) {
    const err = new Error(`下载失败 HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const out = fs.createWriteStream(dest);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress(got, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return { bytes: got };
}

/** 探测 ffmpeg / ffprobe 是否存在 */
function whichExe(name) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(line || null);
    });
  });
}

/** 跑一个外部命令 */
function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 28 });
    let out = '';
    let errOut = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { errOut += d; if (onStderr) onStderr(String(d)); });
    p.on('error', (e) => reject(new Error(`无法执行 ${cmd}: ${e.message}`)));
    p.on('close', (code) => resolve({ code, stdout: out, stderr: errOut }));
  });
}

/** 唯一文件名：name.ext，已存在则 name_1.ext … */
function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  let i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base}_${i++}${ext}`);
  return p;
}

function isHttpUrl(s) {
  try {
    const u = new URL(String(s).trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

module.exports = { safeName, humanSize, humanDuration, httpGet, httpText, download, whichExe, run, uniquePath, isHttpUrl };
