// In-game HUD (prefix hud-). update(state) runs every frame, so every DOM write is
// diffed against the previously written value and nothing allocates per frame.
import { CSS_P1, CSS_P2 } from '../config.js';

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function txt(node, v) {
  const s = v == null ? '' : String(v);
  if (node.__t !== s) { node.__t = s; node.textContent = s; }
}

function cls(node, name, on) {
  const k = '__c_' + name;
  if (node[k] !== on) { node[k] = on; node.classList.toggle(name, on); }
}

function show(node, on) {
  if (node.__v !== on) { node.__v = on; node.style.display = on ? '' : 'none'; }
}

function cssVar(node, name, v) {
  const k = '__v_' + name;
  if (node[k] !== v) { node[k] = v; node.style.setProperty(name, v); }
}

const SLOT_KEYS = ['primary', 'secondary', 'special'];
const SHORT = { pistol: 'P9', razor: 'AR', volt: 'SMG', crush: 'SG', venom: 'DMR', chaos: 'RL', rail: 'RAIL' };

export class HUD {
  constructor(root, game) {
    this.game = game;
    this.el = h('div', 'hud');
    this.el.style.display = 'none';
    root.append(this.el);
    const E = this.el;

    // rush edge + scope + overlays (lowest)
    this.rushEdge = h('div', 'hud-rush-edge');
    this.rushEdge.id = 'hud-rush-edge';
    this.scope = h('div', 'hud-scope');
    this.scope.innerHTML = '<div class="hud-scope__lens"><i class="hud-scope__h"></i><i class="hud-scope__v"></i><i class="hud-scope__dots"></i><i class="hud-scope__ring"></i></div>';
    E.append(this.rushEdge, this.scope);

    // crosshair
    this.xh = h('div', 'hud-xh');
    for (const d of ['t', 'b', 'l', 'r']) this.xh.append(h('i', `hud-xh__arm hud-xh__arm--${d}`));
    this.xh.append(h('i', 'hud-xh__dot'), h('i', 'hud-xh__ring'), h('i', 'hud-xh__chev'));
    E.append(this.xh);

    // hitmarker
    this.hit = h('div', 'hud-hit');
    for (const d of ['tl', 'tr', 'bl', 'br']) this.hit.append(h('i', `hud-hit__l hud-hit__l--${d}`));
    E.append(this.hit);

    // damage indicators (pool)
    this.dmgInd = [];
    const indWrap = h('div', 'hud-dmgind');
    for (let i = 0; i < 5; i++) {
      const a = h('div', 'hud-dmgind__arc');
      indWrap.append(a);
      this.dmgInd.push(a);
    }
    this.dmgIndNext = 0;
    E.append(indWrap);

    // damage numbers (pool)
    this.nums = [];
    const numWrap = h('div', 'hud-nums');
    for (let i = 0; i < 24; i++) {
      const n = h('span', 'hud-num');
      numWrap.append(n);
      this.nums.push(n);
    }
    this.numNext = 0;
    E.append(numWrap);

    // interact + spawn protection under crosshair
    this.interact = h('div', 'hud-interact');
    this.interactKey = h('span', 'hud-key', 'E');
    this.interactText = h('span', 'hud-interact__text');
    this.interact.append(this.interactKey, this.interactText);
    this.protect = h('div', 'hud-protect', 'SPAWN PROTECTED');
    E.append(this.interact, this.protect);

    // top center: score
    this.score = h('div', 'hud-score');
    this.sName = [h('span', 'hud-score__name hud-score__name--p1'), h('span', 'hud-score__name hud-score__name--p2')];
    this.sVal = [h('span', 'hud-score__val hud-score__val--p1', '0'), h('span', 'hud-score__val hud-score__val--p2', '0')];
    this.sYou = [h('span', 'hud-score__you', 'YOU'), h('span', 'hud-score__you', 'YOU')];
    const side = (i) => {
      const s = h('div', `hud-score__side hud-score__side--${i ? 'p2' : 'p1'}`);
      const nm = h('div', 'hud-score__label');
      if (i === 0) nm.append(this.sYou[0], this.sName[0]);
      else nm.append(this.sName[1], this.sYou[1]);
      s.append(nm, this.sVal[i]);
      return s;
    };
    this.timer = h('div', 'hud-score__timer', '08:00');
    this.limit = h('div', 'hud-score__limit', 'FIRST TO 15');
    const mid = h('div', 'hud-score__mid');
    mid.append(this.timer, this.limit);
    this.trainingTitle = h('div', 'hud-score__training', 'TRAINING GROUNDS');
    this.score.append(side(0), mid, side(1), this.trainingTitle);
    E.append(this.score);

    // top right: kill feed + net + fps
    this.feed = h('div', 'hud-feed');
    this.net = h('div', 'hud-net');
    this.netDot = h('i', 'hud-net__dot');
    this.netText = h('span', 'hud-net__text');
    this.netLoss = h('span', 'hud-net__loss');
    this.net.append(this.netDot, this.netText, this.netLoss);
    this.fps = h('div', 'hud-fps');
    E.append(this.feed, this.net, this.fps);

    // bottom left: vitals
    this.vitals = h('div', 'hud-vitals');
    this.hpNum = h('span', 'hud-vitals__num', '100');
    this.hpBar = h('div', 'hud-bar hud-bar--hp');
    this.hpFill = h('i', 'hud-bar__fill');
    this.hpOver = h('i', 'hud-bar__over');
    this.hpLag = h('i', 'hud-bar__lag');
    this.hpBar.append(this.hpLag, this.hpFill, this.hpOver);
    this.arNum = h('span', 'hud-vitals__num hud-vitals__num--ar', '0');
    this.arBar = h('div', 'hud-bar hud-bar--ar');
    this.arFill = h('i', 'hud-bar__fill');
    this.arLag = h('i', 'hud-bar__lag');
    this.arBar.append(this.arLag, this.arFill);
    const hpRow = h('div', 'hud-vitals__row hud-vitals__row--hp');
    const hpHead = h('div', 'hud-vitals__head');
    hpHead.append(h('span', 'hud-vitals__icon hud-vitals__icon--hp'), this.hpNum, h('span', 'hud-vitals__cap', 'HEALTH'));
    hpRow.append(hpHead, this.hpBar);
    const arRow = h('div', 'hud-vitals__row hud-vitals__row--ar');
    const arHead = h('div', 'hud-vitals__head');
    arHead.append(h('span', 'hud-vitals__icon hud-vitals__icon--ar'), this.arNum, h('span', 'hud-vitals__cap', 'ARMOR'));
    arRow.append(arHead, this.arBar);
    this.vitals.append(hpRow, arRow);
    E.append(this.vitals);

    // bottom center: energy
    this.energy = h('div', 'hud-energy');
    this.enLabel = h('div', 'hud-energy__label', 'ENERGY');
    this.enVal = h('span', 'hud-energy__val', '0');
    const enHead = h('div', 'hud-energy__head');
    enHead.append(this.enLabel, this.enVal);
    this.enSegs = [];
    const segs = h('div', 'hud-energy__segs');
    for (let i = 0; i < 10; i++) {
      const s = h('i', 'hud-energy__seg');
      const f = h('b', 'hud-energy__segfill');
      s.append(f);
      segs.append(s);
      this.enSegs.push(f);
    }
    this.rushBar = h('div', 'hud-energy__rush');
    this.rushFill = h('i', 'hud-energy__rushfill');
    this.rushBar.append(this.rushFill);
    this.enReady = h('div', 'hud-energy__ready');
    this.enReadyKey = h('span', 'hud-key', 'F');
    this.enReady.append(h('span', null, 'ENERGY RUSH READY'), this.enReadyKey);
    this.energy.append(this.enReady, enHead, segs, this.rushBar);
    E.append(this.energy);

    // bottom right: weapon
    this.weapon = h('div', 'hud-weapon');
    this.wName = h('div', 'hud-weapon__name');
    this.wMag = h('span', 'hud-weapon__mag', '30');
    this.wRes = h('span', 'hud-weapon__res', '120');
    const ammo = h('div', 'hud-weapon__ammo');
    ammo.append(this.wMag, h('span', 'hud-weapon__sep', '/'), this.wRes);
    this.wReload = h('div', 'hud-weapon__reload');
    this.wReloadFill = h('i', 'hud-weapon__reloadfill');
    this.wReloadText = h('span', 'hud-weapon__reloadtext', 'RELOADING');
    this.wReload.append(this.wReloadFill, this.wReloadText);
    this.slots = [];
    const slotWrap = h('div', 'hud-slots');
    for (let i = 0; i < 3; i++) {
      const s = h('div', 'hud-slot');
      const k = h('span', 'hud-slot__key', String(i + 1));
      const n = h('span', 'hud-slot__name', '—');
      s.append(k, n);
      slotWrap.append(s);
      this.slots.push({ el: s, name: n });
    }
    this.weapon.append(this.wName, ammo, this.wReload, slotWrap);
    E.append(this.weapon);

    // pickup / info feed
    this.toasts = h('div', 'hud-toasts');
    E.append(this.toasts);

    // big center texts
    this.announcer = h('div', 'hud-announce');
    this.center = h('div', 'hud-center');
    this.centerMain = h('div', 'hud-center__main');
    this.centerSub = h('div', 'hud-center__sub');
    this.center.append(this.centerMain, this.centerSub);
    this.count = h('div', 'hud-count');
    this.introEl = h('div', 'hud-intro');
    this.introTitle = h('div', 'hud-intro__title');
    this.introKicker = h('div', 'hud-intro__kicker', 'NOW ENTERING');
    this.introSub = h('div', 'hud-intro__sub');
    this.introVs = h('div', 'hud-intro__vs');
    this.vsA = h('span', 'hud-intro__p hud-intro__p--p1');
    this.vsB = h('span', 'hud-intro__p hud-intro__p--p2');
    this.introVs.append(this.vsA, h('span', 'hud-intro__x', 'VS'), this.vsB);
    this.introEl.append(this.introKicker, this.introTitle, this.introSub, this.introVs);
    E.append(this.announcer, this.center, this.count, this.introEl);

    // death
    this.death = h('div', 'hud-death');
    this.deathBy = h('div', 'hud-death__by');
    this.deathIn = h('div', 'hud-death__in');
    this.death.append(this.deathBy, this.deathIn);
    E.append(this.death);

    // training stats
    this.train = h('div', 'hud-train');
    this.trainRows = {};
    const tt = h('div', 'hud-train__title', 'TRAINING STATS');
    this.train.append(tt);
    for (const [k, label] of [['shots', 'SHOTS'], ['hits', 'HITS'], ['accuracy', 'ACCURACY'], ['headshots', 'HEADSHOTS'], ['damage', 'DAMAGE'], ['dps', 'DPS (3s)'], ['last', 'LAST HIT']]) {
      const r = h('div', 'hud-train__row');
      const v = h('span', 'hud-train__val', '0');
      r.append(h('span', 'hud-train__key', label), v);
      this.train.append(r);
      this.trainRows[k] = v;
    }
    this.train.append(h('div', 'hud-train__hint', 'K: RESET  ·  ESC: MENU'));
    E.append(this.train);

    // overlays + debug
    this.overlay = h('div', 'hud-overlay');
    this.overlayMain = h('div', 'hud-overlay__main');
    this.overlaySub = h('div', 'hud-overlay__sub');
    this.overlay.append(this.overlayMain, this.overlaySub);
    this.debug = h('pre', 'hud-debug');
    E.append(this.overlay, this.debug);

    for (const n of [this.scope, this.interact, this.protect, this.wReload, this.rushBar, this.enReady, this.death, this.train, this.overlay, this.debug, this.trainingTitle, this.fps, this.net, this.netLoss]) show(n, false);
    this.prev = {};
    this.lagHp = 100;
    this.lagAr = 0;
    this.announceT = 0;
    this.centerT = 0;
    this.toastCount = 0;
    this.xhCfg = null;
  }

