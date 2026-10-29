/*
 * Glasses-side screen-cast receiver. Shows a pairing code, then plays the incoming WebRTC video.
 * A sender (cast/send.html, or a native Android app per docs/ANDROID_CAST_SPEC.md) calls
 * peer id "pgcast-<CODE>". Calls are auto-accepted; only one at a time (others are closed).
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var peer = null, code = null, current = null, toastTimer = null, destroyed = false;

  // ---- Zoom / pan (shared module js/zoom.js) ----
  var zoom = PGZoom.create($('video'), function () { var v = $('video'); return { w: v.videoWidth || 0, h: v.videoHeight || 0 }; },
    { forceFallback: /[?&]fallback=1/.test(location.search) });
  function cycleZoom() { toast(zoom.cycle()); }
  function pan(dx, dy) { zoom.pan(dx, dy); }
  function resetZoom() { zoom.reset(); }
  function applyZoom() { zoom.refresh(); }

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
  $('video').addEventListener('resize', function () { applyZoom(); });
  window.addEventListener('resize', function () { applyZoom(); });

  start();
})();
