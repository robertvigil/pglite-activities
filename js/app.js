import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js';

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
  const theme = result.rows[0]?.value || 'green';
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
    return true;
  }

  return false;
}

// No automatic seeding — new devices/browsers start with an empty database.
// Use the Import JSON button (↑) to load data, or the Create button (✚) to add activities manually.

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
     // begin must be Monday (dayOfWeek=1), end must be exactly 6 days later (Sunday)
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
    // begin must be 1st of its month, end must be last day of same month
    if (bDay !== 1) return false;
    if (bYear !== eYear || bMonth !== eMonth) return false;
    const expectedLast = new Date(eYear, eMonth + 1, 0).getUTCDate();
    return e.getUTCDate() === expectedLast;
    }

 function stepMonth(delta) {
    const b = new Date(document.getElementById('begin-date').value + 'T00:00:00');
    const e = new Date(document.getElementById('end-date').value + 'T00:00:00');
    const year = b.getUTCFullYear();
    const month = b.getUTCMonth() + delta;
    const newYear = b.getUTCFullYear() + Math.floor(month / 12);
    const newMonth = ((month % 12) + 12) % 12;
    const newFirst = new Date(newYear, newMonth, 1);
    const newLast = new Date(newYear, newMonth + 1, 0);
    setRange({ begin: iso(newFirst), end: iso(newLast) });
    }


// --- Parse search query into include/exclude terms ---
// "rainy yale -trail" → { include: ['rainy', 'yale'], exclude: ['trail'] }
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

// --- Main refresh: filter by date range + search, compute totals ---
async function refresh() {
  const begin = document.getElementById('begin-date').value;
  const end = document.getElementById('end-date').value;
  if (!begin || !end) return;

  // Persist range in localStorage
  localStorage.setItem('activities.begin', begin);
  localStorage.setItem('activities.end', end);

  // Build search WHERE clause
  const searchQuery = document.getElementById('search').value;
  const parsed = parseSearch(searchQuery);
  const search = buildSearchClauses(parsed);

  // Totals via SQL — count, total distance, total duration formatted as HHH:MM:SS
  // All math done server-side in PGlite, nothing for JS to compute
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

  // Always show totals
  const totalsDiv = document.getElementById('totals');
  totalsDiv.style.display = 'flex';
  totalsDiv.innerHTML = `
    <div class="item"><span class="label">#:</span><span class="value">${count}</span></div>
    <div class="item"><span class="label">dis:</span><span class="value">${totalDistance}</span></div>
    <div class="item"><span class="label">dur:</span><span class="value">${totalDuration}</span></div>
  `;

  // Only show individual rows if ≤31 activities in range
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
      // Display as m/d/yy (more compact than yyyy-mm-dd)
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

// --- HTML escape helper (prevents injection in row data) ---
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Row edit/delete via event delegation ---
document.getElementById('output').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const tr = btn.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;

  if (btn.classList.contains('delete')) {
    if (!confirm('Delete this activity?')) return;
    await db.query('DELETE FROM activities WHERE id = $1;', [id]);
    await refresh();
    return;
  }

  if (btn.classList.contains('edit')) {
    // Only one row in edit mode at a time — refresh first to reset any others
    const alreadyEditing = document.querySelector('tr.editing');
    if (alreadyEditing && alreadyEditing !== tr) {
      await refresh();
      // Re-find the target row after refresh and continue
      const newTr = document.querySelector(`tr[data-id="${id}"]`);
      if (newTr) newTr.querySelector('.edit').click();
      return;
    }
    // Replace row cells with input fields
    tr.classList.add('editing');
    tr.innerHTML = `
      <td><input type="date" class="edit-date" value="${tr.dataset.date}"></td>
      <td><input type="number" step="0.01" class="edit-distance" value="${tr.dataset.distance}"></td>
      <td><input type="text" class="edit-duration" value="${tr.dataset.duration}" pattern="^[0-9]{2}:[0-5][0-9]:[0-5][0-9]$"></td>
      <td><input type="text" class="edit-comments" value="${tr.dataset.comments}"></td>
      <td class="actions">
        <button class="save" title="Save">✓</button>
        <button class="cancel" title="Cancel">↺</button>
      </td>
    `;
    return;
  }

  if (btn.classList.contains('save')) {
    const date = tr.querySelector('.edit-date').value;
    const distance = tr.querySelector('.edit-distance').value;
    const duration = tr.querySelector('.edit-duration').value;
    const comments = tr.querySelector('.edit-comments').value;

    // Basic client-side validation for duration
    if (!/^[0-9]{2}:[0-5][0-9]:[0-5][0-9]$/.test(duration)) {
      alert('Duration must be in HH:MM:SS format');
      return;
    }

    try {
      await db.query(
        'UPDATE activities SET date = $1, distance = $2, duration = $3, comments = $4 WHERE id = $5;',
        [date, distance, duration, comments, id]
      );
      await refresh();
    } catch (err) {
      alert('Update failed: ' + err.message);
    }
    return;
  }

  if (btn.classList.contains('cancel')) {
    await refresh();
    return;
  }
});

