// Regenerates the README screenshots in docs/screenshots from the real UI.
// Needs the dev server running:  npx tsx tools/screenshots.mts
import { mkdirSync } from "node:fs";
import { chromium, Page } from "playwright-core";

const URL = process.env.URL || "http://localhost:5173";
const ROM = process.env.ROM || "testroms/celeste-classic.gba";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });

async function tap(p: Page, key: string, ms = 90): Promise<void> {
  await p.keyboard.down(key);
  await p.waitForTimeout(ms);
  await p.keyboard.up(key);
}

/** The cartridge, console and control deck, with a little breathing room. */
async function shootConsole(name: string): Promise<void> {
  const top = await page.locator(".slot-area").boundingBox();
  const shell = await page.locator(".console").boundingBox();
  const deck = await page.locator(".deck").boundingBox();
  if (!top || !shell || !deck) throw new Error("layout not found");
  const pad = 36;
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: shell.x - pad, y: top.y - pad,
      width: shell.width + pad * 2, height: deck.y + deck.height - top.y + pad + 16,
    },
  });
}

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
await page.locator("#romInput").setInputFiles(ROM);
await page.waitForTimeout(5200);           // title screen
await page.locator("#toast").evaluate((t) => { (t as HTMLElement).hidden = true; });
await shootConsole("title");

await tap(page, "Enter");                  // start the game
await page.waitForTimeout(4200);
await page.keyboard.press("F1");           // quick state on the first screen
await page.waitForTimeout(400);

// Play a little so the states show different moments.
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(500);
await tap(page, "KeyX", 250);
await page.waitForTimeout(350);
await page.keyboard.up("ArrowRight");
await page.locator(".slot-row").nth(1).locator("button", { hasText: "SAVE" }).click();
await page.waitForTimeout(3000);           // let the toast clear
await shootConsole("console");

await page.locator(".panels").screenshot({ path: `${OUT}/panels.png` });

await browser.close();
console.log("wrote", OUT);
