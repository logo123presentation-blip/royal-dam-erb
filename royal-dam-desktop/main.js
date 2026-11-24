const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { autoUpdater } = require('electron-updater');
let store;
let apiProcess;
let mainWindow;
let localApiUrl = 'http://127.0.0.1:3000/api';
let updateCheckInFlight = false;
let updateOperation = 'check';

function sendUpdateState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updates:state', state);
}

function getReleaseNotes(info = {}) {
  const notes = info.releaseNotes;
  if (Array.isArray(notes)) {
    return notes.map(entry => typeof entry === 'string' ? entry : (entry?.note || entry?.releaseName || '')).filter(Boolean).join('\n');
  }
  return typeof notes === 'string' ? notes : '';
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => sendUpdateState({ state: 'checking' }));
  autoUpdater.on('update-available', info => sendUpdateState({ state: 'available', version: info.version, releaseName: info.releaseName || '', releaseNotes: getReleaseNotes(info) }));
  autoUpdater.on('update-not-available', info => sendUpdateState({ state: 'none', version: info?.version || app.getVersion() }));
  autoUpdater.on('download-progress', progress => sendUpdateState({ state: 'downloading', version: progress.version || '', percent: Math.round(progress.percent || 0), transferred: progress.transferred || 0, total: progress.total || 0, bytesPerSecond: progress.bytesPerSecond || 0 }));
  autoUpdater.on('update-downloaded', info => sendUpdateState({ state: 'downloaded', version: info.version, releaseName: info.releaseName || '', releaseNotes: getReleaseNotes(info) }));
  autoUpdater.on('error', error => sendUpdateState({ state: 'error', silent: updateOperation === 'check', message: error?.message || 'تعذر التحقق من التحديث' }));
}

async function checkForUpdates() {
  if (!app.isPackaged || updateCheckInFlight) return { skipped: true };
  updateCheckInFlight = true;
  updateOperation = 'check';
  try { return await autoUpdater.checkForUpdates(); }
  catch (error) { sendUpdateState({ state: 'error', silent: true, message: error?.message || 'تعذر التحقق من التحديث' }); return null; }
  finally { updateCheckInFlight = false; }
}
async function startLocalApi() {
  // Let Windows choose a free loopback port so another app cannot block login.
  process.env.PORT = '0';
  process.env.LOCAL_DATA_DIR = process.env.LOCAL_DATA_DIR || path.join(app.getPath('userData'), 'offline-data');
  const secretFile = path.join(app.getPath('userData'), 'offline-data', '.jwt-secret');
  try {
    const savedSecret = fs.readFileSync(secretFile, 'utf8').trim();
    if (savedSecret.length < 32 || savedSecret.includes('change-this')) throw new Error('Saved JWT secret is invalid');
    process.env.JWT_SECRET = savedSecret;
  } catch (_) {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, process.env.JWT_SECRET, { mode: 0o600 });
  }

  try {
    const { localApiServer } = await import('./local-api.mjs');
    if (!localApiServer.listening) await new Promise((resolve, reject) => {
      localApiServer.once('listening', resolve);
      localApiServer.once('error', reject);
    });
    localApiUrl = `http://127.0.0.1:${localApiServer.address().port}/api`;
    console.log('Local API running in main process');
  } catch (error) {
    console.error('Could not start local API:', error);
    dialog.showErrorBox('تعذر تشغيل الخادم المحلي', error.message || String(error));
  }
}
// Prevent Windows IME/hardware media keys from hijacking keyboard input context
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
// Fix: Bypass unsupported Chromium WebUI print preview and use native OS print dialog directly
app.commandLine.appendSwitch('disable-print-preview');

// Fix Windows 11: Switch modern UnifiedPrintDialog to classic legacy dialog to avoid "This app doesn't support print preview"
if (process.platform === 'win32') {
  exec('reg add "HKCU\\Software\\Microsoft\\Print\\UnifiedPrintDialog" /v "PreferLegacyPrintDialog" /d 1 /t REG_DWORD /f', (err) => {
    if (err) console.warn('Could not set legacy print dialog registry:', err.message);
  });
}

