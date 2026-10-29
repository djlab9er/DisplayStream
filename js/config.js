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
  // How much the glasses accept. Defaults: 150 MB per file, 300 MB in total. Raise them if your
  // glasses cope; lower them if the app ever runs out of memory. (Fractions are fine.)
  // MAX_FILE_MB: 150,
  // MAX_TOTAL_MB: 300,

  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // { urls: 'turn:YOUR_TURN_HOST:443?transport=tcp', username: '...', credential: '...' },
  ],

  // Leave empty ({}) to use the public PeerJS broker (0.peerjs.com).
  // Example: { host: 'peer.example.com', port: 443, path: '/', secure: true }
  PEER_SERVER: {}
};
