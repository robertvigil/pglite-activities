import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js';
import { setupCrud } from './crud.js';

const db = new PGlite('idb://activities-v4');

await db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    distance NUMERIC(10, 2) NOT NULL,
    duration INTERVAL NOT NULL,
    comments TEXT DEFAULT '',
    UNIQUE (date, distance, duration, comments)
  );
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// --- Theme from config ---
const VALID_THEMES = ['green', 'amber', 'white', 'plain'];
async function loadTheme() {
  const result = await db.query("SELECT value FROM config WHERE key = 'theme'");
  const theme = result.rows[0]?.value || 'plain';
  document.documentElement.setAttribute('data-theme', theme);
}

// --- Site title from config ---
async function loadTitle() {
  const result = await db.query("SELECT value FROM config WHERE key = 'site_title'");
  const title = result.rows[0]?.value || 'activities';
  document.getElementById('home-link').textContent = `[${title}]`;
}

// --- Search bar commands (! prefix) ---
async function handleCommand(input) {
  const raw = input.trim();
  if (!raw.startsWith('!')) return false;

  const parts = raw.substring(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === 'title') {
    const newTitle = parts.slice(1).join(' ');
    if (newTitle) {
      await db.query(
        "INSERT INTO config (key, value) VALUES ('site_title', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
        [newTitle]
      );
    } else {
      await db.query("DELETE FROM config WHERE key = 'site_title';");
    }
    await loadTitle();
    document.getElementById('search').value = '';
    await syncToFile();
    return true;
  }

  if (cmd === 'theme') {
    const theme = parts[1]?.toLowerCase();
    if (theme && VALID_THEMES.includes(theme)) {
      await db.query(
        "INSERT INTO config (key, value) VALUES ('theme', $1) ON CONFLICT (key) DO UPDATE SET value = $1;",
        [theme]
      );
    } else {
      await db.query("DELETE FROM config WHERE key = 'theme';");
    }
    await loadTheme();
    document.getElementById('search').value = '';
    await syncToFile();
    return true;
  }

  return false;
}

// --- Date range helpers ---
function iso(d) { return d.toISOString().split('T')[0]; }

function getCurrentWeek() {
  const today = new Date();
  var d = today.getFullYear(), m = today.getMonth(), t = today.getDate();
  var dow = new Date(d, m, t).getDay() - 1; // 0=Mon..6=Sun
  var mon = new Date(d, m, t - (dow < 0 ? dow + 7 : dow));
  var sun = new Date(d, m, t - (dow < 0 ? dow + 7 : dow) + 6);
  return { begin: iso(mon), end: iso(sun) };
}

function getCurrentMonth() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { begin: iso(first), end: iso(last) };
}

