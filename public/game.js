// ── Constants ─────────────────────────────────────────────────────────────

const CELL  = 0.001;          // degrees per grid cell (~111 m lat, ~85 m lng)
const MIN_ZOOM_RESOURCES = 15; // hide resources below this zoom
const SYNC_MS = 5000;          // poll interval for shared state

// Resource definitions — order matters (weights sum to 1.0)
const RESOURCES = [
  { type: 'wood',  icon: '🌲', name: 'Wood',    color: '#388e3c', fill: 'rgba(56,142,60,0.38)',   w: 0.35 },
  { type: 'stone', icon: '🪨', name: 'Stone',   color: '#757575', fill: 'rgba(117,117,117,0.38)', w: 0.25 },
  { type: 'iron',  icon: '⚙️', name: 'Iron',    color: '#8d6e63', fill: 'rgba(141,110,99,0.38)',  w: 0.18 },
  { type: 'food',  icon: '🌾', name: 'Grain',   color: '#f9a825', fill: 'rgba(249,168,37,0.38)',  w: 0.12 },
  { type: 'gold',  icon: '💰', name: 'Gold',    color: '#fdd835', fill: 'rgba(253,216,53,0.38)',  w: 0.06 },
  { type: 'gem',   icon: '💎', name: 'Gems',    color: '#1e88e5', fill: 'rgba(30,136,229,0.38)', w: 0.04 },
];

const RES_BY_TYPE = Object.fromEntries(RESOURCES.map(r => [r.type, r]));

// ── Hash / deterministic resource layout ──────────────────────────────────
// Both client and server use the same algorithm so the map is identical for
// every player without storing static resource positions in the database.

function hash32(x, y) {
  let h = Math.imul(x, 0x9e3779b9) ^ Math.imul(y, 0x517cc1b7);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 1 | s);
    s ^= s + Math.imul(s ^ (s >>> 7), 61 | s);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

function getResource(gx, gy) {
  const rng = seededRng(hash32(gx, gy));
  if (rng() > 0.15) return null; // 15% cell spawn rate
  const roll = rng();
  let cum = 0;
  for (const r of RESOURCES) {
    cum += r.w;
    if (roll < cum) return r;
  }
  return RESOURCES[0];
}

// ── Coordinate helpers ────────────────────────────────────────────────────

function latLngToGrid(lat, lng) {
  return { gx: Math.floor(lng / CELL), gy: Math.floor(lat / CELL) };
}

function gridCenter(gx, gy) {
  return { lat: (gy + 0.5) * CELL, lng: (gx + 0.5) * CELL };
}

function gkey(gx, gy) { return `${gx}_${gy}`; }

// ── Game state ────────────────────────────────────────────────────────────

let map, gridCanvas;
let player = null;          // { id, name, lat, lng, gx, gy, inventory }
let playerMarker = null;
let destMarker   = null;    // ghost marker for movement destination
let resourceLayers = new Map(); // gkey → L.Rectangle
let collectedSet   = new Map(); // gkey → collectedAt (ms)
let otherMarkers   = new Map();
let syncTimer      = null;

// ── API wrapper ───────────────────────────────────────────────────────────

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
  return res.json();
}

// ── Entry point ───────────────────────────────────────────────────────────

async function startGame() {
  const nameEl = document.getElementById('player-name');
  const name   = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }

  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  btn.textContent = 'Locating…';

  let lat, lng;
  try {
    const pos = await new Promise((ok, fail) =>
      navigator.geolocation
        ? navigator.geolocation.getCurrentPosition(ok, fail, { timeout: 8000 })
        : fail(new Error('no geolocation'))
    );
    lat = pos.coords.latitude;
    lng = pos.coords.longitude;
  } catch {
    // Fallback: San Jose, CA
    lat = 37.3382;
    lng = -121.8863;
    addLog('📍 Location unavailable — defaulting to San Jose, CA', 'warn');
  }

  try {
    const data = await api('/api/player/join', 'POST', { name, lat, lng });
    player = { ...data, gx: data.gridX, gy: data.gridY };
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Begin Adventure';
    addLog(`Error: ${e.message}`, 'warn');
    return;
  }

  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');

  initMap(lat, lng);
}

// ── Map initialisation ────────────────────────────────────────────────────

function initMap(lat, lng) {
  map = L.map('map', { center: [lat, lng], zoom: 17, zoomControl: true });

  // Dark CartoDB tiles — perfect for HoMM aesthetic
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
  }).addTo(map);

  initGridCanvas();

  playerMarker = L.marker([lat, lng], { icon: heroIcon(player.name), zIndexOffset: 1000 })
    .addTo(map)
    .bindTooltip(`⚔️ ${player.name} (you)`, { className: 'res-tooltip', permanent: false });

  updateSidebar();
  refreshResources();
  syncPlayers();

  map.on('click', onMapClick);
  map.on('moveend zoomend', refreshResources);

  syncTimer = setInterval(() => {
    refreshResources();
    syncPlayers();
  }, SYNC_MS);

  addLog(`⚔️ ${player.name} enters the world`, 'move');
}

