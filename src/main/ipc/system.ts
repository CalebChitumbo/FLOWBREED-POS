/** Settings, branch config, backup and update IPC handlers (M8). */
import { join } from 'node:path';
import { app, dialog } from 'electron';
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { getDb } from '../db/connection';
import { CONFIG_KEYS } from '@shared/constants';
import { checkForUpdates } from '../updater';

const tokenStr = z.string().min(1);

export function registerSystemHandlers(): void {
  registerHandler('config:get', (req) => {
    const { token, keys } = z.object({ token: tokenStr, keys: z.array(z.string()).max(50) }).parse(req);
    const { sessions, config } = getServices();
    authorize(sessions, token, 'administrator');
    const out: Record<string, string | null> = {};
    for (const key of keys) out[key] = config.get(key);
    return out;
  });

  registerHandler('config:set', (req) => {
    const { token, key, value } = z
      .object({ token: tokenStr, key: z.string().min(1).max(64), value: z.string().max(2000) })
      .parse(req);
    const { sessions, config, audit } = getServices();
    const session = authorize(sessions, token, 'administrator');
    config.set(key, value);
    audit.record({ userId: session.userId, action: 'config_set', entityType: 'config', entityId: key });
    return { ok: true as const };
  });

  registerHandler('branch:get', (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    authorize(getServices().sessions, token);
    return getServices().branches.getCurrent();
  });

  registerHandler('branch:rename', (req) => {
    const { token, name } = z.object({ token: tokenStr, name: z.string().min(1).max(80) }).parse(req);
    authorize(getServices().sessions, token, 'administrator');
    return getServices().branches.rename(name);
  });

  registerHandler('app:lockTimeout', (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const { sessions, config } = getServices();
    authorize(sessions, token);
    return { ms: config.getNumber(CONFIG_KEYS.lockTimeoutMs, 5 * 60 * 1000) };
  });

  registerHandler('backup:run', async (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    const { sessions, config, audit } = getServices();
    const session = authorize(sessions, token, 'administrator');
    const defaultPath = join(app.getPath('documents'), `flowbreeds-backup-${Date.now()}.db`);
    const result = await dialog.showSaveDialog({
      title: 'Save database backup',
      defaultPath,
      filters: [{ name: 'SQLite database', extensions: ['db'] }],
    });
    if (result.canceled || !result.filePath) return { path: null };
    // better-sqlite3 online backup (WAL-safe).
    await getDb().backup(result.filePath);
    config.set('backup.lastAt', new Date().toISOString());
    audit.record({ userId: session.userId, action: 'backup', entityType: 'system' });
    return { path: result.filePath };
  });

  registerHandler('update:check', async (req) => {
    const { token } = z.object({ token: tokenStr }).parse(req);
    authorize(getServices().sessions, token, 'administrator');
    return checkForUpdates();
  });
}