function getCurrentYear() {
  const now = new Date();
  return { begin: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
}

function getAllTime() {
  return { begin: '1970-01-01', end: '2099-12-31' };
}

function isFullWeek(begin, end) {
  if (!begin || !end) return false;
  const b = new Date(begin + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  return b.getUTCDay() === 1 && e.getTime() === b.getTime() + 6 * 86400000;
}

function showWeekNav(show) {
  document.getElementById('week-nav-buttons').style.display = show ? '' : 'none';
}

function showMonthNav(show) {
  document.getElementById('month-nav-buttons').style.display = show ? '' : 'none';
}

function isFullMonth(begin, end) {
  if (!begin || !end) return false;
  const b = new Date(begin + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const bYear = b.getUTCFullYear();
  const bMonth = b.getUTCMonth();
  const bDay = b.getUTCDate();
  const eYear = e.getUTCFullYear();
  const eMonth = e.getUTCMonth();
  if (bDay !== 1) return false;
  if (bYear !== eYear || bMonth !== eMonth) return false;
  const expectedLast = new Date(eYear, eMonth + 1, 0).getUTCDate();
  return e.getUTCDate() === expectedLast;
}

function stepMonth(delta) {
  const b = new Date(document.getElementById('begin-date').value + 'T00:00:00');
  const year = b.getUTCFullYear();
  const month = b.getUTCMonth() + delta;
  const newYear = b.getUTCFullYear() + Math.floor(month / 12);
  const newMonth = ((month % 12) + 12) % 12;
  const newFirst = new Date(newYear, newMonth, 1);
  const newLast = new Date(newYear, newMonth + 1, 0);
  setRange({ begin: iso(newFirst), end: iso(newLast) });
}

// --- Parse search query into include/exclude terms ---
function parseSearch(query) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const include = [];
  const exclude = [];
  for (const t of terms) {
    if (t.startsWith('-') && t.length > 1) {
      exclude.push(t.substring(1));
    } else {
      include.push(t);
    }
  }
  return { include, exclude };
}

// Build SQL WHERE fragments and params for comment search.
// Starts at $3 since $1 and $2 are begin/end dates.
function buildSearchClauses({ include, exclude }, startIdx = 3) {
  const clauses = [];
  const params = [];
  let i = startIdx;
  for (const term of include) {
    clauses.push(`comments ILIKE $${i}`);
    params.push(`%${term}%`);
    i++;
  }
  for (const term of exclude) {
    clauses.push(`comments NOT ILIKE $${i}`);
    params.push(`%${term}%`);
    i++;
  }
  return {
    where: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    params,
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Main refresh: filter by date range + search, compute totals ---
async function refresh() {
  const begin = document.getElementById('begin-date').value;
  const end = document.getElementById('end-date').value;
  if (!begin || !end) return;

  localStorage.setItem('activities.begin', begin);
  localStorage.setItem('activities.end', end);

  const searchQuery = document.getElementById('search').value;
  const parsed = parseSearch(searchQuery);
  const search = buildSearchClauses(parsed);

  const totalsResult = await db.query(`
    WITH agg AS (
      SELECT
        COUNT(*) AS n,
        COALESCE(SUM(distance), 0)::int AS total_distance,
        COALESCE(EXTRACT(EPOCH FROM SUM(duration))::bigint, 0) AS total_secs
      FROM activities
      WHERE date BETWEEN $1 AND $2 ${search.where}
    )
    SELECT
      n,
      total_distance,
      (total_secs / 3600)::text || ':' ||
      LPAD(((total_secs % 3600) / 60)::text, 2, '0') || ':' ||
      LPAD((total_secs % 60)::text, 2, '0')
      AS total_duration
    FROM agg;
  `, [begin, end, ...search.params]);

  const totals = totalsResult.rows[0];
  const count = Number(totals.n);
  const totalDistance = totals.total_distance;
  const totalDuration = totals.total_duration;

  const totalsDiv = document.getElementById('totals');
  totalsDiv.style.display = 'flex';
  totalsDiv.innerHTML = `
    <div class="item"><span class="label">#:</span><span class="value">${count}</span></div>
    <div class="item"><span class="label">dis:</span><span class="value">${totalDistance}</span></div>
    <div class="item"><span class="label">dur:</span><span class="value">${totalDuration}</span></div>
  `;

  const div = document.getElementById('output');
  if (count === 0) {
    div.innerHTML = '<p style="color:#666">No activities in this date range.</p>';
  } else if (count > 40) {
    div.innerHTML = `<p style="color:#666">${count} activities in this range — list hidden. Narrow the date/search range to see individual rows.</p>`;
  } else {
    const result = await db.query(`
      SELECT
        id,
        date,
        distance,
        to_char(duration, 'HH24:MI:SS') AS duration,
        comments
      FROM activities
      WHERE date BETWEEN $1 AND $2 ${search.where}
      ORDER BY date DESC, id DESC;
    `, [begin, end, ...search.params]);

    let html = '<table><tr><th>Date</th><th class="num">Distance</th><th>Duration</th><th>Comments</th><th></th></tr>';
    const dayNames = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
    for (const row of result.rows) {
      const dateStr = new Date(row.date).toISOString().split('T')[0];
      const [y, m, d] = dateStr.split('-').map(Number);
      const dayName = dayNames[new Date(y, m - 1, d).getDay()];
      const displayDate = `${m}/${d}/${String(y).slice(-2)}`;
      html += `<tr data-id="${row.id}" data-date="${dateStr}" data-distance="${row.distance}" data-duration="${row.duration}" data-comments="${escapeHtml(row.comments || '')}">
        <td>${displayDate} (${dayName})</td>
        <td class="num">${row.distance}</td>
        <td>${row.duration}</td>
        <td>${escapeHtml(row.comments || '')}</td>
        <td class="actions">
          <button class="edit" title="Edit">✎</button>
          <button class="delete" title="Delete">✕</button>
        </td>
      </tr>`;
    }
    html += '</table>';
    div.innerHTML = html;
  }
}

// --- Setup CRUD (create form, edit/delete, JSON open/save, FSA attach) ---
const { syncToFile } = setupCrud(db, refresh, { loadTitle, loadTheme });

// --- Wire up controls ---
document.getElementById('begin-date').addEventListener('change', (e) => {
  refresh();
  showWeekNav(isFullWeek(e.target.value, document.getElementById('end-date').value));
  showMonthNav(isFullMonth(e.target.value, document.getElementById('end-date').value));
});
document.getElementById('end-date').addEventListener('change', (e) => {
  refresh();
  showWeekNav(isFullWeek(document.getElementById('begin-date').value, e.target.value));
  showMonthNav(isFullMonth(document.getElementById('begin-date').value, e.target.value));
});
document.getElementById('search').addEventListener('input', (e) => {
  if (e.target.value.trim().startsWith('!')) return;
  refresh();
});
document.getElementById('search').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const handled = await handleCommand(e.target.value);
    if (!handled) refresh();
  }
});

function setRange({ begin, end }) {
  document.getElementById('begin-date').value = begin;
  document.getElementById('end-date').value = end;
  refresh();
  showWeekNav(isFullWeek(begin, end));
  showMonthNav(isFullMonth(begin, end));
}

document.getElementById('prev-week').addEventListener('click', () => {
  const b = new Date(document.getElementById('begin-date').value + 'T00:00:00');
  const e = new Date(document.getElementById('end-date').value + 'T00:00:00');
  b.setDate(b.getDate() - 7);
  e.setDate(e.getDate() - 7);
  setRange({ begin: iso(b), end: iso(e) });
});

document.getElementById('next-week').addEventListener('click', () => {
  const b = new Date(document.getElementById('begin-date').value + 'T00:00:00');
  const e = new Date(document.getElementById('end-date').value + 'T00:00:00');
  b.setDate(b.getDate() + 7);
  e.setDate(e.getDate() + 7);
  setRange({ begin: iso(b), end: iso(e) });
});

document.getElementById('prev-month').addEventListener('click', () => stepMonth(-1));
document.getElementById('next-month').addEventListener('click', () => stepMonth(1));

document.getElementById('this-week').addEventListener('click', () => setRange(getCurrentWeek()));
document.getElementById('this-month').addEventListener('click', () => setRange(getCurrentMonth()));
document.getElementById('this-year').addEventListener('click', () => setRange(getCurrentYear()));
document.getElementById('all-time').addEventListener('click', () => setRange(getAllTime()));

// --- Init ---
loadTheme();
loadTitle();

const savedBegin = localStorage.getItem('activities.begin');
const savedEnd = localStorage.getItem('activities.end');
if (savedBegin && savedEnd) {
  setRange({ begin: savedBegin, end: savedEnd });
} else {
  setRange(getCurrentWeek());
}
