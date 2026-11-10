'use strict';
/* Truco Online - servidor Node.js. Sem dependências: npm start */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const PORT = +process.env.PORT || 3000, TARGET = 12;

/* ================= baralho ================= */
const RANKS = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];   // fraca -> forte
const SUITS = ['♦', '♠', '♥', '♣'];                                   // fraco -> forte (entre destaques)
const newDeck = () => RANKS.flatMap(r => SUITS.map(s => ({ r, s })));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const power = (c, hl) => c.r === hl ? 100 + SUITS.indexOf(c.s) : RANKS.indexOf(c.r);
const nextRank = c => RANKS[(RANKS.indexOf(c.r) + 1) % RANKS.length];
const STEPS = [1, 3, 6, 9, 12], LABEL = { 3: 'DESAFIO', 6: 'DOBRO', 9: 'TRIPLO', 12: 'MÁXIMO' };

/* ================= estado global ================= */
const players = new Map();          // id -> {id,name,team,c,on}
let order = [], hostId = null, phase = 'lobby', G = null;
const cfg = { mode: 'dupla', assign: 'escolher' };
const chat = [];

const ent = s => G.team ? s % 2 : s;
const nm = s => players.get(G.seats[s]).name;
const entName = e => G.team ? 'Time ' + (e + 1) : nm(e);

/* ================= rede (WebSocket manual) ================= */
function frame(str) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
const wsend = (c, o) => { if (c && !c.sock.destroyed) try { c.sock.write(frame(JSON.stringify(o))); } catch (e) { } };
const send = (p, o) => p && wsend(p.c, o);
const err = (p, x) => send(p, { t: 'err', x });

function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const op = b[0] & 15; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 200000) return c.sock.destroy();
    const masked = b[1] & 128; if (masked) off += 4;
    if (b.length < off + len) return;
    let pl = Buffer.from(b.slice(off, off + len));
    if (masked) { const m = b.slice(off - 4, off); for (let i = 0; i < pl.length; i++) pl[i] ^= m[i & 3]; }
    c.buf = b.slice(off + len);
    if (op === 8) return c.sock.end();
    if (op === 9 && pl.length < 126) c.sock.write(Buffer.concat([Buffer.from([0x8a, pl.length]), pl]));
    else if (op === 1) handle(c, pl.toString());
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { res.writeHead(500); return res.end('index.html não encontrado ao lado do servidor.'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(d);
    });
  } else { res.writeHead(404); res.end(); }
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']; if (!key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), id: null };
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  sock.on('close', () => drop(c));
  sock.on('error', () => sock.destroy());
});
setInterval(() => { for (const p of players.values()) if (p.c && !p.c.sock.destroyed) try { p.c.sock.write(Buffer.from([0x89, 0])); } catch (e) { } }, 30000);

/* ================= sala / chat ================= */
function pushChat(o) { o.ts = Date.now(); chat.push(o); if (chat.length > 200) chat.shift(); for (const q of players.values()) send(q, { t: 'chat', m: o }); }
const sys = x => pushChat({ sys: 1, x });

function rebind(p, id) {
  const o = p.id; players.delete(o); p.id = id; players.set(id, p);
  order = order.map(x => x === o ? id : x);
  if (G) G.seats = G.seats.map(x => x === o ? id : x);
  if (hostId === o) hostId = id;
}

function join(c, m) {
  const id = String(m.id || '').slice(0, 60); let name = String(m.name || '').trim().slice(0, 16);
  if (!id || !name) return;
  let p = players.get(id), fresh = false;
  if (!p) {
    const old = [...players.values()].find(q => !q.on && q.name.toLowerCase() === name.toLowerCase());
    if (old) { rebind(old, id); p = old; }
    else if (phase !== 'lobby') return wsend(c, { t: 'err', x: 'Há uma partida em andamento. Para reassumir um lugar, entre com o mesmo nome de um jogador desconectado.' });
    else if (players.size >= 6) return wsend(c, { t: 'err', x: 'Mesa cheia (máximo de 6 jogadores).' });
    else {
      const used = [...players.values()].map(q => q.name.toLowerCase()), base = name; let k = 2;
      while (used.includes(name.toLowerCase())) name = base.slice(0, 13) + ' ' + (k++);
      p = { id, name, team: null, c: null, on: false }; players.set(id, p); order.push(id); fresh = true;
      if (!hostId) hostId = id;
    }
  }
  if (p.c && p.c !== c) { const o = p.c; p.c = null; try { o.sock.destroy(); } catch (e) { } }
  const was = p.on; p.c = c; p.on = true; c.id = id; clearTimeout(p.drop);
  send(p, { t: 'hello', id, name: p.name });
  send(p, { t: 'hist', chat: chat.slice(-80) });
  if (fresh) sys(p.name + ' entrou na mesa.'); else if (!was) sys(p.name + ' voltou.');
  broadcast();
}

