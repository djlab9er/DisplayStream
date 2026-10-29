/*
 * Service worker for "Send to glasses". It does ONE thing: when Android's Share sheet posts
 * photos/videos to ./share-target, it parks them in Cache Storage and redirects to send.html,
 * which picks them up. It caches nothing else, so the rest of the app is never served stale.
 */
var INBOX = 'pg-share-inbox';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'POST' || !/\/share-target$/.test(url.pathname)) return;
  event.respondWith((async function () {
    try {
      var form = await event.request.formData();
      var files = form.getAll('files').filter(function (f) { return f && typeof f === 'object' && 'size' in f; });
      await caches.delete(INBOX);
      var cache = await caches.open(INBOX);
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        await cache.put('/__share/' + i, new Response(f, {
          headers: {
            'Content-Type': f.type || 'application/octet-stream',
            'X-PG-Name': encodeURIComponent(f.name || ('shared-' + i)),
            'X-PG-Modified': String(f.lastModified || Date.now())
          }
        }));
      }
      return Response.redirect(new URL('send.html?share=' + files.length, self.registration.scope).href, 303);
    } catch (err) {
      return Response.redirect(new URL('send.html?share=err', self.registration.scope).href, 303);
    }
  })());
});
