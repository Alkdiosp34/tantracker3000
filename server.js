// SENTINEL — Backend Relay Server
// Node.js + ws (WebSocket library)
//
// Deploy to Render.com (free tier):
//   1. Push this file + package.json to a GitHub repo
//   2. Create new "Web Service" on Render, connect the repo
//   3. Build command: npm install
//   4. Start command: node server.js
//   5. Copy your Render URL and paste it into device.html and control.html as WS_URL
//      (change https:// to wss://)

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Simple HTTP server (Render needs an HTTP endpoint to stay alive)
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SENTINEL relay active\n');
});

const wss = new WebSocketServer({ server: httpServer });

// Track connected clients
let deviceClient = null;   // The Android phone in the car
let controlClients = [];   // Your control panels (phone/tablet/desktop)

// Last known location (so new control panels get it immediately on connect)
let lastLocation = null;

wss.on('connection', (ws) => {
  console.log('[+] Client connected');
  let role = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── REGISTRATION ──────────────────────────────────────
    if (msg.type === 'register') {
      role = msg.role;

      if (role === 'device') {
        deviceClient = ws;
        console.log('[*] Device registered');
        // Notify all control panels
        broadcast(controlClients, { type: 'device_online' });
      }

      if (role === 'control') {
        controlClients.push(ws);
        console.log(`[*] Control panel registered (${controlClients.length} active)`);
        // Send last known location immediately
        if (lastLocation) {
          safeSend(ws, lastLocation);
        }
      }
      return;
    }

    // ── LOCATION from device → broadcast to all controls ──
    if (msg.type === 'location') {
      room.lastLocation = msg;
      broadcast(room.controls, msg);
      return;
    }

    // ── FINAL PING ─────────────────────────────────────────
    if (msg.type === 'location_final') {
      room.lastLocation = msg;
      broadcast(room.controls, msg);
      console.log(`[!] FINAL PING — token ${token.slice(0,8)}... voltage: ${msg.voltage}V`);
      return;
    }

    // ── VOLTAGE ALERTS ─────────────────────────────────────
    if (msg.type === 'voltage_alert') {
      const val = msg.voltage != null ? msg.voltage + (msg.level.startsWith('phone') ? '%' : 'V') : '';
      console.log(`[!] Voltage alert: ${msg.level} ${val} — token ${token.slice(0,8)}...`);
      broadcast(room.controls, msg);
      return;
    }

    // ── COMMANDS from control → device ─────────────────────
    if (['flash', 'stop_flash', 'alarm'].includes(msg.type)) {
      console.log(`[>] Command: ${msg.type} — token ${token.slice(0,8)}...`);
      if (room.device && room.device.readyState === 1) safeSend(room.device, msg);
      return;
    }

    // ── WEBRTC SIGNALING ───────────────────────────────────
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
    if (!token) return;
    const room = getRoom(token);
    console.log(`[-] Client disconnected — token ${token.slice(0,8)}...`);
    if (role === 'device') {
      room.device = null;
      broadcast(room.controls, { type: 'device_offline' });
    }
    if (role === 'control') {
      room.controls = room.controls.filter(c => c !== ws);
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

function safeSend(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (e) {
    console.error('Send error:', e.message);
  }
}

function broadcast(clients, obj) {
  clients.forEach(c => safeSend(c, obj));
}

// Keep Render's free tier alive (it spins down after inactivity)
// Optional: ping self every 14 minutes using an external uptime monitor like UptimeRobot
setInterval(() => {
  console.log(`[*] Heartbeat — device: ${deviceClient ? 'connected' : 'offline'}, controls: ${controlClients.length}`);
}, 60000);

httpServer.listen(PORT, () => console.log(`SENTINEL relay listening on port ${PORT}`));
