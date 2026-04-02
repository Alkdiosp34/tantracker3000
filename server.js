// TanTracker3000 — Backend Relay Server
const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ── CUSTOMER TOKENS ───────────────────────────────────────────
const VALID_TOKENS = new Set([
  'tt3k-6b013c92cface5653bcd4485',
]);

// ── ROOMS ─────────────────────────────────────────────────────
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
  let role = null;
  let token = null;
  let authTimer = null;

  authTimer = setTimeout(() => {
    if (!role) {
      console.warn('[!] Auth timeout — no register received, terminating');
      ws.terminate();
    }
  }, 15000);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'ping') return;

      if (msg.type === 'register') {
        if (!msg.token || !VALID_TOKENS.has(msg.token)) {
          ws.terminate();
          return;
        }
        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
        token = msg.token;
        role = msg.role;
        const room = getRoom(token);

        if (role === 'device') {
          if (room.device && room.device.readyState === 1) room.device.terminate();
          room.device = ws;
          console.log('[*] Device registered — token ok');
          safeBroadcast(room.controls, { type: 'device_online' });
        }

        if (role === 'control') {
          room.controls.push(ws);
          console.log('[*] Control registered (' + room.controls.length + ' active)');
          if (room.lastLocation) safeSend(ws, room.lastLocation);
        }
        return;
      }

      if (!token || !role) return;
      const room = getRoom(token);

      if (msg.type === 'location' || msg.type === 'location_final') {
        room.lastLocation = msg;
        safeBroadcast(room.controls, msg);
        return;
      }

      if (msg.type === 'voltage_alert') {
        safeBroadcast(room.controls, msg);
        return;
      }

      if (['flash','stop_flash','alarm','stop_alarm','screen_on','screen_off'].includes(msg.type)) {
        console.log('[>] Command: ' + msg.type);
        if (room.device && room.device.readyState === 1) safeSend(room.device, msg);
        return;
      }

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

    } catch(e) {
      console.error('Message error:', e.message);
    }
  });

  ws.on('close', () => {
    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    if (!token || !role) return;
    const room = getRoom(token);
    if (role === 'device') {
      room.device = null;
      safeBroadcast(room.controls, { type: 'device_offline' });
    }
    if (role === 'control') {
      room.controls = room.controls.filter(c => c !== ws);
    }
    console.log('[-] Disconnected (' + role + ')');
  });

  ws.on('error', (e) => console.error('WS error:', e.message));
});

function safeSend(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e) {}
}

function safeBroadcast(clients, obj) {
  clients.forEach(c => safeSend(c, obj));
}

// Catch anything that would otherwise crash the process
process.on('uncaughtException', (e) => console.error('Uncaught:', e.message));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

setInterval(() => console.log('[heartbeat] rooms:', rooms.size), 60000);

httpServer.listen(PORT, () => console.log('TanTracker3000 relay listening on port', PORT));
