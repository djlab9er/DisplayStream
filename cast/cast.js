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
  var level = 0, panX = 0, panY = 0, STEP = 90;
  function viewSize() { return Math.min(window.innerWidth, window.innerHeight) || 600; }
  function fitSize(v) {
    var vw = v.videoWidth, vh = v.videoHeight, W = window.innerWidth, H = window.innerHeight;
    if (!vw || !vh) return { w: W, h: H };
    var k = Math.min(W / vw, H / vh);
    return { w: vw * k, h: vh * k };
  }
  function zoomFor(l) {
    var v = $('video'), f = fitSize(v);
    var fill = Math.max(window.innerWidth / f.w, window.innerHeight / f.h);
    if (fill < 1.15) fill = 1.5;                 // already square-ish: still offer a zoom step
    return l === 0 ? 1 : l === 1 ? fill : fill * 1.5;
  }
  function limits(z) {
    var f = fitSize($('video'));
    return { x: Math.max(0, (f.w * z - window.innerWidth) / 2), y: Math.max(0, (f.h * z - window.innerHeight) / 2) };
  }
  function applyZoom(topAlign) {
    var z = zoomFor(level), lim = limits(z);
    if (level === 0) { panX = 0; panY = 0; }
    else {
      if (topAlign) { panX = 0; panY = lim.y; }          // start at the top-left/top of the screen
      panX = Math.max(-lim.x, Math.min(lim.x, panX));
      panY = Math.max(-lim.y, Math.min(lim.y, panY));
    }
    $('video').style.transform = level === 0 ? '' : 'translate(' + panX + 'px,' + panY + 'px) scale(' + z + ')';
  }
  function cycleZoom() {
    level = (level + 1) % 3;
    applyZoom(true);
    toast(level === 0 ? 'Fit' : level === 1 ? 'Zoom: arrows to pan' : 'Zoom 2: arrows to pan');
  }
  function pan(dx, dy) {          // dx/dy = direction the VIEW moves
    if (level === 0) return;
    panX -= dx * STEP; panY -= dy * STEP;
    applyZoom(false);
  }
  function resetZoom() { level = 0; panX = 0; panY = 0; $('video').style.transform = ''; }

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
