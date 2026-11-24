import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { mkdir, readFile, rename, readdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { askGemini, calculateTotals, extractWithGemini, isSupportedTakeoffFile, normalizeUploadedFilename, purgeExpiredChatRecords } from './services/quantityTakeoff.js';

const zip = promisify(gzip), unzip = promisify(gunzip);
const geminiApiKeys = () => [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
const ENTITIES = ['projects', 'purchases', 'workers', 'treasury', 'materials', 'quantityTakeoffs', 'chatSessions', 'chatMessages'];
const permissions = {
  owner: ['editProjects','editPurchases','editWorkers','editTreasury','editMaterials','editSettings','editUsers','manageUsers','ownerWithdraw','viewTakeoffs','editTakeoffs'],
  accountant: ['editPurchases','editWorkers','editTreasury','editMaterials','editSettings','manageUsers','viewTakeoffs','editTakeoffs'],
  manager: ['editProjects','editPurchases','editWorkers','editMaterials','viewTakeoffs','editTakeoffs'], viewer: ['viewTakeoffs'],
};
const root = process.env.LOCAL_DATA_DIR || path.join(process.cwd(), '.royal-dam-data');
const cacheFile = path.join(root, 'royal-dam-cache.json.gz');
const queueFile = path.join(root, 'royal-dam-pending-sync.json.gz');
const backupDir = path.join(root, 'backups');
const iso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const defaultState = () => ({ version: 1, records: Object.fromEntries([...ENTITIES, 'settings'].map(x => [x, {}])), users: {}, queue: [], lastSync: null, lastBackup: null });
let state = defaultState();
let db = null;
let online = false;
let syncing = false;

async function readGzip(file, fallback) {
  try { return JSON.parse((await unzip(await readFile(file))).toString('utf8')); } catch { return fallback; }
}
async function writeGzip(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, await zip(Buffer.from(JSON.stringify(value), 'utf8')));
  await rename(temp, file);
}
async function persist({ backup = true } = {}) {
  await writeGzip(cacheFile, { ...state, queue: [] });
  await writeGzip(queueFile, state.queue);
  if (backup && (!state.lastBackup || Date.now() - Date.parse(state.lastBackup) > 12 * 60 * 60 * 1000)) {
    await mkdir(backupDir, { recursive: true });
    await writeGzip(path.join(backupDir, `royal-dam-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`), { ...state, queue: [] });
    state.lastBackup = iso();
    const files = (await readdir(backupDir)).filter(x => x.endsWith('.gz')).sort();
    await Promise.all(files.slice(0, -14).map(x => unlink(path.join(backupDir, x))));
    await writeGzip(cacheFile, { ...state, queue: [] });
  }
}
async function loadCache() {
  await mkdir(root, { recursive: true });
  state = { ...defaultState(), ...(await readGzip(cacheFile, {})) };
  state.records = { ...defaultState().records, ...(state.records || {}) };
  state.queue = await readGzip(queueFile, state.queue || []);
  // migrate: force currency to 'د' on every startup
  if (state.records.settings?.global) {
    state.records.settings.global.currency = 'د';
  }
}
function cleanUser(row) { const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; return { ...data, id: row.id, username: row.username, role: data.role || 'viewer' }; }
function userRow(user) { return { id: user.id, username: user.username, passwordHash: user.passwordHash, data: { name: user.name, role: user.role, phone: user.phone || '', email: user.email || '', permsOverride: user.permsOverride || {}, prefs: user.prefs || { theme: 'dark', lang: 'ar' }, mustChangePassword: !!user.mustChangePassword, isTrial: !!user.isTrial, trialExpiresAt: user.trialExpiresAt || null, trialDuration: user.trialDuration || null }, tokenVersion: user.tokenVersion || 0, createdAt: user.createdAt || iso(), updatedAt: user.updatedAt || iso() }; }
function isProtectedSalem(user) { const name = String(user?.data?.name || user?.name || '').toLowerCase(); const username = String(user?.username || '').toLowerCase(); return (user?.data?.role || user?.role) === 'owner' && (username === 'salem' || name.includes('salem')); }
function publicUser(user) { const { passwordHash, tokenVersion, ...safe } = user; return { ...safe, ...safe.data, isProtected: isProtectedSalem(user) }; }
function signAccess(user) { return jwt.sign({ sub: user.id, tv: user.tokenVersion }, process.env.JWT_SECRET, { expiresIn: '15m' }); }
function signRefresh(user) { return jwt.sign({ sub: user.id, tv: user.tokenVersion, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '30d' }); }
function can(user, permission) { const custom = user.data?.permsOverride || {}; return Object.hasOwn(custom, permission) ? !!custom[permission] : (permissions[user.data?.role] || []).includes(permission); }
function queue(item) { state.queue.push({ ...item, queuedAt: iso() }); }
function recordList(entity) { return Object.values(state.records[entity] || {}).filter(x => !x.deleted); }
function localRecord(entity, id) { return state.records[entity]?.[id]; }
function defaultSettings() { return { id: 'global', companyName: 'شركة السد الملكي للمقاولات', currency: 'د', location: 'ليبيا', createdAt: iso(), updatedAt: iso() }; }

async function remoteConnect() {
  if (online && db) return true;
  try {
    db = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      charset: 'utf8mb4',
      connectTimeout: 6000,
      waitForConnections: true,
      connectionLimit: 4
    });
    const conn = await db.getConnection();
    await conn.query("SET NAMES 'utf8mb4'");
    await conn.query('CREATE TABLE IF NOT EXISTS erp_records (entity VARCHAR(32) NOT NULL, id VARCHAR(64) NOT NULL, data LONGTEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY(entity,id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    await conn.query('CREATE TABLE IF NOT EXISTS erp_users (id VARCHAR(64) PRIMARY KEY, username VARCHAR(80) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, data LONGTEXT NOT NULL, token_version INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    try {
      await conn.query('ALTER TABLE erp_records CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      await conn.query('ALTER TABLE erp_users CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    } catch (_) {}
    conn.release();
    online = true;
    return true;
  } catch {
    online = false;
    db = null;
    return false;
  }
}
async function seedLocalUsers() {
  if (Object.keys(state.users).length) return;
  if (!process.env.INITIAL_ADMIN_PASSWORD) return;
  if (String(process.env.INITIAL_ADMIN_PASSWORD).length < 12) throw Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters');
  for (const [name, username, role] of [['مالك الشركة','owner','owner'],['المحاسب الرئيسي','accountant','accountant'],['مدير المشاريع','manager','manager'],['مستخدم تجريبي (مشاهدة فقط)','viewer','viewer']]) {
    const user = userRow({ id: uid(), name, username, passwordHash: await bcrypt.hash(process.env.INITIAL_ADMIN_PASSWORD, 12), role, mustChangePassword: true });
    state.users[user.id] = user; queue({ type: 'userUpsert', user });
  }
  await persist();
}
async function pushOperation(operation) {
  if (!online) throw Error('offline');
  if (operation.type === 'recordUpsert') {
    const r = operation.record;
    await db.query('INSERT INTO erp_records VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),updated_at=VALUES(updated_at)', [operation.entity, r.id, JSON.stringify(r), new Date(r.createdAt), new Date(r.updatedAt)]);
  } else if (operation.type === 'recordDelete') await db.query('DELETE FROM erp_records WHERE entity=? AND id=?', [operation.entity, operation.id]);
  else if (operation.type === 'userUpsert') {
    const u = operation.user;
    await db.query('INSERT INTO erp_users VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE username=VALUES(username),password_hash=VALUES(password_hash),data=VALUES(data),token_version=VALUES(token_version),updated_at=VALUES(updated_at)', [u.id, u.username, u.passwordHash, JSON.stringify(u.data), u.tokenVersion, new Date(u.createdAt), new Date(u.updatedAt)]);
  } else if (operation.type === 'userDelete') await db.query('DELETE FROM erp_users WHERE id=?', [operation.id]);
}
async function pullRemote() {
  const [records, users] = await Promise.all([db.query('SELECT * FROM erp_records'), db.query('SELECT * FROM erp_users')]);
  const nextRecords = Object.fromEntries([...ENTITIES, 'settings'].map(x => [x, {}]));
  for (const r of records[0]) { const parsed = JSON.parse(r.data); nextRecords[r.entity] ||= {}; nextRecords[r.entity][r.id] = { ...parsed, id: r.id, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() }; }
  const nextUsers = {};
  for (const r of users[0]) { const user = userRow({ ...cleanUser(r), passwordHash: r.password_hash, tokenVersion: r.token_version, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() }); nextUsers[user.id] = user; }
  state.records = nextRecords; state.users = nextUsers; state.lastSync = iso();
  // migrate: force currency to 'د' after remote pull
  if (state.records.settings?.global) state.records.settings.global.currency = 'د';
}
async function sync() {
  if (syncing || !await remoteConnect()) return false;
  syncing = true;
  try {
    while (state.queue.length) { const op = state.queue[0]; await pushOperation(op); state.queue.shift(); await persist({ backup: false }); }
    await pullRemote(); await persist(); return true;
  } catch { online = false; return false; } finally { syncing = false; }
}
async function commit(operation) {
  queue(operation); await persist();
  if (await sync()) return { synced: true };
  return { synced: false };
}
async function ensureData() { await loadCache(); const connected = await remoteConnect(); if (connected) { await pullRemote(); await persist({ backup: false }); } if (!Object.keys(state.users).length) await seedLocalUsers(); await sync(); const removed = purgeExpiredChatRecords(state.records); for (const item of removed) queue({ type: 'recordDelete', entity: item.collection, id: item.id }); if (removed.length) { await persist({ backup: false }); await sync(); } }
function authenticate(req, res, next) { try { const raw = req.headers.authorization?.replace(/^Bearer\s+/, ''); const payload = jwt.verify(raw, process.env.JWT_SECRET); const user = state.users[payload.sub]; if (!user || user.tokenVersion !== payload.tv) throw Error(); if (user.data?.isTrial && user.data?.trialExpiresAt && Date.now() > Date.parse(user.data.trialExpiresAt)) { return res.status(403).json({ message: '⛔ انتهت الفترة التجريبية لهذا الحساب.' }); } req.user = user; next(); } catch { res.status(401).json({ message: 'انتهت الجلسة أو تم إنهاؤها من جهاز آخر' }); } }
function allow(permission) { return (req, res, next) => can(req.user, permission) ? next() : res.status(403).json({ message: 'ليس لديك الصلاحية المطلوبة' }); }
function response(res, data, result, status = 200) { res.status(result.synced ? status : 202).json({ ...data, syncStatus: result.synced ? 'synced' : 'pending' }); }

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET.includes('change-this')) throw Error('JWT_SECRET must be a strong server-only secret');
await ensureData();
const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(helmet()); app.use(cors({ origin: (origin, callback) => {
  if (!origin || origin === 'null' || origin.startsWith('http://127.0.0.1:') || origin.startsWith('http://localhost:')) return callback(null, true);
  return callback(null, allowedOrigins.includes(origin) ? origin : false);
} })); app.use(express.json({ limit: '2mb' }));
const MAX_TAKEOFF_FILES = 5;
const takeoffUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});
app.get('/health', async (_, res) => { await sync(); res.json({ ok: true, database: online ? 'mysql' : 'offline-cache', online, queued: state.queue.length, lastSync: state.lastSync }); });
app.get('/api/sync-status', authenticate, async (_, res) => { await sync(); res.json({ online, queued: state.queue.length, lastSync: state.lastSync, backupFile: cacheFile }); });
app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }), async (req, res) => { await sync(); const user = Object.values(state.users).find(x => x.username === String(req.body.username || '').toLowerCase()); if (!user || !await bcrypt.compare(req.body.password || '', user.passwordHash)) return res.status(401).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' }); if (user.data?.isTrial && user.data?.trialExpiresAt && Date.now() > Date.parse(user.data.trialExpiresAt)) { return res.status(403).json({ message: '⛔ انتهت الفترة التجريبية لهذا الحساب. يرجى التواصل مع مالك المنظومة للتمديد.' }); } res.json({ accessToken: signAccess(user), refreshToken: signRefresh(user), user: publicUser(user), sync: { online, queued: state.queue.length } }); });
app.post('/api/auth/register', async (req, res) => { const { name, username, password } = req.body; if (!name || !/^[a-z0-9_]{3,}$/i.test(username || '') || String(password || '').length < 12) return res.status(422).json({ message: 'بيانات الحساب غير صالحة وكلمة المرور يجب أن تكون 12 حرفاً على الأقل' }); if (Object.values(state.users).some(x => x.username === username.toLowerCase())) return res.status(409).json({ message: 'اسم المستخدم مستخدم مسبقًا' }); const role = Object.keys(state.users).length ? 'viewer' : 'owner'; const user = userRow({ id: uid(), name: String(name).trim(), username: username.toLowerCase(), passwordHash: await bcrypt.hash(password, 12), role }); state.users[user.id] = user; const result = await commit({ type: 'userUpsert', user }); response(res, { user: publicUser(user) }, result, 201); });
app.post('/api/auth/refresh', (req, res) => { try { const payload = jwt.verify(req.body.refreshToken, process.env.JWT_SECRET); const user = state.users[payload.sub]; if (payload.type !== 'refresh' || !user || user.tokenVersion !== payload.tv) throw Error(); if (user.data?.isTrial && user.data?.trialExpiresAt && Date.now() > Date.parse(user.data.trialExpiresAt)) { return res.status(403).json({ message: '⛔ انتهت الفترة التجريبية لهذا الحساب.' }); } res.json({ accessToken: signAccess(user), refreshToken: signRefresh(user) }); } catch { res.status(401).json({ message: 'انتهت الجلسة' }); } });
app.use('/api', authenticate);
app.post('/api/ai/ask', allow('viewTakeoffs'), rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyGenerator: req => req.user.id }), takeoffUpload.fields([{ name: 'files', maxCount: 10 }]), async (req, res) => { try { const message = String(req.body.message || '').trim(); const files = req.files?.files || []; const apiKeys = geminiApiKeys(); if (!message || message.length > 4000) return res.status(422).json({ message: 'اكتب سؤالاً من 1 إلى 4000 حرف' }); if (files.length > MAX_TAKEOFF_FILES) return res.status(422).json({ message: `يمكن معالجة ${MAX_TAKEOFF_FILES} ملفات كحد أقصى في الطلب الواحد` }); if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) return res.status(413).json({ message: 'إجمالي الملفات يتجاوز 100 ميجابايت' }); let history = []; try { const parsed = JSON.parse(String(req.body.history || '[]')); history = Array.isArray(parsed) ? parsed : []; } catch {} res.json({ answer: await askGemini(message, { apiKey: apiKeys[0], apiKeys, model: process.env.GEMINI_MODEL, files, history }) }); } catch (error) { res.status(error.message === 'GEMINI_API_KEY is not configured' ? 503 : error.status === 429 ? 429 : 422).json({ message: error.message }); } });
app.post('/api/auth/logout', async (req, res) => { req.user.tokenVersion++; req.user.updatedAt = iso(); const result = await commit({ type: 'userUpsert', user: req.user }); res.status(result.synced ? 204 : 202).end(); });
app.get('/api/me', (req, res) => res.json(publicUser(req.user)));
app.put('/api/me', async (req, res) => { if (req.body.name && !isProtectedSalem(req.user)) req.user.data.name = String(req.body.name).trim(); if (req.body.prefs) req.user.data.prefs = { ...req.user.data.prefs, ...req.body.prefs }; req.user.updatedAt = iso(); const result = await commit({ type: 'userUpsert', user: req.user }); response(res, publicUser(req.user), result); });
app.put('/api/me/password', async (req, res) => { if (isProtectedSalem(req.user)) return res.status(403).json({ message: 'حساب سالم محمي ولا يمكن تغيير كلمة مروره' }); const password = String(req.body.password || ''); if (password.length < 4) return res.status(422).json({ message: 'كلمة المرور يجب أن تكون 4 أحرف على الأقل' }); req.user.passwordHash = await bcrypt.hash(password, 12); req.user.updatedAt = iso(); const result = await commit({ type: 'userUpsert', user: req.user }); response(res, { message: 'تم تغيير كلمة المرور' }, result); });

