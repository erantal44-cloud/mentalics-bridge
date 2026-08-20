// שרת גישור פרטי - מכון מנטליקס <-> רפיד וואן
// נכתב ב-Node.js טהור (בלי תלות בחבילות חיצוניות) כדי שיהיה קל לבדוק ולפרוס.
//
// מה הוא עושה:
// 1. שומר עוגיית session עדכנית (.AspNet.Cookies) שמודבקת ידנית פעם ביום/כמה ימים דרך /admin
// 2. מספק endpoint (/report) שמביא מרפיד וואן את כל הפגישות בטווח תאריכים רלוונטי,
//    ומחזיר סיכום מובנה (JSON): לו"ז היום לפי רופא, בדיקת גבייה לרופא שעבד אתמול בערב,
//    וספירת פגישות ליומיים הקרובים (לבדיקת "חורים" גסה).
//
// הערה חשובה: זה endpoint פנימי לא-רשמי של רפיד וואן (לא ה-Public API המתועד).
// הוא יכול להשתנות או להישבר בכל עדכון של רפיד בלי אזהרה מראש.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;
const ADMIN_SECRET = process.env.ADMIN_SECRET; // חובה להגדיר - סוד לגישה ל-/admin ול-/report
const RAPID_BASE_URL = process.env.RAPID_BASE_URL || 'https://mentalics.rapid-image.net';
const DEPARTMENT_ID = process.env.DEPARTMENT_ID || '1';
const EVENING_CUTOFF_HOUR = Number(process.env.EVENING_CUTOFF_HOUR || 16);
const DATA_FILE = path.join(__dirname, 'data.json');

if (!ADMIN_SECRET) {
  console.error('שגיאה: חובה להגדיר את משתנה הסביבה ADMIN_SECRET לפני הפעלת השרת.');
  process.exit(1);
}

// --- אחסון פשוט של העוגייה (best-effort - בדיסק המקומי) ---
// הערה: בתוכנית החינמית של Render הדיסק לא בהכרח נשמר בין הפעלות מחדש.
// אם זה קורה בפועל, פשוט צריך להדביק את העוגייה מחדש דרך /admin.
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { cookie: null, savedAt: null };
  }
}
function saveState(newState) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(newState, null, 2));
  } catch (err) {
    console.error('כשל בשמירת קובץ המצב:', err.message);
  }
}
let state = loadState();