  setVisible(v) {
    show(this.el, !!v);
    if (!v) {
      this.countdown('');
      this.intro_hide();
    }
  }

  setCrosshairSettings(cfg) {
    this.xhCfg = cfg;
    const x = this.xh;
    x.dataset.style = cfg.style || 'cross';
    x.style.setProperty('--xh-color', cfg.color || '#7dff1a');
    x.style.setProperty('--xh-len', `${cfg.size ?? 7}px`);
    x.style.setProperty('--xh-th', `${cfg.thickness ?? 2}px`);
    x.style.setProperty('--xh-gap', `${cfg.gap ?? 4}px`);
    x.style.setProperty('--xh-op', String(cfg.opacity ?? 1));
    x.classList.toggle('is-outline', !!cfg.outline);
    x.classList.toggle('has-dot', !!cfg.dot || cfg.style === 'dot' || cfg.style === 'crossdot');
    this._xhDynamic = cfg.dynamic !== false;
  }

  update(s) {
    const p = this.prev;
    const live = s.phase === 'playing' || s.phase === 'suddendeath' || s.phase === 'training';
    // ---- crosshair
    const xhOn = !s.dead && s.scope <= 0.5 && s.phase !== 'intro' && s.phase !== 'ended';
    show(this.xh, xhOn);
    if (xhOn) {
      const spread = this._xhDynamic ? Math.round(s.spread * 2) / 2 : 0;
      if (spread !== p.spread) { p.spread = spread; this.xh.style.setProperty('--xh-spread', `${spread}px`); }
      const op = (1 - s.ads * 0.55).toFixed(2);
      if (op !== p.xhOp) { p.xhOp = op; this.xh.style.opacity = op; }
    }
    // ---- scope
    const sc = s.scope > 0.02;
    show(this.scope, sc);
    if (sc) { const o = s.scope.toFixed(2); if (o !== p.scope) { p.scope = o; this.scope.style.opacity = o; } }

    // ---- score
    const training = s.mode === 'training';
    show(this.trainingTitle, training);
    cls(this.score, 'is-training', training);
    if (!training) {
      txt(this.sName[0], s.names[0]);
      txt(this.sName[1], s.names[1]);
      for (let i = 0; i < 2; i++) {
        if (p['sc' + i] !== s.scores[i]) {
          const prev = p['sc' + i];
          p['sc' + i] = s.scores[i];
          txt(this.sVal[i], s.scores[i]);
          if (prev !== undefined && s.scores[i] > prev) this._bump(this.sVal[i]);
        }
        show(this.sYou[i], s.myIndex === i);
      }
      txt(this.timer, s.timeText);
      txt(this.limit, s.phase === 'suddendeath' ? 'NEXT ELIMINATION WINS' : `FIRST TO ${s.killLimit}`);
      cls(this.timer, 'is-warn', !!s.timeWarning);
      cls(this.score, 'is-sd', s.phase === 'suddendeath');
    }

    // ---- vitals
    if (s.hp !== p.hp) {
      if (p.hp !== undefined && s.hp < p.hp) this._flash(this.hpBar);
      p.hp = s.hp;
      txt(this.hpNum, s.hp);
      this.hpFill.style.transform = `scaleX(${Math.min(1, s.hp / s.maxHp)})`;
      const over = Math.max(0, s.hp - s.maxHp) / 50;
      this.hpOver.style.transform = `scaleX(${over})`;
      cls(this.vitals, 'is-over', s.hp > s.maxHp);
    }
    if (s.ar !== p.ar) {
      if (p.ar !== undefined && s.ar < p.ar) this._flash(this.arBar);
      p.ar = s.ar;
      txt(this.arNum, s.ar);
      this.arFill.style.transform = `scaleX(${Math.min(1, s.ar / s.maxAr)})`;
    }
    // trailing damage "lag" bars
    this.lagHp += (Math.min(1, s.hp / s.maxHp) * 100 - this.lagHp) * 0.06;
    this.lagAr += (Math.min(1, s.ar / s.maxAr) * 100 - this.lagAr) * 0.06;
    const lh = Math.round(this.lagHp), la = Math.round(this.lagAr);
    if (lh !== p.lh) { p.lh = lh; this.hpLag.style.transform = `scaleX(${lh / 100})`; }
    if (la !== p.la) { p.la = la; this.arLag.style.transform = `scaleX(${la / 100})`; }
    cls(this.vitals, 'is-low', !!s.lowHealth);

    // ---- energy
    const en = Math.max(0, Math.min(100, Math.floor(s.en)));
    if (en !== p.en) {
      p.en = en;
      txt(this.enVal, en);
      for (let i = 0; i < 10; i++) {
        const k = Math.max(0, Math.min(1, (en - i * 10) / 10));
        this.enSegs[i].style.transform = `scaleY(${k})`;
      }
    }
    show(this.enReady, !!s.rushReady && live);
    cls(this.energy, 'is-ready', !!s.rushReady);
    cls(this.energy, 'is-rush', !!s.rushActive);
    show(this.rushBar, !!s.rushActive);
    txt(this.enLabel, s.rushActive ? 'ENERGY RUSH' : 'ENERGY');
    if (s.rushActive) {
      const r = s.rushRemaining.toFixed(3);
      if (r !== p.rush) { p.rush = r; this.rushFill.style.transform = `scaleX(${r})`; }
    }
    const edge = s.rushActive ? '1' : '0';
    if (edge !== p.edge) { p.edge = edge; this.rushEdge.style.opacity = edge; }

    // ---- weapon
    const w = s.weapon;
    txt(this.wName, w.name);
    cls(this.wName, 'is-rare', !!w.rare);
    txt(this.wMag, w.mag);
    txt(this.wRes, w.reserve === Infinity ? '∞' : w.reserve);
    cls(this.wMag, 'is-low', w.mag <= Math.max(1, Math.floor(w.magSize * 0.25)));
    cls(this.wMag, 'is-empty', w.mag === 0);
    const charging = w.id === 'rail' && w.railCharge < 0.999 && !w.reloading;
    show(this.wReload, w.reloading || charging);
    if (w.reloading || charging) {
      const k = (w.reloading ? w.reloadProgress : w.railCharge).toFixed(3);
      if (k !== p.reload) { p.reload = k; this.wReloadFill.style.transform = `scaleX(${k})`; }
      txt(this.wReloadText, w.reloading ? 'RELOADING' : 'CHARGING');
      cls(this.wReload, 'is-charge', charging);
    }
    for (let i = 0; i < 3; i++) {
      const id = s.inventory[SLOT_KEYS[i]];
      const sl = this.slots[i];
      txt(sl.name, id ? SHORT[id] || (s.weaponNames[id] || id).slice(0, 4) : '—');
      cls(sl.el, 'is-empty', !id);
      cls(sl.el, 'is-on', !!id && id === s.current);
    }

    // ---- prompts
    const inter = s.interact && !s.dead;
    show(this.interact, !!inter);
    if (inter) txt(this.interactText, s.interact);
    show(this.protect, !!s.spawnProtected && !s.dead && live);

    // ---- death
    show(this.death, !!s.dead);
    if (s.dead) {
      txt(this.deathBy, s.killerName ? `ELIMINATED BY ${s.killerName}` : 'ELIMINATED');
      txt(this.deathIn, s.respawnIn > 0.05 ? `RESPAWNING IN ${s.respawnIn.toFixed(1)}` : 'RESPAWNING…');
    }

    // ---- net / fps
    const settings = this.game.settings?.data;
    const netOn = !!s.net && settings?.hud?.netIndicator !== false;
    show(this.net, netOn);
    if (netOn) {
      txt(this.netText, s.net.ping == null ? '— MS' : `${s.net.ping} MS`);
      if (this.net.dataset.q !== s.net.quality) this.net.dataset.q = s.net.quality;
      const loss = s.net.loss > 0.02;
      show(this.netLoss, loss);
      if (loss) txt(this.netLoss, `${Math.round(s.net.loss * 100)}% LOSS`);
    }
    show(this.fps, s.fps != null);
    if (s.fps != null) txt(this.fps, `${s.fps} FPS`);
    show(this.feed, settings?.hud?.killfeed !== false);

    // ---- training
    show(this.train, !!s.training);
    if (s.training) {
      const T = s.training, R = this.trainRows;
      txt(R.shots, T.shots); txt(R.hits, T.hits); txt(R.accuracy, `${T.accuracy}%`); txt(R.headshots, T.headshots);
      txt(R.damage, T.damage); txt(R.dps, T.dps); txt(R.last, T.last);
    }

    // ---- phase-dependent layout
    const hideCombat = s.phase === 'intro';
    cls(this.el, 'is-intro', hideCombat);
    cls(this.el, 'is-dead', !!s.dead);
  }

