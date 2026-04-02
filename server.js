// TanTracker3000 — Backend Relay Server
// Uses Turso (hosted SQLite) for persistent 60-day location history
const { WebSocketServer } = require('ws');
const http = require('http');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 8080;
const HISTORY_DAYS = 60;

// ── TURSO DATABASE ────────────────────────────────────────────
// Set TURSO_URL and TURSO_TOKEN as environment variables on Render
let db = null;

async function initDB() {
  if (!process.env.TURSO_URL || !process.env.TURSO_TOKEN) {
    console.warn('[db] TURSO_URL or TURSO_TOKEN not set — history disabled');
    return;
  }
  try {
    db = createClient({
      url: process.env.TURSO_URL,
      authToken: process.env.TURSO_TOKEN,
    });
    await db.execute(`
      CREATE TABLE IF NOT EXISTS pings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        ts INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        mph REAL,
        acc REAL,
        moving INTEGER,
        voltage REAL
      )
    `);
    await db.execute(`
      CREATE INDEX IF NOT EXISTS idx_token_ts ON pings(token, ts)
    `);
    console.log('[db] Turso connected and ready');
    pruneHistory();
  } catch(e) {
    console.error('[db] Init error:', e.message);
    db = null;
  }
}

async function storePing(token, msg) {
  if (!db) return;
  try {
    await db.execute({
      sql: 'INSERT INTO pings (token, ts, lat, lon, mph, acc, moving, voltage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [token, msg.ts || Date.now(), msg.lat, msg.lon, msg.mph || 0, msg.acc || 0, msg.moving ? 1 : 0, msg.voltage || null]
    });
  } catch(e) { console.error('[db] Insert error:', e.message); }
}

async function getHistory(token, days) {
  if (!db) return [];
  const since = Date.now() - (days * 24 * 60 * 60 * 1000);
  try {
    const result = await db.execute({
      sql: 'SELECT ts, lat, lon, mph, acc, moving, voltage FROM pings WHERE token = ? AND ts >= ? ORDER BY ts ASC',
      args: [token, since]
    });
    return result.rows;
  } catch(e) { console.error('[db] Query error:', e.message); return []; }
}

async function pruneHistory() {
  if (!db) return;
  const cutoff = Date.now() - (HISTORY_DAYS * 24 * 60 * 60 * 1000);
  try {
    const result = await db.execute({ sql: 'DELETE FROM pings WHERE ts < ?', args: [cutoff] });
    if (result.rowsAffected > 0) console.log(`[db] Pruned ${result.rowsAffected} old pings`);
  } catch(e) { console.error('[db] Prune error:', e.message); }
}

// Prune every hour
setInterval(pruneHistory, 60 * 60 * 1000);

// ── CUSTOMER TOKENS ───────────────────────────────────────────
const VALID_TOKENS = new Set([
  'tt3k-6b013c92cface5653bcd4485', // owner
]);

// ── ROOMS ─────────────────────────────────────────────────────
const rooms = new Map();
function getRoom(token) {
  if (!rooms.has(token)) rooms.set(token, { device: null, controls: [], lastLocation: null });
  return rooms.get(token);
}

// ── HTTP SERVER ───────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  // GET /history?token=xxx&days=7
  if (url.pathname === '/history' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const days = Math.min(parseInt(url.searchParams.get('days') || '7'), HISTORY_DAYS);
    if (!token || !VALID_TOKENS.has(token)) {
      res.writeHead(401, cors); res.end(JSON.stringify({ error: 'Invalid token' })); return;
    }
    const pings = await getHistory(token, days);
    res.writeHead(200, cors);
    res.end(JSON.stringify({ pings, days, count: pings.length }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TanTracker3000 relay active\n');
});

// ── WEBSOCKET ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let role = null, token = null;
  let authTimer = setTimeout(() => { if (!role) ws.terminate(); }, 15000);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') return;

      if (msg.type === 'register') {
        if (!msg.token || !VALID_TOKENS.has(msg.token)) { ws.terminate(); return; }
        clearTimeout(authTimer); authTimer = null;
        token = msg.token; role = msg.role;
        const room = getRoom(token);
        if (role === 'device') {
          if (room.device && room.device.readyState === 1) room.device.terminate();
          room.device = ws;
          console.log('[*] Device registered');
          safeBroadcast(room.controls, { type: 'device_online' });
        }
        if (role === 'control') {
          room.controls.push(ws);
          console.log('[*] Control registered (' + room.controls.length + ' active)');
          if (room.lastLocation) safeSend(ws, { ...room.lastLocation, type: 'location' });
        }
        return;
      }

      if (!token || !role) return;
      const room = getRoom(token);

      if (msg.type === 'location' || msg.type === 'location_final') {
        room.lastLocation = msg;
        safeBroadcast(room.controls, msg);
        storePing(token, msg); // async, non-blocking
        return;
      }

      if (msg.type === 'voltage_alert') { safeBroadcast(room.controls, msg); return; }

      if (['alarm','stop_alarm','screen_on','screen_off'].includes(msg.type)) {
        console.log('[>] Command: ' + msg.type);
        if (room.device && room.device.readyState === 1) safeSend(room.device, msg);
        return;
      }

      if (msg.type === 'webrtc_offer') {
        if (room.device && room.device.readyState === 1) safeSend(room.device, msg); return;
      }
      if (msg.type === 'webrtc_answer') {
        const ctrl = room.controls.find(c => c.readyState === 1);
        if (ctrl) safeSend(ctrl, msg); return;
      }
      if (msg.type === 'ice_candidate') {
        if (role === 'device') {
          const ctrl = room.controls.find(c => c.readyState === 1);
          if (ctrl) safeSend(ctrl, msg);
        } else {
          if (room.device && room.device.readyState === 1) safeSend(room.device, msg);
        }
        return;
      }
    } catch(e) { console.error('Message error:', e.message); }
  });

  ws.on('close', () => {
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    if (!token || !role) return;
    const room = getRoom(token);
    if (role === 'device') { room.device = null; safeBroadcast(room.controls, { type: 'device_offline' }); }
    if (role === 'control') { room.controls = room.controls.filter(c => c !== ws); }
    console.log('[-] Disconnected (' + role + ')');
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
});

function safeSend(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e) {}
}
function safeBroadcast(clients, obj) { clients.forEach(c => safeSend(c, obj)); }

process.on('uncaughtException', (e) => console.error('Uncaught:', e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

setInterval(() => console.log('[heartbeat] rooms:', rooms.size), 60000);

// Start everything
initDB().then(() => {
  httpServer.listen(PORT, () => console.log('TanTracker3000 relay listening on port', PORT));
});
