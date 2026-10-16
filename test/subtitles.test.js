'use strict';
// 字幕相关的纯函数测试（不联网）：node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAttributeList, parseMasterPlaylist } = require('../lib/tweet');
const { parseVtt, mergeVtt, toSrt, toVtt, parseMediaPlaylist } = require('../lib/subtitles');

test('属性列表：引号值里的逗号不切开，键转大写', () => {
  const a = parseAttributeList(
    'TYPE=SUBTITLES,GROUP-ID="subs",NAME="a, b.srt",DEFAULT=NO,'
    + 'URI="/pl/s0/x.m3u8",language="EN",CHARACTERISTICS="twitter.show-text-when-muted,twitter.auto-generated"');
  assert.deepEqual(a, {
    TYPE: 'SUBTITLES', 'GROUP-ID': 'subs', NAME: 'a, b.srt', DEFAULT: 'NO',
    URI: '/pl/s0/x.m3u8', LANGUAGE: 'EN',
    CHARACTERISTICS: 'twitter.show-text-when-muted,twitter.auto-generated',
  });
  assert.deepEqual(parseAttributeList('BANDWIDTH=100, RESOLUTION=1x2'), { BANDWIDTH: '100', RESOLUTION: '1x2' });
  assert.deepEqual(parseAttributeList(''), {});
  assert.deepEqual(parseAttributeList('A=1,garbage'), { A: '1' });
});

test('master：读出字幕轨，相对 URI 按 master 地址解析，音频轨不算', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="14969RomanShortOverviewVertCaptions.en_US.srt",DEFAULT=NO,FORCED=NO,URI="/amplify_video/1/pl/s0/A.m3u8",LANGUAGE="EN",AUTOSELECT=YES,CHARACTERISTICS="twitter.show-text-when-muted"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en (auto-generated)",URI="s1/B.m3u8",LANGUAGE="en",CHARACTERISTICS="twitter.show-text-when-muted,twitter.auto-generated"',
    '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-32000",AUTOSELECT=YES,URI="/amplify_video/1/pl/mp4a/32000/C.m3u8"',
    '',
    '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=265127,BANDWIDTH=565835,RESOLUTION=320x568,CODECS="mp4a.40.2,avc1.4D401E",SUBTITLES="subs",AUDIO="audio-32000"',
    '/amplify_video/1/pl/avc1/320x568/D.m3u8',
    '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1004919,BANDWIDTH=2129040,RESOLUTION=720x1280,CODECS="mp4a.40.2,avc1.64001F",SUBTITLES="subs",AUDIO="audio-128000"',
    '/amplify_video/1/pl/avc1/720x1280/E.m3u8',
  ].join('\r\n');
  const r = parseMasterPlaylist(master, 'https://video.twimg.com/amplify_video/1/pl/M.m3u8?tag=14');
  assert.equal(r.levels.length, 2);
  assert.equal(r.levels[1].resolution, '720x1280');
  assert.deepEqual(r.subtitles, [
    { lang: 'en', name: '14969RomanShortOverviewVertCaptions.en_US.srt', auto: false, url: 'https://video.twimg.com/amplify_video/1/pl/s0/A.m3u8' },
    { lang: 'en', name: 'en (auto-generated)', auto: true, url: 'https://video.twimg.com/amplify_video/1/pl/s1/B.m3u8' },
  ]);
  // 没有字幕的 master
  assert.deepEqual(parseMasterPlaylist('#EXTM3U\n', 'https://a.example/m.m3u8').subtitles, []);
});

