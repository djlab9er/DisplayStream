/*
 * Phone side: connect to the glasses with the pairing code, queue chosen
 * photos/videos, shrink photos for the display, and stream them over the
 * PeerJS data channel.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    code: $('code'), btnConnect: $('btn-connect'), status: $('conn-status'),
    files: $('files'), quality: $('quality'), vquality: $('vquality'), limits: $('limits'),
    queueCard: $('queue-card'), queue: $('queue'), btnClearDone: $('btn-clear-done')
  };

  var CODE_KEY = 'pgal.sender.code';
  var QUALITY_KEY = 'pgal.sender.quality';
  var VQUALITY_KEY = 'pgal.sender.vquality';

  var peer = null, conn = null, connected = false;
  var wantConnected = false, retries = 0, retryTimer = null, connectTimer = null;
  var maxFile = PG.MAX_FILE, free = PG.MAX_TOTAL;
  var queue = [];
  var pumping = false;
  var pendingAcks = Object.create(null);
  var wakeLock = null;

  // ---------- storage ----------
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function renderLimits() {
    if (!els.limits) return;
    els.limits.textContent = connected
      ? 'Glasses accept files up to ' + PG.formatBytes(maxFile) + ' · ' + PG.formatBytes(free) + ' free'
      : '';
  }

  // ---------- connection status ----------
  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'chip' + (kind ? ' ' + kind : '');
  }

  function teardown() {
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    connected = false;
    if (conn) { try { conn.close(); } catch (e) { /* ignore */ } conn = null; }
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
  }

  function connect(manual) {
    var c = PG.normalizeCode(els.code.value);
    if (!c) { setStatus('Enter the 8-character code from your glasses', 'warn'); return; }
    els.code.value = PG.formatCode(c);
    store(CODE_KEY, c);
    if (manual) retries = 0;
    wantConnected = true;
    teardown();
    setStatus('Connecting…');

    window.pgPeerReady.then(function () {
      var mine = peer = window.pgMakePeer();
      mine.on('open', function () {
        if (peer !== mine) return;
        var cn = mine.connect(PG.peerId(c), { reliable: true });
        wire(cn, mine);
        connectTimer = setTimeout(function () {
          if (peer === mine && !connected) {
            setStatus('Can’t reach the glasses. Is Phone Gallery open on them?', 'err');
            scheduleRetry();
          }
        }, 15000);
      });
      mine.on('error', function (err) {
        if (peer !== mine) return;
        var type = err && err.type;
        if (type === 'peer-unavailable') setStatus('Glasses not found. Open Phone Gallery on them and check the code.', 'err');
        else setStatus('Connection problem (' + (type || 'unknown') + ')', 'err');
        scheduleRetry();
      });
    }, function () {
      setStatus('Could not load the connection library. Check your internet.', 'err');
    });
  }

  function wire(cn, owner) {
    conn = cn;
    cn.on('open', function () {
      if (conn !== cn) return;
      clearTimeout(connectTimer);
      connected = true;
      retries = 0;
      setStatus('Connected to your glasses', 'ok');
      renderLimits();
      renderAll();
      pump();
    });
    cn.on('data', onData);
    var gone = function () {
      if (conn !== cn) return;
      connected = false;
      conn = null;
      Object.keys(pendingAcks).forEach(function (id) {
        pendingAcks[id].reject(new Error('Disconnected'));
      });
      setStatus('Disconnected', 'warn');
      renderLimits();
      renderAll();
      scheduleRetry();
    };
    cn.on('close', gone);
    cn.on('error', gone);
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!wantConnected || connected || retries >= 5) return;
    retries++;
    retryTimer = setTimeout(function () { connect(false); }, 3000 * retries);
  }

  function onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if (typeof msg.free === 'number') free = msg.free;
      if (typeof msg.maxFile === 'number') maxFile = msg.maxFile;
      renderLimits();
    } else if (msg.t === 'ack') {
      if (typeof msg.free === 'number') free = msg.free;
      renderLimits();
      var p = pendingAcks[msg.id];
      if (p) { delete pendingAcks[msg.id]; p.resolve(msg); }
    } else if (msg.t === 'saved') {
      if (typeof msg.free === 'number') free = msg.free;
      renderLimits();
      var q = queue.find(function (x) { return x.id === msg.id; });
      if (q) { q.saved = !!msg.ok; q.savedReason = msg.ok ? '' : (msg.reason || ''); updateRow(q); }
    }
  }

  function waitAck(id, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete pendingAcks[id];
        reject(new Error('The glasses did not confirm the file'));
      }, ms || 90000);
      pendingAcks[id] = {
        resolve: function (m) { clearTimeout(timer); resolve(m); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
    });
  }

  // ---------- media preparation ----------
  function isVideoFile(f) {
    return /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm|3gp|mkv)$/i.test(f.name);
  }

  function canvasToBlob(canvas, type, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Could not encode image')); }, type, q);
    });
  }

  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* try next */ }
      try { return await createImageBitmap(file); } catch (e) { /* try next */ }
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Unsupported image format (HEIC?). Try a JPEG.')); };
      img.src = url;
    });
  }

  async function toJpeg(src, w, h, maxDim, quality) {
    var scale = Math.min(1, maxDim / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(src, 0, 0, cw, ch);
    return canvasToBlob(canvas, 'image/jpeg', quality);
  }

  function swapExt(name, ext) {
    return (name || 'photo').replace(/\.[^.]+$/, '') + ext;
  }

  function videoInfo(file) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var url = URL.createObjectURL(file);
      var done = false;
      function finish(r) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        v.removeAttribute('src');
        try { v.load(); } catch (e) { /* ignore */ }
        resolve(r);
      }
      var timer = setTimeout(function () { finish(null); }, 8000);
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onerror = function () { finish(null); };
      v.onloadedmetadata = function () {
        try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch (e) { finish(null); }
      };
      v.onseeked = function () {
        var w = v.videoWidth, h = v.videoHeight, d = v.duration;
        toJpeg(v, w || 320, h || 180, 240, 0.7).then(
          function (thumb) { finish({ thumb: thumb, w: w, h: h, duration: d }); },
          function () { finish({ thumb: null, w: w, h: h, duration: d }); }
        );
      };
      v.src = url;
    });
  }

  async function prepare(file, maxDim) {
    if (isVideoFile(file)) {
      var info = await videoInfo(file);
      return {
        kind: 'video', blob: file, mime: file.type || 'video/mp4', name: file.name,
        thumb: info && info.thumb, w: info ? info.w : 0, h: info ? info.h : 0, duration: info ? info.duration : 0
      };
    }
    var bmp = await loadBitmap(file);
    var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    try {
      var thumb = await toJpeg(bmp, w, h, 240, 0.7);
      var browserSafe = /^image\/(jpeg|png|webp|gif)$/.test(file.type);
      var small = Math.max(w, h) <= (maxDim || Infinity);
      if (browserSafe && (maxDim === 0 || (small && file.type === 'image/jpeg'))) {
        return { kind: 'photo', blob: file, mime: file.type, name: file.name, thumb: thumb, w: w, h: h, duration: 0 };
      }
      var blob = await toJpeg(bmp, w, h, maxDim || 4096, 0.86);
      return { kind: 'photo', blob: blob, mime: 'image/jpeg', name: swapExt(file.name, '.jpg'), thumb: thumb, w: w, h: h, duration: 0 };
    } finally {
      if (bmp.close) bmp.close();
    }
  }

  // ---------- queue ----------
  async function acquireWakeLock() {
    try { if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignore */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    await acquireWakeLock();
    try {
      for (;;) {
        if (!connected) break;
        var item = queue.find(function (q) { return q.state === 'queued'; });
        if (!item) break;
        await processItem(item);
      }
    } finally {
      pumping = false;
      releaseWakeLock();
    }
  }

  // Shrinks a video so it fits the glasses (see js/compress.js). Result replaces p.blob; kept for retries.
  async function maybeShrink(item, p) {
    if (p.shrunk) return;
    var limit = Math.min(maxFile, free);
    var pl = PGCompress.plan(item.vq, p.duration, p.blob.size, limit, Math.min(p.w || 0, p.h || 0));
    if (pl.fail) throw new Error(pl.fail);
    if (!pl.compress) return;
    item.state = 'compressing';
    item.progress = 0;
    item.origSize = p.blob.size;
    updateRow(item);
    var cancelled = function () { return item.cancelled; };
    var res = await PGCompress.transcode(p.blob, pl, function (f) { item.progress = f; updateRow(item); }, cancelled);
    if (res.blob.size > limit) {                      // recorders overshoot: one more pass, aimed lower
      var again = PGCompress.retryPlan(pl, res.blob.size, limit, p.duration);
      if (!again) throw new Error('Still too large after shrinking (' + PG.formatBytes(res.blob.size) + '). Send a shorter clip.');
      item.note = 'second pass'; item.progress = 0; updateRow(item);
      res = await PGCompress.transcode(p.blob, again, function (f) { item.progress = f; updateRow(item); }, cancelled);
      if (res.blob.size > limit) throw new Error('Still too large after shrinking (' + PG.formatBytes(res.blob.size) + '). Send a shorter clip.');
    }
    p.blob = res.blob; p.mime = res.mime; p.name = swapExt(p.name, res.ext); p.w = res.w; p.h = res.h;
    p.shrunk = true;
    item.note = '';
  }

  async function processItem(item) {
    item.state = 'preparing';
    item.note = '';
    updateRow(item);
    try {
      if (!item.prepared) {
        item.prepared = await prepare(item.file, item.quality);
        if (item.prepared.thumb) item.thumbUrl = URL.createObjectURL(item.prepared.thumb);
      }
      var p = item.prepared;
      if (p.kind === 'video') await maybeShrink(item, p);
      var size = p.blob.size;
      var hint = p.kind === 'video' ? ' Choose Auto under Video size to shrink it.' : '';
      if (size > maxFile) throw new Error('Too large for the glasses (max ' + PG.formatBytes(maxFile) + ').' + hint);
      if (size > free) throw new Error('Not enough room on the glasses (' + PG.formatBytes(free) + ' free).' + (p.kind === 'video' ? hint : ' Choose Clear all on the glasses.'));

      item.state = 'sending';
      item.progress = 0;
      updateRow(item);
      item.nacked = false;
      var ackP = waitAck(item.id);
      ackP.then(function (a) { if (!a.ok) item.nacked = true; }, function () { /* handled below */ });
      try {
        await PG.sendItem(conn, {
          id: item.id, name: p.name, mime: p.mime, kind: p.kind, blob: p.blob, thumb: p.thumb,
          w: p.w, h: p.h, duration: p.duration
        }, function (f) { item.progress = f; updateRow(item); },
        function () { return item.cancelled || item.nacked; });
      } catch (e) {
        if (item.nacked) {
          // The glasses refused the file mid-transfer; surface their reason.
          var refusal = await ackP;
          throw new Error(refusal.reason || 'The glasses rejected this file');
        }
        if (pendingAcks[item.id]) { var pa = pendingAcks[item.id]; delete pendingAcks[item.id]; pa.reject(e); }
        throw e;
      }
      var ack = await ackP;
      if (!ack.ok) throw new Error(ack.reason || 'The glasses rejected this file');
      item.state = 'done';
    } catch (e) {
      if (item.cancelled) { item.state = 'failed'; removeItem(item.id); return; }
      if (!connected) { item.state = 'queued'; item.note = 'Waiting for connection'; }
      else { item.state = 'failed'; item.error = e && e.message ? e.message : 'Failed'; }
    }
    updateRow(item);
  }

  function addFiles(fileList) {
    var q = Number(els.quality.value);
    Array.prototype.forEach.call(fileList, function (file) {
      queue.push({
        id: PG.newId(), file: file, quality: q, vq: els.vquality ? els.vquality.value : 'auto', state: 'queued', progress: 0,
        prepared: null, thumbUrl: '', error: '', note: connected ? '' : 'Waiting for connection', cancelled: false
      });
    });
    renderAll();
    if (!connected && !wantConnected) setStatus('Enter the glasses code and tap Connect to start sending', 'warn');
    pump();
  }

  function removeItem(id) {
    var i = queue.findIndex(function (q) { return q.id === id; });
    if (i < 0) return;
    var it = queue[i];
    if (it.state === 'sending' || it.state === 'compressing') { it.cancelled = true; return; }
    if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    queue.splice(i, 1);
    renderAll();
  }

  // ---------- rendering ----------
  function rowFor(item) { return els.queue.querySelector('[data-id="' + item.id + '"]'); }

  function metaText(item) {
    var size = PG.formatBytes((item.prepared ? item.prepared.blob.size : item.file.size));
    switch (item.state) {
      case 'queued': return size + ' · ' + (item.note || 'Queued');
      case 'preparing': return size + ' · Preparing…';
      case 'compressing': return PG.formatBytes(item.file.size) + ' · Shrinking ' + Math.round((item.progress || 0) * 100) + '%' + (item.note ? ' (' + item.note + ')' : '') + ' · about as long as the video';
      case 'sending': return size + ' · Sending ' + Math.round((item.progress || 0) * 100) + '%';
      case 'done': return size + (item.prepared && item.prepared.shrunk ? ' (was ' + PG.formatBytes(item.origSize) + ')' : '') + ' · Sent' + (item.saved === true ? ' · Saved on glasses' : item.saved === false ? ' · Not saved' + (item.savedReason ? ' (' + item.savedReason + ')' : '') : '');
      case 'failed': return item.error || 'Failed';
      default: return size;
    }
  }

  function buildRow(item) {
    var li = document.createElement('li');
    li.className = 'item';
    li.dataset.id = item.id;

    var th = document.createElement('div');
    th.className = 'th';
    th.textContent = isVideoFile(item.file) ? '▶' : '▫';
    li.appendChild(th);

    var mid = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.file.name;
    var meta = document.createElement('div');
    meta.className = 'meta';
    var bar = document.createElement('div');
    bar.className = 'bar';
    bar.appendChild(document.createElement('i'));
    mid.appendChild(name); mid.appendChild(meta); mid.appendChild(bar);
    li.appendChild(mid);

    var acts = document.createElement('div');
    acts.className = 'acts';
    li.appendChild(acts);
    return li;
  }

  function updateRow(item) {
    var li = rowFor(item);
    if (!li) return;
    var th = li.querySelector('.th');
    if (item.thumbUrl && th.tagName !== 'IMG') {
      var img = new Image();
      img.className = 'th';
      img.alt = '';
      img.src = item.thumbUrl;
      th.replaceWith(img);
    }
    var meta = li.querySelector('.meta');
    meta.textContent = metaText(item);
    meta.className = 'meta' + (item.state === 'failed' ? ' err' : item.state === 'done' ? ' ok' : '');
    li.querySelector('.bar').hidden = item.state !== 'sending' && item.state !== 'compressing';
    li.querySelector('.bar > i').style.inlineSize = Math.round((item.progress || 0) * 100) + '%';

    var acts = li.querySelector('.acts');
    // Rebuild the buttons only when the state changes: progress updates arrive many times a second and
    // replacing the button under a finger would swallow taps.
    if (li.dataset.actsKey === item.state) return;
    li.dataset.actsKey = item.state;
    acts.textContent = '';
    if (item.state === 'failed') {
      var retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = 'Retry';
      retry.addEventListener('click', function () { item.state = 'queued'; item.error = ''; updateRow(item); pump(); });
      acts.appendChild(retry);
    }
    if (item.state !== 'preparing') {
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = item.state === 'sending' || item.state === 'compressing' ? 'Cancel' : 'Remove';
      rm.addEventListener('click', function () { removeItem(item.id); });
      acts.appendChild(rm);
    }
  }

  function renderAll() {
    els.queueCard.hidden = queue.length === 0;
    var existing = {};
    Array.prototype.forEach.call(els.queue.children, function (li) { existing[li.dataset.id] = li; });
    var ids = {};
    queue.forEach(function (item) {
      ids[item.id] = true;
      if (!existing[item.id]) els.queue.appendChild(buildRow(item));
      updateRow(item);
    });
    Object.keys(existing).forEach(function (id) { if (!ids[id]) existing[id].remove(); });
  }

  // ---------- events ----------
  els.btnConnect.addEventListener('click', function () { connect(true); });
  els.code.addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(true); });
  els.files.addEventListener('change', function () {
    if (els.files.files && els.files.files.length) addFiles(els.files.files);
    els.files.value = '';
  });
  els.quality.addEventListener('change', function () { store(QUALITY_KEY, els.quality.value); });
  els.vquality.addEventListener('change', function () { store(VQUALITY_KEY, els.vquality.value); });
  els.btnClearDone.addEventListener('click', function () {
    queue.filter(function (q) { return q.state === 'done'; }).forEach(function (q) { removeItem(q.id); });
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && pumping) acquireWakeLock();
  });
  window.addEventListener('beforeunload', function (e) {
    if (queue.some(function (q) { return q.state === 'sending' || q.state === 'compressing'; })) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- init ----------
  (function init() {
    var q = load(QUALITY_KEY);
    if (q && els.quality.querySelector('option[value="' + q + '"]')) els.quality.value = q;
    var vq = load(VQUALITY_KEY);
    if (vq && els.vquality.querySelector('option[value="' + vq + '"]')) els.vquality.value = vq;

    var fromUrl = new URLSearchParams(location.search).get('c');
    var saved = PG.normalizeCode(fromUrl) || PG.normalizeCode(load(CODE_KEY));
    if (saved) {
      els.code.value = PG.formatCode(saved);
      connect(true);
    }
  })();
})();
