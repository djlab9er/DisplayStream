/*
 * TEST ONLY. A stand-in for PeerJS that routes "connections" and "calls" between pages of the
 * same browser through a BroadcastChannel, so both pages can be exercised end to end without the
 * real library or network.
 *
 *  - Data connections are simulated (no WebRTC).
 *  - Media calls use REAL RTCPeerConnections between the two pages, with signaling relayed over
 *    the BroadcastChannel, so real video really flows and the receiver's <video> really plays.
 *
 * It mirrors only the PeerJS surface this project uses. It does NOT test the PeerJS library or
 * the public broker.
 */
(function () {
  var bc = new BroadcastChannel('mock-peerjs');
  var registry = {};
  var noop = function () {};

  function rid() { return 'mock-' + Math.random().toString(36).slice(2, 10); }

  function Emitter() { this._h = {}; }
  Emitter.prototype.on = function (ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; };
  Emitter.prototype.emit = function (ev) {
    var a = [].slice.call(arguments, 1);
    (this._h[ev] || []).slice().forEach(function (f) { f.apply(null, a); });
  };

  // ---------- data connection (simulated) ----------
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

  // ---------- media connection (real RTCPeerConnection) ----------
  function MediaConn(peer, remoteId, cid) {
    Emitter.call(this);
    this.peer = peer; this.remoteId = remoteId; this.cid = cid;
    this.open = false; this.closed = false;
    this.peerConnection = null;
    this._pend = [];
    this._offer = null;
    this._streamEmitted = false;
  }
  MediaConn.prototype = Object.create(Emitter.prototype);

  MediaConn.prototype._post = function (k, extra) {
    bc.postMessage(Object.assign({ k: k, to: this.remoteId, from: this.peer.id, cid: this.cid }, extra));
  };

  MediaConn.prototype._makePc = function (stream) {
    var self = this;
    var pc = this.peerConnection = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = function (e) { if (e.candidate) self._post('mcand', { c: e.candidate.toJSON() }); };
    pc.ontrack = function (e) {
      if (self._streamEmitted) return;
      self._streamEmitted = true;
      self.open = true;
      self.emit('stream', e.streams[0]);
    };
    pc.oniceconnectionstatechange = function () {
      var s = pc.iceConnectionState;
      self.emit('iceStateChanged', s);
      if (s === 'failed' || s === 'closed') self._finish(false);   // PeerJS closes on failed/closed only
    };
    if (stream) stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
    return pc;
  };

  MediaConn.prototype._flush = function () {
    var pc = this.peerConnection;
    this._pend.splice(0).forEach(function (c) { pc.addIceCandidate(c).catch(noop); });
  };

  MediaConn.prototype._addCand = function (c) {
    var pc = this.peerConnection;
    if (pc && pc.remoteDescription) pc.addIceCandidate(c).catch(noop);
    else this._pend.push(c);
  };

  // caller
  MediaConn.prototype._start = async function (stream) {
    var pc = this._makePc(stream);
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._post('moffer', { d: { type: offer.type, sdp: offer.sdp } });
  };

  // callee (stream optional: receive-only when omitted)
  MediaConn.prototype.answer = async function (stream) {
    var pc = this._makePc(stream);
    await pc.setRemoteDescription(this._offer);
    this._flush();
    var ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    this._post('manswer', { d: { type: ans.type, sdp: ans.sdp } });
  };

  MediaConn.prototype._signal = function (m) {
    var self = this;
    if (m.k === 'manswer') {
      this.peerConnection.setRemoteDescription(m.d).then(function () { self._flush(); }, noop);
    } else if (m.k === 'mcand') {
      this._addCand(m.c);
    } else if (m.k === 'mclose') {
      this._finish(false);
    }
  };

  MediaConn.prototype._finish = function (notify) {
    if (this.closed) return;
    this.closed = true;
    var wasOpen = this.open;
    this.open = false;
    if (notify) this._post('mclose');
    try { if (this.peerConnection) this.peerConnection.close(); } catch (e) { /* ignore */ }
    if (wasOpen || notify || true) this.emit('close');
  };

  MediaConn.prototype.close = function () { this._finish(true); };

  // ---------- peer ----------
  function Peer(id, opts) {
    Emitter.call(this);
    if (id && typeof id === 'object') { opts = id; id = null; }
    this.id = id || rid();
    this.destroyed = false;
    this.conns = {};
    this.mconns = {};
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

  Peer.prototype.call = function (remoteId, stream) {
    var mc = new MediaConn(this, remoteId, rid());
    this.mconns[mc.cid] = mc;
    mc._start(stream).catch(noop);
    return mc;
  };

  Peer.prototype.reconnect = function () { this.emit('open', this.id); };
  Peer.prototype.destroy = function () {
    this.destroyed = true;
    delete registry[this.id];
    var conns = this.conns, mconns = this.mconns;
    Object.keys(conns).forEach(function (k) { conns[k].close(); });
    Object.keys(mconns).forEach(function (k) { mconns[k].close(); });
  };

  bc.onmessage = function (ev) {
    var m = ev.data, p = registry[m.to];
    if (!p) return;

    if (m.k === 'moffer') {
      var mc = new MediaConn(p, m.from, m.cid);
      mc._offer = m.d;
      p.mconns[m.cid] = mc;
      p.emit('call', mc);
      return;
    }
    if (m.k === 'manswer' || m.k === 'mcand' || m.k === 'mclose') {
      var mm = p.mconns[m.cid];
      if (mm) mm._signal(m);
      return;
    }

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
