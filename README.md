# منظومة السد الملكي — Cloud ERP

The original RTL Arabic interface remains in `royal-dam-erp-updated.html`. It now sends business data to the REST API and Electron stores only encrypted per-device session tokens.

## 1. Create MongoDB Atlas

1. Create a free Atlas account and create an **M0 Free** cluster.
2. In **Database Access**, create an application database user with a strong password.
3. In **Network Access**, add the deployment host's IP range. For a first deployment, `0.0.0.0/0` is acceptable only when protected by a strong database password; narrow it later.
4. Click **Connect → Drivers → Node.js**, copy the connection string, replace `<password>`, and append a database name such as `/royal-dam`.
5. In Atlas, enable continuous cloud backup when your Atlas plan offers it.

## 2. Deploy the API (Render)

1. Push this folder to a private GitHub repository.
2. In Render, choose **New → Blueprint** and select the repository; `render.yaml` creates the service.
3. Set `MONGODB_URI` to the Atlas string. Render generates `JWT_SECRET`; leave `CORS_ORIGIN=*` for the desktop app.
4. Deploy and open `https://YOUR-SERVICE.onrender.com/health`. It should return `{ "ok": true }`. Render provides HTTPS by default.
5. Locally, enter `royal-dam-api`, copy `.env.example` to `.env`, run `npm install`, `npm run seed`, then `npm start`. Run `npm run seed` once against the deployed database too (with its production environment values) to create initial accounts.

## 3. Configure and build the desktop installer

1. In `royal-dam-desktop`, copy `.env.example` to `.env` and set `API_BASE_URL=https://YOUR-SERVICE.onrender.com/api`.
2. Run `npm install` then `npm run start` for development.
3. Run `npm run dist` to create the Windows NSIS installer (plus macOS/Linux targets when built on their respective platforms).
4. Install the same generated installer on a second device. Sign in with the same account; creating a project on one device appears automatically on the other within 20 seconds or immediately when it receives focus.

## Data migration, backups, and rollback

- Export a JSON backup from the old app before switching. From `royal-dam-api`, run `npm run migrate -- path/to/backup.json` with production `MONGODB_URI` configured. It imports business data; users are intentionally excluded because the old file stores plaintext passwords. Run `npm run seed` and reset passwords instead.
- Owners can export data through `GET /api/backup` and restore a validated backup using `POST /api/backup/restore`.
- Atlas backups are the primary rollback mechanism. Test a restore procedure before relying on it in production.

## Security notes

Never commit `.env`, Atlas credentials, or a production Electron encryption key. Electron uses context isolation and disables Node integration; credentials and shared business data travel only over HTTPS.
