// Tab scoreboard + end-of-match VICTORY / DEFEAT screen (prefix hud-).

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const COLS = [
  ['name', 'PLAYER'], ['kills', 'K'], ['deaths', 'D'], ['accuracy', 'ACC'], ['damage', 'DMG'], ['headshots', 'HS'], ['ping', 'PING'], ['score', 'SCORE'],
];

export class Scoreboard {
  constructor(root, game) {
    this.game = game;
    this.el = h('div', 'hud-board');
    this.el.style.display = 'none';
    this.title = h('div', 'hud-board__title');
    this.meta = h('div', 'hud-board__meta');
    const head = h('div', 'hud-board__head');
    head.append(this.title, this.meta);
    this.table = h('div', 'hud-board__table');
    const hr = h('div', 'hud-board__row hud-board__row--head');
    for (const [, label] of COLS) hr.append(h('span', null, label));
    this.table.append(hr);
    this.rows = [];
    for (let i = 0; i < 2; i++) {
      const r = h('div', 'hud-board__row');
      const cells = {};
      for (const [k] of COLS) {
        const c = h('span', `hud-board__c hud-board__c--${k}`);
        r.append(c);
        cells[k] = c;
      }
      cells.you = h('span', 'hud-board__you', 'YOU');
      this.table.append(r);
      this.rows.push({ el: r, cells });
    }
    this.el.append(head, this.table, h('div', 'hud-board__foot', 'FIRST TO 15 ELIMINATIONS · 8:00 · SUDDEN DEATH ON TIE'));
    root.append(this.el);
  }

  setVisible(v) {
    this.el.style.display = v ? '' : 'none';
  }

  update(d) {
    this.title.textContent = d.mode === 'training' ? 'TRAINING GROUNDS' : d.mode === 'bot' ? 'PRACTICE DUEL' : 'ONLINE DUEL';
    this.meta.textContent = `${d.map || ''}${d.timeText ? '  ·  ' + d.timeText : ''}`;
    const rows = d.rows || [];
    for (let i = 0; i < 2; i++) {
      const r = this.rows[i];
      const data = rows[i];
      r.el.style.display = data ? '' : 'none';
      if (!data) continue;
      r.el.className = `hud-board__row hud-board__row--${data.side === 0 ? 'p1' : 'p2'}${data.isMe ? ' is-me' : ''}`;
      const c = r.cells;
      c.name.textContent = data.name;
      if (data.isMe) c.name.append(c.you);
      c.kills.textContent = data.kills;
      c.deaths.textContent = data.deaths;
      c.accuracy.textContent = `${data.accuracy}%`;
      c.damage.textContent = data.damage;
      c.headshots.textContent = data.headshots;
      c.ping.textContent = data.ping == null ? '—' : data.isMe ? '—' : `${data.ping}`;
      c.score.textContent = data.score;
    }
  }
}

const STAT_ROWS = [
  ['kills', 'KILLS', (v) => v, 1],
  ['deaths', 'DEATHS', (v) => v, -1],
  ['accuracy', 'ACCURACY', (v) => `${v}%`, 1],
  ['headshots', 'HEADSHOTS', (v) => v, 1],
  ['damage', 'DAMAGE', (v) => v, 1],
  ['longestKill', 'LONGEST KILL', (v) => `${v} M`, 1],
  ['rushes', 'ENERGY RUSHES', (v) => v, 1],
];
const REASONS = { kills: 'FIRST TO 15', time: 'TIME LIMIT', suddendeath: 'SUDDEN DEATH', forfeit: 'OPPONENT FORFEITED' };

