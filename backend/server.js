const express = require('express');
const path = require('path');
const fs   = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const CELL_SIZE  = 0.001;
const RESPAWN_MS = 5 * 60_000; // 5 minutes

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── JSON file store (no native deps needed) ───────────────────────────────

const DB_FILE = path.join(__dirname, 'game.json');

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {
    return { players: {}, collected: {} };
  }
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data), 'utf8');
}

// ── Shared hash/resource logic (mirrors client) ───────────────────────────

function hash32(x, y) {
  let h = Math.imul(x, 0x9e3779b9) ^ Math.imul(y, 0x517cc1b7);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 1 | s);
    s ^= s + Math.imul(s ^ (s >>> 7), 61 | s);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

const RESOURCE_TYPES = ['wood', 'stone', 'iron', 'food', 'gold', 'gem'];
const WEIGHTS        = [0.35,   0.25,   0.18,  0.12,  0.06,  0.04];

function getResourceType(gridX, gridY) {
  const rng = seededRandom(hash32(gridX, gridY));
  if (rng() > 0.15) return null;
  const roll = rng();
  let cum = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    cum += WEIGHTS[i];
    if (roll < cum) return RESOURCE_TYPES[i];
  }
  return RESOURCE_TYPES[0];
}

function latLngToGrid(lat, lng) {
  return {
    gridX: Math.floor(lng / CELL_SIZE),
    gridY: Math.floor(lat / CELL_SIZE),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────

app.post('/api/player/join', (req, res) => {
  const { name, lat, lng } = req.body;
  if (!name || lat == null || lng == null)
    return res.status(400).json({ error: 'missing fields' });

  const { gridX, gridY } = latLngToGrid(lat, lng);
  const now = Date.now();
  const data = loadDb();

  let player = Object.values(data.players).find(p => p.name === name);
  if (!player) {
    const id = uuidv4();
    player = { id, name, lat, lng, gridX, gridY, last_seen: now, inventory: {} };
    data.players[id] = player;
  } else {
    Object.assign(player, { lat, lng, gridX, gridY, last_seen: now });
  }

  saveDb(data);
  res.json({ id: player.id, name: player.name, lat, lng, gridX, gridY, inventory: player.inventory });
});

app.post('/api/player/move', (req, res) => {
  const { playerId, lat, lng, gridX, gridY } = req.body;
  const data = loadDb();
  if (data.players[playerId])
    Object.assign(data.players[playerId], { lat, lng, gridX, gridY, last_seen: Date.now() });
  saveDb(data);
  res.json({ ok: true });
});

app.get('/api/resources', (req, res) => {
  const now  = Date.now();
  const data = loadDb();
  const collected = {};
  for (const [k, v] of Object.entries(data.collected)) {
    if (now - v.collected_at < RESPAWN_MS) collected[k] = v.collected_at;
  }
  res.json({ collected, now });
});

app.post('/api/collect', (req, res) => {
  const { playerId, gridX, gridY } = req.body;
  const key  = `${gridX}_${gridY}`;
  const now  = Date.now();
  const data = loadDb();

  const resourceType = getResourceType(gridX, gridY);
  if (!resourceType) return res.status(400).json({ error: 'no resource at this cell' });

  const existing = data.collected[key];
  if (existing && now - existing.collected_at < RESPAWN_MS) {
    const respawnsIn = Math.ceil((RESPAWN_MS - (now - existing.collected_at)) / 1000);
    return res.status(409).json({ error: 'already collected', respawnsIn });
  }

  const player = data.players[playerId];
  if (!player) return res.status(404).json({ error: 'player not found' });

  data.collected[key] = { collected_by: playerId, collected_at: now, resource_type: resourceType };
  player.inventory[resourceType] = (player.inventory[resourceType] || 0) + 1;

  saveDb(data);
  res.json({ ok: true, inventory: player.inventory, resourceType });
});

app.get('/api/players/nearby', (req, res) => {
  const { lat, lng, playerId } = req.query;
  const now  = Date.now();
  const data = loadDb();
  const players = Object.values(data.players).filter(p =>
    p.id !== playerId &&
    now - p.last_seen < 120_000 &&
    Math.abs(p.lat - parseFloat(lat)) < 0.008 &&
    Math.abs(p.lng - parseFloat(lng)) < 0.008
  ).map(({ id, name, lat, lng }) => ({ id, name, lat, lng }));
  res.json({ players });
});

app.listen(PORT, () =>
  console.log(`RPG-Go running → http://localhost:${PORT}`)
);
