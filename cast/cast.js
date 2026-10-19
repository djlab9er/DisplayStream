/*
 * Glasses-side screen-cast receiver. Shows a pairing code, then plays the incoming WebRTC video.
 * A sender (cast/send.html, or a native Android app per docs/ANDROID_CAST_SPEC.md) calls
 * peer id "pgcast-<CODE>". Calls are auto-accepted; only one at a time (others are closed).
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var peer = null, code = null, current = null, toastTimer = null, destroyed = false;

  // ---- Zoom / pan ----
  // Level 0 = fit (whole screen letterboxed). Level 1 = fill the square (cropped). Level 2 = 1.5x that.
  // Enter cycles levels; arrows pan while zoomed.
  //
  // Preferred method: CSS object-view-box crops the SOURCE frame, so the video element never gets
  // bigger than the display (a CSS scale() of 3x+ made a huge layer that rendered black on the glasses).
  // Fallback for browsers without it: transform scale, with the zoom capped.
  var level = 0, cx = 0, cy = 0, STEP = 90;      // cx, cy = top-left of the visible region, in source px
  var HAS_OVB = !!(window.CSS && CSS.supports && CSS.supports('object-view-box', 'inset(0px)'));
  function vsize() { var v = $('video'); return { w: v.videoWidth || 0, h: v.videoHeight || 0 }; }
  function region() {                              // visible source region at the current level
    var f = vsize(), W = window.innerWidth || 600, H = window.innerHeight || 600;
    var rw = Math.min(f.w, f.h * W / H), rh = rw * H / W;     // "cover" crop
    var m = 1;
    if (rw / f.w > 0.87 && rh / f.h > 0.87) m = 1.5;          // square-ish source: still give a zoom step
    if (level === 2) m *= 1.5;
    return { rw: rw / m, rh: rh / m, vw: f.w, vh: f.h, scale: W / (rw / m) };
  }
  function applyZoom(topAlign) {
    var v = $('video'), r = region();
    if (level === 0 || !r.vw || !r.vh) { v.style.objectViewBox = ''; v.style.transform = ''; return; }
    if (HAS_OVB) {
      if (topAlign) { cx = (r.vw - r.rw) / 2; cy = 0; }
      cx = Math.max(0, Math.min(r.vw - r.rw, cx));
      cy = Math.max(0, Math.min(r.vh - r.rh, cy));
      v.style.transform = '';
      v.style.objectViewBox = 'inset(' + cy + 'px ' + (r.vw - cx - r.rw) + 'px ' + (r.vh - cy - r.rh) + 'px ' + cx + 'px)';
    } else {                                      // fallback: scale, capped so the layer stays modest
      var W = window.innerWidth, H = window.innerHeight, k = Math.min(W / r.vw, H / r.vh);
      var fw = r.vw * k, fh = r.vh * k;
      var z = Math.min(r.scale / k, 2.5);
      var limx = Math.max(0, (fw * z - W) / 2), limy = Math.max(0, (fh * z - H) / 2);
      if (topAlign) { cx = (r.vw - r.rw) / 2; cy = 0; }
      // screen = center + translate + (src*k - fit/2) * z ; put the region's top-left (cx,cy) at screen (0,0)
      var tx = -W / 2 - (cx * k - fw / 2) * z, ty = -H / 2 - (cy * k - fh / 2) * z;
      tx = Math.max(-limx, Math.min(limx, tx)); ty = Math.max(-limy, Math.min(limy, ty));
      v.style.objectViewBox = '';
      v.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
    }
  }
  function cycleZoom() {
    level = (level + 1) % 3;
    applyZoom(true);
    toast(level === 0 ? 'Fit' : level === 1 ? 'Zoom 1 · arrows pan' : 'Zoom 2 · arrows pan');
  }
  function pan(dx, dy) {          // dx/dy = direction the VIEW moves
    if (level === 0) return;
    var r = region(), step = STEP / r.scale;
    cx += dx * step; cy += dy * step;
    var f = vsize(); cx = Math.max(0, Math.min(f.w - r.rw, cx)); cy = Math.max(0, Math.min(f.h - r.rh, cy));
    applyZoom(false);
  }
  function resetZoom() { level = 0; cx = 0; cy = 0; var v = $('video'); v.style.transform = ''; v.style.objectViewBox = ''; }

  function status(t) { $('status').textContent = t; }
  function toast(t) {
    var el = $('toast'); el.textContent = t; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2500);
  }
  function showPair(show) { $('pair').hidden = !show; $('screen').hidden = show; if (show) $('btn-newcode').focus(); }

  function endCall(msg) {
    if (current) { var c = current; current = null; try { c.close(); } catch (e) {} }
    var v = $('video'); v.srcObject = null; resetZoom();
    showPair(true);
    status(msg || 'Waiting for a sender…');
  }

  function onCall(call) {
    if (current) { try { call.close(); } catch (e) {} return; }   // busy
    current = call;
    status('Connecting…');
    call.on('stream', function (stream) {
      if (current !== call) return;
      var v = $('video'); v.srcObject = stream;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      resetZoom(); showPair(false); toast('Casting · Enter = zoom');
    });
    call.on('close', function () { if (current === call) { current = null; endCall('Cast ended. Waiting…'); } });
    call.on('error', function () { if (current === call) { current = null; endCall('Cast failed. Waiting…'); } });
    call.answer();   // receive-only
  }

  function start() {
    destroyed = false;
    code = PG.newCode();
    $('code').textContent = PG.formatCode(code);
    $('send-url').textContent = location.origin.replace(/^https?:\/\//, '') + location.pathname.replace(/[^/]*$/, '') + 'send.html';
    status('Connecting to broker…');
    window.pgPeerReady.then(function () {
      peer = window.pgMakePeer(PG.castPeerId(code));
      peer.on('open', function () { status('Waiting for a sender…'); });
      peer.on('call', onCall);
      peer.on('disconnected', function () { if (!destroyed) { status('Reconnecting…'); try { peer.reconnect(); } catch (e) {} } });
      peer.on('error', function (e) {
        if (e && e.type === 'unavailable-id') { stop(); start(); return; }
        status('Error: ' + ((e && e.type) || 'unknown'));
      });
    }, function () { status('Could not load PeerJS (offline?)'); });
  }

  function stop() {
    destroyed = true;
    if (current) { try { current.close(); } catch (e) {} current = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
  }

  $('btn-newcode').addEventListener('click', function () { stop(); endCall('Starting…'); start(); });

  document.addEventListener('keydown', function (e) {
    if ($('screen').hidden) return;
    var k = e.key;
    if (k === 'Enter') { e.preventDefault(); cycleZoom(); }
    else if (k === 'ArrowLeft')  { e.preventDefault(); pan(-1, 0); }
    else if (k === 'ArrowRight') { e.preventDefault(); pan(1, 0); }
    else if (k === 'ArrowUp')    { e.preventDefault(); pan(0, -1); }
    else if (k === 'ArrowDown')  { e.preventDefault(); pan(0, 1); }
    else if (k === 'Escape') { endCall('Cast stopped. Waiting…'); }
  });
  // Rotation / resolution changes on the sender alter the frame size: re-clamp.
  $('video').addEventListener('resize', function () { applyZoom(false); });
  window.addEventListener('resize', function () { applyZoom(false); });

  start();
})();
