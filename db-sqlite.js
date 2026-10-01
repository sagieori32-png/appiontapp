// מסד נתונים SQLite מקומי (קובץ data/app.db) – משמש כשאין DATABASE_URL.
// משתמש ב-SQLite שמובנה ב-Node.js (גרסה 22.13 ומעלה), כך שאין צורך בהידור
// ובהתקנת Visual Studio בווינדוס. הקובץ כולל גם שדרוג של מסדי נתונים מגרסאות קודמות.
const path = require('path');
const fs = require('fs');

// משתיקים רק את האזהרה "SQLite is an experimental feature"
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  return origEmit.call(process, warning, ...args);
};
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');


db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS polls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id   TEXT NOT NULL UNIQUE,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  location    TEXT,
  closed      INTEGER NOT NULL DEFAULT 0,
  final_option_id INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS poll_options (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,      -- YYYY-MM-DD
  start_time TEXT,               -- HH:MM או ריק (יום שלם)
  end_time   TEXT,
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_invites (
  poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  email    TEXT NOT NULL COLLATE NOCASE,
  sent_at  TEXT,
  PRIMARY KEY (poll_id, email)
);

-- תשובה לסקר מזוהה לפי אימייל: משתמש רשום (user_id) או מוזמן בלי חשבון (user_id ריק)
CREATE TABLE IF NOT EXISTS votes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email      TEXT NOT NULL COLLATE NOCASE,
  name       TEXT NOT NULL,
  comment    TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (poll_id, email)
);

CREATE TABLE IF NOT EXISTS vote_answers (
  vote_id   INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  answer    TEXT NOT NULL CHECK (answer IN ('yes','maybe','no')),
  PRIMARY KEY (vote_id, option_id)
);
`);

// הוספת עמודות חדשות למסדי נתונים קיימים (שדרוג בלי לאבד נתונים)
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('polls', 'agent_enabled', 'INTEGER NOT NULL DEFAULT 1'); // סוכן AI פעיל לסקר
addColumn('polls', 'round', 'INTEGER NOT NULL DEFAULT 1');         // עולה בכל הוספת מועדים
addColumn('polls', 'agent_round', 'INTEGER NOT NULL DEFAULT 0');   // הסבב האחרון שהסוכן טיפל בו
addColumn('polls', 'agent_status', 'TEXT');                        // scheduled | needs_options | error
addColumn('polls', 'agent_result', 'TEXT');                        // JSON עם ההחלטה וההסבר
addColumn('polls', 'agent_ran_at', 'TEXT');

// קישור אישי לכל מוזמן: מאפשר לענות על הסקר הזה בלבד, בלי חשבון
addColumn('poll_invites', 'token', 'TEXT');
{
  const crypto = require('crypto');
  const missing = db.prepare('SELECT poll_id, email FROM poll_invites WHERE token IS NULL').all();
  const set = db.prepare('UPDATE poll_invites SET token = ? WHERE poll_id = ? AND email = ?');
  missing.forEach(r => set.run(crypto.randomBytes(18).toString('base64url'), r.poll_id, r.email));
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS poll_invites_token ON poll_invites(token)');
}

// שדרוג טבלת התשובות מהגרסה הקודמת (שבה רק משתמשים רשומים ענו)
{
  const cols = db.prepare('PRAGMA table_info(votes)').all().map(c => c.name);
  if (!cols.includes('email')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE votes_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id    INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        email      TEXT NOT NULL COLLATE NOCASE,
        name       TEXT NOT NULL,
        comment    TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (poll_id, email)
      );
      INSERT INTO votes_new (id, poll_id, user_id, email, name, comment, updated_at)
        SELECT v.id, v.poll_id, v.user_id, lower(u.email), v.name, v.comment, v.updated_at
        FROM votes v JOIN users u ON u.id = v.user_id;
      DROP TABLE votes;
      ALTER TABLE votes_new RENAME TO votes;
      COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// אימיילים נשמרים תמיד באותיות קטנות
db.exec('UPDATE users SET email = lower(email) WHERE email != lower(email)');
db.exec('UPDATE poll_invites SET email = lower(email) WHERE email != lower(email)');

module.exports = db;
