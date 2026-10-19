/*
 * Protocol shared by the glasses page and the phone page.
 * Works in browsers (window.PG) and Node (module.exports) so it can be unit tested.
 *
 * Messages (PeerJS "binary" serialization, so objects containing ArrayBuffers are fine):
 *   glasses -> phone   {t:'hello', v, maxFile, free}
 *                      {t:'ack', id, ok, reason?}
 *   phone   -> glasses {t:'meta', id, name, mime, kind:'photo'|'video', size, w, h, duration, thumb, thumbMime}
 *                      {t:'chunk', id, seq, data}
 *                      {t:'end', id, chunks}
 *                      {t:'abort', id}
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PREFIX = 'pgal-';
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  var CODE_LEN = 8;

  var CHUNK = 256 * 1024;              // bytes per message
  var HIGH_WATER = 4 * 1024 * 1024;    // pause sending above this buffered amount
  var MAX_FILE = 150 * 1024 * 1024;    // per-file cap on the glasses
  var MAX_TOTAL = 300 * 1024 * 1024;   // total held in glasses memory

  function randomValues(n) {
    var buf = new Uint32Array(n);
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (!c && typeof require === 'function') c = require('crypto').webcrypto;
    c.getRandomValues(buf);
    return buf;
  }

  function newCode() {
    var buf = randomValues(CODE_LEN), out = '';
    for (var i = 0; i < CODE_LEN; i++) out += ALPHABET[buf[i] % ALPHABET.length];
    return out;
  }

  // Accepts "abcd-efgh", "ABCD EFGH", etc. Returns the 8-char code or null.
  function normalizeCode(input) {
    var s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length !== CODE_LEN) return null;
    for (var i = 0; i < s.length; i++) if (ALPHABET.indexOf(s[i]) < 0) return null;
    return s;
  }

  function formatCode(code) { return code.slice(0, 4) + '-' + code.slice(4); }
  function peerId(code) { return PREFIX + code; }

  // The Cast app uses its own prefix so it never collides with the gallery's peer id.
  var CAST_PREFIX = 'pgcast-';
  function castPeerId(code) { return CAST_PREFIX + code; }

  function newId() {
    var b = randomValues(3);
    return Date.now().toString(36) + '-' + b[0].toString(36) + b[1].toString(36) + b[2].toString(36);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function waitDrain(conn, limit) {
    var dc = conn && conn.dataChannel;
    if (!dc) return;
    var max = limit == null ? HIGH_WATER : limit;
    while (dc.readyState === 'open' && dc.bufferedAmount > max) await sleep(30);
  }

  function byteLength(d) {
    if (d == null) return 0;
    if (typeof d.byteLength === 'number') return d.byteLength;
    if (typeof d.size === 'number') return d.size;
    return 0;
  }

  /*
   * Sends one item over an open connection.
   * item: { id, name, mime, kind, blob, thumb (Blob|null), w, h, duration }
   */
  async function sendItem(conn, item, onProgress, isCancelled) {
    var thumb = item.thumb ? await item.thumb.arrayBuffer() : null;
    var size = item.blob.size;
    conn.send({
      t: 'meta', id: item.id, name: item.name, mime: item.mime, kind: item.kind, size: size,
      w: item.w || 0, h: item.h || 0, duration: item.duration || 0,
      thumb: thumb, thumbMime: item.thumb ? (item.thumb.type || 'image/jpeg') : ''
    });
    var off = 0, seq = 0;
    while (off < size) {
      await waitDrain(conn);
      // Check after waiting: a refusal or cancel often arrives while the buffer drains.
      if (isCancelled && isCancelled()) {
        conn.send({ t: 'abort', id: item.id });
        throw new Error('Cancelled');
      }
      var part = await item.blob.slice(off, Math.min(off + CHUNK, size)).arrayBuffer();
      conn.send({ t: 'chunk', id: item.id, seq: seq++, data: part });
      off += part.byteLength;
      if (onProgress) onProgress(off / size);
    }
    conn.send({ t: 'end', id: item.id, chunks: seq });
  }

  /*
   * Reassembles items on the glasses.
   * opts.canAccept(meta) -> null | reason string
   * opts.onItem(meta, blob, thumbBlob|null)
   * opts.onProgress(meta, fraction)
   * handle(msg) returns an array of replies to send back.
   */
  function Receiver(opts) {
    this.opts = opts;
    this.active = Object.create(null);
    this.ignored = Object.create(null);
  }

  Receiver.prototype.reset = function () {
    this.active = Object.create(null);
    this.ignored = Object.create(null);
  };

  Receiver.prototype.activeCount = function () { return Object.keys(this.active).length; };

  Receiver.prototype.handle = function (msg) {
    if (!msg || typeof msg !== 'object') return [];
    var id = msg.id, e;
    switch (msg.t) {
      case 'meta': {
        var reason = null;
        if (!id || typeof msg.size !== 'number' || msg.size < 0) reason = 'Bad file header';
        else if (this.active[id]) reason = 'Duplicate transfer';
        else reason = this.opts.canAccept(msg);
        if (reason) {
          this.ignored[id] = true;
          return [{ t: 'ack', id: id, ok: false, reason: reason }];
        }
        this.active[id] = { meta: msg, parts: [], bytes: 0, seq: 0 };
        if (msg.size === 0) return [];
        return [];
      }
      case 'chunk': {
        if (this.ignored[id]) return [];
        e = this.active[id];
        if (!e) return [];
        if (msg.seq !== e.seq || !msg.data) {
          delete this.active[id];
          this.ignored[id] = true;
          return [{ t: 'ack', id: id, ok: false, reason: 'Transfer out of order' }];
        }
        e.seq++;
        e.parts.push(msg.data);
        e.bytes += byteLength(msg.data);
        if (e.bytes > e.meta.size) {
          delete this.active[id];
          this.ignored[id] = true;
          return [{ t: 'ack', id: id, ok: false, reason: 'Received more data than expected' }];
        }
        if (this.opts.onProgress) this.opts.onProgress(e.meta, e.meta.size ? e.bytes / e.meta.size : 1);
        return [];
      }
      case 'end': {
        if (this.ignored[id]) { delete this.ignored[id]; return []; }
        e = this.active[id];
        if (!e) return [];
        delete this.active[id];
        if (e.bytes !== e.meta.size || (typeof msg.chunks === 'number' && msg.chunks !== e.seq)) {
          return [{ t: 'ack', id: id, ok: false, reason: 'File arrived incomplete' }];
        }
        var blob = new Blob(e.parts, { type: e.meta.mime || '' });
        var thumb = e.meta.thumb && byteLength(e.meta.thumb)
          ? new Blob([e.meta.thumb], { type: e.meta.thumbMime || 'image/jpeg' }) : null;
        try {
          this.opts.onItem(e.meta, blob, thumb);
        } catch (err) {
          return [{ t: 'ack', id: id, ok: false, reason: 'Could not store file' }];
        }
        return [{ t: 'ack', id: id, ok: true }];
      }
      case 'abort':
        delete this.active[id];
        delete this.ignored[id];
        return [];
      default:
        return [];
    }
  };

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  return {
    PREFIX: PREFIX, CODE_LEN: CODE_LEN, CHUNK: CHUNK, HIGH_WATER: HIGH_WATER,
    MAX_FILE: MAX_FILE, MAX_TOTAL: MAX_TOTAL,
    newCode: newCode, normalizeCode: normalizeCode, formatCode: formatCode, peerId: peerId,
    CAST_PREFIX: CAST_PREFIX, castPeerId: castPeerId,
    newId: newId, sleep: sleep, waitDrain: waitDrain, sendItem: sendItem,
    Receiver: Receiver, formatBytes: formatBytes
  };
});
