# Prompt for Codex — Finish "Royal Dam ERP" as a Cloud-Synced Electron Desktop App

Copy everything below into Codex as one message.

---

## Context

I have a working MVP of an ERP web app called **"منظومة السد الملكي" (Royal Dam ERP)** — a single HTML file (`royal-dam-erp-updated.html`) with inline CSS and vanilla JavaScript. It's Arabic (RTL) and manages: projects (مشاريع), purchases (مشتريات), workers (عمال), a treasury/cash ledger (خزينة), materials (مواد), users with role-based permissions, and app settings. It currently persists everything to the browser's `localStorage`, has a login/session system, backup export/import (JSON), and Excel export for several views.

**Problem to solve:** Right now all data lives only in one browser on one device and can be lost by clearing browser data. I need this turned into a real installable desktop app that:

1. Stores all data in a real cloud database (not local files), so it **never gets lost**.
2. Can be installed and used from **multiple different computers/devices**, all seeing the **same live data** (add a project on one PC, see it immediately on another).
3. Runs as a native desktop app via **Electron** (Windows primarily, but keep Mac/Linux buildable too).

Note: I originally asked about "RealmDB" for this — please don't use MongoDB Realm / Atlas Device Sync, it was fully shut down by MongoDB on Sept 30, 2025 and no longer works. Use **MongoDB Atlas (standard cloud MongoDB) with a lightweight REST API backend** instead — same end result (shared cloud data, works offline-tolerant if you add caching), but on a supported, current stack.

## Target Architecture

```
[Electron Desktop App on Device A]  ─┐
[Electron Desktop App on Device B]  ─┼─►  HTTPS  ──►  [Node.js/Express API]  ──►  [MongoDB Atlas]
[Electron Desktop App on Device C]  ─┘                  (hosted, e.g. Railway/Render/Fly.io)
```

