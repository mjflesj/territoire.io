// Serveur autoritaire du jeu de territoire (style paper.io)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const W = 150, H = 150;           // taille de la carte en cases
const TICK_MS = 80;               // 12,5 cases / seconde (petit tick = virages réactifs)
const MIN_PLAYERS = process.env.BOTS !== undefined ? +process.env.BOTS : 8; // complété par des bots
const MAX_HUMANS = 12;            // joueurs humains max par salle
const ROOM_COUNT = 8;
const SPAWN_R = 3;                // territoire de départ : carré 7x7

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; // haut, droite, bas, gauche
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e84393', '#34495e',
  '#a3cb38', '#6c5ce7', '#fdcb6e', '#8e5a3c', '#00cec9', '#ff9ff3', '#576574', '#b33939'];
const BOT_NAMES = ['Pixel', 'Zigzag', 'Carré', 'Ninja', 'Turbo', 'Biscotte', 'Rapido', 'Cookie',
  'Patate', 'Fusée', 'Chamallow', 'Bolide', 'Taupe', 'Gribouille', 'Comète', 'Nugget'];

const idx = (x, y) => y * W + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
let nextId = 1;
let tickNo = 0; // numéro du tick, sert au client à garder une horloge régulière

// Chaque salle est une partie indépendante avec sa propre carte
function createRoom(roomId) {
const owner = new Int32Array(W * H);  // id du propriétaire (0 = libre)
const trail = new Int32Array(W * H);  // id du joueur dont la traînée passe ici
const players = new Map();            // id -> joueur
const clients = new Set();            // sockets qui regardent ou jouent dans cette salle
let changed = new Set();              // cases dont le propriétaire a changé ce tick
let events = [];                      // événements du tick (nouveau joueur, mort)

function setOwner(i, id) {
  const old = owner[i];
  if (old === id) return;
  if (old) { const p = players.get(old); if (p) { p.area--; p.lostTo = id; } }
  if (id) { const p = players.get(id); if (p) p.area++; }
  owner[i] = id;
  changed.add(i);
}

function pickColor() {
  const used = new Set([...players.values()].map(p => p.color));
  const free = COLORS.filter(c => !used.has(c));
  const list = free.length ? free : COLORS;
  return list[Math.floor(Math.random() * list.length)];
}

const SPAWN_MARGIN = 12; // loin des bords pour ne pas mourir contre le mur dès l'apparition
function findSpawn() {
  const rnd = n => SPAWN_MARGIN + Math.floor(Math.random() * (n - 2 * SPAWN_MARGIN));
  for (let tries = 0; tries < 300; tries++) {
    const x = rnd(W), y = rnd(H);
    let ok = true;
    for (let dy = -SPAWN_R - 1; dy <= SPAWN_R + 1 && ok; dy++)
      for (let dx = -SPAWN_R - 1; dx <= SPAWN_R + 1 && ok; dx++) {
        const i = idx(x + dx, y + dy);
        if (owner[i] || trail[i]) ok = false;
      }
    for (const p of players.values()) if (Math.abs(p.x - x) + Math.abs(p.y - y) < 8) ok = false;
    if (ok) return { x, y };
  }
  return { x: rnd(W), y: rnd(H) };
}

function spawn(name, bot) {
  const id = nextId++;
  const { x, y } = findSpawn();
  // Départ orienté vers le centre de la carte
  const dir = Math.abs(x - W / 2) > Math.abs(y - H / 2) ? (x < W / 2 ? 1 : 3) : (y < H / 2 ? 2 : 0);
  const p = { id, name, bot, color: pickColor(), x, y, dir,
    queue: [], sched: [], ack: 0, trail: [], area: 0, kills: 0, alive: true, ws: null };
  players.set(id, p);
  for (let dy = -SPAWN_R; dy <= SPAWN_R; dy++)
    for (let dx = -SPAWN_R; dx <= SPAWN_R; dx++) {
      const i = idx(x + dx, y + dy);
      if (trail[i]) continue;
      setOwner(i, id);
    }
  events.push({ k: 'n', id, name, color: p.color });
  return p;
}

// reason : 'wall' (bord), 'self' (propre traînée), 'trail' (traînée coupée), 'head' (choc frontal),
// 'land' (tout le territoire capturé), 'left' (déconnexion)
function kill(p, by, reason) {
  if (!p.alive) return;
  p.alive = false;
  p.killedBy = by;
  p.reason = reason;
  if (by && by !== p.id) { const k = players.get(by); if (k) k.kills++; }
}

function removeDead(p) {
  for (const i of p.trail) if (trail[i] === p.id) trail[i] = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === p.id) owner[i] = 0;
  const killer = players.get(p.killedBy);
  const by = p.killedBy && p.killedBy !== p.id ? (killer ? killer.name : '?') : null;
  events.push({ k: 'd', id: p.id, by, r: p.reason });
  if (p.ws && p.ws.readyState === 1) {
    p.ws.send(JSON.stringify({ t: 'dead', by, reason: p.reason,
      score: +(Math.max(p.maxArea || 0, p.area) * 100 / (W * H)).toFixed(2), kills: p.kills }));
  }
  if (p.ws) p.ws.playerId = null;
  players.delete(p.id);
}