  _bump(node) {
    node.animate([{ transform: 'scale(1.6)', color: '#ffffff' }, { transform: 'scale(1)' }], { duration: 420, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  _flash(node) {
    node.animate([{ filter: 'brightness(3)' }, { filter: 'brightness(1)' }], { duration: 260 });
  }

  hitmarker(kind) {
    const el = this.hit;
    el.dataset.kind = kind;
    const big = kind === 'kill';
    el.animate(
      [
        { opacity: 1, transform: `translate(-50%,-50%) scale(${big ? 1.6 : 1.35})` },
        { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.25 },
        { opacity: 0, transform: `translate(-50%,-50%) scale(${big ? 1.15 : 1.05})` },
      ],
      { duration: big ? 520 : 260, easing: 'ease-out' },
    );
  }

  damageNumber(x, y, amount, head) {
    if (this.game.settings?.data?.camera?.damageNumbers === false) return;
    const n = this.nums[this.numNext];
    this.numNext = (this.numNext + 1) % this.nums.length;
    n.textContent = String(Math.round(amount));
    n.className = head ? 'hud-num is-head' : 'hud-num';
    const dx = (Math.random() - 0.5) * 30;
    n.style.left = `${x}px`;
    n.style.top = `${y}px`;
    n.getAnimations().forEach((a) => a.cancel());
    n.animate(
      [
        { opacity: 0, transform: `translate(-50%,-50%) scale(${head ? 1.6 : 1.2})` },
        { opacity: 1, transform: 'translate(-50%,-90%) scale(1)', offset: 0.15 },
        { opacity: 0, transform: `translate(calc(-50% + ${dx}px),-260%) scale(0.9)` },
      ],
      { duration: 850, easing: 'ease-out', fill: 'forwards' },
    );
  }

  damageIndicator(angle) {
    const a = this.dmgInd[this.dmgIndNext];
    this.dmgIndNext = (this.dmgIndNext + 1) % this.dmgInd.length;
    a.style.setProperty('--a', `${angle}rad`);
    a.getAnimations().forEach((x) => x.cancel());
    a.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 1100, easing: 'ease-out', fill: 'forwards' });
  }

  killfeed(e) {
    const row = h('div', 'hud-feed__row');
    const k = h('span', `hud-feed__name hud-feed__name--${e.killerSide === 0 ? 'p1' : e.killerSide === 1 ? 'p2' : 'env'}`, e.killer);
    const w = h('span', 'hud-feed__weapon', e.weapon);
    const v = h('span', `hud-feed__name hud-feed__name--${e.victimSide === 0 ? 'p1' : 'p2'}`, e.victim);
    row.append(k, w);
    if (e.head) row.append(h('span', 'hud-feed__hs', 'HS'));
    if (e.killerSide !== -1 || e.killer !== e.victim) row.append(v);
    this.feed.prepend(row);
    while (this.feed.children.length > 5) this.feed.lastChild.remove();
    row.animate([{ opacity: 0, transform: 'translateX(20px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    setTimeout(() => {
      const a = row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, fill: 'forwards' });
      a.onfinish = () => row.remove();
    }, 5000);
  }

