/**
 * Auto-update via electron-updater (NM-03, deployment §7.3). Only active in a
 * packaged build; in dev/Linux it is a no-op. electron-updater is imported
 * dynamically so it never loads in dev or tests.
 */
import { app } from 'electron';
import { log } from './logger';

export async function checkForUpdates(): Promise<{ available: boolean; version: string | null }> {
  if (!app.isPackaged) return { available: false, version: null };
  try {
    const { autoUpdater } = await import('electron-updater');
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version ?? null;
    return { available: Boolean(version) && version !== app.getVersion(), version };
  } catch (err) {
    log.warn('Update check failed', err);
    return { available: false, version: null };
  }
}

/** Kick off a background check + download-and-notify on launch (packaged only). */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return;
  void import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.logger = log;
      return autoUpdater.checkForUpdatesAndNotify();
    })
    .catch((err) => log.warn('Auto-update init failed', err));
}
