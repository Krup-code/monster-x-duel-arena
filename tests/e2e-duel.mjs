// End-to-end multiplayer test: two separate Chrome instances play a full online duel
// over real WebRTC, through the production build served from a GitHub-Pages-style
// subdirectory (/monster-x/).
//
//   npm run build && npm run test:e2e
//   options: --public      use the public PeerJS broker (0.peerjs.com) instead of a local one
//            --headful     show the browser windows
//            --kills=15    kills needed for the win (default 15, the real rule)
//
// Scenario (the "CRITICAL TEST" from the spec):
//   A hosts -> B joins by code -> both ready -> countdown -> A moves, B sees it -> B moves,
//   A sees it -> A shoots B (B loses health) -> B shoots A (A loses health) -> eliminations,
//   score increases, respawn -> A reaches 15 -> A: VICTORY, B: DEFEAT -> both REMATCH -> new match.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import Turn from 'node-turn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const ARGS = new Set(process.argv.slice(2));
const PUBLIC = ARGS.has('--public');
// --turn: relay all media through a local TURN server (needed when a VPN blocks local UDP hairpinning)
const TURN = ARGS.has('--turn');
const HEADFUL = ARGS.has('--headful');
const KILLS = Number([...ARGS].find((a) => a.startsWith('--kills='))?.split('=')[1] || 15);
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 4321;
const SIGNAL_PORT = 9010;

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
let failures = 0;
function check(cond, msg) {
  if (cond) log('  ✓', msg);
  else { failures++; log('  ✗ FAIL:', msg); }
  return cond;
}

// ---------------------------------------------------------------- static server (subdirectory)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/monster-x/')) { res.writeHead(404); res.end('not under /monster-x/'); return; }
      let p = url.pathname.slice('/monster-x/'.length) || 'index.html';
      const file = path.join(DIST, decodeURIComponent(p));
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

async function startSignal() {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'peerjs');
  const proc = spawn(bin, ['--port', String(SIGNAL_PORT), '--path', '/'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(), 4000);
    proc.stdout.on('data', (d) => { if (/Started PeerServer|listening/i.test(String(d))) { clearTimeout(t); resolve(); } });
    proc.on('error', reject);
  });
  return proc;
}

async function launch(name) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : 'new',
    defaultViewport: { width: 1100, height: 640 },
    args: [
      '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--ignore-gpu-blocklist', '--enable-webgl',
      '--use-angle=metal', '--enable-gpu', '--enable-unsafe-webgpu',
      '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', `--window-size=1100,700`,
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(String(e)); log(`[${name}] PAGE ERROR`, String(e).slice(0, 300)); });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') { errors.push(t); log(`[${name}] console.error`, t.slice(0, 300)); }
    else if (/\[net\]|\[host\]|\[nav\]/.test(t)) log(`[${name}]`, t.slice(0, 200));
  });
  // Low graphics so two software-rendered instances stay responsive.
  await page.evaluateOnNewDocument(() => {
    const s = { version: 2, player: { name: '' }, graphics: { preset: 'low', renderScale: 0.5, shadows: 'off', textures: 'low', effects: 'low', antialias: 'off', bloom: true, ao: false, reflections: 'low', drawDistance: 'low', geometry: 'low', lighting: 'low', fpsLimit: 0, fov: 100, showFps: false, motionBlur: false } };
    if (!localStorage.getItem('monsterx-duel-settings-v2')) localStorage.setItem('monsterx-duel-settings-v2', JSON.stringify(s));
  });
  return { browser, page, errors, name };
}

