/* Browser tests for the Tack embed, driven through the system Chrome.

     npm install --no-save playwright-core
     npm run test:browser              all suites
     npm run test:browser -- site      one suite (core | site | screens | resilience)

   Each suite gets its own mock server with empty storage, so counts are exact. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const shots = resolve(here, "shots");
mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (label, pass, detail) => {
  console.log(`  ${pass ? "✔" : "✖"} ${label}${detail === undefined ? "" : "  → " + detail}`);
  if (!pass) failures++;
};

function serve(port) {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, ["--import", "./test/register.mjs", "test/dev-server.mjs"], {
      cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (d) => { if (String(d).includes("dev server")) ok(child); });
    child.on("error", fail);
    setTimeout(() => fail(new Error("server did not start")), 8000);
  });
}

async function withPage(port, fn, viewport = { width: 1280, height: 800 }) {
  const server = await serve(port);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await fn({ page, ctx, base: `http://localhost:${port}`, $: (s) => page.locator("#tack-widget").locator(s) });
    check("no script errors on the page", errors.length === 0, errors.join(" | ") || undefined);
  } finally {
    await browser.close();
    server.kill();
  }
}

const drawerOpen = ($) => $("#drawer").evaluate((e) => e.classList.contains("open"));

async function post({ page, $ }, text, selector, { name, dx = 20, dy = 12 } = {}) {
  await $("#newBtn").click();
  const box = await page.locator(selector).first().boundingBox();
  await page.mouse.click(box.x + dx, box.y + dy);
  await page.waitForTimeout(200);
  if (name) await $("#cName").fill(name);
  await $("#cText").fill(text);
  await $("#cSave").click();
  await page.waitForTimeout(500);
}

/* ------------------------------------------------------------------ core */
async function core() {
  console.log("\ncore: open, place, reply, resolve, filter, dock, delete, phone");
  await withPage(8801, async (t) => {
    const { page, $, base } = t;
    await page.goto(base + "/demo.html", { waitUntil: "networkidle" });
    check("starts closed with the pill showing", (await $("#pill").isVisible()) && !(await drawerOpen($)));
    check("pill reads Tack | C", /Tack\s*C\s*0/.test((await $("#pill").textContent()).replace(/\s+/g, " ")));

    const navBefore = (await page.locator("nav").boundingBox()).width;
    await page.keyboard.press("c"); await page.waitForTimeout(400);
    check("C opens the drawer", await drawerOpen($));
    check("drawer docks and pushes the page 360px", navBefore - (await page.locator("nav").boundingBox()).width === 360);

    // typing C in any input must not toggle
    await page.evaluate(() => { const i = document.createElement("input"); i.id = "pageInput"; document.body.prepend(i); i.focus(); });
    await page.keyboard.press("c");
    check("C in a page input types, drawer stays open", (await drawerOpen($)) && (await page.locator("#pageInput").inputValue()) === "c");
    await page.evaluate(() => document.getElementById("pageInput").remove());

    await post(t, "Headline wraps badly", ".hero h1", { name: "Michael" });
    // content that used to sit behind the drawer is reachable
    await post(t, "Book should be a button", "nav div a:last-child", { dx: 8, dy: 6 });
    check("two pins, two rows", (await $(".pin").count()) === 2 && (await $(".item").count()) === 2);
    const bookBox = await page.locator("nav a").last().boundingBox();
    const pin2 = await $('.pin >> text="2"').boundingBox();
    check("pin 2 sits on the far-right nav link", pin2.x + 14 > bookBox.x && pin2.x + 14 < bookBox.x + bookBox.width);

    // digits are centred in their circles (text box vs circle, within half a pixel horizontally)
    const off = await $("#pins").evaluate((box) => [...box.querySelectorAll(".pin")].map((el) => {
      const r = el.getBoundingClientRect(), g = document.createRange(); g.selectNodeContents(el);
      const x = g.getBoundingClientRect(); return Math.abs((x.left + x.width / 2) - (r.left + r.width / 2));
    }));
    check("pin digits horizontally centred", off.every((d) => d < 0.6), off.join(", "));

    // placing on top of an existing pin still lands
    await post(t, "On top of pin 1", ".hero h1");
    check("can place a comment over an existing pin", (await $(".item").count()) === 3);

    await $(".item").first().click(); await page.waitForTimeout(200);
    await $(".rText").fill("Fixed in v2"); await $(".rSend").click(); await page.waitForTimeout(500);
    check("reply posted", (await $(".reply").count()) === 1);
    const cells = await $(".acts button").evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width); }));
    check("Resolve, Copy link, Delete share the row evenly", cells.length === 3 && Math.max(...cells) - Math.min(...cells) <= 1, cells.join(" / "));
    await $(".rs").click(); await page.waitForTimeout(500);

    check("Ongoing hides the resolved one", (await $(".item").count()) === 2 && (await $(".pin").count()) === 2);
    await $('[data-filter="resolved"]').click(); await page.waitForTimeout(200);
    check("Resolved shows only it", (await $(".item").count()) === 1 && (await $(".pin.resolved").count()) === 1);
    await $('[data-filter="all"]').click(); await page.waitForTimeout(200);
    check("All shows three", (await $(".item").count()) === 3);

    await $("#dClose").click(); await page.waitForTimeout(400);
    check("closing hides pins and restores the page width", (await $(".pin").count()) === 0 && (await page.locator("nav").boundingBox()).width === navBefore);
    check("pill counts ongoing only", (await $("#pillCnt").textContent()) === "2");

    await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(400);
    await page.keyboard.press("c"); await page.waitForTimeout(500);
    check("comments and filter survive a reload", (await $(".item").count()) === 3 && (await $('.seg.filter [aria-selected="true"]').getAttribute("data-filter")) === "all");

    page.once("dialog", (d) => d.accept());
    await $(".item").nth(1).click(); await page.waitForTimeout(200);
    await $(".dl").click(); await page.waitForTimeout(500);
    check("author can delete their comment", (await $(".item").count()) === 2);

    // phone width: pin follows its element, drawer overlays and slides away while placing
    await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(500);
    check("phone: page is not pushed", (await page.evaluate(() => document.documentElement.style.marginRight)) === "");
    const h1 = await page.locator(".hero h1").boundingBox();
    const pin = await $(".pin").first().boundingBox();
    check("phone: pin stays inside its reflowed element", pin.x + 14 > h1.x - 4 && pin.x + 14 < h1.x + h1.width + 4 && pin.y + 14 > h1.y - 4 && pin.y + 14 < h1.y + h1.height + 4);
    await $("#newBtn").click(); await page.waitForTimeout(300);
    check("phone: drawer slides away while placing", await $("#drawer").evaluate((e) => e.classList.contains("peek")));
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
    check("Escape cancels placing", !(await $("#capture").evaluate((e) => e.classList.contains("on"))));
  });
}

