// Video shrinking on the phone page, against a glasses page with tiny limits.
// Run: node test/video.js  (Playwright + Chromium, mock PeerJS; real MediaRecorder, real time)
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
let cfgExtra = '';
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/vendor/peerjs.min.js')) p = '/test/mock-peer.js';
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      let body = fs.readFileSync(f);
      if (p === '/js/config.js') body = Buffer.concat([body, Buffer.from(cfgExtra)]);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(body);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); }
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext();

  // A 4 s, 960x720 busy video (so it is big) and a tiny 1 s one.
  const gen = await ctx.newPage(); await gen.goto(base + '/send.html');
  const b64 = await gen.evaluate(async () => {
    const make = async (w, h, secs, busy) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 4000000 });
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data); const done = new Promise((r) => (rec.onstop = r));
      rec.start(); let n = 0;
      const iv = setInterval(() => {
        x.fillStyle = `hsl(${(n * 9) % 360},70%,40%)`; x.fillRect(0, 0, w, h);
        if (busy) for (let i = 0; i < 60; i++) { x.fillStyle = `hsl(${Math.random() * 360},90%,55%)`; x.fillRect(Math.random() * w, Math.random() * h, 60, 40); }
        x.fillStyle = '#fff'; x.font = `${Math.round(h / 8)}px sans-serif`; x.fillText('frame ' + n++, 30, h / 2);
      }, 33);
      await new Promise((r) => setTimeout(r, secs * 1000)); clearInterval(iv); rec.stop(); await done;
      const b = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let s = ''; for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000)); return btoa(s);
    };
    return { big: await make(960, 720, 4, true), small: await make(320, 240, 1, false) };
  });
  await gen.close();
  const big = path.join(OUT, 'vbig.webm'), small = path.join(OUT, 'vsmall.webm');
  fs.writeFileSync(big, Buffer.from(b64.big, 'base64')); fs.writeFileSync(small, Buffer.from(b64.small, 'base64'));
  const bigSize = fs.statSync(big).size, smallSize = fs.statSync(small).size;
  console.log(`   source clips: big ${(bigSize / 1024).toFixed(0)} KB, small ${(smallSize / 1024).toFixed(0)} KB`);

  // Glasses limit: about 45% of the big clip, but never below what 4 s at the lowest quality needs.
  const limitMB = Math.max(bigSize * 0.45, 260 * 1024) / 1048576;
  const limitBytes = Math.round(limitMB * 1048576);
  assert.ok(bigSize > limitBytes * 1.3 && smallSize < limitBytes, 'test clips do not straddle the limit');
  cfgExtra = `\nwindow.PG_CONFIG.MAX_FILE_MB = ${limitMB};\n`;

  const errs = [];
  async function session() {
    const g = await ctx.newPage(); g.on('pageerror', (e) => errs.push('glasses ' + e.message));
    await g.setViewportSize({ width: 600, height: 600 }); await g.goto(base + '/index.html');
    await g.waitForFunction(() => /Waiting for phone/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
    const code = (await g.textContent('#code')).replace('-', '');
    const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push('phone ' + e.message));
    await p.setViewportSize({ width: 390, height: 844 }); await p.goto(base + '/send.html?c=' + code);
    await p.waitForFunction(() => /Connected to your glasses/.test(document.getElementById('conn-status').textContent), null, { timeout: 5000 });
    return { g, p };
  }
  const meta = (p) => p.evaluate(() => Array.from(document.querySelectorAll('#queue .meta')).map((m) => m.textContent));
  const waitRow = (p, re, ms) => p.waitForFunction((src) => Array.from(document.querySelectorAll('#queue .meta')).some((m) => new RegExp(src).test(m.textContent)), re.source, { timeout: ms || 60000 });
  const glassesVideo = async (g, idx) => {                      // open item idx in the viewer and read the video element
    const tiles = g.locator('#grid .tile');
    await (idx < 0 ? tiles.last() : tiles.nth(idx)).press('Enter');   // saved photos persist across sessions in one context
    await g.waitForSelector('#stage video');
    await g.waitForFunction(() => { const v = document.querySelector('#stage video'); return v && v.readyState >= 1 && v.videoWidth > 0; }, null, { timeout: 10000 });
    const r = await g.evaluate(() => { const v = document.querySelector('#stage video'); return { w: v.videoWidth, h: v.videoHeight, err: !!v.error }; });
    await g.keyboard.press('Escape');
    return r;
  };

  console.log('Auto (default)');
  let { g, p } = await session();
  await check('the phone shows the glasses\' limit', async () => {
    const t = await p.textContent('#limits');
    assert.match(t, /Glasses accept files up to/);
  });
  await p.setInputFiles('#files', [small, big]);
  await check('small video is sent unchanged; big one is shrunk to fit and sent', async () => {
    await p.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 2, null, { timeout: 90000 });
    const m = await meta(p);
    assert.ok(!/was /.test(m[0]), 'small clip should not be re-encoded: ' + m[0]);
    assert.match(m[1], /was [\d.]+ (KB|MB)/);
  });
  await check('the shrunk video really is under the limit on the glasses and plays', async () => {
    const sizes = await g.evaluate(() => Array.from(document.querySelectorAll('#grid .tile')).length);
    assert.equal(sizes, 2);
    const v = await glassesVideo(g, 1);
    assert.equal(v.err, false); assert.ok(v.w > 0 && v.h > 0 && v.h <= 720, JSON.stringify(v));
  });
  await check('the shrunk file respects the per-file limit', async () => {
    // The glasses would have rejected it otherwise; also verify via the phone row text "(was X)" size < limit.
    const m = (await meta(p))[1];
    const mt = /^([\d.]+) (KB|MB) \(was/.exec(m);
    assert.ok(mt, m);
    const bytes = parseFloat(mt[1]) * (mt[2] === 'MB' ? 1048576 : 1024);
    assert.ok(bytes <= limitBytes * 1.02, `${bytes} vs limit ${limitBytes}`);
  });
  await p.close(); await g.close();

  console.log('Original (never shrink)');
  ({ g, p } = await session());
  await p.selectOption('#vquality', 'original');
  await p.setInputFiles('#files', [big]);
  await check('an oversize video is refused with a hint, not silently shrunk', async () => {
    await waitRow(p, /Too large for the glasses[\s\S]*Auto/, 20000);
  });
  await p.close(); await g.close();

  console.log('Always 480p');
  ({ g, p } = await session());
  await p.selectOption('#vquality', '480');
  await p.setInputFiles('#files', [big]);
  await check('480p shrinks even a clip that already fits, down to 480 px high', async () => {
    await waitRow(p, /was [\d.]+ (KB|MB)[\s\S]*Sent/, 90000);
    const v = await glassesVideo(g, -1);
    assert.equal(v.h, 480, JSON.stringify(v));
    assert.equal(v.err, false);
  });
  await p.close(); await g.close();

  console.log('Too long to fit / cancel');
  cfgExtra = `\nwindow.PG_CONFIG.MAX_FILE_MB = 0.05;\n`;      // 50 KB: impossible for a 4 s clip
  ({ g, p } = await session());
  await p.setInputFiles('#files', [big]);
  await check('a clip that can never fit says so up front (no minutes of wasted work)', async () => {
    await waitRow(p, /Too long to fit/, 15000);
  });
  await p.close(); await g.close();

  cfgExtra = `\nwindow.PG_CONFIG.MAX_FILE_MB = ${limitMB};\n`;
  ({ g, p } = await session());
  await p.setInputFiles('#files', [big]);
  await check('Cancel stops shrinking and removes the row', async () => {
    await waitRow(p, /Shrinking/, 15000);
    await p.locator('#queue .acts button', { hasText: 'Cancel' }).first().click();
    await p.waitForFunction(() => document.querySelectorAll('#queue .item').length === 0, null, { timeout: 15000 });
  });
  await check('no page errors', async () => assert.deepEqual(errs, []));

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nvideo shrink tests passed');
  process.exit(failures ? 1 : 0);
})();