- The existing HTML/CSS UI stays visually identical — do not redesign it.
- All `localStorage` read/write calls are replaced with calls to a REST API.
- The API is a separate Node.js/Express project talking to MongoDB Atlas.
- The Electron app is a thin wrapper that loads the UI and talks to the **hosted** API over the internet — so every installed copy, on every device, reads/writes the same database. This is what makes it "multi-device."
- Local JWT/session token is cached securely on each device (not shared data — just that device's login), using `electron-store` (encrypted) rather than `localStorage`.

## Part 1 — Backend API (new project: `royal-dam-api/`)

Build a Node.js + Express + MongoDB Atlas backend:

1. **Setup**
   - `package.json` with `express`, `mongoose`, `bcryptjs`, `jsonwebtoken`, `cors`, `dotenv`, `helmet`, `express-rate-limit`, `express-validator`.
   - `.env.example` with `MONGODB_URI`, `JWT_SECRET`, `PORT`, `CORS_ORIGIN`.
   - Connect to MongoDB Atlas via Mongoose. Assume I will create the free/shared Atlas cluster myself and paste the connection string — don't try to provision Atlas from code.

2. **Mongoose schemas** — mirror the data shapes already used in the HTML file's `state` object (inspect the file's `state.projects`, `state.purchases`, `state.workers`, `state.treasury`, `state.materials`, `state.users`, `state.settings`, `seedDemoData()`, and the `open*Form`/`handle*Submit` functions to get exact field names — don't guess, extract them from the actual code):
   - `Project`
   - `Purchase` (with nested line items)
   - `Worker`
   - `TreasuryTransaction`
   - `Material`
   - `User` (username, hashed password, role, permissions object)
   - `Settings` (single shared document, or per-organization if you add multi-tenant support — see Part 4)
   - Every document gets `createdAt`/`updatedAt` (Mongoose timestamps) and `createdBy`/`updatedBy` (user id) for audit purposes.

3. **Auth**
   - `POST /api/auth/login` — validate username/password (bcrypt compare), issue JWT (short-lived access token + longer-lived refresh token).
   - `POST /api/auth/refresh`, `POST /api/auth/logout`.
   - Middleware to verify JWT on all other routes and attach `req.user`.
   - Middleware to enforce the existing role/permission model (check the file's permissions editor — `openPermsEditor`, `saveUserPerms` — and replicate that permission structure server-side, not just in the UI).
   - Seed script that creates the initial admin user (reuse the default users/passwords currently in `DEFAULT_USERS` in the HTML file, then force a password change on first login).

4. **CRUD REST endpoints** for every entity, one-to-one with the current local functions, e.g.:
   - `GET/POST /api/projects`, `PUT/DELETE /api/projects/:id`
   - `GET/POST /api/purchases`, `PUT/DELETE /api/purchases/:id`
   - `GET/POST /api/workers`, `PUT/DELETE /api/workers/:id`
   - `GET/POST /api/treasury`, `DELETE /api/treasury/:id`
   - `GET/POST /api/materials`, `PUT/DELETE /api/materials/:id`
   - `GET/PUT /api/settings`
   - `GET/POST /api/users`, `PUT/DELETE /api/users/:id`, `PUT /api/users/:id/permissions`
   - Server-side validation (express-validator) matching whatever validation currently happens client-side in the form handlers.
   - Pagination/filtering isn't required for v1 unless the dataset is large — keep it simple (return full collections) unless you find perf reasons otherwise.

5. **Data integrity**
   - Use MongoDB transactions (multi-document `session.withTransaction`) for operations that touch more than one collection at once (e.g. a purchase that also creates a treasury transaction).
   - Never allow the client to send raw `id` fields that collide — use Mongo's own `_id`.
   - Enable Atlas's built-in continuous cloud backups (I'll do this in the Atlas UI) — mention this to me as a manual step, don't try to script it.

6. **Backup/export**: keep a `GET /api/backup` (full JSON dump, admin-only) and `POST /api/backup/restore` endpoint mirroring the existing `exportBackup`/`importBackup` functions, so I still have an escape hatch.

## Part 2 — Frontend changes (edit `royal-dam-erp-updated.html`, or split it into `index.html` + `app.js` + `styles.css` if that's cleaner — your call, tell me which you chose)

1. Replace the `Storage` object (`Storage.read`/`Storage.write`/`Storage.remove`, all backed by `localStorage`) with an `Api` module that wraps `fetch()` calls to the backend, using a configurable `API_BASE_URL`.
2. Every place that currently does `state.projects = Storage.read(...)` or `saveProjects()` etc. should instead:
   - On app load: fetch the relevant collections from the API and populate `state`.
   - On create/update/delete: call the API, then update `state` from the response (don't just trust the local optimistic update — use what the server returns, since other devices may have changed things).
3. Add a lightweight polling or refresh mechanism (e.g. refetch active view's data every 15–30s, or on window focus) so changes made on another device show up without a full reload. (If you want to go further and use WebSockets/Socket.IO for live push updates, that's a nice-to-have — implement it if it's not much extra effort, otherwise polling is fine for v1.)
4. Keep the `session` concept but store the JWT via the Electron secure storage bridge (see Part 3), not `localStorage`.
5. Show a small connection-status indicator (e.g. "متصل بالخادم" / "غير متصل") somewhere in the topbar, and handle API errors gracefully (toast/alert in Arabic, matching the app's existing tone) instead of failing silently.
6. Don't change any visual styling, colors, layout, or Arabic copy — this is a data-layer swap, not a redesign.

## Part 3 — Electron app (new folder: `royal-dam-desktop/`, or wrap the existing frontend folder)

1. `main.js`: creates a `BrowserWindow`, loads the frontend (either the local `index.html` which then calls the remote API, or loads the frontend from a URL you host — prefer bundling the frontend locally and only the *data* goes over the network, so the app opens instantly).
2. `preload.js`: expose a minimal, safe `window.electronAPI` for anything Electron-specific — secure token storage (`electron-store` with encryption, or `keytar`), and app version info. Do not disable context isolation or enable `nodeIntegration` in the renderer — keep it secure.
3. Menu bar basics (File/Edit/View/Help, matching Arabic app conventions if relevant), app icon, window title from the app name.
4. `electron-builder` config: build targets for Windows (`nsis` installer) and optionally macOS (`dmg`)/Linux (`AppImage`). Include app icons if I provide them (placeholder is fine for now).
5. Add `electron-updater` wired to GitHub Releases (or tell me the alternative if I don't want to use GitHub) so future updates can auto-push to all installed devices without manual reinstall.
6. A config screen or `.env`-style config file where I set the `API_BASE_URL` once per install (so the same built app can point to a staging or production backend).

## Part 4 — Deployment (give me exact steps, don't just say "deploy it")

1. Walk me through creating a free MongoDB Atlas cluster and getting the connection string (or do this section as clear numbered instructions with screenshots-equivalent text, since you can't do it for me).
2. Deploy the `royal-dam-api` backend to a host with a persistent URL reachable from any device — recommend **Railway**, **Render**, or **Fly.io** (pick whichever has the simplest free/cheap tier for a small Node+Mongo API) and give me the exact deployment steps/config files needed (`Procfile`/`render.yaml`/etc. as appropriate).
3. Set environment variables on the host (`MONGODB_URI`, `JWT_SECRET`, `CORS_ORIGIN` = nothing restrictive since it's a desktop app, not a browser page).
4. Confirm HTTPS is enabled by default on the chosen host (it should be) so credentials/data are encrypted in transit.

## Part 5 — Migration

Write a one-time Node.js script (`migrate-from-backup.js`) that takes a JSON file exported from the *existing* app's "نسخ احتياطي" (backup) feature (`exportBackup`) and imports it into MongoDB Atlas via the new API/schemas, so I don't lose my current demo/real data when switching over.

## Part 6 — Deliverables checklist

At the end, give me:
- [ ] `royal-dam-api/` — complete backend, with a `README.md` explaining local dev setup and how to run it.
- [ ] `royal-dam-desktop/` (or updated frontend files) — complete Electron app.
- [ ] `.env.example` files for both.
- [ ] `migrate-from-backup.js`.
- [ ] A top-level `README.md` explaining, in order: how to set up MongoDB Atlas, how to deploy the API, how to configure the Electron app's `API_BASE_URL`, how to build installers with `electron-builder`, and how to install the same build on a second device and confirm it sees the same data.
- [ ] A short section on how backups/rollback work now (Atlas continuous backup + the `/api/backup` endpoint).

## Constraints

- Keep all existing Arabic UI text, RTL layout, colors, and features exactly as they are — this is purely a data/architecture upgrade, not a UI rewrite.
- Don't invent new features I didn't ask for.
- Extract exact field names/data shapes from the actual `royal-dam-erp-updated.html` file (I'm providing it to you) rather than guessing — the schemas must match what the UI actually sends and expects.
- Ask me before making irreversible choices (e.g., which hosting provider, whether to split the HTML file into separate files) if there's more than one reasonable option — otherwise proceed and just tell me what you chose and why.