function ownsTakeoff(req, takeoff) { return takeoff && (takeoff.createdBy === req.user.id || req.user.data?.role === 'owner'); }
function chatForUser(session, userId) { return session?.createdBy === userId; }
function addRecord(entity, record) { state.records[entity][record.id] = record; queue({ type: 'recordUpsert', entity, record }); }
const takeoffRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyGenerator: req => req.user.id, standardHeaders: true, legacyHeaders: false });

app.get('/api/quantity-takeoffs', allow('viewTakeoffs'), (req, res) => {
  purgeExpiredChatRecords(state.records);
  res.json(recordList('quantityTakeoffs').filter(takeoff => ownsTakeoff(req, takeoff)).map(({ items, ...summary }) => ({ ...summary, itemCount: items.length })));
});
app.post('/api/quantity-takeoffs', allow('editTakeoffs'), takeoffRateLimit, takeoffUpload.fields([{ name: 'files', maxCount: 10 }, { name: 'file', maxCount: 1 }]), async (req, res) => {
  const files = [...(req.files?.files || []), ...(req.files?.file || [])];
  if (!files.length) return res.status(400).json({ message: 'ارفع ملفًا أو مجلدًا يحتوي على ملفات المخطط أو جدول الكميات' });
  if (files.length > MAX_TAKEOFF_FILES) return res.status(422).json({ message: `يمكن معالجة ${MAX_TAKEOFF_FILES} ملفات كحد أقصى في الطلب الواحد` });
  if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) return res.status(413).json({ message: 'إجمالي الملفات يتجاوز 100 ميجابايت' });
  const unsupported = files.find(file => !isSupportedTakeoffFile(file));
  if (unsupported) return res.status(415).json({ message: `نوع الملف غير مدعوم: ${unsupported.originalname}` });
  purgeExpiredChatRecords(state.records);
  const filenames = files.map(file => normalizeUploadedFilename(file.originalname).replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200));
  const title = String(req.body.title || (filenames.length === 1 ? filenames[0] : `${filenames.length} ملفات`)).slice(0, 200);
  const session = { id: uid(), createdBy: req.user.id, projectId: String(req.body.projectId || ''), title, createdAt: iso(), updatedAt: iso(), status: 'processing' };
  addRecord('chatSessions', session);
  const userMessage = { id: uid(), sessionId: session.id, createdBy: req.user.id, role: 'user', content: `استخراج حصر من ${filenames.join('، ')}`, createdAt: iso(), updatedAt: iso() };
  addRecord('chatMessages', userMessage);
  try {
    const extractedItems = [];
    for (const file of files) {
      const apiKeys = geminiApiKeys();
      const extracted = await extractWithGemini(file, { apiKey: apiKeys[0], apiKeys, model: process.env.GEMINI_TAKEOFF_MODEL || undefined });
      const sourceName = normalizeUploadedFilename(file.originalname);
      extractedItems.push(...extracted.items.map(item => ({ ...item, notes: item.notes ? `${sourceName} — ${item.notes}` : sourceName })));
    }
    const totals = calculateTotals(extractedItems);
    const takeoff = { id: uid(), createdBy: req.user.id, projectId: session.projectId, title: session.title, sourceFile: { name: filenames.length === 1 ? filenames[0] : `${filenames.length} ملفات`, type: 'application/octet-stream', size: files.reduce((sum, file) => sum + file.size, 0) }, sourceFiles: filenames.map((name, index) => ({ name, type: files[index].mimetype, size: files[index].size })), items: extractedItems, ...totals, createdAt: iso(), updatedAt: iso() };
    session.status = 'completed'; session.takeoffId = takeoff.id; session.updatedAt = iso();
    addRecord('quantityTakeoffs', takeoff);
    const assistantMessage = { id: uid(), sessionId: session.id, createdBy: req.user.id, role: 'assistant', content: JSON.stringify({ itemCount: totals.itemCount, total: totals.total }), createdAt: iso(), updatedAt: iso() };
    addRecord('chatMessages', assistantMessage);
    queue({ type: 'recordUpsert', entity: 'chatSessions', record: session });
    await persist();
    await sync();
    res.status(201).json(takeoff);
  } catch (error) {
    session.status = 'failed'; session.error = error.message; session.updatedAt = iso();
    queue({ type: 'recordUpsert', entity: 'chatSessions', record: session });
    const errorMessage = { id: uid(), sessionId: session.id, createdBy: req.user.id, role: 'system', content: error.message, createdAt: iso(), updatedAt: iso() };
    addRecord('chatMessages', errorMessage);
    await persist({ backup: false });
    await sync();
    res.status(error.message === 'GEMINI_API_KEY is not configured' ? 503 : error.status === 429 ? 429 : 422).json({ message: error.message, sessionId: session.id });
  }
});
app.get('/api/quantity-takeoffs/:id', allow('viewTakeoffs'), (req, res) => {
  purgeExpiredChatRecords(state.records);
  const takeoff = localRecord('quantityTakeoffs', req.params.id);
  if (!ownsTakeoff(req, takeoff)) return res.status(404).json({ message: 'غير موجود' });
  res.json(takeoff);
});
app.delete('/api/quantity-takeoffs/:id', allow('editTakeoffs'), async (req, res) => {
  const takeoff = localRecord('quantityTakeoffs', req.params.id);
  if (!ownsTakeoff(req, takeoff)) return res.status(404).json({ message: 'غير موجود' });
  const sessions = recordList('chatSessions').filter(session => session.takeoffId === takeoff.id);
  const sessionIds = new Set(sessions.map(session => session.id));
  for (const message of recordList('chatMessages')) {
    if (sessionIds.has(message.sessionId)) {
      delete state.records.chatMessages[message.id];
      queue({ type: 'recordDelete', entity: 'chatMessages', id: message.id });
    }
  }
  for (const session of sessions) {
    delete state.records.chatSessions[session.id];
    queue({ type: 'recordDelete', entity: 'chatSessions', id: session.id });
  }
  delete state.records.quantityTakeoffs[takeoff.id];
  const result = await commit({ type: 'recordDelete', entity: 'quantityTakeoffs', id: takeoff.id });
  res.status(result.synced ? 204 : 202).end();
});
app.get('/api/quantity-takeoffs/:id/export', allow('viewTakeoffs'), async (req, res, next) => {
  try {
    const takeoff = localRecord('quantityTakeoffs', req.params.id);
    if (!ownsTakeoff(req, takeoff)) return res.status(404).json({ message: 'غير موجود' });
    const { buildQuantityTakeoffWorkbook } = await import('./services/quantityTakeoffExcel.js');
    const buffer = await buildQuantityTakeoffWorkbook(takeoff);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="quantity-takeoff-${takeoff.id}.xlsx"`);
    res.send(buffer);
  } catch (error) { next(error); }
});
app.get('/api/chat-sessions', allow('viewTakeoffs'), (req, res) => {
  purgeExpiredChatRecords(state.records);
  res.json(recordList('chatSessions').filter(session => chatForUser(session, req.user.id)));
});
app.get('/api/chat-sessions/:id/messages', allow('viewTakeoffs'), (req, res) => {
  purgeExpiredChatRecords(state.records);
  const session = localRecord('chatSessions', req.params.id);
  if (!chatForUser(session, req.user.id)) return res.status(404).json({ message: 'غير موجود' });
  res.json(recordList('chatMessages').filter(message => message.sessionId === session.id && message.createdBy === req.user.id));
});

const routePermissions = { projects: 'editProjects', purchases: 'editPurchases', workers: 'editWorkers', treasury: 'editTreasury', materials: 'editMaterials' };
for (const [entity, permission] of Object.entries(routePermissions)) {
  app.get(`/api/${entity}`, (_, res) => res.json(recordList(entity)));
  app.post(`/api/${entity}`, allow(permission), async (req, res) => { const record = { ...req.body, id: uid(), createdAt: iso(), updatedAt: iso() }; if (entity === 'purchases' && !record.number) record.number = `PUR-${Date.now().toString().slice(-6)}`; state.records[entity][record.id] = record; const result = await commit({ type: 'recordUpsert', entity, record }); response(res, record, result, 201); });
  app.put(`/api/${entity}/:id`, allow(permission), async (req, res) => { const old = localRecord(entity, req.params.id); if (!old) return res.status(404).json({ message: 'غير موجود' }); const record = { ...req.body, id: old.id, createdAt: old.createdAt, updatedAt: iso() }; state.records[entity][record.id] = record; const result = await commit({ type: 'recordUpsert', entity, record }); response(res, record, result); });
  app.delete(`/api/${entity}/:id`, allow(permission), async (req, res) => { delete state.records[entity][req.params.id]; const result = await commit({ type: 'recordDelete', entity, id: req.params.id }); res.status(result.synced ? 204 : 202).end(); });
}
app.get('/api/settings', (_, res) => res.json(localRecord('settings', 'global') || defaultSettings()));
app.put('/api/settings', allow('editSettings'), async (req, res) => { const old = localRecord('settings', 'global') || defaultSettings(); const record = { ...req.body, id: 'global', createdAt: old.createdAt, updatedAt: iso() }; state.records.settings.global = record; const result = await commit({ type: 'recordUpsert', entity: 'settings', record }); response(res, record, result); });
app.get('/api/users', allow('manageUsers'), (_, res) => res.json(Object.values(state.users).map(publicUser)));
app.post('/api/users', allow('editUsers'), async (req, res) => { const { name, username, password, role = 'viewer', phone = '', email = '', isTrial = false, trialExpiresAt = null, trialDuration = null } = req.body; if (!name || !username || String(password || '').length < 4) return res.status(422).json({ message: 'الحقول الأساسية مطلوبة' }); if (Object.values(state.users).some(x => x.username === String(username).toLowerCase())) return res.status(409).json({ message: 'اسم المستخدم موجود' }); const user = userRow({ id: uid(), name, username: String(username).toLowerCase(), passwordHash: await bcrypt.hash(password, 12), role, phone, email, isTrial, trialExpiresAt, trialDuration }); state.users[user.id] = user; const result = await commit({ type: 'userUpsert', user }); response(res, publicUser(user), result, 201); });
app.put('/api/users/:id', allow('editUsers'), async (req, res) => { const user = state.users[req.params.id]; if (!user) return res.status(404).json({ message: 'غير موجود' }); if (isProtectedSalem(user)) return res.status(403).json({ message: 'حساب سالم محمي ولا يمكن تعديله' }); const body = req.body; if (body.username && body.username !== user.username && Object.values(state.users).some(x => x.id !== user.id && x.username === String(body.username).toLowerCase())) return res.status(409).json({ message: 'اسم المستخدم موجود' }); user.username = String(body.username || user.username).toLowerCase(); user.data = { ...user.data, ...Object.fromEntries(['name','role','phone','email','isTrial','trialExpiresAt','trialDuration'].filter(x => body[x] !== undefined).map(x => [x, body[x]])) }; if (body.password) user.passwordHash = await bcrypt.hash(body.password, 12); user.updatedAt = iso(); const result = await commit({ type: 'userUpsert', user }); response(res, publicUser(user), result); });
app.put('/api/users/:id/permissions', allow('editUsers'), async (req, res) => { const user = state.users[req.params.id]; if (!user) return res.status(404).json({ message: 'غير موجود' }); if (isProtectedSalem(user)) return res.status(403).json({ message: 'لا يمكن تغيير صلاحيات حساب سالم' }); user.data.permsOverride = req.body.permsOverride || {}; user.updatedAt = iso(); const result = await commit({ type: 'userUpsert', user }); response(res, publicUser(user), result); });
app.delete('/api/users/:id', allow('editUsers'), async (req, res) => { if (req.params.id === req.user.id) return res.status(400).json({ message: 'لا يمكن حذف حسابك' }); const user = state.users[req.params.id]; if (isProtectedSalem(user)) return res.status(403).json({ message: 'حساب سالم محمي ولا يمكن حذفه' }); delete state.users[req.params.id]; const result = await commit({ type: 'userDelete', id: req.params.id }); res.status(result.synced ? 204 : 202).end(); });
app.post('/api/logout-all', allow('ownerWithdraw'), async (req, res) => { for (const user of Object.values(state.users)) if (user.id !== req.user.id) { user.tokenVersion++; user.updatedAt = iso(); queue({ type: 'userUpsert', user }); } const old = localRecord('settings', 'global') || defaultSettings(); const record = { ...old, sessionsRevokedAt: Date.now(), updatedAt: iso() }; state.records.settings.global = record; queue({ type: 'recordUpsert', entity: 'settings', record }); await persist(); const synced = await sync(); res.json({ message: 'تم إنهاء جميع الجلسات', syncStatus: synced ? 'synced' : 'pending' }); });
app.use((error, _, res, __) => { console.error(error); if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'حجم الملف يتجاوز 20 ميجابايت' }); res.status(500).json({ message: 'حدث خطأ في الخادم' }); });
const listenPort = process.env.PORT === '0' ? 0 : (process.env.PORT || 3000);
export const localApiServer = app.listen(listenPort, () => console.log(`Royal Dam API (${online ? 'online' : 'offline'}) listening`));
localApiServer.requestTimeout = 0;
localApiServer.timeout = 0;
setInterval(sync, 15_000).unref();