test('VTT → SRT：去标签、解实体、无小时时间戳、丢 cue 设置与头部块', () => {
  const vtt = [
    String.fromCharCode(0xfeff) + 'WEBVTT', // 带 BOM 的头
    'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
    '',
    'NOTE 这是注释',
    '',
    'STYLE',
    '::cue { color: yellow }',
    '',
    'cue-1',
    '00:01.500 --> 00:03.250 align:start position:10%',
    '<X-word-ms ms=10,20 index=1 character_ranges=0-5,6-11>Hello world</X-word-ms>',
    '',
    '00:00:04.000 --> 00:00:06.000',
    '<v Bob>Tom &amp; Jerry</v> <c.yellow>&lt;3</c>',
    ' <i>second</i>&nbsp;line <00:00:05.000>here ',
    '',
    '01:02:03.004 --> 01:02:05.000',
    '<b></b>',
    '',
    '1:02:06.000 --> 1:02:07.100',
    'a &gt; b &amp;lt; c &#39;q&#x27;',
  ].join('\r\n');
  const cues = parseVtt(vtt);
  const NBSP = String.fromCharCode(0xa0); // &nbsp; 解出来是不换行空格，不是普通空格
  assert.deepEqual(cues, [
    { start: 1500, end: 3250, text: 'Hello world' },
    { start: 4000, end: 6000, text: 'Tom & Jerry <3\nsecond' + NBSP + 'line here' },
    // 去完标签是空的 cue 被丢掉
    { start: 3726000, end: 3727100, text: "a > b &lt; c 'q'" },
  ]);
  assert.equal(toSrt(cues), [
    '1', '00:00:01,500 --> 00:00:03,250', 'Hello world', '',
    '2', '00:00:04,000 --> 00:00:06,000', 'Tom & Jerry <3', 'second' + NBSP + 'line here', '',
    '3', '01:02:06,000 --> 01:02:07,100', "a > b &lt; c 'q'", '',
  ].join('\n'));
});

test('多段合并：每段的 WEBVTT 头去掉，分段边界重复的 cue 只留一条，相接的同文 cue 合并', () => {
  const seg1 = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n'
    + '00:00:00.000 --> 00:00:02.000\nfirst\n\n'
    + '00:00:05.000 --> 00:00:07.000\nacross boundary\n';
  const seg2 = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n'
    + '00:00:05.000 --> 00:00:07.000\nacross boundary\n\n'
    + '00:00:07.040 --> 00:00:08.000\nacross boundary\n\n'
    + '00:00:09.000 --> 00:00:10.000\nlast\n\n'
    + '00:00:12.000 --> 00:00:13.000\nlast\n';
  const cues = mergeVtt([seg2, seg1]);
  assert.deepEqual(cues, [
    { start: 0, end: 2000, text: 'first' },
    { start: 5000, end: 8000, text: 'across boundary' },
    { start: 9000, end: 10000, text: 'last' },
    // 隔得远的同文 cue 不合并
    { start: 12000, end: 13000, text: 'last' },
  ]);
  assert.ok(!toSrt(cues).includes('WEBVTT'));
});

test('多段合并：同一时刻的两条不同 cue 在两段里都出现时，各留一条', () => {
  const seg = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:01.000 --> 00:00:02.000\nB\n';
  assert.deepEqual(mergeVtt([seg, seg]).map((c) => c.text), ['A', 'B']);
});

test('落单的「<」不跨行吞掉正文', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nI <3 it\nmore > less\n';
  assert.equal(parseVtt(vtt)[0].text, 'I <3 it\nmore > less');
});

test('整理后的 VTT：正文里的 & < > 转回实体', () => {
  const out = toVtt([{ start: 0, end: 1234, text: 'a & b <c>' }]);
  assert.equal(out, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.234\na &amp; b &lt;c&gt;\n');
  assert.deepEqual(parseVtt(out), [{ start: 0, end: 1234, text: 'a & b <c>' }]);
});

test('字幕 media playlist：取出分段地址并解析成绝对地址', () => {
  const pl = '#EXTM3U\n#EXT-X-TARGETDURATION:90\n#EXTINF:89.422,\n/subtitles/amplify_video/1/0/a.vtt\n#EXTINF:1,\nb.vtt\n#EXT-X-ENDLIST\n';
  assert.deepEqual(parseMediaPlaylist(pl, 'https://video.twimg.com/amplify_video/1/pl/s0/x.m3u8'), [
    'https://video.twimg.com/subtitles/amplify_video/1/0/a.vtt',
    'https://video.twimg.com/amplify_video/1/pl/s0/b.vtt',
  ]);
});
