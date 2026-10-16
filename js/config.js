/*
 * Optional settings. The defaults work with PeerJS's free public broker.
 *
 * If the phone and glasses can't connect (strict Wi-Fi/cellular NAT), add a TURN
 * server to ICE_SERVERS below. Free/low-cost TURN providers exist (e.g. Metered
 * "Open Relay"). Keep the Google STUN entry as the first item.
 *
 * To use your own PeerJS server instead of the public one, fill in PEER_SERVER.
 */
window.PG_CONFIG = {
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // { urls: 'turn:YOUR_TURN_HOST:443?transport=tcp', username: '...', credential: '...' },
  ],

  // Leave empty ({}) to use the public PeerJS broker (0.peerjs.com).
  // Example: { host: 'peer.example.com', port: 443, path: '/', secure: true }
  PEER_SERVER: {}
};
