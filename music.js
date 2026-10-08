/* SAMC Speedo - YouTube Music Player
 * Self-contained: menyuntikkan UI sendiri, tidak perlu mengubah app.js.
 * Fitur: putar link YouTube (video / playlist), simpan ke daftar putar,
 * hapus per lagu, hapus semua, next/prev, volume, repeat. Tersimpan di localStorage.
 * Perbaikan: musik lanjut otomatis (lagu + posisi detik) setelah HUD
 * dimuat ulang / disembunyikan, mis. saat keluar dari mobil.
 */
(function () {
  'use strict';

  var STORE_KEY = 'samc_music_playlist_v1';
  var VOL_KEY = 'samc_music_volume_v1';
  var RESUME_KEY = 'samc_music_resume_v1';

  var state = {
    items: [],      // { type:'video'|'playlist', id, title }
    current: -1,
    playing: false,
    ready: false,
    player: null,
    apiRequested: false,
    pendingPlay: null,
    wantPlay: false,  // user memang ingin musik jalan (beda dengan jeda oleh sistem)
    resumeTries: 0,
    adMode: false,        // sedang terdeteksi iklan
    adOpenedPanel: false  // panel dibuka otomatis oleh deteksi iklan
  };

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

  /* ---------- simpan / pulihkan posisi lagu ---------- */
  function saveResume() {
    if (!state.ready || state.current < 0) return;
    try {
      var cur = state.items[state.current];
      if (!cur) return;
      var p = state.player;
      var st = p.getPlayerState();
      // hanya simpan saat benar-benar sedang main/jeda, supaya tidak menimpa dengan waktu 0
      if (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.PAUSED) return;
      localStorage.setItem(RESUME_KEY, JSON.stringify({
        current: state.current,
        id: cur.id,
        time: p.getCurrentTime() || 0,
        plIndex: (cur.type === 'playlist' && p.getPlaylistIndex) ? (p.getPlaylistIndex() || 0) : 0,
        playing: state.wantPlay
      }));
    } catch (e) {}
  }
  function loadResume() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY)); } catch (e) { return null; }
  }
  function clearResume() {
    try { localStorage.removeItem(RESUME_KEY); } catch (e) {}
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

  function fetchTitle(entry) {
    var target = entry.type === 'video'
      ? 'https://www.youtube.com/watch?v=' + entry.id
      : 'https://www.youtube.com/playlist?list=' + entry.id;
    return fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(target))
      .then(function (r) { if (!r.ok) throw new Error('oembed'); return r.json(); })
      .then(function (j) { return j.title || null; })
      .catch(function () { return null; });
  }

  /* ---------- UI ---------- */
  var el = {};
  function build() {
    var wrap = document.createElement('div');
    wrap.id = 'ytm-root';
    wrap.className = 'no-drag';
    wrap.innerHTML =
      '<button id="ytm-toggle" type="button" title="Musik YouTube" aria-label="Buka pemutar musik">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>' +
      '</button>' +
      '<section id="ytm-panel" class="ytm-hide" aria-label="Pemutar musik YouTube">' +
        '<div class="ytm-head"><span class="ytm-now" id="ytm-now">Belum ada lagu</span>' +
        '<button id="ytm-close" type="button" class="ytm-icon" title="Tutup">&times;</button></div>' +
        '<div class="ytm-video" id="ytm-video"><div id="ytm-player"></div></div>' +
        '<div class="ytm-adbar ytm-hide" id="ytm-adbar" role="status">' +
          'Iklan diputar. Arahkan kursor lalu klik tombol <b>Lewati / Skip</b> di pojok kanan bawah video.' +
        '</div>' +
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

    ['toggle','panel','close','video','adbar','now','prev','play','next','repeat','vol','input','add','msg','count','clear','list']
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
      if (state.ready) state.player.setVolume(v);
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
      else { state.current = -1; state.playing = false; clearResume(); render(); }
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
    clearResume();
    stopPlayer();
    state.playing = false;
    render();
  }

  /* ---------- pemutar ---------- */
  function ensureApi(cb) {
    if (state.ready) { cb(); return; }
    state.pendingPlay = cb;
    if (state.apiRequested) return;
    state.apiRequested = true;
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof prev === 'function') prev();
      createPlayer();
    };
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = function () { state.apiRequested = false; msg('Gagal memuat YouTube. Cek koneksi internet.', true); };
    document.head.appendChild(s);
  }

  function createPlayer() {
    state.player = new YT.Player('ytm-player', {
      width: '100%', height: '100%',
      playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, disablekb: 1 },
      events: {
        onReady: function () {
          state.ready = true;
          state.player.setVolume(parseInt(el.vol.value, 10));
          var cb = state.pendingPlay; state.pendingPlay = null;
          if (cb) cb();
        },
        onStateChange: onPlayerState,
        onError: function () {
          msg('Video tidak bisa diputar, lanjut ke berikutnya.', true);
          setTimeout(function () { step(1, true); }, 1200);
        }
      }
    });
  }

  function onPlayerState(e) {
    if (e.data === YT.PlayerState.PLAYING) {
      state.playing = true;
      state.resumeTries = 0;
      var cur = state.items[state.current];
      checkAd();
      try {
        var d = state.player.getVideoData();
        // jangan simpan judul iklan sebagai judul lagu
        if (!state.adMode && cur && d && d.title && cur.type === 'video' && !cur.title) { cur.title = d.title; save(); }
        if (!state.adMode && cur && cur.type === 'playlist' && d && d.title) el.now.textContent = d.title;
      } catch (err) {}
      if (!(cur && cur.type === 'playlist')) render(); else el.play.innerHTML = '&#10074;&#10074;';
    } else if (e.data === YT.PlayerState.PAUSED) {
      state.playing = false;
      el.play.innerHTML = '&#9654;';
      // kalau bukan user yang menjeda (mis. HUD disembunyikan), lanjutkan otomatis
      if (state.wantPlay && state.resumeTries < 3) {
        state.resumeTries++;
        setTimeout(function () {
          if (state.wantPlay) { try { state.player.playVideo(); } catch (err) {} }
        }, 400);
      }
    } else if (e.data === YT.PlayerState.ENDED) {
      step(1, true);
    }
  }

  // resume (opsional): { time, plIndex } untuk lanjut dari posisi tersimpan
  function playIndex(i, resume) {
    if (i < 0 || i >= state.items.length) return;
    state.current = i;
    state.wantPlay = true;
    var it = state.items[i];
    render();
    ensureApi(function () {
      var t = resume ? (resume.time || 0) : 0;
      if (it.type === 'playlist') {
        state.player.loadPlaylist({
          listType: 'playlist', list: it.id,
          index: resume ? (resume.plIndex || 0) : 0,
          startSeconds: t
        });
      } else {
        state.player.loadVideoById({ videoId: it.id, startSeconds: t });
      }
      state.player.setVolume(parseInt(el.vol.value, 10));
    });
  }

  function step(dir, fromEnd) {
    if (!state.items.length) return;
    var n = state.current + dir;
    if (n >= state.items.length || n < 0) {
      var loop = el.repeat.classList.contains('ytm-on');
      if (fromEnd && !loop && n >= state.items.length) {
        state.playing = false; state.wantPlay = false; render(); return;
      }
      n = (n + state.items.length) % state.items.length;
    }
    playIndex(n);
  }

  function togglePlay() {
    if (!state.items.length) { msg('Tambahkan link YouTube dulu.', true); return; }
    if (state.current === -1) { playIndex(0); return; }
    if (!state.ready) { playIndex(state.current); return; }
    var st = state.player.getPlayerState();
    if (st === YT.PlayerState.PLAYING) { state.wantPlay = false; state.player.pauseVideo(); }
    else if (st === YT.PlayerState.PAUSED) { state.wantPlay = true; state.player.playVideo(); }
    else playIndex(state.current);
  }

  function stopPlayer() {
    state.wantPlay = false;
    setAdMode(false);
    if (state.ready) { try { state.player.stopVideo(); } catch (e) {} }
    state.playing = false;
  }

  /* ---------- iklan: skip dengan kursor ---------- */
  // Player YouTube ada di iframe lintas-domain, jadi iklan tidak bisa dilewati lewat
  // kode. Yang bisa dilakukan: mendeteksi iklan, membuka panel, dan mengaktifkan
  // klik pada iframe agar kursor bisa menekan tombol "Lewati/Skip" milik YouTube.
  function injectAdStyle() {
    if (document.getElementById('ytm-ad-style')) return;
    var st = document.createElement('style');
    st.id = 'ytm-ad-style';
    st.textContent =
      '#ytm-root .ytm-video.ytm-ad iframe{pointer-events:auto;}' +
      '#ytm-root .ytm-video.ytm-ad{outline:2px solid #f1c40f;}' +
      '#ytm-root #ytm-panel.ytm-ad-mode{width:380px;}' +
      '#ytm-root .ytm-adbar{margin:-2px 0 8px;padding:6px 8px;border-radius:6px;' +
        'background:rgba(241,196,15,.16);color:#f1c40f;font-size:11px;line-height:1.35;}';
    document.head.appendChild(st);
  }

  function isAdPlaying() {
    try {
      var cur = state.items[state.current];
      if (!cur || !state.ready) return false;
      var d = state.player.getVideoData();
      var vid = d && d.video_id;
      if (!vid) return false;
      if (cur.type === 'video') return vid !== cur.id;
      var list = state.player.getPlaylist && state.player.getPlaylist();
      if (list && list.length) return list.indexOf(vid) === -1;
    } catch (e) {}
    return false;
  }

  function setAdMode(on) {
    if (on === state.adMode) return;
    state.adMode = on;
    if (!el.video) return;
    el.video.classList.toggle('ytm-ad', on);
    el.panel.classList.toggle('ytm-ad-mode', on);
    el.adbar.classList.toggle('ytm-hide', !on);
    if (on) {
      if (el.panel.classList.contains('ytm-hide')) {
        el.panel.classList.remove('ytm-hide');
        state.adOpenedPanel = true;
      }
    } else if (state.adOpenedPanel) {
      el.panel.classList.add('ytm-hide');
      state.adOpenedPanel = false;
    }
  }

  function checkAd() {
    if (!state.ready || state.current < 0 || !state.wantPlay) { setAdMode(false); return; }
    setAdMode(isAdPlaying());
  }

  /* ---------- lanjut otomatis ---------- */
  // Cadangan kalau autoplay diblokir: ketuk layar sekali untuk melanjutkan.
  function armGestureResume() {
    var h = function (e) {
      if (e.target && e.target.closest && e.target.closest('#ytm-root')) return;
      document.removeEventListener('pointerdown', h, true);
      if (state.wantPlay && state.ready && !state.playing) {
        try { state.player.playVideo(); } catch (err) {}
      }
    };
    document.addEventListener('pointerdown', h, true);
  }

  /* ---------- init ---------- */
  function init() {
    load();
    injectAdStyle();
    build();
    render();
    setInterval(checkAd, 700);

    // simpan posisi lagu secara berkala dan saat halaman disembunyikan/ditutup
    setInterval(saveResume, 2000);
    window.addEventListener('pagehide', saveResume);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { saveResume(); return; }
      if (state.wantPlay && state.ready && !state.playing) {
        try { state.player.playVideo(); } catch (e) {}
      }
    });

    // pulihkan lagu terakhir dan lanjut otomatis
    var r = loadResume();
    if (r && state.items[r.current] && state.items[r.current].id === r.id) {
      state.current = r.current;
      render();
      if (r.playing) { armGestureResume(); playIndex(r.current, r); }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