const view = (p) => p.evaluate(() => window.__mx.view());
async function waitFor(p, fn, arg, timeout = 30000, label = 'condition') {
  try {
    await p.waitForFunction(fn, { timeout, polling: 100 }, arg);
    return true;
  } catch (e) {
    log(`  timeout waiting for ${label}`);
    return false;
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('dist/ missing — run `npm run build` first');
  const srv = await serve();
  const signal = PUBLIC ? null : await startSignal();
  let turn = null;
  const params = new URLSearchParams();
  if (!PUBLIC) { params.set('signal', 'localhost'); params.set('signalPort', String(SIGNAL_PORT)); }
  params.set('netdebug', '1');
  if (TURN) {
    turn = new Turn({ listeningPort: 3479, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', credentials: { mx: 'duel' }, debugLevel: 'OFF' });
    turn.start();
    params.set('turn', 'turn:127.0.0.1:3479'); params.set('turnUser', 'mx'); params.set('turnPass', 'duel'); params.set('relay', '1');
  }
  const q = params.toString() ? '?' + params.toString() : '';
  const base = `http://localhost:${PORT}/monster-x/`;
  log(`serving ${base}  ·  signaling: ${PUBLIC ? 'public 0.peerjs.com' : `local broker :${SIGNAL_PORT}`}${TURN ? '  ·  media via local TURN relay' : ''}`);

  const A = await launch('A');
  const B = await launch('B');
  try {
    // ------------------------------------------------------------ boot
    log('1. Both players open the site');
    await Promise.all([A.page.goto(base + q), B.page.goto(base + q)]);
    check(await waitFor(A.page, () => window.__mx?.state() === 'MAIN_MENU', null, 90000, 'A main menu'), 'A reached MAIN_MENU');
    check(await waitFor(B.page, () => window.__mx?.state() === 'MAIN_MENU', null, 90000, 'B main menu'), 'B reached MAIN_MENU');
    await A.page.screenshot({ path: path.join(SHOTS, '01-main-menu.png') });

    // ------------------------------------------------------------ host + join
    if (KILLS !== 15) await A.page.evaluate((k) => window.__mx.setRule('killLimit', k), KILLS);
    log('2. A clicks HOST MATCH');
    await A.page.evaluate(() => window.__mx.actions.hostMatch());
    const code = await A.page.evaluate(() => window.__mx.code());
    check(/^[A-HJ-NP-Z2-9]{5}$/.test(code || ''), `room code generated: ${code}`);
    await A.page.screenshot({ path: path.join(SHOTS, '02-host-lobby.png') });

    log('3. B opens the invite link and joins');
    await B.page.goto(`${base}?room=${code}${q ? '&' + q.slice(1) : ''}`);
    await waitFor(B.page, () => window.__mx?.state() === 'MAIN_MENU', null, 90000, 'B main menu (invite)');
    check(await B.page.evaluate(() => window.__mx.game.initialRoom), 'invite link detected ?room=');
    const joinErr = await B.page.evaluate((c) => window.__mx.actions.joinMatch(c).then(() => null, (e) => e.message), code);
    check(!joinErr, `B joined room (${joinErr || 'ok'})`);
    check(await waitFor(A.page, () => window.__mx.lobby()?.connected, null, 20000, 'A sees guest'), 'A lobby shows PLAYER 2 connected');
    await sleep(1500);
    const net = await B.page.evaluate(() => window.__mx.net());
    check(net && net.pc === 'connected' && net.rtt > 0, `WebRTC connected (pc=${net?.pc}, ice=${net?.ice}, rtt=${net?.rtt?.toFixed?.(1)} ms)`);
    await B.page.screenshot({ path: path.join(SHOTS, '03-guest-lobby.png') });

    // ------------------------------------------------------------ start
    log('4. Both READY, host starts');
    await B.page.evaluate(() => window.__mx.actions.setReady(true));
    await A.page.evaluate(() => window.__mx.actions.setReady(true));
    check(await waitFor(A.page, () => window.__mx.lobby()?.ready?.every(Boolean), null, 5000, 'both ready'), 'both players ready');
    await A.page.evaluate(() => window.__mx.actions.startMatch());
    check(await waitFor(A.page, () => window.__mx.view().phase === 'intro' || window.__mx.view().phase === 'countdown', null, 60000, 'A intro'), 'A in intro/countdown');
    check(await waitFor(B.page, () => ['intro', 'countdown'].includes(window.__mx.view().phase), null, 60000, 'B intro'), 'B in intro/countdown');
    await sleep(2500);
    await A.page.screenshot({ path: path.join(SHOTS, '04-intro.png') });
    check(await waitFor(A.page, () => window.__mx.view().phase === 'playing', null, 20000, 'A playing'), 'FIGHT: A playing');
    check(await waitFor(B.page, () => window.__mx.view().phase === 'playing', null, 5000, 'B playing'), 'FIGHT: B playing');
    for (const P of [A, B]) await P.page.evaluate(() => window.__mx.input({}));

    // ------------------------------------------------------------ movement sync
    log('5. Movement sync');
    const a0 = await view(B.page);
    await A.page.evaluate(() => window.__mx.input({ forward: true }));
    await sleep(1400);
    await A.page.evaluate(() => window.__mx.input({}));
    await sleep(400);
    const aSelf = await view(A.page);
    const a1 = await view(B.page);
    const movedA = a0.oppPos && a1.oppPos && Math.hypot(a1.oppPos[0] - a0.oppPos[0], a1.oppPos[2] - a0.oppPos[2]);
    check(movedA > 3, `B sees A move (${movedA?.toFixed(2)} m)`);
    check(a1.oppPos && Math.hypot(a1.oppPos[0] - aSelf.pos[0], a1.oppPos[2] - aSelf.pos[2]) < 0.6, 'B\'s view of A matches A\'s own position');
    const b0 = await view(A.page);
    await B.page.evaluate(() => window.__mx.input({ forward: true, sprint: true }));
    await sleep(1400);
    await B.page.evaluate(() => window.__mx.input({}));
    await sleep(400);
    const b1 = await view(A.page);
    const movedB = b0.oppPos && b1.oppPos && Math.hypot(b1.oppPos[0] - b0.oppPos[0], b1.oppPos[2] - b0.oppPos[2]);
    check(movedB > 3, `A sees B move (${movedB?.toFixed(2)} m)`);

    // ------------------------------------------------------------ duel positions
    const placeDuel = async () => {
      await A.page.evaluate(() => window.__mx.teleport(-7, 0.05, -9.5));
      await B.page.evaluate(() => window.__mx.teleport(7, 0.05, -9.5));
      await sleep(700);
    };
    await placeDuel();
    await A.page.screenshot({ path: path.join(SHOTS, '05-duel-position-A.png') });

    // ------------------------------------------------------------ damage both ways
    log('6. A shoots B');
    const fireBurst = async (P, ms) => {
      await P.page.evaluate(() => { window.__mx.aimAtOpponent(); window.__mx.input({ fire: true }); });
      const until = Date.now() + ms;
      while (Date.now() < until) { await P.page.evaluate(() => window.__mx.aimAtOpponent()); await sleep(60); }
      await P.page.evaluate(() => window.__mx.input({}));
    };
    await fireBurst(A, 220);
    await sleep(600);
    const vB = await view(B.page);
    const vA = await view(A.page);
    check(vB.hp[1] < 100 && vB.hp[1] > 0, `B lost health (B sees hp=${vB.hp[1]})`);
    check(vA.hp[1] === vB.hp[1], `A and B agree on B health (${vA.hp[1]} / ${vB.hp[1]})`);
    await A.page.screenshot({ path: path.join(SHOTS, '06-A-shooting.png') });

    log('7. B shoots A');
    await fireBurst(B, 220);
    await sleep(600);
    const vA2 = await view(A.page);
    check(vA2.hp[0] < 100, `A lost health (hp=${vA2.hp[0]})`);
    await B.page.screenshot({ path: path.join(SHOTS, '07-B-shooting.png') });

    // ------------------------------------------------------------ elimination + respawn
    log('8. Elimination, score, respawn');
    await fireBurst(A, 1500);
    check(await waitFor(A.page, () => window.__mx.view().scores[0] >= 1, null, 5000, 'first kill'), 'A scored an elimination');
    const vB3 = await view(B.page);
    check(vB3.scores[0] >= 1 && vB3.deaths[1] >= 1, `B sees score ${vB3.scores.join('-')} and its death`);
    await B.page.screenshot({ path: path.join(SHOTS, '08-B-dead.png') });
    check(await waitFor(B.page, () => window.__mx.view().localAlive, null, 6000, 'B respawn'), 'B respawned (2 s)');

    // ------------------------------------------------------------ race to KILLS
    log(`9. Playing on until A reaches ${KILLS}`);
    let guard = 0;
    while ((await view(A.page)).scores[0] < KILLS && guard++ < KILLS * 6) {
      if (!(await waitFor(B.page, () => window.__mx.view().localAlive, null, 8000, 'B alive'))) {
        const auth = await A.page.evaluate(() => { const a = window.__mx.game.mc.authority; const p = a.ps[1]; return { phase: a.phase, paused: a.paused, now: +a.now().toFixed(2), alive: p.alive, respawnAt: +p.respawnAt.toFixed(2), hp: p.health, life: p.life, kills: a.ps.map((x) => x.kills), net: window.__mx.net()?.pc, netState: window.__mx.game.net?.state, mcPaused: window.__mx.game.mc.netPaused }; });
        log('   STALL host authority:', JSON.stringify(auth));
        break;
      }
      await placeDuel();
      await sleep(1100); // spawn protection
      await fireBurst(A, 1600);
      const va = await view(A.page), vb = await view(B.page);
      const ws = await A.page.evaluate(() => { const w = window.__mx.game.mc.local.weapons; return { st: w.state, cur: w.current, ammo: w.ammo[w.current], cd: +w.cooldown.toFixed(2) }; });
      log(`   score ${va.scores[0]} - ${va.scores[1]} | A: pos ${va.pos} weapon ${JSON.stringify(ws)} oppPos ${va.oppPos} oppHp ${va.hp[1]} | B: alive ${vb.localAlive} pos ${vb.pos} hp ${vb.hp[1]}`);
      // reload between lives; top up reserve ammo (15 kills needs more rifle ammo than one life carries)
      await A.page.evaluate(() => {
        const w = window.__mx.game.mc?.local.weapons;
        if (w?.ammo.razor) w.ammo.razor.reserve = 120;
        window.__mx.press('reload');
      });
      await sleep(300);
    }
    check(await waitFor(A.page, () => window.__mx.view().ended, null, 10000, 'A ended'), 'match ended');
    await sleep(2400);
    const endA = await view(A.page), endB = await view(B.page);
    check(endA.winner === 0 && endB.winner === 0, `winner = PLAYER 1 on both (${endA.winner}/${endB.winner})`);
    const resA = await A.page.evaluate(() => window.__mx.game.mc?.view.endData?.result);
    const resB = await B.page.evaluate(() => window.__mx.game.mc?.view.endData?.result);
    check(resA === 'victory', `A sees VICTORY (${resA})`);
    check(resB === 'defeat', `B sees DEFEAT (${resB})`);
    check(endA.ui === 'end' && endB.ui === 'end', `stats screens shown (${endA.ui}/${endB.ui})`);
    await A.page.screenshot({ path: path.join(SHOTS, '09-victory.png') });
    await B.page.screenshot({ path: path.join(SHOTS, '10-defeat.png') });

    // ------------------------------------------------------------ rematch
    log('10. Both click REMATCH');
    await A.page.evaluate(() => window.__mx.actions.rematch());
    await sleep(500);
    check(!(await view(A.page)).phase.match(/intro|countdown/), 'match does not restart with only one vote');
    await B.page.evaluate(() => window.__mx.actions.rematch());
    check(await waitFor(A.page, () => ['intro', 'countdown'].includes(window.__mx.view().phase), null, 8000, 'rematch A'), 'rematch started on A');
    check(await waitFor(B.page, () => ['intro', 'countdown'].includes(window.__mx.view().phase), null, 8000, 'rematch B'), 'rematch started on B');
    const r = await view(B.page);
    check(r.scores[0] === 0 && r.scores[1] === 0, `scores reset (${r.scores.join('-')})`);
    check(await A.page.evaluate(() => window.__mx.code()) === code, 'same room (no new code needed)');
    check(await waitFor(A.page, () => window.__mx.view().phase === 'playing', null, 15000, 'rematch fight'), 'rematch FIGHT');
    await B.page.screenshot({ path: path.join(SHOTS, '11-rematch.png') });

    // ------------------------------------------------------------ errors + perf
    const fpsA = await A.page.evaluate(() => window.__mx.game.fps);
    log(`   fps (software-rendered headless, low preset): A=${fpsA.toFixed(1)}`);
    check(A.errors.length === 0, `no page errors on A (${A.errors.length})`);
    check(B.errors.length === 0, `no page errors on B (${B.errors.length})`);
  } finally {
    await A.browser.close().catch(() => {});
    await B.browser.close().catch(() => {});
    srv.close();
    signal?.kill();
    turn?.stop();
  }
  log(failures ? `FAILED (${failures} checks)` : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