  centerMessage(text, sub = '', kind = 'elim', ms = 1800) {
    txt(this.centerMain, text);
    txt(this.centerSub, sub || '');
    this.center.dataset.kind = kind;
    cls(this.centerSub, 'is-hs', sub === 'HEADSHOT');
    show(this.centerSub, !!sub);
    this.center.getAnimations().forEach((a) => a.cancel());
    this.center.animate(
      [
        { opacity: 0, transform: 'translate(-50%,0) scale(1.25)', letterSpacing: '0.4em' },
        { opacity: 1, transform: 'translate(-50%,0) scale(1)', letterSpacing: '0.12em', offset: 0.12 },
        { opacity: 1, transform: 'translate(-50%,0) scale(1)', offset: 0.85 },
        { opacity: 0, transform: 'translate(-50%,-6px) scale(0.98)' },
      ],
      { duration: ms, easing: 'ease-out', fill: 'forwards' },
    );
  }

  announce(text, kind = 'normal', ms = 2000) {
    const a = this.announcer;
    txt(a, text);
    a.dataset.kind = kind;
    a.getAnimations().forEach((x) => x.cancel());
    a.animate(
      [
        { opacity: 0, transform: 'translate(-50%,0) scaleX(1.6)', filter: 'blur(6px)' },
        { opacity: 1, transform: 'translate(-50%,0) scaleX(1)', filter: 'blur(0)', offset: 0.1 },
        { opacity: 1, transform: 'translate(-50%,0)', offset: 0.82 },
        { opacity: 0, transform: 'translate(-50%,-10px)' },
      ],
      { duration: ms, easing: 'ease-out', fill: 'forwards' },
    );
  }

