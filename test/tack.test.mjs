import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TACK_ADMIN_KEY = "admin-secret";
process.env.TACK_ORIGINS = "https://other.example";

const { default: handler, normalizePage } = await import("../netlify/functions/tack.mjs");
const { __reset } = await import("@netlify/blobs");

const SITE = "https://proto.netlify.app";
const ctx = { ip: "1.2.3.4" };

function call(method, path, { body, token, admin, origin = SITE, ip } = {}) {
  const headers = { origin };
  if (body) headers["content-type"] = "application/json";
  if (token) headers["x-tack-token"] = token;
  if (admin) headers["x-tack-admin"] = admin;
  const req = new Request(SITE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return handler(req, ip ? { ip } : ctx);
}
async function json(res) { return res.status === 204 ? null : res.json(); }

const anchor = { sel: "body>main>h1", ox: 0.5, oy: 0.5, px: 100, py: 200, vw: 1440 };

test("normalizePage", () => {
  assert.equal(normalizePage("/rooms/index.html"), "/rooms");
  assert.equal(normalizePage("/index.html"), "/");
  assert.equal(normalizePage("/rooms/?x=1#top"), "/rooms");
  assert.equal(normalizePage("https://a.b/c/d/"), "/c/d");
  assert.equal(normalizePage("rooms"), "/rooms");
  assert.equal(normalizePage(""), "");
});

test("health", async () => {
  const res = await call("GET", "/api/tack/health");
  assert.equal(res.status, 200);
  assert.equal((await json(res)).ok, true);
});

test("rejects unknown origins, accepts same-origin and TACK_ORIGINS", async () => {
  assert.equal((await call("GET", "/api/tack/health", { origin: "https://evil.example" })).status, 403);
  const ok = await call("GET", "/api/tack/health", { origin: "https://other.example" });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://other.example");
  const pre = await call("OPTIONS", "/api/tack/comments", { origin: "https://other.example" });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /X-Tack-Token/);
});

test("full comment lifecycle", async () => {
  __reset();
  const page = "/rooms/index.html";

  // empty list
  let res = await call("GET", "/api/tack/comments?page=" + encodeURIComponent(page));
  assert.deepEqual(await json(res), []);

  // validation
  res = await call("POST", "/api/tack/comments", { body: { page, anchor, author: "A" }, token: "tokA" });
  assert.equal(res.status, 400);
  res = await call("POST", "/api/tack/comments", { body: { page, author: "A", text: "x" }, token: "tokA" });
  assert.equal(res.status, 400);
  res = await call("POST", "/api/tack/comments", { body: { anchor, author: "A", text: "x" }, token: "tokA" });
  assert.equal(res.status, 400);

  // create two, numbers increment, page normalized
  res = await call("POST", "/api/tack/comments", { body: { page, anchor, author: "Alice", text: "  Title wraps  " }, token: "tokA" });
  assert.equal(res.status, 201);
  const c1 = await json(res);
  assert.equal(c1.n, 1);
  assert.equal(c1.page, "/rooms");
  assert.equal(c1.text, "Title wraps");
  assert.equal(c1.mine, true);
  assert.equal(c1.canDelete, true);
  assert.equal("ownerHash" in c1, false);

  res = await call("POST", "/api/tack/comments", { body: { page: "/rooms", anchor: { px: 1, py: 2 }, text: "No name" }, token: "tokB" });
  const c2 = await json(res);
  assert.equal(c2.n, 2);
  assert.equal(c2.author, "Guest");
  assert.equal(c2.anchor.sel, undefined);

  // list as B: c1 not mine, c2 mine
  res = await call("GET", "/api/tack/comments?page=/rooms/", { token: "tokB" });
  const list = await json(res);
  assert.equal(list.length, 2);
  assert.equal(list[0].mine, false);
  assert.equal(list[1].mine, true);

  // another page is separate
  res = await call("GET", "/api/tack/comments?page=/dining");
  assert.deepEqual(await json(res), []);

  // reply by anyone, resolve by anyone
  res = await call("PATCH", "/api/tack/comments/" + c1.id, { body: { page, reply: { author: "Bob", text: "Fixed in v3" } }, token: "tokB" });
  assert.equal(res.status, 200);
  let u = await json(res);
  assert.equal(u.replies.length, 1);
  assert.equal(u.replies[0].mine, true);
  assert.equal(u.replies[0].canDelete, true);
  assert.equal("ownerHash" in u.replies[0], false);

  res = await call("PATCH", "/api/tack/comments/" + c1.id, { body: { page, resolved: true, author: "Bob" }, token: "tokB" });
  u = await json(res);
  assert.equal(u.resolved, true);
  assert.equal(u.resolvedBy, "Bob");

  // edit text: not owner → 403, owner → ok
  res = await call("PATCH", "/api/tack/comments/" + c1.id, { body: { page, text: "hacked" }, token: "tokB" });
  assert.equal(res.status, 403);
  res = await call("PATCH", "/api/tack/comments/" + c1.id, { body: { page, text: "Title wraps at tablet" }, token: "tokA" });
  u = await json(res);
  assert.equal(u.text, "Title wraps at tablet");
  assert.ok(u.editedAt);

  // reply delete: A cannot delete B's reply, admin can
  const rid = u.replies[0].id;
  res = await call("PATCH", "/api/tack/comments/" + c1.id, { body: { page, deleteReply: rid }, token: "tokA" });
  assert.equal(res.status, 403);
  res = await call("PATCH", "/api/tack/comments/" + c1.id, { body: { page, deleteReply: rid }, admin: "admin-secret" });
  assert.equal((await json(res)).replies.length, 0);

  // empty patch
  res = await call("PATCH", "/api/tack/comments/" + c1.id, { body: { page }, token: "tokA" });
  assert.equal(res.status, 400);

  // delete: B cannot delete c1; no token cannot; A can; admin can delete c2
  res = await call("DELETE", "/api/tack/comments/" + c1.id + "?page=/rooms", { token: "tokB" });
  assert.equal(res.status, 403);
  res = await call("DELETE", "/api/tack/comments/" + c1.id + "?page=/rooms");
  assert.equal(res.status, 403);
  res = await call("DELETE", "/api/tack/comments/" + c1.id + "?page=/rooms", { token: "tokA" });
  assert.equal(res.status, 204);
  res = await call("DELETE", "/api/tack/comments/" + c2.id + "?page=/rooms", { admin: "admin-secret" });
  assert.equal(res.status, 204);
  res = await call("DELETE", "/api/tack/comments/" + c2.id + "?page=/rooms", { admin: "admin-secret" });
  assert.equal(res.status, 404);

  // numbering continues after deletes
  res = await call("POST", "/api/tack/comments", { body: { page, anchor, author: "Alice", text: "Third" }, token: "tokA" });
  assert.equal((await json(res)).n, 3);
});

