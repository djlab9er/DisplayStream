/* Computer-side sender: captures the screen and calls the glasses receiver. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var peer = null, call = null, stream = null, timer = null;
  function msg(t) { $('msg').textContent = t; }
  function ui(active) { $('start').disabled = active; $('stop').disabled = !active; }

  function stop(text) {
    clearTimeout(timer);
    if (call) { try { call.close(); } catch (e) {} call = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    ui(false); if (text) msg(text);
  }

  async function start() {
    var code = PG.normalizeCode($('code').value);
    if (!code) { msg('Enter the 8-character code from the glasses.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      msg('This browser cannot capture the screen. Use desktop Chrome, Edge, Firefox or Safari.'); return;
    }
    ui(true); msg('Choose what to share…');
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
    catch (e) { stop('Sharing was cancelled.'); return; }
    stream.getVideoTracks()[0].addEventListener('ended', function () { stop('Sharing stopped.'); });
    msg('Connecting…');
    try { await window.pgPeerReady; } catch (e) { stop('Could not load PeerJS (offline?).'); return; }
    peer = window.pgMakePeer();
    peer.on('error', function (e) { stop('Error: ' + ((e && e.type) || 'unknown')); });
    peer.on('open', function () {
      call = peer.call(PG.castPeerId(code), stream);
      // Rejections (busy / unknown code) are not signalled to the caller, so time out.
      timer = setTimeout(function () { stop('No answer. Check the code, and that the glasses are not already casting.'); }, 20000);
      call.on('iceStateChanged', function (s) {
        if (s === 'connected' || s === 'completed') { clearTimeout(timer); msg('Casting. Press Stop to end.'); }
      });
      call.on('close', function () { stop('The glasses ended the cast.'); });
    });
  }

  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', function () { stop('Stopped.'); });
  var q = new URLSearchParams(location.search).get('c'); if (q) $('code').value = q;
})();
