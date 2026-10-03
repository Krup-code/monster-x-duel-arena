// Entry point: verify WebGL2, boot the game and land on the main menu.
import './styles/base.css';
import './styles/menu.css';
import './styles/hud.css';
import { Game } from './game.js';

function fatal(message) {
  const ui = document.getElementById('ui');
  ui.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;pointer-events:auto;background:#050605;color:#e6ebe3;font:600 18px Rajdhani,system-ui,sans-serif;text-align:center;padding:40px';
  box.innerHTML = `<div><div style="font:700 64px Teko,Impact,sans-serif;color:#7dff1a;letter-spacing:.06em">MONSTER-X</div><p style="max-width:560px;line-height:1.5">${message}</p></div>`;
  ui.appendChild(box);
}

function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

if (!hasWebGL2()) {
  fatal('This browser or device does not support WebGL2, which the game needs. Use a current desktop Chrome, Edge, Firefox or Safari with hardware acceleration enabled.');
} else {
  const game = new Game(document.getElementById('game'), document.getElementById('ui'));
  game.boot().catch((e) => {
    console.error(e);
    fatal(`Something went wrong while loading: ${String(e?.message || e)}. Try reloading the page.`);
  });
}
