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
  var ws = null, beat = null, answered = false, timer = null;

  function close() {
    if (beat) { clearInterval(beat); beat = null; }
    if (timer) { clearTimeout(timer); timer = null; }
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  }

  function start() {
    close();
    answered = false;
    $('pair').hidden = true;
    setStatus('Contacting your phone…');
    var id = 'pgglaunch-' + makeCode();
    var token = makeCode();
    try {
      ws = new WebSocket('wss://0.peerjs.com/peerjs?key=peerjs&id=' + id + '&token=' + token);
    } catch (e) { setStatus('No network'); return; }
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'OPEN') {
        beat = setInterval(function () { try { ws.send('{"type":"HEARTBEAT"}'); } catch (e) {} }, 5000);
        ws.send(JSON.stringify({ type: 'OFFER', dst: 'pggem-' + code,
          payload: { type: 'launch', connectionId: 'launch' } }));
        timer = setTimeout(function () {
          if (!answered) {
            setStatus('Phone did not answer.');
            $('pair').hidden = false;
            close();
          }
        }, 8000);
      } else if (m.type === 'ANSWER') {
        answered = true;
        setStatus('Starting Gemini… it will appear in a moment.');
        close();
      } else if (m.type === 'EXPIRE') {
        setStatus('Phone is not listening.');
        $('pair').hidden = false;
        close();
      } else if (m.type === 'ERROR' || m.type === 'ID-TAKEN') {
        setStatus('Could not reach the broker.');
        close();
      }
    };
    ws.onerror = function () { if (!answered) setStatus('No network'); };
  }

  $('go').addEventListener('click', start);
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
  start();
})();
