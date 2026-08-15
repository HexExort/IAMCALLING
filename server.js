const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const webpush = require('web-push');
const { pool, initDb } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
});
app.use(sessionMiddleware);

// Share session data with socket.io connections
io.engine.use(sessionMiddleware);

// --- Push notifications setup ---
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:example@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function roomFor(userA, userB) {
  return [userA, userB].sort().join('___');
}

async function sendPushToUser(username, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const { rows } = await pool.query(
    'SELECT endpoint, subscription FROM push_subscriptions WHERE username = $1',
    [username]
  );
  for (const row of rows) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
    } catch (err) {
      // Subscription expired or invalid — clean it up
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query(
          'DELETE FROM push_subscriptions WHERE username = $1 AND endpoint = $2',
          [username, row.endpoint]
        );
      }
    }
  }
}

// --- Auth routes ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 2 || password.length < 4) {
    return res.status(400).json({ error: 'Никнейм от 2 символов, пароль от 4 символов' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [username, hash]
    );
    req.session.username = username;
    res.json({ username });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Такой никнейм уже занят' });
    }
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'Пользователь не найден' });
  }
  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) {
    return res.status(400).json({ error: 'Неверный пароль' });
  }
  req.session.username = username;
  res.json({ username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ username: req.session.username || null });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY || null });
});

// Save a push subscription for the logged-in user
app.post('/api/subscribe', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  const subscription = req.body;
  await pool.query(
    `INSERT INTO push_subscriptions (username, endpoint, subscription)
     VALUES ($1, $2, $3)
     ON CONFLICT (username, endpoint) DO UPDATE SET subscription = $3`,
    [req.session.username, subscription.endpoint, subscription]
  );
  res.json({ ok: true });
});

// Check whether a username is registered (used before opening a new chat)
app.get('/api/user-exists/:username', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT 1 FROM users WHERE username = $1',
    [req.params.username]
  );
  res.json({ exists: rows.length > 0 });
});

// Current list of online usernames (for the contacts list status dots)
app.get('/api/online-users', (req, res) => {
  res.json(Array.from(onlineUsers.keys()));
});

// List of people the logged-in user has chatted with, most recent first
app.get('/api/contacts', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  const username = req.session.username;
  const { rows } = await pool.query(
    `SELECT room, MAX(created_at) AS last_at,
            (ARRAY_AGG(body ORDER BY created_at DESC))[1] AS last_body,
            (ARRAY_AGG(sender ORDER BY created_at DESC))[1] AS last_sender
     FROM messages
     WHERE room LIKE '%' || $1 || '%'
     GROUP BY room
     ORDER BY last_at DESC`,
    [username]
  );
  const contacts = rows
    .map(r => {
      const [a, b] = r.room.split('___');
      const contact = a === username ? b : (b === username ? a : null);
      return contact ? { contact, lastBody: r.last_body, lastSender: r.last_sender, lastAt: r.last_at } : null;
    })
    .filter(Boolean);
  res.json(contacts);
});

// Chat history between the logged-in user and a contact
app.get('/api/messages/:contact', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  const room = roomFor(req.session.username, req.params.contact);
  const { rows } = await pool.query(
    'SELECT sender, body, created_at FROM messages WHERE room = $1 ORDER BY created_at ASC LIMIT 200',
    [room]
  );
  res.json(rows);
});

// Delete an entire chat thread with a contact
app.delete('/api/messages/:contact', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  const room = roomFor(req.session.username, req.params.contact);
  await pool.query('DELETE FROM messages WHERE room = $1', [room]);
  res.json({ ok: true });
});

// --- Socket.io: chat + WebRTC signaling ---
// Track which socket belongs to which logged-in username
const onlineUsers = new Map(); // username -> socket.id
const groupCalls = new Map(); // callId -> { members: Set<username>, video: boolean }

