// Captures README screenshots at the HIGH preset: node tests/capture-screenshots.mjs (after npm run build).
// Saves PNGs; convert to JPEG for the repo (macOS: sips -s format jpeg -s formatOptions 82 x.png --out x.jpg).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import puppeteer from 'puppeteer-core';
const DIST = path.resolve('dist'); const OUT = path.resolve('docs/screenshots');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html' };
const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); const f = path.join(DIST, u.pathname.replace('/monster-x/', '') || 'index.html'); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/html' }); fs.createReadStream(f).pipe(res); }).listen(4325);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1600, height: 900 }, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGE ERROR', String(e)));
await p.evaluateOnNewDocument(() => { localStorage.setItem('monsterx-duel-settings-v2', JSON.stringify({ version: 2, player: { name: 'NATHAN' }, graphics: { preset: 'high', renderScale: 1, shadows: 'medium', textures: 'high', effects: 'high', antialias: 'smaa', bloom: true, ao: false, reflections: 'high', drawDistance: 'high', geometry: 'high', lighting: 'high', fpsLimit: 0, fov: 100, showFps: false, motionBlur: false } })); });
await p.goto('http://localhost:4325/monster-x/');
await p.waitForFunction(() => window.__mx?.state() === 'MAIN_MENU', { timeout: 90000 });
await sleep(5000);
await p.screenshot({ path: path.join(OUT, 'main-menu.png') });
console.log('main menu');
// lobby (public broker)
await p.evaluate(() => window.__mx.actions.hostMatch().catch(() => {}));
await sleep(3500);
await p.screenshot({ path: path.join(OUT, 'lobby.png') });
console.log('lobby');
await p.evaluate(() => window.__mx.actions.leaveRoom());
// bot match
await p.evaluate(() => { window.__mx.input({}); window.__mx.setRule('killLimit', 1); window.__mx.actions.startBot({ difficulty: 'normal', map: 'blackout' }); });
await sleep(3500);
await p.evaluate(() => window.__mx.game.ui.hud.setOverlay(null));
await p.screenshot({ path: path.join(OUT, 'intro.png') });
console.log('intro');
await p.waitForFunction(() => window.__mx.view().phase === 'playing', { timeout: 30000 });
await p.evaluate(() => {
  const mc = window.__mx.game.mc;
  mc.bot.controller.update = () => ({ move: { mx: 0, mz: 0, jump: false, jumpPressed: false, crouch: false, crouchPressed: false, sprint: false, ads: false, firing: false, moveMul: 1 }, weapon: { fire: false, firePressed: false, ads: false, reload: false, slot: null, next: false, prev: false, melee: false }, rush: false });
  window.__mx.teleport(-11.5, 0.05, -9.6);
  mc.bot.sim.pos.set(-1.5, 0.05, -10.4); mc.bot.sim.yaw = Math.PI / 2 + 0.3;
});
await sleep(1500);
await p.evaluate(() => { window.__mx.game.ui.hud.setOverlay(null); window.__mx.aimAtOpponent(); const mc = window.__mx.game.mc; mc.local.sim.pitch += 0.02; window.__mx.input({ fire: true }); });
await sleep(140);
await p.evaluate(() => window.__mx.input({}));
await sleep(30);
await p.screenshot({ path: path.join(OUT, 'combat.png') });
console.log('combat');
for (let i = 0; i < 30; i++) { await p.evaluate(() => { window.__mx.aimAtOpponent(); window.__mx.input({ fire: true }); }); await sleep(120); if ((await p.evaluate(() => window.__mx.view().ended))) break; }
await p.evaluate(() => window.__mx.input({}));
await sleep(2600);
await p.screenshot({ path: path.join(OUT, 'victory.png') });
console.log('victory', await p.evaluate(() => window.__mx.view().ui));
await b.close(); srv.close();