/* ------------------------------------------------------------------ site */
async function site() {
  console.log("\nsite: all pages list, click-through, deep links, single-page apps");
  await withPage(8802, async (t) => {
    const { page, ctx, $, base } = t;
    await page.goto(base + "/demo.html", { waitUntil: "networkidle" });
    await page.keyboard.press("c"); await page.waitForTimeout(400);
    await post(t, "Home: tighten the headline", ".hero h1", { name: "Michael" });
    await page.goto(base + "/demo-rooms.html", { waitUntil: "networkidle" }); await page.waitForTimeout(500);
    check("drawer stays open across pages", await drawerOpen($));
    await post(t, "Rooms: button label is vague", ".hero button");
    await post(t, "Rooms: card copy too long", ".card h3");
    await $(".item").nth(1).click(); await page.waitForTimeout(200);
    await $(".rs").click(); await page.waitForTimeout(700);

    await $('[data-scope="site"]').click(); await page.waitForTimeout(800);
    const groups = await $(".grp .gp").allTextContents();
    check("groups list this page first", JSON.stringify(groups) === JSON.stringify(["/demo-rooms.html", "/demo.html"]), groups.join(", "));
    check("All pages tab shows the site's ongoing count", (await $("#nSite").textContent()) === "2");
    check("header counts describe the whole site", /2 ongoing · 3 total/.test(await $("#dCount").textContent()));
    check("pill still counts this page only", (await $("#pillCnt").textContent()) === "1");
    check("Ongoing filter applies across pages", (await $(".item").count()) === 2);
    check("pins stay this page's only", (await $(".pin").count()) === 1);
    await $('[data-filter="all"]').click(); await page.waitForTimeout(300);
    check("All filter shows every comment", (await $(".item").count()) === 3);
    check("other-page rows offer Go to page", (await $(".item.remote .go").count()) === 1);
    check("other page shows its title", /homepage concept/.test(await $(".grp .gt").last().textContent()));
    await page.screenshot({ path: resolve(shots, "all-pages.png") });

    // a row on this page behaves as usual, in place
    await $(".item:not(.remote)").first().click(); await page.waitForTimeout(300);
    check("this-page rows still expand in place", (await $(".item.active").count()) === 1 && new URL(page.url()).pathname === "/demo-rooms.html");

    const remoteId = await $(".item.remote").first().getAttribute("data-id");
    await $(".item.remote").first().click();
    await page.waitForURL(/\/demo\.html/, { timeout: 10000 }); await page.waitForTimeout(1500);
    check("clicking goes to the comment's page", new URL(page.url()).pathname === "/demo.html");
    check("the address bar is left clean", !page.url().includes("tack="));
    check("drawer opens on This page", (await drawerOpen($)) && (await $('.seg.scope [aria-selected="true"]').getAttribute("data-scope")) === "page");
    check("that comment is expanded", (await $(".item.active").getAttribute("data-id")) === remoteId);
    check("its pin is highlighted", (await $(".pin.active").getAttribute("data-id")) === remoteId);
    await page.screenshot({ path: resolve(shots, "arrived.png") });

    // shareable link, to a resolved comment, while the filter says Ongoing
    await $('[data-filter="open"]').click(); await page.waitForTimeout(200);
    const all = await (await page.request.get(base + "/api/tack/comments?scope=site")).json();
    const done = all.find((c) => c.resolved);
    const p2 = await ctx.newPage(); const $2 = (s) => p2.locator("#tack-widget").locator(s);
    await p2.goto(`${base}${done.path}#tack=${done.id}`, { waitUntil: "networkidle" }); await p2.waitForTimeout(1500);
    check("a shared link opens a resolved comment", (await $2(".item.active").getAttribute("data-id")) === done.id);
    check("and switches the filter so it can be seen", (await $2('.seg.filter [aria-selected="true"]').getAttribute("data-filter")) === "all");
    await p2.close();

    const p3 = await ctx.newPage(); const $3 = (s) => p3.locator("#tack-widget").locator(s);
    await p3.goto(base + "/demo.html#tack=c_gone", { waitUntil: "networkidle" }); await p3.waitForTimeout(1000);
    check("a stale link says so", /no longer on this page/.test(await $3("#toast").textContent()));
    await p3.close();

    // a site still on the 1.0 function
    const p4 = await ctx.newPage(); const $4 = (s) => p4.locator("#tack-widget").locator(s);
    await p4.route("**/api/tack/comments?scope=site", (r) => r.fulfill({ status: 400, contentType: "application/json", body: '{"error":"page is required"}' }));
    await p4.goto(base + "/demo.html", { waitUntil: "networkidle" }); await p4.waitForTimeout(800);
    await $4('[data-scope="site"]').click(); await p4.waitForTimeout(800);
    check("older function: All pages explains what to do", /older Tack function/.test(await $4(".empty").textContent()));
    await $4('[data-scope="page"]').click(); await p4.waitForTimeout(300);
    check("older function: This page is unaffected", (await $4(".item").count()) >= 1);
    await p4.close();

    await $('[data-scope="site"]').click(); await page.waitForTimeout(500);
    await $("#newBtn").click(); await page.waitForTimeout(200);
    check("New comment returns to This page", (await $('.seg.scope [aria-selected="true"]').getAttribute("data-scope")) === "page");
    await page.keyboard.press("Escape");

    // single-page apps: route changes re-key, and All pages knows where it is
    await page.evaluate(() => history.pushState({}, "", "/app/library")); await page.waitForTimeout(700);
    check("route change re-keys the drawer", (await $("#dPage").textContent()) === "/app/library" && (await $(".item").count()) === 0);
    await $('[data-scope="site"]').click(); await page.waitForTimeout(600);
    check("All pages still lists the site from a new route", (await $(".item").count()) >= 2 && (await $(".grp.here").count()) === 0);
    await page.goBack(); await page.waitForTimeout(700);
    check("back restores the previous page as This page", (await $(".grp.here .gp").textContent()) === "/demo.html");
  });
}

