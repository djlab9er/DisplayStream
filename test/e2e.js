// End-to-end browser test with a mock PeerJS. Run: node test/e2e.js
// Needs Playwright + Chromium. Set PLAYWRIGHT_PATH if `playwright` isn't resolvable.
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
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log('  ok  ' + name),
    (e) => { failures++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e).split('\n')[0]); }
  );
}

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext();

  // ---- make test media inside the browser ----
  const gen = await ctx.newPage();
  await gen.goto(base + '/send.html');
  const media = await gen.evaluate(async () => {
    const mk = (w, h, hue) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, `hsl(${hue},80%,55%)`); g.addColorStop(1, `hsl(${hue + 60},80%,25%)`);
      x.fillStyle = g; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.font = `${Math.round(h / 8)}px sans-serif`; x.fillText(`${w}x${h}`, w / 20, h / 2); return c; };
    const toB64 = async (blob) => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    const big = await new Promise((r) => mk(3200, 2400, 200).toBlob(r, 'image/png'));
    const jpg = await new Promise((r) => mk(1000, 700, 20).toBlob(r, 'image/jpeg', 0.9));
    const wide = await new Promise((r) => mk(2400, 1200, 120).toBlob(r, 'image/jpeg', 0.9));
    // short webm video
    const vc = mk(320, 240, 300); const vx = vc.getContext('2d');
    const rec = new MediaRecorder(vc.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(); let n = 0;
    const iv = setInterval(() => { vx.fillStyle = `hsl(${(n * 12) % 360},80%,50%)`; vx.fillRect(0, 0, 320, 240); vx.fillStyle = '#fff'; vx.font = '40px sans-serif'; vx.fillText('frame ' + n++, 40, 130); }, 33);
    await new Promise((r) => setTimeout(r, 1600)); clearInterval(iv); rec.stop(); await stopped;
    const vid = new Blob(chunks, { type: 'video/webm' });
    return { big: await toB64(big), jpg: await toB64(jpg), wide: await toB64(wide), vid: await toB64(vid) };
  });
  await gen.close();
  const files = {
    big: path.join(OUT, 'big-photo.png'), jpg: path.join(OUT, 'small-photo.jpg'),
    wide: path.join(OUT, 'wide-photo.jpg'), vid: path.join(OUT, 'clip.webm')
  };
  for (const k of Object.keys(files)) fs.writeFileSync(files[k], Buffer.from(media[k], 'base64'));
  const sizeOf = (f) => fs.statSync(f).size;

  // ---- pages ----
  const errors = [];
  const watch = (name, p) => {
    p.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  };

  const glasses = await ctx.newPage();
  await glasses.setViewportSize({ width: 600, height: 600 });
  watch('glasses', glasses);
  await glasses.goto(base + '/index.html');

  await check('glasses shows a formatted pairing code and a send URL', async () => {
    const code = await glasses.textContent('#code');
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(await glasses.textContent('#send-url'), /send\.html$/);
  });
  await check('glasses reaches "Waiting for phone"', async () => {
    await glasses.waitForFunction(() => /Waiting for phone/.test(document.getElementById('status').textContent), null, { timeout: 4000 });
  });
  await glasses.screenshot({ path: path.join(OUT, '1-glasses-pairing.png') });
  const code = (await glasses.textContent('#code')).replace('-', '');

  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  watch('phone', phone);
  await phone.goto(base + '/send.html?c=' + code);

  await check('phone connects using the code', async () => {
    await phone.waitForFunction(() => /Connected to your glasses/.test(document.getElementById('conn-status').textContent), null, { timeout: 5000 });
  });
  await check('glasses shows "Phone connected"', async () => {
    await glasses.waitForFunction(() => /Phone connected/.test(document.getElementById('status').textContent), null, { timeout: 3000 });
  });

  await phone.setInputFiles('#files', [files.big, files.jpg, files.wide, files.vid]);
  await check('all four files are sent and confirmed', async () => {
    await phone.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 4, null, { timeout: 30000 });
  });
  await phone.screenshot({ path: path.join(OUT, '2-phone-sent.png'), fullPage: true });

  await check('glasses grid has 4 tiles and focus moved onto the first', async () => {
    assert.equal(await glasses.locator('#grid .tile').count(), 4);
    assert.equal(await glasses.evaluate(() => document.activeElement && document.activeElement.className), 'tile');
  });
  await check('pairing hint hidden, mini code shown once media exists', async () => {
    assert.equal(await glasses.locator('#pair').isHidden(), true);
    assert.equal(await glasses.locator('#code-mini').isVisible(), true);
  });
  await glasses.screenshot({ path: path.join(OUT, '3-glasses-grid.png') });

  await check('big PNG was downscaled to <= 1200 px JPEG before sending', async () => {
    await glasses.locator('#grid .tile').first().press('Enter');
    await glasses.waitForSelector('#stage img');
    const dims = await glasses.evaluate(() => { const i = document.querySelector('#stage img'); return i.decode().then(() => [i.naturalWidth, i.naturalHeight]); });
    assert.equal(Math.max(...dims), 1200, 'dims ' + dims);
    assert.ok(dims[0] / dims[1] > 1.3 && dims[0] / dims[1] < 1.4, 'aspect kept ' + dims);
  });
  await check('size on glasses is far below the original PNG', async () => {
    const meta = await glasses.textContent('#caption .meta');
    assert.match(meta, /1 \/ 4/);
    const m = meta.match(/([\d.]+) (KB|MB)/);
    const bytes = Number(m[1]) * (m[2] === 'MB' ? 1048576 : 1024);
    assert.ok(bytes < sizeOf(files.big) / 3, `${bytes} vs ${sizeOf(files.big)}`);
  });
  await glasses.screenshot({ path: path.join(OUT, '4-glasses-viewer-photo.png') });

  await check('viewer: history entry pushed, Right/Left navigate with wraparound', async () => {
    assert.equal(await glasses.evaluate(() => history.state.screen), 'viewer');
    await glasses.keyboard.press('ArrowRight');
    assert.match(await glasses.textContent('#caption .meta'), /2 \/ 4/);
    await glasses.keyboard.press('ArrowLeft');
    await glasses.keyboard.press('ArrowLeft');
    assert.match(await glasses.textContent('#caption .meta'), /4 \/ 4/);
    await glasses.keyboard.press('ArrowRight');
    assert.match(await glasses.textContent('#caption .meta'), /1 \/ 4/);
  });
  await check('small JPEG passed through untouched (same bytes)', async () => {
    await glasses.keyboard.press('ArrowRight');
    const meta = await glasses.textContent('#caption .meta');
    const kb = Number(meta.match(/([\d.]+) KB/)[1]);
    assert.ok(Math.abs(kb * 1024 - sizeOf(files.jpg)) < 1024, `${kb} KB vs ${sizeOf(files.jpg)} B`);
  });
  await check('slideshow is started and stopped from the options menu (Down, then Slideshow)', async () => {
    const pick = async (n) => { await glasses.keyboard.press('ArrowDown'); for (let i = 0; i < n; i++) await glasses.keyboard.press('ArrowRight'); await glasses.keyboard.press('Enter'); };
    await pick(2);                                   // Keep -> Delete -> Slideshow
    assert.match(await glasses.textContent('#toast'), /Slideshow on/);
    await glasses.keyboard.press('ArrowDown');       // menu now offers to stop it
    assert.match(await glasses.textContent('#btn-menu-slideshow'), /Stop slideshow/);
    await glasses.keyboard.press('ArrowRight'); await glasses.keyboard.press('ArrowRight'); await glasses.keyboard.press('Enter');
    assert.match(await glasses.textContent('#toast'), /Slideshow off/);
  });
  await check('Enter on a photo zooms (and Enter again cycles back to fit)', async () => {
    await glasses.keyboard.press('Enter');
    assert.match(await glasses.textContent('#toast'), /Zoom 1/);
    await glasses.keyboard.press('Enter'); await glasses.keyboard.press('Enter');
    assert.match(await glasses.textContent('#toast'), /Fit/);
  });
  await check('video: Enter plays, Enter pauses', async () => {
    await glasses.keyboard.press('ArrowRight');
    await glasses.keyboard.press('ArrowRight'); // -> item 4 (video)
    assert.match(await glasses.textContent('#caption .meta'), /4 \/ 4/);
    await glasses.waitForSelector('#stage video');
    await glasses.keyboard.press('Enter');
    await glasses.waitForFunction(() => { const v = document.querySelector('#stage video'); return v && !v.paused; }, null, { timeout: 4000 });
    // the on-screen play button must disappear while playing
    await glasses.waitForFunction(() => { const g = document.querySelector('#stage .glyph'); return g && g.hidden; }, null, { timeout: 2000 });
    await glasses.screenshot({ path: path.join(OUT, '5-glasses-viewer-video.png') });
    await glasses.keyboard.press('Enter');
    await glasses.waitForFunction(() => document.querySelector('#stage video').paused, null, { timeout: 2000 });
  });
  await check('Back (Escape here) returns to the grid and refocuses the tile', async () => {
    await glasses.keyboard.press('Escape');
    await glasses.waitForFunction(() => !document.getElementById('home').hidden, null, { timeout: 2000 });
    assert.equal(await glasses.locator('#viewer').isHidden(), true);
    assert.equal(await glasses.evaluate(() => document.activeElement.className), 'tile');
    assert.equal(await glasses.evaluate(() => history.state.screen), 'home');
  });
  await check('history never exceeds the 5-entry host limit during browsing', async () => {
    assert.ok(await glasses.evaluate(() => history.length) <= 5);
  });

  await check('Clear all needs two presses, then returns to the pairing screen', async () => {
    await glasses.click('#btn-clear');
    assert.match(await glasses.textContent('#btn-clear'), /again/);
    await glasses.click('#btn-clear');
    await glasses.waitForFunction(() => document.getElementById('grid').children.length === 0);
    assert.equal(await glasses.locator('#pair').isVisible(), true);
  });
  await check('after clearing, glasses accept more files (free space reported)', async () => {
    await phone.click('#btn-clear-done');
    await phone.setInputFiles('#files', [files.wide]);
    await phone.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 1, null, { timeout: 15000 });
    assert.equal(await glasses.locator('#grid .tile').count(), 1);
  });

  await check('wrong code reports "Glasses not found"', async () => {
    const p2 = await ctx.newPage();
    watch('phone2', p2);
    await p2.goto(base + '/send.html?c=AAAA-BBBB');
    await p2.waitForFunction(() => /Glasses not found/.test(document.getElementById('conn-status').textContent), null, { timeout: 5000 });
    await p2.close();
  });

  await check('no uncaught errors or console errors on either page', async () => {
    const real = errors.filter((e) => !/Failed to load resource/.test(e));
    assert.deepEqual(real, []);
  });

  await browser.close();
  srv.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
