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
| Viewer | Enter | video: play/pause. Photo: **zoom** — Fit → Zoom 1 (fills the square) → Zoom 2 → Fit |
| Viewer, zoomed | ◀ ▶ ▲ ▼ | pan around the photo (to change photo, zoom back out to Fit first) |
| Viewer | ▲ | pin or hide the filename caption |
| Viewer | ▼ | open the options menu: **Keep** (default) **Delete this** or **Slideshow** (5 s per photo; ◀ ▶ to choose, Enter to confirm, ▲ ▼ to close) |
| Anywhere | Back | viewer → grid; grid → exits the app |

**Clear all** (press twice) deletes everything on the glasses, including saved copies. **New code** replaces the pairing code.

## Things to know

- **Not tested on real hardware.** This was built from Meta's published docs and tested in desktop
  Chromium with a stand-in for the connection library. The unknown is whether the phone and glasses
  can open a direct WebRTC link on your network. If **Connect** reports it can't reach the glasses
  although the code is right, add a TURN relay in `js/config.js` (comments inside explain how).
- **Photos are shrunk** on the phone to 1200 px JPEG by default (the display is 600 × 600), which keeps
  transfers quick. Choose *Original* on the phone for full size.
- **Videos are sent unchanged.** The glasses can only play formats their browser supports. MP4 (H.264)
  and WebM are the safest bet; some iPhone HEVC `.mov` files may not play. The app says so if playback fails.
- **Saved photos.** Everything you send is kept on the glasses and comes back the next time you open
  the app (limits: 150 MB per file, 300 MB total, and whatever space the glasses' browser allows).
  The home screen says *Saved on glasses* and the phone page shows *Saved on glasses* or *Not saved*
  for each file. Storage is tried in this order, each verified with a real write-and-read before use:
  IndexedDB, then Cache Storage, then memory only. Meta's docs don't promise that IndexedDB persists on
  the glasses, so if neither works the app says *Not saved when the app closes* and behaves as before.
  If the glasses' storage fills up, the file still shows for the session and the phone says it wasn't saved.
  Delete one photo from the viewer (▼ menu) or everything with **Clear all**.
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

## Screen Cast (experimental)

A second glasses web app, **Screen Cast**, shows a live screen shared from another device.

- Glasses launch URL: `https://djlab9er.github.io/DisplayStream/cast/` (add it in the Meta AI app as a second web app, same steps as the gallery).
- The glasses show a code. On a **desktop** browser open `.../cast/send.html`, enter the code and pick a screen/window/tab to share.
- **Android phones**: Chrome cannot capture the screen, so a native app is needed. See [docs/ANDROID_CAST_SPEC.md](docs/ANDROID_CAST_SPEC.md).
- Video only, one sender at a time (extra senders are ignored; senders time out after 20 s with no answer). Calls are auto-accepted: anyone who knows the current code could cast to your glasses, so use "New code" if in doubt.
- Untested on real hardware so far. Tests: `node test/cast.js`.

## Tests

```
node test/protocol.test.js            # transfer protocol, integrity checks, pairing codes
node test/e2e.js                      # both pages in Chromium (needs Playwright), mock connection
node test/portrait.js                 # tall photos/videos must fit the 600x600 display
node test/photozoom.js                # photo zoom and pan (FORCE_FALLBACK=1 tests the fallback path)
node test/saved.js                    # saved photos: reload, delete menu, Clear all, and every storage fallback
node test/cast.js                     # Screen Cast receiver and sender
```

## Files

```
index.html  css/glasses.css  js/glasses.js  js/storage.js   glasses app (storage.js keeps saved photos)
send.html   css/send.css     js/send.js         phone page
js/zoom.js      zoom/pan (gallery photos and Screen Cast)
js/shared.js    protocol + pairing codes        js/peer-loader.js   loads PeerJS (local, then CDN)
js/config.js    TURN / own broker settings
.well-known/meta-wearables-manifest.json  icons/icon.svg   app name and icon on the glasses
```
