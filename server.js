// TanTracker3000 — Backend Relay Server
const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ── CUSTOMER TOKENS ───────────────────────────────────────────
// Each customer gets a unique token. Add one line per customer.
const VALID_TOKENS = new Set([
  'tt3k-6b013c92cface5653bcd4485', // owner
]);

// ── RATE LIMITING ─────────────────────────────────────────────
const RATE_LIMIT = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = RATE_LIMIT.get(ip);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// ── ROOMS (one per token) ─────────────────────────────────────
const rooms = new Map();
function getRoom(token) {
  if (!rooms.has(token)) rooms.set(token, { device: null, controls: [], lastLocation: null });
  return rooms.get(token);
}

// ── HTTP SERVER ───────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TanTracker3000 relay active\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!checkRateLimit(ip)) {
    ws.close(1008, 'Rate limit exceeded');
    return;
  }

  let role = null;
  let token = null;

  // Kick unauthenticated clients after 5 seconds
  const authTimeout = setTimeout(() => {
    if (!role) {
      console.warn(`[!] Unauthenticated client kicked from ${ip}`);
      ws.close(1008, 'Authentication timeout');
    }
  }, 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── REGISTRATION ──────────────────────────────────────────
    if (msg.type === 'register') {
      if (!msg.token || !VALID_TOKENS.has(msg.token)) {
        console.warn(`[!] Invalid token from ${ip}`);
        ws.close(1008, 'Invalid token');
        return;
      }
      clearTimeout(authTimeout);
      token = msg.token;
      role = msg.role;
      const room = getRoom(token);

      if (role === 'device') {
        if (room.device && room.device.readyState === 1) room.device.close();
        room.device = ws;
        console.log(`[*] Device registered`);
        broadcast(room.controls, { type: 'device_online' });
      }

      if (role === 'control') {
        room.controls.push(ws);
        console.log(`[*] Control panel registered (${room.controls.length} active)`);
        if (room.lastLocation) safeSend(ws, room.lastLocation);
      }
      return;
    }

    // Reject unauthenticated messages
    if (!token || !role) { ws.close(1008, 'Not authenticated'); return; }
    const room = getRoom(token);

    // ── KEEPALIVE PING ────────────────────────────────────────
    if (msg.type === 'ping') return; // silently ignore, just keeps connection alive

    // ── LOCATION ──────────────────────────────────────────────
    if (msg.type === 'location') {
      room.lastLocation = msg;
      broadcast(room.controls, msg);
      return;
    }

    if (msg.type === 'location_final') {
      room.lastLocation = msg;
      broadcast(room.controls, msg);
      console.log(`[!] Final ping received`);
      return;
    }

    // ── VOLTAGE ALERTS ────────────────────────────────────────
    if (msg.type === 'voltage_alert') {
      broadcast(room.controls, msg);
      return;
    }

    // ── COMMANDS control → device ─────────────────────────────
    if (['flash', 'stop_flash', 'alarm'].includes(msg.type)) {
      if (room.device && room.device.readyState === 1) safeSend(room.device, msg);
      return;
    }

    // ── WEBRTC ────────────────────────────────────────────────
    if (msg.type === 'webrtc_offer') {
      if (room.device && room.device.readyState === 1) safeSend(room.device, msg);
      return;
    }
    if (msg.type === 'webrtc_answer') {
      const ctrl = room.controls.find(c => c.readyState === 1);
      if (ctrl) safeSend(ctrl, msg);
      return;
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
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (!token || !role) return;
    const room = getRoom(token);
    if (role === 'device') {
      room.device = null;
      broadcast(room.controls, { type: 'device_offline' });
    }
    if (role === 'control') {
      room.controls = room.controls.filter(c => c !== ws);
    }
    console.log(`[-] Client disconnected (${role})`);
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

function safeSend(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e) {}
}
function broadcast(clients, obj) {
  clients.forEach(c => safeSend(c, obj));
}

setInterval(() => {
  console.log(`[heartbeat] rooms: ${rooms.size}`);
}, 60000);

httpServer.listen(PORT, () => console.log(`TanTracker3000 relay listening on port ${PORT}`));