// ── Grid canvas ───────────────────────────────────────────────────────────

function initGridCanvas() {
  gridCanvas = document.createElement('canvas');
  gridCanvas.className = 'grid-canvas';
  map.getPanes().overlayPane.appendChild(gridCanvas);
  map.on('moveend zoomend resize', drawGrid);
  drawGrid();
}

function drawGrid() {
  const size  = map.getSize();
  const zoom  = map.getZoom();
  const ctx   = gridCanvas.getContext('2d');

  gridCanvas.width  = size.x;
  gridCanvas.height = size.y;
  ctx.clearRect(0, 0, size.x, size.y);

  if (zoom < MIN_ZOOM_RESOURCES) {
    document.getElementById('zoom-hint').classList.remove('hidden');
    return;
  }
  document.getElementById('zoom-hint').classList.add('hidden');

  // Fade grid in between zoom 15–17
  const alpha = Math.min(1, (zoom - MIN_ZOOM_RESOURCES) / 2) * 0.45;
  ctx.strokeStyle = `rgba(100, 149, 237, ${alpha})`;
  ctx.lineWidth   = 1;

  const bounds = map.getBounds();
  const startY = Math.floor(bounds.getSouth() / CELL) * CELL;
  const startX = Math.floor(bounds.getWest()  / CELL) * CELL;

  for (let lat = startY; lat <= bounds.getNorth() + CELL; lat += CELL) {
    const p = map.latLngToContainerPoint([lat, bounds.getWest()]);
    ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(size.x, p.y); ctx.stroke();
  }

  for (let lng = startX; lng <= bounds.getEast() + CELL; lng += CELL) {
    const p = map.latLngToContainerPoint([bounds.getNorth(), lng]);
    ctx.beginPath(); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, size.y); ctx.stroke();
  }
}

// ── Resources ─────────────────────────────────────────────────────────────

async function refreshResources() {
  if (map.getZoom() < MIN_ZOOM_RESOURCES) {
    clearResourceLayers();
    return;
  }

  let data;
  try {
    data = await api('/api/resources');
  } catch { return; }

  collectedSet.clear();
  for (const [k, ts] of Object.entries(data.collected)) {
    collectedSet.set(k, ts);
  }

  renderResourcesInView();
}

function renderResourcesInView() {
  const bounds = map.getBounds();
  const minX   = Math.floor(bounds.getWest()  / CELL);
  const maxX   = Math.ceil( bounds.getEast()  / CELL);
  const minY   = Math.floor(bounds.getSouth() / CELL);
  const maxY   = Math.ceil( bounds.getNorth() / CELL);

  // Safety cap — shouldn't happen at normal zoom levels
  if ((maxX - minX) * (maxY - minY) > 600) return;

  const wanted = new Set();

  for (let gy = minY; gy <= maxY; gy++) {
    for (let gx = minX; gx <= maxX; gx++) {
      const def = getResource(gx, gy);
      if (!def) continue;

      const k = gkey(gx, gy);
      if (collectedSet.has(k)) continue; // depleted

      wanted.add(k);

      if (!resourceLayers.has(k)) {
        const pad  = CELL * 0.06;
        const sw   = [gy * CELL + pad, gx * CELL + pad];
        const ne   = [(gy + 1) * CELL - pad, (gx + 1) * CELL - pad];

        const rect = L.rectangle([sw, ne], {
          color:       def.color,
          weight:      1.5,
          fillColor:   def.fill,
          fillOpacity: 1,
          interactive: true,
          bubblingMouseEvents: false,
        });

        const respawnNote = collectedSet.has(k)
          ? ` · respawns soon` : '';

        rect.bindTooltip(
          `${def.icon} <strong>${def.name}</strong>${respawnNote}<br><span style="font-size:11px;opacity:.6">Click to collect</span>`,
          { className: 'res-tooltip', sticky: true, offset: [12, 0] }
        );

        rect.on('click', e => {
          L.DomEvent.stopPropagation(e);
          collectResource(gx, gy, def);
        });

        rect.addTo(map);
        resourceLayers.set(k, rect);
      }
    }
  }

  // Remove layers that are now out of view or collected
  for (const [k, layer] of resourceLayers) {
    if (!wanted.has(k)) {
      map.removeLayer(layer);
      resourceLayers.delete(k);
    }
  }
}

function clearResourceLayers() {
  resourceLayers.forEach(l => map.removeLayer(l));
  resourceLayers.clear();
}

