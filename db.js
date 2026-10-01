// שכבת מסד הנתונים.
// - כש-DATABASE_URL מוגדר (למשל Neon בשרת) – Postgres.
// - אחרת – SQLite מקומי בקובץ data/app.db (נוח לבדיקה במחשב).
//
// אותו ממשק לשניהם, כל הפעולות אסינכרוניות:
//   await db.get(sql, ...params)    → שורה אחת או undefined
//   await db.all(sql, ...params)    → מערך שורות
//   await db.run(sql, ...params)    → { changes }
//   await db.insert(sql, ...params) → המזהה החדש (ה-SQL מסתיים ב-RETURNING id)
//   await db.tx(async t => { ... }) → טרנזקציה; ל-t אותו ממשק
// ב-SQL כותבים ? לפרמטרים, בתחביר שעובד בשני המסדים.

const DATABASE_URL = process.env.DATABASE_URL;

// זמן נוכחי בפורמט אחיד (UTC), לשמירה בעמודות טקסט
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function sqliteAdapter() {
  const raw = require('./db-sqlite');
  const api = {
    kind: 'sqlite',
    async get(sql, ...p) { return raw.prepare(sql).get(...p); },
    async all(sql, ...p) { return raw.prepare(sql).all(...p); },
    async run(sql, ...p) { return { changes: Number(raw.prepare(sql).run(...p).changes) }; },
    async insert(sql, ...p) { return raw.prepare(sql).get(...p).id; },
    async init() {},
  };
  // SQLite עובד על חיבור אחד, ולכן טרנזקציות רצות אחת אחרי השנייה
  let queue = Promise.resolve();
  api.tx = fn => {
    const result = queue.then(async () => {
      raw.exec('BEGIN');
      try { const r = await fn(api); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    });
    queue = result.catch(() => {});
    return result;
  };
  return api;
}

function pgAdapter() {
  const pg = require('pg');
  pg.types.setTypeParser(20, v => Number(v)); // COUNT ו-BIGINT כמספרים רגילים
  const pool = new pg.Pool({
    // sslmode=require (כמו בכתובת ש-Neon נותן) → verify-full: אותה התנהגות, בלי אזהרה ביומן
    connectionString: DATABASE_URL.replace(/sslmode=require\b/, 'sslmode=verify-full'),
    max: Number(process.env.DB_POOL_SIZE || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000, // מסד נתונים חינמי עשוי "להתעורר" כמה שניות
  });
  pool.on('error', e => console.error('[db] idle client error:', e.message));

  // ? → $1, $2, ...
  const convert = sql => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const wrap = q => ({
    async get(sql, ...p) { return (await q(convert(sql), p)).rows[0]; },
    async all(sql, ...p) { return (await q(convert(sql), p)).rows; },
    async run(sql, ...p) { return { changes: (await q(convert(sql), p)).rowCount }; },
    async insert(sql, ...p) { return (await q(convert(sql), p)).rows[0].id; },
  });

  const api = { kind: 'postgres', ...wrap((text, values) => pool.query(text, values)) };
  api.tx = async fn => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(wrap((text, values) => client.query(text, values)));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  api.init = async () => {
    const NOW = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT ${NOW}
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS polls (
        id              SERIAL PRIMARY KEY,
        public_id       TEXT NOT NULL UNIQUE,
        owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        description     TEXT,
        location        TEXT,
        closed          INTEGER NOT NULL DEFAULT 0,
        final_option_id INTEGER,
        created_at      TEXT NOT NULL DEFAULT ${NOW},
        agent_enabled   INTEGER NOT NULL DEFAULT 1,
        round           INTEGER NOT NULL DEFAULT 1,
        agent_round     INTEGER NOT NULL DEFAULT 0,
        agent_status    TEXT,
        agent_result    TEXT,
        agent_ran_at    TEXT
      );
      CREATE TABLE IF NOT EXISTS poll_options (
        id         SERIAL PRIMARY KEY,
        poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        date       TEXT NOT NULL,
        start_time TEXT,
        end_time   TEXT,
        sort       INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS poll_invites (
        poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        email   TEXT NOT NULL,
        sent_at TEXT,
        token   TEXT UNIQUE,
        PRIMARY KEY (poll_id, email)
      );
      CREATE TABLE IF NOT EXISTS votes (
        id         SERIAL PRIMARY KEY,
        poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        email      TEXT NOT NULL,
        name       TEXT NOT NULL,
        comment    TEXT,
        updated_at TEXT NOT NULL DEFAULT ${NOW},
        UNIQUE (poll_id, email)
      );
      CREATE TABLE IF NOT EXISTS vote_answers (
        vote_id   INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
        option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
        answer    TEXT NOT NULL CHECK (answer IN ('yes','maybe','no')),
        PRIMARY KEY (vote_id, option_id)
      );
      CREATE INDEX IF NOT EXISTS poll_options_poll ON poll_options(poll_id);
      CREATE INDEX IF NOT EXISTS votes_poll ON votes(poll_id);
      CREATE INDEX IF NOT EXISTS poll_invites_email ON poll_invites(email);
    `);
  };
  return api;
}

const db = DATABASE_URL ? pgAdapter() : sqliteAdapter();
db.now = now;
module.exports = db;
