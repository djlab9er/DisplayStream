/*
 * Glasses side: shows a pairing code, receives photos/videos from the phone over
 * a PeerJS (WebRTC) data channel, and displays them.
 *
 * Input model (per Meta's docs): the browser moves focus with arrow keys and
 * activates with Enter on the home screen. In the viewer we handle the keys
 * ourselves (a photo viewer is a custom interaction); Back is the native action
 * and uses history, so there is always a way out.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    home: $('home'), viewer: $('viewer'), stage: $('stage'), caption: $('caption'), toast: $('toast'),
    dot: $('dot'), status: $('status'), codeMini: $('code-mini'), pair: $('pair'), code: $('code'),
    sendUrl: $('send-url'), grid: $('grid'), btnNew: $('btn-newcode'), btnClear: $('btn-clear'),
    storeInfo: $('store-info'), menu: $('menu'), btnKeep: $('btn-menu-keep'), btnDelete: $('btn-menu-delete'), btnSlide: $('btn-menu-slideshow')
  };

  var CODE_KEY = 'pgal.code';
  var SLIDE_MS = 5000;

  var storeReady = false;
  var items = [];
  var usedBytes = 0;
  var persistent = false;      // true once PGStore picked a real backend
  var storageFree = null;      // bytes the browser says we may still store (null = unknown)
  var current = -1;

  var code = null;
  var peer = null;
  var peerOpen = false;
  var conn = null;
  var restartTimer = null;
  var restartDelay = 3000;
  var receivingText = '';
  var fatalText = '';

  var slideshow = false, slideTimer = null;
  var zoom = null;             // PGZoom for the photo on screen (null for videos / nothing shown)
  var captionTimer = null, captionPinned = false, toastTimer = null;
  var clearArmed = false, clearTimer = null;

  // ---------- storage ----------
  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  // ---------- small helpers ----------
  function fmtDuration(sec) {
    if (!sec || !isFinite(sec)) return '';
    var s = Math.round(sec), m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }
  function freeBytes() {
    var f = PG.MAX_TOTAL - usedBytes;
    if (persistent && storageFree != null) f = Math.min(f, storageFree);
    return Math.max(0, f);
  }
  function refreshStorageFree() {
    if (!persistent) return Promise.resolve();
    return PGStore.estimate().then(function (e) {
      storageFree = e ? Math.max(0, e.quota - e.usage) : null;
    }, function () { storageFree = null; });
  }

  function toast(text, ms) {
    els.toast.textContent = text;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, ms || 2200);
  }

  // ---------- status / layout ----------
  function renderStatus() {
    var text, on = false;
    if (fatalText) text = fatalText;
    else if (receivingText) { text = receivingText; on = true; }
    else if (conn && conn.open) { text = 'Phone connected'; on = true; }
    else if (peerOpen) text = 'Waiting for phone';
    else text = 'Connecting…';
    els.status.textContent = text;
    els.dot.classList.toggle('on', on);
  }

  function renderLayout() {
    var has = items.length > 0;
    els.pair.hidden = has;
    els.grid.hidden = !has;
    els.codeMini.hidden = !has;
    els.btnClear.hidden = !has;
    els.codeMini.textContent = code ? PG.formatCode(code) : '';
    els.code.textContent = code ? PG.formatCode(code) : '········';
    renderStoreInfo();
  }

  function renderStoreInfo() {
    var t = '';
    if (!storeReady) t = '';
    else if (!persistent) t = 'Not saved when the app closes';
    else if (items.length) t = 'Saved on glasses · ' + PG.formatBytes(usedBytes);
    else t = 'Photos you send are saved here';
    els.storeInfo.textContent = t;
    els.storeInfo.hidden = !t;
  }

  // ---------- pairing code ----------
  function ensureCode() {
    code = PG.normalizeCode(load(CODE_KEY));
    if (!code) { code = PG.newCode(); store(CODE_KEY, code); }
  }
  function rotateCode() {
    code = PG.newCode();
    store(CODE_KEY, code);
    renderLayout();
  }

  // ---------- gallery ----------
  var receiver = new PG.Receiver({
    canAccept: function (meta) {
      if (meta.size > PG.MAX_FILE) return 'Too large for the glasses (max ' + PG.formatBytes(PG.MAX_FILE) + ')';
      var pending = 0;
      Object.keys(receiver.active).forEach(function (k) { pending += receiver.active[k].meta.size; });
      if (usedBytes + pending + meta.size > PG.MAX_TOTAL) return 'Glasses are full. Choose Clear all on the glasses.';
      return null;
    },
    onProgress: function (meta, frac) {
      receivingText = 'Receiving ' + Math.round(frac * 100) + '% · ' + meta.name;
      renderStatus();
    },
    onItem: function (meta, blob, thumb) {
      if (items.some(function (it) { return it.id === meta.id; })) return;
      var item = addItem(meta, blob, thumb);
      receivingText = '';
      renderStatus();
      toast('Received ' + item.name, 1800);
      persistItem(item, meta, blob, thumb);
    }
  });

  // Adds an item to the in-memory gallery and grid. Used for new files and for restoring saved ones.
  function addItem(meta, blob, thumb) {
    var item = {
      id: meta.id, name: meta.name || 'Untitled', kind: meta.kind === 'video' ? 'video' : 'photo',
      mime: meta.mime, size: blob.size, w: meta.w, h: meta.h, duration: meta.duration,
      addedAt: meta.addedAt || Date.now(), saved: false,
      url: URL.createObjectURL(blob), thumbUrl: thumb ? URL.createObjectURL(thumb) : ''
    };
    items.push(item);
    usedBytes += blob.size;
    var wasEmpty = items.length === 1;
    renderLayout();
    appendTile(item);
    if (wasEmpty && !els.home.hidden) focusTile(0);
    return item;
  }

  function reasonFor(e) {
    var n = e && (e.name || '') + ' ' + (e.message || '');
    return /quota/i.test(n) ? 'Glasses storage is full' : 'Could not save on the glasses';
  }

  // Saves a received file, then tells the phone whether it was kept. The file stays viewable either way.
  function persistItem(item, meta, blob, thumb) {
    var report = function (ok, reason) {
      item.saved = ok;
      renderStoreInfo();
      var m = { t: 'saved', id: item.id, ok: ok, free: freeBytes() };
      if (!ok) m.reason = reason || 'Not saved';
      safeSend(conn, m);
    };
    if (!persistent) { report(false, 'This glasses browser can’t keep files after the app closes'); return Promise.resolve(); }
    var rec = {
      id: item.id, blob: blob, thumb: thumb || null,
      meta: { id: item.id, name: item.name, kind: item.kind, mime: item.mime, size: item.size,
              w: item.w, h: item.h, duration: item.duration, addedAt: item.addedAt }
    };
    return PGStore.put(rec).then(function () {
      return refreshStorageFree();
    }).then(function () { report(true); }, function (e) {
      console.warn('save failed', e);
      toast('Not saved: ' + reasonFor(e), 3500);
      report(false, reasonFor(e));
    });
  }

  function restoreSaved() {
    return PGStore.init().then(function (r) {
      persistent = r.backend !== 'memory';
      storeReady = true;
      renderStoreInfo();
      if (!persistent) return null;
      return PGStore.list();
    }).then(function (recs) {
      if (!recs || !recs.length) return refreshStorageFree();
      recs.sort(function (a, b) { return ((a.meta && a.meta.addedAt) || 0) - ((b.meta && b.meta.addedAt) || 0); });
      var n = 0;
      recs.forEach(function (r) {
        try {
          if (!r || !r.blob || !r.meta || items.some(function (it) { return it.id === r.meta.id; })) return;
          addItem(r.meta, r.blob, r.thumb).saved = true;
          n++;
        } catch (e) { console.warn('skipping unreadable saved item', e); }
      });
      renderStatus();
      if (n) toast('Restored ' + n + (n === 1 ? ' saved item' : ' saved items'), 2500);
      return refreshStorageFree();
    }).catch(function (e) {
      console.warn('restore failed', e);
      storeReady = true; persistent = false; renderStoreInfo();
    });
  }

  function appendTile(item) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile';
    b.dataset.id = item.id;
    b.setAttribute('aria-label', (item.kind === 'video' ? 'Video ' : 'Photo ') + item.name);

    var src = item.thumbUrl || (item.kind === 'photo' ? item.url : '');
    if (src) {
      var img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.src = src;
      b.appendChild(img);
    } else {
      var ph = document.createElement('span');
      ph.className = 'ph';
      ph.textContent = item.kind === 'video' ? '▶' : '▫';
      b.appendChild(ph);
    }
    if (item.kind === 'video') {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '▶ ' + (fmtDuration(item.duration) || 'video');
      b.appendChild(badge);
    }
    b.addEventListener('click', function () { openViewer(indexOfId(item.id)); });
    li.appendChild(b);
    els.grid.appendChild(li);
  }

  function indexOfId(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
    return -1;
  }

  function focusTile(i) {
    var tiles = els.grid.querySelectorAll('.tile');
    if (tiles[i]) tiles[i].focus({ preventScroll: false });
  }

  function clearAll() {
    items.forEach(function (it) {
      URL.revokeObjectURL(it.url);
      if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl);
    });
    items = [];
    usedBytes = 0;
    current = -1;
    els.grid.textContent = '';
    if (persistent) PGStore.clear().then(refreshStorageFree).then(sendHello, function (e) { console.warn('clear failed', e); toast('Could not clear saved items', 3000); });
    renderLayout();
    renderStatus();
    sendHello();
    els.btnNew.focus();
  }

  els.btnClear.addEventListener('click', function () {
    if (!clearArmed) {
      clearArmed = true;
      els.btnClear.textContent = 'Press again to clear';
      clearTimer = setTimeout(disarmClear, 4000);
      return;
    }
    disarmClear();
    clearAll();
  });
  function disarmClear() {
    clearArmed = false;
    clearTimeout(clearTimer);
    els.btnClear.textContent = 'Clear all';
  }

  els.btnNew.addEventListener('click', function () {
    rotateCode();
    if (conn) { try { conn.close(); } catch (e) { /* ignore */ } conn = null; }
    receivingText = '';
    restartPeer(0);
    toast('New code: ' + PG.formatCode(code), 3000);
  });

  // ---------- viewer ----------
  function openViewer(i) {
    if (i < 0 || i >= items.length) return;
    current = i;
    history.pushState({ screen: 'viewer', i: i }, '');
    showViewer();
  }

  function showViewer() {
    els.home.hidden = true;
    els.viewer.hidden = false;
    els.viewer.focus();
    renderCurrent();
  }

  function closeViewer() {
    hideMenu();
    stopSlideshow();
    clearStage();
    els.caption.classList.remove('show');
    els.viewer.hidden = true;
    els.home.hidden = false;
    if (current >= 0) focusTile(current); else els.btnNew.focus();
  }

  function clearStage() {
    var v = els.stage.querySelector('video');
    if (v) { try { v.pause(); } catch (e) { /* ignore */ } v.removeAttribute('src'); v.load(); }
    els.stage.textContent = '';
    zoom = null;
  }

  function renderCurrent() {
    var item = items[current];
    if (!item) return;
    clearStage();
    hideMenu();
    clearTimeout(slideTimer);

    if (item.kind === 'video') {
      var v = document.createElement('video');
      v.src = item.url;
      v.playsInline = true;
      v.preload = 'auto';
      v.controls = false;
      if (item.thumbUrl) v.poster = item.thumbUrl;
      var glyph = document.createElement('div');
      glyph.className = 'glyph';
      var gs = document.createElement('span');
      gs.textContent = '▶';
      glyph.appendChild(gs);
      v.addEventListener('play', function () { glyph.hidden = true; clearTimeout(slideTimer); });
      v.addEventListener('pause', function () { glyph.hidden = false; gs.textContent = '▶'; });
      v.addEventListener('ended', function () {
        glyph.hidden = false; gs.textContent = '↻';
        if (slideshow) go(1);
      });
      v.addEventListener('error', function () {
        glyph.hidden = false; gs.textContent = '!';
        toast('This video format can’t play on the glasses', 3500);
      });
      els.stage.appendChild(v);
      els.stage.appendChild(glyph);
    } else {
      var img = new Image();
      img.alt = item.name;
      img.decoding = 'async';
      img.src = item.url;
      zoom = PGZoom.create(img, function () { return { w: img.naturalWidth, h: img.naturalHeight }; });
      els.stage.appendChild(img);
    }

    showCaption();
    scheduleSlide();
  }

  function showCaption() {
    var item = items[current];
    if (!item) return;
    els.caption.textContent = '';
    var n = document.createElement('span');
    n.className = 'name';
    n.textContent = item.name;
    var m = document.createElement('span');
    m.className = 'meta';
    var bits = [(current + 1) + ' / ' + items.length, PG.formatBytes(item.size)];
    if (item.kind === 'video' && item.duration) bits.push(fmtDuration(item.duration));
    if (slideshow) bits.push('slideshow');
    if (persistent) bits.push(item.saved ? 'saved' : 'not saved');
    if (item.kind === 'photo') bits.push('Enter = zoom');
    bits.push('↓ options');
    m.textContent = bits.join(' · ');
    els.caption.appendChild(n);
    els.caption.appendChild(m);
    els.caption.classList.add('show');
    clearTimeout(captionTimer);
    if (!captionPinned) captionTimer = setTimeout(function () { els.caption.classList.remove('show'); }, 3000);
  }

  function toggleCaptionPin() {
    captionPinned = !captionPinned;
    if (captionPinned) { showCaption(); clearTimeout(captionTimer); }
    else els.caption.classList.remove('show');
  }

  function go(delta) {
    if (items.length < 2) return;
    current = (current + delta + items.length) % items.length;
    history.replaceState({ screen: 'viewer', i: current }, '');
    renderCurrent();
  }

  function scheduleSlide() {
    clearTimeout(slideTimer);
    if (slideshow && items.length > 1) slideTimer = setTimeout(function () { go(1); }, SLIDE_MS);
  }

  function stopSlideshow() { slideshow = false; clearTimeout(slideTimer); }

  function primaryAction() {
    var item = items[current];
    if (!item) return;
    if (item.kind === 'video') {
      var v = els.stage.querySelector('video');
      if (!v) return;
      if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () { toast('Could not play this video', 3000); }); }
      else v.pause();
    } else {
      cycleZoom();
    }
  }

  function cycleZoom() {
    if (!zoom) return;
    var img = els.stage.querySelector('img');
    if (!img || !img.naturalWidth) return;       // not decoded yet
    stopSlideshow();                              // don't jump to the next photo while zoomed
    toast(zoom.cycle(), 1800);
    showCaption();
  }

  function toggleSlideshow() {
    if (items.length < 2) { toast('Add more photos for a slideshow'); return; }
    slideshow = !slideshow;
    toast(slideshow ? 'Slideshow on' : 'Slideshow off');
    if (zoom) zoom.reset();
    scheduleSlide();
    showCaption();
  }

  // ---------- delete menu ----------
  function menuOpen() { return !els.menu.hidden; }
  function showMenu() {
    if (!items[current]) return;
    clearTimeout(slideTimer);                     // paused while the menu is open
    var v = els.stage.querySelector('video'); if (v && !v.paused) v.pause();
    els.btnSlide.textContent = slideshow ? 'Stop slideshow' : 'Slideshow';
    els.menu.hidden = false;
    els.btnKeep.focus();
  }
  function hideMenu() {
    if (els.menu.hidden) return;
    els.menu.hidden = true;
    if (!els.viewer.hidden) { els.viewer.focus(); scheduleSlide(); }
  }

  function deleteCurrent() {
    var item = items[current];
    if (!item) return;
    hideMenu();
    URL.revokeObjectURL(item.url);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    items.splice(current, 1);
    usedBytes = Math.max(0, usedBytes - item.size);
    var li = els.grid.querySelector('.tile[data-id="' + item.id + '"]');
    if (li && li.parentNode) li.parentNode.remove();
    if (persistent) PGStore.remove(item.id).then(refreshStorageFree).then(sendHello, function (e) { console.warn('delete failed', e); });
    else sendHello();
    renderLayout();
    toast('Deleted ' + item.name, 2000);
    if (!items.length) { current = -1; history.back(); return; }   // nothing left: back to the home screen
    if (current >= items.length) current = items.length - 1;
    history.replaceState({ screen: 'viewer', i: current }, '');
    renderCurrent();
  }

  els.btnKeep.addEventListener('click', hideMenu);
  els.btnDelete.addEventListener('click', deleteCurrent);
  els.btnSlide.addEventListener('click', function () { hideMenu(); toggleSlideshow(); });

  document.addEventListener('keydown', function (e) {
    if (els.viewer.hidden) return;
    if (menuOpen()) {                       // the two menu buttons take Enter natively; arrows move between them
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowRight':
          e.preventDefault();
          var order = [els.btnKeep, els.btnDelete, els.btnSlide];
          var at = Math.max(0, order.indexOf(document.activeElement));
          order[(at + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length].focus(); break;
        case 'ArrowUp': case 'ArrowDown': case 'Escape': e.preventDefault(); hideMenu(); break;
        default: break;
      }
      return;
    }
    if (zoom && zoom.zoomed) {               // zoomed in: arrows pan, Enter cycles the zoom, Back leaves
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); zoom.pan(-1, 0); break;
        case 'ArrowRight': e.preventDefault(); zoom.pan(1, 0); break;
        case 'ArrowUp': e.preventDefault(); zoom.pan(0, -1); break;
        case 'ArrowDown': e.preventDefault(); zoom.pan(0, 1); break;
        case 'Enter': e.preventDefault(); cycleZoom(); break;
        case 'Escape': e.preventDefault(); history.back(); break;
        default: break;
      }
      return;
    }
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); go(-1); break;
      case 'ArrowRight': e.preventDefault(); go(1); break;
      case 'ArrowUp': e.preventDefault(); toggleCaptionPin(); break;
      case 'ArrowDown': e.preventDefault(); showMenu(); break;
      case 'Enter': e.preventDefault(); primaryAction(); break;
      case 'Escape': e.preventDefault(); history.back(); break; // desktop testing; devices use native Back
      default: break;
    }
  });

  window.addEventListener('popstate', function (e) {
    var st = e.state;
    if (st && st.screen === 'viewer' && items[st.i]) { current = st.i; showViewer(); }
    else closeViewer();
  });

  // ---------- connection ----------
  function safeSend(c, msg) { try { if (c && c.open) c.send(msg); } catch (e) { console.warn('send failed', e); } }

  function sendHello() {
    safeSend(conn, { t: 'hello', v: 1, maxFile: PG.MAX_FILE, free: freeBytes(), persist: persistent });
  }

  function accept(c) {
    if (conn && conn !== c) { try { conn.close(); } catch (e) { /* ignore */ } }
    conn = c;
    receiver.reset();
    receivingText = '';

    var onOpen = function () {
      if (conn !== c) return;
      renderStatus();
      sendHello();
    };
    c.on('open', onOpen);
    if (c.open) onOpen();

    c.on('data', function (d) {
      if (conn !== c) return;
      var replies = receiver.handle(d);
      if (!receiver.activeCount()) receivingText = '';
      replies.forEach(function (r) { r.free = freeBytes(); safeSend(c, r); });
      renderStatus();
    });
    var onGone = function () {
      if (conn !== c) return;
      conn = null;
      receiver.reset();
      receivingText = '';
      renderStatus();
    };
    c.on('close', onGone);
    c.on('error', function (err) { console.warn('conn error', err); onGone(); });
    renderStatus();
  }

  function restartPeer(delay) {
    clearTimeout(restartTimer);
    peerOpen = false;
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } peer = null; }
    renderStatus();
    restartTimer = setTimeout(startPeer, delay == null ? restartDelay : delay);
  }

  function startPeer() {
    if (!window.Peer) return;
    try {
      peer = window.pgMakePeer(PG.peerId(code));
    } catch (e) {
      fatalText = 'This browser can’t do WebRTC';
      renderStatus();
      return;
    }
    var mine = peer;
    mine.on('open', function () {
      if (peer !== mine) return;
      peerOpen = true;
      restartDelay = 3000;
      renderStatus();
    });
    mine.on('connection', function (c) { if (peer === mine) accept(c); });
    mine.on('disconnected', function () {
      if (peer !== mine) return;
      peerOpen = false;
      renderStatus();
      setTimeout(function () { if (peer === mine && !mine.destroyed) { try { mine.reconnect(); } catch (e) { restartPeer(); } } }, 2000);
    });
    mine.on('close', function () { /* destroyed by us or fatally */ });
    mine.on('error', function (err) {
      if (peer !== mine) return;
      var type = err && err.type;
      console.warn('peer error', type, err);
      if (type === 'unavailable-id') { rotateCode(); restartPeer(500); }
      else if (type === 'browser-incompatible') { fatalText = 'This browser can’t do WebRTC'; renderStatus(); }
      else {
        restartDelay = Math.min(restartDelay * 2, 30000);
        restartPeer();
      }
    });
  }

  // ---------- init ----------
  function init() {
    history.replaceState({ screen: 'home' }, '');
    var u = new URL('send.html', location.href);
    els.sendUrl.textContent = (u.host + u.pathname).replace(/\/$/, '');
    ensureCode();
    renderLayout();
    renderStatus();
    els.btnNew.focus();

    restoreSaved();
    window.pgPeerReady.then(startPeer, function (err) {
      console.error(err);
      fatalText = 'Could not load the connection library';
      renderStatus();
    });
  }

  init();
})();
