// Run with: node test/protocol.test.js
'use strict';
const assert = require('node:assert/strict');
const PG = require('../js/shared.js');

function pair() {
  // Two ends; send() delivers a structured clone to the other end asynchronously, in order.
  const mk = () => ({ handlers: {}, open: true, peer: null, dataChannel: { readyState: 'open', bufferedAmount: 0 },
    on(ev, fn) { this.handlers[ev] = fn; },
    send(msg) { const c = structuredClone(msg); setTimeout(() => this.peer.handlers.data && this.peer.handlers.data(c), 0); } });
  const a = mk(), b = mk();
  a.peer = b; b.peer = a;
  return [a, b];
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function bytesOf(blob) { return new Uint8Array(await blob.arrayBuffer()); }

(async () => {
  // --- codes ---
  const c = PG.newCode();
  assert.equal(c.length, 8);
  assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(PG.normalizeCode('abcd-efgh'.replace(/[il]/g, 'j')) !== null, true);
  assert.equal(PG.normalizeCode(PG.formatCode(c)), c);
  assert.equal(PG.normalizeCode('ABCD-EFG'), null);        // too short
  assert.equal(PG.normalizeCode('ABCD-EFG0'), null);       // 0 not in alphabet
  assert.equal(PG.normalizeCode(null), null);
  assert.equal(new Set(Array.from({ length: 200 }, PG.newCode)).size, 200);
  console.log('ok codes');

  // --- full transfer, multi-chunk ---
  {
    const [phone, glasses] = pair();
    const got = [];
    const rx = new PG.Receiver({
      canAccept: () => null,
      onItem: (meta, blob, thumb) => got.push({ meta, blob, thumb })
    });
    const acks = [];
    glasses.on('data', (m) => { for (const r of rx.handle(m)) glasses.send(r); });
    phone.on('data', (m) => acks.push(m));

    const data = new Uint8Array(PG.CHUNK * 3 + 12345);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 255;
    const thumb = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
    const progress = [];
    await PG.sendItem(phone, { id: 'x1', name: 'a.mp4', mime: 'video/mp4', kind: 'video',
      blob: new Blob([data], { type: 'video/mp4' }), thumb, w: 1920, h: 1080, duration: 12.5 },
      (f) => progress.push(f));
    await tick();
    assert.equal(got.length, 1);
    assert.equal(got[0].meta.name, 'a.mp4');
    assert.equal(got[0].meta.duration, 12.5);
    assert.equal(got[0].blob.type, 'video/mp4');
    assert.equal(got[0].blob.size, data.length);
    assert.deepEqual(await bytesOf(got[0].blob), data);
    assert.deepEqual([...(await bytesOf(got[0].thumb))], [1, 2, 3, 4]);
    assert.equal(progress.length, 4);
    assert.equal(progress.at(-1), 1);
    assert.deepEqual(acks.map((a) => [a.t, a.id, a.ok]), [['ack', 'x1', true]]);
    console.log('ok multi-chunk transfer');
  }

  // --- zero-byte and single-chunk ---
  {
    const [phone, glasses] = pair();
    const got = [];
    const rx = new PG.Receiver({ canAccept: () => null, onItem: (m, b) => got.push(b) });
    glasses.on('data', (m) => rx.handle(m));
    await PG.sendItem(phone, { id: 'z', name: 'e', mime: 'image/jpeg', kind: 'photo', blob: new Blob([]), thumb: null });
    await PG.sendItem(phone, { id: 's', name: 's', mime: 'image/jpeg', kind: 'photo', blob: new Blob([new Uint8Array(10)]), thumb: null });
    await tick();
    assert.deepEqual(got.map((b) => b.size), [0, 10]);
    console.log('ok empty + small');
  }

  // --- refusal: receiver says no, sender stops early ---
  {
    const [phone, glasses] = pair();
    let stored = 0;
    const rx = new PG.Receiver({ canAccept: () => 'Glasses are full', onItem: () => stored++ });
    const acks = [];
    glasses.on('data', (m) => { for (const r of rx.handle(m)) glasses.send(r); });
    let nacked = false;
    phone.on('data', (m) => { acks.push(m); if (m.t === 'ack' && !m.ok) nacked = true; });
    // Simulate a busy link: the refusal arrives while the sender is waiting for the buffer to drain.
    phone.dataChannel.bufferedAmount = PG.HIGH_WATER + 1;
    const sending = PG.sendItem(phone, { id: 'n', name: 'big', mime: 'video/mp4', kind: 'video',
      blob: new Blob([new Uint8Array(PG.CHUNK * 40)]), thumb: null }, null, () => nacked);
    setTimeout(() => { phone.dataChannel.bufferedAmount = 0; }, 100);
    await assert.rejects(sending, /Cancelled/);
    await tick();
    assert.equal(stored, 0);
    assert.equal(acks[0].reason, 'Glasses are full');
    assert.equal(rx.activeCount(), 0);
    console.log('ok refusal + early stop');
  }

  // --- integrity failures ---
  {
    const stored = [];
    const rx = new PG.Receiver({ canAccept: () => null, onItem: (m, b) => stored.push(b) });
    // out-of-order chunk
    rx.handle({ t: 'meta', id: 'o', size: 8, mime: 'x' });
    let r = rx.handle({ t: 'chunk', id: 'o', seq: 1, data: new ArrayBuffer(4) });
    assert.equal(r[0].ok, false);
    assert.deepEqual(rx.handle({ t: 'end', id: 'o', chunks: 2 }), []);   // ignored after failure
    // incomplete
    rx.handle({ t: 'meta', id: 'i', size: 8, mime: 'x' });
    rx.handle({ t: 'chunk', id: 'i', seq: 0, data: new ArrayBuffer(4) });
    r = rx.handle({ t: 'end', id: 'i', chunks: 1 });
    assert.equal(r[0].ok, false);
    assert.match(r[0].reason, /incomplete/);
    // oversize
    rx.handle({ t: 'meta', id: 'v', size: 4, mime: 'x' });
    r = rx.handle({ t: 'chunk', id: 'v', seq: 0, data: new ArrayBuffer(9) });
    assert.equal(r[0].ok, false);
    // abort cleans up
    rx.handle({ t: 'meta', id: 'a', size: 4, mime: 'x' });
    assert.equal(rx.activeCount(), 1);
    rx.handle({ t: 'abort', id: 'a' });
    assert.equal(rx.activeCount(), 0);
    // garbage input is ignored
    assert.deepEqual(rx.handle(null), []);
    assert.deepEqual(rx.handle('hi'), []);
    assert.deepEqual(rx.handle({ t: 'chunk', id: 'nope', seq: 0, data: new ArrayBuffer(1) }), []);
    // duplicate meta
    rx.handle({ t: 'meta', id: 'd', size: 4, mime: 'x' });
    r = rx.handle({ t: 'meta', id: 'd', size: 4, mime: 'x' });
    assert.equal(r[0].ok, false);
    assert.equal(stored.length, 0);
    console.log('ok integrity checks');
  }

  // --- backpressure: sender waits while buffered amount is high ---
  {
    const [phone, glasses] = pair();
    const rx = new PG.Receiver({ canAccept: () => null, onItem: () => {} });
    glasses.on('data', (m) => rx.handle(m));
    phone.dataChannel.bufferedAmount = PG.HIGH_WATER + 1;
    let done = false;
    const p = PG.sendItem(phone, { id: 'b', name: 'b', mime: 'x', kind: 'photo', blob: new Blob([new Uint8Array(1000)]), thumb: null })
      .then(() => { done = true; });
    await tick(120);
    assert.equal(done, false, 'sender should be waiting for the buffer to drain');
    phone.dataChannel.bufferedAmount = 0;
    await p;
    assert.equal(done, true);
    console.log('ok backpressure');
  }

  console.log('\nAll protocol tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