function checkSecret(providedKey) {
  return providedKey === ADMIN_SECRET;
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function parseFormBody(raw) {
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}

// --- עמוד הדבקת עוגייה ---
function adminPageHtml(key) {
  const savedAt = state.savedAt ? new Date(state.savedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : 'אף פעם';
  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>עדכון חיבור לרפיד וואן</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; line-height: 1.6; color: #222; }
    h1 { font-size: 20px; }
    ol { padding-right: 20px; }
    textarea { width: 100%; min-height: 100px; font-family: monospace; font-size: 13px; box-sizing: border-box; padding: 8px; }
    button { background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 15px; cursor: pointer; margin-top: 12px; }
    .status { background: #f1f5f9; padding: 10px 14px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
  </style>
</head>
<body>
  <h1>עדכון חיבור לרפיד וואן - מנטליקס</h1>
  <div class="status">עוגייה שמורה כרגע מתאריך: <b>${savedAt}</b></div>
  <ol>
    <li>היכנס ל-<code>mentalics.rapid-image.net/schedule</code> והתחבר כרגיל (כולל קוד ה-SMS).</li>
    <li>פתח את כלי המפתחים של הדפדפן (F12) ← לשונית <b>Network</b>.</li>
    <li>סנן לפי <code>appointments</code>, ורענן את הדף אם צריך שתופיע בקשה.</li>
    <li>לחץ על הבקשה ← לשונית <b>Headers</b> ← תחת <b>Request Headers</b> מצא את השורה <code>Cookie:</code>.</li>
    <li>העתק את הערך המלא שאחרי <code>Cookie:</code> (המחרוזת הארוכה) והדבק אותו כאן למטה.</li>
  </ol>
  <form method="POST" action="/admin/cookie?key=${encodeURIComponent(key)}">
    <textarea name="cookie" placeholder="הדבק כאן את ערך ה-Cookie המלא..." required></textarea>
    <br>
    <button type="submit">שמור עוגייה</button>
  </form>
</body>
</html>`;
}

// --- עזרי תאריך (אזור זמן ישראל) ---
function israelDateParts(offsetDays = 0) {
  const now = new Date();
  const israelNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  israelNow.setDate(israelNow.getDate() + offsetDays);
  const y = israelNow.getFullYear();
  const m = String(israelNow.getMonth() + 1).padStart(2, '0');
  const d = String(israelNow.getDate()).padStart(2, '0');
  return { y, m, d, iso: `${y}-${m}-${d}` };
}
function isoDateOnly(dateStr) {
  return (dateStr || '').slice(0, 10);
}
function hourOf(dateStr) {
  const t = (dateStr || '').slice(11, 13);
  return t ? Number(t) : null;
}

// --- קריאה בפועל לרפיד וואן ---
async function fetchRapidAppointments(fromISO, toISO) {
  const url = new URL(`${RAPID_BASE_URL}/api/schedule/appointments`);
  url.searchParams.set('from', `${fromISO}T00:00:00`);
  url.searchParams.set('to', `${toISO}T23:59:59`);
  url.searchParams.set('departmentId', DEPARTMENT_ID);
  url.searchParams.set('showDebtIndicator', 'true');
  url.searchParams.set('skipApptAdditionalInfo', 'false');
  url.searchParams.set('showAppointmentOfAllDepartment', 'true');
  url.searchParams.set('applyCache', 'false');
  url.searchParams.set('foreignNames', 'false');

  const controller = new AbortController();
  const timeoutMs = Number(process.env.RAPID_TIMEOUT_MS || 20000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  console.log(`[fetchRapidAppointments] מתחיל בקשה ל-${url.toString()}`);
  let resp;
  try {
    resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Cookie: state.cookie || '',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Referer: `${RAPID_BASE_URL}/schedule`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    console.error(`[fetchRapidAppointments] הבקשה נכשלה: ${fetchErr.name} - ${fetchErr.message}`);
    if (fetchErr.name === 'AbortError') {
      const err = new Error('RAPID_TIMEOUT');
      err.code = 'RAPID_TIMEOUT';
      throw err;
    }
    const err = new Error(`RAPID_NETWORK_ERROR: ${fetchErr.message}`);
    err.code = 'RAPID_NETWORK_ERROR';
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  console.log(`[fetchRapidAppointments] התקבלה תשובה - סטטוס ${resp.status}`);

  const contentType = resp.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const err = new Error('COOKIE_EXPIRED_OR_INVALID');
    err.code = 'COOKIE_EXPIRED_OR_INVALID';
    throw err;
  }
  const data = await resp.json();
  if (!Array.isArray(data)) {
    const err = new Error('UNEXPECTED_RESPONSE_SHAPE');
    err.code = 'UNEXPECTED_RESPONSE_SHAPE';
    throw err;
  }
  return data;
}

// --- בניית הדוח (הלוגיקה העסקית - ניתנת לבדיקה בנפרד) ---
function buildReport(appointments, { today, yesterday, dayPlus1, dayPlus2 }) {
  const todaySchedule = {};
  const eveningBillingCheck = [];
  const upcomingCounts = {};

  for (const appt of appointments) {
    if (appt.isDeleted) continue;
    const dateOnly = isoDateOnly(appt.startDate);
    const doctor = appt.doctorName || 'לא משויך לרופא';

    if (dateOnly === today) {
      if (!todaySchedule[doctor]) todaySchedule[doctor] = [];
      todaySchedule[doctor].push({
        time: (appt.startDate || '').slice(11, 16),
        endTime: (appt.endDate || '').slice(11, 16),
        customerName: appt.customerName || '',
        status: appt.bookingStatusName || '',
        notes: appt.notes || '',
      });
    }

    if (dateOnly === yesterday) {
      const h = hourOf(appt.startDate);
      if (h !== null && h >= EVENING_CUTOFF_HOUR) {
        const balance = typeof appt.patientBalance === 'number' ? appt.patientBalance : null;
        const needsAttention = appt.isPaid === false || appt.hasInvoice === false || (balance !== null && balance < 0);
        eveningBillingCheck.push({
          doctor,
          time: (appt.startDate || '').slice(11, 16),
          customerName: appt.customerName || '',
          isPaid: appt.isPaid,
          hasInvoice: appt.hasInvoice,
          patientBalance: balance,
          price: appt.price,
          needsAttention,
        });
      }
    }

    if (dateOnly === dayPlus1 || dateOnly === dayPlus2) {
      if (!upcomingCounts[dateOnly]) upcomingCounts[dateOnly] = {};
      upcomingCounts[dateOnly][doctor] = (upcomingCounts[dateOnly][doctor] || 0) + 1;
    }
  }

  for (const doctor of Object.keys(todaySchedule)) {
    todaySchedule[doctor].sort((a, b) => a.time.localeCompare(b.time));
  }

  return {
    generatedAt: new Date().toISOString(),
    dates: { yesterday, today, dayPlus1, dayPlus2 },
    todaySchedule,
    eveningBillingCheck,
    upcomingCounts,
    note: 'upcomingCounts היא ספירה גולמית של פגישות קיימות בלבד - לא בדיקת "חורים" אמיתית מול שעות עבודה מלאות של כל רופא.',
  };
}

// --- שרת HTTP ---
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    if (pathname === '/admin' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendHtml(res, 403, 'גישה נדחתה - סוד שגוי או חסר.');
      return sendHtml(res, 200, adminPageHtml(key));
    }

    if (pathname === '/admin/cookie' && req.method === 'POST') {
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendHtml(res, 403, 'גישה נדחתה - סוד שגוי או חסר.');
      const raw = await readBody(req);
      const body = parseFormBody(raw);
      const cookie = (body.cookie || '').trim();
      if (!cookie) return sendHtml(res, 400, 'לא התקבל ערך עוגייה.');
      state = { cookie, savedAt: new Date().toISOString() };
      saveState(state);
      return sendHtml(
        res,
        200,
        `<!doctype html><html dir="rtl" lang="he"><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;">
          <p style="background:#dcfce7;color:#166534;padding:14px;border-radius:6px;">✔ העוגייה נשמרה בהצלחה.</p>
          <a href="/admin?key=${encodeURIComponent(key)}">חזרה</a>
        </body></html>`
      );
    }

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, hasCookie: !!state.cookie, cookieSavedAt: state.savedAt });
    }

    if (pathname === '/report' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });
      if (!state.cookie) {
        return sendJson(res, 409, { error: 'NO_COOKIE_SAVED', message: 'לא נשמרה עדיין עוגייה. יש להיכנס ל-/admin ולהדביק אחת.' });
      }

      const today = url.searchParams.get('date') || israelDateParts(0).iso;
      const yesterday = israelDateParts(-1).iso;
      const dayPlus1 = israelDateParts(1).iso;
      const dayPlus2 = israelDateParts(2).iso;

      let appointments;
      try {
        appointments = await fetchRapidAppointments(yesterday, dayPlus2);
      } catch (err) {
        console.error(`[/report] שגיאה: ${err.code || 'UNKNOWN'} - ${err.message}`);
        if (err.code === 'COOKIE_EXPIRED_OR_INVALID') {
          return sendJson(res, 401, {
            error: 'COOKIE_EXPIRED_OR_INVALID',
            message: 'העוגייה פגה או לא תקפה. יש להתחבר מחדש לרפיד וואן ולהדביק עוגייה טרייה דרך /admin.',
          });
        }
        if (err.code === 'RAPID_TIMEOUT') {
          return sendJson(res, 504, {
            error: 'RAPID_TIMEOUT',
            message: `אין תגובה מרפיד וואן בתוך ${Number(process.env.RAPID_TIMEOUT_MS || 20000) / 1000} שניות. ייתכן חסימת רשת בין Render לרפיד.`,
          });
        }
        if (err.code === 'RAPID_NETWORK_ERROR') {
          return sendJson(res, 502, { error: 'RAPID_NETWORK_ERROR', message: err.message });
        }
        return sendJson(res, 502, { error: 'RAPID_FETCH_FAILED', message: err.message });
      }

      const report = buildReport(appointments, { today, yesterday, dayPlus1, dayPlus2 });
      return sendJson(res, 200, report);
    }

    sendHtml(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'INTERNAL_ERROR', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`שרת הגישור של מנטליקס פעיל על פורט ${PORT}`);
});

module.exports = { buildReport, israelDateParts, isoDateOnly,
