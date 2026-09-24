/* ============================================================
   Tack — Figma-style comments on live prototypes · Verb Interactive
   v1.0.0

   Add to any page on a Netlify site that has the Tack function:
     <script src="/tack.js" defer></script>

   Options (data attributes on the script tag):
     data-api="/api/tack"     where the Tack function lives (default: same site)
     data-page="/custom/key"   override the page identity (default: pathname)
     data-open="true"          start with the drawer open

   On screens wider than 640px the open drawer docks and pushes the page
   left by 360px so nothing is hidden behind it. On phones it overlays.

   Comments are stored server-side through the Tack function; nothing
   here is a secret. Reviewers pick a display name once. A random token
   in localStorage lets them delete their own comments and nothing else.
============================================================ */
(function () {
  "use strict";
  if (window.__tackLoaded) return;
  window.__tackLoaded = true;

  var script = document.currentScript || {};
  var ds = script.dataset || {};
  var API = (ds.api || "/api/tack").replace(/\/+$/, "");
  var PAGE = normalizePage(ds.page || location.pathname);
  var Z = 2147483000;
  var POLL_MS = 20000;
  var LS = { name: "tack.name", token: "tack.token", drawer: "tack.drawer", filter: "tack.filter" };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function rand() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  var token = lsGet(LS.token);
  if (!token) { token = rand(); lsSet(LS.token, token); }

  var state = {
    comments: [],
    filter: lsGet(LS.filter) || "open",        // open | resolved | all
    open: ds.open === "true" || lsGet(LS.drawer) === "1",
    placing: false,
    pending: null,                              // { anchor } while composing
    activeId: null,
    loading: true,
    error: null
  };

  /* ---------- utils ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function relTime(iso) {
    var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
    return new Date(iso).toLocaleDateString();
  }
  function normalizePage(p) {
    var s = String(p || "").split(/[?#]/)[0];
    if (s.charAt(0) !== "/") s = "/" + s;
    s = s.replace(/\/index\.html?$/i, "/");
    if (s.length > 1) s = s.replace(/\/+$/, "");
    return s;
  }
  function getName() { return lsGet(LS.name) || ""; }
  function pluralize(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  /* ---------- API ---------- */
  function api(path, opts) {
    opts = opts || {};
    var headers = { "X-Tack-Token": token };
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin"
    }).then(function (r) {
      if (r.status === 204) return null;
      return r.text().then(function (t) {
        var d = null;
        try { d = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
        if (!r.ok) throw new Error((d && d.error) || ("Tack server returned " + r.status));
        return d;
      });
    });
  }
  function pageQ() { return "?page=" + encodeURIComponent(PAGE); }

  function load(silent) {
    return api("/comments" + pageQ()).then(function (list) {
      state.comments = list || [];
      state.loading = false;
      state.error = null;
      renderAll();
    }).catch(function (err) {
      state.loading = false;
      state.error = err.message || "Could not reach the Tack server.";
      renderAll();
      if (!silent) toast("Tack can’t reach its server");
    });
  }

  /* ---------- fonts (best effort) ---------- */
  var fl = document.createElement("link");
  fl.rel = "stylesheet";
  fl.href = "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap";
  document.head.appendChild(fl);

  /* ---------- shadow host ---------- */
  var host = document.createElement("div");
  host.id = "tack-widget";
  host.style.cssText = "position:absolute;top:0;left:0;width:100%;height:0;overflow:visible;z-index:" + Z + ";";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  var css = [
    ":host{all:initial}",
    "*{box-sizing:border-box;margin:0;padding:0}",
    "button{font:inherit;cursor:pointer;border:none;background:none;color:inherit}",
    "input,textarea{font:inherit;color:inherit}",
    ":focus-visible{outline:2px solid #0083A8;outline-offset:2px}",
    "[hidden]{display:none!important}",
    ".ui{--bg:#121212;--bg2:#1C1C1C;--bg3:#262626;--line:rgba(255,255,255,.14);--line2:rgba(255,255,255,.28);--text:#FFFFFF;--muted:rgba(255,255,255,.62);--teal:#0083A8;--teal2:#0FA0C9;--pink:#EC008C;",
    "  font-family:'Outfit',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:var(--text);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}",
    ".caps{text-transform:uppercase;letter-spacing:.08em;font-weight:600;font-size:11.5px}",

    /* capture layer */
    ".capture{position:fixed;inset:0;z-index:5;display:none;cursor:crosshair}",
    ".capture.on{display:block}",
    ".capture.on~#pins .pin{pointer-events:none}",
    ".capture .edge{position:fixed;inset:0;border:3px solid var(--teal);opacity:.7;pointer-events:none}",
    ".hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#000;color:#fff;border:1px solid var(--line);font-size:12px;font-weight:500;letter-spacing:.04em;padding:8px 18px;pointer-events:none;white-space:nowrap;z-index:40}",

    /* pill */
    ".pill{position:fixed;bottom:20px;right:20px;z-index:20;display:flex;align-items:center;gap:10px;background:#000;color:#fff;border:1px solid var(--line2);padding:10px 16px 10px 14px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;font-size:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);transition:border-color .15s,transform .15s}",
    ".pill:hover{border-color:#fff;transform:translateY(-1px)}",
    ".pill .sep{width:1px;height:14px;background:var(--line2)}",
    ".pill kbd{font:inherit;font-size:11px;color:var(--muted);letter-spacing:0}",
    ".pill .cnt{font-size:11px;background:#fff;color:#000;padding:1px 7px;min-width:20px;text-align:center;letter-spacing:0;margin-left:2px}",
    ".pill .cnt.hot{background:var(--teal);color:#fff}",

    /* pins */
    ".pin{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;z-index:10;border-radius:50%;background:var(--teal);color:#fff;font-family:'Outfit',system-ui,sans-serif;font-weight:600;font-size:12.5px;line-height:1;padding:0 0 1px;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);transition:transform .12s}",
    ".pin:hover,.pin.active{transform:scale(1.18);z-index:12}",
    ".pin.active{box-shadow:0 0 0 4px rgba(0,131,168,.35),0 2px 10px rgba(0,0,0,.35)}",
    ".pin.resolved{background:#fff;color:#121212;border-color:#121212}",
    ".pin.ghost{background:rgba(18,18,18,.85);color:#fff;border:2px dashed var(--teal2);box-shadow:none;animation:pulse 1.2s ease-in-out infinite}",
    ".pin.pop{animation:pop .3s cubic-bezier(.34,1.56,.64,1)}",
    "@keyframes pop{from{transform:scale(.3)}to{transform:scale(1)}}",
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}",

    /* drawer */
    ".drawer{position:fixed;top:0;right:0;bottom:0;width:360px;max-width:100vw;z-index:25;background:var(--bg);color:var(--text);border-left:1px solid var(--line);box-shadow:-24px 0 60px rgba(0,0,0,.35);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .22s cubic-bezier(.2,.8,.2,1);visibility:hidden}",
    ".drawer.open{transform:none;visibility:visible}",
    ".drawer.docked{box-shadow:none}",
    ".drawer.open.peek{transform:translateX(calc(100% - 44px))}",
    ".d-head{padding:16px 16px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;background:#000}",
    ".d-head .logo{display:flex;align-items:center;gap:10px;text-transform:uppercase;letter-spacing:.1em;font-weight:600;font-size:12px}",
    ".d-head .count{font-size:11px;color:var(--muted);flex:1;text-align:right;padding-right:4px;letter-spacing:.02em}",
    ".d-head .x{font-size:22px;line-height:1;color:var(--muted);padding:0 8px}",
    ".d-head .x:hover{color:#fff}",
    ".d-tools{padding:12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:10px;background:var(--bg)}",
    ".seg{display:flex;border:1px solid var(--line2);padding:0}",
    ".seg button{flex:1;padding:8px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600;color:var(--muted);display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;border-right:1px solid var(--line2)}",
    ".seg button:last-child{border-right:0}",
    ".seg button:hover{color:#fff}",
    ".seg button[aria-selected=true]{background:#fff;color:#000}",
    ".seg .c{font-size:10px;font-weight:600;color:inherit;opacity:.7;letter-spacing:0}",
    ".btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.08em;border:1px solid var(--line2);background:transparent;color:#fff;position:relative;z-index:1;overflow:hidden;transition:color .2s,border-color .2s}",
    ".btn:before{content:'';position:absolute;inset:0;z-index:-1;background:var(--teal);transform:translateX(-101%);transition:transform .25s ease}",
    ".btn:hover{border-color:var(--teal)}",
    ".btn:hover:before{transform:none}",
    ".btn.primary{background:#fff;color:#000;border-color:#fff}",
    ".btn.primary:hover{color:#fff;border-color:var(--teal)}",
    ".btn.primary[aria-pressed=true]{background:var(--teal);color:#fff;border-color:var(--teal)}",
    ".btn.primary[aria-pressed=true]:before{background:#000}",
    ".btn.sm{padding:7px 12px;font-size:11px}",
    ".btn:disabled{opacity:.6;cursor:default}",
    ".d-notice{padding:10px 16px;font-size:12.5px;background:rgba(236,0,140,.12);color:#fff;border-bottom:1px solid rgba(236,0,140,.4)}",
    ".d-list{flex:1;overflow-y:auto;padding:8px}",
    ".d-foot{border-top:1px solid var(--line);padding:10px 12px;display:flex;align-items:center;gap:10px;background:#000}",
    ".d-foot .page{flex:1;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:.02em}",

    /* composer */
    ".composer{border:1px solid var(--teal);padding:12px;margin-bottom:8px;background:var(--bg2)}",
    ".composer .c-head{display:flex;align-items:center;gap:10px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px;color:var(--muted)}",
    ".composer input,.composer textarea,.replybox input,.replybox textarea{width:100%;border:1px solid var(--line2);padding:9px 11px;background:#000;color:#fff;font-size:13.5px}",
    ".composer input::placeholder,.composer textarea::placeholder,.replybox input::placeholder,.replybox textarea::placeholder{color:rgba(255,255,255,.4)}",
    ".composer textarea,.replybox textarea{min-height:76px;resize:vertical;font-size:14px}",
    ".composer input+textarea{margin-top:8px}",
    ".composer input:focus,.composer textarea:focus,.replybox input:focus,.replybox textarea:focus{outline:none;border-color:var(--teal2)}",
    ".row-end{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}",

    /* items */
    ".n{width:24px;height:24px;border-radius:50%;background:var(--teal);color:#fff;font-size:11px;font-weight:600;line-height:1;padding-bottom:1px;display:inline-flex;align-items:center;justify-content:center;flex:none}",
    ".n.done{background:#fff;color:#121212}",
    ".n.ghost{background:transparent;color:#fff;border:1.5px dashed var(--teal2)}",
    ".item{border:1px solid transparent;padding:12px;margin-bottom:2px;display:grid;grid-template-columns:26px 1fr;gap:2px 10px;cursor:pointer}",
    ".item:hover{background:var(--bg2)}",
    ".item.active{border-color:var(--line2);background:var(--bg2);cursor:default}",
    ".item .n{margin-top:1px}",
    ".item .body{min-width:0}",
    ".who{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    ".who time{font-weight:400;font-size:11px;color:var(--muted)}",
    ".tag{font-weight:600;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border:1px solid var(--line2);padding:1px 6px;white-space:nowrap}",
    ".tag.you{color:#fff;border-color:var(--teal);background:rgba(0,131,168,.25)}",
    ".txt{font-size:13.5px;overflow-wrap:anywhere;white-space:pre-wrap;margin-top:3px;color:#fff}",
    ".item.resolved .txt{color:var(--muted)}",
    ".item.resolved:not(.active) .txt{text-decoration:line-through;text-decoration-color:rgba(255,255,255,.35)}",
    ".meta{font-size:11.5px;color:var(--muted);margin-top:5px}",
    ".meta .ok{color:#fff;font-weight:600}",
    ".replies{margin-top:10px;border-left:2px solid var(--line2);padding-left:10px;display:flex;flex-direction:column;gap:8px}",
    ".reply .who{font-size:12px}",
    ".reply .txt{font-size:13px}",
    ".reply .rdel{margin-left:auto;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}",
    ".reply .rdel:hover{color:var(--pink)}",
    ".replybox{margin-top:10px;display:flex;flex-direction:column;gap:6px}",
    ".replybox textarea{min-height:46px}",
    ".replybox .row-end{margin-top:0}",
    ".acts{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}",
    ".acts button{font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--muted);text-align:center;padding:6px 8px}",
    ".acts button:hover{color:#fff}",
    ".acts .rs:hover{color:var(--teal2)}",
    ".acts .dl{border-left:1px solid var(--line)}",
    ".acts .dl:hover{color:var(--pink)}",
    ".empty{padding:40px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.6}",
    ".empty .dpin{width:32px;height:32px;border-radius:50%;background:var(--teal);color:#fff;border:2px solid #fff;font-weight:600;line-height:1;padding-bottom:1px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px}",
    ".empty b{color:#fff}",

    ".toast{position:fixed;bottom:80px;right:20px;background:#000;color:#fff;border:1px solid var(--line2);border-left:3px solid var(--teal);padding:9px 16px;font-size:12.5px;font-weight:500;letter-spacing:.02em;opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:none;z-index:70}",
    ".toast.show{opacity:1;transform:none}",
    ".drawer.open~.toast{right:380px}",

    "@media (max-width:640px){.drawer{width:100vw}.pill{left:50%;right:auto;transform:translateX(-50%)}.drawer.open~.toast{right:20px;bottom:76px}.drawer.open.peek{transform:translateX(100%)}}",
    "@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}"
  ].join("\n");

  root.innerHTML =
    '<style>' + css + '</style>' +
    '<div class="ui">' +
    '  <div class="capture" id="capture"><span class="edge"></span></div>' +
    '  <div class="hint" id="hint" hidden>Click anywhere on the page to place the comment · Esc to cancel</div>' +
    '  <div id="pins"></div>' +
    '  <aside class="drawer" id="drawer" aria-label="Tack comments">' +
    '    <header class="d-head">' +
    '      <span class="logo">Tack</span>' +
    '      <span class="count" id="dCount"></span>' +
    '      <button class="x" id="dClose" aria-label="Hide comments" title="Hide comments (C)">&times;</button>' +
    '    </header>' +
    '    <div class="d-tools">' +
    '      <div class="seg" role="tablist" aria-label="Filter comments">' +
    '        <button role="tab" data-filter="open">Ongoing <span class="c" id="nOpen">0</span></button>' +
    '        <button role="tab" data-filter="resolved">Resolved <span class="c" id="nResolved">0</span></button>' +
    '        <button role="tab" data-filter="all">All <span class="c" id="nAll">0</span></button>' +
    '      </div>' +
    '      <button class="btn primary" id="newBtn" aria-pressed="false">+&nbsp; New comment</button>' +
    '    </div>' +
    '    <div class="d-notice" id="dNotice" hidden></div>' +
    '    <div class="d-list" id="dList"></div>' +
    '    <footer class="d-foot">' +
    '      <span class="page mono" id="dPage"></span>' +
    '      <button class="btn sm" id="copyBtn">Copy summary</button>' +
    '    </footer>' +
    '  </aside>' +
    '  <button class="pill" id="pill" aria-expanded="false" title="Show comments (C)">Tack<span class="sep"></span><kbd>C</kbd><span class="cnt" id="pillCnt">0</span></button>' +
    '  <div class="toast" id="toast" role="status"></div>' +
    '</div>';

  var $ = function (s) { return root.querySelector(s); };
  var pinsBox = $("#pins");
  var listBox = $("#dList");
  $("#dPage").textContent = PAGE;
  $("#dPage").title = "Comments are keyed to " + PAGE;

  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove("show"); }, 2400);
  }

  /* ---------- element anchoring ---------- */
  function cssPath(el) {
    if (!el || el === document.body || el === document.documentElement) return "body";
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { parts.unshift("#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)); break; }
      var sel = el.tagName.toLowerCase();
      var parent = el.parentElement;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
        if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
      }
      parts.unshift(sel);
      el = parent;
    }
    if (parts.length && parts[0].charAt(0) !== "#") parts.unshift("body");
    return parts.join(">");
  }

  /* Anchored pins follow their element through responsive reflow. Returns
     null when the element is missing or hidden at this breakpoint. Falls
     back to page coordinates for comments with no usable selector. */
  function docPos(a) {
    if (a.sel) {
      try {
        var el = document.querySelector(a.sel);
        if (el && !host.contains(el)) {
          var r = el.getBoundingClientRect();
          if (r.width || r.height) {
            return { x: r.left + window.scrollX + r.width * a.ox, y: r.top + window.scrollY + r.height * a.oy };
          }
        }
      } catch (e) { /* bad selector */ }
      return null;
    }
    return { x: a.px, y: a.py };
  }

  /* ---------- derived ---------- */
  function visible() {
    return state.comments.filter(function (c) {
      if (state.filter === "open") return !c.resolved;
      if (state.filter === "resolved") return c.resolved;
      return true;
    }).sort(function (a, b) { return a.n - b.n; });
  }
  function nextN() { return state.comments.reduce(function (m, c) { return Math.max(m, c.n); }, 0) + 1; }
  function find(id) { for (var i = 0; i < state.comments.length; i++) if (state.comments[i].id === id) return state.comments[i]; return null; }

  /* ---------- pins ---------- */
  function renderPins() {
    pinsBox.innerHTML = "";
    if (!state.open) return;
    var hr = host.getBoundingClientRect();
    var offX = hr.left + window.scrollX, offY = hr.top + window.scrollY;

    visible().forEach(function (c) {
      var pos = docPos(c.anchor);
      if (!pos) return;
      var p = document.createElement("button");
      p.className = "pin" + (c.n % 2 === 0 ? " even" : "") + (c.resolved ? " resolved" : "") + (state.activeId === c.id ? " active" : "");
      p.style.left = (pos.x - offX) + "px";
      p.style.top = (pos.y - offY) + "px";
      p.textContent = c.n;
      p.title = c.text;
      p.setAttribute("aria-label", "Comment " + c.n + " by " + c.author + (c.resolved ? " (resolved)" : ""));
      p.dataset.id = c.id;
      p.addEventListener("click", function (ev) {
        ev.stopPropagation();
        state.activeId = c.id;
        renderAll();
        var item = listBox.querySelector('[data-id="' + c.id + '"]');
        if (item) item.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      pinsBox.appendChild(p);
    });

    if (state.pending) {
      var gp = docPos(state.pending.anchor);
      if (gp) {
        var g = document.createElement("span");
        g.className = "pin ghost";
        g.style.left = (gp.x - offX) + "px";
        g.style.top = (gp.y - offY) + "px";
        g.textContent = nextN();
        pinsBox.appendChild(g);
      }
    }
  }

  var rz;
  function schedule() { clearTimeout(rz); rz = setTimeout(renderPins, 120); }
  if (window.ResizeObserver) new ResizeObserver(schedule).observe(document.body);
  window.addEventListener("resize", schedule);
  window.addEventListener("load", schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);

  /* ---------- drawer ---------- */
  /* Above the phone breakpoint the drawer docks: the page is pushed left by
     the drawer's width so nothing sits behind it and every element stays
     clickable. Fixed-position elements in the prototype are viewport-based
     and will still run under the drawer; that is a browser limit. */
  var DRAWER_W = 360, MOBILE = 640;
  var docEl = document.documentElement;
  var savedMargin = null;
  function applyPush() {
    var push = state.open && window.innerWidth > MOBILE;
    if (push) {
      if (savedMargin === null) savedMargin = docEl.style.marginRight || "";
      docEl.style.setProperty("margin-right", DRAWER_W + "px", "important");
    } else if (savedMargin !== null) {
      docEl.style.marginRight = savedMargin;
      if (!docEl.style.marginRight) docEl.style.removeProperty("margin-right");
      savedMargin = null;
    }
    $("#drawer").classList.toggle("docked", push);
  }
  window.addEventListener("resize", applyPush);

  function setOpen(open) {
    state.open = !!open;
    lsSet(LS.drawer, state.open ? "1" : "0");
    $("#drawer").classList.toggle("open", state.open);
    $("#pill").hidden = state.open;
    $("#pill").setAttribute("aria-expanded", state.open);
    applyPush();
    if (!state.open) { setPlacing(false); cancelCompose(); }
    renderAll();
    if (state.open) load(true);
  }
  $("#pill").addEventListener("click", function () { setOpen(true); });
  $("#dClose").addEventListener("click", function () { setOpen(false); });

  Array.prototype.forEach.call(root.querySelectorAll(".seg button"), function (b) {
    b.addEventListener("click", function () {
      state.filter = b.dataset.filter;
      lsSet(LS.filter, state.filter);
      renderAll();
    });
  });

  /* ---------- placing ---------- */
  function setPlacing(on) {
    state.placing = !!on;
    $("#newBtn").setAttribute("aria-pressed", state.placing);
    $("#newBtn").innerHTML = state.placing ? "&#10005;&nbsp; Cancel placing" : "+&nbsp; New comment";
    $("#capture").classList.toggle("on", state.placing);
    $("#hint").hidden = !state.placing;
    // On narrow screens the drawer covers the page, so slide it away while placing.
    $("#drawer").classList.toggle("peek", state.placing && window.innerWidth <= 640);
  }
  $("#newBtn").addEventListener("click", function () {
    if (state.pending) cancelCompose();
    setPlacing(!state.placing);
  });

  $("#capture").addEventListener("click", function (e) {
    var px = e.clientX + window.scrollX;
    var py = e.clientY + window.scrollY;
    var stack = document.elementsFromPoint(e.clientX, e.clientY) || [];
    var target = null;
    for (var i = 0; i < stack.length; i++) {
      if (stack[i] !== host && !host.contains(stack[i])) { target = stack[i]; break; }
    }
    var anchor = { px: px, py: py, vw: window.innerWidth };
    if (target && target !== document.documentElement) {
      var r = target.getBoundingClientRect();
      if (r.width && r.height) {
        anchor.sel = cssPath(target);
        anchor.ox = (e.clientX - r.left) / r.width;
        anchor.oy = (e.clientY - r.top) / r.height;
      }
    }
    state.pending = { anchor: anchor };
    state.activeId = null;
    setPlacing(false);
    renderAll();
    var ta = listBox.querySelector("#cText"), nm = listBox.querySelector("#cName");
    if (nm && !nm.value) nm.focus(); else if (ta) ta.focus();
  });

  function cancelCompose() {
    if (!state.pending) return;
    state.pending = null;
    renderAll();
  }

  function submitCompose() {
    var nm = listBox.querySelector("#cName"), ta = listBox.querySelector("#cText"), btn = listBox.querySelector("#cSave");
    var name = (nm.value || "").trim() || "Guest";
    var text = (ta.value || "").trim();
    if (!text) { ta.focus(); return; }
    lsSet(LS.name, name);
    btn.disabled = true; btn.textContent = "Posting…";
    api("/comments", { method: "POST", body: { page: PAGE, anchor: state.pending.anchor, author: name, text: text } })
      .then(function (c) {
        state.pending = null;
        state.comments.push(c);
        state.activeId = c.id;
        if (state.filter === "resolved") state.filter = "open";
        renderAll();
        var pin = pinsBox.querySelector('.pin[data-id="' + c.id + '"]');
        if (pin) pin.classList.add("pop");
        toast("Comment " + c.n + " posted");
      })
      .catch(function (err) {
        btn.disabled = false; btn.textContent = "Post comment";
        toast(err.message);
      });
  }

  /* ---------- list ---------- */
  function renderList() {
    var all = state.comments;
    var nOpen = all.filter(function (c) { return !c.resolved; }).length;
    $("#nOpen").textContent = nOpen;
    $("#nResolved").textContent = all.length - nOpen;
    $("#nAll").textContent = all.length;
    $("#pillCnt").textContent = nOpen;
    $("#pillCnt").classList.toggle("hot", nOpen > 0);
    $("#dCount").textContent = all.length ? nOpen + " ongoing · " + all.length + " total" : "";
    Array.prototype.forEach.call(root.querySelectorAll(".seg button"), function (b) {
      b.setAttribute("aria-selected", b.dataset.filter === state.filter);
    });
    var notice = $("#dNotice");
    notice.hidden = !state.error;
    notice.textContent = state.error ? state.error + " Comments will retry when you reopen the drawer." : "";

    listBox.innerHTML = "";

    if (state.pending) {
      var comp = document.createElement("div");
      comp.className = "composer";
      var savedName = getName();
      comp.innerHTML =
        '<div class="c-head"><span class="n ghost">' + nextN() + '</span>New comment</div>' +
        '<input id="cName" placeholder="Your name" aria-label="Your name" maxlength="60" value="' + esc(savedName) + '">' +
        '<textarea id="cText" placeholder="What should change here?" aria-label="Comment" maxlength="2000"></textarea>' +
        '<div class="row-end"><button class="btn sm" id="cCancel">Cancel</button><button class="btn sm primary" id="cSave">Post comment</button></div>';
      comp.querySelector("#cCancel").addEventListener("click", cancelCompose);
      comp.querySelector("#cSave").addEventListener("click", submitCompose);
      comp.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") { ev.stopPropagation(); cancelCompose(); }
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) submitCompose();
      });
      listBox.appendChild(comp);
    }

    var cs = visible();
    if (!cs.length && !state.pending) {
      var empty = document.createElement("div");
      empty.className = "empty";
      if (state.loading) empty.textContent = "Loading comments…";
      else if (state.filter === "resolved") empty.innerHTML = "Nothing resolved yet.";
      else if (state.filter === "open" && all.length) empty.innerHTML = "Every comment on this page is resolved.<br>Switch to <b>Resolved</b> or <b>All</b> to see them.";
      else empty.innerHTML = '<div class="dpin">1</div>No comments on this page yet.<br>Press <b>New comment</b>, then click anywhere on the page.';
      listBox.appendChild(empty);
      return;
    }

    cs.forEach(function (c) {
      var active = state.activeId === c.id;
      var el = document.createElement("article");
      el.className = "item" + (c.resolved ? " resolved" : "") + (active ? " active" : "");
      el.dataset.id = c.id;
      var hidden = !docPos(c.anchor);
      var html =
        '<span class="n' + (c.resolved ? " done" : "") + '">' + c.n + '</span>' +
        '<div class="body">' +
        '  <div class="who">' + esc(c.author) +
        (c.mine ? '<span class="tag you">you</span>' : "") +
        '<time datetime="' + esc(c.createdAt) + '">' + relTime(c.createdAt) + (c.editedAt ? " · edited" : "") + '</time>' +
        (hidden ? '<span class="tag">hidden at this size</span>' : "") +
        '  </div>' +
        '  <div class="txt">' + esc(c.text) + '</div>';

      if (!active) {
        var bits = [];
        if (c.replies.length) bits.push(pluralize(c.replies.length, "reply"));
        if (c.resolved) bits.push('<span class="ok">Resolved' + (c.resolvedBy ? " by " + esc(c.resolvedBy) : "") + '</span>');
        if (bits.length) html += '<div class="meta">' + bits.join(" · ") + '</div>';
      } else {
        if (c.resolved) html += '<div class="meta"><span class="ok">&#10004; Resolved' + (c.resolvedBy ? " by " + esc(c.resolvedBy) : "") + (c.resolvedAt ? " · " + relTime(c.resolvedAt) : "") + '</span></div>';
        if (c.replies.length) {
          html += '<div class="replies">' + c.replies.map(function (r) {
            return '<div class="reply" data-rid="' + esc(r.id) + '"><div class="who">' + esc(r.author) +
              (r.mine ? '<span class="tag you">you</span>' : "") +
              '<time>' + relTime(r.at) + '</time>' +
              (r.canDelete ? '<button class="rdel" title="Delete reply">Delete</button>' : "") +
              '</div><div class="txt">' + esc(r.text) + '</div></div>';
          }).join("") + '</div>';
        }
        html += '<div class="replybox">' +
          (getName() ? "" : '<input class="rName" placeholder="Your name" aria-label="Your name" maxlength="60">') +
          '<textarea class="rText" placeholder="Reply…" aria-label="Reply" maxlength="2000"></textarea>' +
          '<div class="row-end"><button class="btn sm primary rSend">Reply</button></div></div>';
        html += '<div class="acts">' +
          '<button class="rs">' + (c.resolved ? "Reopen" : "Resolve") + '</button>' +
          (c.canDelete ? '<button class="dl">Delete</button>' : "") +
          '</div>';
      }
      html += '</div>';
      el.innerHTML = html;

      el.addEventListener("click", function (e) {
        if (e.target.closest("button, textarea, input, .replybox")) return;
        state.activeId = active ? null : c.id;
        renderAll();
        if (!active) {
          var pos = docPos(c.anchor);
          if (pos) window.scrollTo({ top: Math.max(0, pos.y - window.innerHeight / 2), behavior: "smooth" });
        }
      });

      if (active) {
        el.querySelector(".rs").addEventListener("click", function () { toggleResolved(c); });
        var dl = el.querySelector(".dl");
        if (dl) dl.addEventListener("click", function () { removeComment(c); });
        var send = el.querySelector(".rSend");
        send.addEventListener("click", function () { sendReply(c, el); });
        el.querySelector(".rText").addEventListener("keydown", function (ev) {
          if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) sendReply(c, el);
        });
        Array.prototype.forEach.call(el.querySelectorAll(".rdel"), function (b) {
          b.addEventListener("click", function () {
            var rid = b.closest(".reply").dataset.rid;
            api("/comments/" + c.id, { method: "PATCH", body: { page: PAGE, deleteReply: rid } })
              .then(function (u) { replace(u); renderAll(); })
              .catch(function (err) { toast(err.message); });
          });
        });
      }
      listBox.appendChild(el);
    });
  }

  function replace(updated) {
    for (var i = 0; i < state.comments.length; i++) if (state.comments[i].id === updated.id) { state.comments[i] = updated; return; }
    state.comments.push(updated);
  }

  function toggleResolved(c) {
    var was = c.resolved;
    c.resolved = !was; renderAll();
    api("/comments/" + c.id, { method: "PATCH", body: { page: PAGE, resolved: !was, author: getName() || "Guest" } })
      .then(function (u) { replace(u); renderAll(); toast(was ? "Comment " + c.n + " reopened" : "Comment " + c.n + " resolved"); })
      .catch(function (err) { c.resolved = was; renderAll(); toast(err.message); });
  }

  function removeComment(c) {
    if (!window.confirm("Delete comment " + c.n + "? This can’t be undone.")) return;
    api("/comments/" + c.id + pageQ(), { method: "DELETE" })
      .then(function () {
        state.comments = state.comments.filter(function (x) { return x.id !== c.id; });
        if (state.activeId === c.id) state.activeId = null;
        renderAll(); toast("Comment " + c.n + " deleted");
      })
      .catch(function (err) { toast(err.message); });
  }

  function sendReply(c, el) {
    var ta = el.querySelector(".rText"), nm = el.querySelector(".rName"), btn = el.querySelector(".rSend");
    var text = (ta.value || "").trim();
    if (!text) { ta.focus(); return; }
    var name = getName() || (nm && nm.value.trim()) || "Guest";
    lsSet(LS.name, name);
    btn.disabled = true;
    api("/comments/" + c.id, { method: "PATCH", body: { page: PAGE, reply: { author: name, text: text } } })
      .then(function (u) { replace(u); renderAll(); })
      .catch(function (err) { btn.disabled = false; toast(err.message); });
  }

  /* ---------- summary ---------- */
  $("#copyBtn").addEventListener("click", function () {
    var lines = ["# Tack comments — " + document.title, "URL: " + location.href, ""];
    state.comments.slice().sort(function (a, b) { return a.n - b.n; }).forEach(function (c) {
      lines.push(c.n + ". [" + (c.resolved ? "resolved" : "ongoing") + "] " + c.author + ": " + c.text);
      c.replies.forEach(function (r) { lines.push("     ↳ " + r.author + ": " + r.text); });
    });
    if (!state.comments.length) lines.push("(no comments)");
    var text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Summary copied"); }, function () { window.prompt("Copy the summary:", text); });
    } else {
      window.prompt("Copy the summary:", text);
    }
  });

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", function (e) {
    var t = (e.composedPath ? e.composedPath()[0] : e.target) || {};
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
    if (e.key === "Escape") {
      if (state.placing) { setPlacing(false); return; }
      if (state.pending && !typing) { cancelCompose(); return; }
      return;
    }
    // Plain C toggles the drawer. Ignored while any input, textarea or
    // editable element has focus, in the page or in the drawer.
    if (!typing && (e.key === "c" || e.key === "C") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setOpen(!state.open);
    }
  });

  /* ---------- single-page apps ---------- */
  /* History-based routers change the URL without a reload. Re-key the
     comments to the new path so each screen keeps its own thread. A
     data-page override on the script tag pins the key instead. */
  var pageLocked = !!ds.page;
  function onRouteChange() {
    if (pageLocked) return;
    var next = normalizePage(location.pathname);
    if (next === PAGE) return;
    PAGE = next;
    $("#dPage").textContent = PAGE;
    $("#dPage").title = "Comments are keyed to " + PAGE;
    state.comments = []; state.pending = null; state.activeId = null; state.loading = true;
    setPlacing(false);
    renderAll();
    load(true);
  }
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    if (typeof orig !== "function") return;
    history[k] = function () { var r = orig.apply(this, arguments); setTimeout(onRouteChange, 0); return r; };
  });
  window.addEventListener("popstate", function () { setTimeout(onRouteChange, 0); });
  // Frameworks swap DOM without resizing the body; re-anchor pins when they do.
  if (window.MutationObserver) {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) if (!host.contains(muts[i].target)) { schedule(); return; }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- polling ---------- */
  setInterval(function () {
    if (state.open && document.visibilityState === "visible" && !state.pending) load(true);
  }, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.open) load(true);
  });

  /* ---------- boot ---------- */
  function renderAll() { renderList(); renderPins(); }
  $("#drawer").classList.toggle("open", state.open);
  $("#pill").hidden = state.open;
  $("#pill").setAttribute("aria-expanded", state.open);
  applyPush();
  renderAll();
  load(!state.open);
})();
