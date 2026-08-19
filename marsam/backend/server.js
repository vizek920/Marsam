// Marsam — Backend server
// Real-time collaborative whiteboard: rooms, drawing sync, layers,
// host permissions, and stroke-replay recording.

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Room code: short, unambiguous characters (no 0/O/1/I)
const genRoomCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 6);

const PORT = process.env.PORT || 3001;

// ---- In-memory room store -------------------------------------------------
// rooms[roomId] = {
//   id, name, isPublic, hostSocketId, createdAt,
//   users: { [socketId]: { username, color, canDraw } },
//   layers: { [layerId]: { ownerSocketId, name } },
//   strokes: [ { id, layerId, socketId, tool, color, size, points, ts } ],
//   replayLog: [ ...same shape as strokes, in emission order ],
//   galleryEntry: null | { imageDataUrl, savedAt }
// }
const rooms = {};

const CURSOR_COLORS = [
  '#C9A227', '#3F7D6E', '#B24C3F', '#5B6FA8',
  '#A87F3F', '#7D9B4E', '#8C5FA8', '#4E9BA8',
];

function publicRoomList() {
  return Object.values(rooms)
    .filter((r) => r.isPublic)
    .map((r) => ({
      id: r.id,
      name: r.name,
      userCount: Object.keys(r.users).length,
      createdAt: r.createdAt,
    }));
}

function broadcastRoomList() {
  io.emit('public_rooms', publicRoomList());
}

// ---- REST endpoints ---------------------------------------------------
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/rooms/public', (req, res) => {
  res.json(publicRoomList());
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  res.json({
    id: room.id,
    name: room.name,
    isPublic: room.isPublic,
    userCount: Object.keys(room.users).length,
  });
});

