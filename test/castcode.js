// Cast code persistence: the glasses keep the same pairing code across reloads; "New code" replaces it.
// Run: node test/castcode.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/vendor/peerjs.min.js')) p = '/test/mock-peer.js';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
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
  const code = async () => (await page.textContent('#code')).replace('-', '');
  await page.goto(base + '/cast/index.html');
  await page.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.getElementById('code').textContent));
  const first = await code();
  await check('code survives a reload', async () => {
    await page.reload();
    await page.waitForFunction(() => /^[A-Z2-9]{4}-/.test(document.getElementById('code').textContent));
    assert.equal(await code(), first);
  });
  await check('code survives closing and reopening the app', async () => {
    const p2 = await ctx.newPage(); await p2.goto(base + '/cast/index.html');
    await p2.waitForFunction(() => /^[A-Z2-9]{4}-/.test(document.getElementById('code').textContent));
    assert.equal((await p2.textContent('#code')).replace('-', ''), first);
    await p2.close();
  });
  await check('New code replaces it, and that one then persists', async () => {
    await page.click('#btn-newcode');
    await page.waitForFunction((o) => document.getElementById('code').textContent.replace('-', '') !== o, first);
    const second = await code(); assert.notEqual(second, first);
    await page.reload();
    await page.waitForFunction(() => /^[A-Z2-9]{4}-/.test(document.getElementById('code').textContent));
    assert.equal(await code(), second);
  });
  await browser.close(); srv.close();
  console.log(failures ? failures + ' FAILED' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
