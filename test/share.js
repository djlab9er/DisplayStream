// Share-target test: a multipart POST to ./share-target (what Android's Share sheet does) is
// parked by the service worker and the sender page picks it up and queues the files.
// Run: node test/share.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/vendor/peerjs.min.js')) p = '/test/mock-peer.js';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Service-Worker-Allowed': '/' });
  fs.createReadStream(f).pipe(res);
});
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').slice(0, 3).join(' | ')); }
}

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await check('manifest declares a share target for files', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    assert.equal(m.share_target.method, 'POST');
    assert.equal(m.share_target.enctype, 'multipart/form-data');
    assert.equal(m.share_target.params.files[0].name, 'files');
    for (const i of m.icons) assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src);
  });

  await page.goto(base + '/send.html');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();                       // now controlled by the service worker
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);

  await check('shared files are queued after the POST', async () => {
    await page.evaluate(async () => {
      const fd = new FormData();
      const c = document.createElement('canvas'); c.width = 400; c.height = 300;
      c.getContext('2d').fillRect(0, 0, 400, 300);
      const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg'));
      fd.append('files', new File([jpg], 'one.jpg', { type: 'image/jpeg' }));
      fd.append('files', new File([jpg], 'two.jpg', { type: 'image/jpeg' }));
      const form = document.createElement('form');
      form.method = 'POST'; form.action = 'share-target'; form.enctype = 'multipart/form-data';
      const inp = document.createElement('input'); inp.type = 'file'; inp.name = 'files'; inp.multiple = true;
      const dt = new DataTransfer();
      fd.getAll('files').forEach((f) => dt.items.add(f));
      inp.files = dt.files; form.appendChild(inp); document.body.appendChild(form);
      form.submit();
    });
    await page.waitForURL(/send\.html/);
    await page.waitForFunction(() => document.querySelectorAll('#queue li').length === 2, null, { timeout: 8000 });
    const names = await page.locator('#queue li').allInnerTexts();
    assert.ok(/one\.jpg/.test(names.join()) && /two\.jpg/.test(names.join()), names.join('|'));
    assert.equal(new URL(page.url()).search, '');
  });

  await check('inbox is emptied (a reload does not re-queue)', async () => {
    const n = await page.evaluate(async () => (await (await caches.open('pg-share-inbox')).keys()).length);
    assert.equal(n, 0);
  });

  await browser.close(); srv.close();
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