// Gallery: public snapshots that users chose to publish
app.get('/api/gallery', (req, res) => {
  const items = Object.values(rooms)
    .filter((r) => r.galleryEntry)
    .map((r) => ({
      roomId: r.id,
      roomName: r.name,
      imageDataUrl: r.galleryEntry.imageDataUrl,
      savedAt: r.galleryEntry.savedAt,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
  res.json(items);
});

// ---- Socket.io -------------------------------------------------------
io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('create_room', ({ name, isPublic, username }, cb) => {
    const id = genRoomCode();
    const room = {
      id,
      name: name?.trim() || `غرفة ${id}`,
      isPublic: !!isPublic,
      hostSocketId: null,
      createdAt: Date.now(),
      users: {},
      layers: {},
      strokes: [],
      replayLog: [],
      galleryEntry: null,
      bannedClientIds: new Set(),
      kickedInfo: {},   // clientId -> username, for the host's ban list UI
      timers: {},       // socketId -> Timeout, for timed draw permissions
    };
    rooms[id] = room;
    cb?.({ ok: true, roomId: id });
    if (room.isPublic) broadcastRoomList();
  });

  socket.on('join_room', ({ roomId, username, clientId }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb?.({ ok: false, error: 'room_not_found' });

    if (clientId && room.bannedClientIds.has(clientId)) {
      return cb?.({ ok: false, error: 'kicked' });
    }

    currentRoomId = roomId;
    room.pendingRequests = room.pendingRequests || {};

    // Public rooms, and the very first joiner (who becomes host), skip approval.
    if (room.isPublic || !room.hostSocketId) {
      cb?.({ ok: true });
      finalizeJoin(socket, room, username, clientId);
      return;
    }

    // Private room with an existing host: hold for approval.
    const requestId = `${socket.id}-${Date.now()}`;
    const cleanName = (username || 'ضيف').slice(0, 24);
    room.pendingRequests[requestId] = { socketId: socket.id, username: cleanName, clientId };
    cb?.({ ok: true, pending: true, requestId });

    const hostSocket = io.sockets.sockets.get(room.hostSocketId);
    hostSocket?.emit('join_request', { requestId, username: cleanName });
  });

  socket.on('approve_join', ({ requestId }) => {
    const room = rooms[currentRoomId];
    if (!room || room.hostSocketId !== socket.id) return; // host only
    const req = room.pendingRequests?.[requestId];
    if (!req) return;
    delete room.pendingRequests[requestId];
    const reqSocket = io.sockets.sockets.get(req.socketId);
    if (!reqSocket) return; // requester already disconnected
    finalizeJoin(reqSocket, room, req.username, req.clientId);
  });

  socket.on('reject_join', ({ requestId }) => {
    const room = rooms[currentRoomId];
    if (!room || room.hostSocketId !== socket.id) return; // host only
    const req = room.pendingRequests?.[requestId];
    if (!req) return;
    delete room.pendingRequests[requestId];
    io.sockets.sockets.get(req.socketId)?.emit('join_rejected');
  });

  // Finish joining a socket into a room: assign color/layer, send them the
  // full state, and let everyone else know. Used both for immediate joins
  // (public rooms / the first host) and for host-approved private joins.
  function finalizeJoin(sock, room, username, clientId) {
    sock.join(room.id);
    if (!room.hostSocketId) room.hostSocketId = sock.id;
    const isHost = room.hostSocketId === sock.id;
    const color = CURSOR_COLORS[Object.keys(room.users).length % CURSOR_COLORS.length];

    room.users[sock.id] = {
      username: (username || 'ضيف').slice(0, 24),
      color,
      canDraw: true,
      isHost,
      clientId: clientId || null,
    };
    room.layers[sock.id] = { ownerSocketId: sock.id, name: room.users[sock.id].username };

    sock.emit('joined', {
      ok: true,
      you: { id: sock.id, ...room.users[sock.id] },
      users: room.users,
      layers: room.layers,
      strokes: room.strokes,
      isHost,
      kicked: room.kickedInfo,
    });

    sock.to(room.id).emit('user_joined', { id: sock.id, ...room.users[sock.id] });
    io.to(room.id).emit('presence_update', { users: room.users });
    if (room.isPublic) broadcastRoomList();
  }

  // ---- Drawing sync ----
  socket.on('stroke', (stroke) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    const user = room.users[socket.id];
    if (!user || !user.canDraw) return;

    const record = { ...stroke, socketId: socket.id, ts: Date.now() };
    room.strokes.push(record);
    room.replayLog.push(record);
    socket.to(currentRoomId).emit('stroke', record);
  });

  socket.on('undo_stroke', ({ strokeId }) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    room.strokes = room.strokes.filter((s) => s.id !== strokeId || s.socketId !== socket.id);
    io.to(currentRoomId).emit('stroke_removed', { strokeId, socketId: socket.id });
  });

  socket.on('clear_layer', ({ layerId }) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    room.strokes = room.strokes.filter((s) => s.layerId !== layerId);
    io.to(currentRoomId).emit('layer_cleared', { layerId });
  });

  // ---- Cursors ----
  socket.on('cursor_move', ({ x, y }) => {
    const room = rooms[currentRoomId];
    if (!room || !room.users[socket.id]) return;
    socket.to(currentRoomId).emit('cursor_move', { id: socket.id, x, y });
  });

  // ---- Reactions (emoji overlays) ----
  socket.on('reaction', ({ emoji, x, y }) => {
    if (!currentRoomId) return;
    io.to(currentRoomId).emit('reaction', { emoji, x, y, id: socket.id });
  });

  // ---- Host permissions ----
  socket.on('set_permission', ({ targetId, canDraw }) => {
    const room = rooms[currentRoomId];
    if (!room || room.hostSocketId !== socket.id) return; // host only
    if (!room.users[targetId]) return;
    clearTimeout(room.timers[targetId]);
    delete room.timers[targetId];
    room.users[targetId].canDraw = canDraw;
    io.to(currentRoomId).emit('permission_changed', { targetId, canDraw });
  });

  // Host gives a specific person a timed drawing window; canDraw flips
  // back to false automatically when it runs out.
  socket.on('set_permission_timed', ({ targetId, seconds }) => {
    const room = rooms[currentRoomId];
    if (!room || room.hostSocketId !== socket.id) return; // host only
    if (!room.users[targetId]) return;
    const durationMs = Math.max(1, Number(seconds) || 0) * 1000;

    clearTimeout(room.timers[targetId]);
    room.users[targetId].canDraw = true;
    const endsAt = Date.now() + durationMs;
    io.to(currentRoomId).emit('permission_changed', { targetId, canDraw: true, endsAt });

    room.timers[targetId] = setTimeout(() => {
      if (!room.users[targetId]) return;
      room.users[targetId].canDraw = false;
      delete room.timers[targetId];
      io.to(currentRoomId).emit('permission_changed', { targetId, canDraw: false });
    }, durationMs);
  });

  // ---- Kick / ban ----
  socket.on('kick_user', ({ targetId }) => {
    const room = rooms[currentRoomId];
    if (!room || room.hostSocketId !== socket.id) return; // host only
    if (targetId === socket.id) return; // can't kick yourself
    const target = room.users[targetId];
    if (!target) return;

    if (target.clientId) room.bannedClientIds.add(target.clientId);
    room.kickedInfo[target.clientId || targetId] = target.username;

    clearTimeout(room.timers[targetId]);
    delete room.timers[targetId];

    const targetSocket = io.sockets.sockets.get(targetId);
    targetSocket?.emit('you_were_kicked');
    targetSocket?.leave(currentRoomId);
    targetSocket?.disconnect(true);

    delete room.users[targetId];
    delete room.layers[targetId];
    io.to(currentRoomId).emit('presence_update', { users: room.users });
    io.to(currentRoomId).emit('ban_list_updated', { kicked: room.kickedInfo });
  });

  socket.on('unban_user', ({ clientId }) => {
    const room = rooms[currentRoomId];
    if (!room || room.hostSocketId !== socket.id) return; // host only
    room.bannedClientIds.delete(clientId);
    delete room.kickedInfo[clientId];
    io.to(currentRoomId).emit('ban_list_updated', { kicked: room.kickedInfo });
  });

  // ---- Quick-draw challenge (host-triggered) ----
  socket.on('challenge_start', ({ word, seconds }) => {
    const room = rooms[currentRoomId];
    if (!room || room.hostSocketId !== socket.id) return; // host only
    io.to(currentRoomId).emit('challenge_start', { word, seconds: seconds || 60, startedAt: Date.now() });
  });

  // ---- Replay ----
  socket.on('get_replay', (cb) => {
    const room = rooms[currentRoomId];
    cb?.(room ? room.replayLog : []);
  });

  // ---- Gallery publish ----
  socket.on('publish_to_gallery', ({ imageDataUrl }) => {
    const room = rooms[currentRoomId];
    if (!room) return;
    room.galleryEntry = { imageDataUrl, savedAt: Date.now() };
    io.emit('gallery_updated');
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    const room = rooms[currentRoomId];
    if (!room) return;
    if (room.pendingRequests) {
      for (const [rid, req] of Object.entries(room.pendingRequests)) {
        if (req.socketId === socket.id) delete room.pendingRequests[rid];
      }
    }
    clearTimeout(room.timers[socket.id]);
    delete room.timers[socket.id];
    delete room.users[socket.id];
    delete room.layers[socket.id];
    socket.to(currentRoomId).emit('user_left', { id: socket.id });
    io.to(currentRoomId).emit('presence_update', { users: room.users });

    if (Object.keys(room.users).length === 0) {
      // Empty room: keep briefly for reconnects, then clean up
      setTimeout(() => {
        if (rooms[currentRoomId] && Object.keys(rooms[currentRoomId].users).length === 0) {
          const wasPublic = rooms[currentRoomId].isPublic;
          delete rooms[currentRoomId];
          if (wasPublic) broadcastRoomList();
        }
      }, 5 * 60 * 1000);
    } else if (room.hostSocketId === socket.id) {
      // Reassign host to the next user
      const nextHostId = Object.keys(room.users)[0];
      room.hostSocketId = nextHostId;
      room.users[nextHostId].isHost = true;
      io.to(currentRoomId).emit('host_changed', { newHostId: nextHostId });
    }
    if (room.isPublic) broadcastRoomList();
  });
});

server.listen(PORT, () => {
  console.log(`Marsam backend listening on port ${PORT}`);
});
