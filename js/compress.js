/*
 * Phone-side video shrinking, so a video fits the glasses' per-file / free-space limit.
 *
 *  PGCompress.plan(mode, duration, srcBytes, limitBytes, srcShortSide)   pure, unit-tested
 *  PGCompress.transcode(file, plan, onProgress, isCancelled)             browser only
 *
 * transcode() plays the video into a canvas and records it with MediaRecorder, so it runs in real
 * time (a 3 minute video takes about 3 minutes) and needs the page open and visible. Audio is
 * routed through Web Audio into the recording and is NOT played aloud.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PGCompress = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AUDIO_BPS = 96000;
  var MIN_BPS = 250000;       // below this the picture is mush
  var MAX_BPS = 4000000;
  var FILL = 0.85;            // aim for 85% of the limit: recorders overshoot

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function fmtMin(sec) { return sec < 90 ? Math.round(sec) + ' s' : (sec / 60).toFixed(1) + ' min'; }

  /*
   * mode: 'original' | 'auto' | '720' | '480'
   * Returns { compress:false } | { compress:true, height, bitrate, estBytes } | { fail: 'message' }
   */
  function plan(mode, duration, srcBytes, limitBytes, srcShortSide) {
    if (mode === 'original') return { compress: false };
    var target = limitBytes * FILL;
    if (mode === 'auto' && srcBytes <= limitBytes) return { compress: false };

    var known = isFinite(duration) && duration > 0;
    var height, bitrate;
    if (!known) {                                     // cannot estimate: pick something modest, verify afterwards
      height = mode === '720' ? 720 : 480; bitrate = mode === '720' ? 2000000 : 800000;
    } else {
      var fit = Math.floor(target * 8 / duration) - AUDIO_BPS;   // best video bitrate that fits
      if (fit < MIN_BPS) {
        var maxSec = Math.floor(target * 8 / (MIN_BPS + AUDIO_BPS));
        return { fail: 'Too long to fit: about ' + fmtMin(maxSec) + ' is the most the glasses can hold at the lowest quality. Send a shorter clip.' };
      }
      if (mode === '720') { height = 720; bitrate = Math.min(2000000, fit); }
      else if (mode === '480') { height = 480; bitrate = Math.min(900000, fit); }
      else { bitrate = Math.min(MAX_BPS, fit); height = bitrate >= 1200000 ? 720 : bitrate >= 500000 ? 480 : 360; }
    }
    if (srcShortSide > 0) height = Math.min(height, srcShortSide);
    bitrate = clamp(bitrate, MIN_BPS, MAX_BPS);
    return { compress: true, height: height, bitrate: bitrate, estBytes: known ? Math.round((bitrate + AUDIO_BPS) * duration / 8) : 0 };
  }

  // Second attempt after a recorder overshoots: scale the bitrate by how far off it was.
  function retryPlan(prev, actualBytes, limitBytes, duration) {
    var target = limitBytes * FILL;
    var bitrate = Math.floor(prev.bitrate * (target / actualBytes) * 0.9);
    if (bitrate < MIN_BPS) return null;
    var height = bitrate >= 1200000 ? prev.height : Math.min(prev.height, bitrate >= 500000 ? 480 : 360);
    return { compress: true, height: height, bitrate: bitrate, estBytes: duration ? Math.round((bitrate + AUDIO_BPS) * duration / 8) : 0 };
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    var c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < c.length; i++) if (MediaRecorder.isTypeSupported(c[i])) return c[i];
    return '';
  }

  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

  /* Returns { blob, mime, ext, w, h }. Throws Error('Cancelled') or a readable Error. */
  function transcode(file, pl, onProgress, isCancelled) {
    return new Promise(function (resolve, reject) {
      if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
        reject(new Error('This phone browser can’t shrink videos. Choose Original, or send a shorter clip.')); return;
      }
      var mime = pickMime();
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      var audioCtx = null, rec = null, stream = null, raf = 0, watchdog = 0, finished = false, lastT = -1, lastMove = Date.now();
      var started = Date.now();

      function cleanup() {
        cancelAnimationFrame(raf); clearInterval(watchdog);
        document.removeEventListener('visibilitychange', onVis);
        try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        try { if (audioCtx) audioCtx.close(); } catch (e) { /* ignore */ }
        try { v.pause(); } catch (e) { /* ignore */ }
        v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ }
        URL.revokeObjectURL(url);
      }
      function fail(err) {
        if (finished) return;
        finished = true;
        try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (e) { /* ignore */ }
        cleanup();
        reject(err);
      }
      function onVis() {                 // canvas drawing stops in the background: pause instead of recording freezes
        if (document.hidden) { try { v.pause(); if (rec && rec.state === 'recording') rec.pause(); } catch (e) { /* ignore */ } }
        else { try { if (rec && rec.state === 'paused') rec.resume(); v.play(); } catch (e) { /* ignore */ } }
        lastMove = Date.now();
      }
      document.addEventListener('visibilitychange', onVis);

      v.playsInline = true; v.preload = 'auto'; v.src = url;
      v.onerror = function () { fail(new Error('This phone can’t read that video to shrink it.')); };
      var metaTimer = setTimeout(function () { fail(new Error('Could not read the video to shrink it.')); }, 15000);

      v.onloadedmetadata = function () {
        clearTimeout(metaTimer);
        var sw = v.videoWidth, sh = v.videoHeight, dur = v.duration;
        if (!sw || !sh) { fail(new Error('This phone can’t decode that video to shrink it.')); return; }
        var k = Math.min(1, pl.height / Math.min(sw, sh));
        var cw = even(sw * k), ch = even(sh * k);
        var canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        stream = canvas.captureStream(30);

        try {                             // route the soundtrack into the recording without playing it
          var AC = root.AudioContext || root.webkitAudioContext;
          audioCtx = new AC();
          var src = audioCtx.createMediaElementSource(v);
          var dest = audioCtx.createMediaStreamDestination();
          src.connect(dest);
          dest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
          if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () { /* ignore */ });
        } catch (e) { v.muted = true; }   // no audio rather than no video

        var chunks = [];
        try {
          rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: pl.bitrate, audioBitsPerSecond: AUDIO_BPS });
        } catch (e) { fail(new Error('This phone can’t record video here, so it can’t shrink it.')); return; }
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onerror = function () { fail(new Error('Shrinking the video failed.')); };
        rec.onstop = function () {
          if (finished) return;
          finished = true;
          cleanup();
          var type = rec.mimeType || mime || 'video/webm';
          var blob = new Blob(chunks, { type: type });
          if (!blob.size) { reject(new Error('Shrinking produced an empty video.')); return; }
          resolve({ blob: blob, mime: type.split(';')[0], ext: /mp4/.test(type) ? '.mp4' : '.webm', w: cw, h: ch, duration: dur });
        };

        function frame() {
          if (finished) return;
          if (isCancelled && isCancelled()) { fail(new Error('Cancelled')); return; }
          if (!document.hidden && v.readyState >= 2) { try { ctx.drawImage(v, 0, 0, cw, ch); } catch (e) { /* skip a frame */ } }
          if (onProgress && dur > 0) onProgress(Math.min(1, v.currentTime / dur));
          if (v.currentTime !== lastT) { lastT = v.currentTime; lastMove = Date.now(); }
          raf = requestAnimationFrame(frame);
        }
        v.onended = function () { if (!finished) { try { rec.stop(); } catch (e) { fail(new Error('Shrinking the video failed.')); } } };
        watchdog = setInterval(function () {
          if (document.hidden) return;
          if (Date.now() - lastMove > 20000) fail(new Error('Shrinking stalled. Keep this page open with the screen on, then retry.'));
          else if (isFinite(dur) && Date.now() - started > dur * 4000 + 60000) fail(new Error('Shrinking took too long. Try a shorter clip.'));
        }, 1000);

        rec.start(1000);
        var p = v.play();
        if (p && p.catch) p.catch(function () { fail(new Error('This phone blocked playback needed to shrink the video. Tap the page and retry.')); });
        frame();
      };
    });
  }

  return { plan: plan, retryPlan: retryPlan, transcode: transcode, pickMime: pickMime, AUDIO_BPS: AUDIO_BPS, MIN_BPS: MIN_BPS, FILL: FILL };
});
