/* Zero-dependency local runner: serves ./public and routes /api/tack/*
   to the real function with an in-memory Blobs store. Comments vanish
   when the process exits. For persistent local Blobs use `netlify dev`.

     node --import ./test/register.mjs test/dev-server.mjs   → http://localhost:8787/demo.html
*/
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

process.env.TACK_ADMIN_KEY ||= "dev-admin";
const { default: handler } = await import("../netlify/functions/tack.mjs");

const PORT = Number(process.env.PORT || 8787);
const ROOT = new URL("../public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/tack")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const fetchReq = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const out = await handler(fetchReq, { ip: req.socket.remoteAddress });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(out.status === 204 ? undefined : Buffer.from(await out.arrayBuffer()));
    return;
  }
  let p = normalize(decodeURIComponent(url.pathname));
  if (p.endsWith("/")) p += "index.html";
  const file = join(ROOT, p);
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, () => console.log(`VERB-Tack dev server → http://localhost:${PORT}/demo.html`));