test("export requires admin and groups by page", async () => {
  __reset();
  await call("POST", "/api/tack/comments", { body: { page: "/a", anchor, author: "X", text: "one" }, token: "t" });
  await call("POST", "/api/tack/comments", { body: { page: "/b/", anchor, author: "X", text: "two" }, token: "t" });
  await call("POST", "/api/tack/comments", { body: { page: "/a", anchor, author: "X", text: "three" }, token: "t" });
  assert.equal((await call("GET", "/api/tack/export")).status, 403);
  assert.equal((await call("GET", "/api/tack/export", { admin: "wrong" })).status, 403);
  const res = await call("GET", "/api/tack/export", { admin: "admin-secret" });
  assert.equal(res.status, 200);
  const out = await json(res);
  assert.deepEqual(Object.keys(out.pages).sort(), ["/a", "/b"]);
  assert.equal(out.pages["/a"].length, 2);
  assert.equal(out.pages["/a"][1].n, 2);
  assert.equal(out.pages["/a"][0].canDelete, true);
});

test("rate limit blocks the 31st write from one IP", async () => {
  __reset();
  let last;
  for (let i = 0; i < 31; i++) {
    last = await call("POST", "/api/tack/comments", { body: { page: "/rl", anchor, author: "S", text: "spam " + i }, token: "t", ip: "9.9.9.9" });
  }
  assert.equal(last.status, 429);
  const other = await call("POST", "/api/tack/comments", { body: { page: "/rl", anchor, author: "S", text: "ok" }, token: "t", ip: "8.8.8.8" });
  assert.equal(other.status, 201);
});

test("strips control characters and clips length", async () => {
  __reset();
  const long = "x".repeat(2500);
  const res = await call("POST", "/api/tack/comments", { body: { page: "/c", anchor, author: "N\u0007ame".repeat(30), text: "a\u0000b\nc" + long }, token: "t" });
  const c = await json(res);
  assert.equal(c.text.startsWith("ab\nc"), true);
  assert.equal(c.text.length, 2000);
  assert.equal(c.author.length, 60);
  assert.equal(c.author.includes("\u0007"), false);
});

test("unknown route and bad method", async () => {
  assert.equal((await call("GET", "/api/tack/nope")).status, 404);
  assert.equal((await call("PUT", "/api/tack/comments?page=/x")).status, 405);
});

test("routes work behind a rewrite to /.netlify/functions/tack", async () => {
  __reset();
  let res = await call("GET", "/.netlify/functions/tack/health");
  assert.equal(res.status, 200);
  res = await call("POST", "/.netlify/functions/tack/comments", { body: { page: "/app/library", anchor, author: "A", text: "spa" }, token: "t" });
  assert.equal(res.status, 201);
  const c = await json(res);
  res = await call("PATCH", "/.netlify/functions/tack/comments/" + c.id, { body: { page: "/app/library", resolved: true }, token: "t" });
  assert.equal((await json(res)).resolved, true);
  res = await call("GET", "/api/tack/comments?page=/app/library");
  assert.equal((await json(res)).length, 1);
});