function drop(c) {
  const p = c.id && players.get(c.id); if (!p || p.c !== c) return;
  p.on = false; p.c = null;
  if (phase === 'lobby') {
    p.drop = setTimeout(() => {
      if (!p.on && phase === 'lobby' && players.has(p.id)) {
        players.delete(p.id); order = order.filter(x => x !== p.id);
        if (hostId === p.id) hostId = order.find(i => players.get(i).on) || order[0] || null;
        sys(p.name + ' saiu.'); broadcast();
      }
    }, 8000);
  } else {
    sys(p.name + ' desconectou.');
    if (hostId === p.id) { const n = order.find(i => players.get(i).on); if (n) hostId = n; }
  }
  broadcast();
}

function handle(c, raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (m.t === 'join') return join(c, m);
  const p = c.id && players.get(c.id); if (!p) return;
  const s = G ? G.seats.indexOf(p.id) : -1;
  switch (m.t) {
    case 'chat': { const x = String(m.x || '').trim().slice(0, 300); if (x) pushChat({ n: p.name, x }); break; }
    case 'cfg':
      if (p.id !== hostId || phase !== 'lobby') return;
      if (['dupla', 'trio', 'solo'].includes(m.mode)) cfg.mode = m.mode;
      if (['escolher', 'sorteio'].includes(m.assign)) cfg.assign = m.assign;
      broadcast(); break;
    case 'team': if (phase !== 'lobby') return; p.team = (m.team === 0 || m.team === 1) ? m.team : null; broadcast(); break;
    case 'start': if (p.id === hostId && phase === 'lobby') startGame(p); break;
    case 'quit': if (p.id === hostId && G) resetToLobby(); break;
    case 'cut': doCut(s, m.pos); break;
    case 'decide': decide(s, !!m.play); break;
    case 'play': playCard(s, m.i | 0, !!m.cov); break;
    case 'raise': if (G && canRaise(s)) { const h = G.hand; startPending(s, STEPS[STEPS.indexOf(h.stake) + 1], h.stake); broadcast(); } break;
    case 'ans': if (G && G.hand) answer(s, m.a); break;
  }
}

/* ================= início da partida ================= */
function startGame(host) {
  const list = order.map(i => players.get(i)), n = list.length, need = { dupla: 4, trio: 6 }[cfg.mode];
  if (need && n !== need) return err(host, `Este modo precisa de ${need} jogadores (há ${n} na mesa).`);
  if (cfg.mode === 'solo' && (n < 2 || n > 6)) return err(host, 'Todos contra todos: de 2 a 6 jogadores.');
  const team = cfg.mode !== 'solo'; let seats;
  if (!team) seats = cfg.assign === 'sorteio' ? shuffle(list) : list.slice();
  else {
    let A, B;
    if (cfg.assign === 'sorteio') { const s = shuffle(list); A = s.slice(0, n / 2); B = s.slice(n / 2); }
    else {
      A = list.filter(p => p.team === 0); B = list.filter(p => p.team === 1);
      if (A.length !== n / 2 || B.length !== n / 2) return err(host, `Os times precisam ter ${n / 2} jogador(es) cada. Todos devem escolher um time.`);
    }
    seats = []; for (let i = 0; i < n / 2; i++) seats.push(A[i], B[i]);
  }
  G = { team, n, seats: seats.map(p => p.id), score: Array(team ? 2 : n).fill(0), dealer: crypto.randomInt(n), hand: null, winner: null, next: null, vz: null };
  phase = 'game';
  sys('Partida iniciada (' + (team ? 'times de ' + n / 2 : 'todos contra todos') + '). Primeiro a chegar em ' + TARGET + ' pontos vence.');
  if (team) for (let e = 0; e < 2; e++) sys('Time ' + (e + 1) + ': ' + G.seats.map((_, s) => s).filter(s => ent(s) === e).map(nm).join(' e '));
  newHand();
}

function resetToLobby() {
  if (G) { clearTimeout(G.next); clearTimeout(G.vz); if (G.hand) clearTimeout(G.hand.timer); }
  G = null; phase = 'lobby';
  for (const q of [...players.values()]) if (!q.on) { players.delete(q.id); order = order.filter(x => x !== q.id); }
  if (!players.has(hostId)) hostId = order[0] || null;
  sys('Voltamos para a sala.'); broadcast();
}

