// CRUD operations — create, edit, delete, JSON import/export, live-sync to attached file

// --- File System Access API support: persistent handle for live-sync to a local JSON file ---
const hasFSA = 'showSaveFilePicker' in window && window.isSecureContext;
const HANDLE_DB_NAME = 'pglite-activities-handles';
const HANDLE_KEY = 'attached-file';

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbHandle(op, value) {
  const db = await openHandleDB();
  const tx = db.transaction('handles', op === 'get' ? 'readonly' : 'readwrite');
  const store = tx.objectStore('handles');
  if (op === 'get') {
    return new Promise((resolve, reject) => {
      const req = store.get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  if (op === 'put') store.put(value, HANDLE_KEY);
  if (op === 'delete') store.delete(HANDLE_KEY);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function iso(d) { return d.toISOString().split('T')[0]; }

export function setupCrud(db, refreshFn, { loadTitle, loadTheme }) {
  const createForm = document.getElementById('create-form');
  const createToggle = document.getElementById('create-toggle');
  const createCancel = document.getElementById('create-cancel');
  const outputEl = document.getElementById('output');

  // --- Attached-file state (live-sync via File System Access API) ---
  let attachedHandle = null;
  let attachedPerm = null; // 'granted' | 'prompt' | 'denied' | null

  async function buildExportData() {
    const result = await db.query(`
      SELECT
        date,
        distance,
        to_char(duration, 'HH24:MI:SS') AS duration,
        comments
      FROM activities
      ORDER BY date, id;
    `);
    const entries = result.rows.map(row => ({
      date: new Date(row.date).toISOString().split('T')[0],
      distance: Number(row.distance),
      duration: row.duration,
      comments: row.comments || '',
    }));
    const configResult = await db.query("SELECT key, value FROM config");
    const config = {};
    for (const row of configResult.rows) config[row.key] = row.value;
    return Object.keys(config).length > 0 ? { config, entries } : entries;
  }

  async function syncToFile() {
    if (!attachedHandle || attachedPerm !== 'granted') return;
    try {
      const data = await buildExportData();
      const writable = await attachedHandle.createWritable();
      await writable.write(JSON.stringify(data, null, 2));
      await writable.close();
    } catch (err) {
      console.error('Live-sync write failed:', err);
      attachedPerm = null;
      updateAttachUI();
    }
  }

  function updateAttachUI() {
    const nameEl = document.getElementById('attach-name');
    const btn = document.getElementById('attach-file');
    const createBtn = document.getElementById('create-file');
    if (!nameEl || !btn) return;
    nameEl.classList.remove('granted', 'needs-permission');
    if (!attachedHandle) {
      nameEl.textContent = '';
      nameEl.title = '';
      btn.title = 'Open an existing JSON file and attach (live-sync). Click to pick a file.';
      if (createBtn) createBtn.style.display = '';
      return;
    }
    if (createBtn) createBtn.style.display = 'none';
    nameEl.textContent = attachedHandle.name;
    if (attachedPerm === 'granted') {
      nameEl.classList.add('granted');
      const tip = `Attached to ${attachedHandle.name} — every edit auto-saves to this file. Click to detach.`;
      btn.title = tip;
      nameEl.title = tip;
    } else {
      nameEl.classList.add('needs-permission');
      const tip = `Write permission to ${attachedHandle.name} expired (new browser session). Click to re-grant and resume auto-save.`;
      btn.title = tip;
      nameEl.title = tip;
    }
  }

  async function importJsonData(raw, sourceLabel) {
    const entries = Array.isArray(raw) ? raw : (raw.entries || []);
    const jsonConfig = Array.isArray(raw) ? {} : (raw.config || {});

    if (!Array.isArray(entries)) {
      alert('JSON must be an array of entries or {config, entries} object.');
      return false;
    }

    const searchInput = document.getElementById('search');
    const savedSearch = searchInput.value;
    const savedPlaceholder = searchInput.placeholder;
    searchInput.disabled = true;
    searchInput.value = '';

    await db.exec('BEGIN;');
    try {
      await db.exec('DELETE FROM activities;');
      const total = entries.length;
      for (let i = 0; i < entries.length; i++) {
        const row = entries[i];
        await db.query(
          `INSERT INTO activities (date, distance, duration, comments)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING;`,
          [row.date, row.distance, row.duration, row.comments || '']
        );
        if (i % 25 === 0 || i === entries.length - 1) {
          searchInput.placeholder = `Loading ${i + 1} / ${total}...`;
          await new Promise(r => setTimeout(r, 0));
        }
      }

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
      return false;
    }

    searchInput.disabled = false;
    searchInput.value = savedSearch;
    searchInput.placeholder = savedPlaceholder;

    await loadTitle();
    await loadTheme();

    alert(`Loaded ${entries.length} entries from ${sourceLabel}.`);
    return true;
  }

  // --- Create form ---
  function showCreateForm() {
    createForm.classList.add('open');
    document.getElementById('new-date').value = iso(new Date());
    document.getElementById('new-date').focus();
  }

  function hideCreateForm() {
    createForm.classList.remove('open');
    createForm.reset();
  }

  createToggle.addEventListener('click', () => {
    createForm.classList.contains('open') ? hideCreateForm() : showCreateForm();
  });

  createCancel.addEventListener('click', hideCreateForm);

  createForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      createForm.requestSubmit();
    }
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
      await refreshFn();
      await syncToFile();
    } catch (err) {
      alert('Failed to create activity: ' + err.message);
    }
  });

  // --- Row edit/delete via event delegation ---
  outputEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;

    if (btn.classList.contains('delete')) {
      if (!confirm('Delete this activity?')) return;
      await db.query('DELETE FROM activities WHERE id = $1;', [id]);
      await refreshFn();
      await syncToFile();
      return;
    }

    if (btn.classList.contains('edit')) {
      const alreadyEditing = document.querySelector('tr.editing');
      if (alreadyEditing && alreadyEditing !== tr) {
        await refreshFn();
        const newTr = document.querySelector(`tr[data-id="${id}"]`);
        if (newTr) newTr.querySelector('.edit').click();
        return;
      }
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

      if (!/^[0-9]{2}:[0-5][0-9]:[0-5][0-9]$/.test(duration)) {
        alert('Duration must be in HH:MM:SS format');
        return;
      }

      try {
        await db.query(
          'UPDATE activities SET date = $1, distance = $2, duration = $3, comments = $4 WHERE id = $5;',
          [date, distance, duration, comments, id]
        );
        await refreshFn();
        await syncToFile();
      } catch (err) {
        alert('Update failed: ' + err.message);
      }
      return;
    }

    if (btn.classList.contains('cancel')) {
      await refreshFn();
      return;
    }
  });

  // --- Ctrl+Enter or Shift+Enter saves inline edit ---
  outputEl.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || (!e.ctrlKey && !e.shiftKey)) return;
    const tr = e.target.closest('tr.editing');
    if (!tr) return;
    e.preventDefault();
    tr.querySelector('.save').click();
  });

  // --- Esc key cancels current edit/create ---
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (createForm.classList.contains('open')) {
      hideCreateForm();
      return;
    }
    if (document.querySelector('tr.editing')) {
      refreshFn();
      return;
    }
  });

  // --- JSON Save (legacy ↓ — download blob) ---
  document.getElementById('export-csv').addEventListener('click', async () => {
    const data = await buildExportData();
    const entries = Array.isArray(data) ? data : data.entries;
    if (entries.length === 0) {
      alert('No activities to export.');
      return;
    }
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `activities-${iso(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- JSON Open (legacy ↑ — file input) ---
  document.getElementById('import-csv').addEventListener('click', () => {
    document.getElementById('csv-input').click();
  });
  document.getElementById('csv-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm(`You are about to replace all existing data with "${file.name}".\n\nThis cannot be undone. Continue?`)) {
      e.target.value = '';
      return;
    }

    const text = await file.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      alert('Invalid JSON file: ' + err.message);
      return;
    }

    const ok = await importJsonData(raw, file.name);
    if (ok) {
      await refreshFn();
      await syncToFile();
    }
    e.target.value = '';
  });

  // --- Attach to local file (File System Access API) ---
  if (hasFSA) {
    // FSA available — hide the legacy ↑/↓ buttons; 🔗 / 📝 cover both jobs
    document.getElementById('export-csv').style.display = 'none';
    document.getElementById('import-csv').style.display = 'none';
    const attachBtn = document.getElementById('attach-file');
    const createBtn = document.getElementById('create-file');
    attachBtn.style.display = '';
    createBtn.style.display = '';

    async function pickAndAttach() {
      // Use showOpenFilePicker, NOT showSaveFilePicker.
      // GTK's Save dialog truncates the chosen file when you click "Replace",
      // before our code can read it — silently destroying existing content.
      // showOpenFilePicker reads the file as-is and doesn't truncate.
      // To attach to a new (not-yet-existing) file, the user creates it first
      // via their file manager / `touch activities.json` and then picks it here.
      let handle;
      try {
        [handle] = await window.showOpenFilePicker({
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
          multiple: false,
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        alert('Could not pick file: ' + err.message);
        return;
      }

      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          alert('Write permission denied — cannot attach.');
          return;
        }
      }

      const file = await handle.getFile();
      const text = await file.text();

      let existing = null;
      if (text.trim().length > 0) {
        try { existing = JSON.parse(text); } catch {}
      }
      const existingEntries = existing
        ? (Array.isArray(existing) ? existing : (existing.entries || []))
        : null;

      let syncAfterAttach = true;

      if (existingEntries && existingEntries.length > 0) {
        const load = confirm(
          `"${handle.name}" already contains ${existingEntries.length} entries.\n\n` +
          `Click OK to LOAD the file into activities (replaces current data).\n` +
          `Click Cancel to KEEP the current data (the file stays as-is until you make an edit, which will overwrite it).`
        );
        if (load) {
          await importJsonData(existing, handle.name);
        }
        syncAfterAttach = false;
      } else if (text.trim().length > 0 && !existing) {
        const ok = confirm(
          `"${handle.name}" has existing content that isn't recognized as an activities file.\n\n` +
          `Click OK to attach anyway (the content stays as-is until your next edit, which will overwrite it).\n` +
          `Click Cancel to abort.`
        );
        if (!ok) return;
        syncAfterAttach = false;
      }

      attachedHandle = handle;
      attachedPerm = 'granted';
      await idbHandle('put', handle);
      updateAttachUI();
      await refreshFn();
      if (syncAfterAttach) await syncToFile();
    }

    attachBtn.addEventListener('click', async () => {
      if (!attachedHandle) {
        await pickAndAttach();
        return;
      }

      if (attachedPerm !== 'granted') {
        try {
          const perm = await attachedHandle.requestPermission({ mode: 'readwrite' });
          attachedPerm = perm;
          updateAttachUI();
          if (perm === 'granted') await syncToFile();
        } catch (err) {
          console.error('Permission request failed:', err);
        }
        return;
      }

      if (confirm(`Detach from "${attachedHandle.name}"?\n\nFuture edits won't sync to disk.`)) {
        attachedHandle = null;
        attachedPerm = null;
        await idbHandle('delete');
        updateAttachUI();
      }
    });

    document.getElementById('attach-name').addEventListener('click', () => {
      if (attachedHandle && attachedPerm !== 'granted') attachBtn.click();
    });

    // 📝 Create new file — uses showSaveFilePicker. The user has explicitly
    // chosen "create new", so any existing file they pick gets replaced with
    // the current IDB state. (This is the destructive-but-intentional path.)
    createBtn.addEventListener('click', async () => {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: 'activities.json',
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        alert('Could not pick file: ' + err.message);
        return;
      }
      attachedHandle = handle;
      attachedPerm = 'granted';
      await idbHandle('put', handle);
      updateAttachUI();
      await refreshFn();
      await syncToFile();
    });

    // Restore any previously-attached handle
    (async () => {
      try {
        const handle = await idbHandle('get');
        if (!handle) { updateAttachUI(); return; }
        attachedHandle = handle;
        attachedPerm = await handle.queryPermission({ mode: 'readwrite' });
        updateAttachUI();
      } catch (err) {
        console.error('Failed to restore attached handle:', err);
      }
    })();
  }

  return { syncToFile };
}
