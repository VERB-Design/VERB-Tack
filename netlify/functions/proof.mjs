/* ============================================================
   Proof API · Verb Interactive
   Netlify Function (v2) backing the Proof comments overlay.
   Storage: Netlify Blobs, store "proof", one blob per comment.

   Routes (all under /api/proof):
     GET    /comments?page=/path          list comments for a page
     POST   /comments                     create a comment
     PATCH  /comments/:id                 reply · resolve/reopen · edit text
     DELETE /comments/:id?page=/path      owner token or admin key
     GET    /export                       admin key → every comment on the site
     GET    /health                       { ok: true }

   Environment:
     PROOF_ADMIN_KEY   required for DELETE (non-owner) and /export
     PROOF_ORIGINS     optional, comma-separated extra origins allowed to
                       call this API (only needed when the embed runs on a
                       different site than the function)
============================================================ */

import { getStore } from "@netlify/blobs";

export const VERSION = "1.0.0";

export const config = { path: "/api/proof/*" };

const MAX_TEXT = 2000;
const MAX_NAME = 60;
const WRITE_LIMIT = 30;                 // writes per IP …
const WRITE_WINDOW = 10 * 60 * 1000;    // … per 10 minutes
const hits = new Map();

/* ---------- entry ---------- */
export default async function handler(req, context) {
  const url = new URL(req.url);
  const origin = req.headers.get("origin") || "";
  const allowed = originAllowed(origin, url);

  if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), allowed);
  if (origin && !allowed) return json({ error: "Origin not allowed" }, 403);

  const parts = url.pathname.replace(/^\/api\/proof\/?/, "").split("/").filter(Boolean);
  const [resource, id] = parts;
  const admin = isAdmin(req);

  try {
    let res;
    if (resource === "comments") res = await comments(req, url, id, admin, context);
    else if (resource === "export" && req.method === "GET") res = admin ? await exportAll() : json({ error: "Admin key required" }, 403);
    else if (resource === "health") res = json({ ok: true, version: VERSION });
    else res = json({ error: "Not found" }, 404);
    return cors(res, allowed);
  } catch (err) {
    console.error("[proof]", err);
    return cors(json({ error: "Server error" }, 500), allowed);
  }
}

/* ---------- /comments ---------- */
async function comments(req, url, id, admin, context) {
  const store = getStore({ name: "proof", consistency: "strong" });
  const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
  const page = normalizePage(url.searchParams.get("page") ?? body.page);
  if (!page) return json({ error: "page is required" }, 400);

  const pk = await pageKey(page);
  const prefix = `c/${pk}/`;
  const token = req.headers.get("x-proof-token") || body.token || "";
  const tokenHash = token ? await sha256(token) : "";

  /* list */
  if (req.method === "GET" && !id) {
    const items = await readAll(store, prefix);
    return json(items.sort((a, b) => a.n - b.n).map((c) => publicView(c, tokenHash, admin)));
  }

  /* create */
  if (req.method === "POST" && !id) {
    const limited = rateLimit(context, req);
    if (limited) return limited;
    const text = clean(body.text, MAX_TEXT);
    if (!text) return json({ error: "text is required" }, 400);
    const anchor = cleanAnchor(body.anchor);
    if (!anchor) return json({ error: "anchor is required" }, 400);

    const counterKey = `n/${pk}`;
    const n = ((await store.get(counterKey, { type: "json" })) || 0) + 1;
    await store.setJSON(counterKey, n);

    const c = {
      id: "c_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10),
      n,
      page,
      anchor,
      author: clean(body.author, MAX_NAME) || "Guest",
      text,
      replies: [],
      resolved: false,
      createdAt: new Date().toISOString(),
      ownerHash: tokenHash,
    };
    await store.setJSON(prefix + c.id, c);
    return json(publicView(c, tokenHash, admin), 201);
  }

  if (!id) return json({ error: "Method not allowed" }, 405);

  const key = prefix + id;
  const c = await store.get(key, { type: "json" });
  if (!c) return json({ error: "Not found" }, 404);
  const owner = admin || (tokenHash && c.ownerHash === tokenHash);

  /* update */
  if (req.method === "PATCH") {
    let changed = false;

    if (typeof body.resolved === "boolean") {
      c.resolved = body.resolved;
      c.resolvedAt = body.resolved ? new Date().toISOString() : null;
      c.resolvedBy = body.resolved ? clean(body.author, MAX_NAME) || "Guest" : null;
      changed = true;
    }
    if (body.reply) {
      const limited = rateLimit(context, req);
      if (limited) return limited;
      const rt = clean(body.reply.text, MAX_TEXT);
      if (!rt) return json({ error: "reply.text is required" }, 400);
      c.replies.push({
        id: "r_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8),
        author: clean(body.reply.author, MAX_NAME) || "Guest",
        text: rt,
        at: new Date().toISOString(),
        ownerHash: tokenHash,
      });
      changed = true;
    }
    if (typeof body.text === "string") {
      if (!owner) return json({ error: "Only the author can edit this comment" }, 403);
      const t = clean(body.text, MAX_TEXT);
      if (!t) return json({ error: "text cannot be empty" }, 400);
      c.text = t;
      c.editedAt = new Date().toISOString();
      changed = true;
    }
    if (body.deleteReply) {
      const i = c.replies.findIndex((r) => r.id === body.deleteReply);
      if (i === -1) return json({ error: "Reply not found" }, 404);
      const canDelete = admin || (tokenHash && c.replies[i].ownerHash === tokenHash);
      if (!canDelete) return json({ error: "Only the author can delete this reply" }, 403);
      c.replies.splice(i, 1);
      changed = true;
    }
    if (!changed) return json({ error: "Nothing to update" }, 400);

    await store.setJSON(key, c);
    return json(publicView(c, tokenHash, admin));
  }

  /* delete */
  if (req.method === "DELETE") {
    if (!owner) return json({ error: "Only the author can delete this comment" }, 403);
    await store.delete(key);
    return new Response(null, { status: 204 });
  }

  return json({ error: "Method not allowed" }, 405);
}

