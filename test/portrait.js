// Regression test: portrait (tall) photos and videos must fit inside the 600x600 display.
// Run: node test/portrait.js   (needs Playwright + Chromium; uses the mock PeerJS)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/vendor/peerjs.min.js') p = '/test/mock-peer.js';
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); }
}

async function rectOf(page, sel) {
  return page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; }, sel);
}
function assertInside(r, size, label) {
  const eps = 1;
  assert.ok(r.top >= -eps && r.left >= -eps && r.bottom <= size + eps && r.right <= size + eps,
    `${label} box is ${Math.round(r.w)}x${Math.round(r.h)} at (${Math.round(r.left)},${Math.round(r.top)}), outside ${size}x${size}`);
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext();

  const gen = await ctx.newPage();
  await gen.goto(base + '/send.html');
  const media = await gen.evaluate(async () => {
    const mk = (w, h, hue) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, `hsl(${hue},80%,60%)`); g.addColorStop(1, `hsl(${hue + 80},80%,25%)`);
      x.fillStyle = g; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.font = `${Math.round(w / 6)}px sans-serif`; x.fillText('TOP', 20, w / 5); x.fillText('BOTTOM', 20, h - 30);
      x.strokeStyle = '#fff'; x.lineWidth = 8; x.strokeRect(4, 4, w - 8, h - 8); return c; };
    const b64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    const jpg = await new Promise((r) => mk(900, 1200, 200).toBlob(r, 'image/jpeg', 0.9));
    const vc = mk(360, 480, 20); const vx = vc.getContext('2d');
    const rec = new MediaRecorder(vc.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(); let n = 0;
    const iv = setInterval(() => { vx.drawImage(mk(360, 480, (n++ * 15) % 360), 0, 0); }, 40);
    await new Promise((r) => setTimeout(r, 1500)); clearInterval(iv); rec.stop(); await stopped;
    return { jpg: await b64(jpg), vid: await b64(new Blob(chunks, { type: 'video/webm' })) };
  });
  await gen.close();
  const files = { jpg: path.join(OUT, 'tall-photo.jpg'), vid: path.join(OUT, 'tall-clip.webm') };
  fs.writeFileSync(files.jpg, Buffer.from(media.jpg, 'base64'));
  fs.writeFileSync(files.vid, Buffer.from(media.vid, 'base64'));

  const glasses = await ctx.newPage();
  await glasses.setViewportSize({ width: 600, height: 600 });
  await glasses.goto(base + '/index.html');
  await glasses.waitForFunction(() => /Waiting for phone/.test(document.getElementById('status').textContent));
  const code = (await glasses.textContent('#code')).replace('-', '');
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(base + '/send.html?c=' + code);
  await phone.waitForFunction(() => /Connected to your glasses/.test(document.getElementById('conn-status').textContent));
  await phone.setInputFiles('#files', [files.jpg, files.vid]);
  await phone.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 2, null, { timeout: 20000 });

  await glasses.locator('#grid .tile').first().press('Enter');
  await glasses.waitForSelector('#stage img');
  await glasses.evaluate(() => document.querySelector('#stage img').decode());

  await check('portrait photo box fits inside 600x600', async () => {
    assertInside(await rectOf(glasses, '#stage img'), 600, 'photo');
  });
  await check('portrait photo is vertically centered on the display', async () => {
    const r = await rectOf(glasses, '#stage img');
    assert.ok(Math.abs((r.top + r.bottom) / 2 - 300) < 2, `center y = ${(r.top + r.bottom) / 2}`);
  });
  await glasses.screenshot({ path: path.join(OUT, 'portrait-photo.png') });

  await glasses.keyboard.press('ArrowRight');
  await glasses.waitForSelector('#stage video');
  await glasses.waitForFunction(() => document.querySelector('#stage video').readyState >= 1);
  await check('portrait video box fits inside 600x600', async () => {
    assertInside(await rectOf(glasses, '#stage video'), 600, 'video');
  });
  await check('portrait video is vertically centered on the display', async () => {
    const r = await rectOf(glasses, '#stage video');
    assert.ok(Math.abs((r.top + r.bottom) / 2 - 300) < 2, `center y = ${(r.top + r.bottom) / 2}`);
  });
  await check('nothing in the viewer is clipped by the page (no overflow)', async () => {
    const o = await glasses.evaluate(() => { const s = document.getElementById('stage'); return [s.scrollHeight, s.clientHeight, document.documentElement.scrollHeight, window.innerHeight]; });
    assert.ok(o[0] <= o[1] + 1 && o[2] <= o[3] + 1, 'overflow: ' + o.join(','));
  });
  await glasses.screenshot({ path: path.join(OUT, 'portrait-video.png') });

  await browser.close();
  srv.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nPortrait checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
