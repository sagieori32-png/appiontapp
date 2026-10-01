/* אפליקציית תיאום פגישות – צד לקוח (ללא ספריות) */
(() => {
  'use strict';

  // ---------- עזרים כלליים ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const HE_DAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

  const state = { me: null, mailConfigured: false, aiConfigured: false };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* ריק */ }
    if (!res.ok) {
      if (res.status === 401 && !url.endsWith('/login')) {
        state.me = null;
        navigate(`/login?next=${encodeURIComponent(location.pathname)}`, true);
      }
      const err = new Error(data.error || 'משהו השתבש. נסו שוב.');
      err.data = data;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('bad', bad);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('הקישור הועתק');
  }

  // ---------- תאריכים ----------
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayYmd = () => ymd(new Date());

  function dayTile(dateStr, cls = '') {
    const d = parseYmd(dateStr);
    return `<div class="day-tile ${cls}" aria-label="יום ${HE_DAYS[d.getDay()]}, ${d.getDate()} ב${HE_MONTHS[d.getMonth()]} ${d.getFullYear()}">
      <div class="dow">${HE_DAYS[d.getDay()]}</div>
      <div class="num">${d.getDate()}</div>
      <div class="mon">${HE_MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}</div>
    </div>`;
  }
  const timeLabel = o => o.start_time ? (o.end_time ? `${o.start_time}–${o.end_time}` : o.start_time) : '';
  function optionText(o) {
    const d = parseYmd(o.date);
    return `יום ${HE_DAYS[d.getDay()]}, ${d.getDate()} ב${HE_MONTHS[d.getMonth()]}${o.start_time ? ', \u2066' + timeLabel(o) + '\u2069' : ' (כל היום)'}`;
  }

  // ---------- ניתוב ----------
  function navigate(url, replace = false) {
    history[replace ? 'replaceState' : 'pushState']({}, '', url);
    route();
  }
  window.addEventListener('popstate', route);
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });

  function renderNav() {
    const bar = $('#topbar');
    if (!state.me) { bar.hidden = true; return; }
    bar.hidden = false;
    const p = location.pathname;
    const link = (href, label) => `<a href="${href}" data-link class="${p === href ? 'active' : ''}">${label}</a>`;
    $('#nav').innerHTML = `
      ${link('/', 'הסקרים שלי')}
      ${link('/new', 'סקר חדש')}
      ${state.me.is_admin ? link('/admin', 'ניהול משתמשים') : ''}
      ${link('/account', 'החשבון שלי')}
      <button type="button" id="logoutBtn">יציאה</button>`;
    $('#logoutBtn').onclick = async () => {
      await api('POST', '/api/logout', {});
      state.me = null;
      navigate('/login');
    };
  }

  function setView(html, narrow = false) {
    app.classList.toggle('narrow', narrow);
    app.innerHTML = html;
    renderNav();
    window.scrollTo(0, 0);
  }

  async function route() {
    const path = location.pathname;
    const params = new URLSearchParams(location.search);

    if (path === '/login') {
      if (state.me) return navigate(params.get('next') || '/', true);
      return renderLogin(params.get('next'));
    }
    // קישור אישי של מוזמן (?t=...) – פותח את הסקר הזה בלבד, בלי התחברות
    const pm = path.match(/^\/p\/([\w-]+)$/);
    if (pm && params.get('t')) return renderPoll(pm[1], false, params.get('t'));

    if (!state.me) return navigate(`/login?next=${encodeURIComponent(path + location.search)}`, true);
    if (state.me.must_change_password) return renderChangePassword(true);

    let m;
    if (path === '/' || path === '') return renderDashboard();
    if (path === '/new') return renderNew();
    if (path === '/admin') return state.me.is_admin ? renderAdmin() : navigate('/', true);
    if (path === '/account') return renderAccount();
    if ((m = path.match(/^\/p\/([\w-]+)$/))) return renderPoll(m[1], params.get('created') === '1');
    setView(`<div class="empty"><h2>הדף לא נמצא</h2><p>ייתכן שהקישור שגוי.</p><a class="btn primary" href="/" data-link>לסקרים שלי</a></div>`);
  }

  // ---------- כניסה ----------
  function renderLogin(next) {
    $('#topbar').hidden = true;
    app.classList.add('narrow');
    const fromPoll = next && next.startsWith('/p/');
    app.innerHTML = `
      <div class="login-wrap">
        <form class="panel login-card stack" id="loginForm" novalidate>
          <div class="brand-big">
            <img src="/icon.svg" alt="" width="64" height="64">
            <h1>תיאום פגישות</h1>
            <p class="muted">${fromPoll ? 'הוזמנתם לבחור מועד לפגישה. יש לכם חשבון במערכת? התחברו כאן.' : 'התחברו עם האימייל והסיסמה שקיבלתם ממנהל המערכת.'}</p>
          </div>
          <label class="field"><span>אימייל</span>
            <input class="input ltr" type="email" name="email" autocomplete="username" required autofocus></label>
          <label class="field"><span>סיסמה</span>
            <input class="input ltr" type="password" name="password" autocomplete="current-password" required></label>
          <div class="error" id="loginErr" hidden></div>
          <button class="btn primary" style="width:100%">כניסה</button>
          ${fromPoll ? '' : '<p class="muted" style="font-size:14px;text-align:center">אין לכם חשבון? פנו למנהל המערכת.</p>'}
        </form>
        ${fromPoll ? `<form class="panel login-card stack" id="linkForm" novalidate style="margin-top:16px">
          <h2>הוזמנתם ואין לכם חשבון?</h2>
          <p class="muted">אין צורך בחשבון. הזינו את האימייל שאליו קיבלתם את ההזמנה, ונשלח אליו קישור אישי לסקר.</p>
          <label class="field"><span>האימייל שלכם</span><input class="input ltr" type="email" name="email" required></label>
          <div id="linkMsg" hidden></div>
          <button class="btn" style="width:100%">שליחת קישור אישי</button>
        </form>` : ''}
      </div>`;
    const linkForm = $('#linkForm');
    if (linkForm) linkForm.onsubmit = async e => {
      e.preventDefault();
      const msg = $('#linkMsg'), pid = next.split('/')[2].split('?')[0];
      try {
        const r = await api('POST', `/api/polls/${pid}/request-link`, { email: linkForm.email.value });
        msg.className = 'note';
        msg.textContent = r.mail_configured
          ? 'אם הכתובת מוזמנת לסקר, שלחנו אליה קישור אישי. בדקו את תיבת הדואר (וגם את הספאם).'
          : 'שליחת מיילים עדיין לא הוגדרה במערכת. בקשו מיוצר/ת הסקר לשלוח לכם את הקישור האישי.';
      } catch (ex) { msg.className = 'error'; msg.textContent = ex.message; }
      msg.hidden = false;
    };
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, err = $('#loginErr'), btn = $('button', f);
      err.hidden = true; btn.disabled = true;
      try {
        const { user } = await api('POST', '/api/login', { email: f.email.value, password: f.password.value });
        state.me = user;
        navigate(next || '/', true);
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false; btn.disabled = false;
      }
    };
  }

  // ---------- שינוי סיסמה ----------
  function passwordForm(forced) {
    return `
      <form class="panel stack" id="pwForm" novalidate>
        <h2>${forced ? 'בחירת סיסמה חדשה' : 'שינוי סיסמה'}</h2>
        ${forced ? '<p class="muted">זו הכניסה הראשונה שלכם, או שהסיסמה אופסה. בחרו סיסמה אישית כדי להמשיך.</p>' : ''}
        <label class="field"><span>${forced ? 'הסיסמה הזמנית' : 'הסיסמה הנוכחית'}</span>
          <input class="input ltr" type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span>סיסמה חדשה</span>
          <input class="input ltr" type="password" name="next" autocomplete="new-password" minlength="8" required>
          <small>לפחות 8 תווים</small></label>
        <label class="field"><span>הסיסמה החדשה שוב</span>
          <input class="input ltr" type="password" name="again" autocomplete="new-password" required></label>
        <div class="error" id="pwErr" hidden></div>
        <div class="row"><button class="btn primary">שמירת הסיסמה</button></div>
      </form>`;
  }
  function bindPasswordForm(onDone) {
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, err = $('#pwErr');
      err.hidden = true;
      if (f.next.value !== f.again.value) { err.textContent = 'הסיסמאות החדשות אינן זהות'; err.hidden = false; return; }
      try {
        await api('POST', '/api/me/password', { current: f.current.value, next: f.next.value });
        state.me.must_change_password = false;
        toast('הסיסמה נשמרה');
        onDone();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    };
  }
  function renderChangePassword(forced) {
    setView(passwordForm(forced), true);
    bindPasswordForm(() => route());
  }

  // ---------- החשבון שלי ----------
  function renderAccount() {
    setView(`
      <div class="page-head"><div><h1>החשבון שלי</h1><p class="muted ltr" style="text-align:right">${esc(state.me.email)}</p></div></div>
      <form class="panel stack" id="nameForm">
        <h2>השם שלי</h2>
        <label class="field"><span>שם מלא</span><input class="input" name="name" value="${esc(state.me.name)}" required maxlength="80"></label>
        <div class="row"><button class="btn primary">שמירת השם</button></div>
      </form>
      ${passwordForm(false)}`, true);
    $('#nameForm').onsubmit = async e => {
      e.preventDefault();
      try {
        await api('PATCH', '/api/me', { name: e.target.name.value });
        state.me.name = e.target.name.value.trim();
        toast('השם נשמר');
      } catch (ex) { toast(ex.message, true); }
    };
    bindPasswordForm(() => $('#pwForm').reset());
  }

  // ---------- לוח הסקרים ----------
  let dashTab = 'all';
  async function renderDashboard() {
    setView('<div class="spinner"></div>');
    const [{ polls }, everything] = await Promise.all([
      api('GET', '/api/polls'),
      state.me.is_admin ? api('GET', '/api/polls?scope=all') : Promise.resolve(null),
    ]);
    const groups = {
      all: polls,
      everyone: everything ? everything.polls : [],
      todo: polls.filter(p => !p.is_owner && !p.i_voted && !p.closed),
      mine: polls.filter(p => p.is_owner),
    };
    const draw = () => {
      const list = groups[dashTab];
      const tabs = [['all', 'הכול'], ['todo', `ממתינים לתשובה שלי (${groups.todo.length})`], ['mine', 'סקרים שיצרתי']];
      if (state.me.is_admin) tabs.push(['everyone', `כל הסקרים במערכת (${groups.everyone.length})`]);
      if (!groups[dashTab] || (dashTab === 'everyone' && !state.me.is_admin)) dashTab = 'all';
      $('#dash').innerHTML = `
        <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === dashTab}" class="${k === dashTab ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
        ${list.length ? `<div class="poll-list">${list.map(pollItem).join('')}</div>` : emptyDash()}`;
      $$('[data-tab]', $('#dash')).forEach(b => b.onclick = () => { dashTab = b.dataset.tab; draw(); });
    };
    setView(`
      <div class="page-head">
        <div><h1>שלום ${esc(state.me.name)}</h1><p class="muted">כאן מופיעים הסקרים שיצרתם ואלה שהוזמנתם אליהם.</p></div>
        <a class="btn sun" href="/new" data-link>${icons.plus} סקר חדש</a>
      </div>
      <div id="dash"></div>`);
    draw();
  }
  function emptyDash() {
    if (dashTab === 'everyone') return `<div class="empty"><h2>עוד אין סקרים במערכת</h2><p>כשמשתמשים ייצרו סקרים, הם יופיעו כאן.</p></div>`;
    if (dashTab === 'todo') return `<div class="empty"><h2>אין סקרים שמחכים לכם</h2><p>כשמישהו יזמין אתכם לפגישה, היא תופיע כאן.</p></div>`;
    return `<div class="empty"><h2>עוד אין כאן סקרים</h2><p>צרו סקר, בחרו כמה מועדים אפשריים והזמינו את המשתתפים.</p><a class="btn sun" href="/new" data-link>יצירת סקר ראשון</a></div>`;
  }
  function pollItem(p) {
    const badge = p.closed ? '<span class="badge closed">נסגר</span>'
      : (!p.is_owner && !p.i_voted) ? '<span class="badge todo">ממתין לתשובה שלך</span>'
      : '<span class="badge open">פתוח</span>';
    return `<a class="poll-item" href="/p/${esc(p.public_id)}" data-link>
      ${p.first_date ? dayTile(p.first_date) : ''}
      <div class="info">
        <div class="title">${esc(p.title)}</div>
        <div class="meta">
          <span>${p.is_owner ? 'יצרתם' : 'מאת ' + esc(p.owner_name)}</span>
          <span>${p.option_count} מועדים</span>
          <span>${p.vote_count} ענו${p.invite_count ? ` מתוך ${p.invite_count}` : ''}</span>
        </div>
      </div>
      ${badge}
    </a>`;
  }

  // ---------- בחירת תאריכים ושעות (לוח שנה + שעות לכל יום) ----------
  // existing: תאריכים שכבר קיימים בסקר (מסומנים בנקודה)
  function mountPlanner(cal, slots, existing = new Set()) {
    const dates = new Map();       // 'YYYY-MM-DD' -> [{start, end}]
    let month = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();

  // לוח שנה
  function drawCal() {
    const m = month;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const today = todayYmd();
    let cells = HE_DAYS_SHORT.map(d => `<div class="dow">${d}</div>`).join('');
    cells += '<span></span>'.repeat(first.getDay());
    for (let i = 1; i <= days; i++) {
      const key = ymd(new Date(m.getFullYear(), m.getMonth(), i));
      const past = key < today;
      cells += `<button type="button" data-date="${key}" class="${dates.has(key) ? 'sel' : ''} ${key === today ? 'today' : ''} ${existing.has(key) ? 'had' : ''}" ${past ? 'disabled' : ''} aria-pressed="${dates.has(key)}">${i}</button>`;
    }
    const isCurrent = m.getFullYear() === new Date().getFullYear() && m.getMonth() === new Date().getMonth();
    cal.innerHTML = `
      <div class="cal-head">
        <button type="button" data-prev aria-label="החודש הקודם" ${isCurrent ? 'disabled style="opacity:.3"' : ''}>›</button>
        <strong>${HE_MONTHS[m.getMonth()]} ${m.getFullYear()}</strong>
        <button type="button" data-next aria-label="החודש הבא">‹</button>
      </div>
      <div class="cal-grid">${cells}</div>`;
    $('[data-prev]', cal).onclick = () => { month = new Date(m.getFullYear(), m.getMonth() - 1, 1); drawCal(); };
    $('[data-next]', cal).onclick = () => { month = new Date(m.getFullYear(), m.getMonth() + 1, 1); drawCal(); };
    $$('[data-date]', cal).forEach(b => b.onclick = () => {
      const k = b.dataset.date;
      if (dates.has(k)) dates.delete(k); else dates.set(k, []);
      drawCal(); drawSlots();
    });
  }

  function drawSlots() {
    const keys = [...dates.keys()].sort();
    if (!keys.length) {
      slots.innerHTML = `<div class="empty-slots">עוד לא נבחרו תאריכים.<br>לחצו על ימים בלוח כדי להוסיף אותם.</div>`;
      return;
    }
    slots.innerHTML = keys.map(k => {
      const times = dates.get(k);
      return `<div class="slot-day" data-day="${k}">
        ${dayTile(k)}
        <div class="times">
          ${times.length ? times.map((t, i) => `<span class="time-chip">${t.start}${t.end ? '–' + t.end : ''}<button type="button" data-rm-time="${i}" aria-label="הסרת השעה">✕</button></span>`).join('') : '<span class="allday">כל היום</span>'}
          <div class="time-add">
            <input class="input ltr" type="time" data-start aria-label="שעת התחלה" step="900">
            <span class="muted">עד</span>
            <input class="input ltr" type="time" data-end aria-label="שעת סיום (לא חובה)" step="900">
            <button type="button" class="btn small" data-add-time>הוספת שעה</button>
          </div>
        </div>
        <div class="slot-actions">
          <button type="button" class="btn ghost small" data-rm-day aria-label="הסרת התאריך">הסרה</button>
          ${keys.length > 1 && times.length ? '<button type="button" class="btn ghost small" data-copy title="העתקת השעות של יום זה לכל שאר התאריכים">לכל הימים</button>' : ''}
        </div>
      </div>`;
    }).join('');

    $$('.slot-day', slots).forEach(row => {
      const k = row.dataset.day;
      const times = dates.get(k);
      $('[data-add-time]', row).onclick = () => {
        const s = $('[data-start]', row).value, e = $('[data-end]', row).value;
        if (!s) { toast('בחרו שעת התחלה', true); $('[data-start]', row).focus(); return; }
        if (e && e <= s) { toast('שעת הסיום צריכה להיות אחרי שעת ההתחלה', true); return; }
        if (!times.some(t => t.start === s && t.end === e)) times.push({ start: s, end: e || '' });
        times.sort((a, b) => a.start.localeCompare(b.start));
        drawSlots();
        $(`[data-day="${k}"] [data-start]`, slots)?.focus();
      };
      $$('[data-start],[data-end]', row).forEach(inp => inp.onkeydown = ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); $('[data-add-time]', row).click(); }
      });
      $$('[data-rm-time]', row).forEach(b => b.onclick = () => { times.splice(Number(b.dataset.rmTime), 1); drawSlots(); });
      $('[data-rm-day]', row).onclick = () => { dates.delete(k); drawCal(); drawSlots(); };
      const copy = $('[data-copy]', row);
      if (copy) copy.onclick = () => {
        for (const other of dates.keys()) if (other !== k) dates.set(other, times.map(t => ({ ...t })));
        drawSlots(); toast('השעות הועתקו לכל התאריכים');
      };
    });
  }


    drawCal(); drawSlots();
    return {
      count: () => dates.size,
      getOptions() {
        const options = [];
        for (const [date, times] of [...dates.entries()].sort()) {
          if (!times.length) options.push({ date });
          else times.forEach(t => options.push({ date, start_time: t.start, end_time: t.end || null }));
        }
        return options;
      },
      reset() { dates.clear(); drawCal(); drawSlots(); },
    };
  }

  // ---------- יצירת סקר ----------
  async function renderNew() {
    const draft = { participants: [] };
    let known = new Map();
    api('GET', '/api/users').then(({ users }) => {
      known = new Map(users.map(u => [u.email.toLowerCase(), u.name]));
      $('#userList').innerHTML = users.filter(u => u.email.toLowerCase() !== state.me.email.toLowerCase())
        .map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join('');
      drawParticipants();
    }).catch(() => {});

    setView(`
      <div class="page-head"><div><h1>סקר חדש</h1><p class="muted">שלושה שלבים: על מה הפגישה, מתי היא יכולה להתקיים, ומי מוזמן.</p></div></div>
      <form id="newForm" novalidate>
        <section class="panel stack">
          <div class="panel-title"><span class="step">1</span><h2>נושא הפגישה</h2></div>
          <label class="field"><span>נושא</span><input class="input" name="title" maxlength="200" required placeholder="לדוגמה: ישיבת צוות רבעונית"></label>
          <div class="grid-2">
            <label class="field"><span>מיקום <span class="muted">(לא חובה)</span></span><input class="input" name="location" maxlength="200" placeholder="חדר ישיבות / Zoom"></label>
            <label class="field"><span>הערות למשתתפים <span class="muted">(לא חובה)</span></span><input class="input" name="description" maxlength="2000"></label>
          </div>
        </section>

        <section class="panel">
          <div class="panel-title"><span class="step">2</span><h2>מועדים אפשריים</h2></div>
          <p class="muted" style="margin:-6px 0 16px">סמנו בלוח את התאריכים האפשריים. לכל תאריך אפשר להוסיף שעות – בלי שעות, המשתתפים יבחרו את היום כולו.</p>
          <div class="planner">
            <div class="cal" id="cal"></div>
            <div class="slots" id="slots"></div>
          </div>
        </section>

        <section class="panel stack">
          <div class="panel-title"><span class="step">3</span><h2>משתתפים</h2></div>
          <p class="muted" style="margin-top:-6px">אפשר להזמין כל כתובת אימייל – גם אנשים בלי חשבון במערכת. כל משתתף יקבל קישור אישי שמאפשר לו לענות על הסקר הזה בלבד. ניתן להדביק כמה כתובות יחד.</p>
          <div class="adder">
            <input class="input ltr" id="pInput" type="email" list="userList" placeholder="name@example.com" autocomplete="off">
            <button type="button" class="btn" id="pAdd">הוספה</button>
          </div>
          <datalist id="userList"></datalist>
          <div class="chips" id="pChips"></div>
        </section>

        <section class="panel agent-opt">
          <label class="check agent-check">
            <input type="checkbox" name="agent_enabled" checked>
            <span><b>סוכן AI יסגור את הסקר בשבילי</b>
              <small>כשכל המשתתפים יענו: אם יש מועד שמתאים לרוב, הסוכן יקבע אותו וישלח לכולם זימון ליומן. אם אין – הוא ישלח לך סיכום עם הצעות ויבקש מועדים נוספים.</small></span>
          </label>
        </section>

        <div class="error" id="newErr" hidden style="margin-top:18px"></div>
        <div class="row" style="margin-top:20px">
          <button class="btn sun" id="createBtn">יצירת הסקר</button>
          <a class="btn ghost" href="/" data-link>ביטול</a>
        </div>
      </form>`);

    const planner = mountPlanner($('#cal'), $('#slots'));

    // משתתפים
    function addEmails(raw) {
      const list = raw.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
      let bad = 0;
      for (const e of list) {
        if (!EMAIL_RE.test(e)) { bad++; continue; }
        if (!draft.participants.includes(e)) draft.participants.push(e);
      }
      if (bad) toast(`${bad === 1 ? 'כתובת אחת אינה תקינה' : bad + ' כתובות אינן תקינות'} ולא נוספה`, true);
      drawParticipants();
    }
    function drawParticipants() {
      $('#pChips').innerHTML = draft.participants.map((e, i) => {
        const name = known.get(e);
        return `<span class="chip" title="${esc(e)}">
          ${name ? `<b>${esc(name)}</b>` : ''}<span class="ltr">${esc(e)}</span>
          <button type="button" data-rm="${i}" aria-label="הסרת ${esc(e)}">✕</button></span>`;
      }).join('') || '<span class="muted">עוד לא נוספו משתתפים. אפשר גם לדלג ולשלוח קישור בעצמכם.</span>';
      $$('[data-rm]', $('#pChips')).forEach(b => b.onclick = () => { draft.participants.splice(Number(b.dataset.rm), 1); drawParticipants(); });
    }
    const pInput = $('#pInput');
    $('#pAdd').onclick = () => { addEmails(pInput.value); pInput.value = ''; pInput.focus(); };
    pInput.onkeydown = e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); $('#pAdd').click(); } };
    pInput.onpaste = e => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (/[\s,;]/.test(text.trim())) { e.preventDefault(); addEmails(text); }
    };
    pInput.onchange = () => { if (known.has(pInput.value.trim().toLowerCase())) { addEmails(pInput.value); pInput.value = ''; } };

    drawParticipants();

    $('#newForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, err = $('#newErr'), btn = $('#createBtn');
      err.hidden = true;
      if (pInput.value.trim()) { addEmails(pInput.value); pInput.value = ''; }
      const options = planner.getOptions();
      const fail = (msg, el) => { err.textContent = msg; err.hidden = false; el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); el?.focus?.(); };
      if (!f.title.value.trim()) return fail('יש להזין נושא לפגישה', f.title);
      if (!options.length) return fail('יש לבחור לפחות תאריך אחד בלוח', $('#cal'));
      btn.disabled = true;
      try {
        const res = await api('POST', '/api/polls', {
          title: f.title.value, description: f.description.value, location: f.location.value,
          options, participants: draft.participants, agent_enabled: f.agent_enabled.checked,
        });
        navigate(`/p/${res.public_id}?created=1`, true);
      } catch (ex) {
        btn.disabled = false;
        fail(ex.message);
      }
    };
  }

  // ---------- דף סקר ----------
  // token = הקישור האישי של מוזמן (גישה לסקר הזה בלבד, בלי חשבון)
  async function renderPoll(pid, created, token) {
    const q = token ? `?t=${encodeURIComponent(token)}` : '';
    setView('<div class="spinner"></div>');
    let data;
    try { data = await api('GET', `/api/polls/${pid}${q}`); }
    catch (ex) {
      return setView(`<div class="empty"><h2>לא הצלחנו לפתוח את הסקר</h2><p>${esc(ex.message)}</p>${state.me ? '<a class="btn primary" href="/" data-link>לסקרים שלי</a>' : ''}</div>`);
    }
    const { poll, options, votes, invites, is_owner, agent, me } = data;
    const mine = votes.find(v => v.is_me);
    const myAnswers = { ...(mine?.answers || {}) };
    let myName = mine?.name || me.name || '';
    const open = !poll.closed;

    // ספירה ומועד מוביל
    const counts = options.map(o => {
      let yes = 0, maybe = 0;
      const yesNames = [], maybeNames = [];
      votes.forEach(v => {
        const a = v.answers[o.id];
        if (a === 'yes') { yes++; yesNames.push(v.name); }
        if (a === 'maybe') { maybe++; maybeNames.push(v.name); }
      });
      return { yes, maybe, score: yes * 2 + maybe, yesNames, maybeNames };
    });
    const top = Math.max(0, ...counts.map(c => c.score));
    const isBest = i => top > 0 && counts[i].score === top;
    const finalOpt = options.find(o => o.id === poll.final_option_id);

    const markHtml = a => a === 'yes' ? '<span class="mark yes" aria-label="מתאים">✓</span>'
      : a === 'maybe' ? '<span class="mark maybe" aria-label="אם אין ברירה">?</span>'
      : a === 'no' ? '<span class="mark no" aria-label="לא מתאים">✕</span>'
      : '<span class="mark none" aria-label="לא סומן">–</span>';
    const cycle = a => a === 'yes' ? 'maybe' : a === 'maybe' ? 'no' : a === 'no' ? undefined : 'yes';

    const others = votes.filter(v => !(open && v.is_me));

    setView(`
      ${me.guest ? `<div class="guest-bar"><img src="/icon.svg" alt="" width="28" height="28"><span>עונים בתור <b class="ltr">${esc(me.email)}</b>. זה קישור אישי – אל תעבירו אותו לאחרים.</span></div>` : ''}
      ${data.admin_view ? `<div class="note admin-note"><b>תצוגת מנהל:</b> זה סקר של ${esc(poll.owner_name)}. יש לכם את כל כלי הניהול שלו, ופעולות שתבצעו (שליחה, סגירה, מחיקה) ייעשו בשמו.</div>` : ''}
      ${created && is_owner ? `<div class="note" style="margin-bottom:18px"><b>הסקר נוצר.</b> עכשיו שלחו אותו למשתתפים – במייל מהמערכת, או העתיקו את הקישור ושלחו בעצמכם (ראו למטה).</div>` : ''}
      ${finalOpt ? `<div class="final-banner">${dayTile(finalOpt.date, 'best')}<div><b>נקבע מועד לפגישה</b><div style="font-size:20px;font-family:var(--display)">${esc(optionText(finalOpt))}</div></div></div>` : ''}
      <div class="poll-head">
        <div>
          <h1>${esc(poll.title)}</h1>
          <div class="meta">
            <span>מאת ${esc(poll.owner_name)}</span>
            ${poll.location ? `<span>מיקום: ${esc(poll.location)}</span>` : ''}
            <span>${votes.length} ענו</span>
            ${poll.closed ? '<span class="badge closed">הסקר נסגר</span>' : ''}
          </div>
          ${poll.description ? `<p class="desc">${esc(poll.description)}</p>` : ''}
        </div>
        ${is_owner ? `<a class="btn small" href="#owner">ניהול ושליחה</a>` : ''}
      </div>

      ${open ? `<div class="legend">
        <span>${markHtml('yes')} מתאים</span><span>${markHtml('maybe')} אם אין ברירה</span><span>${markHtml('no')} לא מתאים</span>
        <span class="hide-mobile">לחיצה על משבצת בשורה שלכם מחליפה את התשובה</span>
        <span>מועד שלא תסמנו ייחשב "לא מתאים"</span>
      </div>` : ''}

      <div class="grid-wrap ${open ? 'voting' : ''}">
        <table class="vote-grid">
          <thead><tr>
            <th class="who">${votes.length} משתתפים</th>
            ${options.map((o, i) => `<th class="${isBest(i) ? 'best-col' : ''}"><div class="col-head">${dayTile(o.date, isBest(i) ? 'best' : '')}<span class="time ${o.start_time ? '' : 'allday'}">${o.start_time ? timeLabel(o) : 'כל היום'}</span></div></th>`).join('')}
          </tr></thead>
          <tbody>
            ${open ? `<tr class="me"><td class="who">${esc(myName)}<small>התשובות שלכם</small></td>
              ${options.map((o, i) => `<td class="cell ${isBest(i) ? 'best-col' : ''}"><button type="button" class="cell-btn" data-cell="${o.id}" aria-label="${esc(optionText(o))}">${markHtml(myAnswers[o.id])}</button></td>`).join('')}</tr>` : ''}
            ${others.map(v => `<tr><td class="who">${esc(v.name)}${v.is_me ? ' (אתם)' : ''}${v.comment ? `<small>${esc(v.comment)}</small>` : ''}</td>
              ${options.map((o, i) => `<td class="cell ${isBest(i) ? 'best-col' : ''}">${markHtml(v.answers[o.id])}</td>`).join('')}</tr>`).join('')}
          </tbody>
          <tfoot><tr><td class="who">סה״כ מתאים</td>
            ${counts.map((c, i) => `<td class="count ${isBest(i) ? 'best-col' : ''}">${c.yes}${c.maybe ? `<small>${c.maybe} אולי</small>` : ''}</td>`).join('')}
          </tr></tfoot>
        </table>
      </div>

      ${open ? `<div class="vote-cards">
        ${options.map((o, i) => `<div class="vote-card ${isBest(i) ? 'best' : ''}">
          ${dayTile(o.date, isBest(i) ? 'best' : '')}
          <div class="body">
            <div class="tm">${o.start_time ? timeLabel(o) : '<span class="muted">כל היום</span>'}</div>
            <div class="counts"><b>${counts[i].yes} מתאים</b>${counts[i].maybe ? ` · ${counts[i].maybe} אולי` : ''}${isBest(i) ? ' · המועד המוביל' : ''}</div>
            ${counts[i].yes + counts[i].maybe ? `<details><summary>מי סימן</summary>${counts[i].yesNames.map(esc).join(', ')}${counts[i].maybeNames.length ? `<br><span class="muted">אולי: ${counts[i].maybeNames.map(esc).join(', ')}</span>` : ''}</details>` : ''}
            <div class="seg" role="group" aria-label="${esc(optionText(o))}">
              <button type="button" class="yes" data-seg="${o.id}" data-val="yes" aria-pressed="${myAnswers[o.id] === 'yes'}">מתאים</button>
              <button type="button" class="maybe" data-seg="${o.id}" data-val="maybe" aria-pressed="${myAnswers[o.id] === 'maybe'}">אולי</button>
              <button type="button" class="no" data-seg="${o.id}" data-val="no" aria-pressed="${myAnswers[o.id] === 'no'}">לא</button>
            </div>
          </div>
        </div>`).join('')}
      </div>

      <form class="vote-bar" id="voteForm">
        <label class="field"><span>השם שלכם</span><input class="input name-input" name="name" value="${esc(myName)}" required maxlength="80"></label>
        <label class="field hide-mobile"><span>הערה <span class="muted">(לא חובה)</span></span><input class="input name-input" name="comment" value="${esc(mine?.comment || '')}" maxlength="500"></label>
        <button class="btn sun">${mine ? 'עדכון התשובות' : 'שמירת התשובות'}</button>
      </form>` : ''}

      ${is_owner ? agentSection(poll, agent) + ownerSection(poll, invites, options, counts, isBest) : ''}
    `);

    if (open) {
      const syncMarks = () => {
        $$('[data-cell]').forEach(b => { b.innerHTML = markHtml(myAnswers[b.dataset.cell]); });
        $$('[data-seg]').forEach(b => b.setAttribute('aria-pressed', myAnswers[b.dataset.seg] === b.dataset.val));
      };
      $$('[data-cell]').forEach(b => b.onclick = () => {
        const v = cycle(myAnswers[b.dataset.cell]);
        if (v) myAnswers[b.dataset.cell] = v; else delete myAnswers[b.dataset.cell];
        syncMarks();
      });
      $$('[data-seg]').forEach(b => b.onclick = () => {
        const id = b.dataset.seg;
        if (myAnswers[id] === b.dataset.val) delete myAnswers[id]; else myAnswers[id] = b.dataset.val;
        syncMarks();
      });
      $('#voteForm').onsubmit = async e => {
        e.preventDefault();
        const f = e.target;
        if (!f.name.value.trim()) { toast('רשמו את שמכם', true); f.name.focus(); return; }
        if (!Object.keys(myAnswers).length) { toast('סמנו לפחות מועד אחד', true); return; }
        try {
          await api('PUT', `/api/polls/${pid}/vote${q}`, { name: f.name.value, comment: f.comment.value, answers: myAnswers });
          toast('התשובות נשמרו');
          renderPoll(pid, false, token);
        } catch (ex) { toast(ex.message, true); }
      };
    }
    if (is_owner) { bindOwner(pid, poll, invites, options, counts, isBest); bindAgent(pid, poll, agent, options); }
    if (created) history.replaceState({}, '', `/p/${pid}`);
  }


  // ---------- סוכן AI (ליוצר/ת הסקר) ----------
  function agentSection(poll, agent) {
    const r = agent.result || {};
    const prog = agent.progress || { responded: 0, total: 0 };
    let body;
    if (agent.status === 'scheduled' && poll.closed) {
      body = `<p class="agent-state ok">הסוכן קבע את הפגישה ל<b>${esc(r.when || '')}</b> ושלח זימון ליומן ל-${r.emailed || 0} נמענים${r.simulated ? ' (בדמה – SMTP לא מוגדר)' : ''}.</p>
        ${r.reasoning ? `<p class="agent-why">${esc(r.reasoning)}</p>` : ''}`;
    } else if (agent.status === 'needs_options') {
      body = `<p class="agent-state warn">אף מועד לא התאים לרוב המשתתפים. הסוכן שלח לך סיכום במייל ומבקש להוסיף מועדים.</p>
        ${r.owner_message ? `<p class="agent-why">${esc(r.owner_message)}</p>` : ''}
        ${r.suggestions?.length ? `<p style="margin-top:10px"><b>הצעות הסוכן:</b></p><ul class="agent-tips">${r.suggestions.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <div class="row" style="margin-top:12px"><a class="btn sun" href="#add-dates" id="goAdd">הוספת מועדים</a></div>`;
    } else if (agent.status === 'error') {
      body = `<p class="agent-state warn">${esc(r.error || 'הסוכן נתקל בשגיאה.')}</p>`;
    } else if (poll.closed) {
      body = `<p class="muted">הסקר נסגר ידנית.</p>`;
    } else if (!prog.total) {
      body = `<p class="muted">הוסיפו משתתפים לסקר. הסוכן מחכה שכל המוזמנים יענו.</p>`;
    } else {
      const pct = Math.round(100 * prog.responded / prog.total);
      body = `<div class="agent-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${prog.total}" aria-valuenow="${prog.responded}"><span style="width:${pct}%"></span></div>
        <p style="margin-top:8px"><b>ענו ${prog.responded} מתוך ${prog.total}.</b> ${agent.enabled
          ? `כשכולם יענו, הסוכן יבדוק אם יש מועד שמתאים לרוב (לפחות ${prog.threshold}).`
          : 'הסוכן כבוי – הסקר לא ייסגר אוטומטית.'}</p>`;
    }
    return `
      <section class="panel agent-panel" id="agent">
        <div class="agent-head">
          <div class="agent-badge" aria-hidden="true">AI</div>
          <div style="flex:1">
            <h2>סוכן התיאום</h2>
            <p class="muted" style="font-size:15px">${agent.ai_configured ? 'מנתח את התשובות וההערות בעזרת Claude' : 'פועל לפי כלל הרוב (מפתח AI לא הוגדר בשרת)'}</p>
          </div>
          ${!poll.closed ? `<label class="switch"><input type="checkbox" id="agentToggle" ${agent.enabled ? 'checked' : ''}><span>פעיל</span></label>` : ''}
        </div>
        <div class="agent-body">${body}</div>
        ${!poll.closed ? `<div class="row" style="margin-top:14px">
          <button type="button" class="btn small" id="agentRun">הפעלת הסוכן עכשיו</button>
          <span class="muted" style="font-size:14px">גם אם לא כולם ענו</span>
        </div>` : ''}
      </section>
      <section class="panel" id="add-dates">
        <details ${agent.status === 'needs_options' || location.hash === '#add-dates' ? 'open' : ''}>
          <summary class="add-sum"><h2>הוספת מועדים לסקר</h2></summary>
          <p class="muted" style="margin:10px 0 14px">המועדים החדשים יתווספו לסקר, והמשתתפים יתבקשו לסמן גם אותם. הסוכן יבדוק שוב כשכולם יענו.</p>
          <div class="planner">
            <div class="cal" id="addCal"></div>
            <div class="slots" id="addSlots"></div>
          </div>
          <div class="row" style="margin-top:14px">
            <button type="button" class="btn primary" id="addDatesBtn">הוספת המועדים</button>
            <label class="check"><input type="checkbox" id="addNotify" checked> לשלוח למשתתפים מייל על המועדים החדשים</label>
          </div>
        </details>
      </section>`;
  }

  function bindAgent(pid, poll, agent, options) {
    const toggle = $('#agentToggle');
    if (toggle) toggle.onchange = async () => {
      try {
        await api('PATCH', `/api/polls/${pid}/agent`, { enabled: toggle.checked });
        toast(toggle.checked ? 'הסוכן הופעל' : 'הסוכן כובה');
        setTimeout(() => renderPoll(pid, false), 400);
      } catch (ex) { toast(ex.message, true); toggle.checked = !toggle.checked; }
    };
    const run = $('#agentRun');
    if (run) run.onclick = async () => {
      if (!confirm('להפעיל את הסוכן עכשיו? אם יש מועד שמתאים לרוב, הוא יסגור את הסקר וישלח זימון לכל המשתתפים.')) return;
      run.disabled = true; run.textContent = 'הסוכן בודק את התשובות…';
      try {
        const { result } = await api('POST', `/api/polls/${pid}/agent/run`, {});
        toast(result.decision === 'schedule' ? 'נקבע מועד ונשלח זימון ליומן' : 'לא נמצא מועד לרוב – נשלח לך סיכום עם הצעות');
        renderPoll(pid, false);
      } catch (ex) { toast(ex.message, true); run.disabled = false; run.textContent = 'הפעלת הסוכן עכשיו'; }
    };

    const details = $('#add-dates details');
    let planner = null;
    const ensurePlanner = () => { if (!planner) planner = mountPlanner($('#addCal'), $('#addSlots'), new Set(options.map(o => o.date))); };
    if (details.open) ensurePlanner();
    details.addEventListener('toggle', () => details.open && ensurePlanner());
    const goAdd = $('#goAdd');
    if (goAdd) goAdd.onclick = e => { e.preventDefault(); details.open = true; ensurePlanner(); $('#add-dates').scrollIntoView({ behavior: 'smooth' }); };
    if (location.hash === '#add-dates') setTimeout(() => $('#add-dates').scrollIntoView(), 50);

    $('#addDatesBtn').onclick = async () => {
      ensurePlanner();
      const opts = planner.getOptions();
      if (!opts.length) { toast('בחרו לפחות תאריך אחד בלוח', true); return; }
      try {
        const r = await api('POST', `/api/polls/${pid}/options`, { options: opts, notify: $('#addNotify').checked });
        toast(`נוספו ${r.added} מועדים${r.notified ? (r.simulated ? ' (SMTP לא מוגדר – המייל לא נשלח)' : ` ונשלח עדכון ל-${r.notified} משתתפים`) : ''}`);
        history.replaceState({}, '', `/p/${pid}`);
        renderPoll(pid, false);
      } catch (ex) { toast(ex.message, true); }
    };
  }

  function mailtoHref(poll, invites) {
    const subject = `בחירת מועד: ${poll.title}`;
    const body = `שלום,\n\nאני מתאם/ת את הפגישה "${poll.title}".\nאשמח שתסמנו אילו מועדים מתאימים לכם בקישור הבא:\n${poll.link}\n\nתודה,\n${state.me.name}`;
    const bcc = invites.map(i => i.email).join(',');
    return `mailto:?${bcc ? 'bcc=' + encodeURIComponent(bcc) + '&' : ''}subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function personalMailto(poll, i) {
    const subject = `בחירת מועד: ${poll.title}`;
    const body = `שלום,\n\nאני מתאם/ת את הפגישה "${poll.title}".\nאשמח שתסמנו אילו מועדים מתאימים לכם, בקישור האישי שלכם:\n${i.link}\n\nתודה,\n${state.me.name}`;
    return `mailto:${encodeURIComponent(i.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function ownerSection(poll, invites, options, counts, isBest) {
    const unsent = invites.filter(i => !i.sent).length;
    return `
      <div class="owner-grid" id="owner">
        <section class="panel stack">
          <h2>שליחה למשתתפים</h2>
          ${!state.mailConfigured ? '<p class="note">שליחת מייל אוטומטית עדיין לא הוגדרה בשרת. בינתיים שלחו לכל משתתף את הקישור האישי שלו מרשימת המשתתפים (כפתורי ההעתקה והמייל ליד כל שם).</p>' : ''}
          <p class="muted" style="font-size:15px">כל משתתף מקבל במייל קישור אישי, שמאפשר לענות בלי חשבון. הקישור הכללי מתאים למשתמשים רשומים; מוזמן בלי חשבון שיפתח אותו יוכל לבקש את הקישור האישי שלו במייל.</p>
          <div>
            <label class="field"><span>קישור כללי לסקר</span></label>
            <div class="linkbox"><input class="input" readonly value="${esc(poll.link)}" id="linkInput" aria-label="קישור לסקר"><button type="button" class="btn" id="copyLink">${icons.copy} העתקה</button></div>
          </div>
          <div class="row">
            <button type="button" class="btn sun" id="sendAll" ${invites.length ? '' : 'disabled'}>${icons.mail} שליחה במייל ל-${invites.length} משתתפים</button>
            ${unsent && unsent < invites.length ? `<button type="button" class="btn" id="sendUnsent">שליחה רק ל-${unsent} שטרם קיבלו</button>` : ''}
            <a class="btn" href="${esc(mailtoHref(poll, invites))}">פתיחה בתוכנת המייל שלי</a>
          </div>
          ${navigator.share ? '<button type="button" class="btn ghost" id="nativeShare">שיתוף באפליקציה אחרת…</button>' : ''}
        </section>

        <section class="panel">
          <h2 style="margin-bottom:10px">משתתפים (${invites.length})</h2>
          <ul class="people">
            ${invites.map(i => `<li>
              <div class="p-main"><div>${i.name ? `<b>${esc(i.name)}</b>` : '<span class="muted">ללא חשבון</span>'}</div><div><small class="ltr">${esc(i.email)}</small></div></div>
              ${i.voted ? '<span class="badge open">ענה</span>' : i.sent ? '<span class="badge">נשלח</span>' : '<span class="badge todo">טרם נשלח</span>'}
              <button type="button" class="btn ghost small icon-btn" data-copy-link="${esc(i.link)}" title="העתקת הקישור האישי" aria-label="העתקת הקישור האישי של ${esc(i.email)}">${icons.copy}</button>
              <a class="btn ghost small icon-btn" href="${esc(personalMailto(poll, i))}" title="שליחת הקישור האישי מתוכנת המייל" aria-label="שליחת הקישור האישי ל-${esc(i.email)}">${icons.mail}</a>
              <button type="button" class="btn ghost small" data-rm-invite="${esc(i.email)}" aria-label="הסרת ${esc(i.email)}">✕</button>
            </li>`).join('') || '<li class="muted">אין משתתפים ברשימה. אפשר להוסיף כאן, או לשלוח את הקישור בעצמכם.</li>'}
          </ul>
          <div class="adder" style="margin-top:12px">
            <input class="input ltr" id="moreInput" type="email" list="userList2" placeholder="הוספת משתתף לפי אימייל" autocomplete="off">
            <button type="button" class="btn" id="moreAdd">הוספה</button>
          </div>
          <datalist id="userList2"></datalist>
        </section>
      </div>

      <section class="panel" style="margin-top:18px">
        <h2 style="margin-bottom:10px">סיום הסקר</h2>
        ${poll.closed
          ? `<p class="muted" style="margin-bottom:12px">הסקר סגור ולא ניתן לעדכן בו תשובות.</p><div class="row"><button type="button" class="btn" id="reopen">פתיחת הסקר מחדש</button><button type="button" class="btn danger" id="delPoll">מחיקת הסקר</button></div>`
          : `<p class="muted" style="margin-bottom:12px">כשכולם ענו, קבעו את המועד הסופי. המשתתפים יוכלו לקבל עדכון במייל.</p><div class="row"><button type="button" class="btn primary" id="closePoll">קביעת מועד וסגירה</button><button type="button" class="btn danger" id="delPoll">מחיקת הסקר</button></div>`}
      </section>

      <dialog id="closeDlg">
        <form method="dialog" id="closeForm">
          <div class="d-body">
            <h2>קביעת מועד סופי</h2>
            <p class="muted">המועד המוביל מסומן מראש.</p>
            <div class="option-pick">
              ${options.map((o, i) => `<label><input type="radio" name="opt" value="${o.id}" ${isBest(i) && !options.slice(0, i).some((_, j) => isBest(j)) ? 'checked' : ''}>
                <span style="flex:1">${esc(optionText(o))}</span><span class="muted">${counts[i].yes} ✓${counts[i].maybe ? ` · ${counts[i].maybe} ?` : ''}</span></label>`).join('')}
              <label><input type="radio" name="opt" value=""><span>סגירה בלי לקבוע מועד</span></label>
            </div>
            <label class="check" style="margin-top:14px"><input type="checkbox" name="notify" checked> שליחת עדכון במייל לכל המשתתפים</label>
          </div>
          <div class="d-foot">
            <button class="btn primary" value="ok">סגירת הסקר</button>
            <button class="btn ghost" value="cancel" formnovalidate>ביטול</button>
          </div>
        </form>
      </dialog>`;
  }

  function bindOwner(pid, poll, invites) {
    $('#copyLink').onclick = () => copyText(poll.link);
    $('#linkInput').onfocus = e => e.target.select();
    const share = $('#nativeShare');
    if (share) share.onclick = () => navigator.share({ title: poll.title, text: `בחירת מועד: ${poll.title}`, url: poll.link }).catch(() => {});

    const send = async (onlyUnsent, btn) => {
      const label = btn.innerHTML;
      $$('#sendAll, #sendUnsent').forEach(b => { b.disabled = true; });
      btn.textContent = 'שולח…';
      try {
        const r = await api('POST', `/api/polls/${pid}/send`, { only_unsent: onlyUnsent });
        toast(r.simulated ? 'שליחת מיילים לא מוגדרת בשרת – המיילים לא נשלחו'
          : `נשלחו ${r.sent} מיילים${r.failed.length ? `, ${r.failed.length} נכשלו` : ''}`, r.simulated || r.failed.length > 0);
        renderPoll(pid, false);
      } catch (ex) {
        toast(ex.message, true);
        $$('#sendAll, #sendUnsent').forEach(b => { b.disabled = false; });
        btn.innerHTML = label;
      }
    };
    $('#sendAll').onclick = e => send(false, e.currentTarget);
    if ($('#sendUnsent')) $('#sendUnsent').onclick = e => send(true, e.currentTarget);

    api('GET', '/api/users').then(({ users }) => {
      $('#userList2').innerHTML = users.map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join('');
    }).catch(() => {});
    const more = $('#moreInput');
    $('#moreAdd').onclick = async () => {
      const emails = more.value.split(/[\s,;]+/).filter(Boolean);
      if (!emails.length) return more.focus();
      try {
        await api('POST', `/api/polls/${pid}/participants`, { emails });
        toast('המשתתפים נוספו. לחצו על "שליחה רק לשטרם קיבלו" כדי להזמין אותם.');
        renderPoll(pid, false);
      } catch (ex) { toast(ex.message, true); }
    };
    more.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#moreAdd').click(); } };
    $$('[data-copy-link]').forEach(b => b.onclick = () => copyText(b.dataset.copyLink));
    $$('[data-rm-invite]').forEach(b => b.onclick = async () => {
      await api('DELETE', `/api/polls/${pid}/participants`, { email: b.dataset.rmInvite });
      renderPoll(pid, false);
    });

    $('#delPoll').onclick = async () => {
      if (!confirm(`למחוק את הסקר "${poll.title}" וכל התשובות בו? אי אפשר לבטל את הפעולה.`)) return;
      await api('DELETE', `/api/polls/${pid}`, {});
      toast('הסקר נמחק');
      navigate('/');
    };
    if ($('#reopen')) $('#reopen').onclick = async () => { await api('POST', `/api/polls/${pid}/reopen`, {}); toast('הסקר נפתח מחדש'); renderPoll(pid, false); };
    if ($('#closePoll')) {
      const dlg = $('#closeDlg');
      $('#closePoll').onclick = () => dlg.showModal();
      dlg.addEventListener('close', async () => {
        if (dlg.returnValue !== 'ok') return;
        const f = $('#closeForm');
        try {
          const r = await api('POST', `/api/polls/${pid}/close`, { final_option_id: f.opt.value || null, notify: f.notify.checked });
          toast(r.notified ? (r.simulated ? 'הסקר נסגר (SMTP לא מוגדר – העדכון לא נשלח)' : `הסקר נסגר ונשלח עדכון ל-${r.notified} משתתפים`) : 'הסקר נסגר');
          renderPoll(pid, false);
        } catch (ex) { toast(ex.message, true); }
      });
    }
  }

  // ---------- ניהול משתמשים ----------
  async function renderAdmin() {
    setView('<div class="spinner"></div>');
    const { users } = await api('GET', '/api/admin/users');
    setView(`
      <div class="page-head"><div><h1>ניהול משתמשים</h1><p class="muted">רק משתמשים שנפתחו כאן יכולים להיכנס למערכת, ליצור סקרים ולהשתתף בהם.</p></div></div>

      <form class="panel stack" id="addUser" novalidate>
        <h2>פתיחת משתמש חדש</h2>
        <div class="grid-2">
          <label class="field"><span>שם מלא</span><input class="input" name="name" required maxlength="80"></label>
          <label class="field"><span>אימייל</span><input class="input ltr" type="email" name="email" required></label>
        </div>
        <label class="field"><span>סיסמה זמנית <span class="muted">(לא חובה)</span></span>
          <input class="input ltr" name="password" autocomplete="off" minlength="8">
          <small>השאירו ריק כדי שהמערכת תיצור סיסמה. המשתמש יתבקש להחליף אותה בכניסה הראשונה.</small></label>
        <div class="row">
          <label class="check"><input type="checkbox" name="send_email" ${state.mailConfigured ? 'checked' : ''}> שליחת פרטי הכניסה למשתמש במייל</label>
          <label class="check"><input type="checkbox" name="is_admin"> הרשאת מנהל</label>
        </div>
        <div class="error" id="addErr" hidden></div>
        <div class="row"><button class="btn primary">פתיחת המשתמש</button></div>
      </form>

      <section class="panel">
        <h2 style="margin-bottom:8px">משתמשים (${users.length})</h2>
        <table class="table">
          <thead><tr><th>שם</th><th>אימייל</th><th>תפקיד</th><th>מצב</th><th></th></tr></thead>
          <tbody>${users.map(u => `<tr>
            <td><b>${esc(u.name)}</b></td>
            <td class="ltr" style="text-align:right">${esc(u.email)}</td>
            <td>${u.is_admin ? '<span class="badge todo">מנהל</span>' : 'משתמש'}</td>
            <td>${u.must_change_password ? '<span class="muted">טרם בחר סיסמה</span>' : '<span class="badge open">פעיל</span>'}</td>
            <td><div class="row end">
              <button type="button" class="btn small" data-reset="${u.id}">איפוס סיסמה</button>
              ${u.id !== state.me.id ? `<button type="button" class="btn small ghost" data-admin="${u.id}" data-val="${u.is_admin ? 0 : 1}">${u.is_admin ? 'הסרת הרשאת מנהל' : 'הפיכה למנהל'}</button>
              <button type="button" class="btn small danger" data-del="${u.id}" data-name="${esc(u.name)}">מחיקה</button>` : '<span class="muted">(אתם)</span>'}
            </div></td></tr>`).join('')}</tbody>
        </table>
      </section>

      <dialog id="pwDlg"><div class="d-body stack" id="pwDlgBody"></div><div class="d-foot"><button type="button" class="btn primary" id="pwDlgClose">סיום</button></div></dialog>`);

    const showPassword = (title, email, password, mail) => {
      $('#pwDlgBody').innerHTML = `<h2>${esc(title)}</h2>
        <p>שם משתמש: <span class="ltr">${esc(email)}</span></p>
        <p>סיסמה זמנית: <span class="secret">${esc(password)}</span> <button type="button" class="btn small" id="cpPw">העתקה</button></p>
        ${mail?.error ? `<p class="error">${esc(mail.error)}</p>` : mail?.simulated ? '<p class="note">SMTP לא מוגדר – העבירו את הפרטים למשתמש בעצמכם.</p>' : mail ? '<p class="note">פרטי הכניסה נשלחו במייל.</p>' : '<p class="note">העבירו את הפרטים למשתמש. הסיסמה לא תוצג שוב.</p>'}`;
      $('#cpPw').onclick = () => navigator.clipboard?.writeText(password).then(() => toast('הסיסמה הועתקה'));
      const dlg = $('#pwDlg');
      $('#pwDlgClose').onclick = () => dlg.close();
      dlg.onclose = () => renderAdmin();
      dlg.showModal();
    };

    $('#addUser').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, err = $('#addErr');
      err.hidden = true;
      try {
        const r = await api('POST', '/api/admin/users', {
          name: f.name.value, email: f.email.value, password: f.password.value,
          is_admin: f.is_admin.checked, send_email: f.send_email.checked,
        });
        showPassword('המשתמש נפתח', f.email.value.trim().toLowerCase(), r.password, r.mail);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    };
    $$('[data-reset]').forEach(b => b.onclick = async () => {
      const u = users.find(x => x.id === Number(b.dataset.reset));
      if (!confirm(`לאפס את הסיסמה של ${u.name}? הסיסמה הנוכחית תפסיק לעבוד.`)) return;
      try {
        const r = await api('POST', `/api/admin/users/${u.id}/reset-password`, { send_email: state.mailConfigured });
        showPassword('הסיסמה אופסה', u.email, r.password, r.mail);
      } catch (ex) { toast(ex.message, true); }
    });
    $$('[data-admin]').forEach(b => b.onclick = async () => {
      try { await api('PATCH', `/api/admin/users/${b.dataset.admin}`, { is_admin: b.dataset.val === '1' }); renderAdmin(); }
      catch (ex) { toast(ex.message, true); }
    });
    $$('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`למחוק את המשתמש ${b.dataset.name}? גם הסקרים שיצר והתשובות שלו יימחקו.`)) return;
      try { await api('DELETE', `/api/admin/users/${b.dataset.del}`, {}); toast('המשתמש נמחק'); renderAdmin(); }
      catch (ex) { toast(ex.message, true); }
    });
  }

  // ---------- אייקונים ----------
  const icons = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
  };

  // ---------- הפעלה ----------
  (async () => {
    try {
      const r = await api('GET', '/api/me');
      state.me = r.user;
      state.mailConfigured = r.mail_configured;
      state.aiConfigured = r.ai_configured;
    } catch { /* לא מחובר */ }
    route();
  })();
})();
