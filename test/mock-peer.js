/*
 * TEST ONLY. A stand-in for PeerJS that routes "connections" between two pages of the
 * same browser through a BroadcastChannel, so both pages can be exercised end to end
 * without the real library or network. It does NOT test WebRTC itself.
 */
(function () {
  var bc = new BroadcastChannel('mock-peerjs');
  var registry = {};

  function rid() { return 'mock-' + Math.random().toString(36).slice(2, 10); }

  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; };
  Emitter.prototype.emit = function (ev) {
    var a = [].slice.call(arguments, 1);
    (this._h[ev] || []).slice().forEach(function (f) { f.apply(null, a); });
  };

  function Conn(peer, remoteId, cid) {
    Emitter.call(this);
    this.peer = peer; this.remoteId = remoteId; this.cid = cid;
    this.open = false;
    this.dataChannel = { readyState: 'open', bufferedAmount: 0 };
  }
  Conn.prototype = Object.create(Emitter.prototype);
  Conn.prototype.send = function (d) { bc.postMessage({ k: 'data', to: this.remoteId, from: this.peer.id, cid: this.cid, d: d }); };
  Conn.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    bc.postMessage({ k: 'close', to: this.remoteId, from: this.peer.id, cid: this.cid });
    this.emit('close');
  };

  function Peer(id, opts) {
    Emitter.call(this);
    if (id && typeof id === 'object') { opts = id; id = null; }
    this.id = id || rid();
    this.destroyed = false;
    this.conns = {};
    registry[this.id] = this;
    var self = this;
    setTimeout(function () { self.emit('open', self.id); }, 20);
  }
  Peer.prototype = Object.create(Emitter.prototype);
  Peer.prototype.connect = function (remoteId) {
    var self = this, cid = rid(), c = new Conn(this, remoteId, cid);
    this.conns[cid] = c;
    bc.postMessage({ k: 'connect', to: remoteId, from: this.id, cid: cid });
    c._t = setTimeout(function () { if (!c.open) self.emit('error', { type: 'peer-unavailable' }); }, 1500);
    return c;
  };
  Peer.prototype.reconnect = function () { this.emit('open', this.id); };
  Peer.prototype.destroy = function () {
    this.destroyed = true;
    delete registry[this.id];
    var conns = this.conns;
    Object.keys(conns).forEach(function (k) { conns[k].close(); });
  };

  bc.onmessage = function (ev) {
    var m = ev.data, p = registry[m.to];
    if (!p) return;
    if (m.k === 'connect') {
      var c = new Conn(p, m.from, m.cid);
      p.conns[m.cid] = c;
      p.emit('connection', c);
      c.open = true;
      bc.postMessage({ k: 'accept', to: m.from, from: p.id, cid: m.cid });
      c.emit('open');
      return;
    }
    var cc = p.conns[m.cid];
    if (!cc) return;
    if (m.k === 'accept') { clearTimeout(cc._t); cc.open = true; cc.emit('open'); }
    else if (m.k === 'data') cc.emit('data', m.d);
    else if (m.k === 'close' && cc.open) { cc.open = false; cc.emit('close'); }
  };

  window.Peer = Peer;
})();
