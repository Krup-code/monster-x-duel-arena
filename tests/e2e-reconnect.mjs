// Reconnection test: two browsers connect in a lobby, the guest's WebRTC link is force-closed,
// and both sides must recover to "connected" within the reconnect window.
//   npm run build && node tests/e2e-reconnect.mjs   (media relayed through a local TURN server)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core'; import Turn from 'node-turn';
const DIST = path.resolve('dist');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html' };
const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); const f = path.join(DIST, u.pathname.replace('/monster-x/', '') || 'index.html'); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/html' }); fs.createReadStream(f).pipe(res); }).listen(4322);
const sig = spawn(path.resolve('node_modules/.bin/peerjs'), ['--port', '9011', '--path', '/']);
await new Promise((r) => setTimeout(r, 1500));
const turn = new Turn({ listeningPort: 3480, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', credentials: { mx: 'duel' }, debugLevel: 'OFF' });
turn.start();
const q = '?signal=localhost&signalPort=9011&turn=turn:127.0.0.1:3480&turnUser=mx&turnPass=duel&relay=1';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const mk = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--mute-audio'] }); const p = await b.newPage(); await p.goto('http://localhost:4322/monster-x/' + q); await p.waitForFunction(() => window.__mx?.state() === 'MAIN_MENU', { timeout: 60000 }); return { b, p }; };
let ok = false;
const A = await mk(), B = await mk();
try {
  await A.p.evaluate(() => window.__mx.actions.hostMatch());
  const code = await A.p.evaluate(() => window.__mx.code());
  await B.p.evaluate((c) => window.__mx.actions.joinMatch(c), code);
  await A.p.waitForFunction(() => window.__mx.game.net?.state === 'connected', { timeout: 20000 });
  console.log('connected; force-closing the guest link');
  await B.p.evaluate(() => window.__mx.game.net.link.close());
  await A.p.waitForFunction(() => window.__mx.game.net?.state === 'reconnecting', { timeout: 8000 });
  console.log('host detected the drop');
  const t0 = Date.now();
  await A.p.waitForFunction(() => window.__mx.game.net?.state === 'connected', { timeout: 15000 });
  await B.p.waitForFunction(() => window.__mx.game.net?.state === 'connected', { timeout: 5000 });
  console.log(`both reconnected after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  ok = true;
} catch (e) {
  console.log('FAILED', e.message);
} finally {
  await A.b.close(); await B.b.close(); srv.close(); sig.kill(); turn.stop();
}
console.log(ok ? 'RECONNECT TEST PASSED' : 'RECONNECT TEST FAILED');
process.exit(ok ? 0 : 1);
