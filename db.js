const { Pool } = require('pg');

// Render provides DATABASE_URL automatically when you attach a Postgres database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      username TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (username, endpoint)
    );
  `);

  // Which planet represents this user when they're online (chosen by them)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status_planet TEXT DEFAULT 'earth';`);

  // Group chats — created automatically from a group call (video or audio),
  // with everyone who joined that call as a member
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_chats (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_chat_members (
      group_chat_id TEXT NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (group_chat_id, username)
    );
  `);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_chat_id TEXT;`);
  await pool.query(`ALTER TABLE messages ALTER COLUMN room DROP NOT NULL;`);

  console.log('Database ready');
}

module.exports = { pool, initDb };
