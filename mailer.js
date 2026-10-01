// שליחת מיילים דרך SMTP (Gmail, Outlook, SendGrid וכו')
// אם SMTP לא מוגדר – המיילים נרשמים ביומן השרת במקום להישלח (מצב פיתוח).
const nodemailer = require('nodemailer');

const configured = !!process.env.SMTP_HOST;
let transporter = null;

if (configured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

const FROM = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@example.com';
// כתובת המערכת בלבד (בלי השם), לשימוש בשם השולח של כל מארגן
const FROM_ADDRESS = (FROM.match(/<([^>]+)>/) || [, FROM])[1].trim();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout(title, bodyHtml) {
  return `<!doctype html><html dir="rtl" lang="he"><body style="margin:0;background:#EEF1F6;font-family:Arial,Helvetica,sans-serif;color:#1F2A44">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #D9DFEA">
    <tr><td style="background:#1F2A44;color:#fff;padding:18px 24px;font-size:20px;font-weight:bold">${esc(title)}</td></tr>
    <tr><td style="padding:24px;font-size:16px;line-height:1.6;text-align:right">${bodyHtml}</td></tr>
  </table></td></tr></table></body></html>`;
}

function button(href, label) {
  return `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#F2C14E;color:#1F2A44;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">${esc(label)}</a></p>
  <p style="font-size:13px;color:#6B7489">אם הכפתור לא עובד, העתיקו את הקישור:<br><span style="direction:ltr;unicode-bidi:embed">${esc(href)}</span></p>`;
}

// sender = { name, email } של מי שיצר את הסקר: המייל יוצא מכתובת המערכת,
// אבל בשם שלו, ותשובות (Reply) מגיעות ישירות אליו.
async function send({ to, subject, html, text, ics, sender }) {
  if (!configured) {
    console.log(`\n[MAIL – SMTP לא מוגדר, המייל לא נשלח]\nאל: ${to}${sender ? `\nבשם: ${sender.name} <${sender.email}>` : ''}\nנושא: ${subject}\n${text || ''}${ics ? '\n[מצורף זימון ליומן invite.ics]' : ''}\n`);
    return { simulated: true };
  }
  const msg = { from: FROM, to, subject, html, text };
  if (sender?.email) {
    msg.from = { name: `${sender.name} (תיאום פגישות)`, address: FROM_ADDRESS };
    msg.replyTo = { name: sender.name, address: sender.email };
  }
  if (ics) {
    // icalEvent גורם ל-Gmail/Outlook להציג "הוספה ליומן" עם כפתורי אישור
    msg.icalEvent = { method: 'REQUEST', filename: 'invite.ics', content: ics };
  }
  await transporter.sendMail(msg);
  return { simulated: false };
}

function calendarInvite({ to, ownerName, poll, when, note, link, gcal, ics, ownerEmail }) {
  const subject = `זימון: ${poll.title} – ${when}`;
  const html = layout('נקבע מועד לפגישה', `
    <p>המועד שהתאים לרוב המשתתפים נבחר, והפגישה נקבעה:</p>
    <p style="font-size:18px;font-weight:bold;margin:14px 0 2px">${esc(poll.title)}</p>
    <p style="font-size:20px;font-weight:bold;margin:0 0 6px">${esc(when)}</p>
    ${poll.location ? `<p style="margin:0">מיקום: ${esc(poll.location)}</p>` : ''}
    ${note ? `<p style="margin:14px 0 0;color:#4A5571">${esc(note)}</p>` : ''}
    <p style="margin:18px 0 0">הזימון מצורף למייל – אשרו אותו כדי שהפגישה תיכנס ליומן שלכם.</p>
    ${button(gcal, 'הוספה ל-Google Calendar')}
    <p style="font-size:13px;color:#6B7489">מארגן/ת: ${esc(ownerName)} · <a href="${esc(link)}">תוצאות הסקר</a></p>`);
  const text = `נקבע מועד לפגישה "${poll.title}": ${when}\n${note || ''}\nהוספה ליומן: ${gcal}\nתוצאות: ${link}`;
  return send({ to, subject, html, text, ics, sender: { name: ownerName, email: ownerEmail } });
}

function ownerNeedsOptions({ to, poll, summary, message, suggestions, link }) {
  const subject = `לא נמצא מועד מוסכם: ${poll.title}`;
  const rows = summary.map(s => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #E3E7EF">${esc(s.when)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #E3E7EF;text-align:center;color:#2E9E6A;font-weight:bold">${s.yes}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #E3E7EF;text-align:center;color:#C9850F">${s.maybe}</td></tr>`).join('');
  const html = layout('נדרשים מועדים נוספים', `
    <p>${esc(message).replace(/\n/g, '<br>')}</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin:16px 0;font-size:14px;border-collapse:collapse">
      <tr style="background:#F3F6FB"><th style="padding:6px 8px;text-align:right">מועד</th><th style="padding:6px 8px">מתאים</th><th style="padding:6px 8px">אולי</th></tr>
      ${rows}
    </table>
    ${suggestions.length ? `<p style="font-weight:bold;margin:16px 0 4px">הצעות להמשך:</p><ul style="margin:0;padding-right:20px">${suggestions.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    ${button(link + '#add-dates', 'הוספת מועדים לסקר')}`);
  const text = `${message}\n\n${summary.map(s => `${s.when}: ${s.yes} מתאים, ${s.maybe} אולי`).join('\n')}\n\n${suggestions.map(s => '- ' + s).join('\n')}\n\nהוספת מועדים: ${link}`;
  return send({ to, subject, html, text });
}

function newOptions({ to, ownerName, poll, link, ownerEmail }) {
  const subject = `נוספו מועדים חדשים: ${poll.title}`;
  const html = layout('נוספו מועדים חדשים', `
    <p><b>${esc(ownerName)}</b> הוסיף/ה מועדים אפשריים לפגישה <b>${esc(poll.title)}</b>.</p>
    <p>נשמח שתסמנו גם אותם, כדי שנמצא מועד שמתאים לכולם.</p>
    ${button(link, 'לסימון המועדים החדשים')}`);
  return send({ to, subject, html, text: `נוספו מועדים חדשים לפגישה "${poll.title}". לסימון: ${link}`, sender: { name: ownerName, email: ownerEmail } });
}

function pollInvite({ to, ownerName, poll, link, ownerEmail }) {
  const subject = `${ownerName} מזמין/ה אותך לבחור מועד: ${poll.title}`;
  const html = layout('בחירת מועד לפגישה', `
    <p>שלום,</p>
    <p><b>${esc(ownerName)}</b> מתאם/ת פגישה ומבקש/ת שתסמנו אילו מועדים מתאימים לכם.</p>
    <p style="font-size:18px;font-weight:bold;margin:16px 0 4px">${esc(poll.title)}</p>
    ${poll.description ? `<p style="margin:0;color:#4A5571">${esc(poll.description)}</p>` : ''}
    ${poll.location ? `<p style="margin:4px 0 0;color:#4A5571">מיקום: ${esc(poll.location)}</p>` : ''}
    ${button(link, 'לבחירת המועדים')}`);
  const text = `${ownerName} מזמין/ה אותך לבחור מועד לפגישה "${poll.title}".\nלבחירת המועדים: ${link}`;
  return send({ to, subject, html, text, sender: { name: ownerName, email: ownerEmail } });
}

function welcome({ to, name, password, link }) {
  const subject = 'נפתח לך חשבון במערכת תיאום הפגישות';
  const html = layout('ברוכים הבאים', `
    <p>שלום ${esc(name)},</p>
    <p>נפתח עבורך חשבון במערכת תיאום הפגישות.</p>
    <p>שם משתמש: <span style="direction:ltr;unicode-bidi:embed">${esc(to)}</span><br>
       סיסמה זמנית: <b style="direction:ltr;unicode-bidi:embed">${esc(password)}</b></p>
    <p>בכניסה הראשונה תתבקשו לבחור סיסמה חדשה.</p>
    ${button(link, 'כניסה למערכת')}`);
  const text = `נפתח לך חשבון.\nשם משתמש: ${to}\nסיסמה זמנית: ${password}\nכניסה: ${link}`;
  return send({ to, subject, html, text });
}

function finalChosen({ to, ownerName, poll, when, link, ownerEmail }) {
  const subject = `נקבע מועד: ${poll.title}`;
  const html = layout('נקבע מועד לפגישה', `
    <p><b>${esc(ownerName)}</b> קבע/ה את מועד הפגישה <b>${esc(poll.title)}</b>:</p>
    <p style="font-size:20px;font-weight:bold;margin:12px 0">${esc(when)}</p>
    ${poll.location ? `<p>מיקום: ${esc(poll.location)}</p>` : ''}
    ${button(link, 'לפרטי הפגישה')}`);
  return send({ to, subject, html, text: `מועד הפגישה "${poll.title}": ${when}\n${link}`, sender: { name: ownerName, email: ownerEmail } });
}

module.exports = { configured, pollInvite, welcome, finalChosen, calendarInvite, ownerNeedsOptions, newOptions };
