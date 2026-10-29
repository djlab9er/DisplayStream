/*
 * Zoom + pan for an <img> or <video> shown letterboxed in the 600x600 display.
 * Used by the gallery viewer (photos) and Screen Cast (video frames).
 *
 *   var z = PGZoom.create(element, function () { return { w: sourceWidth, h: sourceHeight }; });
 *   z.cycle()      Fit -> Zoom 1 -> Zoom 2 -> Fit; returns a label for a toast
 *   z.pan(dx, dy)  move the view (-1/0/1 per axis); does nothing at Fit
 *   z.refresh()    re-clamp (call when the source size or window size changes)
 *   z.reset()      back to Fit;  z.zoomed  true when not at Fit
 *
 * Level 1 fills the square (crops the long side); level 2 is 1.5x that.
 *
 * Preferred method: CSS object-view-box crops the SOURCE, so the element never grows beyond the
 * display (a CSS scale() of 3x+ made a huge layer that rendered black on the glasses).
 * Fallback for browsers without it: transform scale, capped at 2.5x.
 */
(function (root) {
  'use strict';
  var HAS_OVB = !!(root.CSS && root.CSS.supports && root.CSS.supports('object-view-box', 'inset(0px)'));
  var LABELS = ['Fit', 'Zoom 1 · arrows pan', 'Zoom 2 · arrows pan'];

  function create(el, sizeFn, opts) {
    var level = 0, cx = 0, cy = 0;               // cx, cy = top-left of the visible region, in source px
    var STEP = (opts && opts.step) || 90;        // screen px per key press
    var useOvb = (opts && opts.forceFallback) ? false : HAS_OVB;

    function region() {                          // visible source region at the current level
      var f = sizeFn() || { w: 0, h: 0 }, W = root.innerWidth || 600, H = root.innerHeight || 600;
      var rw = Math.min(f.w, f.h * W / H), rh = rw * H / W;      // "cover" crop
      var m = 1;
      if (rw / f.w > 0.87 && rh / f.h > 0.87) m = 1.5;           // square-ish source: still give a zoom step
      if (level === 2) m *= 1.5;
      return { rw: rw / m, rh: rh / m, vw: f.w, vh: f.h, scale: W / (rw / m) };
    }

    function clear() { el.style.objectViewBox = ''; el.style.transform = ''; }

    function apply(topAlign) {
      var r = region();
      if (level === 0 || !r.vw || !r.vh) { clear(); return; }
      if (useOvb) {
        if (topAlign) { cx = (r.vw - r.rw) / 2; cy = 0; }
        cx = Math.max(0, Math.min(r.vw - r.rw, cx));
        cy = Math.max(0, Math.min(r.vh - r.rh, cy));
        el.style.transform = '';
        el.style.objectViewBox = 'inset(' + cy + 'px ' + (r.vw - cx - r.rw) + 'px ' + (r.vh - cy - r.rh) + 'px ' + cx + 'px)';
      } else {
        var W = root.innerWidth, H = root.innerHeight, k = Math.min(W / r.vw, H / r.vh);
        var fw = r.vw * k, fh = r.vh * k;
        var z = Math.min(r.scale / k, 2.5);
        var limx = Math.max(0, (fw * z - W) / 2), limy = Math.max(0, (fh * z - H) / 2);
        if (topAlign) { cx = (r.vw - r.rw) / 2; cy = 0; }
        // screen = center + translate + (src*k - fit/2) * z ; put the region's top-left (cx,cy) at screen (0,0)
        var tx = -W / 2 - (cx * k - fw / 2) * z, ty = -H / 2 - (cy * k - fh / 2) * z;
        tx = Math.max(-limx, Math.min(limx, tx)); ty = Math.max(-limy, Math.min(limy, ty));
        el.style.objectViewBox = '';
        el.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')';
      }
    }

    return {
      get level() { return level; },
      get zoomed() { return level > 0; },
      cycle: function () { level = (level + 1) % 3; apply(true); return LABELS[level]; },
      pan: function (dx, dy) {                   // dx/dy = direction the VIEW moves
        if (level === 0) return;
        var r = region(), step = STEP / r.scale;
        cx += dx * step; cy += dy * step;
        cx = Math.max(0, Math.min(r.vw - r.rw, cx)); cy = Math.max(0, Math.min(r.vh - r.rh, cy));
        apply(false);
      },
      refresh: function () { apply(false); },
      reset: function () { level = 0; cx = 0; cy = 0; clear(); }
    };
  }

  root.PGZoom = { create: create, supportsViewBox: HAS_OVB };
})(typeof self !== 'undefined' ? self : this);
