#!/usr/bin/env node
/* verb-tack CLI
     npx verb-tack init [publishDir]   add the function file, .nvmrc and a generated TACK_ADMIN_KEY in .env (and copy tack.js if a publish dir is given)
     npx verb-tack copy <publishDir>   copy tack.js into a publish directory
*/
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const [cmd, arg] = process.argv.slice(2);

function copyEmbed(dir) {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(pkgRoot, "public", "tack.js"), join(target, "tack.js"));
  console.log(`✓ copied tack.js → ${join(dir, "tack.js")}`);
}

function init(publishDir) {
  const fnDir = resolve("netlify/functions");
  const fnFile = join(fnDir, "tack.mjs");
  mkdirSync(fnDir, { recursive: true });
  if (existsSync(fnFile)) {
    console.log(`• ${fnFile} already exists, left as is`);
  } else {
    writeFileSync(fnFile, readFileSync(join(pkgRoot, "templates", "tack.mjs")));
    console.log("✓ wrote netlify/functions/tack.mjs");
  }

  const nvmrc = resolve(".nvmrc");
  if (!existsSync(nvmrc)) {
    writeFileSync(nvmrc, "22\n");
    console.log("✓ wrote .nvmrc (Node 22, required by @netlify/blobs)");
  }

  const toml = resolve("netlify.toml");
  if (!existsSync(toml)) {
    writeFileSync(toml, `[build]\n  publish = "${publishDir || "."}"\n\n[functions]\n  directory = "netlify/functions"\n  node_bundler = "esbuild"\n`);
    console.log("✓ wrote netlify.toml");
  } else {
    const txt = readFileSync(toml, "utf8");
    if (!/\[functions\]/.test(txt)) {
      console.log("• netlify.toml exists but has no [functions] block. Add:\n\n  [functions]\n    directory = \"netlify/functions\"\n    node_bundler = \"esbuild\"\n");
    } else {
      console.log("• netlify.toml already has a [functions] block");
    }
  }

  if (publishDir) copyEmbed(publishDir);

  const key = adminKey();

  console.log(`
Next steps
  1. Add to your pages:
       <script src="${publishDir ? "/tack.js" : "https://verb-tack.netlify.app/tack.js"}" defer></script>
  2. In Netlify → Site configuration → Environment variables, add
       TACK_ADMIN_KEY = ${key}
     (also saved in .env for netlify dev; .env is git-ignored)
  3. Deploy. Open the site and press C.
`);
}

/* Generate the admin key once, keep it in .env (git-ignored), reuse on re-runs. */
function adminKey() {
  const envFile = resolve(".env");
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8").match(/^TACK_ADMIN_KEY=(.+)$/m) : null;
  if (existing) return existing[1].trim();
  const key = randomBytes(30).toString("base64url");
  appendFileSync(envFile, `${existsSync(envFile) && !readFileSync(envFile, "utf8").endsWith("\n") ? "\n" : ""}TACK_ADMIN_KEY=${key}\n`);
  console.log("✓ generated TACK_ADMIN_KEY and saved it to .env");
  const gi = resolve(".gitignore");
  const lines = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^\.env$/m.test(lines)) {
    appendFileSync(gi, `${lines && !lines.endsWith("\n") ? "\n" : ""}.env\n`);
    console.log("✓ added .env to .gitignore");
  }
  return key;
}

switch (cmd) {
  case "init": init(arg); break;
  case "copy":
    if (!arg) { console.error("usage: verb-tack copy <publishDir>"); process.exit(1); }
    copyEmbed(arg); break;
  default:
    console.log("usage:\n  verb-tack init [publishDir]\n  verb-tack copy <publishDir>");
    process.exit(cmd ? 1 : 0);
}
