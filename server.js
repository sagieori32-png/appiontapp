// שרת האפליקציה – Express + SQLite (מקומי) או Postgres (בשרת, עם DATABASE_URL)
require('./env').load();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const mailer = require('./mailer');
const agent = require('./agent');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_DAYS = 30;
const COOKIE = 'sid';

app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

// ---------- עזרים ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = e => String(e || '').trim().toLowerCase();
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
const tempPassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), b => chars[b % chars.length]).join('');
};

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}
const pollLink = (req, publicId) => `${baseUrl(req)}/p/${publicId}`;

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

const publicUser = u => u && ({
  id: u.id, email: u.email, name: u.name,
  is_admin: !!u.is_admin, must_change_password: !!u.must_change_password,
});

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

// הגנה בסיסית מפני CSRF: בקשות משנות-מצב חייבות להיות JSON מאותו מקור
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!req.is('application/json')) return fail(res, 415, 'בקשה לא תקינה');
    const origin = req.get('origin');
    if (origin && new URL(origin).host !== req.get('host')) return fail(res, 403, 'בקשה ממקור לא מורשה');
  }
  next();
});

// זיהוי המשתמש מתוך העוגייה
app.use(async (req, res, next) => {
  const token = parseCookies(req)[COOKIE];
  if (token && req.path.startsWith('/api/')) {
    try {
      const row = await db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                                WHERE s.token = ? AND s.expires_at > ?`, token, Date.now());
      if (row) { req.user = row; req.sessionToken = token; }
    } catch (e) { return next(e); }
  }
  next();
});

const requireUser = (req, res, next) => req.user ? next() : fail(res, 401, 'יש להתחבר למערכת');
const requireAdmin = (req, res, next) => req.user?.is_admin ? next() : fail(res, 403, 'פעולה זו מותרת למנהל המערכת בלבד');

// ---------- התחברות ----------
const loginAttempts = new Map(); // הגבלת ניסיונות לפי IP

app.post('/api/login', async (req, res) => {
  const key = req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(key) || { count: 0, until: 0 };
  if (rec.until > now) return fail(res, 429, 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.');

  const email = normEmail(req.body.email);
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    rec.count++;
    if (rec.count >= 8) { rec.until = now + 10 * 60 * 1000; rec.count = 0; }
    loginAttempts.set(key, rec);
    return fail(res, 401, 'האימייל או הסיסמה שגויים');
  }
  loginAttempts.delete(key);

  const token = randomToken();
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, user.id, now + SESSION_DAYS * 86400000);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', async (req, res) => {
  if (req.sessionToken) await db.run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) || null, mail_configured: mailer.configured, ai_configured: agent.aiConfigured }));

app.post('/api/me/password', requireUser, async (req, res) => {
  const { current, next } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return fail(res, 400, 'הסיסמה הנוכחית שגויה');
  if (String(next || '').length < 8) return fail(res, 400, 'הסיסמה החדשה צריכה להכיל לפחות 8 תווים');
  await db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', bcrypt.hashSync(next, 10), req.user.id);
  // ניתוק שאר ההתחברויות של המשתמש
  await db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', req.user.id, req.sessionToken);
  res.json({ ok: true });
});

app.patch('/api/me', requireUser, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return fail(res, 400, 'יש להזין שם');
  await db.run('UPDATE users SET name = ? WHERE id = ?', name.slice(0, 80), req.user.id);
  res.json({ ok: true });
});

// ---------- ניהול משתמשים (מנהל בלבד) ----------
app.get('/api/admin/users', requireUser, requireAdmin, async (req, res) => {
  const users = await db.all(`SELECT id, email, name, is_admin, must_change_password, created_at
                              FROM users ORDER BY created_at DESC, id DESC`);
  res.json({ users: users.map(u => ({ ...u, is_admin: !!u.is_admin, must_change_password: !!u.must_change_password })) });
});

app.post('/api/admin/users', requireUser, requireAdmin, async (req, res) => {
  const email = normEmail(req.body.email);
  const name = String(req.body.name || '').trim();
  if (!EMAIL_RE.test(email)) return fail(res, 400, 'כתובת האימייל אינה תקינה');
  if (!name) return fail(res, 400, 'יש להזין שם');
  if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) return fail(res, 409, 'כבר קיים משתמש עם האימייל הזה');

  const password = String(req.body.password || '').trim() || tempPassword();
  if (password.length < 8) return fail(res, 400, 'הסיסמה צריכה להכיל לפחות 8 תווים');
  const id = await db.insert('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, ?) RETURNING id',
    email, name.slice(0, 80), bcrypt.hashSync(password, 10), req.body.is_admin ? 1 : 0);

  let mail = null;
  if (req.body.send_email) {
    try { mail = await mailer.welcome({ to: email, name, password, link: baseUrl(req) }); }
    catch (e) { console.error(e); mail = { error: 'המשתמש נוצר, אבל שליחת המייל נכשלה' }; }
  }
  res.json({ id, password, mail });
});

app.patch('/api/admin/users/:id', requireUser, requireAdmin, async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id) || 0);
  if (!user) return fail(res, 404, 'המשתמש לא נמצא');
  if ('is_admin' in req.body && user.id === req.user.id && !req.body.is_admin) return fail(res, 400, 'אי אפשר להסיר הרשאת מנהל מעצמך');
  const name = 'name' in req.body ? String(req.body.name).trim().slice(0, 80) || user.name : user.name;
  const isAdmin = 'is_admin' in req.body ? (req.body.is_admin ? 1 : 0) : user.is_admin;
  await db.run('UPDATE users SET name = ?, is_admin = ? WHERE id = ?', name, isAdmin, user.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-password', requireUser, requireAdmin, async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id) || 0);
  if (!user) return fail(res, 404, 'המשתמש לא נמצא');
  const password = tempPassword();
  await db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', bcrypt.hashSync(password, 10), user.id);
  await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  let mail = null;
  if (req.body.send_email) {
    try { mail = await mailer.welcome({ to: user.email, name: user.name, password, link: baseUrl(req) }); }
    catch (e) { console.error(e); mail = { error: 'הסיסמה אופסה, אבל שליחת המייל נכשלה' }; }
  }
  res.json({ password, mail });
});

app.delete('/api/admin/users/:id', requireUser, requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return fail(res, 400, 'אי אפשר למחוק את המשתמש שלך');
  const info = await db.run('DELETE FROM users WHERE id = ?', Number(req.params.id) || 0);
  if (!info.changes) return fail(res, 404, 'המשתמש לא נמצא');
  res.json({ ok: true });
});

// רשימת משתמשים להשלמה אוטומטית בבחירת משתתפים
app.get('/api/users', requireUser, async (req, res) => {
  res.json({ users: await db.all('SELECT email, name FROM users ORDER BY name') });
});

// ---------- סקרים ----------
function loadPoll(publicId) {
  return db.get('SELECT * FROM polls WHERE public_id = ?', String(publicId));
}

// משתתפים מוזמנים לפי אימייל – לא חייבים להיות משתמשים רשומים
function validateParticipants(list) {
  const emails = [...new Set((Array.isArray(list) ? list : []).map(normEmail).filter(Boolean))];
  const invalid = emails.filter(e => !EMAIL_RE.test(e));
  if (invalid.length) return { error: `כתובות לא תקינות: ${invalid.join(', ')}` };
  if (emails.length > 500) return { error: 'יותר מדי משתתפים' };
  return { emails };
}

const inviteToken = () => randomToken(18);
async function addInvites(t, pollId, emails) {
  for (const e of emails) {
    await t.run('INSERT INTO poll_invites (poll_id, email, token) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', pollId, e, inviteToken());
  }
}

// הקישור לסקר. למוזמן – הקישור האישי שלו, שמאפשר לענות בלי חשבון
async function personalLink(base, poll, email) {
  const inv = await db.get('SELECT token FROM poll_invites WHERE poll_id = ? AND email = ?', poll.id, normEmail(email));
  return `${base}/p/${poll.public_id}${inv?.token ? '?t=' + inv.token : ''}`;
}

// כל מי שקשור לסקר: המוזמנים ומי שענה
async function pollRecipients(poll) {
  return [...new Set([
    ...(await db.all('SELECT email FROM poll_invites WHERE poll_id = ?', poll.id)).map(r => r.email),
    ...(await db.all('SELECT email FROM votes WHERE poll_id = ?', poll.id)).map(r => r.email),
  ].map(normEmail))];
}

function runAgent(req, poll, extra = {}) {
  const base = baseUrl(req);
  return agent.run(poll.id, { link: `${base}/p/${poll.public_id}`, linkFor: e => personalLink(base, poll, e), ...extra });
}

// מי צופה בסקר: משתמש מחובר, או מוזמן עם קישור אישי – שתקף לסקר הזה בלבד
async function resolveViewer(req, res, poll) {
  const t = String(req.query.t || '').slice(0, 100);
  if (t) {
    const inv = await db.get(`SELECT i.email, u.id AS user_id, u.name FROM poll_invites i
                              LEFT JOIN users u ON u.email = i.email WHERE i.poll_id = ? AND i.token = ?`, poll.id, t);
    if (inv) return { email: normEmail(inv.email), user_id: inv.user_id ?? null, name: inv.name || '', guest: true };
    if (!req.user) { fail(res, 403, 'הקישור האישי אינו תקף לסקר הזה. בקשו מיוצר/ת הסקר לשלוח לכם קישור חדש.'); return null; }
  }
  if (req.user) return { email: normEmail(req.user.email), user_id: req.user.id, name: req.user.name, guest: false };
  fail(res, 401, 'יש להתחבר למערכת');
  return null;
}

function validateOptions(list) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;
  const out = [];
  const seen = new Set();
  for (const o of Array.isArray(list) ? list : []) {
    const date = String(o.date || '');
    const start = o.start_time ? String(o.start_time) : null;
    const end = o.end_time ? String(o.end_time) : null;
    if (!DATE.test(date) || isNaN(Date.parse(date))) return { error: 'אחד התאריכים אינו תקין' };
    if (start && !TIME.test(start)) return { error: 'אחת השעות אינה תקינה' };
    if (end && (!TIME.test(end) || !start || end <= start)) return { error: 'שעת הסיום צריכה להיות אחרי שעת ההתחלה' };
    const key = `${date}|${start}|${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, start, end });
  }
  if (!out.length) return { error: 'יש לבחור לפחות תאריך אחד' };
  if (out.length > 200) return { error: 'יותר מדי אפשרויות' };
  out.sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
  return { options: out };
}

app.get('/api/polls', requireUser, async (req, res) => {
  const email = normEmail(req.user.email), uid = req.user.id;
  const rows = await db.all(`
    SELECT p.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM votes v WHERE v.poll_id = p.id) AS vote_count,
      (SELECT COUNT(*) FROM poll_invites i WHERE i.poll_id = p.id) AS invite_count,
      (SELECT COUNT(*) FROM poll_options o WHERE o.poll_id = p.id) AS option_count,
      (SELECT MIN(date) FROM poll_options o WHERE o.poll_id = p.id) AS first_date,
      EXISTS (SELECT 1 FROM votes v WHERE v.poll_id = p.id AND v.email = ?) AS i_voted,
      (p.owner_id = ?) AS is_owner
    FROM polls p JOIN users u ON u.id = p.owner_id
    WHERE p.owner_id = ?
       OR EXISTS (SELECT 1 FROM poll_invites i WHERE i.poll_id = p.id AND i.email = ?)
       OR EXISTS (SELECT 1 FROM votes v WHERE v.poll_id = p.id AND v.email = ?)
    ORDER BY p.created_at DESC, p.id DESC`, email, uid, uid, email, email);
  res.json({ polls: rows.map(p => ({
    public_id: p.public_id, title: p.title, owner_name: p.owner_name, closed: !!p.closed,
    vote_count: p.vote_count, invite_count: p.invite_count, option_count: p.option_count,
    first_date: p.first_date, i_voted: !!p.i_voted, is_owner: !!p.is_owner, created_at: p.created_at,
  })) });
});

app.post('/api/polls', requireUser, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return fail(res, 400, 'יש להזין נושא לפגישה');
  const opts = validateOptions(req.body.options);
  if (opts.error) return fail(res, 400, opts.error);
  const parts = validateParticipants(req.body.participants);
  if (parts.error) return fail(res, 400, parts.error);

  const publicId = randomToken(9);
  await db.tx(async t => {
    const pollId = await t.insert(`INSERT INTO polls (public_id, owner_id, title, description, location, agent_enabled, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      publicId, req.user.id, title.slice(0, 200),
      String(req.body.description || '').trim().slice(0, 2000) || null,
      String(req.body.location || '').trim().slice(0, 200) || null,
      req.body.agent_enabled === false ? 0 : 1, db.now());
    for (const [i, o] of opts.options.entries()) {
      await t.run('INSERT INTO poll_options (poll_id, date, start_time, end_time, sort) VALUES (?, ?, ?, ?, ?)', pollId, o.date, o.start, o.end, i);
    }
    await addInvites(t, pollId, parts.emails);
  });
  res.json({ public_id: publicId, link: pollLink(req, publicId) });
});

app.get('/api/polls/:pid', async (req, res) => {
  const poll = await loadPoll(req.params.pid);
  if (!poll) return fail(res, 404, 'הסקר לא נמצא. ייתכן שהקישור שגוי או שהסקר נמחק.');
  const viewer = await resolveViewer(req, res, poll); if (!viewer) return;
  const owner = await db.get('SELECT name, email FROM users WHERE id = ?', poll.owner_id);
  const options = await db.all('SELECT id, date, start_time, end_time FROM poll_options WHERE poll_id = ? ORDER BY sort, id', poll.id);
  const votes = await db.all(`SELECT id, name, comment, updated_at, email FROM votes
                              WHERE poll_id = ? ORDER BY updated_at, id`, poll.id);
  const answers = await db.all(`SELECT a.vote_id, a.option_id, a.answer FROM vote_answers a
                                JOIN votes v ON v.id = a.vote_id WHERE v.poll_id = ?`, poll.id);
  const byVote = {};
  answers.forEach(a => { (byVote[a.vote_id] ||= {})[a.option_id] = a.answer; });
  const isOwner = !viewer.guest && poll.owner_id === viewer.user_id;
  const base = baseUrl(req);
  const invites = !isOwner ? [] : await db.all(`SELECT i.email, i.sent_at, i.token, u.name FROM poll_invites i
                              LEFT JOIN users u ON u.email = i.email WHERE i.poll_id = ? ORDER BY i.email`, poll.id);

  res.json({
    poll: {
      public_id: poll.public_id, title: poll.title, description: poll.description, location: poll.location,
      closed: !!poll.closed, final_option_id: poll.final_option_id, created_at: poll.created_at,
      owner_name: owner?.name, owner_email: owner?.email, link: pollLink(req, poll.public_id),
    },
    is_owner: isOwner,
    me: { name: viewer.name, email: viewer.email, guest: viewer.guest },
    options,
    agent: {
      enabled: !!poll.agent_enabled,
      ai_configured: agent.aiConfigured,
      status: poll.agent_status,
      ran_at: poll.agent_ran_at,
      handled_this_round: poll.agent_round >= poll.round,
      result: isOwner ? safeJson(poll.agent_result) : undefined,
      progress: await agent.progress(poll.id),
    },
    votes: votes.map(v => ({
      id: v.id, name: v.name, comment: v.comment, updated_at: v.updated_at,
      is_me: normEmail(v.email) === viewer.email, email: isOwner ? v.email : undefined,
      answers: byVote[v.id] || {},
    })),
    invites: invites.map(i => ({
      email: i.email, name: i.name, sent: !!i.sent_at,
      link: `${base}/p/${poll.public_id}?t=${i.token}`,
      voted: votes.some(v => v.email.toLowerCase() === i.email.toLowerCase()),
    })),
  });
});

app.put('/api/polls/:pid/vote', async (req, res) => {
  const poll = await loadPoll(req.params.pid);
  if (!poll) return fail(res, 404, 'הסקר לא נמצא');
  const viewer = await resolveViewer(req, res, poll); if (!viewer) return;
  if (poll.closed) return fail(res, 400, 'הסקר נסגר ולא ניתן לעדכן תשובות');
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return fail(res, 400, 'יש לרשום את שמך');
  const validIds = new Set((await db.all('SELECT id FROM poll_options WHERE poll_id = ?', poll.id)).map(o => o.id));
  const answers = Object.entries(req.body.answers || {})
    .map(([id, a]) => [Number(id), a])
    .filter(([id, a]) => validIds.has(id) && ['yes', 'maybe', 'no'].includes(a));

  await db.tx(async t => {
    const voteId = await t.insert(`INSERT INTO votes (poll_id, user_id, email, name, comment, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (poll_id, email) DO UPDATE SET name = excluded.name, comment = excluded.comment,
                user_id = COALESCE(excluded.user_id, votes.user_id), updated_at = excluded.updated_at
                RETURNING id`,
      poll.id, viewer.user_id, viewer.email, name, String(req.body.comment || '').trim().slice(0, 500) || null, db.now());
    await t.run('DELETE FROM vote_answers WHERE vote_id = ?', voteId);
    // מועד שלא סומן נחשב "לא מתאים" (כמו ב-Doodle)
    const given = new Map(answers);
    for (const id of validIds) {
      await t.run('INSERT INTO vote_answers (vote_id, option_id, answer) VALUES (?, ?, ?)', voteId, id, given.get(id) || 'no');
    }
  });
  res.json({ ok: true });
  // אחרי כל תשובה – בודקים ברקע אם כולם ענו, ואם כן הסוכן מחליט
  runAgent(req, poll).catch(e => console.error(e));
});

async function requireOwner(req, res) {
  const poll = await loadPoll(req.params.pid);
  if (!poll) { fail(res, 404, 'הסקר לא נמצא'); return null; }
  if (poll.owner_id !== req.user.id && !req.user.is_admin) { fail(res, 403, 'רק יוצר/ת הסקר יכול/ה לבצע פעולה זו'); return null; }
  return poll;
}

// הוספת משתתפים לסקר קיים
app.post('/api/polls/:pid/participants', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  const parts = validateParticipants(req.body.emails);
  if (parts.error) return fail(res, 400, parts.error);
  await addInvites(db, poll.id, parts.emails);
  res.json({ ok: true });
});

app.delete('/api/polls/:pid/participants', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  await db.run('DELETE FROM poll_invites WHERE poll_id = ? AND email = ?', poll.id, normEmail(req.body.email));
  res.json({ ok: true });
});

// שליחת הזמנות במייל. only_unsent=true שולח רק למי שעוד לא קיבל
app.post('/api/polls/:pid/send', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  let invites = await db.all('SELECT email, sent_at, token FROM poll_invites WHERE poll_id = ?', poll.id);
  if (req.body.only_unsent) invites = invites.filter(i => !i.sent_at);
  if (!invites.length) return fail(res, 400, 'אין משתתפים לשליחה');
  const owner = await db.get('SELECT name FROM users WHERE id = ?', poll.owner_id);
  const base = baseUrl(req);
  const failed = [];
  for (const inv of invites) {
    try { await mailer.pollInvite({ to: inv.email, ownerName: owner.name, poll, link: `${base}/p/${poll.public_id}?t=${inv.token}` });
      await db.run('UPDATE poll_invites SET sent_at = ? WHERE poll_id = ? AND email = ?', db.now(), poll.id, inv.email); }
    catch (e) { console.error('mail failed', inv.email, e.message); failed.push(inv.email); }
  }
  res.json({ sent: invites.length - failed.length, failed, simulated: !mailer.configured });
});

app.post('/api/polls/:pid/close', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  let finalId = req.body.final_option_id ? Number(req.body.final_option_id) : null;
  let opt = null;
  if (finalId) {
    opt = await db.get('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?', finalId, poll.id);
    if (!opt) return fail(res, 400, 'המועד שנבחר אינו שייך לסקר');
  }
  await db.run('UPDATE polls SET closed = 1, final_option_id = ? WHERE id = ?', finalId, poll.id);

  let notified = 0;
  if (opt && req.body.notify) {
    const owner = await db.get('SELECT name FROM users WHERE id = ?', poll.owner_id);
    const recipients = await pollRecipients(poll);
    const when = formatOption(opt);
    for (const to of recipients) {
      try { await mailer.finalChosen({ to, ownerName: owner.name, poll, when, link: await personalLink(baseUrl(req), poll, to) }); notified++; }
      catch (e) { console.error('mail failed', to, e.message); }
    }
  }
  res.json({ ok: true, notified, simulated: !mailer.configured });
});

app.post('/api/polls/:pid/reopen', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  await db.run('UPDATE polls SET closed = 0, final_option_id = NULL, agent_status = NULL WHERE id = ?', poll.id);
  res.json({ ok: true });
});

app.delete('/api/polls/:pid', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  await db.run('DELETE FROM polls WHERE id = ?', poll.id);
  res.json({ ok: true });
});

const formatOption = agent.formatOption;

// ---------- סוכן AI ----------
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

app.patch('/api/polls/:pid/agent', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  await db.run('UPDATE polls SET agent_enabled = ? WHERE id = ?', req.body.enabled ? 1 : 0, poll.id);
  res.json({ ok: true });
  if (req.body.enabled) runAgent(req, poll).catch(e => console.error(e));
});

// הפעלה ידנית – גם אם לא כולם ענו עדיין
app.post('/api/polls/:pid/agent/run', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  if (poll.closed) return fail(res, 400, 'הסקר כבר סגור');
  const result = await runAgent(req, poll, { force: true });
  if (result.error) return fail(res, 400, result.error);
  if (result.skipped === 'already_running') return fail(res, 409, 'הסוכן כבר עובד על הסקר הזה');
  res.json({ result });
});

// הוספת מועדים לסקר קיים (למשל אחרי שהסוכן ביקש)
app.post('/api/polls/:pid/options', requireUser, async (req, res) => {
  const poll = await requireOwner(req, res); if (!poll) return;
  const opts = validateOptions(req.body.options);
  if (opts.error) return fail(res, 400, opts.error);
  const existing = new Set((await db.all('SELECT date, start_time, end_time FROM poll_options WHERE poll_id = ?', poll.id))
    .map(o => `${o.date}|${o.start_time}|${o.end_time}`));
  const fresh = opts.options.filter(o => !existing.has(`${o.date}|${o.start}|${o.end}`));
  if (!fresh.length) return fail(res, 400, 'כל המועדים האלה כבר קיימים בסקר');

  await db.tx(async t => {
    for (const o of fresh) {
      await t.run('INSERT INTO poll_options (poll_id, date, start_time, end_time, sort) VALUES (?, ?, ?, ?, 0)', poll.id, o.date, o.start, o.end);
    }
    // סידור מחדש לפי תאריך ושעה
    const all = await t.all("SELECT id FROM poll_options WHERE poll_id = ? ORDER BY date, COALESCE(start_time, ''), id", poll.id);
    for (const [i, o] of all.entries()) await t.run('UPDATE poll_options SET sort = ? WHERE id = ?', i, o.id);
    // סבב חדש: הסוכן יפעל שוב כשכולם יסמנו גם את המועדים החדשים
    await t.run('UPDATE polls SET round = round + 1, closed = 0, final_option_id = NULL, agent_status = NULL WHERE id = ?', poll.id);
  });

  let notified = 0;
  if (req.body.notify) {
    const owner = await db.get('SELECT name FROM users WHERE id = ?', poll.owner_id);
    const to = await pollRecipients(poll);
    for (const email of to) {
      try { await mailer.newOptions({ to: email, ownerName: owner.name, poll, link: await personalLink(baseUrl(req), poll, email) }); notified++; }
      catch (e) { console.error('mail failed', email, e.message); }
    }
  }
  res.json({ added: fresh.length, notified, simulated: !mailer.configured });
});


// מוזמן שאין לו את הקישור האישי: מזין את האימייל ומקבל אותו במייל.
// התשובה זהה תמיד, כדי לא לחשוף מי מוזמן לסקר.
const linkRequests = new Map();
app.post('/api/polls/:pid/request-link', async (req, res) => {
  const now = Date.now();
  const rec = linkRequests.get(req.ip) || { count: 0, since: now };
  if (now - rec.since > 10 * 60 * 1000) { rec.count = 0; rec.since = now; }
  if (++rec.count > 10) return fail(res, 429, 'יותר מדי בקשות. נסו שוב בעוד כמה דקות.');
  linkRequests.set(req.ip, rec);

  const poll = await loadPoll(req.params.pid);
  const email = normEmail(req.body.email);
  if (!EMAIL_RE.test(email)) return fail(res, 400, 'כתובת האימייל אינה תקינה');
  if (poll && !poll.closed) {
    const inv = await db.get('SELECT token FROM poll_invites WHERE poll_id = ? AND email = ?', poll.id, email);
    if (inv) {
      const owner = await db.get('SELECT name FROM users WHERE id = ?', poll.owner_id);
      mailer.pollInvite({ to: email, ownerName: owner.name, poll, link: `${baseUrl(req)}/p/${poll.public_id}?t=${inv.token}` })
        .catch(e => console.error('mail failed', email, e.message));
    }
  }
  res.json({ ok: true, mail_configured: mailer.configured });
});

// ---------- קבצים סטטיים וניתוב צד-לקוח ----------
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (req, res) => fail(res, 404, 'נתיב לא קיים'));

// שגיאה לא צפויה (למשל מסד הנתונים לא זמין) – תשובה מסודרת במקום קריסה
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err);
  if (res.headersSent) return next(err);
  fail(res, 500, 'אירעה שגיאה בשרת. נסו שוב בעוד רגע.');
});

// ---------- יצירת מנהל ראשון ----------
async function ensureAdmin() {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM users');
  if (Number(n) > 0) return;
  const email = normEmail(process.env.ADMIN_EMAIL || 'admin@example.com');
  const password = process.env.ADMIN_PASSWORD || tempPassword();
  await db.run('INSERT INTO users (email, name, password_hash, is_admin, must_change_password) VALUES (?, ?, ?, 1, ?)',
    email, process.env.ADMIN_NAME || 'מנהל המערכת', bcrypt.hashSync(password, 10), process.env.ADMIN_PASSWORD ? 0 : 1);
  console.log('\n========================================');
  console.log(' נוצר משתמש מנהל ראשון');
  console.log(` אימייל: ${email}`);
  console.log(` סיסמה:  ${password}`);
  console.log('========================================\n');
}

(async () => {
  await db.init();
  await ensureAdmin();
  app.listen(PORT, () => {
    console.log(`השרת פועל: http://localhost:${PORT} (מסד נתונים: ${db.kind === 'postgres' ? 'Postgres' : 'SQLite מקומי'})`);
    if (!mailer.configured) console.log('שימו לב: SMTP לא מוגדר – מיילים יודפסו ליומן במקום להישלח.');
  });
})().catch(e => {
  console.error('\nהשרת לא הצליח לעלות:', e.message);
  if (db.kind === 'postgres') console.error('בדקו את DATABASE_URL ושמסד הנתונים זמין.');
  process.exit(1);
});