// --- Ctrl+Enter or Shift+Enter submits create form ---
document.getElementById('create-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
    e.preventDefault();
    document.getElementById('create-form').requestSubmit();
  }
});

// --- Ctrl+Enter or Shift+Enter saves inline edit ---
document.getElementById('output').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || (!e.ctrlKey && !e.shiftKey)) return;
  const tr = e.target.closest('tr.editing');
  if (!tr) return;
  e.preventDefault();
  tr.querySelector('.save').click();
});

// --- Esc key = cancel current edit/create ---
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  // If create form is open, close it
  if (document.getElementById('create-form').classList.contains('open')) {
    hideCreateForm();
    return;
  }

  // If a row is being edited, cancel that edit
  if (document.querySelector('tr.editing')) {
    refresh();
    return;
  }
});

// --- Create form ---
const createForm = document.getElementById('create-form');
const createToggle = document.getElementById('create-toggle');
const createCancel = document.getElementById('create-cancel');

function showCreateForm() {
  createForm.classList.add('open');
  // Default date = today
  document.getElementById('new-date').value = iso(new Date());
  document.getElementById('new-date').focus();
}

function hideCreateForm() {
  createForm.classList.remove('open');
  createForm.reset();
}

createToggle.addEventListener('click', () => {
  if (createForm.classList.contains('open')) {
    hideCreateForm();
  } else {
    showCreateForm();
  }
});

createCancel.addEventListener('click', hideCreateForm);

// --- JSON export ---
document.getElementById('export-csv').addEventListener('click', async () => {
  const result = await db.query(`
    SELECT
      date,
      distance,
      to_char(duration, 'HH24:MI:SS') AS duration,
      comments
    FROM activities
    ORDER BY date, id;
  `);

  if (result.rows.length === 0) {
    alert('No activities to export.');
    return;
  }

  const entries = result.rows.map(row => ({
    date: new Date(row.date).toISOString().split('T')[0],
    distance: Number(row.distance),
    duration: row.duration,
    comments: row.comments || '',
  }));

  const configResult = await db.query(
    "SELECT key, value FROM config"
  );
  const config = {};
  for (const row of configResult.rows) {
    config[row.key] = row.value;
  }

  const output = Object.keys(config).length > 0
    ? { config, entries }
    : entries;

  const json = JSON.stringify(output, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `activities-${iso(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// --- JSON import (with CSV fallback) ---
document.getElementById('import-csv').addEventListener('click', () => {
  document.getElementById('csv-input').click();
});
document.getElementById('csv-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();

  let entries, jsonConfig = {};

  try {
    const raw = JSON.parse(text);
    entries = Array.isArray(raw) ? raw : (raw.entries || []);
    jsonConfig = Array.isArray(raw) ? {} : (raw.config || {});
  } catch (err) {
    alert('Invalid JSON: ' + err.message);
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    alert('JSON must be an array of entries or {config, entries} object.');
    return;
  }

  if (!confirm('You are about to replace all existing data. This cannot be undone. Continue?')) return;

  const total = entries.length;
  const searchInput = document.getElementById('search');
  const savedSearch = searchInput.value;
  const savedPlaceholder = searchInput.placeholder;
  searchInput.disabled = true;
  searchInput.value = '';

  await db.exec('BEGIN;');
  try {
    await db.exec('DELETE FROM activities;');
    for (let i = 0; i < entries.length; i++) {
      const row = entries[i];
      await db.query(
        `INSERT INTO activities (date, distance, duration, comments)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING;`,
        [row.date, row.distance, row.duration, row.comments || '']
      );
      if (i % 25 === 0 || i === entries.length - 1) {
        searchInput.placeholder = `Importing ${i + 1} / ${total}...`;
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Apply config from JSON
    for (const [key, value] of Object.entries(jsonConfig)) {
      await db.query(
        "INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2;",
        [key, value]
      );
    }

    await db.exec('COMMIT;');
  } catch (err) {
    await db.exec('ROLLBACK;');
    searchInput.disabled = false;
    searchInput.value = savedSearch;
    searchInput.placeholder = savedPlaceholder;
    alert('Import failed: ' + err.message);
    return;
  }

  searchInput.disabled = false;
  searchInput.value = savedSearch;
  searchInput.placeholder = savedPlaceholder;

  // Reload title and theme in case they changed
  await loadTitle();
  await loadTheme();

  alert(`Loaded ${total} entries from ${file.name}.`);
  await refresh();
  e.target.value = '';
});


createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = document.getElementById('new-date').value;
  const distance = document.getElementById('new-distance').value;
  const duration = document.getElementById('new-duration').value;
  const comments = document.getElementById('new-comments').value;

  try {
    await db.query(
      'INSERT INTO activities (date, distance, duration, comments) VALUES ($1, $2, $3, $4);',
      [date, distance, duration, comments]
    );
    hideCreateForm();
    await refresh();
  } catch (err) {
    alert('Failed to create activity: ' + err.message);
  }
});

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

// Restore saved range or default to this week
const savedBegin = localStorage.getItem('activities.begin');
const savedEnd = localStorage.getItem('activities.end');
if (savedBegin && savedEnd) {
  setRange({ begin: savedBegin, end: savedEnd });
} else {
  setRange(getCurrentWeek());
}