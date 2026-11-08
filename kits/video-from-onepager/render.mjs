import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [,, sceneFile, outDir, fpsArg, onlyArg] = process.argv;
const fps = Number(fpsArg || 30);
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
import { existsSync, readFileSync } from 'node:fs';
if (existsSync('timings.json')) {
  const timing = JSON.parse(readFileSync('timings.json', 'utf8'));
  await page.evaluateOnNewDocument(t => { window.__TIMING = t; }, timing);
}
await page.goto(pathToFileURL(path.resolve(sceneFile)).href, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
const total = await page.evaluate(() => window.TOTAL);
const n = Math.ceil(total * fps);
const times = onlyArg ? onlyArg.split(',').map(Number) : null;
const frames = times ? times.map(t => [Math.round(t * fps), t]) : Array.from({ length: n }, (_, i) => [i, i / fps]);
for (const [i, t] of frames) {
  await page.evaluate(tt => window.render(tt), t);
  await page.screenshot({ path: path.join(outDir, `f${String(i).padStart(5, '0')}.png`) });
}
await browser.close();
console.log(`rendered ${frames.length} frames`);