/* ================= mão ================= */
function newHand() {
  G.dealer = (G.dealer + 1) % G.n;
  const cutter = (G.dealer + 1) % G.n;
  const h = G.hand = {
    stage: 'cut', deck: shuffle(newDeck()), cutter, mao: cutter, cards: Array.from({ length: G.n }, () => []),
    alive: Array(G.n).fill(true), stake: 1, kind: 'normal', table: [], vazas: [], lead: cutter, turn: cutter,
    lastRaiser: null, pending: null, result: null, vira: null, hl: null, onze: null, timer: null
  };
  const at = G.score.map((s, e) => s === 11 ? e : -1).filter(e => e >= 0);
  if (at.length >= 2) h.kind = 'ferro'; else if (at.length === 1) { h.kind = 'onze'; h.onze = at[0]; }
  h.timer = setTimeout(() => doCut(cutter, 1 + crypto.randomInt(39)), 40000);
  sys(nm(cutter) + ' corta o baralho.');
  broadcast();
}

function doCut(s, pos) {
  const h = G && G.hand; if (!h || h.stage !== 'cut' || h.cutter !== s) return;
  clearTimeout(h.timer);
  pos = Math.max(1, Math.min(39, pos | 0));
  h.deck = h.deck.slice(pos).concat(h.deck.slice(0, pos));
  for (let k = 0; k < 3; k++) for (let i = 0; i < G.n; i++) h.cards[(h.mao + i) % G.n].push(h.deck.shift());
  h.vira = h.deck.shift(); h.hl = nextRank(h.vira);
  if (h.kind === 'onze') { h.stage = 'decide'; sys(entName(h.onze) + ' está com 11 pontos e decide se joga.'); }
  else { h.stage = 'play'; if (h.kind === 'ferro') sys('Rodada às cegas: ninguém vê as próprias cartas e não há aumento.'); }
  broadcast();
}

function decide(s, play) {
  const h = G && G.hand; if (!h || h.stage !== 'decide' || s < 0 || ent(s) !== h.onze) return;
  if (play) { h.stake = 3; h.stage = 'play'; sys(entName(h.onze) + ' joga a rodada 11 (vale 3).'); broadcast(); }
  else {
    const list = []; for (let e = 0; e < G.score.length; e++) if (e !== h.onze) list.push([e, 1]);
    award(list, entName(h.onze) + ' recuou da rodada 11. Adversários ganham 1.');
  }
}

const canRaise = s => {
  const h = G && G.hand;
  return s >= 0 && !!h && h.stage === 'play' && !h.pending && h.kind === 'normal' && h.turn === s && h.alive[s] && h.stake < 12 && h.lastRaiser !== ent(s);
};

function startPending(s, v, from) {
  const h = G.hand, opp = [];
  for (let k = 1; k < G.n; k++) { const q = (s + k) % G.n; if (h.alive[q] && ent(q) !== ent(s)) opp.push(q); }
  h.pending = { caller: s, value: v, from, resp: G.team ? opp.slice(0, 1) : opp, idx: 0 };
  sys(nm(s) + ': ' + LABEL[v] + ' (' + v + ')!');
}

function answer(s, a) {
  const h = G.hand, p = h.pending; if (!p || p.resp[p.idx] !== s) return;
  if (a === 'aumentar') {
    if (p.value >= 12) return;
    h.lastRaiser = ent(p.caller);
    startPending(s, STEPS[STEPS.indexOf(p.value) + 1], p.value);
    return broadcast();
  }
  if (a === 'recuar') {
    for (let q = 0; q < G.n; q++) if (ent(q) === ent(s)) { h.alive[q] = false; h.cards[q] = []; }
    h.table = h.table.filter(t => h.alive[t.seat]);
    sys(nm(s) + ' recuou.');
  } else if (a === 'aceitar') sys(nm(s) + ' aceitou.');
  else return;
  p.idx++;
  if (p.idx >= p.resp.length) settle(); else broadcast();
}

function settle() {
  const h = G.hand, p = h.pending; h.pending = null;
  const es = new Set(); for (let q = 0; q < G.n; q++) if (h.alive[q]) es.add(ent(q));
  if (es.size <= 1) { const w = es.size ? [...es][0] : ent(p.caller); return award([[w, p.from]], entName(w) + ' ganha ' + p.from + ' (adversário recuou).'); }
  h.stake = p.value; h.lastRaiser = ent(p.caller);
  advance(); broadcast();
}

function playCard(s, i, cov) {
  const h = G && G.hand; if (!h || s < 0 || h.stage !== 'play' || h.pending || h.turn !== s || !h.alive[s]) return;
  const c = h.cards[s][i]; if (!c) return;
  cov = cov && h.vazas.length > 0 && h.kind !== 'ferro';
  h.cards[s].splice(i, 1); h.table.push({ seat: s, card: c, covered: cov });
  advance(); broadcast();
}

