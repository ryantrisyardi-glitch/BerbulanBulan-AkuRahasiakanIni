/*
  Service Worker — "Untuk Yang Tersayang"
  --------------------------------------------------
  Tujuan:
  - Video (raw.githubusercontent.com / cdn.jsdelivr.net) dan foto
    (lh3.googleusercontent.com) di-cache begitu berhasil diambil,
    sehingga kunjungan berikutnya (atau saat jaringan lambat/putus)
    file diambil dari cache, bukan menunggu network lagi.
  - HTML/CSS/JS/font punya sendiri pakai strategi stale-while-revalidate
    supaya app tetap cepat tapi tetap ter-update.
  - TIDAK mengubah urutan / logic load video-foto di index.html sama
    sekali — semua terjadi transparan di level network request.
*/

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const MEDIA_CACHE = `media-${VERSION}`;

// File-file inti yang langsung di-precache saat install
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// Host-host yang isinya video/foto besar → cache-first + support Range
const MEDIA_HOSTS = [
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
  'lh3.googleusercontent.com'
];

// ══════════════════ INSTALL ══════════════════
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ══════════════════ ACTIVATE ══════════════════
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== MEDIA_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ══════════════════ HELPERS ══════════════════

function isMediaHost(url) {
  return MEDIA_HOSTS.some((host) => url.hostname === host);
}

// Ambil full response dari cache media, lalu potong sesuai header Range
// yang diminta browser (penting supaya <video> tetap bisa seek/play
// walau sumbernya dari cache, bukan network).
async function servePossiblyRanged(request, cachedResponse) {
  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) return cachedResponse;

  const buffer = await cachedResponse.arrayBuffer();
  const total = buffer.byteLength;

  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) return cachedResponse;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : total - 1;
  const chunk = buffer.slice(start, end + 1);

  return new Response(chunk, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': chunk.byteLength,
      'Accept-Ranges': 'bytes'
    }
  });
}

// Cache-first untuk media besar (video/foto), dengan dukungan Range.
async function mediaCacheFirst(request) {
  const cache = await caches.open(MEDIA_CACHE);

  // Selalu simpan berdasarkan URL tanpa header Range, supaya satu file
  // besar cukup disimpan sekali secara utuh di cache.
  const cacheKey = new Request(request.url, { method: 'GET' });
  const cached = await cache.match(cacheKey);

  if (cached) {
    try {
      return await servePossiblyRanged(request, cached.clone());
    } catch (e) {
      return cached;
    }
  }

  try {
    // Minta full body (tanpa Range) ke network supaya bisa di-cache utuh
    const fullRequest = new Request(request.url, {
      method: 'GET',
      headers: { Accept: request.headers.get('accept') || '*/*' },
      mode: 'cors',
      credentials: 'omit'
    });
    const networkResponse = await fetch(fullRequest);

    if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
      cache.put(cacheKey, networkResponse.clone());
    }
    return await servePossiblyRanged(request, networkResponse.clone());
  } catch (err) {
    // Network gagal & tidak ada cache → biarkan gagal, index.html yang
    // menangani fallback UI (poster/pesan error) di sisi <video>/<img>.
    throw err;
  }
}

// Stale-while-revalidate untuk shell app sendiri (HTML/CSS/JS/font)
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);

  return cached || networkFetch;
}

// ══════════════════ FETCH ══════════════════
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (isMediaHost(url)) {
    event.respondWith(mediaCacheFirst(request));
    return;
  }

  if (
    url.origin === self.location.origin ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(staleWhileRevalidate(request));
  }
  // Request lain (di luar daftar) dibiarkan lewat apa adanya.
});

// ══════════════════ PESAN DARI HALAMAN (opsional) ══════════════════
// Bisa dipakai untuk trigger "pre-cache diam-diam" dari index.html,
// misalnya: navigator.serviceWorker.controller.postMessage({type:'PRECACHE', urls:[...]})
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PRECACHE' && Array.isArray(event.data.urls)) {
    event.waitUntil(
      caches.open(MEDIA_CACHE).then((cache) =>
        Promise.all(
          event.data.urls.map((u) =>
            fetch(u, { mode: 'cors', credentials: 'omit' })
              .then((res) => cache.put(new Request(u, { method: 'GET' }), res))
              .catch(() => {})
          )
        )
      )
    );
  }
});
