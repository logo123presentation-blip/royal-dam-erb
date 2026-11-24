# Royal Dam API

Copy `.env.example` to `.env`, set Atlas `MONGODB_URI` and a long random `JWT_SECRET`, then run:

```bash
npm install
npm run seed
npm run dev
```

The API listens on `http://localhost:3000`; use `GET /health` to verify it. Initial accounts are owner/owner123, accountant/acc123, manager/mgr123, and viewer/view123. Change them immediately.

For a legacy backup run `npm run migrate -- ../royaldam-backup.json`. It imports business data but intentionally excludes legacy plaintext-password user records.
# Royal Dam API

## Quantity takeoff API

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in the server environment. The key is never sent to clients.

- `POST /api/quantity-takeoffs` — authenticated multipart upload; field name: `file`, optional fields: `title`, `projectId`.
- `GET /api/quantity-takeoffs` — list the authenticated user's takeoffs.
- `GET /api/quantity-takeoffs/:id` — return one takeoff with locally calculated totals.
- `GET /api/quantity-takeoffs/:id/export` — download the RTL ExcelJS workbook.
- `GET /api/chat-sessions` and `GET /api/chat-sessions/:id/messages` — recent extraction history.

Supported uploads are PDF, XLS/XLSX, DXF/DWG, PNG, and JPEG up to 20 MB. Uploaded binaries are held in memory only and are not persisted. Chat sessions and messages are purged after seven days.
