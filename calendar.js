// יצירת זימון ליומן (קובץ ics) וקישור ל-Google Calendar
const crypto = require('crypto');

const TZ = process.env.TIMEZONE || 'Asia/Jerusalem';
const DEFAULT_MINUTES = Number(process.env.MEETING_MINUTES || 60);

// ההפרש (במילישניות) בין אזור הזמן ל-UTC ברגע נתון
function tzOffset(ts, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// שעה מקומית (תאריך + HH:MM באזור הזמן) → Date ב-UTC, כולל שעון קיץ
function localToUtc(date, time, tz = TZ) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - tzOffset(guess, tz);
  const second = tzOffset(ts, tz);
  if (guess - second !== ts) ts = guess - second;
  return new Date(ts);
}

const pad = n => String(n).padStart(2, '0');
const utcStamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const dateStamp = s => s.replace(/-/g, '');
function nextDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return `${n.getUTCFullYear()}${pad(n.getUTCMonth() + 1)}${pad(n.getUTCDate())}`;
}

// טווח הזמן של מועד: start/end ב-UTC, או allDay
function optionRange(o) {
  if (!o.start_time) return { allDay: true, start: dateStamp(o.date), end: nextDay(o.date) };
  const start = localToUtc(o.date, o.start_time);
  const end = o.end_time ? localToUtc(o.date, o.end_time) : new Date(start.getTime() + DEFAULT_MINUTES * 60000);
  return { allDay: false, start, end };
}

const icsText = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// קיפול שורות ל-75 בתים לפי התקן (בלי לחתוך תו עברי באמצע)
function fold(line) {
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function buildIcs({ poll, option, organizer, attendees, description, url }) {
  const r = optionRange(option);
  const uid = `${poll.public_id}-${option.id}-${crypto.randomBytes(4).toString('hex')}@meetings`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meeting Scheduler//HE', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    r.allDay ? `DTSTART;VALUE=DATE:${r.start}` : `DTSTART:${utcStamp(r.start)}`,
    r.allDay ? `DTEND;VALUE=DATE:${r.end}` : `DTEND:${utcStamp(r.end)}`,
    `SUMMARY:${icsText(poll.title)}`,
    description ? `DESCRIPTION:${icsText(description)}` : null,
    poll.location ? `LOCATION:${icsText(poll.location)}` : null,
    url ? `URL:${url}` : null,
    `ORGANIZER;CN=${icsText(organizer.name)}:mailto:${organizer.email}`,
    ...attendees.map(a => `ATTENDEE;CN=${icsText(a.name || a.email)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`),
    'STATUS:CONFIRMED', 'SEQUENCE:0',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:תזכורת', 'TRIGGER:-PT15M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

function googleCalendarLink({ poll, option, details }) {
  const r = optionRange(option);
  const dates = r.allDay ? `${r.start}/${r.end}` : `${utcStamp(r.start)}/${utcStamp(r.end)}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: poll.title, dates, details: details || '', location: poll.location || '', ctz: TZ });
  return `https://calendar.google.com/calendar/render?${q}`;
}

module.exports = { buildIcs, googleCalendarLink, optionRange, localToUtc, TZ };