// Fermeture d'une boucle : la traînée devient territoire, puis tout ce qui
// n'est pas accessible depuis le bord de la carte sans traverser le territoire est capturé.
function capture(p) {
  for (const i of p.trail) { trail[i] = 0; setOwner(i, p.id); }
  p.trail = [];
  // Boîte englobante du territoire (+1 de marge) pour limiter le calcul
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (owner[idx(x, y)] === p.id) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  minX--; minY--; maxX++; maxY++;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const seen = new Uint8Array(bw * bh);
  const stack = [];
  const isMine = (x, y) => inBounds(x, y) && owner[idx(x, y)] === p.id;
  for (let x = 0; x < bw; x++) { stack.push(x, 0, x, bh - 1); }
  for (let y = 0; y < bh; y++) { stack.push(0, y, bw - 1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
    const s = y * bw + x;
    if (seen[s] || isMine(x + minX, y + minY)) continue;
    seen[s] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    if (!seen[y * bw + x]) setOwner(idx(x + minX, y + minY), p.id);
  }
}

// --- IA des bots ---
function botThink(b) {
  const safe = d => {
    if ((d + 2) % 4 === b.dir) return false;
    const nx = b.x + DX[d], ny = b.y + DY[d];
    if (!inBounds(nx, ny)) return false;
    return trail[idx(nx, ny)] !== b.id;
  };
  const inside = owner[idx(b.x, b.y)] === b.id;
  const safeDirs = [0, 1, 2, 3].filter(safe);
  if (!safeDirs.length) return;
  let d = b.dir;
  if (inside) {
    b.limit = 6 + Math.floor(Math.random() * 22);
    if (!safe(d) || Math.random() < 0.12) d = safeDirs[Math.floor(Math.random() * safeDirs.length)];
  } else {
    const threat = [...players.values()].some(o => o !== b && Math.abs(o.x - b.x) + Math.abs(o.y - b.y) < 6);
    if (b.trail.length >= b.limit || (threat && b.trail.length > 3)) {
      const step = bfsHome(b);
      if (step !== -1) d = step;
      else if (!safe(d)) d = safeDirs[0];
    } else if (!safe(d) || Math.random() < 0.15) {
      d = safeDirs[Math.floor(Math.random() * safeDirs.length)];
    }
  }
  b.queue = [d];
}

function bfsHome(b) {
  const prev = new Map();
  const q = [];
  for (let d = 0; d < 4; d++) {
    if ((d + 2) % 4 === b.dir) continue;
    const nx = b.x + DX[d], ny = b.y + DY[d];
    if (!inBounds(nx, ny)) continue;
    const i = idx(nx, ny);
    if (trail[i] === b.id) continue;
    if (owner[i] === b.id) return d;
    prev.set(i, d); q.push(i);
  }
  for (let h = 0; h < q.length && h < 3000; h++) {
    const i = q[h], x = i % W, y = (i - x) / W, d0 = prev.get(i);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!inBounds(nx, ny)) continue;
      const j = idx(nx, ny);
      if (prev.has(j) || trail[j] === b.id) continue;
      if (owner[j] === b.id) return d0;
      prev.set(j, d0); q.push(j);
    }
  }
  return -1;
}