function advance() {
  const h = G.hand, al = []; for (let s = 0; s < G.n; s++) if (h.alive[s]) al.push(s);
  const pl = new Set(h.table.map(t => t.seat));
  if (al.every(s => pl.has(s))) { h.stage = 'resolving'; G.vz = setTimeout(finishVaza, 1600); return; }
  let s = h.turn, g = 0; while ((!h.alive[s] || pl.has(s)) && g++ < G.n) s = (s + 1) % G.n;
  h.turn = s;
}

function finishVaza() {
  const h = G && G.hand; if (!h || h.stage !== 'resolving') return;
  let best = -2, win = [];
  for (const t of h.table) { const pw = t.covered ? -1 : power(t.card, h.hl); if (pw > best) { best = pw; win = [t]; } else if (pw === best) win.push(t); }
  const es = new Set(win.map(t => ent(t.seat)));
  let w = null; if (es.size === 1) { w = [...es][0]; h.lead = win[0].seat; }
  h.vazas.push(w); h.table = []; h.stage = 'play';
  const dead = new Set(); for (let e = 0; e < G.score.length; e++) if (!G.seats.some((_, s) => ent(s) === e && h.alive[s])) dead.add(e);
  const r = h.vazas.map(e => e !== null && dead.has(e) ? null : e), cnt = {};
  r.forEach(e => { if (e !== null) cnt[e] = (cnt[e] || 0) + 1; });
  let hw = null; for (const e in cnt) if (cnt[e] >= 2) hw = +e;
  if (hw === null) {
    if (r.length === 2) { if (r[0] !== null && r[1] === null) hw = r[0]; else if (r[0] === null && r[1] !== null) hw = r[1]; }
    else if (r.length >= 3) hw = r[0] ?? r[1] ?? r[2] ?? ent(h.mao);
  }
  if (hw !== null) return award([[hw, h.stake]], entName(hw) + ' vence a mão (+' + h.stake + ').');
  h.turn = h.lead; advance(); broadcast();
}

function award(list, text) {
  const h = G.hand; for (const [e, p] of list) G.score[e] += p;
  h.stage = 'ended'; h.result = text; h.pending = null; sys(text);
  const top = Math.max(...G.score);
  if (top >= TARGET) { G.winner = G.score.indexOf(top); phase = 'over'; sys('🏆 ' + entName(G.winner) + ' venceu a partida!'); }
  else G.next = setTimeout(newHand, 4200);
  broadcast();
}

/* ================= visão de cada jogador ================= */
function view(id) {
  const v = { t: 'st', phase, cfg, host: hostId, me: id, lobby: order.map(i => { const q = players.get(i); return { id: i, name: q.name, team: q.team, on: q.on }; }) };
  if (!G) return v;
  const h = G.hand, ms = G.seats.indexOf(id);
  v.g = {
    n: G.n, team: G.team, me: ms, score: G.score, target: TARGET, dealer: G.dealer, winner: G.winner,
    ents: G.score.map((_, e) => entName(e)),
    seats: G.seats.map((sid, s) => { const q = players.get(sid); return { name: q.name, ent: ent(s), on: q.on, n: h ? h.cards[s].length : 0, alive: h ? h.alive[s] : true }; })
  };
  if (h) {
    const o = v.g.h = {
      stage: h.stage, kind: h.kind, stake: h.stake, vira: h.vira, hl: h.hl, turn: h.turn, cutter: h.cutter, vazas: h.vazas,
      table: h.table.map(t => ({ seat: t.seat, card: t.covered && t.seat !== ms ? null : t.card, cov: t.covered })),
      pend: h.pending ? { caller: h.pending.caller, value: h.pending.value, who: h.pending.resp[h.pending.idx] } : null,
      res: h.result, onze: h.onze, can: canRaise(ms)
    };
    if (ms >= 0) {
      o.my = h.kind === 'ferro' ? h.cards[ms].map(() => null) : h.cards[ms];
      if (h.kind === 'onze' && G.team && ent(ms) === h.onze) { o.mates = {}; G.seats.forEach((_, s) => { if (s !== ms && ent(s) === h.onze) o.mates[s] = h.cards[s]; }); }
    }
  }
  return v;
}
function broadcast() { for (const q of players.values()) if (q.c) send(q, view(q.id)); }

/* ================= iniciar ================= */
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Truco Online no ar!  (Ctrl+C para parar)\n');
  console.log('  Neste computador:  http://localhost:' + PORT);
  for (const l of Object.values(os.networkInterfaces())) for (const i of l || [])
    if ((i.family === 'IPv4' || i.family === 4) && !i.internal) console.log('  Para os outros:    http://' + i.address + ':' + PORT);
  console.log('');
});
