/*
 * Loads PeerJS: first from ./vendor/peerjs.min.js (self-hosted, preferred),
 * then from public CDNs. Exposes window.pgPeerReady (a Promise) and
 * window.pgMakePeer(id) which applies js/config.js.
 */
(function () {
  // Resolve the local copy relative to THIS script (../vendor/), not the page, so pages in
  // subfolders such as /cast/ find it too. document.currentScript is only set during execution.
  var LOCAL = (document.currentScript && document.currentScript.src)
    ? new URL('../vendor/peerjs.min.js', document.currentScript.src).href
    : 'vendor/peerjs.min.js';

  var SOURCES = [
    LOCAL,
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
  ];

  function load(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () {
        if (window.Peer) resolve(src);
        else reject(new Error('Loaded but Peer is missing: ' + src));
      };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  window.pgPeerReady = (async function () {
    var lastError;
    for (var i = 0; i < SOURCES.length; i++) {
      try { return await load(SOURCES[i]); } catch (e) { lastError = e; }
    }
    throw lastError || new Error('Could not load PeerJS');
  })();

  window.pgMakePeer = function (id) {
    var cfg = window.PG_CONFIG || {};
    var opts = Object.assign({ debug: 1, config: { iceServers: cfg.ICE_SERVERS || [] } }, cfg.PEER_SERVER || {});
    return id ? new window.Peer(id, opts) : new window.Peer(opts);
  };
})();