function balanceBots() {
  const humans = [...players.values()].filter(p => !p.bot).length;
  const bots = [...players.values()].filter(p => p.bot);
  const wanted = Math.max(0, MIN_PLAYERS - humans);
  // Les bots en trop ne sont pas supprimés (ça ressemblait à une mort sans raison) :
  // ils ne réapparaissent simplement pas après leur prochaine mort.
  if (bots.length < wanted && Math.random() < 0.2) {
    const used = new Set([...players.values()].map(p => p.name));
    const names = BOT_NAMES.filter(n => !used.has(n));
    spawn(names[Math.floor(Math.random() * names.length)] || 'Bot', true);
  }
}

// --- Boucle de jeu ---
function tick() {
  // Salle sans personne : on la met en pause
  if (!clients.size && ![...players.values()].some(p => !p.bot)) return;
  balanceBots();
  const alive = [...players.values()].filter(p => p.alive);
  for (const p of alive) {
    if (p.bot) botThink(p);
    // Virages des humains : chacun est prévu pour un tick précis (calculé par le client, qui joue
    // un peu en avance) afin que le serveur tourne exactement sur la même case que l'écran.
    while (p.sched.length && p.sched[0].k <= tickNo) {
      const { d, s } = p.sched.shift();
      p.ack = s; // dernier virage traité, renvoyé au client
      if (d !== p.dir && (d + 2) % 4 !== p.dir) { p.dir = d; break; }
    }
    while (p.queue.length) {
      const d = p.queue.shift();
      if (d !== p.dir && (d + 2) % 4 !== p.dir) { p.dir = d; break; }
    }
    p.x += DX[p.dir]; p.y += DY[p.dir];
  }
  // Collisions
  for (const p of alive) {
    if (!inBounds(p.x, p.y)) { kill(p, p.id, 'wall'); continue; }
    const t = trail[idx(p.x, p.y)];
    if (t) kill(players.get(t), p.id, t === p.id ? 'self' : 'trail');
  }
  for (let a = 0; a < alive.length; a++) for (let b = a + 1; b < alive.length; b++) {
    const p = alive[a], q = alive[b];
    if (p.x !== q.x || p.y !== q.y || !inBounds(p.x, p.y)) continue;
    const o = owner[idx(p.x, p.y)];
    if (o === p.id) kill(q, p.id, 'head');
    else if (o === q.id) kill(p, q.id, 'head');
    else { kill(p, q.id, 'head'); kill(q, p.id, 'head'); }
  }
  for (const p of alive) if (!p.alive) removeDead(p);
  // Déplacements : traînée ou capture
  for (const p of alive) {
    if (!p.alive) continue;
    const i = idx(p.x, p.y);
    if (owner[i] === p.id) { if (p.trail.length) capture(p); }
    else { trail[i] = p.id; p.trail.push(i); }
  }
  for (const p of [...players.values()]) if (p.alive && p.area <= 0) { kill(p, p.lostTo || p.id, 'land'); removeDead(p); }
  for (const p of players.values()) p.maxArea = Math.max(p.maxArea || 0, p.area);
  broadcast();
}

function encodeChanges() {
  const list = [...changed].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < list.length;) {
    const start = list[k], o = owner[start];
    let len = 1;
    while (k + len < list.length && list[k + len] === start + len && owner[start + len] === o) len++;
    out.push(start, len, o);
    k += len;
  }
  return out;
}

function playerState(p) { return [p.id, p.x, p.y, p.dir, p.trail.length, p.area, p.kills, p.ack]; }

