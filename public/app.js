'use strict';
/* X-Downloader 前端：解析推文 → 手动挑选画质 → 下载（SSE 实时进度） */

const $ = (s) => document.querySelector(s);
let ANALYSIS = null;       // 当前推文分析结果
let SELECTION = [];        // [{ mediaIndex, qualityIndex }]

function humanSize(n) {
  if (n == null || !isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
}
function humanDur(ms) {
  if (!ms) return '';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return m > 0 ? m + '分' + (s - m * 60).toFixed(1) + '秒' : s.toFixed(1) + '秒';
}

// ---- 环境自检 ----
(async function checkEnv() {
  try {
    const r = await fetch('/api/env').then((x) => x.json());
    if (!r.hasFfmpeg) $('#warn-ffmpeg').hidden = false;
  } catch { /* 忽略 */ }
})();

// ---- 解析 ----
$('#go').addEventListener('click', analyze);
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });

async function analyze() {
  const url = $('#url').value.trim();
  if (!url) return;
  const btn = $('#go');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> 解析中';
  $('#result').hidden = true;
  $('#log').hidden = true;

  try {
    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    }).then((x) => x.json());

    if (!r.ok) { alert('解析失败：' + r.error); return; }
    ANALYSIS = r.analysis;
    render(r.analysis);
  } catch (e) {
    alert('请求出错：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '解析';
  }
}

// ---- 渲染 ----
function render(a) {
  const meta = $('#meta');
  const mediaBox = $('#media');
  mediaBox.innerHTML = '';
  SELECTION = [];

  if (!a.media.length) {
    meta.innerHTML = '<div class="who">@' + (a.screenName || '?') + '</div><div class="txt">这条推文里没有找到任何媒体。</div>';
    $('#result').hidden = false;
    $('#download').disabled = true;
    return;
  }
  $('#download').disabled = false;

  meta.innerHTML =
    '<div class="who">@' + esc(a.screenName || '?') + '</div>' +
    (a.text ? '<div class="txt">' + esc(a.text) + '</div>' : '');

  a.media.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'card';

    const badge = m.kind === 'image'
      ? '<span class="badge image">图片</span>'
      : (m.isGif ? '<span class="badge gif">GIF 动图</span>' : '<span class="badge video">视频</span>');

    const dimtxt = [
      m.width && m.height ? m.width + '×' + m.height : null,
      m.durationMs ? humanDur(m.durationMs) : null,
    ].filter(Boolean).join(' · ');

    const head = document.createElement('div');
    head.className = 'card head';
    head.innerHTML =
      (m.thumb ? '<img class="thumb" src="' + esc(m.thumb) + '" alt="" referrerpolicy="no-referrer">' : '') +
      '<div class="info">' +
        '<div>' + badge + '<span class="dimtxt">' + esc(dimtxt) + '</span></div>' +
        '<div class="dimtxt" style="margin-top:6px">媒体 #' + (i + 1) + '</div>' +
      '</div>' +
      '<label class="check"><input type="checkbox" data-m="' + i + '" checked> 下载</label>';
    card.appendChild(head);

    const qs = document.createElement('div');
    qs.className = 'qualities';
    m.qualities.forEach((q, qi) => {
      const row = document.createElement('label');
      row.className = 'q' + (q.isDefault ? ' sel' : '');
      const label = q.label || ('档位 ' + (qi + 1));
      row.innerHTML =
        '<input type="radio" name="m' + i + '" data-m="' + i + '" data-q="' + qi + '"' + (q.isDefault ? ' checked' : '') + '>' +
        '<span class="lab">' + esc(label) + '</span>' +
        '<span class="br">' + (q.bitrate ? Math.round(q.bitrate / 1000) + ' kbps' : '') + '</span>' +
        (q.isDefault ? '<span class="top">最高画质</span>' : '');
      row.addEventListener('click', () => {
        qs.querySelectorAll('.q').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
      });
      qs.appendChild(row);
    });
    card.appendChild(qs);
    mediaBox.appendChild(card);
  });

  $('#result').hidden = false;
  $('#log').hidden = true;
  collectSelection();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collectSelection() {
  SELECTION = [];
  if (!ANALYSIS) return;
  document.querySelectorAll('.card.head .check input').forEach((cb) => {
    const i = Number(cb.dataset.m);
    if (!cb.checked) return;
    const radio = document.querySelector('input[type=radio][data-m="' + i + '"]:checked');
    const qi = radio ? Number(radio.dataset.q) : 0;
    SELECTION.push({ mediaIndex: i, qualityIndex: qi });
  });
  $('#hint').textContent = SELECTION.length ? ('已选 ' + SELECTION.length + ' 项') : '未选择任何项目';
  $('#download').disabled = SELECTION.length === 0;
}

