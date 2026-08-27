// שרת גישור פרטי - מכון מנטליקס <-> רפיד וואן
// נכתב ב-Node.js טהור (בלי תלות בחבילות חיצוניות) כדי שיהיה קל לבדוק ולפרוס.
//
// מה הוא עושה:
// 1. שומר "חתימת בקשה" עדכנית (כל הכותרות שרפיד וואן דורש - כולל Cookie ו-Authorization)
//    שמודבקת ידנית פעם ביום/כמה ימים דרך /admin (העתקה מלאה כ-cURL מ-DevTools)
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
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!ADMIN_SECRET) {
  console.error('שגיאה: חובה להגדיר את משתנה הסביבה ADMIN_SECRET לפני הפעלת השרת.');
  process.exit(1);
}

// --- אחסון פשוט של כותרות הבקשה (best-effort - בדיסק המקומי) ---
// הערה: בתוכנית החינמית של Render הדיסק לא בהכרח נשמר בין הפעלות מחדש.
// אם זה קורה בפועל, פשוט צריך להדביק מחדש דרך /admin.
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { headers: null, savedAt: null };
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

// --- חילוץ כותרות מתוך טקסט "Copy as cURL (bash)" של Chrome DevTools ---
function parseCurlHeaders(curlText) {
  const headers = {};
  const hRegex = /--?H(?:eader)?\s+(['"])([^:]+):\s*([\s\S]*?)\1/g;
  let m;
  while ((m = hRegex.exec(curlText)) !== null) {
    const name = m[2].trim().toLowerCase();
    headers[name] = m[3];
  }
  const cRegex = /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/;
  const cMatch = curlText.match(cRegex);
  if (cMatch) {
    headers['cookie'] = cMatch[2];
  }
  // כותרות שאסור להעביר הלאה כמו שהן (יחושבו מחדש או לא רלוונטיות)
  delete headers['content-length'];
  delete headers['host'];
  delete headers[':authority'];
  delete headers[':method'];
  delete headers[':path'];
  delete headers[':scheme'];
  return headers;
}

// --- עמוד הדבקת חתימת בקשה ---
function adminPageHtml(key) {
  const savedAt = state.savedAt ? new Date(state.savedAt).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : 'אף פעם';
  const hasCookie = !!(state.headers && state.headers.cookie);
  const hasAuth = !!(state.headers && state.headers.authorization);
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
    textarea { width: 100%; min-height: 160px; font-family: monospace; font-size: 12px; box-sizing: border-box; padding: 8px; direction: ltr; text-align: left; }
    button { background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 15px; cursor: pointer; margin-top: 12px; }
    .status { background: #f1f5f9; padding: 10px 14px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
    code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>עדכון חיבור לרפיד וואן - מנטליקס</h1>
  <div class="status">
    נשמר לאחרונה: <b>${savedAt}</b><br>
    Cookie: ${hasCookie ? '✔ קיים' : '✘ חסר'} | Authorization: ${hasAuth ? '✔ קיים' : '✘ חסר'}
  </div>
  <ol>
    <li>היכנס ל-<code>mentalics.rapid-image.net/schedule</code> והתחבר כרגיל (כולל קוד ה-SMS).</li>
    <li>פתח את כלי המפתחים של הדפדפן (F12) ← לשונית <b>Network</b>.</li>
    <li>סנן לפי <code>appointments</code>, ורענן את הדף אם צריך שתופיע בקשה.</li>
    <li>קליק ימני על הבקשה ← <b>Copy</b> ← <b>Copy as cURL (bash)</b>.</li>
    <li>הדבק כאן למטה את <b>כל הטקסט</b> שהועתק (מתחיל במילה <code>curl</code>) ולחץ שמור.</li>
  </ol>
  <form method="POST" action="/admin/cookie?key=${encodeURIComponent(key)}">
    <textarea name="curl" placeholder="curl --url '...' -H '...' ..." required></textarea>
    <br>
    <button type="submit">שמור</button>
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

// חישוב הפרש השעות של אזור הזמן של ישראל (מתחשב אוטומטית בשעון קיץ/חורף)
function israelOffsetMinutes(atDate) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', timeZoneName: 'shortOffset' });
    const parts = dtf.formatToParts(atDate);
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    const match = tzPart && tzPart.value.match(/GMT([+-]\d+)(?::?(\d+))?/);
    if (!match) return 180;
    const hours = parseInt(match[1], 10);
    const mins = match[2] ? parseInt(match[2], 10) : 0;
    return hours * 60 + (hours < 0 ? -mins : mins);
  } catch {
    return 180; // ברירת מחדל - שעון קיץ ישראל (UTC+3)
  }
}
// הרגע המדויק (UTC) של חצות בישראל עבור תאריך נתון (YYYY-MM-DD)
function israelMidnightUtcDate(isoDateStr) {
  const guessUtcMidnight = new Date(`${isoDateStr}T00:00:00Z`);
  const offsetMin = israelOffsetMinutes(guessUtcMidnight);
  return new Date(guessUtcMidnight.getTime() - offsetMin * 60000);
}

// --- קריאה בפועל לרפיד וואן ---
async function fetchRapidAppointments(fromDateOnly, toExclusiveDateOnly) {
  if (!state.headers || (!state.headers.cookie && !state.headers.authorization)) {
    const err = new Error('NO_AUTH_SAVED');
    err.code = 'NO_AUTH_SAVED';
    throw err;
  }

  const fromDate = israelMidnightUtcDate(fromDateOnly);
  const toDate = israelMidnightUtcDate(toExclusiveDateOnly);

  const url = new URL(`${RAPID_BASE_URL}/api/schedule/appointments`);
  url.searchParams.set('from', fromDate.toUTCString());
  url.searchParams.set('to', toDate.toUTCString());
  url.searchParams.set('departmentId', DEPARTMENT_ID);
  url.searchParams.set('showDebtIndicator', 'true');
  url.searchParams.set('skipApptAdditionalInfo', 'false');
  url.searchParams.set('showAppointmentOfAllDepartment', 'true');
  url.searchParams.set('applyCache', 'false');
  url.searchParams.set('foreignNames', 'false');

  const headers = { ...state.headers };
  if (!headers['content-type']) headers['content-type'] = 'application/json;charset=UTF-8';
  if (!headers['accept']) headers['accept'] = 'application/json, text/plain, */*';
  if (!headers['referer']) headers['referer'] = `${RAPID_BASE_URL}/schedule`;
  if (!headers['origin']) headers['origin'] = RAPID_BASE_URL;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.RAPID_TIMEOUT_MS || 20000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  console.log(`[fetchRapidAppointments] מתחיל בקשה ל-${url.toString()}`);
  let resp;
  try {
    resp = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: '[]',
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
    const textPreview = (await resp.text()).slice(0, 300);
    console.error(`[fetchRapidAppointments] תשובה לא-JSON (סטטוס ${resp.status}): ${textPreview}`);
    const err = new Error('COOKIE_EXPIRED_OR_INVALID');
    err.code = 'COOKIE_EXPIRED_OR_INVALID';
    throw err;
  }
  const data = await resp.json();
  if (!Array.isArray(data)) {
    console.error(`[fetchRapidAppointments] תשובת JSON לא-מערך (סטטוס ${resp.status}): ${JSON.stringify(data).slice(0, 500)}`);
    if (resp.status === 401 || resp.status === 403) {
      const err = new Error('COOKIE_EXPIRED_OR_INVALID');
      err.code = 'COOKIE_EXPIRED_OR_INVALID';
      throw err;
    }
    const err = new Error('UNEXPECTED_RESPONSE_SHAPE');
    err.code = 'UNEXPECTED_RESPONSE_SHAPE';
    throw err;
  }
  return data;
}

// --- זיהוי המטפל/ה וסוג השירות בפועל ---
// שדה doctorName לפעמים ריק (במיוחד אצל פסיכולוגים) - staffNames הוא המקור האמין יותר.
function getStaffName(appt) {
  if (Array.isArray(appt.staffNames) && appt.staffNames.length) {
    return appt.staffNames.join(', ');
  }
  if (appt.doctorName) return appt.doctorName;
  return 'לא ידוע';
}
// שם השירות/הטיפול בפועל (אם קיים) - למשל "מעקב פסיכיאטרי מבוגרים (יעוץ)" או "טיפול פסיכולוגי"
function getServiceName(appt) {
  if (appt.firstSrvName) return appt.firstSrvName;
  if (Array.isArray(appt.services) && appt.services.length && appt.services[0].serviceName) {
    return appt.services[0].serviceName;
  }
  return null;
}
// זיהוי טיפול פסיכולוגי (בניגוד לפסיכיאטרי) - כדי לסנן אותו מבדיקת הגבייה היומית
function isPsychologicalTreatment(appt) {
  const group = appt.scheduleGroupName || '';
  const service = getServiceName(appt) || '';
  return group.includes('פסיכולוג') || service.includes('פסיכולוגי');
}
// זיהוי אם staffName הוא רופא/ה (ולא איש/אשת צוות אחר) - ברפיד וואן רופאים מופיעים כ"דר " (בלי גרשיים) או "פרופ'"
function isDoctorStaffName(staffName) {
  const s = (staffName || '').trim();
  return s.startsWith('דר ') || s.startsWith('פרופ');
}
// "כללי כללי" הוא סימון פנימי של המכון (לא לקוח/פגישה אמיתיים) - למשל חסימת זמן/חופשה
function isPlaceholderBlock(appt) {
  return (appt.customerName || '').trim() === 'כללי כללי';
}

// --- בניית הדוח (הלוגיקה העסקית - ניתנת לבדיקה בנפרד) ---
function buildReport(appointments, { today, yesterday, dayPlus1, dayPlus2 }) {
  const todaySchedule = {};
  const eveningBillingCheck = [];
  const upcomingCounts = {};
  let filteredPsychologicalCount = 0;

  for (const appt of appointments) {
    if (appt.isDeleted) continue;
    const dateOnly = isoDateOnly(appt.startDate);
    const staffName = getStaffName(appt);
    const serviceName = getServiceName(appt);
    const placeholder = isPlaceholderBlock(appt);

    if (dateOnly === today && isDoctorStaffName(staffName)) {
      if (!todaySchedule[staffName]) todaySchedule[staffName] = [];
      todaySchedule[staffName].push({
        time: (appt.startDate || '').slice(11, 16),
        endTime: (appt.endDate || '').slice(11, 16),
        customerName: placeholder ? '' : (appt.customerName || ''),
        status: appt.bookingStatusName || '',
        service: serviceName,
        notes: appt.notes || '',
      });
    }

    if (dateOnly === yesterday && !placeholder) {
      const h = hourOf(appt.startDate);
      if (h !== null && h >= EVENING_CUTOFF_HOUR) {
        if (isPsychologicalTreatment(appt)) {
          filteredPsychologicalCount += 1;
        } else {
          const balance = typeof appt.patientBalance === 'number' ? appt.patientBalance : null;
          const needsAttention = appt.isPaid === false || appt.hasInvoice === false || (balance !== null && balance < 0);
          eveningBillingCheck.push({
            staffName,
            service: serviceName,
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
    }

    if ((dateOnly === dayPlus1 || dateOnly === dayPlus2) && !placeholder) {
      if (!upcomingCounts[dateOnly]) upcomingCounts[dateOnly] = {};
      upcomingCounts[dateOnly][staffName] = (upcomingCounts[dateOnly][staffName] || 0) + 1;
    }
  }

  for (const staffName of Object.keys(todaySchedule)) {
    todaySchedule[staffName].sort((a, b) => a.time.localeCompare(b.time));
  }

  return {
    generatedAt: new Date().toISOString(),
    dates: { yesterday, today, dayPlus1, dayPlus2 },
    todaySchedule,
    eveningBillingCheck,
    filteredPsychologicalCount,
    upcomingCounts,
    note: 'upcomingCounts היא ספירה גולמית של פגישות קיימות בלבד - לא בדיקת "חורים" אמיתית מול שעות עבודה מלאות של כל רופא. eveningBillingCheck כולל רק טיפולים פסיכיאטריים (לא פסיכולוגיים) - ראה filteredPsychologicalCount למספר שסוננו.',
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
      const curlText = (body.curl || '').trim();
      if (!curlText) return sendHtml(res, 400, 'לא התקבל טקסט.');
      const headers = parseCurlHeaders(curlText);
      if (!headers.cookie && !headers.authorization) {
        return sendHtml(
          res,
          400,
          'לא נמצאו בטקסט לא כותרת Cookie ולא כותרת Authorization. ודא שהדבקת את כל הפלט של "Copy as cURL" (מתחיל במילה curl).'
        );
      }
      state = { headers, savedAt: new Date().toISOString() };
      saveState(state);
      return sendHtml(
        res,
        200,
        `<!doctype html><html dir="rtl" lang="he"><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;">
          <p style="background:#dcfce7;color:#166534;padding:14px;border-radius:6px;">✔ נשמר בהצלחה (Cookie: ${headers.cookie ? 'כן' : 'לא'}, Authorization: ${headers.authorization ? 'כן' : 'לא'}).</p>
          <a href="/admin?key=${encodeURIComponent(key)}">חזרה</a>
        </body></html>`
      );
    }

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        hasCookie: !!(state.headers && state.headers.cookie),
        hasAuthorization: !!(state.headers && state.headers.authorization),
        savedAt: state.savedAt,
        headerNames: state.headers ? Object.keys(state.headers) : [],
      });
    }

    if (pathname === '/raw' && req.method === 'GET') {
      // נתיב כללי: מחזיר פגישות גולמיות (כל השדות, כמו שרפיד וואן מחזירה) לטווח תאריכים.
      // כל הסינון/ההיגיון העסקי (מי רלוונטי, אילו כללים חלים) מתבצע בצד השיחה, לא כאן.
      // from/to הם תאריכי יומן ישראל (YYYY-MM-DD); to הוא לא כולל (חצות ישראל של אותו תאריך).
      // ברירת מחדל: מאתמול ועד 7 ימים קדימה - מספיק להסתכל אחורה (גבייה/סיכומים) וקדימה (מיזוג/לו"ז).
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });
      const from = url.searchParams.get('from') || israelDateParts(-1).iso;
      const to = url.searchParams.get('to') || israelDateParts(7).iso;
      let appointments;
      try {
        appointments = await fetchRapidAppointments(from, to);
      } catch (err) {
        return sendJson(res, 502, { error: err.code || 'UNKNOWN', message: err.message });
      }
      const filtered = appointments.filter((appt) => !appt.isDeleted);
      return sendJson(res, 200, { range: { from, to }, count: filtered.length, appointments: filtered });
    }

    if (pathname === '/report' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });
      if (!state.headers) {
        return sendJson(res, 409, { error: 'NO_AUTH_SAVED', message: 'לא נשמרה עדיין חתימת בקשה. יש להיכנס ל-/admin ולהדביק cURL טרי.' });
      }

      const today = url.searchParams.get('date') || israelDateParts(0).iso;
      const yesterday = israelDateParts(-1).iso;
      const dayPlus1 = israelDateParts(1).iso;
      const dayPlus2 = israelDateParts(2).iso;
      const dayPlus3 = israelDateParts(3).iso; // גבול עליון לא כולל, לטווח השאילתה בפועל

      let appointments;
      try {
        appointments = await fetchRapidAppointments(yesterday, dayPlus3);
      } catch (err) {
        console.error(`[/report] שגיאה: ${err.code || 'UNKNOWN'} - ${err.message}`);
        if (err.code === 'NO_AUTH_SAVED') {
          return sendJson(res, 409, { error: 'NO_AUTH_SAVED', message: 'לא נשמרה עדיין חתימת בקשה. יש להיכנס ל-/admin ולהדביק cURL טרי.' });
        }
        if (err.code === 'COOKIE_EXPIRED_OR_INVALID') {
          return sendJson(res, 401, {
            error: 'COOKIE_EXPIRED_OR_INVALID',
            message: 'החיבור פג או לא תקף. יש להתחבר מחדש לרפיד וואן ולהדביק cURL טרי דרך /admin.',
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

module.exports = {
  buildReport,
  israelDateParts,
  isoDateOnly,
  hourOf,
  parseCurlHeaders,
  israelMidnightUtcDate,
  getStaffName,
  getServiceName,
  isPsychologicalTreatment,
};