  countdown(text) {
    const c = this.count;
    if (!text) {
      c.getAnimations().forEach((x) => x.cancel());
      c.style.opacity = '0';
      return;
    }
    txt(c, text);
    cls(c, 'is-fight', text === 'FIGHT');
    c.getAnimations().forEach((x) => x.cancel());
    c.animate(
      text === 'FIGHT'
        ? [{ opacity: 0, transform: 'translate(-50%,-50%) scale(2.6)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.25 }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1.05)', offset: 0.8 }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.3)' }]
        : [{ opacity: 0, transform: 'translate(-50%,-50%) scale(2)' }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)', offset: 0.22 }, { opacity: 1, offset: 0.75 }, { opacity: 0, transform: 'translate(-50%,-50%) scale(0.8)' }],
      { duration: text === 'FIGHT' ? 900 : 980, easing: 'cubic-bezier(.2,1.2,.4,1)', fill: 'forwards' },
    );
  }

  intro(stage, data = {}) {
    if (!stage) { this.intro_hide(); return; }
    this.introEl.dataset.stage = stage;
    show(this.introEl, true);
    if (stage === 'title') {
      txt(this.introTitle, data.mapName || '');
      txt(this.introSub, data.sub || '');
    } else {
      const n = data.names || ['PLAYER 1', 'PLAYER 2'];
      txt(this.vsA, n[0]);
      txt(this.vsB, n[1]);
    }
    this.introEl.getAnimations().forEach((a) => a.cancel());
    this.introEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'forwards' });
  }

  intro_hide() {
    if (this.introEl.__v === false) return;
    const a = this.introEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
    a.onfinish = () => show(this.introEl, false);
  }

  toast(text, kind = 'info') {
    const t = h('div', `hud-toast hud-toast--${kind}`, text);
    this.toasts.append(t);
    while (this.toasts.children.length > 4) this.toasts.firstChild.remove();
    t.animate([{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'ease-out' });
    setTimeout(() => {
      const a = t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' });
      a.onfinish = () => t.remove();
    }, kind === 'info' && text.length > 40 ? 4200 : 2200);
  }

  setScoreboard() { /* the Scoreboard class renders the Tab panel */ }

  setOverlay(kind, data = {}) {
    if (!kind) { show(this.overlay, false); this._overlayKind = null; return; }
    show(this.overlay, true);
    if (this._overlayKind !== kind) {
      this._overlayKind = kind;
      this.overlay.dataset.kind = kind;
    }
    if (kind === 'resume') {
      txt(this.overlayMain, 'CLICK TO RESUME');
      txt(this.overlaySub, 'Mouse look is paused');
    } else if (kind === 'disconnected') {
      txt(this.overlayMain, 'OPPONENT DISCONNECTED');
      txt(this.overlaySub, data.text || `RECONNECTING… ${Math.max(0, Math.ceil(data.remaining ?? 0))}s`);
    } else {
      txt(this.overlayMain, data.text || 'WAITING…');
      txt(this.overlaySub, data.sub || '');
    }
  }

  setDebug(visible, lines) {
    show(this.debug, !!visible);
    if (visible && lines) {
      const s = lines.join('\n');
      if (s !== this._dbg) { this._dbg = s; this.debug.textContent = s; }
    }
  }

  flashRushReady() {
    this.energy.animate([{ filter: 'brightness(2.4)', transform: 'translateX(-50%) scale(1.06)' }, { filter: 'brightness(1)', transform: 'translateX(-50%) scale(1)' }], { duration: 700, easing: 'ease-out' });
  }
}

export const HUD_COLORS = { p1: CSS_P1, p2: CSS_P2 };
