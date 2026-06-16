import { test, expect, _electron as electron } from '@playwright/test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * End-to-end smoke test driving the real packaged-mode Electron app
 * (renderer over app://, MAIN + SQLite + argon2). Requires native modules built
 * for the Electron ABI (npm run rebuild) and a display (xvfb on Linux/CI).
 */
const USER_DATA = join(process.cwd(), '.e2e-userdata');
const SHOTS = join(process.cwd(), 'tests/e2e/screenshots');

test('first-run bootstrap -> shell -> users page', async () => {
  rmSync(USER_DATA, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const app = await electron.launch({ args: ['.', `--user-data-dir=${USER_DATA}`] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // 1) First-run admin bootstrap
  await expect(win.getByText('Create the administrator account')).toBeVisible();
  await win.screenshot({ path: join(SHOTS, '01-bootstrap.png') });

  await win.getByLabel('Administrator username').fill('admin');
  await win.getByLabel('Password', { exact: true }).fill('admin123');
  await win.getByLabel('Confirm password').fill('admin123');
  await win.getByRole('button', { name: 'Create account' }).click();

  // 2) Authenticated shell
  await expect(win.getByText('Offline-first')).toBeVisible();
  await win.screenshot({ path: join(SHOTS, '02-shell.png') });

  // 3) Users admin page
  await win.getByText('Users', { exact: true }).first().click();
  await expect(win.getByText('Users & Access')).toBeVisible();
  await expect(win.getByText('admin')).toBeVisible();
  await win.screenshot({ path: join(SHOTS, '03-users.png') });

  await app.close();
});
