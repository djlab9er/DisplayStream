Optional: self-host PeerJS so the app doesn't depend on a public CDN.

From the project folder, run:

  curl -L -o vendor/peerjs.min.js https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js

If vendor/peerjs.min.js exists the app uses it; otherwise it falls back to unpkg, then jsDelivr.
