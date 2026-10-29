# Android Cast companion app — specification

Goal: an Android app that streams the phone's screen to the **Screen Cast** web app running on
Meta Ray-Ban Display glasses (`https://djlab9er.github.io/DisplayStream/cast/`). Android Chrome
cannot capture the screen (`getDisplayMedia` is unsupported), so this needs a native app.
The glasses side already exists in this repo (`cast/`); this spec is the sender.

## Protocol (what the glasses expect)
1. Glasses show an 8-char code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (e.g. `K7QW-3M2P`).
2. The glasses register on the PeerJS public broker with peer id **`pgcast-` + CODE** (no dash, uppercase).
3. The sender registers any peer id and places a **media call** to `pgcast-CODE` carrying ONE video track.
   The glasses auto-answer with no media (receive-only). Audio is ignored.
4. Hang up = cast ends; the glasses return to the pairing screen. If the glasses are already casting,
   a second call is closed and the caller is NOT told, so the sender must time out (20 s) with a message.
5. No data channel is used.

### PeerJS wire protocol (verified against peerjs 1.5.4 source)
- WebSocket: `wss://0.peerjs.com/peerjs?key=peerjs&id=<myId>&token=<random>` (or `ws://`/own server).
- Server → client: `OPEN`, `ERROR`, `ID-TAKEN`, `INVALID-KEY`, `LEAVE`, `EXPIRE`, plus relayed `OFFER`, `ANSWER`, `CANDIDATE`.
- Client → server (JSON): `{"type":"OFFER","dst":"pgcast-CODE","payload":{"sdp":{"type":"offer","sdp":"..."},"type":"media","connectionId":"mc_<random>","browser":"..."}}`
  - Candidates: `{"type":"CANDIDATE","dst":...,"payload":{"candidate":{...},"type":"media","connectionId":"mc_..."}}`
  - Answer arrives as `ANSWER` with the same `connectionId`.
- Send a heartbeat `{"type":"HEARTBEAT"}` about every 5 s.
- ICE servers: `stun:stun.l.google.com:19302` (add TURN if cellular/NAT fails; see `js/config.js`).
- Simplest route: use the JVM/Android WebRTC library (`org.webrtc`, e.g. `io.github.webrtc-sdk:android`)
  and implement the signaling above (~150 lines with OkHttp WebSocket). Do not embed a WebView with PeerJS:
  WebView cannot capture the screen either.

## Android requirements
- `minSdk 26`, Kotlin, Jetpack Compose UI (one screen).
- Permissions: `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS` (13+).
- Flow: user enters/pastes code → app requests screen capture via `MediaProjectionManager.createScreenCaptureIntent()`
  → on grant, start a **foreground service** (`foregroundServiceType="mediaProjection"`) BEFORE using the projection
  (required on Android 10+/14 or the capture is killed) → build `ScreenCapturerAndroid` → `VideoSource` → `VideoTrack`.
- Capture size: scale to at most 720 px on the long edge, 15 fps (the display is 600×600 and bandwidth is limited);
  `RtpParameters` max bitrate ≈ 1.5 Mbps; prefer VP8/H264 (hardware).
- Handle: projection stopped by user (`MediaProjection.Callback.onStop`), network loss (retry once), service teardown,
  rotation (re-create the capturer or let WebRTC adapt), Android 14 one-time-per-capture consent.
- Notification with a Stop action while casting. A Quick Settings tile is optional.
- Deep link: `pgcast://cast?c=CODE` (optional; also accept the QR/URL `…/cast/send.html?c=CODE`).
- Privacy: say clearly that the whole screen incl. notifications is shared; offer "Do Not Disturb" hint.

## Phone locks / screen turns off
Android 15 QPR1 and newer stop screen projection whenever the device locks (`MediaProjection.Callback.onStop()`,
log "Stopped MediaProjection due to keyguard lock"); this cannot be prevented by an app. Behavior implemented:
- Hold a partial wake lock and a Wi-Fi lock while casting, so the connection survives when the display is off.
- On `onStop()` do NOT hang up. Keep the WebRTC call open (the glasses keep showing the last frame), post a
  high-importance "Cast paused" notification with a Resume action, and show "Resume casting" in the app.
- Resume re-asks for screen-capture permission (required every time) and restarts the capturer on the SAME
  call and video source. End the cast after 10 minutes paused.
- If the phone has no secure lock (None/Swipe), capture may keep running with the display off; the locks help there.
- What the glasses can show with the display off is the last frame; a turned-off display has nothing new to capture.

## Acceptance tests
1. Open the glasses Screen Cast app, enter the code, accept the system dialog → phone screen appears on the glasses in < 5 s.
2. Rotate phone / switch apps → stream continues.
3. Tap Stop (notification or app) → glasses return to the pairing screen.
4. Wrong code → app shows "No answer" after 20 s, no crash.
5. Glasses already casting → second sender shows "No answer".
6. Revoke the projection from the status bar chip → app stops cleanly.
7. Works on Wi-Fi and cellular (with TURN configured if needed).

## Out of scope
Audio, remote control/touch back-channel, recording, multiple glasses.

## Prompt for your local Claude Code
"Read docs/ANDROID_CAST_SPEC.md and build the Android app it describes in a new folder `android-cast/`
(Gradle Kotlin project). Implement the PeerJS signaling exactly as specified. Provide build instructions."