// ── Open mailto: or Gmail in Google Chrome; other URLs in default browser ──
function openEmailOrUrl(url) {
  let targetUrl = url;
  if (targetUrl.startsWith('mailto:')) {
    const raw = targetUrl.slice(7);
    const [addressPart, queryPart] = raw.split('?');
    const params  = new URLSearchParams(queryPart || '');
    const to      = decodeURIComponent(addressPart || '');
    const subject = params.get('subject') || '';
    const body    = params.get('body') || '';
    targetUrl =
      `https://mail.google.com/mail/?view=cm&fs=1` +
      `&to=${encodeURIComponent(to)}` +
      (subject ? `&su=${encodeURIComponent(subject)}` : '') +
      (body    ? `&body=${encodeURIComponent(body)}`  : '');
  }

  const isMail = targetUrl.includes('mail.google.com');
  if (isMail) {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA
        ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
        : ''
    ].filter(Boolean);
    for (const cp of chromePaths) {
      if (fs.existsSync(cp)) {
        exec(`"${cp}" "${targetUrl}"`);
        return;
      }
    }
    exec(`start chrome "${targetUrl}"`, (err) => {
      if (err) shell.openExternal(targetUrl);
    });
  } else {
    shell.openExternal(targetUrl);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 700,
    title: 'منظومة السد الملكي ERP',
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,            // FIX: prevents spellcheck popup stealing focus from inputs
      backgroundThrottling: false,  // FIX: prevents timer throttling when window is blurred
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openEmailOrUrl(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('mailto:') || (url.startsWith('http') && !url.includes('127.0.0.1') && !url.includes('localhost'))) {
      event.preventDefault();
      openEmailOrUrl(url);
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return mainWindow;
}
function registerIpc() {
  ipcMain.handle('store:get', (_, key) => store.get(key));
  ipcMain.handle('store:set', (_, key, value) => store.set(key, value));
  ipcMain.handle('store:delete', (_, key) => store.delete(key));
  ipcMain.handle('config:get', () => ({
    // Desktop owns an embedded API; old saved cloud URLs must not break local startup.
    apiBaseUrl: process.env.DESKTOP_REMOTE_API === 'true' ? (store.get('apiBaseUrl') || process.env.API_BASE_URL || localApiUrl) : localApiUrl,
    version: app.getVersion(),
    backupFolder: path.join(app.getPath('userData'), 'offline-data', 'backups')
  }));
  ipcMain.handle('config:setApi', (_, value) => store.set('apiBaseUrl', value));
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', async () => {
    if (!app.isPackaged) return { skipped: true };
    updateOperation = 'download';
    try { await autoUpdater.downloadUpdate(); return { started: true }; }
    catch (error) { sendUpdateState({ state: 'error', silent: false, message: error?.message || 'تعذر تنزيل التحديث' }); return { started: false, error: error.message }; }
  });
  ipcMain.handle('updates:install', () => {
    if (!app.isPackaged) return { skipped: true };
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 100);
    return { restarting: true };
  });
  ipcMain.handle('shell:openExternal', (_, url) => openEmailOrUrl(url));
  ipcMain.handle('file:save', async (event, options = {}) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    try {
      const data = options.data instanceof Uint8Array ? Buffer.from(options.data) : Buffer.from(options.data || []);
      if (!data.length || data.length > 100 * 1024 * 1024) return { success: false, error: 'الملف الناتج فارغ أو كبير جدًا' };
      const { filePath, canceled } = await dialog.showSaveDialog(parentWin, {
        title: options.title || 'حفظ الملف',
        defaultPath: options.defaultPath || 'ملف-ناتج.xlsx',
        filters: options.filters || [{ name: 'ملفات Excel (*.xlsx)', extensions: ['xlsx'] }]
      });
      if (canceled || !filePath) return { success: false, canceled: true };
      await fs.promises.writeFile(filePath, data);
      return { success: true, filePath };
    } catch (error) {
      console.error('Error saving generated file:', error);
      return { success: false, error: error.message };
    }
  });
  // Get list of installed system printers
  ipcMain.handle('app:getPrinters', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return [];
    try {
      const printers = await win.webContents.getPrintersAsync();
      return printers || [];
    } catch (err) {
      console.error('getPrinters error:', err);
      return [];
    }
  });

  // Native printing handlers: supports silent direct print or system dialog
  ipcMain.handle('app:print', async (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return { success: false, error: 'No active window found' };
    return new Promise((resolve) => {
      const printOpts = {
        silent: options.silent === true,
        printBackground: options.printBackground !== false,
        pageSize: options.pageSize || 'A4',
        ...options
      };
      if (options.deviceName) printOpts.deviceName = options.deviceName;

      win.webContents.print(printOpts, (success, failureReason) => {
        if (!success && failureReason !== 'cancelled') {
          console.error('Print failure:', failureReason);
        }
        resolve({ success, failureReason });
      });
    });
  });

  // Helper: render arbitrary HTML in a dedicated off-screen window and generate PDF Buffer
  async function renderHtmlToPdfBuffer(htmlContent, options = {}) {
    const printWin = new BrowserWindow({
      show: false,
      width: 1024,
      height: 1448,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const styledHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>${options.title || 'تقرير'}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&display=swap');
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body {
      margin: 0;
      padding: 14mm 12mm;
      background: #ffffff !important;
      color: #0F172A !important;
      font-family: 'Tajawal', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      direction: rtl;
    }
    @page {
      size: A4 portrait;
      margin: 8mm 8mm 10mm 8mm;
    }
    table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
    tr { page-break-inside: avoid !important; page-break-after: auto; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    th, td { border: 1px solid #CBD5E1; padding: 6px 10px; font-size: 0.84rem; text-align: start; }
    th { font-weight: 700; }
    .paper { border: none !important; box-shadow: none !important; padding: 0 !important; background: transparent !important; width: 100% !important; }
    .print-report-sheet { width: 100% !important; max-width: 100% !important; padding: 0 !important; }
    .no-print { display: none !important; }
    svg { vertical-align: middle; }
  </style>
</head>
<body>
  ${htmlContent}
</body>
</html>`;

    try {
      await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(styledHtml)}`);
      // Short delay to ensure layout and fonts are fully settled
      await new Promise(r => setTimeout(r, 250));
      const pdfData = await printWin.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: {
          marginType: 'custom',
          top: 0.3,
          bottom: 0.3,
          left: 0.3,
          right: 0.3
        },
        ...options
      });
      return pdfData;
    } finally {
      if (!printWin.isDestroyed()) printWin.destroy();
    }
  }

  // Native PDF export directly to disk
  ipcMain.handle('app:printToPDF', async (event, options = {}) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    try {
      let pdfData;
      if (options.html && typeof options.html === 'string' && options.html.trim().length > 0) {
        pdfData = await renderHtmlToPdfBuffer(options.html, options);
      } else {
        if (!parentWin || parentWin.isDestroyed()) return { success: false, error: 'No active window found' };
        pdfData = await parentWin.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { marginType: 'custom', top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 },
          ...options
        });
      }

      const { filePath, canceled } = await dialog.showSaveDialog(parentWin, {
        title: 'حفظ التقرير المالي بصيغة PDF',
        defaultPath: options.defaultPath || `تقرير-مالي-${new Date().toISOString().slice(0, 10)}.pdf`,
        filters: [{ name: 'ملفات PDF (*.pdf)', extensions: ['pdf'] }]
      });

      if (!canceled && filePath) {
        await fs.promises.writeFile(filePath, pdfData);
        return { success: true, filePath };
      }
      return { success: false, canceled: true };
    } catch (err) {
      console.error('Error exporting PDF:', err);
      return { success: false, error: err.message };
    }
  });

  // Open generated PDF in OS default PDF viewer (Edge / Acrobat / Chrome) with full print preview
  ipcMain.handle('app:openPDF', async (event, options = {}) => {
    const parentWin = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    try {
      let pdfData;
      if (options.html && typeof options.html === 'string' && options.html.trim().length > 0) {
        pdfData = await renderHtmlToPdfBuffer(options.html, options);
      } else {
        if (!parentWin || parentWin.isDestroyed()) return { success: false, error: 'No active window found' };
        pdfData = await parentWin.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { marginType: 'custom', top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 },
          ...options
        });
      }

      const tempDir = app.getPath('temp');
      const tempPath = path.join(tempDir, `royal-dam-report-${Date.now()}.pdf`);
      await fs.promises.writeFile(tempPath, pdfData);
      await shell.openPath(tempPath);
      return { success: true, filePath: tempPath };
    } catch (err) {
      console.error('Error opening PDF in system viewer:', err);
      return { success: false, error: err.message };
    }
  });
}
app.whenReady().then(async()=>{ const { default: Store } = await import('electron-store'); store = new Store({encryptionKey:process.env.STORE_ENCRYPTION_KEY||'replace-this-before-production'}); await startLocalApi(); configureAutoUpdater(); registerIpc(); Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'ملف',submenu:[{role:'quit',label:'خروج'}]},{label:'تحرير',submenu:[{role:'undo'},{role:'redo'},{role:'cut'},{role:'copy'},{role:'paste'}]},{label:'عرض',submenu:[{role:'reload'},{role:'toggledevtools'},{role:'togglefullscreen'}]},{label:'مساعدة',submenu:[{label:'الموقع',click:()=>shell.openExternal('https://github.com/logo123presentation-blip/royal-dam-erb')}]}])); createWindow(); });
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
