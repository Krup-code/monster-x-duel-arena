// Key rebinding test: rebind from the menus, cancel with Esc, use the new key in a match.
//   npm run build && node tests/e2e-rebind.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
let failures = 0;
const check = (c, m) => { if (c) log('  ✓', m); else { failures++; log('  ✗ FAIL:', m); } };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/monster-x\//, '') || 'index.html';
  const f = path.join(DIST, decodeURIComponent(p));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(4324);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1280, height: 720 }, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); log('PAGE ERROR', String(e).slice(0, 300)); });
const binds = (a) => page.evaluate((x) => window.__mx.game.facade.settings.data.controls.bindings[x], a);
const screen = () => page.evaluate(() => window.__mx.game.ui.current);
const clickSel = (sel) => page.evaluate((s) => { const b = document.querySelector(s); if (!b) return false; b.click(); return true; }, sel);

try {
  await page.goto('http://localhost:4324/monster-x/');
  await page.waitForFunction(() => window.__mx?.state() === 'MAIN_MENU', { timeout: 90000 });

  log('1. Rebind straight from the CONTROLS page');
  await page.evaluate(() => window.__mx.game.ui.show('controls'));
  await sleep(300);
  check(await clickSel('.mx-ref [aria-label^="Jump"][aria-label$="binding 1"]'), 'CONTROLS page has a clickable Jump slot');
  await sleep(100);
  await page.keyboard.press('KeyJ');
  await sleep(200);
  check((await binds('jump'))[0] === 'KeyJ', `Jump rebound to J (${JSON.stringify(await binds('jump'))})`);
  check(await page.evaluate(() => /J/.test(document.querySelector('.mx-ref [aria-label^="Jump"][aria-label$="binding 1"]').textContent)), 'slot shows the new key');

  log('2. Esc cancels a capture without leaving the screen');
  await clickSel('.mx-ref [aria-label="Reload binding 1"]');
  await sleep(100);
  await page.keyboard.press('Escape');
  await sleep(250);
  check((await screen()) === 'controls', `still on CONTROLS after Esc (${await screen()})`);
  check((await binds('reload'))[0] === 'KeyR', 'reload binding unchanged');

  log('3. Rebind in SETTINGS, with conflict handling');
  await page.evaluate(() => window.__mx.game.ui.show('settings', { tab: 'controls' }));
  await sleep(300);
  await clickSel('.mx-pane--controls [aria-label="Interact / pick up binding 1"], .mx-pane--controls [aria-label^="Interact"][aria-label$="binding 1"]');
  await sleep(100);
  await page.keyboard.press('KeyG');
  await sleep(200);
  check((await binds('interact'))[0] === 'KeyG', `Interact rebound to G (${JSON.stringify(await binds('interact'))})`);
  await clickSel('.mx-pane--controls [aria-label^="Interact"][aria-label$="binding 1"]');
  await sleep(100);
  await page.keyboard.press('Escape');
  await sleep(250);
  check((await screen()) === 'settings', `still on SETTINGS after Esc (${await screen()})`);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /settings/i.test(k)) || '{}'))?.controls?.bindings?.jump?.[0]);
  check(persisted === 'KeyJ', `bindings saved to localStorage (${persisted})`);

  log('4. The new key works in a match');
  await page.evaluate(() => { window.__mx.game.ui.show(null); window.__mx.actions.startTraining(); });
  await page.waitForFunction(() => window.__mx.view().phase === 'training', { timeout: 60000 });
  await page.evaluate(() => { const g = window.__mx.game; g.input.locked = true; g.input.enabled = true; });
  await sleep(500);
  const jumpVel = async (code) => {
    await page.keyboard.down(code);
    let vy = 0;
    for (let i = 0; i < 6; i++) { await sleep(30); vy = Math.max(vy, await page.evaluate(() => window.__mx.game.mc.local.sim.vel.y)); }
    await page.keyboard.up(code);
    await sleep(900);
    return vy;
  };
  check((await jumpVel('KeyJ')) > 2, 'J makes the player jump');
  check((await jumpVel('Space')) < 0.5, 'Space no longer jumps');
  // stand next to an interactable (weapon rack / prop) so the prompt is on screen
  const spot = await page.evaluate(() => { const mc = window.__mx.game.mc; const p = mc.arena.pickups.find((q) => q.kind === 'weapon' && mc.local.weapons.pickupAction(q.weapon) === 'swap'); return p ? [p.pos.x + 0.8, p.pos.y + 1, p.pos.z] : null; });
  if (spot) await page.evaluate((p) => window.__mx.teleport(p[0], Math.max(0.05, p[1] - 1), p[2]), spot);
  await sleep(500);
  log('   interact prompt visible:', await page.evaluate(() => document.querySelector('.hud-interact')?.style.display !== 'none'), 'spot', JSON.stringify(spot));
  const hudKey = await page.evaluate(() => document.querySelector('.hud-interact .hud-key')?.textContent);
  check(hudKey?.trim() === 'G', `HUD interact prompt shows the rebound key (${hudKey})`);

  log('5. Reset to defaults');
  await page.evaluate(() => { window.__mx.game.input.locked = false; window.__mx.actions.mainMenu(); });
  await sleep(400);
  await page.evaluate(() => window.__mx.game.ui.show('settings', { tab: 'controls' }));
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.mx-pane--controls button')].find((b) => /RESET TO DEFAULTS/.test(b.textContent))?.click());
  await sleep(200);
  check((await binds('jump'))[0] === 'Space' && (await binds('interact'))[0] === 'KeyE', 'defaults restored');
  check(errors.length === 0, `no page errors (${errors.length})`);
} catch (e) {
  failures++;
  log('EXCEPTION', e);
} finally {
  await browser.close();
  srv.close();
}
log(failures ? `FAILED (${failures})` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
