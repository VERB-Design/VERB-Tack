import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
globalThis.Netlify = { env: { get: (k) => process.env[k] } };