/* ---------- /export ---------- */
async function exportAll() {
  const store = getStore({ name: "proof", consistency: "strong" });
  const items = await readAll(store, "c/");
  const byPage = {};
  for (const c of items) (byPage[c.page] ||= []).push(publicView(c, "", true));
  for (const p in byPage) byPage[p].sort((a, b) => a.n - b.n);
  return json({ exportedAt: new Date().toISOString(), version: VERSION, pages: byPage });
}

/* ---------- helpers ---------- */
async function readAll(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

function publicView(c, tokenHash, admin) {
  const { ownerHash, replies, ...rest } = c;
  return {
    ...rest,
    mine: !!(tokenHash && ownerHash === tokenHash),
    canDelete: !!(admin || (tokenHash && ownerHash === tokenHash)),
    replies: (replies || []).map(({ ownerHash: rh, ...r }) => ({
      ...r,
      mine: !!(tokenHash && rh === tokenHash),
      canDelete: !!(admin || (tokenHash && rh === tokenHash)),
    })),
  };
}

export function normalizePage(p) {
  if (typeof p !== "string" || !p) return "";
  let s = p.trim();
  try { if (/^https?:\/\//i.test(s)) s = new URL(s).pathname; } catch { /* keep as is */ }
  s = s.split(/[?#]/)[0];
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/index\.html?$/i, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s.slice(0, 500);
}

async function pageKey(page) {
  return (await sha256(page)).slice(0, 20);
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(v, max) {
  if (typeof v !== "string") return "";
  // strip control characters except newline and tab, collapse trailing space
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
}

function cleanAnchor(a) {
  if (!a || typeof a !== "object") return null;
  const num = (x) => (typeof x === "number" && isFinite(x) ? Math.round(x * 10000) / 10000 : 0);
  const out = { px: num(a.px), py: num(a.py), vw: num(a.vw) };
  if (typeof a.sel === "string" && a.sel.length <= 600) {
    out.sel = a.sel;
    out.ox = num(a.ox);
    out.oy = num(a.oy);
  }
  return out;
}

async function readJson(req) {
  try { return (await req.json()) || {}; } catch { return {}; }
}

function isAdmin(req) {
  const key = Netlify.env.get("PROOF_ADMIN_KEY");
  const given = req.headers.get("x-proof-admin");
  return !!(key && given && given === key);
}

function originAllowed(origin, url) {
  if (!origin) return null;                   // same-origin GET, curl, etc.
  if (origin === url.origin) return origin;
  const extra = (Netlify.env.get("PROOF_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

function cors(res, origin) {
  if (!origin) return res;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Proof-Token, X-Proof-Admin");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

function rateLimit(context, req) {
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WRITE_WINDOW);
  if (list.length >= WRITE_LIMIT) {
    return json({ error: "Too many comments in a short time. Try again in a few minutes." }, 429);
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();   // keep the in-memory map bounded
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
