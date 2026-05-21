import { _electron as electron } from 'playwright-core';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(__dirname, 'test-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const electronBin = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');

console.log('Launching Electron app...');
const app = await electron.launch({
  executablePath: electronBin,
  args: [__dirname],
  env: { ...process.env, ELECTRON_DEV: 'true' },
  timeout: 30000,
});

// Wait for main window
await new Promise(r => setTimeout(r, 6000));

const windows = app.windows();
console.log(`Windows open: ${windows.length}`);
for (const w of windows) console.log(' ', w.url());

// Find the real app window (not devtools)
let page = windows.find(w => !w.url().includes('devtools') && !w.url().includes('about:blank'));
if (!page) page = await app.firstWindow();

await page.waitForLoadState('domcontentloaded');
await new Promise(r => setTimeout(r, 3000));

// Screenshot of main window
const shot1 = path.join(SHOT_DIR, '01-main-window.png');
await page.screenshot({ path: shot1 });
console.log('Main window screenshot:', shot1);

// Check what project is showing
const titleText = await page.evaluate(() => {
  const el = document.querySelector('[class*="title"], [class*="project"], .window-title, h1');
  return el ? el.textContent : document.title;
}).catch(() => document.title);
console.log('Title/project shown:', titleText);

// Check projectRoot state via console
const projectRoot = await page.evaluate(() => {
  return window.__nebulaDebug?.projectRoot || 'N/A';
}).catch(() => 'N/A');
console.log('projectRoot:', projectRoot);

// Open a new window via keyboard shortcut
console.log('\nOpening new window (Ctrl+Shift+N)...');
await page.keyboard.press('Control+Shift+N');
await new Promise(r => setTimeout(r, 5000));

const windows2 = app.windows().filter(w => !w.url().includes('devtools'));
console.log(`Windows after Ctrl+Shift+N: ${windows2.length}`);

// Find the new window (the one that wasn't there before)
const newWin = windows2.find(w => w !== page);
if (newWin) {
  await newWin.waitForLoadState('domcontentloaded');
  await new Promise(r => setTimeout(r, 4000));

  const shot2 = path.join(SHOT_DIR, '02-new-window.png');
  await newWin.screenshot({ path: shot2 });
  console.log('New window screenshot:', shot2);

  const newProjectRoot = await newWin.evaluate(() => {
    // Try to read from React state via DOM
    const titleEl = document.querySelector('[class*="title-bar"], [class*="window-title"]');
    return titleEl ? titleEl.textContent?.trim() : document.title;
  }).catch(() => 'error');
  console.log('New window title/project:', newProjectRoot);
} else {
  console.log('No new window detected');
}

await app.close();
console.log('\nDone. Check test-shots/ for screenshots.');