document.addEventListener('change', (e) => {
  if (e.target.closest('#media')) collectSelection();
});

$('#selectAll').addEventListener('click', () => {
  document.querySelectorAll('.card.head .check input').forEach((cb) => { cb.checked = true; });
  document.querySelectorAll('.qualities').forEach((qs) => {
    const rows = [...qs.querySelectorAll('.q')];
    const def = rows.find((r) => r.querySelector('.top')) || rows[rows.length - 1];
    rows.forEach((r) => r.classList.remove('sel'));
    def.classList.add('sel');
    def.querySelector('input').checked = true;
  });
  collectSelection();
});

// ---- 下载 ----
$('#download').addEventListener('click', startDownload);

function startDownload() {
  collectSelection();
  if (!SELECTION.length) return;

  const mode = $('#mode').value;
  let gif = null;
  let audio = null;
  if (mode.startsWith('gif:')) gif = mode.slice(4);
  if (mode.startsWith('audio:')) audio = mode.slice(6);

  const logBox = $('#log');
  const logtext = $('#logtext');
  const done = $('#done');
  logBox.hidden = false;
  done.hidden = true;
  done.innerHTML = '';
  logtext.textContent = '';
  $('#barfill').style.width = '0%';
  $('#download').disabled = true;

  const payload = {
    url: $('#url').value.trim(),
    selection: SELECTION,
    outDir: $('#outDir').value.trim() || null,
    gif, audio,
  };

  fetch('/api/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((res) => {
    if (!res.ok || !res.body) throw new Error('服务器返回 ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const pump = () => reader.read().then(({ done: fin, value }) => {
      if (fin) return;
      buf += dec.decode(value, { stream: true });
      // SSE 以空行分隔事件
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleEvent(chunk, logtext, done);
      }
      return pump();
    });
    return pump();
  }).catch((e) => {
    logtext.textContent += '\n✗ ' + e.message;
  }).finally(() => {
    $('#download').disabled = false;
  });
}

function handleEvent(chunk, logtext, done) {
  let ev = 'message';
  let data = '';
  chunk.split('\n').forEach((line) => {
    if (line.startsWith('event: ')) ev = line.slice(7).trim();
    else if (line.startsWith('data: ')) data += line.slice(6);
  });
  if (!data) return;
  let obj;
  try { obj = JSON.parse(data); } catch { return; }

  if (ev === 'status') {
    logtext.textContent += (logtext.textContent ? '\n' : '') + '· ' + obj.message;
    logtext.scrollTop = logtext.scrollHeight;
  } else if (ev === 'progress') {
    if (obj.total) {
      $('#barfill').style.width = Math.floor((obj.got / obj.total) * 100) + '%';
    }
  } else if (ev === 'error') {
    logtext.textContent += '\n✗ ' + obj.message;
  } else if (ev === 'done') {
    $('#barfill').style.width = '100%';
    done.hidden = false;
    obj.results.forEach((x) => {
      const d = document.createElement('div');
      d.className = 'item';
      const kind = { video: '视频', gif: 'GIF', image: '图片', audio: '音频' }[x.kind] || x.kind;
      d.innerHTML = '<span>' + kind + '</span><span class="p">' + esc(x.path) + '</span><span class="s">' + esc(x.sizeText) + '</span>';
      done.appendChild(d);
    });
    obj.warns.forEach((w) => {
      const d = document.createElement('div');
      d.className = 'wr';
      d.textContent = '⚠ ' + w;
      done.appendChild(d);
    });
    logtext.textContent += '\n✓ 完成';
  }
}