function broadcast() {
  const msg = JSON.stringify({ t: 's', n: tickNo, e: events, c: encodeChanges(),
    p: [...players.values()].map(playerState) });
  changed = new Set(); events = [];
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

function fullState() {
  const grid = [];
  for (let i = 0; i < owner.length;) {
    let len = 1;
    while (i + len < owner.length && owner[i + len] === owner[i]) len++;
    grid.push(owner[i], len); i += len;
  }
  return { t: 'init', room: roomId, n: tickNo, w: W, h: H, tick: TICK_MS, grid,
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, s: playerState(p), trail: p.trail })) };
}

function humans() { return [...players.values()].filter(p => !p.bot).length; }

return {
  id: roomId, clients, tick, humans,
  info: () => ({ id: roomId, humans: humans(), total: players.size }),
  watch(ws) { clients.add(ws); ws.send(JSON.stringify(fullState())); },
  // Retour à l'accueil en pleine partie : le joueur disparaît, le socket reste spectateur
  quit(ws) {
    const p = players.get(ws.playerId);
    if (p) { p.ws = null; kill(p, null, 'left'); removeDead(p); }
    ws.playerId = null;
  },
  leave(ws) {
    clients.delete(ws);
    const p = players.get(ws.playerId);
    if (p) { p.ws = null; kill(p, null, 'left'); removeDead(p); }
    ws.playerId = null;
  },
  join(ws, name) {
    if (humans() >= MAX_HUMANS) return false;
    const p = spawn(name, false);
    p.ws = ws; ws.playerId = p.id;
    ws.send(JSON.stringify({ t: 'you', id: p.id, x: p.x, y: p.y, dir: p.dir }));
    return true;
  },
  input(ws, d, k, s) {
    const p = players.get(ws.playerId);
    if (!p || !p.alive || p.sched.length >= 4) return;
    if (!(k > tickNo && k < tickNo + 40)) k = tickNo + 1; // en retard ou invalide : au prochain tick
    const last = p.sched[p.sched.length - 1];
    if (last && k <= last.k) k = last.k + 1;
    p.sched.push({ d, k, s });
  },
};
}

const rooms = Array.from({ length: ROOM_COUNT }, (_, i) => createRoom(i));
const roomList = () => ({ t: 'rooms', max: MAX_HUMANS, rooms: rooms.map(r => r.info()) });

// --- Serveur HTTP + WebSocket ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
function watch(ws, r) {
  const room = rooms[r] || rooms[0];
  if (ws.room === room) return;
  if (ws.room) ws.room.leave(ws);
  ws.room = room;
  room.watch(ws);
}
wss.on('connection', ws => {
  ws.send(JSON.stringify(roomList()));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'watch') {
      if (!ws.playerId) watch(ws, m.r | 0);
    } else if (m.t === 'join' && !ws.playerId) {
      watch(ws, m.r | 0);
      const name = String(m.name || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Anonyme';
      if (!ws.room.join(ws, name)) ws.send(JSON.stringify({ t: 'full' }));
    } else if (m.t === 'dir' && ws.room) {
      const d = m.d | 0;
      if (d >= 0 && d < 4) ws.room.input(ws, d, +m.k || 0, +m.s || 0);
    } else if (m.t === 'quit' && ws.room) {
      ws.room.quit(ws);
    } else if (m.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', c: m.c }));
    }
  });
  ws.on('close', () => { if (ws.room) ws.room.leave(ws); });
});

// Boucle à pas fixe sans dérive (setInterval prend du retard et rend les ticks irréguliers)
let nextTick = Date.now();
(function loop() {
  tickNo++;
  for (const r of rooms) r.tick();
  nextTick += TICK_MS;
  if (Date.now() - nextTick > 1000) nextTick = Date.now(); // gros retard : on repart sans rattraper
  setTimeout(loop, Math.max(0, nextTick - Date.now()));
})();
setInterval(() => {
  const msg = JSON.stringify(roomList());
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}, 2000);
server.listen(PORT, () => console.log(`Serveur lancé sur http://localhost:${PORT}`));
