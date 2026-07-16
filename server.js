// Divide & Conquer relay — plain WebSocket message bus by 4-letter room code.
// Two clients per room (host + joiner). Server forwards JSON messages between
// them. No WebRTC, no ICE, no TURN — works on any network with outbound HTTPS.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 9000;
const MAX_MSG_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25_000;
const ROOM_TTL_MS = 30 * 60 * 1000;
const REJOIN_GRACE_MS = 90 * 1000; // keep a room alive this long after a drop

const rooms = new Map(); // code -> { host, joiner, createdAt, emptySince }

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`Divide & Conquer relay — alive. rooms=${rooms.size}`);
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

function partnerOf(room, ws) {
  return room.host === ws ? room.joiner : room.host;
}

function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  for (const peer of [room.host, room.joiner]) {
    if (peer && peer.readyState === 1) {
      send(peer, { type: 'partner-left', reason });
      try { peer.close(1000, reason || 'room closed'); } catch (_) {}
    }
  }
  rooms.delete(code);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) { closeRoom(code, 'ttl'); continue; }
    // Reap rooms whose dropped player never came back within the grace period.
    // Only when a slot is actually still empty — a stale emptySince left over
    // after a successful rejoin must never kill a live pair.
    const slotEmpty = !room.host || !room.joiner;
    if (slotEmpty && room.emptySince && now - room.emptySince > REJOIN_GRACE_MS) {
      closeRoom(code, 'abandoned');
    } else if (!slotEmpty) {
      room.emptySince = null;
    }
  }
}, 15_000);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws._code = null;
  ws._role = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    // ── Control messages ─────────────────────────────────────────
    if (msg.type === 'host') {
      const code = String(msg.code || '').toUpperCase().slice(0, 8);
      if (!/^[A-Z0-9]{2,8}$/.test(code)) {
        send(ws, { type: 'error', reason: 'bad-code' });
        return;
      }
      if (rooms.has(code)) {
        send(ws, { type: 'error', reason: 'code-taken' });
        return;
      }
      rooms.set(code, { host: ws, joiner: null, createdAt: Date.now() });
      ws._code = code; ws._role = 'host';
      send(ws, { type: 'hosted', code });
      console.log(`+ host ${code} (rooms=${rooms.size})`);
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().slice(0, 8);
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', reason: 'no-room' }); return; }
      if (room.joiner) { send(ws, { type: 'error', reason: 'room-full' }); return; }
      room.joiner = ws;
      room.emptySince = null;
      ws._code = code; ws._role = 'joiner';
      send(ws, { type: 'joined', code });
      send(room.host, { type: 'partner-joined' });
      console.log(`+ join ${code}`);
      return;
    }

    // A player whose socket dropped mid-game reclaims their slot.
    if (msg.type === 'rejoin') {
      const code = String(msg.code || '').toUpperCase().slice(0, 8);
      const role = msg.role === 'host' ? 'host' : 'joiner';
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', reason: 'no-room' }); return; }
      const current = room[role];
      if (current && current !== ws && current.readyState === 1) {
        send(ws, { type: 'error', reason: 'room-full' });
        return;
      }
      room[role] = ws;
      room.emptySince = (room.host && room.joiner) ? null : room.emptySince;
      ws._code = code; ws._role = role;
      const peer = partnerOf(room, ws);
      const partnerHere = !!(peer && peer.readyState === 1);
      // partner flag lets the client know whether queued messages can flush now
      send(ws, { type: 'rejoined', code, partner: partnerHere });
      if (partnerHere) send(peer, { type: 'partner-rejoined' });
      console.log(`+ rejoin ${role} ${code}`);
      return;
    }

    // ── Data messages — relay to partner ─────────────────────────
    if (msg.type === 'data') {
      const room = rooms.get(ws._code);
      if (!room) return;
      const peer = partnerOf(room, ws);
      send(peer, { type: 'data', payload: msg.payload });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws._code) return;
    const room = rooms.get(ws._code);
    if (!room) return;
    // Ignore closes from stale sockets that were already replaced by a rejoin
    // — otherwise a late TCP timeout would mark a live room as abandoned.
    if (room[ws._role] !== ws) return;
    // Free the slot but keep the room for REJOIN_GRACE_MS so the player can
    // reconnect and resume — previously any drop instantly killed the room.
    room[ws._role] = null;
    room.emptySince = Date.now();
    const peer = ws._role === 'host' ? room.joiner : room.host;
    if (peer && peer.readyState === 1) send(peer, { type: 'partner-left' });
    console.log(`- ${ws._role} ${ws._code} (grace ${REJOIN_GRACE_MS / 1000}s)`);
  });

  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => console.log(`Relay listening on :${PORT}`));