// ── Collect ───────────────────────────────────────────────────────────────

async function collectResource(gx, gy, def) {
  // Auto-move to the cell if not already adjacent
  const dx = Math.abs(player.gx - gx);
  const dy = Math.abs(player.gy - gy);
  if (dx > 1 || dy > 1) {
    await moveTo(gx, gy);
  }

  let result;
  try {
    result = await api('/api/collect', 'POST', { playerId: player.id, gridX: gx, gridY: gy });
  } catch (e) {
    if (e.status === 409) {
      addLog(`${def.icon} Already collected — wait for respawn`, 'warn');
    }
    return;
  }

  player.inventory = result.inventory;

  // Remove from map immediately
  const k = gkey(gx, gy);
  if (resourceLayers.has(k)) {
    map.removeLayer(resourceLayers.get(k));
    resourceLayers.delete(k);
  }
  collectedSet.set(k, Date.now());

  showPopup(def);
  updateSidebar();
  addLog(`${def.icon} Collected ${def.name}`, 'collect');
}

// ── Movement ──────────────────────────────────────────────────────────────

async function onMapClick(e) {
  const { gx, gy } = latLngToGrid(e.latlng.lat, e.latlng.lng);
  await moveTo(gx, gy);
}

async function moveTo(gx, gy) {
  const { lat, lng } = gridCenter(gx, gy);
  player.lat = lat;
  player.lng = lng;
  player.gx  = gx;
  player.gy  = gy;

  playerMarker.setLatLng([lat, lng]);
  updateSidebar();

  // Check if we just stepped onto a resource
  const def = getResource(gx, gy);
  const k   = gkey(gx, gy);
  if (def && !collectedSet.has(k)) {
    addLog(`${def.icon} ${def.name} nearby — click to collect`, '');
  }

  api('/api/player/move', 'POST', { playerId: player.id, lat, lng, gridX: gx, gridY: gy })
    .catch(() => {});
}

// ── Other players ──────────────────────────────────────────────────────────

async function syncPlayers() {
  let data;
  try {
    data = await api(`/api/players/nearby?lat=${player.lat}&lng=${player.lng}&playerId=${player.id}`);
  } catch { return; }

  otherMarkers.forEach(m => map.removeLayer(m));
  otherMarkers.clear();

  const el = document.getElementById('nearby-players');
  el.innerHTML = '';

  for (const p of data.players) {
    const m = L.marker([p.lat, p.lng], { icon: otherIcon() })
      .addTo(map)
      .bindTooltip(`⚔️ ${p.name}`, { className: 'res-tooltip' });
    otherMarkers.set(p.id, m);
    el.innerHTML += `<div class="player-row"><div class="player-pip"></div>${p.name}</div>`;
  }

  if (!data.players.length) {
    el.innerHTML = '<span class="dim" style="font-size:12px">No heroes nearby</span>';
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────

function updateSidebar() {
  document.getElementById('hero-name').textContent = `⚔️ ${player.name}`;
  document.getElementById('hero-grid').textContent =
    `Grid (${player.gx}, ${player.gy})`;

  const inv = player.inventory || {};
  const el  = document.getElementById('inventory');
  const cells = RESOURCES.filter(r => (inv[r.type] || 0) > 0)
    .map(r => `
      <div class="inv-cell" style="border-color:${r.color}55">
        <span class="inv-icon">${r.icon}</span>
        <div class="inv-count">${inv[r.type]}</div>
        <div class="inv-label">${r.name}</div>
      </div>`).join('');

  el.innerHTML = cells ||
    `<span class="dim" style="font-size:12px;grid-column:span 3">
       Walk and tap resources to collect
     </span>`;
}

function showPopup(def) {
  const popup = document.getElementById('collect-popup');
  document.getElementById('popup-icon').textContent = def.icon;
  document.getElementById('popup-text').textContent  = `+1 ${def.name}!`;
  popup.classList.remove('hidden');
  setTimeout(() => popup.classList.add('hidden'), 1400);
}

function addLog(msg, type = '') {
  const log  = document.getElementById('activity-log');
  const row  = document.createElement('div');
  row.className = `log-row ${type}`;
  row.textContent = msg;
  log.insertBefore(row, log.firstChild);
  while (log.children.length > 25) log.lastChild.remove();
}

function heroIcon(name) {
  return L.divIcon({
    className: '',
    html: `<div class="hero-icon" title="${name}">⚔️</div>`,
    iconSize:   [32, 32],
    iconAnchor: [16, 16],
  });
}

function otherIcon() {
  return L.divIcon({
    className: 'other-icon',
    iconSize:   [14, 14],
    iconAnchor: [7, 7],
  });
}
