/**
 * MAIN process entry point.
 * Boots the hardened BrowserWindow, opens + migrates the local DB, then registers
 * and mounts IPC handlers before showing the window.
 */
import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { initDatabase, closeDatabase } from './db/connection';
import { runMigrations } from './db/migrate';
import { initServices } from './services';
import { registerAllHandlers } from './ipc';
import { mountIpc } from './ipc/registry';
import { log } from './logger';

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

  // Open external links in the OS browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // electron-vite injects the dev server URL in development.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  try {
    const dbPath = join(app.getPath('userData'), 'flowbreeds-pos.db');
    const db = initDatabase(dbPath);
    const schemaVersion = runMigrations(db);
    initServices(db);
    log.info(`Local DB ready at ${dbPath} (schema v${schemaVersion})`);
  } catch (err) {
    log.error('Fatal: failed to initialise database', err);
    app.quit();
    return;
  }

  registerAllHandlers();
  mountIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  closeDatabase();
});
