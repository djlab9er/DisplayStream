// Photo zoom/pan in the gallery viewer. Run: node test/photozoom.js (FORCE_FALLBACK=1 tests the transform path)
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const FALLBACK = !!process.env.FORCE_FALLBACK;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/vendor/peerjs.min.js')) p = '/test/mock-peer.js';
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

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  // one tall and one wide JPEG (kept at original size so the viewer shows them as-is)
  const gen = await ctx.newPage(); await gen.goto(base + '/send.html');
  const b64 = await gen.evaluate(async () => {
    const mk = async (w, h, hue, label) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, `hsl(${hue},85%,55%)`); g.addColorStop(1, `hsl(${hue + 90},85%,25%)`);
      x.fillStyle = g; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.font = '90px sans-serif'; x.fillText(label + ' TOP', 20, 100); x.fillText(label + ' END', 20, h - 30);
      const b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
      let s = ''; for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000)); return btoa(s);
    };
    return [await mk(600, 1300, 20, 'TALL'), await mk(1200, 600, 200, 'WIDE')];
  });
  await gen.close();
  const files = b64.map((b, i) => { const f = path.join(OUT, `zoom-${i}.jpg`); fs.writeFileSync(f, Buffer.from(b, 'base64')); return f; });

  const g = await ctx.newPage();
  if (FALLBACK) await g.addInitScript(() => { const o = CSS.supports.bind(CSS); CSS.supports = (a, b) => (a === 'object-view-box' ? false : o(a, b)); });
  const errs = []; g.on('pageerror', (e) => errs.push(e.message));
  await g.setViewportSize({ width: 600, height: 600 });
  await g.goto(base + '/index.html');
  await g.waitForFunction(() => /Waiting for phone/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
  const code = (await g.textContent('#code')).replace('-', '');
  const ph = await ctx.newPage(); await ph.goto(base + '/send.html?c=' + code);
  await ph.waitForFunction(() => /Connected to your glasses/.test(document.getElementById('conn-status').textContent), null, { timeout: 5000 });
  await ph.selectOption('#quality', { index: 0 }).catch(() => {});
  await ph.setInputFiles('#files', files);
  await ph.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 2, null, { timeout: 20000 });
  await g.keyboard.press('Enter');                       // open the first tile
  await g.waitForSelector('#stage img');
  await g.evaluate(() => document.querySelector('#stage img').decode());

  const st = () => g.evaluate(() => {
    const i = document.querySelector('#stage img'); const b = i.getBoundingClientRect();
    const nums = (str, re) => { const m = re.exec(str || ''); return m ? m[1].split(/[\s,]+/).filter(Boolean).map(parseFloat) : null; };
    let ins = nums(i.style.objectViewBox, /inset\(([^)]*)\)/);
    if (ins) { const [a, b2, c, d] = ins; ins = ins.length === 1 ? [a, a, a, a] : ins.length === 2 ? [a, b2, a, b2] : ins.length === 3 ? [a, b2, c, b2] : [a, b2, c, d]; }
    const tv = nums(i.style.transform, /translate\(([^)]*)\)/), zv = nums(i.style.transform, /scale\(([^)]*)\)/);
    return { nw: i.naturalWidth, nh: i.naturalHeight, w: b.width, h: b.height, ins: ins && { t: ins[0], r: ins[1], b: ins[2], l: ins[3] },
      tr: tv && zv && { x: tv[0], y: tv[1], z: zv[0] }, fit: !i.style.objectViewBox && !i.style.transform,
      cap: document.getElementById('caption').textContent };
  });
  const reg = (s) => ({ w: s.nw - s.ins.l - s.ins.r, h: s.nh - s.ins.t - s.ins.b });

  await check('tall photo opens at Fit and the caption advertises zoom', async () => {
    const s = await st();
    assert.equal(s.fit, true); assert.ok(s.nh > s.nw * 1.5, 'tall: ' + s.nw + 'x' + s.nh);
    assert.match(s.cap, /Enter = zoom/);
  });
  await check('Enter zooms to fill the square, starting at the top', async () => {
    await g.keyboard.press('Enter');
    const s = await st();
    assert.equal(s.fit, false);
    if (!FALLBACK) {
      assert.ok(s.w <= 600.5 && s.h <= 600.5, 'element stays display-sized');
      const r = reg(s);
      assert.ok(Math.abs(r.w / r.h - 1) < 0.02, JSON.stringify(r));
      assert.ok(r.h < s.nh - 1 && s.ins.t < 0.5, JSON.stringify(s.ins));
    } else assert.ok(s.tr.z > 1 && s.tr.z <= 2.5001, JSON.stringify(s.tr));
    await g.screenshot({ path: path.join(OUT, 'photo-zoom1.png') });
  });
  await check('arrows pan the picture instead of switching photos; clamped at both ends', async () => {
    const a = await st();
    await g.keyboard.press('ArrowDown');
    const b = await st();
    if (!FALLBACK) assert.ok(b.ins.t > a.ins.t, 'view moved down'); else assert.ok(b.tr.y < a.tr.y, 'content moved up');
    assert.match(b.cap, /1 \/ 2/);                       // still the first photo
    assert.equal(await g.locator('#menu').isVisible(), false); // Down panned, it did not open the menu
    for (let i = 0; i < 80; i++) await g.keyboard.press('ArrowDown');
    const end = await st();
    if (!FALLBACK) assert.ok(end.ins.b < 0.5 && end.ins.t > 0, JSON.stringify(end.ins));
    await g.screenshot({ path: path.join(OUT, 'photo-zoom-end.png') });
    for (let i = 0; i < 160; i++) await g.keyboard.press('ArrowUp');
    const top = await st();
    if (!FALLBACK) assert.ok(top.ins.t < 0.5, JSON.stringify(top.ins));
    assert.match(top.cap, /1 \/ 2/);
  });
  await check('Zoom 2 shows a smaller region; third Enter returns to Fit', async () => {
    const z1 = await st();
    await g.keyboard.press('Enter');
    const z2 = await st();
    assert.equal(z2.fit, false);
    if (!FALLBACK) { assert.ok(Math.abs(reg(z1).w / reg(z2).w - 1.5) < 0.05); assert.ok(z2.w <= 600.5 && z2.h <= 600.5); }
    else assert.ok(z2.tr.z <= 2.5001);
    await g.keyboard.press('Enter');
    assert.equal((await st()).fit, true);
  });
  await check('at Fit, Right goes to the next photo, which opens at Fit', async () => {
    await g.keyboard.press('ArrowRight');
    await g.waitForFunction(() => /2 \/ 2/.test(document.getElementById('caption').textContent));
    await g.evaluate(() => document.querySelector('#stage img').decode());
    const s = await st();
    assert.equal(s.fit, true); assert.equal(s.nw, 1200);
  });
  await check('a wide photo zooms to a square window and pans sideways', async () => {
    await g.keyboard.press('Enter');
    const a = await st();
    if (!FALLBACK) { const r = reg(a); assert.ok(Math.abs(r.w / r.h - 1) < 0.02 && r.w < a.nw - 1, JSON.stringify(a.ins)); }
    await g.keyboard.press('ArrowRight');
    const b = await st();
    if (!FALLBACK) assert.ok(b.ins.l > a.ins.l, 'view moved right'); else assert.ok(b.tr.x < a.tr.x);
    assert.match(b.cap, /2 \/ 2/);
    await g.keyboard.press('Enter'); await g.keyboard.press('Enter');
    assert.equal((await st()).fit, true);
  });
  await check('slideshow is in the menu; zooming stops it', async () => {
    await g.keyboard.press('ArrowDown');
    await g.keyboard.press('ArrowRight'); await g.keyboard.press('ArrowRight'); await g.keyboard.press('Enter');
    assert.match(await g.textContent('#toast'), /Slideshow on/);
    await g.keyboard.press('Enter');
    assert.equal((await st()).fit, false);
    assert.equal(await g.evaluate(() => /slideshow/.test(document.getElementById('caption').textContent)), false);
    await g.keyboard.press('Enter'); await g.keyboard.press('Enter');
  });
  await check('Back leaves the viewer even while zoomed', async () => {
    await g.keyboard.press('Enter');
    await g.keyboard.press('Escape');
    await g.waitForSelector('#home:not([hidden])');
  });
  await check('no page errors', async () => assert.deepEqual(errs, []));

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nphoto zoom tests passed');
  process.exit(failures ? 1 : 0);
})();
