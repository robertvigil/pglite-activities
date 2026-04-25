# pglite-activities

A minimalist activity tracker that runs **entirely in your browser**. No backend, no accounts, no cloud — just a single HTML file with a real PostgreSQL database (via [PGlite](https://pglite.dev/)) running client-side in IndexedDB.

Built for logging distance-based exercises (biking, running, walking) but the schema adapts to anything with a date, a distance, a duration, and notes.

**Live demo:** [robertvigil.com/activities](https://robertvigil.com/public/activities)

<img src="screenshots/mobile.jpg" alt="Mobile screenshot" width="300">

## How it works

A single HTML file with separate CSS and JS modules loaded as ES modules. Activities live in the browser's IndexedDB via PGlite. To move data between devices, export a JSON file and share it however you want (I use [Syncthing](https://syncthing.net/)).

## Features

- **Date range filtering** — always-active `from → to` range with quick buttons (Wk / Mo / Yr / ∞). ◀ ▶ arrows appear for full weeks and full months, stepping back/forward accordingly. Range persists in localStorage.
- **Live totals** — count, total distance, total duration — computed by the database, not JavaScript
- **Comments search** — multi-word AND with exclusion: `yale -rain` matches comments containing "yale" but not "rain"
- **Smart list/summary display** — ≤40 rows shows individual activities, >40 rows shows totals only (prevents wall-of-text for wide date ranges)
- **Inline CRUD** — add, edit, delete activities with compact icon buttons (✚ ✎ ✕ ✓ ↺)
- **JSON import/export** — round-trip activities to a JSON file. Import replaces all data (with confirmation). Settings (title, theme) are included in exports.
- **Configurable title** — type `!title My Rides` in the search bar to customize the `[activities]` header. Included in JSON exports.
- **Theme support** — type `!theme amber`, `!theme white`, or `!theme green` in the search bar to switch the accent color. Persists across sessions and is included in JSON exports.
- **Keyboard-friendly** — Esc cancels create/edit, Enter submits forms
- **Mobile responsive** — compact cards on small screens, tables on desktop
- **Retro terminal aesthetic** — green-on-black by default, with amber and white alternatives

## Architecture

```mermaid
graph TD
    Browser[Your browser]
    HTML[index.html — 2KB]
    CSS[css/style.css — 6KB]
    JS[js/app.js — 21KB]
    UI[UI — HTML / CSS / JS]
    PGlite[PGlite — Postgres WASM ~3MB]
    IDB[(IndexedDB)]
    Table[activities table]

    Browser --> HTML
    HTML --> CSS
    HTML --> JS
    JS --> UI
    JS --> PGlite
    PGlite --> IDB
    IDB --> Table
```

- **No backend.** The server delivers static files only.
- **No network.** Once loaded, the app works offline. Everything happens client-side.
- **Real SQL.** PGlite is actual PostgreSQL compiled to WebAssembly (see technical docs in `CLAUDE.md`).

```mermaid
graph TD
    Browser[Your browser]
    HTML[index.html ~26KB]
    UI[UI — HTML / CSS / JS]
    PGlite[PGlite — Postgres WASM ~3MB]
    IDB[(IndexedDB)]
    Table[activities table]

    Browser --> HTML
    HTML --> UI
    HTML --> PGlite
    PGlite --> IDB
    IDB --> Table
```

- **No backend.** The server only delivers `index.html` (static file).
- **No network.** Once loaded, the app works offline. Everything happens client-side.
- **Real SQL.** Not simulated — PGlite is actual PostgreSQL compiled to WebAssembly. Same query engine, same SQL features (window functions, CTEs, JSONB, pgvector, etc.) as a full Postgres server.

## Schema

```sql
CREATE TABLE activities (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  distance NUMERIC(10, 2) NOT NULL,
  duration INTERVAL NOT NULL,   -- real Postgres interval type
  comments TEXT DEFAULT '',
  UNIQUE (date, distance, duration, comments)
);
```

- `INTERVAL` type means duration math is native (`SUM(duration)` just works)
- The `UNIQUE` constraint is what makes CSV re-imports idempotent via `INSERT ... ON CONFLICT DO NOTHING`

## Running it

### Local: serve via any static file server

PGlite loads as an ES module from a CDN, which browsers block over `file://` — so you need a web server. Any static one works:

```bash
# Python stdlib (no dependencies)
python3 -m http.server 8766
```

Then open `http://localhost:8766/`.

### Deploy to a real server

It's one HTML file. Drop it behind any web server — nginx, Caddy, Vercel, GitHub Pages, etc.

## Import / Export

**Export JSON** (↓ button): downloads `activities-YYYY-MM-DD.json` with all rows and settings. Format:

```json
{
  "config": {"site_title": "my rides", "theme": "amber"},
  "entries": [
    {"date": "2026-04-18", "distance": 12.5, "duration": "01:15:00", "comments": "windy"}
  ]
}
```

**Import JSON** (↑ button): replaces all existing data with the contents of a JSON file (with confirmation prompt). Settings (title, theme) are applied from the JSON config.

## Syncing between devices

There's no built-in sync. The recommended workflow is:

1. Export JSON on device A
2. Move the JSON file to device B (Syncthing, email, USB, whatever)
3. Import JSON on device B

For automatic sync between a browser-based PGlite database and a real Postgres server, look into [ElectricSQL](https://electric-sql.com/) — same team that makes PGlite.

## Data privacy

- Activity data lives **only** in your browser's IndexedDB
- Nothing is sent to any server
- Other visitors to the same URL get their own empty database — they can't see your rides
- If you deploy the site publicly, strangers who visit just get a blank app in their own browser
- The only thing that leaves your browser is what you choose to export via JSON

**Backup is your responsibility.** If you clear site data, lose your browser profile, or uninstall the browser without a recent JSON export, your rides are gone. Regular exports to an external location (Syncthing, Dropbox, etc.) are the backup strategy.

## Keyboard shortcuts

- **Enter** — submit create/edit form
- **Esc** — cancel current create/edit
- **Tab** — navigate form fields

## Browser support

Needs a modern browser with:
- ES modules
- IndexedDB (all browsers)
- `:has()` CSS selector (2023+)
- WebAssembly (all modern browsers)

Tested: Firefox, Chrome, Safari (desktop + mobile).

## License

MIT — see `LICENSE`.

---

*This project was vibe-coded with [Claude Code](https://claude.ai/claude-code).*
