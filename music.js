/* SAMC Speedo - Music Player (versi Piped)
 * Tidak memakai YouTube iframe. Audio diambil lewat API Piped lalu
 * diputar dengan elemen <audio> biasa, jadi tidak kena error embed.
 * Fitur: link video / playlist, daftar putar, hapus per lagu, hapus semua,
 * next/prev, seek, volume, repeat. Tersimpan di localStorage.
 * Format data localStorage sama dengan versi lama (daftar lama tetap terbaca).
 */
(function () {
  'use strict';

  var STORE_KEY = 'samc_music_playlist_v1';
  var VOL_KEY = 'samc_music_volume_v1';

  // Instance Piped sering berubah/mati. Daftar ini dicoba berurutan,
  // dan akan ditambah otomatis dari daftar resmi (lihat refreshInstances).
  var INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.private.coffee',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.leptons.xyz',
    'https://pipedapi.nosebs.ru'
  ];
  var INSTANCE_LIST_URL = 'https://piped-instances.kavin.rocks/';
  var TIMEOUT_MS = 10000;

  var state = {
    items: [],      // { type:'video'|'playlist', id, title }
    current: -1,    // index di items
    queue: [],      // daftar video id yang sedang diputar (1 untuk video, banyak untuk playlist)
    qi: 0,          // posisi di queue
    urls: [],       // kandidat URL audio untuk lagu saat ini
    ui: 0,          // index URL yang sedang dicoba
    playing: false,
    loaded: false,  // audio.src sudah terisi
    token: 0,       // untuk membatalkan permintaan lama
    instIdx: 0
  };

  var audio = new Audio();
  audio.preload = 'auto';

  /* ---------- storage ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) state.items = arr.filter(function (x) { return x && x.id && x.type; });
    } catch (e) { state.items = []; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.items)); } catch (e) {}
  }
  function getVolume() {
    try { var v = parseInt(localStorage.getItem(VOL_KEY), 10); return isNaN(v) ? 70 : v; } catch (e) { return 70; }
  }

  /* ---------- parse link YouTube ---------- */
  function parseYouTube(input) {
    input = (input || '').trim();
    if (!input) return null;
    if (/^[\w-]{11}$/.test(input)) return { type: 'video', id: input };
    var url;
    try { url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch (e) { return null; }
    var host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    var v = null, list = url.searchParams.get('list');
    if (host === 'youtu.be') v = url.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com') {
      if (url.pathname === '/watch') v = url.searchParams.get('v');
      else {
        var m = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
        if (m) v = m[1];
      }
    } else return null;
    if (v && /^[\w-]{11}$/.test(v)) return { type: 'video', id: v };
    if (list && /^[\w-]+$/.test(list)) return { type: 'playlist', id: list };
    return null;
  }

  /* ---------- Piped API ---------- */
  function fetchTimeout(url) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) ctrl.abort();
        reject(new Error('timeout'));
      }, TIMEOUT_MS);
      fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
        if (done) return;
        done = true; clearTimeout(t);
        if (!r.ok) { reject(new Error('http ' + r.status)); return; }
        return r.json().then(resolve, reject);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(t);
        reject(e);
      });
    });
  }

  // Coba tiap instance berurutan sampai ada yang berhasil.
  function api(path) {
    var n = INSTANCES.length;
    var start = state.instIdx;
    function attempt(k) {
      if (k >= n) return Promise.reject(new Error('semua instance gagal'));
      var idx = (start + k) % n;
      return fetchTimeout(INSTANCES[idx] + path).then(function (j) {
        if (j && j.error) throw new Error(j.error);
        state.instIdx = idx;
        return j;
      }).catch(function () { return attempt(k + 1); });
    }
    return attempt(0);
  }

  // Ambil daftar instance terbaru dari situs resmi Piped (jika bisa).
  function refreshInstances() {
    fetchTimeout(INSTANCE_LIST_URL).then(function (list) {
      if (!Array.isArray(list)) return;
      list.sort(function (a, b) { return (b.uptime_30d || 0) - (a.uptime_30d || 0); });
      var fresh = [];
      list.forEach(function (x) {
        if (x && x.api_url && /^https:\/\//.test(x.api_url)) {
          var u = x.api_url.replace(/\/+$/, '');
          if (fresh.indexOf(u) === -1 && INSTANCES.indexOf(u) === -1) fresh.push(u);
        }
      });
      INSTANCES = INSTANCES.concat(fresh.slice(0, 6));
    }).catch(function () {});
  }

  function pickAudioUrls(info) {
    var streams = (info && info.audioStreams) || [];
    streams = streams.filter(function (s) { return s && s.url; });
    function score(s) {
      var mt = (s.mimeType || '').toLowerCase();
      var codec = (mt.indexOf('mp4') !== -1 || mt.indexOf('m4a') !== -1) ? 1 : 0; // AAC paling kompatibel
      return codec * 1000000 + (s.bitrate || 0);
    }
    streams.sort(function (a, b) { return score(b) - score(a); });
    return streams.map(function (s) { return s.url; });
  }

  function fetchTitle(entry) {
    var p = entry.type === 'video'
      ? api('/streams/' + entry.id).then(function (j) { return j.title; })
      : api('/playlists/' + entry.id).then(function (j) { return j.name; });
    return p.then(function (t) { return t || null; }).catch(function () { return null; });
  }

  function fetchPlaylistIds(id) {
    var ids = [];
    function collect(j) {
      (j.relatedStreams || []).forEach(function (s) {
        var m = s && s.url && s.url.match(/[?&]v=([\w-]{11})/);
        if (m) ids.push(m[1]);
      });
    }
    return api('/playlists/' + id).then(function (j) {
      collect(j);
      var title = j.name || null;
      var next = j.nextpage;
      function more(page) {
        if (!next || page >= 3) return ids;
        return api('/nextpage/playlists/' + id + '?nextpage=' + encodeURIComponent(next))
          .then(function (jj) { collect(jj); next = jj.nextpage; return more(page + 1); })
          .catch(function () { return ids; });
      }
      return Promise.resolve(more(0)).then(function () { return { ids: ids, title: title }; });
    });
  }

  /* ---------- UI ---------- */
  var el = {};

  function build() {
    var wrap = document.createElement('div');
    wrap.id = 'ytm-root';
    wrap.className = 'no-drag';
    wrap.innerHTML =
      '<button id="ytm-toggle" type="button" title="Musik" aria-label="Buka pemutar musik">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>' +
      '</button>' +
      '<section id="ytm-panel" class="ytm-hide" aria-label="Pemutar musik">' +
        '<div class="ytm-head"><span class="ytm-now" id="ytm-now">Belum ada lagu</span>' +
        '<button id="ytm-close" type="button" class="ytm-icon" title="Tutup">&times;</button></div>' +
        '<div class="ytm-controls">' +
          '<button id="ytm-prev" type="button" class="ytm-icon" title="Sebelumnya">&#9198;</button>' +
          '<button id="ytm-play" type="button" class="ytm-icon ytm-main" title="Putar / Jeda">&#9654;</button>' +
          '<button id="ytm-next" type="button" class="ytm-icon" title="Berikutnya">&#9197;</button>' +
          '<button id="ytm-repeat" type="button" class="ytm-icon ytm-on" title="Ulangi daftar putar">&#8635;</button>' +
          '<input id="ytm-seek" type="range" min="0" max="1000" value="0" aria-label="Posisi lagu">' +
        '</div>' +
        '<div class="ytm-controls">' +
          '<input id="ytm-vol" type="range" min="0" max="100" aria-label="Volume">' +
        '</div>' +
        '<div class="ytm-add">' +
          '<input id="ytm-input" type="text" placeholder="Tempel link YouTube" autocomplete="off" spellcheck="false">' +
          '<button id="ytm-add" type="button" title="Simpan ke daftar putar">Simpan</button>' +
        '</div>' +
        '<div class="ytm-msg" id="ytm-msg" role="status"></div>' +
        '<div class="ytm-list-head"><span id="ytm-count">Daftar putar (0)</span>' +
        '<button id="ytm-clear" type="button" class="ytm-link">Hapus semua</button></div>' +
        '<ul id="ytm-list"></ul>' +
      '</section>';
    document.body.appendChild(wrap);

    ['toggle','panel','close','now','prev','play','next','repeat','seek','vol','input','add','msg','count','clear','list']
      .forEach(function (k) { el[k] = document.getElementById('ytm-' + k); });

    // cegah HUD ikut tergeser saat berinteraksi dengan panel musik
    ['mousedown', 'touchstart', 'pointerdown'].forEach(function (ev) {
      wrap.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
    });

    el.toggle.addEventListener('click', function () { el.panel.classList.toggle('ytm-hide'); });
    el.close.addEventListener('click', function () { el.panel.classList.add('ytm-hide'); });
    el.add.addEventListener('click', onAdd);
    el.input.addEventListener('keydown', function (e) { if (e.key === 'Enter') onAdd(); });
    el.play.addEventListener('click', togglePlay);
    el.next.addEventListener('click', function () { step(1); });
    el.prev.addEventListener('click', function () { step(-1); });
    el.repeat.addEventListener('click', function () { el.repeat.classList.toggle('ytm-on'); });
    el.clear.addEventListener('click', clearAll);

    el.vol.value = getVolume();
    audio.volume = getVolume() / 100;
    el.vol.addEventListener('input', function () {
      var v = parseInt(el.vol.value, 10);
      try { localStorage.setItem(VOL_KEY, String(v)); } catch (e) {}
      audio.volume = v / 100;
    });

    var seeking = false;
    el.seek.addEventListener('input', function () { seeking = true; });
    el.seek.addEventListener('change', function () {
      if (audio.duration && isFinite(audio.duration)) {
        audio.currentTime = (parseInt(el.seek.value, 10) / 1000) * audio.duration;
      }
      seeking = false;
    });
    audio.addEventListener('timeupdate', function () {
      if (seeking || !audio.duration || !isFinite(audio.duration)) return;
      el.seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
    });
  }

  function msg(text, isError) {
    el.msg.textContent = text || '';
    el.msg.className = 'ytm-msg' + (isError ? ' ytm-err' : '');
    if (text) {
      clearTimeout(msg._t);
      msg._t = setTimeout(function () { el.msg.textContent = ''; }, 3500);
    }
  }

  function setNow(text) { el.now.textContent = text; }

  function render() {
    el.count.textContent = 'Daftar putar (' + state.items.length + ')';
    el.list.textContent = '';
    if (!state.items.length) {
      var empty = document.createElement('li');
      empty.className = 'ytm-empty';
      empty.textContent = 'Kosong. Tempel link video atau playlist YouTube di atas.';
      el.list.appendChild(empty);
    }
    state.items.forEach(function (it, i) {
      var li = document.createElement('li');
      if (i === state.current) li.className = 'ytm-active';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ytm-track';
      btn.title = 'Putar';
      btn.textContent = (it.type === 'playlist' ? '[Playlist] ' : '') + (it.title || it.id);
      btn.addEventListener('click', function () { playIndex(i); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'ytm-icon ytm-del';
      del.title = 'Hapus dari daftar putar';
      del.setAttribute('aria-label', 'Hapus ' + (it.title || it.id));
      del.innerHTML = '&times;';
      del.addEventListener('click', function () { removeIndex(i); });

      li.appendChild(btn);
      li.appendChild(del);
      el.list.appendChild(li);
    });
    var cur = state.items[state.current];
    setNow(cur ? (cur.title || cur.id) : 'Belum ada lagu');
    el.play.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
  }

  /* ---------- aksi daftar putar ---------- */
  function onAdd() {
    var parsed = parseYouTube(el.input.value);
    if (!parsed) { msg('Link YouTube tidak valid.', true); return; }
    var exists = state.items.some(function (x) { return x.type === parsed.type && x.id === parsed.id; });
    if (exists) { msg('Sudah ada di daftar putar.', true); return; }

    var entry = { type: parsed.type, id: parsed.id, title: '' };
    state.items.push(entry);
    save();
    el.input.value = '';
    msg('Disimpan ke daftar putar.');
    render();

    fetchTitle(entry).then(function (t) {
      if (t) { entry.title = t; save(); render(); }
    });
    if (state.current === -1) playIndex(state.items.length - 1);
  }

  function removeIndex(i) {
    var wasCurrent = i === state.current;
    state.items.splice(i, 1);
    save();
    if (wasCurrent) {
      stopPlayer();
      if (state.items.length) playIndex(Math.min(i, state.items.length - 1));
      else { state.current = -1; state.playing = false; render(); }
      return;
    }
    if (i < state.current) state.current--;
    render();
  }

  function clearAll() {
    if (!state.items.length) return;
    if (!window.confirm('Hapus semua lagu dari daftar putar?')) return;
    state.items = [];
    state.current = -1;
    save();
    stopPlayer();
    render();
  }

  /* ---------- pemutar ---------- */
  function stopPlayer() {
    state.token++;
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {}
    state.playing = false;
    state.loaded = false;
    state.queue = [];
    state.qi = 0;
    state.urls = [];
    if (el.seek) el.seek.value = 0;
  }

  function playIndex(i) {
    if (i < 0 || i >= state.items.length) return;
    stopPlayer();
    state.current = i;
    var it = state.items[i];
    var token = state.token;
    render();
    setNow('Memuat...');

    if (it.type === 'playlist') {
      fetchPlaylistIds(it.id).then(function (res) {
        if (token !== state.token) return;
        if (!res.ids.length) throw new Error('playlist kosong');
        if (res.title && !it.title) { it.title = res.title; save(); }
        state.queue = res.ids;
        state.qi = 0;
        render();
        playQueueCurrent(token);
      }).catch(function () {
        if (token !== state.token) return;
        msg('Playlist gagal dimuat, lanjut ke berikutnya.', true);
        setTimeout(function () { if (token === state.token) step(1, true); }, 1200);
      });
    } else {
      state.queue = [it.id];
      state.qi = 0;
      playQueueCurrent(token);
    }
  }

  function playQueueCurrent(token) {
    var vid = state.queue[state.qi];
    if (!vid) return;
    var it = state.items[state.current];
    setNow('Memuat...');
    api('/streams/' + vid).then(function (info) {
      if (token !== state.token) return;
      var urls = pickAudioUrls(info);
      if (!urls.length) throw new Error('tidak ada stream audio');
      if (it && it.type === 'video' && !it.title && info.title) { it.title = info.title; save(); }
      state.urls = urls;
      state.ui = 0;
      var label = (it && it.type === 'playlist')
        ? ((info.title || vid) + (state.queue.length > 1 ? ' (' + (state.qi + 1) + '/' + state.queue.length + ')' : ''))
        : ((it && it.title) || info.title || vid);
      setNow(label);
      startAudio(token);
    }).catch(function () {
      if (token !== state.token) return;
      skipBroken(token);
    });
  }

  function startAudio(token) {
    audio.src = state.urls[state.ui];
    state.loaded = true;
    var p = audio.play();
    if (p && p.catch) {
      p.catch(function (err) {
        if (token !== state.token) return;
        if (err && err.name === 'NotAllowedError') {
          state.playing = false;
          render();
          msg('Tekan Play untuk memulai.', true);
        }
        // error lain ditangani oleh event 'error' pada audio
      });
    }
  }

  function skipBroken(token) {
    msg('Lagu tidak bisa diputar, lanjut ke berikutnya.', true);
    setTimeout(function () {
      if (token !== state.token) return;
      advance(true);
    }, 1200);
  }

  // Maju ke lagu berikutnya di queue; jika habis, ke item daftar putar berikutnya.
  function advance(fromEnd) {
    if (state.qi + 1 < state.queue.length) {
      state.qi++;
      playQueueCurrent(state.token);
    } else {
      step(1, fromEnd);
    }
  }

  audio.addEventListener('playing', function () {
    state.playing = true;
    el.play.innerHTML = '&#10074;&#10074;';
  });
  audio.addEventListener('pause', function () {
    if (audio.ended) return;
    state.playing = false;
    el.play.innerHTML = '&#9654;';
  });
  audio.addEventListener('ended', function () { advance(true); });
  audio.addEventListener('error', function () {
    if (!state.loaded) return;
    var token = state.token;
    if (state.ui + 1 < state.urls.length) {
      state.ui++;
      startAudio(token);
    } else {
      skipBroken(token);
    }
  });

  function step(dir, fromEnd) {
    if (!state.items.length) return;
    var n = state.current + dir;
    if (n >= state.items.length || n < 0) {
      var loop = el.repeat.classList.contains('ytm-on');
      if (fromEnd && !loop && n >= state.items.length) { stopPlayer(); render(); return; }
      n = (n + state.items.length) % state.items.length;
    }
    playIndex(n);
  }

  function togglePlay() {
    if (!state.items.length) { msg('Tambahkan link YouTube dulu.', true); return; }
    if (state.current === -1) { playIndex(0); return; }
    if (!state.loaded) { playIndex(state.current); return; }
    if (audio.paused) {
      var p = audio.play();
      if (p && p.catch) p.catch(function () { playIndex(state.current); });
    } else {
      audio.pause();
    }
  }

  /* ---------- init ---------- */
  function init() {
    load();
    build();
    render();
    refreshInstances();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
