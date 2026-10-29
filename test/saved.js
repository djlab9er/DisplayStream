// Saved-photos test: persistence across reloads, delete menu, Clear all, and every fallback.
// Run: node test/saved.js  (Playwright + Chromium, mock PeerJS)
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

// Three distinct JPEGs, written to disk once.
async function makeFiles(browser, base) {
  const p = await browser.newPage();
  await p.goto(base + '/send.html');
  const b64s = await p.evaluate(async () => {
    const out = [];
    for (const [i, hue] of [[1, 10], [2, 120], [3, 220]]) {
      const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d');
      x.fillStyle = `hsl(${hue},80%,50%)`; x.fillRect(0, 0, 800, 600); x.fillStyle = '#fff'; x.font = '120px sans-serif'; x.fillText('#' + i, 300, 330);
      const b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
      let s = ''; for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode(...b.subarray(k, k + 0x8000));
      out.push(btoa(s));
    }
    return out;
  });
  await p.close();
  return b64s.map((b, i) => { const f = path.join(OUT, `saved-${i + 1}.jpg`); fs.writeFileSync(f, Buffer.from(b, 'base64')); return f; });
}

const tiles = (g) => g.locator('#grid .tile').count();
async function open(ctx, base, init) {
  const g = await ctx.newPage();
  if (init) await g.addInitScript(init);
  const errs = []; g.on('pageerror', (e) => errs.push(e.message));
  g.errs = errs;
  await g.setViewportSize({ width: 600, height: 600 });
  await g.goto(base + '/index.html');
  await g.waitForFunction(() => /Waiting for phone/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
  await g.waitForFunction(() => document.getElementById('store-info').textContent !== '' || true);
  return g;
}
async function pair(ctx, base, g) {
  const code = (await g.textContent('#code')).replace('-', '') || (await g.textContent('#code-mini')).replace('-', '');
  const ph = await ctx.newPage();
  await ph.setViewportSize({ width: 390, height: 844 });
  await ph.goto(base + '/send.html?c=' + code);
  await ph.waitForFunction(() => /Connected to your glasses/.test(document.getElementById('conn-status').textContent), null, { timeout: 5000 });
  return ph;
}
const backend = (g) => g.evaluate(() => window.PGStore.backend);
const info = (g) => g.textContent('#store-info');
const phoneMeta = (ph) => ph.evaluate(() => Array.from(document.querySelectorAll('#queue .meta')).map((m) => m.textContent));

(async () => {
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  const files = await makeFiles(browser, base);

  // ============ 1) IndexedDB (normal) ============
  console.log('IndexedDB backend');
  let ctx = await browser.newContext();
  let g = await open(ctx, base);
  await check('uses IndexedDB and tells the user photos will be kept', async () => {
    assert.equal(await backend(g), 'indexeddb');
    assert.match(await info(g), /saved here/i);
  });
  let ph = await pair(ctx, base, g);
  await ph.setInputFiles('#files', files);
  await check('phone is told each file is saved on the glasses', async () => {
    await ph.waitForFunction(() => Array.from(document.querySelectorAll('#queue .meta')).filter((m) => /Saved on glasses/.test(m.textContent)).length === 3, null, { timeout: 20000 });
  });
  await check('glasses show "Saved on glasses" with a size', async () => {
    assert.match(await info(g), /Saved on glasses · \d/);
    assert.equal(await tiles(g), 3);
  });

  await g.reload();
  await g.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 3, null, { timeout: 8000 });
  await g.waitForTimeout(2800);   // let the "Restored" toast fade for the screenshot
  await g.screenshot({ path: path.join(OUT, 'saved-home.png') });
  await check('after reopening, the 3 photos come back without re-sending', async () => {
    assert.equal(await tiles(g), 3);
    assert.equal(await g.locator('#pair').isHidden(), true);
    assert.equal(await g.evaluate(() => document.activeElement && document.activeElement.className), 'tile');
  });
  await check('restored photos are real, loadable images, in the order they were sent', async () => {
    const ok = await g.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('#grid .tile img'));
      await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
      return imgs.map((i) => i.naturalWidth > 0);
    });
    assert.deepEqual(ok, [true, true, true]);
    await g.keyboard.press('Enter');
    await g.waitForSelector('#stage img');
    const first = await g.evaluate(async () => { const i = document.querySelector('#stage img'); await i.decode(); return [i.naturalWidth, i.naturalHeight, document.getElementById('caption').textContent]; });
    assert.ok(first[0] > 0 && /1 \/ 3/.test(first[2]), JSON.stringify(first));
    await g.screenshot({ path: path.join(OUT, 'saved-viewer.png') });
  });

  await check('Down opens the options menu on "Keep"; Down again closes it; nothing is deleted', async () => {
    await g.keyboard.press('ArrowDown');
    assert.equal(await g.locator('#menu').isVisible(), true);
    assert.equal(await g.evaluate(() => document.activeElement.id), 'btn-menu-keep');
    await g.screenshot({ path: path.join(OUT, 'saved-menu.png') });
    await g.keyboard.press('ArrowDown');
    assert.equal(await g.locator('#menu').isVisible(), false);
    assert.equal(await tiles(g), 3);
  });
  await check('"Keep" (Enter) closes the menu and deletes nothing', async () => {
    await g.keyboard.press('ArrowDown');
    await g.keyboard.press('Enter');
    assert.equal(await g.locator('#menu').isVisible(), false);
    assert.equal(await tiles(g), 3);
  });
  await check('Delete this: removes the photo, shows the next, updates the count', async () => {
    await g.keyboard.press('ArrowDown');
    await g.keyboard.press('ArrowRight');
    assert.equal(await g.evaluate(() => document.activeElement.id), 'btn-menu-delete');
    await g.keyboard.press('Enter');
    await g.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 2);
    assert.equal(await g.locator('#menu').isVisible(), false);
    assert.equal(await g.locator('#viewer').isVisible(), true);
    assert.match(await g.textContent('#caption'), /1 \/ 2/);
  });
  await check('the deletion is permanent (still 2 after reopening)', async () => {
    await g.reload();
    await g.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 2, null, { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await tiles(g), 2);
  });
  await check('deleting the last photos returns to the pairing screen and persists', async () => {
    for (let n = 0; n < 2; n++) {
      if (await g.locator('#viewer').isHidden()) await g.keyboard.press('Enter');
      await g.waitForSelector('#viewer:not([hidden])');
      await g.keyboard.press('ArrowDown'); await g.keyboard.press('ArrowRight'); await g.keyboard.press('Enter');
      await g.waitForTimeout(200);
    }
    await g.waitForSelector('#home:not([hidden])');
    assert.equal(await tiles(g), 0);
    assert.equal(await g.locator('#pair').isVisible(), true);
    await g.reload();
    await g.waitForTimeout(800);
    assert.equal(await tiles(g), 0);
  });

  await ph.close();
  ph = await pair(ctx, base, g);
  await ph.setInputFiles('#files', files.slice(0, 2));
  await ph.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 2, null, { timeout: 20000 });
  await check('Clear all wipes saved photos too (two presses)', async () => {
    await g.click('#btn-clear'); await g.click('#btn-clear');
    await g.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 0);
    await g.reload();
    await g.waitForTimeout(800);
    assert.equal(await tiles(g), 0);
    assert.match(await info(g), /saved here/i);
  });
  await check('no page errors (IndexedDB run)', async () => assert.deepEqual(g.errs, []));
  await ctx.close();

  // ============ 2) IndexedDB blocked -> Cache Storage ============
  console.log('Cache Storage fallback');
  ctx = await browser.newContext();
  g = await open(ctx, base, () => { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); });
  await check('falls back to Cache Storage', async () => assert.equal(await backend(g), 'cache'));
  ph = await pair(ctx, base, g);
  await ph.setInputFiles('#files', files.slice(0, 2));
  await ph.waitForFunction(() => Array.from(document.querySelectorAll('#queue .meta')).filter((m) => /Saved on glasses/.test(m.textContent)).length === 2, null, { timeout: 20000 });
  await g.reload();
  await g.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 2, null, { timeout: 8000 });
  await check('photos survive a reload via Cache Storage', async () => {
    assert.equal(await tiles(g), 2);
    const ok = await g.evaluate(async () => { const i = document.querySelector('#grid .tile img'); await i.decode(); return i.naturalWidth > 0; });
    assert.equal(ok, true);
  });
  await check('delete works and persists via Cache Storage', async () => {
    await g.keyboard.press('Enter'); await g.waitForSelector('#viewer:not([hidden])');
    await g.keyboard.press('ArrowDown'); await g.keyboard.press('ArrowRight'); await g.keyboard.press('Enter');
    await g.waitForFunction(() => document.querySelectorAll('#grid .tile').length === 1);
    await g.reload(); await g.waitForTimeout(800);
    assert.equal(await tiles(g), 1);
  });
  await check('Clear all wipes the Cache Storage copy', async () => {
    await g.click('#btn-clear'); await g.click('#btn-clear');
    await g.waitForTimeout(300);
    await g.reload(); await g.waitForTimeout(800);
    assert.equal(await tiles(g), 0);
  });
  await ctx.close();

  // ============ 3) nothing available -> memory only ============
  console.log('No persistent storage');
  ctx = await browser.newContext();
  g = await open(ctx, base, () => {
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    Object.defineProperty(window, 'caches', { value: undefined, configurable: true });
  });
  await check('detects memory-only and says so', async () => {
    assert.equal(await backend(g), 'memory');
    assert.match(await info(g), /Not saved/i);
  });
  ph = await pair(ctx, base, g);
  await ph.setInputFiles('#files', files.slice(0, 1));
  await ph.waitForFunction(() => document.querySelectorAll('#queue .meta.ok').length === 1, null, { timeout: 20000 });
  await check('phone is told the file was NOT saved, but it still shows on the glasses', async () => {
    await ph.waitForFunction(() => /Not saved/.test(document.querySelector('#queue .meta').textContent), null, { timeout: 5000 });
    assert.equal(await tiles(g), 1);
  });
  await check('nothing is restored after reopening', async () => {
    await g.reload(); await g.waitForTimeout(800);
    assert.equal(await tiles(g), 0);
  });
  await ctx.close();

  // ============ 4) storage full ============
  console.log('Storage full');
  ctx = await browser.newContext();
  g = await open(ctx, base);
  await g.evaluate(() => { window.PGStore.put = () => Promise.reject(Object.assign(new Error('full'), { name: 'QuotaExceededError' })); });
  ph = await pair(ctx, base, g);
  await ph.setInputFiles('#files', files.slice(0, 1));
  await check('a full disk is reported to the phone; the photo is still viewable', async () => {
    await ph.waitForFunction(() => /Not saved \(Glasses storage is full\)/.test(document.querySelector('#queue .meta').textContent), null, { timeout: 20000 });
    assert.equal(await tiles(g), 1);
  });
  await check('no page errors (storage full)', async () => assert.deepEqual(g.errs, []));
  await ctx.close();

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nsaved-photos tests passed');
  process.exit(failures ? 1 : 0);
})();
