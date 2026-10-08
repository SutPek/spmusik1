/* tiktok.js — pemutar TikTok untuk proyek spmusik1
 * Tidak mengubah app.js / music.js / peer.js. Cukup dimuat setelah file-file itu.
 * Menempelkan tombol kecil + panel pemutar ke halaman.
 * Memutar lewat embed resmi TikTok (iframe), bukan mengunduh video/audio.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "spmusik1.tiktok.queue";
  var queue = [];     // [{id, url}]
  var current = -1;

  /* ---------- Util ---------- */

  // Ambil video ID dari URL tiktok.com/@user/video/123...
  function extractId(url) {
    var m = String(url).match(/\/video\/(\d{8,25})/);
    return m ? m[1] : null;
  }

  // Link pendek (vm.tiktok.com / vt.tiktok.com / tiktok.com/t/xxx) harus di-resolve
  // lewat oEmbed resmi TikTok untuk mendapatkan video ID.
  function resolveShortLink(url) {
    var api = "https://www.tiktok.com/oembed?url=" + encodeURIComponent(url);
    return fetch(api)
      .then(function (r) {
        if (!r.ok) throw new Error("oEmbed gagal (" + r.status + ")");
        return r.json();
      })
      .then(function (data) {
        var id = data.embed_product_id || (data.html && (data.html.match(/data-video-id="(\d+)"/) || [])[1]);
        if (!id) throw new Error("Video ID tidak ditemukan");
        return id;
      });
  }

  function isTikTokUrl(url) {
    try {
      var h = new URL(url).hostname.replace(/^www\./, "");
      return h === "tiktok.com" || h.slice(-11) === ".tiktok.com";
    } catch (e) {
      return false;
    }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(queue)); } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) queue = JSON.parse(raw) || [];
    } catch (e) { queue = []; }
  }

  /* ---------- UI ---------- */

  var root = document.createElement("div");
  root.id = "tt-root";
  root.className = "no-drag";
  root.innerHTML =
    '<button id="tt-toggle" class="tt-fab" title="Pemutar TikTok" aria-label="Buka pemutar TikTok">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19.6 6.7a5.2 5.2 0 0 1-3.2-1.1A5.2 5.2 0 0 1 14.6 2h-3.4v13.2a2.5 2.5 0 1 1-2.5-2.5c.3 0 .5 0 .8.1V9.3a6 6 0 0 0-.8-.1 5.9 5.9 0 1 0 5.9 5.9V8.4a8.6 8.6 0 0 0 5 1.6V6.7z"/></svg>' +
    '</button>' +
    '<div id="tt-panel" class="tt-panel tt-hide">' +
      '<div class="tt-head"><span>Pemutar TikTok</span><button id="tt-close" class="tt-x" aria-label="Tutup">&times;</button></div>' +
      '<div class="tt-row">' +
        '<input id="tt-input" type="url" placeholder="Tempel link TikTok…" autocomplete="off">' +
        '<button id="tt-play" class="tt-btn">Putar</button>' +
      '</div>' +
      '<div id="tt-msg" class="tt-msg" role="status"></div>' +
      '<div id="tt-stage" class="tt-stage"><div class="tt-empty">Tempel link video TikTok lalu tekan Putar.</div></div>' +
      '<div class="tt-nav">' +
        '<button id="tt-prev" class="tt-btn tt-ghost">‹ Sebelumnya</button>' +
        '<button id="tt-next" class="tt-btn tt-ghost">Berikutnya ›</button>' +
      '</div>' +
      '<ul id="tt-list" class="tt-list"></ul>' +
    '</div>';
  document.body.appendChild(root);

  var $ = function (id) { return document.getElementById(id); };
  var panel = $("tt-panel"), input = $("tt-input"), msg = $("tt-msg"),
      stage = $("tt-stage"), list = $("tt-list");

  function setMsg(text, isError) {
    msg.textContent = text || "";
    msg.className = "tt-msg" + (isError ? " tt-err" : "");
  }

  function renderList() {
    list.innerHTML = "";
    queue.forEach(function (item, i) {
      var li = document.createElement("li");
      if (i === current) li.className = "tt-active";
      var b = document.createElement("button");
      b.className = "tt-item";
      b.textContent = (i + 1) + ". " + item.url.replace(/^https?:\/\/(www\.)?/, "");
      b.onclick = function () { playIndex(i); };
      var d = document.createElement("button");
      d.className = "tt-x";
      d.setAttribute("aria-label", "Hapus");
      d.innerHTML = "&times;";
      d.onclick = function () { removeIndex(i); };
      li.appendChild(b);
      li.appendChild(d);
      list.appendChild(li);
    });
  }

  function showPlayer(id) {
    stage.innerHTML = "";
    var f = document.createElement("iframe");
    // Player resmi TikTok; autoplay jalan karena dipicu klik pengguna.
    f.src = "https://www.tiktok.com/player/v1/" + id +
            "?autoplay=1&loop=1&music_info=1&description=1&rel=0";
    f.allow = "autoplay; fullscreen; encrypted-media";
    f.allowFullscreen = true;
    f.title = "TikTok " + id;
    f.className = "tt-frame";
    stage.appendChild(f);
  }

  /* ---------- Logika antrean ---------- */

  function playIndex(i) {
    if (i < 0 || i >= queue.length) return;
    current = i;
    showPlayer(queue[i].id);
    renderList();
    setMsg("");
  }

  function removeIndex(i) {
    queue.splice(i, 1);
    if (i < current) current--;
    else if (i === current) {
      current = -1;
      stage.innerHTML = '<div class="tt-empty">Video dihapus dari antrean.</div>';
    }
    save();
    renderList();
  }

  function addAndPlay(url) {
    url = url.trim();
    if (!url) return setMsg("Link masih kosong.", true);
    if (!isTikTokUrl(url)) return setMsg("Itu bukan link TikTok.", true);

    var id = extractId(url);
    var ready = id ? Promise.resolve(id) : (setMsg("Memproses link pendek…"), resolveShortLink(url));

    ready.then(function (vid) {
      var exist = queue.findIndex(function (q) { return q.id === vid; });
      if (exist === -1) {
        queue.push({ id: vid, url: url });
        exist = queue.length - 1;
        save();
      }
      input.value = "";
      playIndex(exist);
    }).catch(function () {
      setMsg("Link tidak bisa diputar. Coba link lengkap berbentuk tiktok.com/@akun/video/…", true);
    });
  }

  /* ---------- Event ---------- */

  $("tt-toggle").onclick = function () { panel.classList.toggle("tt-hide"); };
  $("tt-close").onclick  = function () { panel.classList.add("tt-hide"); };
  $("tt-play").onclick   = function () { addAndPlay(input.value); };
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") addAndPlay(input.value); });
  $("tt-next").onclick   = function () { if (queue.length) playIndex((current + 1) % queue.length); };
  $("tt-prev").onclick   = function () { if (queue.length) playIndex((current - 1 + queue.length) % queue.length); };

  // Cegah klik di panel ikut men-drag dasbor (app.js memakai kelas no-drag)
  ["mousedown", "touchstart", "pointerdown"].forEach(function (ev) {
    root.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
  });

  load();
  renderList();

  // API kecil kalau mau dipanggil dari kode lain: window.TikTokPlayer.play(url)
  window.TikTokPlayer = { play: addAndPlay, next: function () { $("tt-next").click(); }, prev: function () { $("tt-prev").click(); } };
})();
