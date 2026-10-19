// Cast test: receiver (cast/index.html) + sender logic with mock PeerJS and REAL WebRTC video.
// Run: node test/cast.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
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
      if (p.endsWith('/vendor/peerjs.min.js')) p = '/test/mock-peer.js';
      if (p.endsWith('/')) p += 'index.html';
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
// Fake "screen": animated canvas stream, installed as getDisplayMedia.
const FAKE = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); let n = 0;
    setInterval(() => { x.fillStyle = `hsl(${(n += 7) % 360},80%,50%)`; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = '60px sans-serif'; x.fillText('CAST ' + n, 40, 200); }, 50);
    return c.captureStream(20);
  };
};
const videoPlaying = (page) => page.waitForFunction(() => { const v = document.getElementById('video'); return v && v.videoWidth > 0 && v.currentTime > 0.2; }, null, { timeout: 15000 });

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 600, height: 600 } });

  const rx = await ctx.newPage();
  const errs = []; rx.on('pageerror', (e) => errs.push(String(e)));
  await rx.goto(base + '/cast/');
  await rx.waitForFunction(() => /Waiting/.test(document.getElementById('status').textContent));
  const code = (await rx.textContent('#code')).replace('-', '');

  await check('receiver shows an 8-char code and sender URL', async () => {
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.match(await rx.textContent('#send-url'), /\/cast\/send\.html$/);
    await rx.screenshot({ path: path.join(OUT, 'cast-pair.png') });
  });

  const tx = await ctx.newPage();
  tx.on('pageerror', (e) => errs.push(String(e)));
  await tx.addInitScript(FAKE);
  await tx.goto(base + '/cast/send.html');

  await check('sender rejects a malformed code', async () => {
    await tx.fill('#code', 'abc'); await tx.click('#start');
    assert.match(await tx.textContent('#msg'), /8-character/);
  });

  await check('screen video reaches the glasses and plays', async () => {
    await tx.fill('#code', code.slice(0, 4) + '-' + code.slice(4).toLowerCase());
    await tx.click('#start');
    await videoPlaying(rx);
    assert.equal(await rx.evaluate(() => document.getElementById('screen').hidden), false);
    assert.equal(await rx.evaluate(() => document.getElementById('pair').hidden), true);
    await rx.screenshot({ path: path.join(OUT, 'cast-playing.png') });
    assert.match(await tx.textContent('#msg'), /Casting/);
  });

  await check('video is letterboxed inside 600x600', async () => {
    const r = await rx.evaluate(() => { const b = document.getElementById('video').getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
    assert.ok(r[0] >= 0 && r[1] >= 0 && r[2] <= 600.5 && r[3] <= 600.5, JSON.stringify(r));
  });

  await check('a second sender is turned away while busy', async () => {
    const tx2 = await ctx.newPage(); await tx2.addInitScript(FAKE); await tx2.goto(base + '/cast/send.html');
    await tx2.fill('#code', code); await tx2.click('#start');
    await tx2.waitForTimeout(1500);
    assert.equal(await rx.evaluate(() => document.getElementById('video').srcObject !== null), true);
    // (The mock relays the close; real PeerJS does not, hence the sender-side timeout.) The first cast must be undisturbed:
    assert.equal(await rx.evaluate(() => document.getElementById('screen').hidden), false);
    await videoPlaying(rx);
    await tx2.close();
  });

  await check('stopping the sender returns the glasses to pairing', async () => {
    await tx.click('#stop');
    await rx.waitForFunction(() => !document.getElementById('pair').hidden, null, { timeout: 8000 });
    assert.match(await rx.textContent('#status'), /ended|Waiting/);
  });

  await check('glasses can accept a new cast after the first ends', async () => {
    await tx.fill('#code', code); await tx.click('#start');
    await videoPlaying(rx);
  });

  await check('Back (Escape) ends the cast on the glasses', async () => {
    await rx.keyboard.press('Escape');
    await rx.waitForFunction(() => !document.getElementById('pair').hidden);
    await tx.waitForFunction(() => /ended|Stopped/.test(document.getElementById('msg').textContent), null, { timeout: 8000 });
  });

  await check('New code changes the pairing code', async () => {
    await rx.click('#btn-newcode');
    await rx.waitForFunction((old) => document.getElementById('code').textContent.replace('-', '') !== old, code);
  });

  await check('no page errors', async () => assert.deepEqual(errs, []));

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall cast tests passed');
  process.exit(failures ? 1 : 0);
})();
