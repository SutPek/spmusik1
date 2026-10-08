/* SAMC Speedo - Music Player (Invidious + HTML5 Audio)
 * Self-contained: menyuntikkan UI sendiri, tidak perlu mengubah app.js.
 * Tanpa YouTube IFrame API, tanpa YT.Player, tanpa deteksi iklan.
 * Alur: link YouTube -> ID -> Invidious API -> stream audio -> <audio>.
 * Fitur: video / playlist, daftar putar, hapus, next/prev, volume, repeat,
 *        failover antar instance Invidious, resume posisi terakhir.
 */
(function () {
  'use strict';

  var STORE_KEY = 'samc_music_playlist_v1';
  var VOL_KEY = 'samc_music_volume_v1';
  var RESUME_KEY = 'samc_music_resume_v1';

  /* ---------- Invidious ---------- */
  // Daftar instance publik bisa berubah / mati. Cek https://instances.invidious.io
  // Idealnya ganti dengan instance self-hosted milik sendiri (taruh paling atas).
  var INVIDIOUS_INSTANCES = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yt.chocolatemoo53.com',
    'https://invidious.tiekoetter.com',
    'https://invidious.f5.si'
  ];
  var REQUEST_TIMEOUT = 8000; // ms per instance

  var state = {
    items: [],          // { type:'video'|'playlist', id, title }
    current: -1,
    playing: false,
    player: null,       // elemen <audio>
    instanceIndex: 0,   // instance terakhir yang berhasil
    loading: false,
    wantPlay: false,
    token: 0,           // pembatal request lama saat ganti lagu
    retry: 0,
    failStreak: 0,
    resume: null        // { id, time }
  };

  /* ---------- storage ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) state.items = arr.filter(function (x) { return x && x.id && x.type; });
    } catch (e) { state.items = []; }
    try {
      var r = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
      if (r && typeof r.current === 'number' && state.items[r.current] && state.items[r.current].id === r.id) {
        state.current = r.current;
        state.resume = { id: r.id, time: r.time || 0 };
      }
    } catch (e) {}
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.items)); } catch (e) {}
  }
  function getVolume() {
    try { var v = parseInt(localStorage.getItem(VOL_KEY), 10); return isNaN(v) ? 70 : v; } catch (e) { return 70; }
  }
  function saveResume() {
    if (!state.player || state.current < 0) return;
    var cur = state.items[state.current];
    if (!cur || !state.player.src) return;
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({
        current: state.current,
        id: cur.id,
        time: state.player.currentTime || 0
      }));
    } catch (e) {}
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

  /* ---------- API Invidious (dengan failover) ---------- */
  function invidiousFetch(path) {
    var n = INVIDIOUS_INSTANCES.length;
    var tried = 0;

    function next() {
      if (tried >= n) return Promise.reject(new Error('Semua instance Invidious gagal.'));
      var idx = (state.instanceIndex + tried) % n;
      tried++;
      var base = INVIDIOUS_INSTANCES[idx];
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT);

      return fetch(base + path, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      })
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          if (!data || data.error) throw new Error((data && data.error) || 'Respons kosong');
          state.instanceIndex = idx;
          return { data: data, base: base };
        })
        .catch(function () {
          clearTimeout(timer);
          return next();
        });
    }
    return next();
  }

  function fetchVideo(id) {
    return invidiousFetch('/api/v1/videos/' + encodeURIComponent(id) + '?hl=id&local=true');
  }
  function fetchPlaylist(id) {
    return invidiousFetch('/api/v1/playlists/' + encodeURIComponent(id) + '?hl=id');
  }

  function fetchTitle(entry) {
    var req = entry.type === 'video' ? fetchVideo(entry.id) : fetchPlaylist(entry.id);
    return req
      .then(function (res) { return res.data.title || null; })
      .catch(function () { return null; });
  }

  /* ---------- pilih stream audio ---------- */
  function pickStream(data, base) {
    var audioEl = state.player;
    var adaptive = Array.isArray(data.adaptiveFormats) ? data.adaptiveFormats : [];
    var muxed = Array.isArray(data.formatStreams) ? data.formatStreams : [];

    function playable(s) {
      if (!s || !s.url) return false;
      try { return audioEl.canPlayType(String(s.type || '')) !== ''; } catch (e) { return true; }
    }
    function byBitrate(a, b) { return parseInt(b.bitrate || 0, 10) - parseInt(a.bitrate || 0, 10); }

    var audioOnly = adaptive.filter(function (s) {
      return String(s.type || '').toLowerCase().indexOf('audio/') === 0 && playable(s);
    });
    // utamakan mp4/aac (kompatibel luas), lalu sisanya (webm/opus)
    var mp4 = audioOnly.filter(function (s) { return /audio\/mp4/i.test(s.type); }).sort(byBitrate);
    var rest = audioOnly.filter(function (s) { return !/audio\/mp4/i.test(s.type); }).sort(byBitrate);

    var chosen = mp4[0] || rest[0];
    // cadangan: stream gabungan video+audio (kualitas rendah), tetap bisa diputar di <audio>
    if (!chosen) chosen = muxed.filter(playable).sort(byBitrate)[0] || muxed[0];
    if (!chosen || !chosen.url) throw new Error('Stream audio tidak ditemukan.');

    var url = chosen.url;
    if (url.charAt(0) === '/') url = base + url; // URL proxy relatif
    return url;
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
        '<div class="ytm-video" id="ytm-video" style="display:none"></div>' +
        '<div class="ytm-controls">' +
          '<button id="ytm-prev" type="button" class="ytm-icon" title="Sebelumnya">&#9198;</button>' +
          '<button id="ytm-play" type="button" class="ytm-icon ytm-main" title="Putar / Jeda">&#9654;</button>' +
          '<button id="ytm-next" type="button" class="ytm-icon" title="Berikutnya">&#9197;</button>' +
          '<button id="ytm-repeat" type="button" class="ytm-icon ytm-on" title="Ulangi daftar putar">&#8635;</button>' +
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

    ['toggle','panel','close','now','prev','play','next','repeat','vol','input','add','msg','count','clear','list','video']
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
    el.vol.addEventListener('input', function () {
      var v = parseInt(el.vol.value, 10);
      try { localStorage.setItem(VOL_KEY, String(v)); } catch (e) {}
      if (state.player) state.player.volume = v / 100;
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
    el.now.textContent = cur ? (cur.title || cur.id) : 'Belum ada lagu';
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
    try { localStorage.removeItem(RESUME_KEY); } catch (e) {}
    render();
  }

  /* ---------- pemutar (HTML5 Audio) ---------- */
  function createPlayer() {
    if (state.player) return;

    var audio = document.createElement('audio');
    audio.id = 'ytm-audio';
    audio.preload = 'auto';
    audio.controls = false;
    audio.setAttribute('playsinline', '');
    audio.volume = parseInt(el.vol.value, 10) / 100;

    audio.addEventListener('playing', function () {
      state.playing = true;
      state.retry = 0;
      state.failStreak = 0;
      render();
    });
    audio.addEventListener('pause', function () {
      if (audio.ended) return;
      state.playing = false;
      el.play.innerHTML = '&#9654;';
      saveResume();
    });
    audio.addEventListener('ended', function () {
      state.playing = false;
      step(1, true);
    });
    audio.addEventListener('error', function () {
      if (!audio.getAttribute('src') || state.loading) return;
      var it = state.items[state.current];
      if (!it) return;
      // coba sekali lagi lewat instance berikutnya, lalu lewati
      if (state.retry < 1) {
        state.retry++;
        state.instanceIndex = (state.instanceIndex + 1) % INVIDIOUS_INSTANCES.length;
        msg('Stream gagal, mencoba instance lain...', true);
        loadTrack(it, audio.currentTime || 0, state.token);
      } else {
        skipBroken(state.token);
      }
    });

    el.video.appendChild(audio);
    state.player = audio;
  }

  function skipBroken(token) {
    state.playing = false;
    state.failStreak++;
    if (state.failStreak >= state.items.length) {
      msg('Semua lagu gagal diputar. Coba lagi nanti.', true);
      state.failStreak = 0;
      render();
      return;
    }
    msg('Lagu tidak bisa diputar, lanjut ke berikutnya.', true);
    setTimeout(function () { if (token === state.token) step(1, true); }, 1200);
  }

  function loadTrack(it, startTime, token) {
    state.loading = true;
    msg('Memuat...');

    fetchVideo(it.id)
      .then(function (res) {
        if (token !== state.token) return null;
        var d = res.data;
        if (d.title && !it.title) { it.title = d.title; save(); }
        var url = pickStream(d, res.base);
        var a = state.player;

        a.src = url;
        if (startTime > 1) {
          a.addEventListener('loadedmetadata', function h() {
            a.removeEventListener('loadedmetadata', h);
            try { a.currentTime = startTime; } catch (e) {}
          });
        }
        state.loading = false;
        render();
        return a.play();
      })
      .then(function () {
        if (token === state.token) { state.loading = false; msg(''); }
      })
      .catch(function (err) {
        if (token !== state.token) return;
        state.loading = false;
        if (err && err.name === 'NotAllowedError') {
          msg('Browser memblokir autoplay. Tekan Play.', true);
          state.playing = false;
          render();
          return;
        }
        console.error('[Musik]', err);
        skipBroken(token);
      });
  }

  function expandPlaylist(i, token) {
    var entry = state.items[i];
    state.loading = true;
    msg('Memuat playlist...');

    fetchPlaylist(entry.id)
      .then(function (res) {
        if (token !== state.token) return;
        var videos = res.data && res.data.videos;
        if (!Array.isArray(videos) || !videos.length) throw new Error('Playlist kosong / tidak valid.');

        var newItems = videos
          .filter(function (v) { return v && v.videoId; })
          .map(function (v) { return { type: 'video', id: v.videoId, title: v.title || '' }; });
        if (!newItems.length) throw new Error('Playlist tidak berisi video.');

        // ganti entry playlist dengan daftar videonya
        Array.prototype.splice.apply(state.items, [i, 1].concat(newItems));
        save();
        state.current = i;
        state.loading = false;
        render();
        loadTrack(state.items[i], 0, token);
      })
      .catch(function (err) {
        if (token !== state.token) return;
        console.error('[Musik Playlist]', err);
        state.loading = false;
        msg('Playlist gagal dimuat.', true);
        render();
      });
  }

  function playIndex(i, startTime) {
    if (i < 0 || i >= state.items.length) return;
    state.current = i;
    state.wantPlay = true;
    var it = state.items[i];
    render();
    createPlayer();
    var token = ++state.token;
    state.retry = 0;
    if (it.type === 'playlist') { expandPlaylist(i, token); return; }
    loadTrack(it, startTime || 0, token);
  }

  function step(dir, fromEnd) {
    if (!state.items.length) return;
    var n = state.current + dir;
    if (n >= state.items.length || n < 0) {
      var loop = el.repeat.classList.contains('ytm-on');
      if (fromEnd && !loop && n >= state.items.length) { state.playing = false; render(); return; }
      n = (n + state.items.length) % state.items.length;
    }
    playIndex(n);
  }

  function togglePlay() {
    if (!state.items.length) { msg('Tambahkan link YouTube dulu.', true); return; }
    if (state.current === -1) { playIndex(0); return; }

    var a = state.player;
    if (!a || !a.getAttribute('src')) {
      var cur = state.items[state.current];
      var t = state.resume && cur && state.resume.id === cur.id ? state.resume.time : 0;
      state.resume = null;
      playIndex(state.current, t);
      return;
    }
    if (!a.paused) {
      state.wantPlay = false;
      a.pause();
    } else {
      state.wantPlay = true;
      a.play().catch(function () { msg('Gagal memutar. Tekan Play sekali lagi.', true); });
    }
  }

  function stopPlayer() {
    state.token++;
    state.wantPlay = false;
    state.playing = false;
    state.loading = false;
    if (state.player) {
      try {
        state.player.pause();
        state.player.removeAttribute('src');
        state.player.load();
      } catch (e) {}
    }
  }

  /* ---------- init ---------- */
  function init() {
    load();
    build();
    render();
    setInterval(function () { if (state.playing) saveResume(); }, 5000);
    window.addEventListener('pagehide', saveResume);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
