/*
 * Optional persistence for received media on the glasses.
 *
 * Backends, in order of preference. Each is verified with a real write + read-back before it
 * is trusted, because Meta's docs only guarantee localStorage and Service Worker/Cache Storage
 * and say nothing about IndexedDB:
 *   1. IndexedDB     stores Blobs directly
 *   2. Cache Storage stores each file as a Response body (a Service Worker is NOT needed)
 *   3. memory        nothing persists; the app still works for the current session
 *
 * Record shape: { id, meta, blob, thumb }
 *   meta = { id, name, kind, mime, size, w, h, duration, addedAt }
 */
(function (root) {
  'use strict';

  var DB_NAME = 'displaystream';
  var STORE = 'items';
  var CACHE_NAME = 'displaystream-media-v1';
  var PROBE_ID = '__probe__';

  var backend = 'memory';
  var db = null;
  var cache = null;

  // ---------- IndexedDB ----------
  function reqDone(tx, req) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(req ? req.result : undefined); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
    });
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = function () { reject(new Error('IndexedDB open blocked')); };
    });
  }

  function idbRun(mode, fn) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(STORE, mode);
        var req = fn(tx.objectStore(STORE));
        reqDone(tx, req).then(resolve, reject);
      } catch (e) { reject(e); }
    });
  }

  function idbPut(rec) {
    return idbRun('readwrite', function (s) {
      return s.put({ id: rec.id, meta: rec.meta, blob: rec.blob, thumb: rec.thumb || null });
    });
  }
  function idbGet(id) { return idbRun('readonly', function (s) { return s.get(id); }); }
  function idbGetAll() { return idbRun('readonly', function (s) { return s.getAll(); }); }
  function idbDelete(id) { return idbRun('readwrite', function (s) { return s.delete(id); }); }
  function idbClear() { return idbRun('readwrite', function (s) { return s.clear(); }); }

  async function probeIdb() {
    if (!root.indexedDB) throw new Error('No IndexedDB');
    db = await idbOpen();
    var blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/octet-stream' });
    await idbPut({ id: PROBE_ID, meta: { id: PROBE_ID }, blob: blob });
    var got = await idbGet(PROBE_ID);
    if (!got || !got.blob || got.blob.size !== 4) throw new Error('IndexedDB probe mismatch');
    var buf = await got.blob.arrayBuffer();
    if (buf.byteLength !== 4) throw new Error('IndexedDB probe unreadable');
    await idbDelete(PROBE_ID);
  }

  // ---------- Cache Storage ----------
  function keyUrl(id, thumb) {
    return root.location.origin + '/__pg/' + encodeURIComponent(id) + (thumb ? '.thumb' : '');
  }

  async function cachePut(rec) {
    var metaHeader = encodeURIComponent(JSON.stringify(rec.meta));
    await cache.put(keyUrl(rec.id), new Response(rec.blob, {
      headers: { 'Content-Type': rec.blob.type || 'application/octet-stream', 'X-PG-Meta': metaHeader }
    }));
    if (rec.thumb) {
      try {
        await cache.put(keyUrl(rec.id, true), new Response(rec.thumb, {
          headers: { 'Content-Type': rec.thumb.type || 'image/jpeg' }
        }));
      } catch (e) { /* a missing thumbnail is fine; the photo itself is saved */ }
    }
  }

  async function cacheList() {
    var keys = await cache.keys();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var u = new URL(keys[i].url);
      if (u.pathname.indexOf('/__pg/') !== 0 || /\.thumb$/.test(u.pathname)) continue;
      var resp = await cache.match(keys[i]);
      if (!resp) continue;
      var meta;
      try { meta = JSON.parse(decodeURIComponent(resp.headers.get('X-PG-Meta') || '')); } catch (e) { continue; }
      if (!meta || !meta.id) continue;
      var blob = await resp.blob();
      var tResp = await cache.match(keyUrl(meta.id, true));
      var thumb = tResp ? await tResp.blob() : null;
      out.push({ id: meta.id, meta: meta, blob: blob, thumb: thumb });
    }
    return out;
  }

  async function cacheRemove(id) {
    await cache.delete(keyUrl(id));
    await cache.delete(keyUrl(id, true));
  }

  async function probeCache() {
    if (!root.caches) throw new Error('No Cache Storage');
    cache = await root.caches.open(CACHE_NAME);
    var url = keyUrl(PROBE_ID);
    await cache.put(url, new Response(new Blob([new Uint8Array([1, 2, 3, 4])]), { headers: { 'Content-Type': 'application/octet-stream' } }));
    var resp = await cache.match(url);
    if (!resp) throw new Error('Cache probe missing');
    var blob = await resp.blob();
    if (blob.size !== 4) throw new Error('Cache probe mismatch');
    await cache.delete(url);
  }

  // ---------- public API ----------
  async function init() {
    try {
      if (root.navigator && root.navigator.storage && root.navigator.storage.persist) {
        root.navigator.storage.persist().catch(function () { /* optional */ });
      }
    } catch (e) { /* optional */ }

    try { await probeIdb(); backend = 'indexeddb'; return { backend: backend }; }
    catch (e) { console.info('IndexedDB not usable:', e && e.message); db = null; }

    try { await probeCache(); backend = 'cache'; return { backend: backend }; }
    catch (e) { console.info('Cache Storage not usable:', e && e.message); cache = null; }

    backend = 'memory';
    return { backend: backend };
  }

  async function list() {
    if (backend === 'indexeddb') return idbGetAll();
    if (backend === 'cache') return cacheList();
    return [];
  }

  async function put(rec) {
    if (backend === 'indexeddb') return idbPut(rec);
    if (backend === 'cache') return cachePut(rec);
    throw new Error('Storage is not persistent on this device');
  }

  async function remove(id) {
    if (backend === 'indexeddb') return idbDelete(id);
    if (backend === 'cache') return cacheRemove(id);
  }

  async function clear() {
    if (backend === 'indexeddb') return idbClear();
    if (backend === 'cache') {
      await root.caches.delete(CACHE_NAME);
      cache = await root.caches.open(CACHE_NAME);
    }
  }

  async function estimate() {
    try {
      if (root.navigator && root.navigator.storage && root.navigator.storage.estimate) {
        var e = await root.navigator.storage.estimate();
        if (e && typeof e.quota === 'number') return { usage: e.usage || 0, quota: e.quota };
      }
    } catch (e) { /* unknown */ }
    return null;
  }

  root.PGStore = {
    init: init, list: list, put: put, remove: remove, clear: clear, estimate: estimate,
    get backend() { return backend; }
  };
})(typeof self !== 'undefined' ? self : this);