/* ------------------------------------------------------------ resilience */
async function resilience() {
  console.log("\nresilience: dropped, blocked and slow connections");
  await withPage(8803, async ({ page, $, base }) => {
    let dropped = 0;
    await page.route("**/api/tack/comments?page=**", (r) => (dropped++ === 0 ? r.abort("connectionreset") : r.continue()));
    await page.goto(base + "/demo.html", { waitUntil: "networkidle" });
    await page.keyboard.press("c"); await page.waitForTimeout(1200);
    check("one dropped call recovers without a notice", await $("#dNotice").evaluate((e) => e.hidden));

    await page.unroute("**/api/tack/comments?page=**");
    let blocked = true;
    await page.route("**/api/tack/**", (r) => (blocked ? r.abort("connectionreset") : r.continue()));
    await page.keyboard.press("c"); await page.waitForTimeout(200);
    await page.keyboard.press("c"); await page.waitForTimeout(1500);
    check("a blocked server shows a notice with Retry", /Could not reach the Tack server/.test(await $("#dNotice").textContent()) && (await $("#retryBtn").count()) === 1);
    blocked = false;
    await $("#retryBtn").click(); await page.waitForTimeout(1200);
    check("Retry clears it", await $("#dNotice").evaluate((e) => e.hidden));

    await page.unroute("**/api/tack/**");
    let slow = 0;
    await page.route("**/api/tack/comments?page=**", async (r) => { if (slow++ === 0) await new Promise((d) => setTimeout(d, 13000)); return r.continue().catch(() => {}); });
    await page.keyboard.press("c"); await page.waitForTimeout(200);
    await page.keyboard.press("c"); await page.waitForTimeout(15000);
    check("a call past the 12s budget recovers on the retry", await $("#dNotice").evaluate((e) => e.hidden));
  });
}

