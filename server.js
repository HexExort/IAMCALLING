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
    return res.status(400).json({ error: 'INVALID_INPUT' });
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
      return res.status(400).json({ error: 'USERNAME_TAKEN' });
    }
    console.error(err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'USER_NOT_FOUND' });
  }
  const valid = await bcrypt.compare(password, rows[0].password_hash);
  if (!valid) {
    return res.status(400).json({ error: 'WRONG_PASSWORD' });
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
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
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

// Current list of online users with their chosen status planet
app.get('/api/online-users', async (req, res) => {
  const usernames = Array.from(onlineUsers.keys());
  if (usernames.length === 0) return res.json([]);
  const { rows } = await pool.query(
    'SELECT username, status_planet FROM users WHERE username = ANY($1)',
    [usernames]
  );
  res.json(rows.map(r => ({ username: r.username, planet: r.status_planet || 'earth' })));
});

// Get/set the planet that represents you when online
app.get('/api/status-planet', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
  const { rows } = await pool.query('SELECT status_planet FROM users WHERE username = $1', [req.session.username]);
  res.json({ planet: rows[0]?.status_planet || 'earth' });
});

app.post('/api/status-planet', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
  const { planet } = req.body;
  const VALID = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
  if (!VALID.includes(planet)) return res.status(400).json({ error: 'INVALID_PLANET' });
  await pool.query('UPDATE users SET status_planet = $1 WHERE username = $2', [planet, req.session.username]);
  io.emit('presence', { username: req.session.username, online: true, planet });
  res.json({ ok: true });
});

// List of people the logged-in user has chatted with, most recent first
app.get('/api/contacts', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
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
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
  const room = roomFor(req.session.username, req.params.contact);
  const { rows } = await pool.query(
    'SELECT sender, body, created_at FROM messages WHERE room = $1 ORDER BY created_at ASC LIMIT 200',
    [room]
  );
  res.json(rows);
});

// Delete an entire chat thread with a contact
app.delete('/api/messages/:contact', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
  const room = roomFor(req.session.username, req.params.contact);
  await pool.query('DELETE FROM messages WHERE room = $1', [room]);
  res.json({ ok: true });
});

// List of group chats (created from group calls) the user is a member of
app.get('/api/group-chats', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
  const { rows } = await pool.query(
    `SELECT gc.id,
            (SELECT array_agg(username) FROM group_chat_members WHERE group_chat_id = gc.id) AS members,
            (SELECT body FROM messages WHERE group_chat_id = gc.id ORDER BY created_at DESC LIMIT 1) AS last_body,
            (SELECT sender FROM messages WHERE group_chat_id = gc.id ORDER BY created_at DESC LIMIT 1) AS last_sender,
            (SELECT created_at FROM messages WHERE group_chat_id = gc.id ORDER BY created_at DESC LIMIT 1) AS last_at
     FROM group_chats gc
     WHERE gc.id IN (SELECT group_chat_id FROM group_chat_members WHERE username = $1)
     ORDER BY last_at DESC NULLS LAST`,
    [req.session.username]
  );
  res.json(rows);
});

// Message history for a specific group chat (only if the requester is a member)
app.get('/api/group-messages/:id', async (req, res) => {
  if (!req.session.username) return res.status(401).json({ error: 'AUTH' });
  const isMember = await pool.query(
    'SELECT 1 FROM group_chat_members WHERE group_chat_id = $1 AND username = $2',
    [req.params.id, req.session.username]
  );
  if (isMember.rows.length === 0) return res.status(403).json({ error: 'NOT_A_MEMBER' });
  const { rows } = await pool.query(
    'SELECT sender, body, created_at FROM messages WHERE group_chat_id = $1 ORDER BY created_at ASC LIMIT 300',
    [req.params.id]
  );
  res.json(rows);
});

// --- Socket.io: chat + WebRTC signaling ---
// Track which socket belongs to which logged-in username
const onlineUsers = new Map(); // username -> socket.id
// callee username -> { from, video, expiresAt } — a call attempt that
// missed the callee because they were offline (got a push instead).
// Picked back up automatically if they come online in time.
const pendingCalls = new Map();
const groupCalls = new Map(); // callId -> { members: Set<username>, video: boolean }

