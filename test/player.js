// Video player controls on the glasses: seek, progress, speed, sound, previous/next.
// Run: node test/player.js (Playwright + Chromium, mock PeerJS)
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
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      let body = fs.readFileSync(f);
      if (p === '/js/config.js') body = Buffer.concat([body, Buffer.from('\nwindow.PG_CONFIG.SEEK_SECONDS = 2;\n')]);
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

  // two videos recorded by MediaRecorder (their WebM duration is "Infinity" until fixed)
  const gen = await ctx.newPage(); await gen.goto(base + '/send.html');
  const b64 = await gen.evaluate(async () => {
    const make = async (hue, secs) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240; const x = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data); const done = new Promise((r) => (rec.onstop = r));
      rec.start(); let n = 0;
      const iv = setInterval(() => { x.fillStyle = `hsl(${(hue + n * 6) % 360},80%,45%)`; x.fillRect(0, 0, 320, 240); x.fillStyle = '#fff'; x.font = '50px sans-serif'; x.fillText('t ' + (n++ / 30).toFixed(1), 60, 130); }, 33);
      await new Promise((r) => setTimeout(r, secs * 1000)); clearInterval(iv); rec.stop(); await done;
      const b = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let s = ''; for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000)); return btoa(s);
    };
    return [await make(0, 7), await make(200, 3)];
  });
  await gen.close();
  const files = b64.map((b, i) => { const f = path.join(OUT, `player-${i}.webm`); fs.writeFileSync(f, Buffer.from(b, 'base64')); return f; });

  const errs = [];
  const g = await ctx.newPage(); g.on('pageerror', (e) => errs.push(e.message));
  await g.setViewportSize({ width: 600, height: 600 }); await g.goto(base + '/index.html');
  await g.waitForFunction(() => /Waiting for phone/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
  const code = (await g.textContent('#code')).replace('-', '');
  const ph = await ctx.newPage(); await ph.setViewportSize({ width: 390, height: 844 }); await ph.goto(base + '/send.html?c=' + code);
  await ph.waitForFunction(() => /Connected to your glasses/.test(document.getElementById('conn-status').textContent), null, { timeout: 5000 });
  await ph.selectOption('#vquality', 'original');
  await ph.setInputFiles('#files', files);
  await ph.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 2, null, { timeout: 30000 });

  const V = () => g.evaluate(() => { const v = document.querySelector('#stage video'); return v && { t: v.currentTime, d: v.duration, paused: v.paused, rate: v.playbackRate, muted: v.muted, ended: v.ended }; });
  const T = () => g.evaluate(() => ({ time: document.getElementById('ttime').textContent, flags: document.getElementById('tflags').textContent, shown: document.getElementById('transport').classList.contains('show'), fill: document.getElementById('tfill').style.inlineSize, cap: document.getElementById('caption').textContent }));
  const press = async (k, n = 1) => { for (let i = 0; i < n; i++) await g.keyboard.press(k); };
  const menuFocus = () => g.evaluate(() => document.activeElement.id);

  await g.locator('#grid .tile').first().press('Enter');
  await g.waitForSelector('#stage video');
  await g.waitForFunction(() => { const v = document.querySelector('#stage video'); return v && isFinite(v.duration) && v.duration > 3 && v.currentTime === 0; }, null, { timeout: 10000 });

  await check('a recorder-made WebM gets a real duration, so the bar and seeking work', async () => {
    const v = await V();
    assert.ok(isFinite(v.d) && v.d > 5 && v.d < 9, JSON.stringify(v));
    assert.match((await T()).time, /^0:00 \/ 0:0[6-8]$/);
  });
  await check('Enter plays and pauses', async () => {
    await press('Enter'); await g.waitForTimeout(400);
    assert.equal((await V()).paused, false);
    await press('Enter');
    assert.equal((await V()).paused, true);
  });
  await check('Right skips ahead, Left skips back (by the configured step), shown on the progress bar', async () => {
    const a = (await V()).t;
    await press('ArrowRight');
    const b = await V();
    assert.ok(Math.abs(b.t - (a + 2)) < 0.3, `${a} -> ${b.t}`);
    const tt = await T();
    assert.equal(tt.shown, true); assert.match(tt.time, /^0:0[2-3] \//);
    assert.ok(parseFloat(tt.fill) > 20 && parseFloat(tt.fill) < 40, tt.fill);
    await press('ArrowLeft');
    assert.ok(Math.abs((await V()).t - a) < 0.3);
    assert.match((await T()).cap, /1 \/ 2/);                 // seeking did not change video
    await g.screenshot({ path: path.join(OUT, 'player-seek.png') });
  });
  await check('seeking clamps at the start and the end', async () => {
    await press('ArrowLeft', 4);
    assert.equal((await V()).t, 0);
    await press('ArrowRight', 12);
    const v = await V();
    assert.ok(v.t <= v.d + 0.01 && v.t > v.d - 0.5, JSON.stringify(v));
    assert.match((await T()).cap, /1 \/ 2/);
    await press('ArrowLeft', 12);
  });
  await check('Up pins the player bar; Up again hides it', async () => {
    await press('ArrowUp'); await g.waitForTimeout(3500);
    assert.equal((await T()).shown, true);
    await press('ArrowUp');
    assert.equal((await T()).shown, false);
  });
  await check('Down opens a menu with Speed, Sound, Previous and Next for videos', async () => {
    await press('ArrowDown');
    const vis = await g.evaluate(() => ['btn-menu-speed', 'btn-menu-sound', 'btn-menu-prev', 'btn-menu-next'].map((id) => !document.getElementById(id).hidden));
    assert.deepEqual(vis, [true, true, true, true]);
    assert.equal(await menuFocus(), 'btn-menu-keep');
    await g.screenshot({ path: path.join(OUT, 'player-menu.png') });
  });
  await check('Speed cycles 1× → 1.5× and shows on the bar', async () => {
    await press('ArrowRight', 2); assert.equal(await menuFocus(), 'btn-menu-speed');
    await press('Enter');
    assert.equal((await V()).rate, 1.5);
    assert.match(await g.textContent('#btn-menu-speed'), /1\.5/);
    assert.match((await T()).flags, /1\.5×/);
  });
  await check('Sound toggles mute', async () => {
    await press('ArrowRight'); assert.equal(await menuFocus(), 'btn-menu-sound');
    await press('Enter');
    assert.equal((await V()).muted, true);
    assert.match(await g.textContent('#btn-menu-sound'), /off/);
    assert.match((await T()).flags, /muted/);
  });
  await check('the menu stays open while adjusting; Down closes it', async () => {
    assert.equal(await g.locator('#menu').isVisible(), true);
    await press('ArrowDown');
    assert.equal(await g.locator('#menu').isVisible(), false);
  });
  await check('Next (menu) goes to the next video; speed and mute carry over', async () => {
    await press('ArrowDown'); await press('ArrowRight', 5); assert.equal(await menuFocus(), 'btn-menu-next');
    await press('Enter');
    await g.waitForFunction(() => /2 \/ 2/.test(document.getElementById('caption').textContent));
    await g.waitForFunction(() => { const v = document.querySelector('#stage video'); return v && v.readyState >= 1; });
    const v = await V();
    assert.equal(v.rate, 1.5); assert.equal(v.muted, true);
  });
  await check('Previous (menu) goes back; Left/Right never changes video', async () => {
    await press('ArrowRight', 3);                          // seeks within video 2
    assert.match((await T()).cap, /2 \/ 2/);
    await press('ArrowDown'); await press('ArrowRight', 4); assert.equal(await menuFocus(), 'btn-menu-prev');
    await press('Enter');
    await g.waitForFunction(() => /1 \/ 2/.test(document.getElementById('caption').textContent));
  });
  await check('a finished video can be replayed with Enter', async () => {
    await press('ArrowRight', 8);                          // jump to the end
    await g.evaluate(() => { const v = document.querySelector('#stage video'); v.playbackRate = 2; });
    await press('Enter');
    await g.waitForFunction(() => { const v = document.querySelector('#stage video'); return v.ended || v.currentTime > 0; }, null, { timeout: 8000 });
  });
  await check('no page errors', async () => assert.deepEqual(errs, []));

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nvideo player tests passed');
  process.exit(failures ? 1 : 0);
})();
