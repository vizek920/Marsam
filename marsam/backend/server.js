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
    };
    rooms[id] = room;
    cb?.({ ok: true, roomId: id });
    if (room.isPublic) broadcastRoomList();
  });

  socket.on('join_room', ({ roomId, username }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb?.({ ok: false, error: 'room_not_found' });

    currentRoomId = roomId;
    socket.join(roomId);

    if (!room.hostSocketId) room.hostSocketId = socket.id; // first real joiner becomes host
    const isHost = room.hostSocketId === socket.id;
    const color = CURSOR_COLORS[Object.keys(room.users).length % CURSOR_COLORS.length];

    room.users[socket.id] = {
      username: (username || 'ضيف').slice(0, 24),
      color,
      canDraw: true,
      isHost,
    };

    // Personal layer for this user
    room.layers[socket.id] = { ownerSocketId: socket.id, name: room.users[socket.id].username };

    cb?.({
      ok: true,
      you: { id: socket.id, ...room.users[socket.id] },
      users: room.users,
      layers: room.layers,
      strokes: room.strokes,
      isHost: room.hostSocketId === socket.id,
    });

    socket.to(roomId).emit('user_joined', { id: socket.id, ...room.users[socket.id] });
    io.to(roomId).emit('presence_update', { users: room.users });
    if (room.isPublic) broadcastRoomList();
  });

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
    room.users[targetId].canDraw = canDraw;
    io.to(currentRoomId).emit('permission_changed', { targetId, canDraw });
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