/* --------------------------------------------------------------- screens */
async function screens() {
  console.log("\nscreens: one address, several screens, named by the prototype");
  await withPage(8804, async (t) => {
    const { page, ctx, $, base } = t;
    const title = () => page.locator("#kiosk h1").textContent();
    await page.goto(base + "/demo-kiosk.html", { waitUntil: "networkidle" });
    await page.keyboard.press("c"); await page.waitForTimeout(400);
    check("tab reads This screen", (await $('[data-scope="page"]').textContent()) === "This screen");
    check("footer names the screen", (await $("#dPage").textContent()) === "/demo-kiosk.html › Destination");

    await post(t, "Destination: heading too long", "#kiosk h1", { name: "Michael" });
    check("comment 1 pinned on Destination", (await $(".pin").count()) === 1 && (await $(".item").count()) === 1);

    await page.locator('[data-dest="Lyness"]').click(); await page.waitForTimeout(500);
    check("screen changed with the same address", (await title()) === "One way or return?" && new URL(page.url()).pathname === "/demo-kiosk.html");
    check("the pin did not follow to the new screen", (await $(".pin").count()) === 0);
    check("the list is this screen's only", (await $(".item").count()) === 0 && (await $("#dPage").textContent()).endsWith("› Trip type"));
    check("pill counts this screen only", (await $("#nOpen").textContent()) === "0");

    await post(t, "Trip type: say Round trip", "#kiosk h1");
    check("numbers run across the page's screens", (await $(".item .n").first().textContent()) === "2");

    await $('[data-scope="site"]').click(); await page.waitForTimeout(700);
    const heads = await $(".grp").evaluateAll((g) => g.map((x) => x.querySelector(".gp").textContent + " " + (x.querySelector(".gs") ? x.querySelector(".gs").textContent : "")));
    check("All pages groups by screen, this one first", heads[0] === "/demo-kiosk.html › Trip type" && heads[1] === "/demo-kiosk.html › Destination", heads.join(" | "));
    check("the other screen's row offers Go to screen", /Go to screen/.test(await $(".item.remote .go").textContent()));
    await page.screenshot({ path: resolve(shots, "screens-all.png") });

    const firstId = await $(".item.remote").first().getAttribute("data-id");
    await $(".item.remote").first().click(); await page.waitForTimeout(900);
    check("clicking asks the prototype to switch screens", (await title()) === "Where are you going?");
    check("and opens that comment on its pin", (await $(".item.active").getAttribute("data-id")) === firstId && (await $(".pin.active").getAttribute("data-id")) === firstId);
    await page.screenshot({ path: resolve(shots, "screens-arrived.png") });

    // a shared link to a comment on a later screen
    const all = await (await page.request.get(base + "/api/tack/comments?scope=site")).json();
    const second = all.find((c) => c.screen === "Trip type");
    check("the function stored the screen and the element's fingerprint", !!second && second.anchor.tag === "h1" && second.anchor.txt === "One way or return?");
    const p2 = await ctx.newPage(); const $2 = (s) => p2.locator("#tack-widget").locator(s);
    await p2.goto(`${base}/demo-kiosk.html#tack=${second.id}`, { waitUntil: "networkidle" }); await p2.waitForTimeout(1500);
    check("a shared link takes the prototype to the right screen", (await p2.locator("#kiosk h1").textContent()) === "One way or return?" && (await $2(".item.active").getAttribute("data-id")) === second.id);
    await p2.close();

    // a prototype that will not jump: say where it is, then open it when the reviewer gets there
    const p3 = await ctx.newPage(); const $3 = (s) => p3.locator("#tack-widget").locator(s);
    await p3.goto(`${base}/demo-kiosk.html?guard=1#tack=${second.id}`, { waitUntil: "networkidle" }); await p3.waitForTimeout(1200);
    check("guarded prototype stays put", (await p3.locator("#kiosk h1").textContent()) === "Where are you going?");
    check("Tack says which screen the comment is on", /Comment 2 is on the “Trip type” screen/.test(await $3("#toast").textContent()), await $3("#toast").textContent());
    await p3.locator('[data-dest="Flotta"]').click(); await p3.waitForTimeout(900);
    check("and opens it once the reviewer reaches that screen", (await $3(".item.active").getAttribute("data-id")) === second.id);
    await p3.close();

    // comments made before the prototype named its screens
    await page.request.post(base + "/api/tack/comments", { data: { page: "/demo-kiosk.html", anchor: { sel: "#kiosk>section>header>h1", ox: 0.5, oy: 0.5, px: 0, py: 0 }, author: "Earlier", text: "Made before screens were named" } });
    await $('[data-scope="page"]').click(); await page.waitForTimeout(200);
    await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(600);
    check("an unfiled comment shows on this screen, labelled", (await $(".item").filter({ hasText: "screen not recorded" }).count()) === 1);
    await page.locator('[data-dest="Lyness"]').click(); await page.waitForTimeout(500);
    check("and on the next screen too", (await $(".item").filter({ hasText: "screen not recorded" }).count()) === 1);

    // a site whose function is too old to store the screen
    await page.route("**/api/tack/comments", async (r) => {
      if (r.request().method() !== "POST") return r.continue();
      const res = await r.fetch(); const j = await res.json(); delete j.screen;
      return r.fulfill({ response: res, json: j });
    });
    await post(t, "Posted through an old function", "#kiosk p");
    check("older function: the drawer says comments can't be kept per screen", /older Tack function/.test(await $("#dNotice").textContent()));
  });

  console.log("\nscreens: the same prototype without a name (fingerprint only)");
  await withPage(8805, async (t) => {
    const { page, $, base } = t;
    await page.goto(base + "/demo-kiosk.html?nostate=1", { waitUntil: "networkidle" });
    await page.keyboard.press("c"); await page.waitForTimeout(400);
    check("tab still reads This page", (await $('[data-scope="page"]').textContent()) === "This page");
    await post(t, "Heading on the first screen", "#kiosk h1", { name: "Michael" });
    check("pinned", (await $(".pin").count()) === 1);
    await page.locator('[data-dest="Lyness"]').click(); await page.waitForTimeout(500);
    check("a different heading in the same place: pin hides", (await $(".pin").count()) === 0);
    check("the row stays, marked not on screen", (await $(".item").count()) === 1 && /not on screen/.test(await $(".item").textContent()));
    await page.locator("[data-back]").click(); await page.waitForTimeout(500);
    check("back on the first screen the pin returns", (await $(".pin").count()) === 1);

    // text that changes legitimately must keep its pin
    await page.locator('[data-dest="Lyness"]').click(); await page.locator('[data-trip="Return"]').click(); await page.waitForTimeout(400);
    await post(t, "Total needs a currency note", ".total");
    const before = await page.locator(".total").textContent();
    await page.locator("[data-bike]").click(); await page.waitForTimeout(500);
    check("a total that changes keeps its pin", before !== (await page.locator(".total").textContent()) && (await $(".pin").count()) === 1, before + " → " + (await page.locator(".total").textContent()));
  });
}

const suites = { core, site, screens, resilience };
const pick = process.argv[2];
for (const [name, fn] of Object.entries(suites)) if (!pick || pick === name) await fn();
console.log(failures ? `\n${failures} check(s) failed` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
