/**
 * MAIN process entry point.
 * Boots the hardened BrowserWindow, opens + migrates the local DB, registers
 * services and IPC, and serves the renderer.
 *
 * In production the renderer is served over a custom privileged `app://` scheme
 * (not file://) so that a strict `script-src 'self'` CSP works and assets load
 * with a stable origin. In development it loads the electron-vite dev server.
 */
import { join, normalize, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { app, BrowserWindow, shell, protocol, session } from 'electron';
import { initDatabase, closeDatabase } from './db/connection';
import { runMigrations } from './db/migrate';
import { initServices } from './services';
import { PrinterService, setPrinter } from './printer/printer-service';
import { FilePrinterTransport } from './printer/file-transport';
import { initFinancialRuntime, stopFinancialRuntime } from './financial/runtime';
import { getSyncEngine } from './sync';
import { initAutoUpdate } from './updater';
import { registerAllHandlers } from './ipc';
import { mountIpc } from './ipc/registry';
import type { SyncStatus } from '@shared/ipc/contract';
import { log } from './logger';

const RENDERER_DIR = join(__dirname, '../renderer');
const PROD_URL = 'app://bundle/index.html';
const devUrl = process.env['ELECTRON_RENDERER_URL'];
const isDev = Boolean(devUrl);

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

// Must run before app `ready`.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const { pathname } = new URL(request.url);
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = normalize(join(RENDERER_DIR, rel));
    if (!filePath.startsWith(RENDERER_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await readFile(filePath);
      const headers: Record<string, string> = {
        'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      };
      if (filePath.endsWith('index.html')) headers['content-security-policy'] = PROD_CSP;
      return new Response(new Uint8Array(data), { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function applyDevCsp(): void {
  // Dev server needs inline scripts (React Refresh) + localhost websockets.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' data: http://localhost:* ws://localhost:*; " +
            "script-src 'self' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:*",
        ],
      },
    });
  });
}

function broadcastSyncStatus(status: SyncStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('event:syncStatus', status);
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.on('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void window.loadURL(devUrl as string);
  } else {
    void window.loadURL(PROD_URL);
  }
}

app.whenReady().then(() => {
  try {
    const dbPath = join(app.getPath('userData'), 'flowbreeds-pos.db');
    const db = initDatabase(dbPath);
    const schemaVersion = runMigrations(db);
    const services = initServices(db);
    // Dev/Linux uses the file-preview transport; Windows swaps in ESC/POS (M8).
    setPrinter(new PrinterService(new FilePrinterTransport()));
    // Boots the sync engine on FirestoreTransport when Financial Hub credentials
    // are stored (M10), or NullTransport otherwise (outbox accumulates safely),
    // plus the FinancialBridge that feeds the Flowbreeds Financial app.
    initFinancialRuntime({ db, services, onSyncStatus: broadcastSyncStatus });
    log.info(`Local DB ready at ${dbPath} (schema v${schemaVersion})`);
  } catch (err) {
    log.error('Fatal: failed to initialise database', err);
    app.quit();
    return;
  }

  if (isDev) applyDevCsp();
  else registerAppProtocol();

  registerAllHandlers();
  mountIpc();
  createWindow();
  initAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try {
    stopFinancialRuntime();
    getSyncEngine().stop();
  } catch {
    /* engine may not have started */
  }
  closeDatabase();
});
