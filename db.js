require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      notify_email TEXT,
      notify_discord TEXT,
      notify_days_before INTEGER DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      item_name TEXT NOT NULL,
      item_source TEXT,
      item_deadline DATE,
      saved_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, item_key)
    );

    CREATE TABLE IF NOT EXISTS notifications_sent (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, item_key)
    );
  `);
}

module.exports = { pool, initDb };
