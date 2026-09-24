/* ============================================================
   VERB-Tack — Figma-style comments on live prototypes · Verb Interactive
   v1.0.0

   Add to any page on a Netlify site that has the VERB-Tack function:
     <script src="/tack.js" defer></script>

   Options (data attributes on the script tag):
     data-api="/api/tack"     where the VERB-Tack function lives (default: same site)
     data-page="/custom/key"   override the page identity (default: pathname)
     data-open="true"          start with the drawer open

   Comments are stored server-side through the VERB-Tack function; nothing
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
        if (!r.ok) throw new Error((d && d.error) || ("VERB-Tack server returned " + r.status));
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
      state.error = err.message || "Could not reach the VERB-Tack server.";
      renderAll();
      if (!silent) toast("VERB-Tack can’t reach its server");
    });
  }

  /* ---------- fonts (best effort) ---------- */
  var fl = document.createElement("link");
  fl.rel = "stylesheet";
  fl.href = "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Spline+Sans+Mono:wght@500;600&display=swap";
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
    ":focus-visible{outline:2px solid #E2472B;outline-offset:2px;border-radius:4px}",
    "[hidden]{display:none!important}",
    ".ui{font-family:'Instrument Sans',system-ui,sans-serif;font-size:14px;line-height:1.5;color:#1C1A17;-webkit-font-smoothing:antialiased}",
    ".mono{font-family:'Spline Sans Mono',ui-monospace,monospace}",

    /* capture layer */
    ".capture{position:fixed;inset:0;z-index:5;display:none;cursor:crosshair}",
    ".capture.on{display:block}",
    ".capture .edge{position:fixed;inset:0;border:3px solid #E2472B;opacity:.6;pointer-events:none}",
    ".hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#1C1A17;color:#FBFAF7;font-size:13px;font-weight:500;padding:7px 16px;border-radius:99px;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none;white-space:nowrap;z-index:40}",

    /* pill */
    ".pill{position:fixed;bottom:20px;right:20px;z-index:20;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #E3DFD6;border-radius:99px;padding:8px 14px 8px 10px;font-weight:600;font-size:13.5px;letter-spacing:-.01em;box-shadow:0 2px 6px rgba(28,26,23,.12),0 16px 40px rgba(28,26,23,.18);transition:transform .15s,box-shadow .15s}",
    ".pill:hover{transform:translateY(-1px);box-shadow:0 4px 10px rgba(28,26,23,.14),0 20px 44px rgba(28,26,23,.2)}",
    ".pill .cnt{font-family:'Spline Sans Mono',monospace;font-size:11px;background:#F2F0EA;border-radius:99px;padding:2px 8px}",
    ".pill .cnt.hot{background:#E2472B;color:#fff}",
    ".dot{width:17px;height:17px;border-radius:52% 46% 52% 48%;background:#E2472B;position:relative;flex:none}",
    ".dot::after{content:'';position:absolute;inset:5px;border-radius:inherit;background:#fff}",

    /* pins */
    ".pin{position:absolute;width:29px;height:29px;margin:-15px 0 0 -15px;z-index:10;border-radius:52% 48% 50% 50%/48% 52% 48% 52%;background:#E2472B;color:#fff;font-family:'Spline Sans Mono',monospace;font-weight:600;font-size:12.5px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 0 rgba(0,0,0,.18),0 6px 14px rgba(226,71,43,.35);transform:rotate(-4deg);transition:transform .12s}",
    ".pin.even{transform:rotate(5deg)}",
    ".pin:hover,.pin.active{transform:rotate(0) scale(1.18);z-index:12}",
    ".pin.resolved{background:#fff;color:#2E7D4F;border:2px solid #2E7D4F;box-shadow:0 2px 8px rgba(28,26,23,.2)}",
    ".pin.ghost{background:#fff;color:#E2472B;border:2px dashed #E2472B;box-shadow:none;animation:pulse 1.2s ease-in-out infinite}",
    ".pin.pop{animation:pop .3s cubic-bezier(.34,1.56,.64,1)}",
    "@keyframes pop{from{transform:scale(.3) rotate(-4deg)}to{transform:scale(1) rotate(-4deg)}}",
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}",

    /* drawer */
    ".drawer{position:fixed;top:0;right:0;bottom:0;width:360px;max-width:100vw;z-index:25;background:#fff;border-left:1px solid #E3DFD6;box-shadow:-2px 0 6px rgba(28,26,23,.06),-24px 0 60px rgba(28,26,23,.14);display:flex;flex-direction:column;transform:translateX(100%);transition:transform .22s cubic-bezier(.2,.8,.2,1);visibility:hidden}",
    ".drawer.open{transform:none;visibility:visible}",
    ".d-head{padding:14px 16px 12px;border-bottom:1px solid #E3DFD6;display:flex;align-items:center;gap:10px}",
    ".d-head .logo{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;letter-spacing:-.01em}",
    ".d-head .count{font-family:'Spline Sans Mono',monospace;font-size:11px;color:#5C574F;flex:1;text-align:right;padding-right:4px}",
    ".d-head .x{font-size:20px;line-height:1;color:#5C574F;padding:2px 8px;border-radius:6px}",
    ".d-head .x:hover{background:#F2F0EA;color:#1C1A17}",
    ".d-tools{padding:10px 12px;border-bottom:1px solid #E3DFD6;display:flex;flex-direction:column;gap:10px;background:#FBFAF7}",
    ".seg{display:flex;background:#F2F0EA;border-radius:9px;padding:3px;gap:2px}",
    ".seg button{flex:1;padding:6px 8px;border-radius:7px;font-size:12.5px;font-weight:600;color:#5C574F;display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}",
    ".seg button:hover{color:#1C1A17}",
    ".seg button[aria-selected=true]{background:#fff;color:#1C1A17;box-shadow:0 1px 2px rgba(28,26,23,.12)}",
    ".seg .c{font-family:'Spline Sans Mono',monospace;font-size:10px;font-weight:500;color:#5C574F;background:#E9E6DF;border-radius:99px;padding:0 6px;min-width:18px;text-align:center}",
    ".seg button[aria-selected=true] .c{background:#F2F0EA}",
    ".btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 13px;border-radius:8px;font-weight:600;font-size:13px;border:1px solid #E3DFD6;background:#fff}",
    ".btn:hover{border-color:#CFC9BD}",
    ".btn.primary{background:#1C1A17;border-color:#1C1A17;color:#FBFAF7}",
    ".btn.primary:hover{background:#000}",
    ".btn.primary[aria-pressed=true]{background:#E2472B;border-color:#E2472B}",
    ".btn.sm{padding:5px 10px;font-size:12px}",
    ".d-notice{padding:10px 16px;font-size:12.5px;background:#FDF0EC;color:#C33517;border-bottom:1px solid #F3D3CB}",
    ".d-list{flex:1;overflow-y:auto;padding:10px}",
    ".d-foot{border-top:1px solid #E3DFD6;padding:10px 12px;display:flex;align-items:center;gap:10px}",
    ".d-foot .page{flex:1;font-size:10.5px;color:#5C574F;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".d-foot kbd{font-family:'Spline Sans Mono',monospace;font-size:10px;color:#5C574F;border:1px solid #E3DFD6;border-bottom-width:2px;border-radius:4px;padding:0 5px}",

    /* composer */
    ".composer{border:1px solid #E2472B;border-radius:12px;padding:12px;margin-bottom:10px;background:#FFF8F6}",
    ".composer .c-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin-bottom:10px}",
    ".composer input,.composer textarea,.replybox input,.replybox textarea{width:100%;border:1px solid #E3DFD6;border-radius:8px;padding:8px 11px;background:#fff;font-size:13.5px}",
    ".composer textarea,.replybox textarea{min-height:72px;resize:vertical;font-size:14px}",
    ".composer input+textarea{margin-top:8px}",
    ".composer input:focus,.composer textarea:focus,.replybox input:focus,.replybox textarea:focus{outline:2px solid #E2472B;outline-offset:0;border-color:transparent}",
    ".row-end{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}",

    /* items */
    ".n{width:23px;height:23px;border-radius:52% 46% 52% 48%;background:#E2472B;color:#fff;font-family:'Spline Sans Mono',monospace;font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;flex:none}",
    ".n.done{background:#fff;color:#2E7D4F;border:1.5px solid #2E7D4F}",
    ".n.ghost{background:#fff;color:#E2472B;border:1.5px dashed #E2472B}",
    ".item{border:1px solid transparent;border-radius:10px;padding:10px 12px;margin-bottom:3px;display:grid;grid-template-columns:25px 1fr;gap:2px 10px;cursor:pointer}",
    ".item:hover{background:#FBFAF7}",
    ".item.active{border-color:#E3DFD6;background:#FBFAF7;cursor:default}",
    ".item .n{margin-top:2px}",
    ".item .body{min-width:0}",
    ".who{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
    ".who time{font-family:'Spline Sans Mono',monospace;font-weight:400;font-size:10px;color:#5C574F}",
    ".tag{font-family:'Spline Sans Mono',monospace;font-weight:500;font-size:9.5px;color:#5C574F;background:#F2F0EA;border-radius:99px;padding:1px 7px;white-space:nowrap}",
    ".tag.you{color:#C33517;background:#FDF0EC}",
    ".txt{font-size:13.5px;overflow-wrap:anywhere;white-space:pre-wrap;margin-top:2px}",
    ".item.resolved .txt{color:#5C574F}",
    ".item.resolved:not(.active) .txt{text-decoration:line-through;text-decoration-color:rgba(46,125,79,.5)}",
    ".meta{font-size:11.5px;color:#5C574F;margin-top:4px}",
    ".meta .ok{color:#2E7D4F;font-weight:600}",
    ".replies{margin-top:10px;border-left:2px solid #E3DFD6;padding-left:10px;display:flex;flex-direction:column;gap:8px}",
    ".reply .who{font-size:12px}",
    ".reply .txt{font-size:13px}",
    ".reply .rdel{margin-left:auto;font-size:11px;color:#5C574F}",
    ".reply .rdel:hover{color:#C33517}",
    ".replybox{margin-top:10px;display:flex;flex-direction:column;gap:6px}",
    ".replybox textarea{min-height:44px}",
    ".replybox .row-end{margin-top:0}",
    ".acts{display:flex;gap:14px;margin-top:10px;padding-top:8px;border-top:1px solid #EEEBE4}",
    ".acts button{font-size:12px;font-weight:600;color:#5C574F}",
    ".acts button:hover{color:#1C1A17}",
    ".acts .rs:hover{color:#2E7D4F}",
    ".acts .dl{margin-left:auto}",
    ".acts .dl:hover{color:#C33517}",
    ".empty{padding:36px 20px;text-align:center;color:#5C574F;font-size:13px;line-height:1.6}",
    ".empty .dpin{width:32px;height:32px;border-radius:52% 48% 50% 50%;background:#E2472B;color:#fff;font-family:'Spline Sans Mono',monospace;font-weight:600;display:flex;align-items:center;justify-content:center;margin:0 auto 10px;transform:rotate(-5deg)}",
    ".empty b{color:#1C1A17}",

    ".toast{position:fixed;bottom:80px;right:20px;background:#1C1A17;color:#FBFAF7;padding:8px 16px;border-radius:99px;font-size:13px;font-weight:500;opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:none;z-index:70}",
    ".toast.show{opacity:1;transform:none}",
    ".drawer.open~.toast{right:380px}",

    ".drawer.open.peek{transform:translateX(calc(100% - 44px))}",
    "@media (max-width:640px){.drawer{width:100vw}.pill{left:50%;right:auto;transform:translateX(-50%)}.drawer.open~.toast{right:20px;bottom:76px}.drawer.open.peek{transform:translateX(100%)}}",
    "@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}"
  ].join("\n");

  root.innerHTML =
    '<style>' + css + '</style>' +
    '<div class="ui">' +
    '  <div class="capture" id="capture"><span class="edge"></span></div>' +
    '  <div class="hint" id="hint" hidden>Click anywhere on the page to place the comment · Esc to cancel</div>' +
    '  <div id="pins"></div>' +
    '  <aside class="drawer" id="drawer" aria-label="VERB-Tack comments">' +
    '    <header class="d-head">' +
    '      <span class="logo"><span class="dot"></span>VERB-Tack</span>' +
    '      <span class="count" id="dCount"></span>' +
    '      <button class="x" id="dClose" aria-label="Hide comments" title="Hide comments (Shift+C)">&times;</button>' +
    '    </header>' +
    '    <div class="d-tools">' +
    '      <div class="seg" role="tablist" aria-label="Filter comments">' +
    '        <button role="tab" data-filter="open">Ongoing <span class="c" id="nOpen">0</span></button>' +
    '        <button role="tab" data-filter="resolved">Resolved <span class="c" id="nResolved">0</span></button>' +
    '        <button role="tab" data-filter="all">All <span class="c" id="nAll">0</span></button>' +
    '      </div>' +
    '      <button class="btn primary" id="newBtn" aria-pressed="false">&#9998; New comment</button>' +
    '    </div>' +
    '    <div class="d-notice" id="dNotice" hidden></div>' +
    '    <div class="d-list" id="dList"></div>' +
    '    <footer class="d-foot">' +
    '      <span class="page mono" id="dPage"></span>' +
    '      <button class="btn sm" id="copyBtn">Copy summary</button>' +
    '    </footer>' +
    '  </aside>' +
    '  <button class="pill" id="pill" aria-expanded="false" title="Show comments (Shift+C)"><span class="dot"></span>VERB-Tack <span class="cnt" id="pillCnt">0</span></button>' +
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
  function setOpen(open) {
    state.open = !!open;
    lsSet(LS.drawer, state.open ? "1" : "0");
    $("#drawer").classList.toggle("open", state.open);
    $("#pill").hidden = state.open;
    $("#pill").setAttribute("aria-expanded", state.open);
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
    $("#newBtn").innerHTML = state.placing ? "&#10005; Cancel placing" : "&#9998; New comment";
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
      else empty.innerHTML = '<div class="dpin">1</div>No comments on this page yet.<br>Press <b>&#9998; New comment</b>, then click anywhere on the page.';
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
          '<button class="rs">' + (c.resolved ? "Reopen" : "&#10004; Resolve") + '</button>' +
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
    var lines = ["# VERB-Tack comments — " + document.title, "URL: " + location.href, ""];
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
    if (!typing && e.shiftKey && (e.key === "C" || e.key === "c") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setOpen(!state.open);
    }
  });

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
  renderAll();
  load(!state.open);
})();
