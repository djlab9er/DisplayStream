// Unit tests for the video shrink planner. Run: node test/compress.test.js
'use strict';
const assert = require('node:assert/strict');
const C = require('../js/compress.js');
const MB = 1024 * 1024;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok ' + name); };

t('original never compresses', () => assert.deepEqual(C.plan('original', 60, 500 * MB, 150 * MB, 1080), { compress: false }));
t('auto leaves a file that fits alone', () => assert.deepEqual(C.plan('auto', 60, 100 * MB, 150 * MB, 1080), { compress: false }));
t('auto shrinks a file that is too big, aiming under the limit', () => {
  const p = C.plan('auto', 600, 400 * MB, 150 * MB, 1080);          // 10 minutes
  assert.equal(p.compress, true);
  assert.ok(p.estBytes <= 150 * MB * C.FILL + 1, p.estBytes);
  assert.ok(p.bitrate >= C.MIN_BPS && p.height <= 720);
});
t('short clip gets high quality, long clip gets lower resolution', () => {
  const short = C.plan('auto', 30, 300 * MB, 150 * MB, 1080), long = C.plan('auto', 1500, 900 * MB, 150 * MB, 1080);
  assert.equal(short.height, 720); assert.ok(long.height < 720, long.height);
  assert.ok(short.bitrate > long.bitrate);
});
t('refuses a clip too long to ever fit, and says how long is possible', () => {
  const p = C.plan('auto', 7200, 2000 * MB, 150 * MB, 1080);
  assert.match(p.fail, /Too long to fit: about \d+(\.\d)? (min|s)/);
});
t('forced 720p / 480p compress even small files, bounded by the limit', () => {
  const a = C.plan('720', 60, 10 * MB, 150 * MB, 1080), b = C.plan('480', 60, 10 * MB, 150 * MB, 1080);
  assert.equal(a.height, 720); assert.equal(b.height, 480); assert.ok(a.bitrate > b.bitrate);
  const c = C.plan('720', 3600, 800 * MB, 150 * MB, 1080);          // one hour: bitrate must drop to fit
  assert.ok(c.fail || c.estBytes <= 150 * MB);
});
t('never upscales: height is capped at the source', () => assert.equal(C.plan('720', 30, 50 * MB, 10 * MB, 480).height, 480));
t('unknown duration: modest settings, verified later', () => {
  const p = C.plan('auto', NaN, 400 * MB, 150 * MB, 1080);
  assert.equal(p.compress, true); assert.equal(p.estBytes, 0); assert.ok(p.bitrate <= 900000);
});
t('retry plan lowers the bitrate in proportion to the overshoot', () => {
  const first = C.plan('auto', 100, 400 * MB, 100 * MB, 1080);
  const r = C.retryPlan(first, 130 * MB, 100 * MB, 100);
  assert.ok(r.bitrate < first.bitrate * 0.8, `${r.bitrate} vs ${first.bitrate}`);
  assert.equal(C.retryPlan({ bitrate: 260000, height: 360 }, 500 * MB, 10 * MB, 100), null);
});
console.log('\nAll ' + n + ' compress planner tests passed');