io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username;
  if (!username) {
    socket.disconnect();
    return;
  }

  onlineUsers.set(username, socket.id);
  pool.query('SELECT status_planet FROM users WHERE username = $1', [username]).then(({ rows }) => {
    io.emit('presence', { username, online: true, planet: rows[0]?.status_planet || 'earth' });
  });

  // Did someone try to call us while we were offline? Pick it back up.
  const pending = pendingCalls.get(username);
  if (pending && pending.expiresAt > Date.now()) {
    pendingCalls.delete(username);
    const room = roomFor(username, pending.from);
    socket.join(room);
    socket.emit('incoming-call', { from: pending.from, video: pending.video });
    // Let the caller know we're here now, in case they're still waiting —
    // their client will send a fresh offer to actually establish the call.
    const callerSocketId = onlineUsers.get(pending.from);
    if (callerSocketId) {
      io.to(callerSocketId).emit('callee-reconnected', { contact: username });
    }
  } else if (pending) {
    pendingCalls.delete(username);
  }

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

  // --- Group chats (created from finished group calls) ---
  function groupChatRoom(id) {
    return `groupchat:${id}`;
  }

  socket.on('join-group-chat', async (groupChatId) => {
    const isMember = await pool.query(
      'SELECT 1 FROM group_chat_members WHERE group_chat_id = $1 AND username = $2',
      [groupChatId, username]
    );
    if (isMember.rows.length === 0) return;
    socket.join(groupChatRoom(groupChatId));
  });

  socket.on('group-chat-message', async ({ groupChatId, body }) => {
    const isMember = await pool.query(
      'SELECT 1 FROM group_chat_members WHERE group_chat_id = $1 AND username = $2',
      [groupChatId, username]
    );
    if (isMember.rows.length === 0) return;

    await pool.query(
      'INSERT INTO messages (group_chat_id, sender, body) VALUES ($1, $2, $3)',
      [groupChatId, username, body]
    );
    io.to(groupChatRoom(groupChatId)).emit('group-chat-message', {
      groupChatId, sender: username, body, created_at: new Date()
    });

    // Push notification for offline members
    const members = await pool.query(
      'SELECT username FROM group_chat_members WHERE group_chat_id = $1',
      [groupChatId]
    );
    members.rows.forEach(row => {
      if (row.username !== username && !onlineUsers.has(row.username)) {
        sendPushToUser(row.username, { type: 'message', from: username, body: body.slice(0, 100) });
      }
    });
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
      // Remember this call so that if the callee opens the app from the
      // push notification a bit later, we can pick it back up instead of
      // it just silently going nowhere.
      pendingCalls.set(contact, { from: username, video: !!video, expiresAt: Date.now() + 90000 });
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
    groupCalls.set(callId, {
      members: new Set([username]),
      everJoined: new Set([username]),
      video: !!video,
      startedAt: Date.now()
    });
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
      if (typeof callback === 'function') callback({ error: 'CALL_ENDED' });
      return;
    }
    if (call.members.size >= MAX_GROUP_SIZE && !call.members.has(username)) {
      if (typeof callback === 'function') callback({ error: 'CALL_FULL' });
      return;
    }

    const existing = Array.from(call.members).filter(u => u !== username);
    call.members.add(username);
    call.everJoined.add(username);
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

  async function leaveGroupCall(socket, username, callId) {
    const call = groupCalls.get(callId);
    if (!call) return;
    call.members.delete(username);
    socket.leave(groupRoom(callId));
    socket.to(groupRoom(callId)).emit('group-participant-left', { callId, username });
    if (socket.data.groupCallId === callId) {
      socket.data.groupCallId = null;
    }
    if (call.members.size === 0) {
      groupCalls.delete(callId);
      await finalizeGroupCallAsChat(callId, call);
    }
  }

  // When a group call fully ends, turn it into a persistent group chat for
  // everyone who was ever part of it, with a summary message.
  async function finalizeGroupCallAsChat(callId, call) {
    const members = Array.from(call.everJoined);
    if (members.length < 2) return; // a "call" with just yourself isn't a group chat

    try {
      await pool.query('INSERT INTO group_chats (id) VALUES ($1) ON CONFLICT DO NOTHING', [callId]);
      for (const member of members) {
        await pool.query(
          'INSERT INTO group_chat_members (group_chat_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [callId, member]
        );
      }

      const durationSec = (Date.now() - call.startedAt) / 1000;
      const EARTH_DEG_PER_SEC = 360 / 86164.0905;
      const degrees = (durationSec * EARTH_DEG_PER_SEC).toFixed(3);
      const summary = `👥📞😊 🌍${degrees}°`;

      await pool.query(
        'INSERT INTO messages (group_chat_id, sender, body) VALUES ($1, $2, $3)',
        [callId, '__system__', summary]
      );

      members.forEach(member => {
        const targetSocketId = onlineUsers.get(member);
        if (targetSocketId) {
          io.to(targetSocketId).emit('group-chat-updated', { groupChatId: callId });
        }
      });
    } catch (err) {
      console.error('Failed to finalize group call as chat', err);
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
