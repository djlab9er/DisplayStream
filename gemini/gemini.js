/*
 * Launcher for the Gemini Glasses phone app. Opening this app on the glasses sends a "start" ping
 * through PeerJS's public broker (the same one Cast uses) to the phone, which then connects to the
 * glasses and shows its Ask screen. The code is made once here and typed into the phone app once.
 */
(function () {
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var KEY = 'pgem.code';
  var $ = function (id) { return document.getElementById(id); };

  function makeCode() {
    var out = '';
    var buf = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < 8; i++) out += ALPHABET[buf[i] % ALPHABET.length];
    return out;
  }
  function loadCode() {
    try { var c = localStorage.getItem(KEY); if (c && /^[A-Z2-9]{8}$/.test(c)) return c; } catch (e) {}
    var n = makeCode();
    try { localStorage.setItem(KEY, n); } catch (e) {}
    return n;
  }
  function setStatus(t) { $('status').textContent = t; }

  var code = loadCode();
  $('code').textContent = code;
  var peer = null, answered = false, timer = null, tries = 0, retry = null;

  function close() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (retry) { clearTimeout(retry); retry = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
  }
  function noPhone(msg) {
    setStatus(msg);
    $('pair').hidden = false;
    close();
  }
  // The glasses' network can take a few seconds to come up right after an app opens, so a failed
  // first attempt is retried a few times before giving up.
  function again(why) {
    if (answered) return;
    close();
    if (tries < 4) {
      tries++;
      setStatus('Connecting… (' + tries + ')');
      retry = setTimeout(function () { go(); }, 2000);
    } else {
      setStatus('No network (' + why + '). Tap Start Gemini to try again.');
    }
  }

  // Primary route: a plain HTTPS request to ntfy.sh (the phone app listens on the same topic).
  // If that fails, fall back to the PeerJS broker route below.
  function start() {
    tries = 0; answered = false; close();
    $('pair').hidden = false;
    setStatus('Contacting your phone…');
    var done = false;
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    fetch('https://ntfy.sh/pggem-' + code.toLowerCase(), { method: 'POST', body: 'launch', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        clearTimeout(t); done = true;
        if (r.ok) setStatus('Sent. Gemini should appear in a few seconds.');
        else go();
      }, function () { clearTimeout(t); if (!done) go(); });
  }

  function go() {
    close();
    setStatus('Contacting your phone…');
    // Same PeerJS loader and broker connection the Cast app uses on the glasses.
    window.pgPeerReady.then(function () {
      if (answered) return;
      var me;
      try { me = peer = window.pgMakePeer('pgglaunch-' + makeCode()); }
      catch (e) { again('start'); return; }
      me.on('open', function () {
        if (me !== peer) return;
        me.socket.on('message', function (m) {
          if (me !== peer || !m) return;
          if (m.type === 'ANSWER') {
            answered = true;
            setStatus('Starting Gemini… it will appear in a moment.');
            close();
          } else if (m.type === 'EXPIRE') {
            noPhone('Phone is not listening.');
          }
        });
        me.socket.send({ type: 'OFFER', dst: 'pggem-' + code,
          payload: { type: 'launch', connectionId: 'launch' } });
        timer = setTimeout(function () { if (!answered) noPhone('Phone did not answer.'); }, 8000);
      });
      me.on('error', function (e) { if (me === peer) again((e && e.type) || 'error'); });
      me.on('disconnected', function () { if (me === peer && !answered && !timer) again('offline'); });
    }, function () { again('library'); });
  }

  $('go').addEventListener('click', start);
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
  start();
})();