io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username;
  if (!username) {
    socket.disconnect();
    return;
  }

  onlineUsers.set(username, socket.id);
  io.emit('presence', { username, online: true });

  socket.on('join-chat', (contact) => {
    const room = roomFor(username, contact);
    socket.join(room);
    socket.data.room = room;
    socket.data.contact = contact;
  });

  socket.on('chat-message', async ({ contact, body }) => {
    const room = roomFor(username, contact);
    await pool.query(
      'INSERT INTO messages (room, sender, body) VALUES ($1, $2, $3)',
      [room, username, body]
    );
    io.to(room).emit('chat-message', { sender: username, body, created_at: new Date(), room });

    // Push notification if the contact isn't online
    if (!onlineUsers.has(contact)) {
      sendPushToUser(contact, {
        type: 'message',
        from: username,
        body: body.slice(0, 100)
      });
    }
  });

  // Auto-generated notes about missed/finished calls — shown in the chat
  // thread but not pushed as a notification and not attributed to a person.
  socket.on('system-message', async ({ contact, body }) => {
    const room = roomFor(username, contact);
    await pool.query(
      'INSERT INTO messages (room, sender, body) VALUES ($1, $2, $3)',
      [room, '__system__', body]
    );
    io.to(room).emit('chat-message', { sender: '__system__', body, created_at: new Date(), room });
  });

  // --- WebRTC call signaling ---
  socket.on('call-user', ({ contact, video }) => {
    const room = roomFor(username, contact);
    socket.join(room);
    socket.data.room = room;

    // Make sure the callee's socket is also in the room, even if they
    // never opened this chat thread yet — otherwise they never receive
    // the offer/ICE candidates that follow.
    const targetSocketId = onlineUsers.get(contact);
    if (targetSocketId) {
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) targetSocket.join(room);
      io.to(targetSocketId).emit('incoming-call', { from: username, video });
    } else {
      sendPushToUser(contact, {
        type: 'call',
        from: username
      });
    }
  });

  socket.on('signal', ({ contact, data }) => {
    const room = roomFor(username, contact);
    socket.to(room).emit('signal', { from: username, data });
  });

  socket.on('call-ended', ({ contact }) => {
    const room = roomFor(username, contact);
    socket.to(room).emit('call-ended');
  });

  // Relay a video shape choice (circle/star/square/etc) to the other side of a 1:1 call
  socket.on('video-shape', ({ contact, shape }) => {
    const room = roomFor(username, contact);
    socket.to(room).emit('video-shape', { from: username, shape });
  });

  // --- Group calls (mesh: everyone connects to everyone directly) ---
  // callId -> { members: Set<username>, video: boolean }
  const MAX_GROUP_SIZE = 8;

  function groupRoom(callId) {
    return `call:${callId}`;
  }

  socket.on('start-group-call', ({ contacts, video }, callback) => {
    const callId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    groupCalls.set(callId, { members: new Set([username]), video: !!video });
    socket.join(groupRoom(callId));
    socket.data.groupCallId = callId;

    (contacts || []).forEach(contact => {
      const targetSocketId = onlineUsers.get(contact);
      if (targetSocketId) {
        io.to(targetSocketId).emit('group-call-invite', { callId, from: username, video: !!video });
      } else {
        sendPushToUser(contact, { type: 'call', from: username });
      }
    });

    if (typeof callback === 'function') callback({ callId });
  });

  socket.on('invite-to-call', ({ callId, contact }) => {
    const call = groupCalls.get(callId);
    if (!call || !call.members.has(username)) return;
    if (call.members.size >= MAX_GROUP_SIZE) return;
    const targetSocketId = onlineUsers.get(contact);
    if (targetSocketId) {
      io.to(targetSocketId).emit('group-call-invite', { callId, from: username, video: call.video });
    } else {
      sendPushToUser(contact, { type: 'call', from: username });
    }
  });

  socket.on('join-group-call', ({ callId }, callback) => {
    const call = groupCalls.get(callId);
    if (!call) {
      if (typeof callback === 'function') callback({ error: 'Звонок уже завершён' });
      return;
    }
    if (call.members.size >= MAX_GROUP_SIZE && !call.members.has(username)) {
      if (typeof callback === 'function') callback({ error: 'В звонке уже максимум участников (8)' });
      return;
    }

    const existing = Array.from(call.members).filter(u => u !== username);
    call.members.add(username);
    socket.join(groupRoom(callId));
    socket.data.groupCallId = callId;

    if (typeof callback === 'function') {
      callback({ participants: existing, video: call.video });
    }
    socket.to(groupRoom(callId)).emit('group-participant-joined', { callId, username });
  });

  socket.on('group-signal', ({ callId, to, data }) => {
    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('group-signal', { callId, from: username, data });
    }
  });

  // Relay a video shape choice to everyone else in a group call
  socket.on('group-video-shape', ({ callId, shape }) => {
    socket.to(groupRoom(callId)).emit('group-video-shape', { from: username, shape });
  });

  // Relay a quick emoji reaction to everyone else in a group call
  socket.on('group-reaction', ({ callId, emoji }) => {
    socket.to(groupRoom(callId)).emit('group-reaction', { from: username, emoji });
  });

  socket.on('leave-group-call', ({ callId }) => {
    leaveGroupCall(socket, username, callId);
  });

  function leaveGroupCall(socket, username, callId) {
    const call = groupCalls.get(callId);
    if (!call) return;
    call.members.delete(username);
    socket.leave(groupRoom(callId));
    socket.to(groupRoom(callId)).emit('group-participant-left', { callId, username });
    if (call.members.size === 0) {
      groupCalls.delete(callId);
    }
    if (socket.data.groupCallId === callId) {
      socket.data.groupCallId = null;
    }
  }

  socket.on('disconnect', () => {
    if (onlineUsers.get(username) === socket.id) {
      onlineUsers.delete(username);
      io.emit('presence', { username, online: false });
    }
    if (socket.data.groupCallId) {
      leaveGroupCall(socket, username, socket.data.groupCallId);
    }
  });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB', err);
  process.exit(1);
});
