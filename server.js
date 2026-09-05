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

// --- שמות ימים בעברית + תווית תאריך, לצורך הודעת הוואטסאפ היומית ---
const HE_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
// isoDateStr הוא תמיד תאריך יומן ישראל (YYYY-MM-DD) - מפרשים בצהריים מקומי כדי להימנע מבעיות אזור זמן.
function weekdayIndexOfIsoDate(isoDateStr) {
  const d = new Date(`${isoDateStr}T12:00:00`);
  return d.getDay(); // 0=ראשון ... 6=שבת
}
function heDateLabel(isoDateStr) {
  const idx = weekdayIndexOfIsoDate(isoDateStr);
  const [y, m, d] = isoDateStr.split('-');
  return `יום ${HE_WEEKDAYS[idx]}, ${d}.${m}.${y}`;
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

// --- תיקון באג אזור זמן: רפיד וואן מחזירה את startDate/endDate ב-UTC, לא בשעון ישראל ---
// הפונקציה ממירה מחרוזת UTC (כמו שמגיעה מרפיד) למחרוזת "מקומית" (שעון ישראל, קיץ/חורף אוטומטי לפי
// israelOffsetMinutes), באותו פורמט ISO (YYYY-MM-DDTHH:MM:SS) - כדי שאפשר להמשיך להשתמש ב-
// isoDateOnly/hourOf/slice(11,16) הרגילים על הפלט שלה, בלי לשנות את הפונקציות עצמן.
function utcToIsraelIsoString(rapidDateStr) {
  if (!rapidDateStr) return rapidDateStr;
  // אם המחרוזת כבר כוללת אינדיקציית אזור זמן (Z או ‎+HH:MM/-HH:MM‎) - מפרשים אותה כמו שהיא.
  // אם לא - רפיד מחזירה UTC "עירום" (בלי Z), אז מוסיפים Z כדי שתתפרש נכון כ-UTC ולא כשעון מקומי של השרת.
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(rapidDateStr);
  const utcDate = new Date(hasTz ? rapidDateStr : `${rapidDateStr}Z`);
  if (isNaN(utcDate.getTime())) return rapidDateStr; // הגנה - אם הפרסור נכשל, מחזירים את המקור
  const offsetMin = israelOffsetMinutes(utcDate);
  const localDate = new Date(utcDate.getTime() + offsetMin * 60000);
  return localDate.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS" - שעון ישראל, בפורמט UTC-ish לצורך slice
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
// שמות "לקוח" שהם סימונים פנימיים של המכון (לא פגישות אמיתיות) - למשל חסימת זמן/חופשה/זום פרטי
const PLACEHOLDER_CUSTOMER_NAMES = new Set([
  'כללי כללי',
  'ערן כללי',
  'מחוץ למכון לא לקבוע',
  'לא לקבוע מחוץ למכון',
  'לא לקבןע מחוץ למכון',
  'זום פרטי',
  'לא במכון',
]);
function isPlaceholderBlock(appt) {
  return PLACEHOLDER_CUSTOMER_NAMES.has((appt.customerName || '').trim());
}

// --- בניית הדוח (הלוגיקה העסקית - ניתנת לבדיקה בנפרד) ---
function buildReport(appointments, { today, yesterday, dayPlus1, dayPlus2 }) {
  const todaySchedule = {};
  const eveningBillingCheck = [];
  const upcomingCounts = {};
  let filteredPsychologicalCount = 0;

  // ד"ר עודד טלמור (1/9, לפי בקשת המשתמש): ברביעי - לוודא שנשלחו הסיכומים משלישי בערב (אתמול).
  // בראשון - לוודא שנשלחו הסיכומים משישי בבוקר (יומיים אחורה, כי שבת סגור - אין בדיקה בשבת עצמה).
  // זו לא בדיקה אוטומטית של "האם באמת נשלח" (אין לזה מקור נתונים ברפיד וואן) - רק תזכורת שמופיעה
  // כשהוא בכלל עבד ביום הרלוונטי, כדי לא להטריד תזכורת מיותרת בימים שהוא לא עבד.
  const todayIdx = weekdayIndexOfIsoDate(today);
  let talmorCheckDate = null;
  let talmorWorkdayLabel = '';
  if (todayIdx === 3) {
    talmorCheckDate = yesterday; // שלישי
    talmorWorkdayLabel = 'שלישי בערב';
  } else if (todayIdx === 0) {
    talmorCheckDate = israelDateParts(-2).iso; // שישי
    talmorWorkdayLabel = 'שישי בבוקר';
  }
  let talmorWorked = false;

  // תזכורת מיזוג (5/9, לפי בקשת המשתמש): אם *מחר* יש פגישה (כל רופא/מטפל) שנמשכת אחרי 20:00 -
  // יש להוציא היום בבוקר תזכורת למשרד לדאוג למיזוג מראש (המשתמש ביקש לפחות 24 שעות מראש, כלומר
  // התזכורת מוצגת בדוח של היום עבור פגישה שתתקיים מחר בערב - לא בדיעבד).
  const tomorrowLateAppts = [];

  // תזכורת פרופ' אמסלם (5/9, לפי בקשת המשתמש): להתריע באותו הבוקר שהוא עובד (לא יום לפני/אחרי),
  // עם רשימת הפעולות הקבועות (קישור זום, שאלונים, טפסי לקוחות, תזכור למטופלים).
  let amslamWorkingToday = false;

  for (const appt of appointments) {
    if (appt.isDeleted) continue;
    // רפיד וואן מחזירה startDate/endDate ב-UTC - ממירים לשעון ישראל לפני כל שימוש בתאריך/שעה שלהם.
    const startLocal = utcToIsraelIsoString(appt.startDate);
    const endLocal = utcToIsraelIsoString(appt.endDate);
    const dateOnly = isoDateOnly(startLocal);
    const staffName = getStaffName(appt);
    const serviceName = getServiceName(appt);
    const placeholder = isPlaceholderBlock(appt);

    // הערה (1/9): "כללי כללי" וכו' (placeholder) מדולג עכשיו גם בלו"ז היום, לא רק בגבייה/ספירה -
    // מאז שהוסרו ההערות (notes) מהלו"ז, אין יותר סיבה טובה להציג שורת פגישה ריקה/מטעה.
    if (dateOnly === today && isDoctorStaffName(staffName) && !placeholder) {
      if (!todaySchedule[staffName]) todaySchedule[staffName] = [];
      todaySchedule[staffName].push({
        time: (startLocal || '').slice(11, 16),
        endTime: (endLocal || '').slice(11, 16),
        customerName: appt.customerName || '',
        status: appt.bookingStatusName || '',
        service: serviceName,
        notes: appt.notes || '',
      });
      if (staffName.includes('אמסלם')) amslamWorkingToday = true;
    }

    if (dateOnly === yesterday && !placeholder) {
      const h = hourOf(startLocal);
      if (h !== null && h >= EVENING_CUTOFF_HOUR) {
        if (isPsychologicalTreatment(appt)) {
          filteredPsychologicalCount += 1;
        } else {
          const balance = typeof appt.patientBalance === 'number' ? appt.patientBalance : null;
          // הערה (1/9): appt.hasInvoice הוסר מתנאי needsAttention בכוונה - נבדק בפועל מול רפיד וואן
          // (121 פגישות, 31/8) ונמצא ש-hasInvoice הוא false בול ל-100% מהפגישות, ללא יוצא מן הכלל,
          // כולל פגישות עם isPaid=true ו-patientBalance=0 (משולמות במלואן). כלומר השדה הזה לא אמין/לא
          // מאוכלס בפועל ב-endpoint הזה, וגרם לרוב הפגישות המשולמות להיתפס בטעות כ"דורשות תשומת לב".
          // הסימנים האמיתיים והאמינים הם isPaid ו-patientBalance בלבד.
          const needsAttention = appt.isPaid === false || (balance !== null && balance < 0);
          eveningBillingCheck.push({
            staffName,
            service: serviceName,
            time: (startLocal || '').slice(11, 16),
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

    // תזכורת מיזוג: פגישה מחר שנמשכת אחרי 20:00 (השוואת מחרוזות "HH:MM" עובדת נכון פה כי שתי
    // הצדדים תמיד באורך 5 תווים קבוע - למשל "20:30" > "20:00").
    if (dateOnly === dayPlus1 && !placeholder) {
      const endTimeStr = (endLocal || '').slice(11, 16);
      if (endTimeStr && endTimeStr > '20:00') {
        tomorrowLateAppts.push({ staffName, endTime: endTimeStr });
      }
    }

    if (talmorCheckDate && dateOnly === talmorCheckDate && !placeholder && staffName.includes('טלמור')) {
      talmorWorked = true;
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
    talmorReminder: talmorCheckDate ? { checkDate: talmorCheckDate, workdayLabel: talmorWorkdayLabel, worked: talmorWorked } : null,
    amslamWorkingToday,
    tomorrowLateAppts,
    note: 'upcomingCounts היא ספירה גולמית של פגישות קיימות בלבד - לא בדיקת "חורים" אמיתית מול שעות עבודה מלאות של כל רופא. eveningBillingCheck כולל רק טיפולים פסיכיאטריים (לא פסיכולוגיים) - ראה filteredPsychologicalCount למספר שסוננו.',
  };
}

// --- בניית טקסט הודעת הוואטסאפ היומית מתוך הדוח (report מ-buildReport) + טקסט פניות (מהג'ימייל) ---
function buildWhatsAppText(report, leadsText) {
  const { today, dayPlus1 } = report.dates;
  const todayIdx = weekdayIndexOfIsoDate(today);
  const lines = [];

  lines.push('📋 דוח בוקר - מכון מנטליקס');
  lines.push(heDateLabel(today));
  lines.push('');

  // לו"ז היום - רק רופאים (todaySchedule כבר מסונן ב-buildReport)
  lines.push('🗓️ לו"ז היום:');
  const doctorNames = Object.keys(report.todaySchedule).sort();
  if (doctorNames.length === 0) {
    lines.push('אין פגישות רופאים היום.');
  } else {
    for (const name of doctorNames) {
      lines.push(`\n${name}:`);
      for (const appt of report.todaySchedule[name]) {
        const who = appt.customerName ? appt.customerName : '(חסימה פנימית)';
        const noteSuffix = appt.notes ? ` - ${appt.notes}` : '';
        lines.push(`  ${appt.time}-${appt.endTime} ${who}${noteSuffix}`);
      }
    }
  }
  lines.push('');

  // בדיקת גבייה - אתמול (הודעה כללית לכל רופא, לפי הכלל שסוכם - לא ניחוש פרטים עדינים)
  lines.push('💳 בדיקת גבייה (אתמול):');
  const needsAttention = report.eveningBillingCheck.filter((e) => e.needsAttention);
  if (needsAttention.length === 0) {
    lines.push('לא נמצאו פגישות הדורשות תשומת לב.');
  } else {
    const byDoctor = {};
    for (const e of needsAttention) {
      if (!byDoctor[e.staffName]) byDoctor[e.staffName] = [];
      byDoctor[e.staffName].push(e);
    }
    for (const doc of Object.keys(byDoctor)) {
      lines.push(`שימו לב, אתמול עבד/ה ${doc} - אנא וודאו גבייה:`);
      for (const e of byDoctor[doc]) {
        lines.push(`  ${e.time} ${e.customerName || ''}`);
      }
    }
  }
  lines.push('');

  // מחר - סגור בשבת, או מספר פגישות קבועות לכל רופא
  const tomorrowIdx = weekdayIndexOfIsoDate(dayPlus1);
  lines.push(`📆 מחר (${heDateLabel(dayPlus1)}):`);
  if (tomorrowIdx === 6) {
    lines.push('המכון סגור (שבת).');
  } else {
    const counts = report.upcomingCounts[dayPlus1] || {};
    const allNames = Object.keys(counts).sort();
    if (allNames.length === 0) {
      lines.push('אין עדיין פגישות רשומות.');
    } else {
      const doctorNames = allNames.filter((n) => isDoctorStaffName(n));
      const otherNames = allNames.filter((n) => !isDoctorStaffName(n));
      lines.push('רופאים:');
      if (!doctorNames.length) lines.push('  אין פגישות רשומות.');
      for (const n of doctorNames) lines.push(`  ${n}: ${counts[n]} פגישות קבועות`);
      lines.push('שאר המטפלים:');
      if (!otherNames.length) lines.push('  אין פגישות רשומות.');
      for (const n of otherNames) lines.push(`  ${n}: ${counts[n]} פגישות קבועות`);
    }
  }
  lines.push('');

  // סדר יום קבוע למשרד + תזכורת עציצים (שני/חמישי בלבד, מובלטת)
  lines.push('🧹 סדר יום למשרד:');
  lines.push('- לרוקן פחים בחדרים.');
  lines.push('- לסדר את המכון בבוקר.');
  lines.push('- לבדוק את מצב החלב (יש מספיק? לא מקולקל?).');
  lines.push('- לרוקן את מגש/מדף החלב במכונת הקפה.');
  lines.push('- לנקות את השולחן בפינת ההמתנה.');
  lines.push('- לוודא כי אין לכלוך או עטיפות ממתקים סביב ספת ההמתנה.');
  if (todayIdx === 1 || todayIdx === 4) {
    lines.push('');
    lines.push('🌱🚨 תזכורת חשובה - להשקות את העציצים!! 🚨🌱');
  }
  if (report.talmorReminder && report.talmorReminder.worked) {
    lines.push('');
    lines.push(`📝 תזכורת - לוודא שנשלחו הסיכומים של ד"ר עודד טלמור (${report.talmorReminder.workdayLabel})`);
  }
  if (report.amslamWorkingToday) {
    lines.push('');
    lines.push('🖥️ פרופ\' דורון אמסלם עובד היום - רשימת פעולות:');
    lines.push('  - לשלוח שוב את קישור הזום.');
    lines.push('  - לוודא שהשאלונים מולאו.');
    lines.push('  - לוודא שכל טפסי הלקוחות במערכת מסודרים.');
    lines.push('  - לתזכר את המטופלים בבוקר שיעלו בדיוק בזמן.');
  }
  if (report.tomorrowLateAppts && report.tomorrowLateAppts.length) {
    lines.push('');
    lines.push(`❄️ שימו לב - דאגתם למיזוג למחר בערב? (${describeTomorrowLateAppts(report.tomorrowLateAppts)})`);
  }
  lines.push('');

  // פניות מהלילה (מייל - מגיע כפרמטר leads; וואטסאפ תמיד דורש בדיקה ידנית)
  lines.push('📞 פניות מהלילה:');
  lines.push(leadsText && leadsText.trim() ? leadsText.trim() : 'לא התקבל סיכום פניות הפעם.');
  lines.push('');
  lines.push('⚠️ מזכיר לכם כי יש פניות גם בטלפון השני, אנא זיכרו לבדוק גם אותו.');
  lines.push('תזכורת: לבדוק כל שעה אם נכנסו פניות חדשות (מייל/וואטסאפ/טלפון).');

  return lines.join('\n');
}

// --- שליחת טקסט ההודעה לכל הנמענים דרך שרת הוואטסאפ (server-to-server, בלי מגבלת אורך URL) ---
async function sendWhatsAppText(text) {
  const sendUrl = process.env.WHATSAPP_SEND_URL || 'https://mentalics-whatsapp.onrender.com/send';
  const secret = process.env.WHATSAPP_SECRET;
  const recipients = (process.env.REPORT_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!secret) throw new Error('MISSING_WHATSAPP_SECRET');
  if (!recipients.length) throw new Error('MISSING_REPORT_RECIPIENTS');

  const results = [];
  for (const to of recipients) {
    try {
      const resp = await fetch(`${sendUrl}?key=${encodeURIComponent(secret)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, to }),
      });
      let body = {};
      try {
        body = await resp.json();
      } catch {
        // גוף לא-JSON - נשאיר body ריק, נסתמך על resp.ok/status
      }
      results.push({ to, ok: resp.ok && body.ok !== false, status: resp.status, body });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }
  return results;
}

// --- בריחת HTML (מניעת שבירת התבנית ע"י תווים כמו < > & מתוך שמות/הערות אמיתיים) ---
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// החלפה בטוחה של placeholder בתבנית (split/join, לא regex-replace - נמנע מבעיית "$" בטקסט המוחלף)
function fillPlaceholder(html, token, value) {
  return html.split(token).join(value);
}

// --- שיוך צבע קבוע לכל רופא/ה (לפי hash של השם) - כדי שאותו/ה רופא/ה יקבל/תקבל תמיד את אותו צבע,
// גם בין ימים שונים, ולא רק לפי סדר במסך של אותו יום. עוזר להבחין מהר בין כמה רופאים בו-זמנית בדוח. ---
const DOCTOR_STRIPE_COLORS = ['doc-blue', 'doc-purple', 'doc-teal', 'doc-pink', 'doc-amber'];
function stripeColorForDoctor(staffName) {
  const s = String(staffName || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return DOCTOR_STRIPE_COLORS[hash % DOCTOR_STRIPE_COLORS.length];
}

// --- בניית קטעי ה-HTML הדינמיים לכל סעיף בתבנית ה-PDF (report-template.html) ---
function buildScheduleRowsHtml(report) {
  const doctorNames = Object.keys(report.todaySchedule).sort();
  if (doctorNames.length === 0) {
    return '<div class="empty">אין פגישות רופאים היום.</div>';
  }
  // לפי בקשת המשתמש (1/9): שם הרופא/ה כשורת כותרת נפרדת (פעם אחת), והפגישות מתחתיו כשורות מוזחות
  // (לא הכל בשורה אופקית אחת עם שם הרופא חוזר על עצמו בכל פגישה). רק שם לקוח + שעה בכל שורת פגישה.
  const groups = [];
  for (const name of doctorNames) {
    const stripeColor = stripeColorForDoctor(name);
    const apptLines = report.todaySchedule[name]
      .map((appt) => {
        const who = appt.customerName ? escapeHtml(appt.customerName) : '(חסימה פנימית)';
        return `<div class="appt-line"><span class="cname">${who}</span><span class="time">${appt.time}–${appt.endTime}</span></div>`;
      })
      .join('\n');
    groups.push(
      `<div class="doctor-group"><div class="row doctor-header"><span class="stripe ${stripeColor}"></span><span class="txt"><span class="name">${escapeHtml(name)}</span></span></div>${apptLines}</div>`
    );
  }
  return groups.join('\n');
}
function buildLeadsRowsHtml(leadsText) {
  const lines = (leadsText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    return '<div class="empty">לא התקבלו פניות חדשות מהלילה (במייל).</div>';
  }
  return lines
    .map((line) => `<div class="row"><span class="stripe ok"></span><div class="txt"><span class="name">${escapeHtml(line)}</span></div></div>`)
    .join('\n');
}
function buildBillingRowsHtml(report) {
  const needsAttention = report.eveningBillingCheck.filter((e) => e.needsAttention);
  if (!needsAttention.length) {
    return '<div class="row"><span class="stripe ok"></span><div class="txt"><span class="name">לא נמצאו פגישות הדורשות תשומת לב</span><span class="chip ok">תקין</span></div></div>';
  }
  const byDoctor = {};
  for (const e of needsAttention) {
    if (!byDoctor[e.staffName]) byDoctor[e.staffName] = [];
    byDoctor[e.staffName].push(e);
  }
  const rows = [];
  for (const doc of Object.keys(byDoctor)) {
    const details = byDoctor[doc].map((e) => `${e.time} ${e.customerName || ''}`.trim()).join(', ');
    rows.push(
      `<div class="row"><span class="stripe danger"></span><div class="txt"><span class="name">${escapeHtml(doc)}</span><span class="chip danger">לוודא גבייה</span><div class="sub">${escapeHtml(details)}</div></div></div>`
    );
  }
  return rows.join('\n');
}
// עוזר: תיאור קצר וקומפקטי של רשימת פגישות מחר שנמשכות אחרי 20:00 (לתזכורת המיזוג) - לדוגמה
// "דר שרון פורת (עד 20:30), דר אורן טנא (עד 21:00)". ממוין לפי שעת סיום, מהמאוחרת ביותר.
function describeTomorrowLateAppts(tomorrowLateAppts) {
  const sorted = [...tomorrowLateAppts].sort((a, b) => b.endTime.localeCompare(a.endTime));
  return sorted.map((a) => `${a.staffName} (עד ${a.endTime})`).join(', ');
}

function buildSpecialReminderRowsHtml(todayIdx, report) {
  const { talmorReminder, amslamWorkingToday, tomorrowLateAppts } = report;
  const rows = [];
  if (todayIdx === 1 || todayIdx === 4) {
    rows.push('<div class="row"><span class="stripe danger"></span><div class="txt"><span class="name">💧 להשקות את העציצים!</span><span class="chip danger">היום</span></div></div>');
  }
  // לפי בקשת המשתמש (1/9): רביעי - לוודא סיכומים משלישי בערב; ראשון - לוודא סיכומים משישי בבוקר -
  // רק אם ד"ר טלמור בכלל עבד באותו יום (talmorReminder.worked).
  if (talmorReminder && talmorReminder.worked) {
    rows.push(
      `<div class="row"><span class="stripe danger"></span><div class="txt"><span class="name">📝 לוודא שנשלחו הסיכומים של ד"ר עודד טלמור (${escapeHtml(talmorReminder.workdayLabel)})</span><span class="chip danger">היום</span></div></div>`
    );
  }
  // לפי בקשת המשתמש (5/9): בכל בוקר שפרופ' אמסלם עובד - רשימת הפעולות הקבועות שלו.
  if (amslamWorkingToday) {
    rows.push(
      `<div class="row"><span class="stripe danger"></span><div class="txt"><span class="name">🖥️ פרופ' דורון אמסלם עובד היום - רשימת פעולות</span><span class="chip danger">היום</span><div class="sub">לשלוח שוב את קישור הזום · לוודא שהשאלונים מולאו · לוודא שכל טפסי הלקוחות במערכת מסודרים · לתזכר את המטופלים בבוקר שיעלו בדיוק בזמן</div></div></div>`
    );
  }
  // לפי בקשת המשתמש (5/9): תזכורת מיזוג ליום העבודה הבא - מוצגת יום לפני (לפחות 24 שעות מראש),
  // אם יש מחר פגישה (כל רופא/מטפל) שנמשכת אחרי 20:00.
  if (tomorrowLateAppts && tomorrowLateAppts.length) {
    rows.push(
      `<div class="row"><span class="stripe danger"></span><div class="txt"><span class="name">❄️ שימו לב - דאגתם למיזוג למחר בערב?</span><span class="chip danger">מחר</span><div class="sub">${escapeHtml(describeTomorrowLateAppts(tomorrowLateAppts))}</div></div></div>`
    );
  }
  if (!rows.length) {
    return '<div class="empty">אין תזכורות מיוחדות אוטומטיות להיום.</div>';
  }
  return rows.join('\n');
}
// לפי בקשת המשתמש (1/9): "מחר" מציג את כולם (לא רק רופאים) אבל בשתי שורות נפרדות - רופאים
// (staffName שמתחיל ב"דר"/"פרופ'") ושאר שמות המטפלים - במקום רשימה אחת מעורבת.
// מחזיר HTML גולמי (עם <br>) - שמות כבר escape-ים בפנים, אל תעטפו שוב ב-escapeHtml בצד הקורא.
function buildTomorrowLine(report) {
  const { dayPlus1 } = report.dates;
  const tomorrowIdx = weekdayIndexOfIsoDate(dayPlus1);
  const dateLabel = escapeHtml(heDateLabel(dayPlus1));
  if (tomorrowIdx === 6) {
    return `מחר (${dateLabel}) — המכון סגור.`;
  }
  const counts = report.upcomingCounts[dayPlus1] || {};
  const allNames = Object.keys(counts).sort();
  if (!allNames.length) {
    return `מחר (${dateLabel}) — אין עדיין פגישות רשומות.`;
  }
  const doctorNames = allNames.filter((n) => isDoctorStaffName(n));
  const otherNames = allNames.filter((n) => !isDoctorStaffName(n));
  const fmt = (names) => names.map((n) => `${escapeHtml(n)}: ${counts[n]}`).join(' · ');
  const doctorsPart = doctorNames.length ? `רופאים — ${fmt(doctorNames)}` : 'רופאים — אין פגישות רשומות.';
  const othersPart = otherNames.length ? `שאר המטפלים — ${fmt(otherNames)}` : 'שאר המטפלים — אין פגישות רשומות.';
  return `מחר (${dateLabel})<br>${doctorsPart}<br>${othersPart}`;
}

// --- טעינת תבנית ה-HTML (עם קאשינג בזיכרון - הקובץ לא משתנה בזמן ריצה) ---
let reportTemplateCache = null;
function loadReportTemplate() {
  if (!reportTemplateCache) {
    reportTemplateCache = fs.readFileSync(path.join(__dirname, 'report-template.html'), 'utf8');
  }
  return reportTemplateCache;
}

// --- בניית ה-HTML המלא (לצורך המרה ל-PDF) מתוך report (buildReport) + טקסט פניות ---
function renderReportHtml(report, leadsText) {
  const { today, yesterday } = report.dates;
  const todayIdx = weekdayIndexOfIsoDate(today);
  const attentionCount = report.eveningBillingCheck.filter((e) => e.needsAttention).length;
  const activeDoctorsCount = Object.keys(report.todaySchedule).length;

  let html = loadReportTemplate();
  html = fillPlaceholder(html, '{{DATE_LABEL}}', escapeHtml(heDateLabel(today)));
  html = fillPlaceholder(html, '{{ATTENTION_COUNT}}', String(attentionCount));
  html = fillPlaceholder(html, '{{ACTIVE_DOCTORS_COUNT}}', String(activeDoctorsCount));
  html = fillPlaceholder(html, '{{DOCTOR_COUNT_NOTE}}', `${activeDoctorsCount} רופאים`);
  html = fillPlaceholder(html, '{{SCHEDULE_ROWS}}', buildScheduleRowsHtml(report));
  html = fillPlaceholder(html, '{{LEADS_ROWS}}', buildLeadsRowsHtml(leadsText));
  html = fillPlaceholder(html, '{{YESTERDAY_LABEL}}', escapeHtml(heDateLabel(yesterday)));
  html = fillPlaceholder(html, '{{BILLING_ROWS}}', buildBillingRowsHtml(report));
  html = fillPlaceholder(html, '{{SPECIAL_REMINDER_ROWS}}', buildSpecialReminderRowsHtml(todayIdx, report));
  html = fillPlaceholder(html, '{{TOMORROW_LINE}}', buildTomorrowLine(report)); // כבר escape-ד בפנים + כולל <br>, לא לעטוף שוב
  return html;
}

// --- המרת HTML ל-PDF (Playwright/Chromium) - require מקומי כדי שלא יפיל את השרת אם החבילה חסרה ---
async function renderPdfBuffer(html) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
}

// --- שליחת PDF כמסמך לכל הנמענים דרך שרת הוואטסאפ ---
async function sendWhatsAppDocument(pdfBuffer, fileName, caption) {
  const sendUrl = process.env.WHATSAPP_SEND_DOCUMENT_URL || 'https://mentalics-whatsapp.onrender.com/send-document';
  const secret = process.env.WHATSAPP_SECRET;
  const recipients = (process.env.REPORT_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!secret) throw new Error('MISSING_WHATSAPP_SECRET');
  if (!recipients.length) throw new Error('MISSING_REPORT_RECIPIENTS');

  const fileBase64 = pdfBuffer.toString('base64');
  const results = [];
  for (const to of recipients) {
    try {
      const resp = await fetch(`${sendUrl}?key=${encodeURIComponent(secret)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileBase64, fileName, caption, mimetype: 'application/pdf', to }),
      });
      let body = {};
      try {
        body = await resp.json();
      } catch {
        // גוף לא-JSON - נשאיר body ריק
      }
      results.push({ to, ok: resp.ok && body.ok !== false, status: resp.status, body });
    } catch (err) {
      results.push({ to, ok: false, error: err.message });
    }
  }
  return results;
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
      // בימי ראשון - מרחיבים את תחילת השליפה עד יום שישי (יומיים אחורה, לא רק אתמול=שבת) כדי שיהיו
      // נתונים זמינים לבדיקת ד"ר טלמור (עבד שישי בבוקר?) - ראה talmorReminder ב-buildReport.
      const fetchFromDate = weekdayIndexOfIsoDate(today) === 0 ? israelDateParts(-2).iso : yesterday;

      let appointments;
      try {
        appointments = await fetchRapidAppointments(fetchFromDate, dayPlus3);
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

    if (pathname === '/daily-send' && req.method === 'GET') {
      // נתיב לאוטומציה: משימה מתוזמנת קוראת לכאן פעם ביום עם GET קצר (leads=סיכום פניות מהלילה),
      // והשרת עצמו (שרת-לשרת, לא קלוד) בונה את טקסט הדוח המלא ושולח אותו בוואטסאפ לכל הנמענים.
      // כך נמנעים לגמרי ממגבלת אורך ה-URL של WebFetch שגילינו קודם.
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });
      if (!state.headers) {
        return sendJson(res, 409, {
          error: 'NO_AUTH_SAVED',
          message: 'לא נשמרה עדיין חתימת בקשה לרפיד וואן. יש להיכנס ל-/admin ולהדביק cURL טרי.',
        });
      }

      const today = url.searchParams.get('date') || israelDateParts(0).iso;
      const yesterday = israelDateParts(-1).iso;
      const dayPlus1 = israelDateParts(1).iso;
      const dayPlus2 = israelDateParts(2).iso;
      const dayPlus3 = israelDateParts(3).iso;
      const leadsText = url.searchParams.get('leads') || '';
      // בימי ראשון - מרחיבים את תחילת השליפה עד יום שישי (יומיים אחורה, לא רק אתמול=שבת) כדי שיהיו
      // נתונים זמינים לבדיקת ד"ר טלמור (עבד שישי בבוקר?) - ראה talmorReminder ב-buildReport.
      const fetchFromDate = weekdayIndexOfIsoDate(today) === 0 ? israelDateParts(-2).iso : yesterday;

      let appointments;
      try {
        appointments = await fetchRapidAppointments(fetchFromDate, dayPlus3);
      } catch (err) {
        console.error(`[/daily-send] שגיאה בשליפת נתונים מרפיד וואן: ${err.code || 'UNKNOWN'} - ${err.message}`);
        if (err.code === 'NO_AUTH_SAVED') {
          return sendJson(res, 409, { error: 'NO_AUTH_SAVED', message: 'לא נשמרה עדיין חתימת בקשה. יש להיכנס ל-/admin ולהדביק cURL טרי.' });
        }
        if (err.code === 'COOKIE_EXPIRED_OR_INVALID') {
          return sendJson(res, 401, {
            error: 'COOKIE_EXPIRED_OR_INVALID',
            message: 'החיבור פג או לא תקף. יש להתחבר מחדש לרפיד וואן ולהדביק cURL טרי דרך /admin.',
          });
        }
        return sendJson(res, 502, { error: err.code || 'RAPID_FETCH_FAILED', message: err.message });
      }

      const report = buildReport(appointments, { today, yesterday, dayPlus1, dayPlus2 });

      // מנסים קודם PDF מעוצב; אם משהו בייצור/שליחת ה-PDF נכשל (למשל Chromium לא הותקן כמו שצריך) -
      // נופלים אוטומטית חזרה לשליחת טקסט פשוט, כדי שהדוח היומי לא "ייעלם" בגלל תקלה בשלב הזה.
      let sendResults;
      let mode = 'pdf';
      try {
        const html = renderReportHtml(report, leadsText);
        const pdfBuffer = await renderPdfBuffer(html);
        const caption = `📋 דוח בוקר - מכון מנטליקס - ${heDateLabel(today)}`;
        sendResults = await sendWhatsAppDocument(pdfBuffer, `mentalics-daily-report-${today}.pdf`, caption);
      } catch (pdfErr) {
        console.error(`[/daily-send] יצירת/שליחת PDF נכשלה (${pdfErr.message}) - נופל חזרה לשליחת טקסט.`);
        mode = 'text-fallback';
        try {
          const text = buildWhatsAppText(report, leadsText);
          sendResults = await sendWhatsAppText(text);
        } catch (textErr) {
          console.error(`[/daily-send] גם שליחת הטקסט הרזרבי נכשלה: ${textErr.message}`);
          return sendJson(res, 502, { error: 'WHATSAPP_SEND_FAILED', message: textErr.message, pdfError: pdfErr.message });
        }
      }

      const allOk = sendResults.every((r) => r.ok);
      console.log(`[/daily-send] מצב=${mode} נשלח (ok=${allOk}) לנמענים: ${sendResults.map((r) => `${r.to}:${r.ok}`).join(', ')}`);
      return sendJson(res, allOk ? 200 : 207, { ok: allOk, mode, sendResults });
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
  utcToIsraelIsoString,
  getStaffName,
  getServiceName,
  isPsychologicalTreatment,
  heDateLabel,
  weekdayIndexOfIsoDate,
  buildWhatsAppText,
  renderReportHtml,
  buildTomorrowLine,
  stripeColorForDoctor,
};