export class EndScreen {
  constructor(root, game) {
    this.game = game;
    this.el = h('div', 'hud-end');
    this.el.style.display = 'none';
    this.sweep = h('div', 'hud-end__sweep');
    this.result = h('div', 'hud-end__result');
    this.reason = h('div', 'hud-end__reason');
    this.score = h('div', 'hud-end__score');
    this.table = h('div', 'hud-end__table');
    this.status = h('div', 'hud-end__status');
    const btns = h('div', 'hud-end__btns');
    const mk = (label, cls, fn) => {
      const b = h('button', `hud-end__btn ${cls}`);
      b.type = 'button';
      b.append(h('span', 'hud-end__btnfill'), h('span', 'hud-end__btnlabel', label));
      b.addEventListener('click', fn); // menu sounds come from the UI manager's delegated listener
      btns.append(b);
      return b;
    };
    this.rematchBtn = mk('REMATCH', 'is-primary', () => {
      game.actions.rematch();
    });
    this.mapBtn = mk('CHANGE MAP', '', () => game.actions.changeMap());
    this.menuBtn = mk('MAIN MENU', 'is-ghost', () => game.actions.mainMenu());
    const panel = h('div', 'hud-end__panel');
    panel.append(this.result, this.reason, this.score, this.table, this.status, btns);
    this.el.append(this.sweep, panel);
    root.append(this.el);
  }

  show(d) {
    this.data = d;
    const victory = d.result === 'victory';
    this.el.dataset.result = d.result;
    this.el.style.display = '';
    this.result.textContent = victory ? 'VICTORY' : 'DEFEAT';
    this.result.dataset.text = this.result.textContent;
    this.reason.textContent = `${REASONS[d.reason] || ''}${d.map ? '  ·  ' + d.map : ''}`;
    const [a, b] = d.stats;
    this.score.innerHTML = '';
    const sideEl = (i) => {
      const s = h('div', `hud-end__side hud-end__side--${i ? 'p2' : 'p1'}${d.myIndex === i ? ' is-me' : ''}`);
      s.append(h('span', 'hud-end__name', d.names[i] || d.stats[i]?.name || `PLAYER ${i + 1}`), h('span', 'hud-end__kills', String(d.stats[i]?.kills ?? 0)));
      if (d.winnerIndex === i) s.append(h('span', 'hud-end__crown', 'WINNER'));
      return s;
    };
    this.score.append(sideEl(0), h('span', 'hud-end__dash', '—'), sideEl(1));
    this.table.innerHTML = '';
    const head = h('div', 'hud-end__row hud-end__row--head');
    head.append(h('span', 'hud-end__v hud-end__v--p1', d.names[0]), h('span', 'hud-end__k', 'MATCH STATS'), h('span', 'hud-end__v hud-end__v--p2', d.names[1]));
    this.table.append(head);
    STAT_ROWS.forEach(([key, label, fmt, better], idx) => {
      const va = a?.[key] ?? 0, vb = b?.[key] ?? 0;
      const row = h('div', 'hud-end__row');
      const ca = h('span', 'hud-end__v hud-end__v--p1', String(fmt(va)));
      const cb = h('span', 'hud-end__v hud-end__v--p2', String(fmt(vb)));
      if (va !== vb) ((va - vb) * better > 0 ? ca : cb).classList.add('is-best');
      row.append(ca, h('span', 'hud-end__k', label), cb);
      row.style.animationDelay = `${600 + idx * 70}ms`;
      this.table.append(row);
    });
    this.mapBtn.style.display = d.mode === 'training' ? 'none' : '';
    this.setRematchStatus({ me: false, them: false, online: d.mode === 'duel' });
    this.el.classList.remove('is-in');
    void this.el.offsetWidth;
    this.el.classList.add('is-in');
  }

  setRematchStatus(s) {
    if (!this.data) return;
    const online = !!s.online;
    this.rematchBtn.classList.toggle('is-pressed', online && !!s.me);
    this.rematchBtn.querySelector('.hud-end__btnlabel').textContent = online && s.me ? `WAITING… (${(s.me ? 1 : 0) + (s.them ? 1 : 0)}/2)` : 'REMATCH';
    let msg = '';
    if (online) {
      if (s.them && !s.me) msg = 'OPPONENT WANTS A REMATCH';
      else if (s.me && !s.them) msg = 'WAITING FOR OPPONENT…';
    }
    this.status.textContent = msg;
    this.status.classList.toggle('is-hot', !!s.them && !s.me);
  }

  hide() {
    this.el.style.display = 'none';
  }
}
