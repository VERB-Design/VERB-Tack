/* In-memory stand-in for @netlify/blobs, used only by the test suite. */
const stores = new Map();

export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async get(key, { type } = {}) {
      if (!m.has(key)) return null;
      const raw = m.get(key);
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) { m.set(key, JSON.stringify(value)); },
    async set(key, value) { m.set(key, String(value)); },
    async delete(key) { m.delete(key); },
    async list({ prefix = "" } = {}) {
      const blobs = [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: "x" }));
      return { blobs, directories: [] };
    },
  };
}

export function __reset() { stores.clear(); }
