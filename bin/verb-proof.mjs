#!/usr/bin/env node
/* verb-proof CLI
     npx verb-proof init [publishDir]   add the function file (and copy proof.js if a publish dir is given)
     npx verb-proof copy <publishDir>   copy proof.js into a publish directory
*/
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const [cmd, arg] = process.argv.slice(2);

function copyEmbed(dir) {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  copyFileSync(join(pkgRoot, "public", "proof.js"), join(target, "proof.js"));
  console.log(`✓ copied proof.js → ${join(dir, "proof.js")}`);
}

function init(publishDir) {
  const fnDir = resolve("netlify/functions");
  const fnFile = join(fnDir, "proof.mjs");
  mkdirSync(fnDir, { recursive: true });
  if (existsSync(fnFile)) {
    console.log(`• ${fnFile} already exists, left as is`);
  } else {
    writeFileSync(fnFile, readFileSync(join(pkgRoot, "templates", "proof.mjs")));
    console.log("✓ wrote netlify/functions/proof.mjs");
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

  console.log(`
Next steps
  1. Add to your pages:
       <script src="${publishDir ? "/proof.js" : "https://verb-proof.netlify.app/proof.js"}" defer></script>
  2. In Netlify → Site configuration → Environment variables, add
       PROOF_ADMIN_KEY = <a long random string>
  3. Deploy. Open the site and press Shift+C.
`);
}

switch (cmd) {
  case "init": init(arg); break;
  case "copy":
    if (!arg) { console.error("usage: verb-proof copy <publishDir>"); process.exit(1); }
    copyEmbed(arg); break;
  default:
    console.log("usage:\n  verb-proof init [publishDir]\n  verb-proof copy <publishDir>");
    process.exit(cmd ? 1 : 0);
}
