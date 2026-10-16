# DisplayStream

View photos/videos located on phone with Meta Displays

Send photos and videos from your phone to your glasses and browse them on the display.
No Google account, no API keys, no server of your own: just a static site and a free public connection broker.

```
 Phone (send.html)  ── WebRTC data channel (peer-to-peer) ──►  Glasses (index.html)
        └── pairing code, exchanged through PeerJS's free public broker ──┘
```

Your files travel directly from phone to glasses and are never stored on a server. The broker only
helps the two devices find each other.

## 1. Host it (HTTPS required)

The glasses only load public HTTPS URLs. Any static host works. Easiest options:

- **Netlify Drop**: drag this whole folder onto <https://app.netlify.com/drop>.
- **Cloudflare Pages**: create a project, upload the folder (direct upload).
- **GitHub Pages**: push the folder to a repo and enable Pages. The included `.nojekyll` file keeps the
  `.well-known` folder from being skipped.

Make sure the folder is uploaded **including** the hidden `.well-known/` folder (it holds the app icon
manifest). After hosting, check this loads in a browser:
`https://YOUR-SITE/.well-known/meta-wearables-manifest.json`
If it doesn't, the app still works but shows Meta's default icon.

Optional: self-host the connection library so there's no CDN dependency. See `vendor/README.txt`.

## 2. Add it to your glasses

In the Meta AI app (Developer Mode already on): **App Settings → Apps → Web Apps → Connect Web App**,
enter your site's URL (the page with `index.html`), and **Save**. The app appears at the bottom of
the glasses' app grid.

## 3. Use it

1. Open the app on the glasses. It shows a code like `75HM-KWSV`.
2. On your phone open `YOUR-SITE/send.html` (bookmark it or add it to your home screen).
3. Enter the code, tap **Connect**, then **Choose photos & videos**.

The phone remembers the code, so next time it reconnects automatically. Tip: `send.html?c=75HM-KWSV`
pre-fills it.

### Controls on the glasses

| Where | Input | Does |
|---|---|---|
| Grid | arrows / Enter | move between thumbnails / open |
| Viewer | ◀ ▶ | previous / next (wraps around) |
| Viewer | Enter | play/pause a video; on photos, start/stop a 5 s slideshow |
| Viewer | ▲ ▼ | pin or hide the filename caption |
| Anywhere | Back | viewer → grid; grid → exits the app |

**Clear all** (press twice) frees the glasses' memory. **New code** replaces the pairing code.

## Things to know

- **Not tested on real hardware.** This was built from Meta's published docs and tested in desktop
  Chromium with a stand-in for the connection library. The unknown is whether the phone and glasses
  can open a direct WebRTC link on your network. If **Connect** reports it can't reach the glasses
  although the code is right, add a TURN relay in `js/config.js` (comments inside explain how).
- **Photos are shrunk** on the phone to 1200 px JPEG by default (the display is 600 × 600), which keeps
  transfers quick. Choose *Original* on the phone for full size.
- **Videos are sent unchanged.** The glasses can only play formats their browser supports. MP4 (H.264)
  and WebM are the safest bet; some iPhone HEVC `.mov` files may not play. The app says so if playback fails.
- **Memory only.** Media lives in the glasses' memory for the session (limits: 150 MB per file,
  300 MB total) and is gone when the app restarts. Send again, or keep the phone page handy.
- **The code is a shared secret.** Anyone who knows the current code can send to your glasses while the
  app is open. Tap **New code** if it leaks.
- The phone page must stay open and awake while sending. It requests a screen wake lock where supported.

## Troubleshooting

| Symptom | Try |
|---|---|
| "Could not load the connection library" | Add `vendor/peerjs.min.js` (see `vendor/README.txt`) and check the glasses have internet |
| Phone: "Glasses not found" | App must be open on the glasses; re-check the code (no 0/O/1/I/L) |
| Connects, then stalls | Add a TURN server in `js/config.js` |
| Photo fails with "Unsupported image format" | Choose a JPEG/PNG; HEIC from some sources can't be decoded by the browser |
| Video shows ! | Codec not supported on the glasses; convert to H.264 MP4 |

## Tests

```
node test/protocol.test.js            # transfer protocol, integrity checks, pairing codes
node test/e2e.js                      # both pages in Chromium (needs Playwright), mock connection
node test/portrait.js                 # tall photos/videos must fit the 600x600 display
```

## Files

```
index.html  css/glasses.css  js/glasses.js      glasses app
send.html   css/send.css     js/send.js         phone page
js/shared.js    protocol + pairing codes        js/peer-loader.js   loads PeerJS (local, then CDN)
js/config.js    TURN / own broker settings
.well-known/meta-wearables-manifest.json  icons/icon.svg   app name and icon on the glasses
```
