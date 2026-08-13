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

  console.log('Database ready');
}

module.exports = { pool, initDb };
