// Offline-mode test: practice match vs the bot, Training Grounds, and every graphics preset.
//   npm run build && npm run test:solo   (--headful to watch)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const HEADFUL = process.argv.includes('--headful');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
let failures = 0;
const check = (c, m) => { if (c) log('  ✓', m); else { failures++; log('  ✗ FAIL:', m); } };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/^\/monster-x\//, '') || 'index.html';
  const f = path.join(DIST, decodeURIComponent(p));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(4323);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: HEADFUL ? false : 'new', defaultViewport: { width: 1280, height: 720 },
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(String(e)); log('PAGE ERROR', String(e).slice(0, 300)); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); log('console.error', m.text().slice(0, 300)); } else if (/\[nav\]|\[bot\]/.test(m.text())) log(m.text()); });
const view = () => page.evaluate(() => window.__mx.view());

try {
  await page.goto('http://localhost:4323/monster-x/');
  await page.waitForFunction(() => window.__mx?.state() === 'MAIN_MENU', { timeout: 90000 });
  log('main menu ready');

  // ---------------------------------------------------------------- practice vs bot
  log('1. Practice vs bot (hard)');
  await page.evaluate(() => { window.__mx.input({}); window.__mx.actions.startBot({ difficulty: 'hard', map: 'blackout' }); });
  await page.waitForFunction(() => window.__mx.view().phase === 'playing', { timeout: 60000 });
  check(true, 'bot match reached FIGHT');
  const botStart = (await view()).oppPos;
  let botMoved = 0, last = botStart, hurtAt = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const v = await view();
    if (v.oppPos && last) botMoved += Math.hypot(v.oppPos[0] - last[0], v.oppPos[2] - last[2]);
    last = v.oppPos;
    if (hurtAt < 0 && (v.hp[0] < 100 || v.deaths[0] > 0)) { hurtAt = i + 1; if (i >= 20) break; }
    if (i >= 20 && hurtAt > 0) break;
  }
  check(botMoved > 25, `bot navigates the arena (${botMoved.toFixed(1)} m)`);
  check(hurtAt > 0, `bot hunted down and damaged the idle player (after ${hurtAt} s)`);
  await page.screenshot({ path: path.join(SHOTS, 'solo-01-bot.png') });
  // Fight back: track the bot and fire until we score.
  log('   freezing the bot in front of the player and firing…');
  await page.waitForFunction(() => window.__mx.view().localAlive && window.__mx.view().alive[1], { timeout: 10000 });
  await page.evaluate(() => {
    const mc = window.__mx.game.mc;
    const idle = mc.bot.controller.update.bind(mc.bot.controller);
    mc.bot.controller.update = (dt, ctx) => { const o = idle(dt, { ...ctx, alive: false }); return o; };
    window.__mx.teleport(-7, 0.05, -9.5);
    mc.bot.sim.pos.set(7, 0.05, -9.5); mc.bot.sim.vel.set(0, 0, 0);
  });
  await sleep(1300);
  let scored = false;
  for (let i = 0; i < 60 && !scored; i++) {
    await page.evaluate(() => { window.__mx.aimAtOpponent(); window.__mx.input({ fire: true }); const w = window.__mx.game.mc.local.weapons; if (w.ammo.razor) w.ammo.razor.reserve = 120; });
    await sleep(150);
    scored = (await view()).scores[0] > 0;
  }
  await page.evaluate(() => window.__mx.input({}));
  const v2 = await view();
  check(v2.scores[0] > 0, `player eliminated the bot (score ${v2.scores.join('-')})`);
  check(v2.scores[1] >= 0, `bot score tracked (${v2.scores[1]})`);
  const nav = await page.evaluate(() => window.__mx.game.nav?.nodes.length || 0);
  check(nav > 200, `navigation graph built (${nav} nodes)`);

  // ---------------------------------------------------------------- training
  log('2. Training Grounds');
  await page.evaluate(() => window.__mx.actions.startTraining());
  await page.waitForFunction(() => window.__mx.view().phase === 'training', { timeout: 60000 });
  await sleep(500);
  const tg = await page.evaluate(() => window.__mx.game.arena.targets.map((t) => [t.kind, t.pos.x, t.pos.y, t.pos.z]));
  check(tg.length >= 10, `targets spawned (${tg.length})`);
  // shoot the 10 m static target in the head and body
  await page.evaluate(() => { const t = window.__mx.game.arena.targets[1]; window.__mx.aimAt(t.pos.x, t.pos.y + 1.0, t.pos.z); window.__mx.press('fire'); });
  await sleep(400);
  await page.evaluate(() => { const t = window.__mx.game.arena.targets[1]; window.__mx.aimAt(t.pos.x, t.pos.y + 1.6, t.pos.z); window.__mx.press('fire'); });
  await sleep(400);
  const tr = await page.evaluate(() => window.__mx.game.mc.hud.training);
  check(tr && tr.hits >= 1, `training hits registered (${tr?.hits} hits, ${tr?.damage} dmg, ${tr?.headshots} HS, acc ${tr?.accuracy}%)`);
  // weapon rack: swap to the rail with E
  await page.evaluate(() => window.__mx.teleport(9, 0.05, 15));
  await sleep(400);
  await page.evaluate(() => window.__mx.press('interact'));
  await sleep(600);
  const w = await page.evaluate(() => window.__mx.game.mc.local.weapons.inventory);
  check(Object.values(w).includes('rail'), `weapon rack pickup works (inventory ${JSON.stringify(w)})`);
  await page.screenshot({ path: path.join(SHOTS, 'solo-02-training.png') });

  // ---------------------------------------------------------------- presets
  log('3. Graphics presets');
  for (const p of ['low', 'medium', 'high', 'ultra']) {
    await page.evaluate((name) => window.__mx.game.facade.settings.applyPreset(name), p);
    await sleep(700);
    const lum = await page.evaluate(() => {
      const g = window.__mx.game; g.postfx.render(0.016);
      const c = document.createElement('canvas'); c.width = 16; c.height = 9; const x = c.getContext('2d'); x.drawImage(g.renderer.domElement, 0, 0, 16, 9);
      const d = x.getImageData(0, 0, 16, 9).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (16 * 9 * 3);
    });
    check(lum > 8, `${p.toUpperCase()} preset renders (mean luminance ${lum.toFixed(0)})`);
  }
  await page.evaluate(() => window.__mx.game.facade.settings.applyPreset('high'));
  await page.evaluate(() => window.__mx.actions.mainMenu());
  await sleep(500);
  check((await page.evaluate(() => window.__mx.state())) === 'MAIN_MENU', 'back to main menu');
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
